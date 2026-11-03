/**
 * ContentService implementation: release loading/validation and public
 * question-material projection.
 *
 * Frozen sources:
 * - modules/contracts/server/content.ts (ContentService port, manifest
 *   public/private split, content status machine, loadRelease validation
 *   sequence documented on the interface)
 * - LIFECYCLE-DATA-API.md §1/§2 (publicManifestHash covers public assets
 *   only; renderer never learns which private files a release points to;
 *   unknown ids are stable-code rejections, never a generic fallback)
 * - SCENE-CONTRACTS §1/§2 (only renderer rondo.cylinder@1 registered in the
 *   first batch; scene protocol string "1"; integer mm parameter domains)
 *
 * On-disk release layout (B convention):
 *   <rootDir>/<releaseId>/manifest.json          (ReleaseManifest: public+private)
 *   <rootDir>/<releaseId>/public/tasks/<taskId>.json
 *   <rootDir>/<releaseId>/public/hints/<contentRef>.json
 *   <rootDir>/<releaseId>/public/assets/<name>   (opaque bytes, hash-verified)
 *   <rootDir>/<releaseId>/private/rules.json
 *
 * Internal extensions beyond the frozen port (getTaskSpec / getHintContent /
 * sampleGivens) are consumed by B's learning server through a runtime
 * capability check; they never widen the public contract.
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import {
  CYLINDER_RENDERER_CONTRACT_VERSION,
  CYLINDER_RENDERER_ID,
  CYLINDER_OPERATION_TYPES,
  HEIGHT_MM_MAX,
  HEIGHT_MM_MIN,
  RADIUS_MM_MAX,
  RADIUS_MM_MIN,
} from '../contracts/public/scene';
import { SCENE_PROTOCOL_VERSION } from '../contracts/public/protocol';
import type { PublicSceneState } from '../contracts/public/scene';
import { FORBIDDEN_QUESTION_FIELDS, type MaterialVisibility, type PublicQuestionSpec } from '../contracts/public/question';
import { rondoError } from '../contracts/public/errors';
import { canonicalize } from '../contracts/public/canonical';
import {
  parseReleaseManifest,
  parsePrivateReleaseBindingsV2,
  CONTENT_TRANSITIONS,
  type ReleaseManifest,
  type ReleaseRecord,
  type ReleaseStatus,
  type PrivateReleaseBindingsV2,
  type ContentService,
} from '../contracts/server/content';
import { parsePrivateRuleSet, ruleBodyV2Schema, type PrivateRuleSet, type RuleBodyV2 } from '../contracts/server/rules';
import { ruleBodyL34V1Schema, frozenInstanceTruthSchema, type RuleBodyL34V1, type FrozenInstanceTruth } from '../contracts/server/rules-l34';
import { ruleBodyThemesV1Schema, type RuleBodyThemesV1 } from '../contracts/server/rules-themes';
import { ruleBodyStepsV1Schema, type RuleBodyStepsV1 } from '../contracts/server/rules-steps';
import {AI_NEW_IDS,AI_OPERATIONS} from '../contracts/public/ai-lab';
import { activityStateSchema } from '../contracts/public/activity';
import { activityTaskFileSchema } from './task-file';
import { activityRuleSchema, type ActivityRule } from '../contracts/server/rules-activity';
import { GRID_RENDERER_ID, GRID_OPERATION_TYPES, gridBoardStateV1Schema } from '../contracts/public/scene-gridboard';
import { STEP_RENDERER_ID, stepProgramStateV1Schema } from '../contracts/public/scene-steps';
import type { StoragePort } from '../contracts/server/storage';
import type { SqliteStorage } from '../../adapters/sqlite/storage';
import { computePublicManifestHash, sha256Hex } from './digest';
import {
  hintFileSchema,
  privateRulesFileSchema,
  taskFileSchema,
  themesTaskFileSchema,
  cppTaskFileSchema,
  type HintFile,
  type TaskFile,
  type AnyFamilyTaskFile,
  type TaskGivens,
} from './task-file';

/**
 * Registered renderer families (integration W1): each entry pins the ids a
 * release manifest may declare plus the family's operation universe and the
 * dual-expression pair its releases must carry (fallback parity per family).
 * Unknown renderers/versions stay UNKNOWN_RENDERER rejections.
 */
const REGISTERED_RENDERERS: Readonly<
  Record<string, { rendererId: string; rendererContractVersion: string; publicStateSchemaVersion: string; family: RendererFamily; operations: readonly string[]; expressions: readonly ('WEBGL2' | 'SVG_DOM' | 'BOARD_SVG' | 'BOARD_TABLE' | 'STEP_TABLE' | 'STATE_TRACE')[] }>
> = {
  'rondo.activity@1': { rendererId: 'rondo.activity', rendererContractVersion: '1', publicStateSchemaVersion: '1', family: 'activity', operations: ['SetMathControl','CaptureMathTrial','RecordMathObservation','RecordGespReasoning','SetActivityScale', 'InspectActivityCard', 'SaveActivityDraft',...AI_NEW_IDS.flatMap(id=>AI_OPERATIONS[id])], expressions: ['BOARD_SVG', 'BOARD_TABLE'] },
  'rondo.cylinder@1': {
    rendererId: CYLINDER_RENDERER_ID,
    rendererContractVersion: CYLINDER_RENDERER_CONTRACT_VERSION,
    publicStateSchemaVersion: SCENE_PROTOCOL_VERSION,
    family: 'cylinder',
    operations: CYLINDER_OPERATION_TYPES,
    expressions: ['WEBGL2', 'SVG_DOM'],
  },
  'rondo.cylinder@2': {
    rendererId: CYLINDER_RENDERER_ID,
    rendererContractVersion: '2',
    publicStateSchemaVersion: '2',
    family: 'cylinder',
    operations: [...CYLINDER_OPERATION_TYPES, 'SetLayerCount', 'SetVisibleLayerCount'],
    expressions: ['WEBGL2', 'SVG_DOM'],
  },
  'rondo.gridboard@1': {
    rendererId: GRID_RENDERER_ID,
    rendererContractVersion: '1',
    publicStateSchemaVersion: '1',
    family: 'gridboard',
    operations: GRID_OPERATION_TYPES,
    expressions: ['BOARD_SVG', 'BOARD_TABLE'],
  },
  'rondo.steps@1': {
    rendererId: STEP_RENDERER_ID,
    rendererContractVersion: '1',
    publicStateSchemaVersion: '1',
    family: 'steps',
    operations: ['EditStepProgram', 'SetTraceCursor'],
    expressions: ['STEP_TABLE', 'STATE_TRACE'],
  },
};

export type RendererFamily = 'cylinder' | 'gridboard' | 'steps' | 'activity';

/** The union of every family rule truth body the Host can load (integration W1). */
export type FamilyRuleBody = RuleBodyV2 | RuleBodyL34V1 | RuleBodyThemesV1 | RuleBodyStepsV1 | ActivityRule;

export interface LoadedRelease {
  readonly releaseId: string;
  readonly manifest: ReleaseManifest;
  readonly tasks: ReadonlyMap<string, AnyFamilyTaskFile & { allowedOperationIds: string[] }>;
  readonly hints: ReadonlyMap<string, HintFile>;
  /** v1 rule sets (deprecated-by-v2; empty when the release ships v2 bindings). */
  readonly ruleSets: ReadonlyMap<string, PrivateRuleSet>;
  /** v2 (RULE_DSL_VERSION '2') + family truths (L34/THEMES/GESP2, integration W1), keyed by ruleId. */
  readonly ruleBodies: ReadonlyMap<string, FamilyRuleBody>;
  /** Frozen instance truths keyed by taskId (first frozen entry per bound generator). */
  readonly instanceTruths: ReadonlyMap<string, FrozenInstanceTruth>;
  /** Renderer family this release belongs to. */
  readonly family: RendererFamily;
  /** v2 per-release task bindings; null when the release ships only the v1 rules file. */
  readonly bindings: PrivateReleaseBindingsV2 | null;
}

/**
 * Fixed file→kind table for the v2 private rule DSL: the `kind` discriminator
 * is the only v2-added field; C rule files carry none of their own. Mirrors
 * tests/contracts/rules-v2.test.ts (the normative coverage).
 */
export const RULE_KIND_BY_FILE: Readonly<Record<string, RuleBodyV2['kind']>> = {
  'rule.cylParam.changeClassify.v1.json': 'PARAM_CHANGE_CLASSIFY',
  'rule.cylParam.readback.v1.json': 'NUMERIC_READBACK',
  'rule.cylParam.identify.v1.json': 'PARAM_IDENTIFY',
  'rule.cylNet.direction.v1.json': 'EDGE_DIRECTION',
  'rule.cylNet.pairing.v1.json': 'EDGE_PAIRING',
  'rule.cylNet.area.v1.json': 'LATERAL_AREA',
  'rule.cylNet.transfer.v1.json': 'TRANSFER_CHECK',
};

/**
 * L3/L4 formalized rule files (integration W1, H0-DELTA-INTEGRATION-20261027-3):
 * bodies carry kind + entries verbatim (no pendingDsl; rules-l34.ts parses).
 */
const L34_RULE_FILES: ReadonlySet<string> = new Set([
  'rule.cylFaces.set.v1.json',
  'rule.cylFaces.area.v1.json',
  'rule.cylLayers.stack.v1.json',
  'rule.cylLayers.volume.v1.json',
  'rule.cylLayers.transfer.v1.json',
]);

/** Rule files whose body is already a formal family truth (kind + entries/payload). */
const FAMILY_BODY_RULE_FILES: ReadonlySet<string> = new Set([
  'rule.mvp.activity.v1.json',
  ...L34_RULE_FILES,
  // themes (GRID_TASK_TRUTH) and steps (STEP_TASK_TRUTH / EXPECTED_OUTPUT)
  'rule.thm.m1.v1.json',
  'rule.thm.m2.v1.json',
  'rule.thm.m3.v1.json',
  'rule.thm.m4.v1.json',
  'rule.thm.f1.v1.json',
  'rule.thm.f2.v1.json',
  'rule.thm.f3.v1.json',
  'rule.cppU1.trace.v1.json',
  'rule.cppU1.program.v1.json',
  'rule.cppU1.branch.v1.json',
]);

/** Parse a formal family rule body (kind + entries) by its declared discriminator. */
function parseFamilyRuleBody(fileName: string, raw: unknown): FamilyRuleBody {
  const envelope = raw as Record<string, unknown>;
  const body = envelope['body'];
  if (fileName === 'rule.mvp.activity.v1.json') return activityRuleSchema.parse(body);
  const kind = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['kind'] : undefined;
  if (L34_RULE_FILES.has(fileName)) {
    if (kind === undefined) throw rondoError('SCHEMA_MISMATCH', `L34 rule file missing body.kind: ${fileName}`);
    const parsed = ruleBodyL34V1Schema.safeParse(body);
    if (!parsed.success) throw rondoError('SCHEMA_MISMATCH', `L34 rule body validation failed: ${fileName}`);
    return parsed.data;
  }
  const themes = ruleBodyThemesV1Schema.safeParse(body);
  if (themes.success) return themes.data;
  const steps = ruleBodyStepsV1Schema.safeParse(body);
  if (steps.success) return steps.data;
  throw rondoError('SCHEMA_MISMATCH', `family rule body not parseable as a registered family truth: ${fileName}`);
}

/** Builds the RuleBodyV2 input for one C rule file (fields lifted verbatim; only `kind` is added). */
function toRuleBodyV2Input(kind: RuleBodyV2['kind'], file: Record<string, unknown>): Record<string, unknown> {
  const body = file['body'] as Record<string, unknown>;
  const pending = (file['pendingDsl'] ?? null) as Record<string, unknown> | null;
  switch (kind) {
    case 'PARAM_CHANGE_CLASSIFY':
    case 'TRANSFER_CHECK':
      return { kind, rules: body['rules'] };
    case 'NUMERIC_READBACK':
    case 'PARAM_IDENTIFY':
      return { kind, rules: body['rules'], numericReadback: pending?.['numericReadback'], feedback: pending?.['feedback'] };
    case 'EDGE_DIRECTION': {
      const shape = pending?.['numericRelationShape'] as Record<string, unknown>;
      return { kind, expectedEdgeMapping: shape?.['expectedEdgeMapping'], feedback: pending?.['feedback'] };
    }
    case 'EDGE_PAIRING': {
      const shape = pending?.['numericRelationShape'] as Record<string, unknown>;
      return { kind, expectedEdgeMapping: shape?.['expectedEdgeMapping'], diagnostics: pending?.['diagnostics'], feedback: pending?.['feedback'] };
    }
    case 'LATERAL_AREA':
      return { kind, quantityChecks: pending?.['quantityChecks'], diagnostics: pending?.['diagnostics'], feedback: pending?.['feedback'] };
  }
}

/** Server-internal task view for the learning server (never leaves the Host). */
export interface LoadedTaskSpec {
  readonly releaseId: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly file: AnyFamilyTaskFile & { allowedOperationIds: string[] };
  readonly manifest: ReleaseManifest;
}

export interface ContentServiceInternal extends ContentService {
  /** Internal: build the public spec for an instance row the caller already authorized. */
  getPublicQuestionSpecFor(
    instance: { questionInstanceId: string; releaseId: string; taskId: string; taskVersion: string; paramsJson: string },
    visibility: MaterialVisibility,
  ): PublicQuestionSpec;
  getTaskSpec(releaseId: string, taskId: string): LoadedTaskSpec | null;
  getHintContent(releaseId: string, contentRef: string): HintFile | null;
  /** Deterministic in-domain sampling from server-generated entropy. */
  sampleGivens(releaseId: string, taskId: string, entropy: string): TaskGivens;
  /**
   * v2 (RULE_DSL_VERSION '2'): the C-line rule truth body bound to the task,
   * or null when the release ships only v1 rule sets. Narrowing helper —
   * family releases carry their truths through getRuleBody.
   */
  getRuleBodyV2(releaseId: string, taskId: string): RuleBodyV2 | null;
  /**
   * Family rule truth body bound to the task (cylinder v2 / L34 / GRID /
   * STEP), or null when the release ships only v1 rule sets.
   */
  getRuleBody(releaseId: string, taskId: string): FamilyRuleBody | null;
  /**
   * Frozen instance truth (first frozen entry of the bound generator file),
   * or null when the task has no frozen instance binding.
   */
  getFrozenInstanceTruth(releaseId: string, taskId: string): FrozenInstanceTruth | null;
  /** Renderer family of a loaded release ('cylinder' when unknown). */
  familyOf(releaseId: string): RendererFamily;
  /**
   * v2 composite segment enablement from the private binding (e.g. S1 four
   * segments, D1 three); null/undefined when the task is not a composite or
   * the binding declares none. Optional so pre-v2 content fixtures keep
   * satisfying the interface.
   */
  getEnabledSegments?(releaseId: string, taskId: string): readonly string[] | null;
}

export interface RondoContentServiceDeps {
  readonly storage: StoragePort;
  readonly now: () => number;
}

export class RondoContentService implements ContentServiceInternal {
  private readonly loaded = new Map<string, LoadedRelease>();
  private closed = false;

  constructor(private readonly deps: RondoContentServiceDeps) {}

  async loadRelease(rootDir: string, releaseId: string): Promise<ReleaseRecord> {
    if (this.closed) throw rondoError('HOST_RECOVERING', 'content service is closed');
    const releaseDir = join(rootDir, releaseId);
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(await readFile(join(releaseDir, 'manifest.json'), 'utf8'));
    } catch {
      throw rondoError('CONTENT_UNAVAILABLE', `release manifest not readable: ${releaseId}`);
    }
    const parsed = parseManifestOrReject(manifestRaw, releaseId);
    if (parsed.public.releaseId !== releaseId) {
      throw rondoError('CONTENT_UNAVAILABLE', `manifest releaseId mismatch: ${releaseId}`);
    }

    // 1. Registry-matching renderer declarations (family-aware, integration W1:
    //    cylinder@1/@2, gridboard@1, steps@1 — loadRelease dispatches on the
    //    manifest's renderer declaration). THEMES micro-lesson ① releases
    //    legitimately declare two renderers (cylinder + gridboard).
    let releaseFamily: RendererFamily | null = null;
    for (const declaration of parsed.public.rendererDeclarations) {
      const registered = REGISTERED_RENDERERS[`${declaration.rendererId}@${declaration.rendererContractVersion}`];
      if (
        registered === undefined ||
        registered.rendererId !== declaration.rendererId ||
        registered.rendererContractVersion !== declaration.rendererContractVersion ||
        registered.publicStateSchemaVersion !== declaration.publicStateSchemaVersion
      ) {
        throw rondoError(
          'UNKNOWN_RENDERER',
          `renderer declaration not registered: ${declaration.rendererId}@${declaration.rendererContractVersion}`,
        );
      }
      releaseFamily = registered.family;
    }
    if (parsed.public.rendererDeclarations.length === 0) {
      throw rondoError('UNKNOWN_RENDERER', 'release declares no renderer');
    }
    if (releaseFamily === null) {
      throw rondoError('UNKNOWN_RENDERER', 'release declares no registered renderer family');
    }

    // 2. Load the public tree: tasks, hints, assets (family-aware task files).
    const tasks = new Map<string, AnyFamilyTaskFile & { allowedOperationIds: string[] }>();
    for (const taskId of parsed.public.taskIds) {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(join(releaseDir, 'public', 'tasks', `${taskId}.json`), 'utf8'));
      } catch {
        throw rondoError('CONTENT_UNAVAILABLE', `public task file missing: ${taskId}`);
      }
      assertNoForbiddenFields(raw, taskId);
      const familySchema =
        releaseFamily === 'activity' ? activityTaskFileSchema : releaseFamily === 'cylinder' ? taskFileSchema : releaseFamily === 'gridboard' ? themesTaskFileSchema : cppTaskFileSchema;
      const task = parseOrSchemaMismatch(() => familySchema.parse(raw), `task ${taskId}`) as AnyFamilyTaskFile & { allowedOperationIds: string[] };
      if (task.taskId !== taskId) {
        throw rondoError('SCHEMA_MISMATCH', `task file id mismatch: ${taskId}`);
      }
      const allowedOps = allowedOperationsFor(parsed.public.rendererDeclarations);
      for (const opId of task.allowedOperationIds) {
        if (!allowedOps.includes(opId)) {
          throw rondoError('UNKNOWN_RENDERER', `task ${taskId} allows unregistered operation ${opId}`);
        }
      }
      tasks.set(taskId, task);
    }
    const extraTaskFiles = await listJsonFiles(join(releaseDir, 'public', 'tasks'));
    for (const name of extraTaskFiles) {
      const taskId = name.replace(/\.json$/, '');
      if (!tasks.has(taskId)) {
        throw rondoError('SCHEMA_MISMATCH', `public task file not declared in manifest: ${taskId}`);
      }
    }

    const hints = new Map<string, HintFile>();
    for (const hintFile of await listJsonFiles(join(releaseDir, 'public', 'hints'))) {
      const contentRef = hintFile.replace(/\.json$/, '');
      const raw = JSON.parse(await readFile(join(releaseDir, 'public', 'hints', hintFile), 'utf8'));
      assertNoForbiddenFields(raw, `hint:${contentRef}`);
      const hint = parseOrSchemaMismatch(() => hintFileSchema.parse(raw), `hint ${contentRef}`);
      if (hint.contentRef !== contentRef) {
        throw rondoError('SCHEMA_MISMATCH', `hint file contentRef mismatch: ${contentRef}`);
      }
      hints.set(contentRef, hint);
    }

    const assets: Record<string, string> = {};
    const assetDir = join(releaseDir, 'public', 'assets');
    for (const assetName of await listFiles(assetDir)) {
      const bytes = await readFile(join(assetDir, assetName));
      assets[assetName] = sha256Hex(bytes);
    }
    const declaredAssetHashes = [...parsed.public.publicAssetHashes].sort();
    const actualAssetHashes = Object.values(assets).sort();
    if (declaredAssetHashes.length !== actualAssetHashes.length || declaredAssetHashes.some((h, i) => h !== actualAssetHashes[i])) {
      throw rondoError('SCHEMA_MISMATCH', `public asset hash set mismatch for release ${releaseId}`);
    }

    // 3. publicManifestHash over the whole public tree.
    const { publicManifestHash, ...publicHeader } = parsed.public;
    const computedHash = computePublicManifestHash({
      publicHeader,
      tasks: Object.fromEntries([...tasks.entries()].map(([id, t]) => [id, stripToPlain(t)])),
      hints: Object.fromEntries([...hints.entries()].map(([ref, h]) => [ref, stripToPlain(h)])),
      assets,
    });
    if (computedHash !== publicManifestHash) {
      throw rondoError('SCHEMA_MISMATCH', `publicManifestHash mismatch for release ${releaseId}`);
    }

    // 4. Complete fallback expression subsets: every expression of the release's
    //    family pair must be declared, and EACH member must cover every
    //    learning-critical operation the tasks open (per-family dual pair:
    //    WEBGL2/SVG_DOM, BOARD_SVG/BOARD_TABLE, STEP_TABLE/STATE_TRACE).
    const subsets = new Map(parsed.public.expressionOperationSubsets.map((s) => [s.expression, s]));
    const familyExpressions = familyExpressionsFor(parsed.public.rendererDeclarations);
    for (const expression of familyExpressions) {
      if (!subsets.has(expression)) {
        throw rondoError('SCHEMA_MISMATCH', `release ${releaseId} must declare ${expression} operation subsets`);
      }
    }
    const criticalOps = new Set<string>();
    for (const task of tasks.values()) {
      for (const op of task.allowedOperationIds) criticalOps.add(op);
    }
    for (const [expression, subset] of subsets) {
      if (!familyExpressions.includes(expression)) continue;
      for (const op of criticalOps) {
        if (!subset.allowedOperationIds.includes(op)) {
          throw rondoError('SCHEMA_MISMATCH', `${expression} subset missing critical operation ${op}; release cannot load as-is`);
        }
      }
    }

    // 5. Private rule truth. v2 (RULE_DSL_VERSION '2') is the C-line format:
    //    private/bindings.json (privateReleaseBindingsV2Schema, verbatim C
    //    shape) points each task at a private rule FILE whose body is lifted
    //    into a RuleBodyV2 (only the `kind` discriminator is added, by the
    //    fixed file→kind table). The deprecated v1 rules.json path stays for
    //    synthetic v1 fixtures.
    const ruleSets = new Map<string, PrivateRuleSet>();
    const ruleBodies = new Map<string, FamilyRuleBody>();
    const instanceTruths = new Map<string, FrozenInstanceTruth>();
    let bindings: PrivateReleaseBindingsV2 | null = null;
    const bindingsPath = join(releaseDir, 'private', 'bindings.json');
    let hasBindings = false;
    try {
      await readFile(bindingsPath, 'utf8');
      hasBindings = true;
    } catch {
      hasBindings = false;
    }
    if (hasBindings) {
      let bindingsRaw: unknown;
      try {
        bindingsRaw = JSON.parse(await readFile(bindingsPath, 'utf8'));
      } catch {
        throw rondoError('SCHEMA_MISMATCH', 'private/bindings.json not readable');
      }
      bindings = parseOrSchemaMismatch(() => parsePrivateReleaseBindingsV2(bindingsRaw), 'bindings.json');
      if (bindings.releaseId !== releaseId) {
        throw rondoError('SCHEMA_MISMATCH', `bindings releaseId mismatch: ${releaseId}`);
      }
      const privateRoot = join(releaseDir, 'private');
      for (const binding of bindings.taskBindings) {
        if (!tasks.has(binding.taskId)) {
          throw rondoError('SCHEMA_MISMATCH', `taskBinding references unknown task: ${binding.taskId}`);
        }
        const manifestRef = parsed.private.ruleRefs.find((r) => r.taskId === binding.taskId);
        if (
          manifestRef === undefined ||
          manifestRef.ruleId !== binding.ruleRef.ruleId ||
          manifestRef.ruleVersion !== binding.ruleRef.ruleVersion
        ) {
          throw rondoError('SCHEMA_MISMATCH', `taskBinding ${binding.taskId} inconsistent with manifest ruleRefs`);
        }
        if (ruleBodies.has(binding.ruleRef.ruleId)) continue;
        const rulePath = resolvePathInside(privateRoot, binding.ruleRef.path);
        let ruleFileRaw: unknown;
        try {
          ruleFileRaw = JSON.parse(await readFile(rulePath, 'utf8'));
        } catch {
          throw rondoError('SCHEMA_MISMATCH', `rule file not readable: ${binding.ruleRef.path}`);
        }
        const fileName = basename(rulePath);
        const envelope = ruleFileRaw as Record<string, unknown>;
        if (envelope['ruleId'] !== binding.ruleRef.ruleId) {
          throw rondoError('SCHEMA_MISMATCH', `rule file id mismatch: ${fileName}`);
        }
        if (FAMILY_BODY_RULE_FILES.has(fileName)) {
          // integration W1: L3/L4 + themes + steps rule files carry a formal
          // family truth body (kind + entries) — parsed by the family schema.
          const body = parseOrSchemaMismatch(() => parseFamilyRuleBody(fileName, ruleFileRaw), `rule body ${binding.ruleRef.ruleId}`);
          ruleBodies.set(binding.ruleRef.ruleId, body);
        } else {
          const kind = RULE_KIND_BY_FILE[fileName];
          if (kind === undefined) {
            throw rondoError('SCHEMA_MISMATCH', `no v2 kind mapped for rule file: ${fileName}`);
          }
          const body = parseOrSchemaMismatch(
            () => ruleBodyV2Schema.parse(toRuleBodyV2Input(kind, envelope)),
            `rule body ${binding.ruleRef.ruleId}`,
          );
          ruleBodies.set(binding.ruleRef.ruleId, body);
        }
        if (binding.instanceGeneratorRef !== undefined) {
          const instancePath = resolvePathInside(privateRoot, binding.instanceGeneratorRef.path);
          let instanceRaw: string;
          try {
            instanceRaw = await readFile(instancePath, 'utf8');
          } catch {
            throw rondoError('SCHEMA_MISMATCH', `instance generator file not readable: ${binding.instanceGeneratorRef.path}`);
          }
          // Parse the first frozen entry as the instance truth this batch binds
          // (exactly one frozen instance per task; mock contentLoaders agree).
          try {
            const parsedInstances = JSON.parse(instanceRaw) as { frozen?: Array<{ instanceId: unknown; initial?: unknown; inputs?: unknown; truth: unknown }> };
            const first = parsedInstances.frozen?.[0];
            if (first === undefined) {
              throw new Error('no frozen entry');
            }
            instanceTruths.set(
              binding.taskId,
              frozenInstanceTruthSchema.parse({
                instanceId: first.instanceId,
                // cpp.steps frozen instances carry the initial variable values
                // as `inputs` (family variant); normalize to the shared shape.
                initial: first.initial ?? first.inputs ?? {},
                truth: first.truth,
              }),
            );
          } catch (err) {
            if (err instanceof Error && err.name === 'ZodError') {
              throw rondoError('SCHEMA_MISMATCH', `frozen instance truth invalid: ${binding.instanceGeneratorRef.path}`);
            }
            throw rondoError('SCHEMA_MISMATCH', `frozen instance file not parseable: ${binding.instanceGeneratorRef.path}`);
          }
        }
      }
      for (const taskId of tasks.keys()) {
        if (!bindings.taskBindings.some((b) => b.taskId === taskId)) {
          throw rondoError('SCHEMA_MISMATCH', `task ${taskId} has no v2 binding`);
        }
      }
    } else {
      const ruleRaw = JSON.parse(await readFile(join(releaseDir, 'private', 'rules.json'), 'utf8'));
      const privateRules = parseOrSchemaMismatch(() => privateRulesFileSchema.parse(ruleRaw), 'rules.json');
      for (const entry of privateRules.ruleSets) {
        if (ruleSets.has(entry.ruleId)) {
          throw rondoError('SCHEMA_MISMATCH', `duplicate ruleId in rules.json: ${entry.ruleId}`);
        }
        ruleSets.set(
          entry.ruleId,
          parseOrSchemaMismatch(
            () => parsePrivateRuleSet({ ruleSetVersion: entry.ruleSet.ruleSetVersion, rules: entry.ruleSet.rules }),
            `ruleSet ${entry.ruleId}`,
          ),
        );
      }
      for (const ref of parsed.private.ruleRefs) {
        if (!tasks.has(ref.taskId)) {
          throw rondoError('SCHEMA_MISMATCH', `ruleRef references unknown task: ${ref.taskId}`);
        }
        const set = ruleSets.get(ref.ruleId);
        if (!set || set.ruleSetVersion !== ref.ruleVersion) {
          throw rondoError('SCHEMA_MISMATCH', `ruleRef ${ref.ruleId}@${ref.ruleVersion} not satisfied by private/rules.json`);
        }
      }
      for (const taskId of tasks.keys()) {
        if (!parsed.private.ruleRefs.some((r) => r.taskId === taskId)) {
          throw rondoError('SCHEMA_MISMATCH', `task ${taskId} has no rule reference`);
        }
      }
    }

    // 6. Hint gates: referenced content exists; per-task levels unique.
    const levelsByTask = new Map<string, Set<number>>();
    for (const gate of parsed.private.hintGateTable) {
      if (!tasks.has(gate.taskId)) {
        throw rondoError('SCHEMA_MISMATCH', `hint gate references unknown task: ${gate.taskId}`);
      }
      const hint = hints.get(gate.contentRef);
      if (!hint || hint.level !== gate.hintLevel) {
        throw rondoError('SCHEMA_MISMATCH', `hint gate ${gate.taskId}#${gate.hintLevel} has no matching content`);
      }
      const levels = levelsByTask.get(gate.taskId) ?? new Set<number>();
      if (levels.has(gate.hintLevel)) {
        throw rondoError('SCHEMA_MISMATCH', `duplicate hint level for task ${gate.taskId}: ${gate.hintLevel}`);
      }
      levels.add(gate.hintLevel);
      levelsByTask.set(gate.taskId, levels);
    }

    // 7. Construction parameter domains: registered param ids inside global ranges.
    for (const domainEntry of parsed.private.constructionParamDomains) {
      if (!tasks.has(domainEntry.taskId)) {
        throw rondoError('SCHEMA_MISMATCH', `param domain references unknown task: ${domainEntry.taskId}`);
      }
      for (const domain of domainEntry.domains) {
        const bounds = paramBounds(domain.paramId);
        if (!bounds) {
          throw rondoError('SCHEMA_MISMATCH', `unknown construction param: ${domain.paramId}`);
        }
        if (domain.min < bounds.min || domain.max > bounds.max || domain.min > domain.max) {
          throw rondoError('SCHEMA_MISMATCH', `param domain out of registered range: ${domain.paramId}`);
        }
      }
    }

    // 8. Register/verify in storage. A releaseId is immutable: same id with a
    //    different manifest is rejected.
    const now = this.deps.now();
    const courseVersions = canonicalize({
      taskIds: parsed.public.taskIds,
      taskVersion: parsed.public.taskVersion,
      titles: Object.fromEntries([...tasks.entries()].map(([id, t]) => [id, t.title])),
    });
    await this.deps.storage.tx('content.loadRelease', async (repos) => {
      const existing = await repos.contentRelease.findById({ familyId: '', actorId: '' }, releaseId);
      if (existing === null) {
        await repos.contentRelease.insert({ familyId: '', actorId: '' }, {
          releaseId,
          status: 'DRAFT',
          courseVersionsJson: courseVersions,
          rendererDeclarationsJson: canonicalize(parsed.public.rendererDeclarations),
          publicManifestHash,
          createdAt: now,
          statusChangedAt: now,
          statusReason: null,
        });
        return;
      }
      if (existing.publicManifestHash !== publicManifestHash) {
        throw rondoError('INVALID_OPERATION', `release ${releaseId} already registered with different content`);
      }
    });

    this.loaded.set(releaseId, { releaseId, manifest: parsed, tasks, hints, ruleSets, ruleBodies, instanceTruths, bindings, family: releaseFamily });
    return { releaseId, status: this.releaseStatus(releaseId), manifest: parsed };
  }

  releaseStatus(releaseId: string): ReleaseStatus {
    const storage = this.deps.storage as StoragePort & { findReleaseStatusSync?: (id: string) => string | null };
    if (typeof storage.findReleaseStatusSync !== 'function') {
      throw rondoError('PERSISTENCE_FAILED', 'storage lacks the release status seam');
    }
    const status = storage.findReleaseStatusSync(releaseId);
    if (status === null) throw rondoError('CONTENT_UNAVAILABLE', `unknown release: ${releaseId}`);
    return status as ReleaseStatus;
  }

  getPublicQuestionSpec(questionInstanceId: string, visibility: MaterialVisibility): PublicQuestionSpec {
    if (this.closed) throw rondoError('HOST_RECOVERING', 'content service is closed');
    // B-internal seam: instance lookup without family scope (public material
    // only; family authorization is enforced by the learning server on the
    // attempt/cycle before anything reaches a client). Synchronous because
    // the frozen port signature is synchronous and node:sqlite reads are.
    const storage = this.deps.storage as StoragePort & { findInstanceUnscopedSync?: (id: string) => unknown };
    if (typeof storage.findInstanceUnscopedSync !== 'function') {
      throw rondoError('PERSISTENCE_FAILED', 'storage lacks the content instance lookup seam');
    }
    const instance = storage.findInstanceUnscopedSync(questionInstanceId) as
      | { questionInstanceId: string; releaseId: string; taskId: string; taskVersion: string; paramsJson: string }
      | null;
    if (instance === null) {
      throw rondoError('CONTENT_UNAVAILABLE', `unknown question instance: ${questionInstanceId}`);
    }
    return this.getPublicQuestionSpecFor(instance, visibility);
  }

  /** Internal: build the public spec for an instance row the caller already authorized. */
  getPublicQuestionSpecFor(
    instance: { questionInstanceId: string; releaseId: string; taskId: string; taskVersion: string; paramsJson: string },
    visibility: MaterialVisibility,
  ): PublicQuestionSpec {
    const release = this.loaded.get(instance.releaseId);
    if (!release) throw rondoError('CONTENT_UNAVAILABLE', `release not loaded: ${instance.releaseId}`);
    const task = release.tasks.get(instance.taskId);
    if (!task) throw rondoError('CONTENT_UNAVAILABLE', `task not in release: ${instance.taskId}`);
    const blocks = [];
    for (const group of task.promptGroups) {
      if (visibilityRankOf(group.minVisibility) <= visibilityRankOf(visibility)) blocks.push(...group.blocks);
    }
    const declaration = release.manifest.public.rendererDeclarations[0];
    const spec: PublicQuestionSpec = {
      questionInstanceId: instance.questionInstanceId,
      releaseId: instance.releaseId,
      taskId: instance.taskId,
      taskVersion: instance.taskVersion,
      prompt: blocks,
      responseSchemaId: task.responseSchemaId,
      scene: {
        rendererId: declaration.rendererId,
        rendererContractVersion: declaration.rendererContractVersion,
        state: initialSceneStateFor(release.family, task, instance.paramsJson),
      },
      allowedOperationIds: [...task.allowedOperationIds],
      materialVisibility: visibility,
    };
    // Dimension families carry the numeric policy; themes/steps tasks omit it
    // (optional per the family contract deltas — nothing is backfilled).
    if (release.family === 'cylinder' && task.taskFamily.startsWith('cylinder.')) {
      spec.numericPolicy = (task as TaskFile).numericPolicy;
    }
    return spec;
  }

  resolveRules(releaseId: string, taskId: string): PrivateRuleSet | null {
    const release = this.loaded.get(releaseId);
    if (!release) return null;
    const ref = release.manifest.private.ruleRefs.find((r) => r.taskId === taskId);
    if (!ref) return null;
    const set = release.ruleSets.get(ref.ruleId);
    return set ?? null;
  }

  /** v2 (RULE_DSL_VERSION '2'): the C-line rule truth body bound to the task. */
  getRuleBodyV2(releaseId: string, taskId: string): RuleBodyV2 | null {
    const body = this.getRuleBody(releaseId, taskId);
    return body !== null && 'kind' in body && RULE_V2_KINDS_SET.has(body.kind as string) ? (body as RuleBodyV2) : null;
  }

  /** Family rule truth body bound to the task (cylinder v2 / L34 / GRID / STEP). */
  getRuleBody(releaseId: string, taskId: string): FamilyRuleBody | null {
    const release = this.loaded.get(releaseId);
    if (!release || release.bindings === null) return null;
    const binding = release.bindings.taskBindings.find((b) => b.taskId === taskId);
    if (!binding) return null;
    return release.ruleBodies.get(binding.ruleRef.ruleId) ?? null;
  }

  /** Frozen instance truth bound to the task's generator (null when none). */
  getFrozenInstanceTruth(releaseId: string, taskId: string): FrozenInstanceTruth | null {
    const release = this.loaded.get(releaseId);
    if (!release) return null;
    return release.instanceTruths.get(taskId) ?? null;
  }

  /** Renderer family of a loaded release ('cylinder' when unknown). */
  familyOf(releaseId: string): RendererFamily {
    return this.loaded.get(releaseId)?.family ?? 'cylinder';
  }

  /** v2 composite segment enablement from the private binding (null when not declared). */
  getEnabledSegments(releaseId: string, taskId: string): readonly string[] | null {
    const release = this.loaded.get(releaseId);
    if (!release || release.bindings === null) return null;
    const binding = release.bindings.taskBindings.find((b) => b.taskId === taskId);
    return binding?.enabledSegments ?? null;
  }

  getTaskSpec(releaseId: string, taskId: string): LoadedTaskSpec | null {
    const release = this.loaded.get(releaseId);
    if (!release) return null;
    const file = release.tasks.get(taskId);
    if (!file) return null;
    return { releaseId, taskId, taskVersion: release.manifest.public.taskVersion, file, manifest: release.manifest };
  }

  getHintContent(releaseId: string, contentRef: string): HintFile | null {
    return this.loaded.get(releaseId)?.hints.get(contentRef) ?? null;
  }

  sampleGivens(releaseId: string, taskId: string, entropy: string): TaskGivens {
    const spec = this.getTaskSpec(releaseId, taskId);
    if (!spec) throw rondoError('CONTENT_UNAVAILABLE', `unknown task: ${releaseId}/${taskId}`);
    const cylFile = spec.file as TaskFile;
    if (!cylFile.sampleParams || !cylFile.taskFamily.startsWith('cylinder.')) return cylFile.givens;
    const domains = new Map(
      (spec.manifest.private.constructionParamDomains.find((d) => d.taskId === taskId)?.domains ?? []).map((d) => [d.paramId, d]),
    );
    const radiusDomain = domains.get('radiusMm');
    const heightDomain = domains.get('heightMm');
    const digest = sha256Hex(entropy);
    const pick = (offset: number, domain: { min: number; max: number } | undefined, fallbackMin: number, fallbackMax: number): number => {
      const min = domain?.min ?? fallbackMin;
      const max = domain?.max ?? fallbackMax;
      const chunk = Number.parseInt(digest.slice(offset, offset + 8), 16);
      return min + (chunk % (max - min + 1));
    };
    return {
      radiusMm: pick(0, radiusDomain, RADIUS_MM_MIN, RADIUS_MM_MAX),
      heightMm: pick(8, heightDomain, HEIGHT_MM_MIN, HEIGHT_MM_MAX),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.loaded.clear();
  }

  /** Host-maintenance helper: validated status transition (content status machine). */
  static transitionAllowed(from: ReleaseStatus, to: ReleaseStatus): boolean {
    return CONTENT_TRANSITIONS[from].includes(to);
  }
}

/** Operation universe across every renderer a release declares (family union for micro-lesson ① dual declarations). */
function allowedOperationsFor(declarations: ReleaseManifest['public']['rendererDeclarations']): readonly string[] {
  const ops: string[] = [];
  for (const declaration of declarations) {
    const registered = REGISTERED_RENDERERS[`${declaration.rendererId}@${declaration.rendererContractVersion}`];
    if (registered !== undefined) ops.push(...registered.operations);
  }
  return ops;
}

/** Dual-expression pair(s) across every renderer a release declares. */
function familyExpressionsFor(declarations: ReleaseManifest['public']['rendererDeclarations']): readonly ('WEBGL2' | 'SVG_DOM' | 'BOARD_SVG' | 'BOARD_TABLE' | 'STEP_TABLE' | 'STATE_TRACE')[] {
  const expressions: ('WEBGL2' | 'SVG_DOM' | 'BOARD_SVG' | 'BOARD_TABLE' | 'STEP_TABLE' | 'STATE_TRACE')[] = [];
  for (const declaration of declarations) {
    const registered = REGISTERED_RENDERERS[`${declaration.rendererId}@${declaration.rendererContractVersion}`];
    if (registered !== undefined) expressions.push(...registered.expressions);
  }
  return expressions;
}

const RULE_V2_KINDS_SET: ReadonlySet<string> = new Set([
  'PARAM_CHANGE_CLASSIFY',
  'NUMERIC_READBACK',
  'PARAM_IDENTIFY',
  'EDGE_DIRECTION',
  'EDGE_PAIRING',
  'LATERAL_AREA',
  'TRANSFER_CHECK',
] as const);

/** Family-aware initial scene state: cylinder V1/V2, gridboard, or steps. */
export function initialSceneStateFor(family: RendererFamily, task: AnyFamilyTaskFile, paramsJson: string): PublicSceneState {
  if (family === 'activity') return activityStateSchema.parse(JSON.parse(paramsJson));
  if (family === 'gridboard' || family === 'steps') {
    // Family givens ARE the scene state (board / step program); parse strictly
    // through the family state schemas so a malformed givens record rejects here.
    const givens = JSON.parse(paramsJson) as Record<string, unknown>;
    const parsed =
      family === 'gridboard'
        ? gridBoardStateV1Schema.safeParse(givens)
        : family === 'steps'
          ? stepProgramStateV1Schema.safeParse(givens)
          : null;
    if (parsed === null || !parsed.success) {
      throw rondoError('SCHEMA_MISMATCH', `family givens not a valid ${family} state: ${task.taskId}`);
    }
    return parsed.data as PublicSceneState;
  }
  const params = JSON.parse(paramsJson) as TaskGivens;
  const cylTask = task as TaskFile;
  const base = {
    radiusMm: params.radiusMm,
    heightMm: params.heightMm,
    unrollPermille: cylTask.initialState?.unrollPermille ?? 0,
    section: cylTask.initialState?.section ?? 'NONE',
    selectedFaceIds: cylTask.initialState?.selectedFaceIds ?? [],
  };
  if (cylTask.initialState?.layerCount !== undefined) {
    return {
      ...base,
      layerCount: cylTask.initialState.layerCount,
      visibleLayerCount: cylTask.initialState.visibleLayerCount ?? 0,
    };
  }
  return base;
}

function visibilityRankOf(v: MaterialVisibility): number {
  return { PREDICTION: 0, OBSERVATION: 1, ASSESSMENT: 2, REVIEW: 3 }[v];
}

/** Resolves a binding-relative private path with containment inside the release's private root. */
function resolvePathInside(rootDir: string, relativePath: string): string {
  const resolved = resolve(rootDir, relativePath);
  if (resolved !== rootDir && !resolved.startsWith(rootDir + sep)) {
    throw rondoError('SCHEMA_MISMATCH', `private path escapes the release: ${relativePath}`);
  }
  return resolved;
}

function paramBounds(paramId: string): { min: number; max: number } | null {
  if (paramId === 'radiusMm') return { min: RADIUS_MM_MIN, max: RADIUS_MM_MAX };
  if (paramId === 'heightMm') return { min: HEIGHT_MM_MIN, max: HEIGHT_MM_MAX };
  return null;
}

function assertNoForbiddenFields(raw: unknown, label: string): void {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if ((FORBIDDEN_QUESTION_FIELDS as readonly string[]).includes(key)) {
        throw rondoError('SCHEMA_MISMATCH', `forbidden field '${key}' in public content: ${label}`);
      }
    }
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/** Ensure an object is a plain JSON object tree before canonical hashing. */
function stripToPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Map zod failures to the stable SCHEMA_MISMATCH code (LIFECYCLE §6). */
function parseOrSchemaMismatch<T>(fn: () => T, label: string): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && err.name === 'ZodError') {
      throw rondoError('SCHEMA_MISMATCH', `content schema validation failed (${label})`);
    }
    throw err;
  }
}

function parseManifestOrReject(manifestRaw: unknown, releaseId: string): ReleaseManifest {
  return parseOrSchemaMismatch(() => parseReleaseManifest(manifestRaw), `manifest ${releaseId}`);
}
