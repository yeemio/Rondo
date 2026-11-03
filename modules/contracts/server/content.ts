/**
 * Content service port, release manifest (public/private split), and the
 * content status machine.
 *
 * Frozen sources:
 * - B server-ports-recommendation.md §3 (ContentService shape:
 *   loadRelease / releaseStatus / getPublicQuestionSpec / resolveRules / close)
 * - LIFECYCLE-DATA-API.md §1/§2 (DRAFT -> REVIEWED -> AVAILABLE -> RETIRED,
 *   REVOKED from published states; publicManifestHash covers public assets
 *   only; renderer never learns which private files a releaseId points to)
 * - B sqlite-schema-recommendation.md §2.2 (contentRelease columns)
 * - H0-SPEC.md §2 content.ts
 *
 * The manifest private part is Host-only; it must never be serialized into
 * any renderer projection.
 *
 * Changelog:
 * - v2 (2026-10-27, B-D10 close-out): privateReleaseBindingsV2Schema
 *   formalizes the C-line private bindings files
 *   (content/cylinder/private/bindings/*.bindings.private.json: releaseId +
 *   taskBindings[{taskId, ruleRef{ruleId,ruleVersion,path},
 *   instanceGeneratorRef?, enabledSegments?}]). Per the actual C files, no
 *   hintGateTable / constructionParamDomains members exist in this format —
 *   those remain B-manifest (releaseManifestPrivateSchema) concepts.
 * - v1: frozen H0 release manifest (public + private split).
 */
import { z } from 'zod';
import { idSchema } from '../public/protocol';
import type { MaterialVisibility, PublicQuestionSpec } from '../public/question';
import type { PrivateRuleSet } from './rules';

export const CONTENT_STATUSES = ['DRAFT', 'REVIEWED', 'AVAILABLE', 'RETIRED', 'REVOKED'] as const;
export type ReleaseStatus = (typeof CONTENT_STATUSES)[number];
export const releaseStatusSchema = z.enum(CONTENT_STATUSES);

/**
 * Content status machine (LIFECYCLE §2). Linear forward path; REVOKED is
 * reachable from the published states (AVAILABLE, RETIRED). Nothing leaves
 * REVOKED. RETIRED keeps full old bindings queryable but blocks new attempts.
 */
export const CONTENT_TRANSITIONS: Readonly<Record<ReleaseStatus, readonly ReleaseStatus[]>> = {
  DRAFT: ['REVIEWED'],
  REVIEWED: ['AVAILABLE'],
  AVAILABLE: ['RETIRED', 'REVOKED'],
  RETIRED: ['REVOKED'],
  REVOKED: [],
};

/**
 * Scene expression families. WEBGL2/SVG_DOM are the H0 cylinder pair; each
 * later renderer family registers its own dual-expression pair via a
 * versioned delta:
 * - THEMES-A 2026-10-27: rondo.gridboard@1 ships BOARD_SVG（SVG 图板：圆盘/
 *   条带/数轴/矩形/点阵/百格板）and BOARD_TABLE（同状态的表格投影；同一
 *   状态、同一判分接口）.
 * - GESP2 2026-10-27 (A-5): rondo.steps@1 ships STEP_TABLE/STATE_TRACE (DOM
 *   pair; both members carry the same operation subsets — keyboard/mouse
 *   equivalence, same judging).
 */
export const SCENE_EXPRESSIONS = ['WEBGL2', 'SVG_DOM', 'BOARD_SVG', 'BOARD_TABLE', 'STEP_TABLE', 'STATE_TRACE'] as const;
export type SceneExpression = (typeof SCENE_EXPRESSIONS)[number];

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha-256 hex string');

export const rendererDeclarationSchema = z
  .object({
    rendererId: idSchema,
    rendererContractVersion: idSchema,
    publicStateSchemaVersion: idSchema,
  })
  .strict();
export type RendererDeclaration = z.infer<typeof rendererDeclarationSchema>;

/**
 * Per-expression operation subset: a release must declare what each of its
 * supported expressions (WEBGL2 / SVG_DOM) can do. A release missing a
 * critical fallback operation cannot be marked AVAILABLE.
 */
export const expressionOperationSubsetSchema = z
  .object({
    expression: z.enum(SCENE_EXPRESSIONS),
    allowedOperationIds: z.array(idSchema).max(32),
  })
  .strict();
export type ExpressionOperationSubset = z.infer<typeof expressionOperationSubsetSchema>;

export const releaseManifestPublicSchema = z
  .object({
    releaseId: idSchema,
    taskIds: z.array(idSchema).min(1).max(64),
    taskVersion: idSchema,
    rendererDeclarations: z.array(rendererDeclarationSchema).min(1).max(8),
    /** Hashes of public assets only; never includes private answers/tests (LIFECYCLE §1). */
    publicAssetHashes: z.array(sha256HexSchema).max(256),
    expressionOperationSubsets: z.array(expressionOperationSubsetSchema).min(1).max(8),
    publicManifestHash: sha256HexSchema,
  })
  .strict();
export type ReleaseManifestPublic = z.infer<typeof releaseManifestPublicSchema>;

export const ruleRefSchema = z
  .object({ taskId: idSchema, ruleId: idSchema, ruleVersion: idSchema })
  .strict();
export type RuleRef = z.infer<typeof ruleRefSchema>;

export const hintGateSchema = z
  .object({ taskId: idSchema, hintLevel: z.number().int().min(0).max(5), contentRef: idSchema })
  .strict();
export type HintGate = z.infer<typeof hintGateSchema>;

export const intParamDomainSchema = z
  .object({ paramId: idSchema, kind: z.literal('INT_RANGE'), min: z.number().int(), max: z.number().int() })
  .strict()
  .superRefine((domain, ctx) => {
    if (domain.max < domain.min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `max < min for param ${domain.paramId}` });
    }
  });
export type IntParamDomain = z.infer<typeof intParamDomainSchema>;

export const constructionParamDomainSchema = z
  .object({ taskId: idSchema, domains: z.array(intParamDomainSchema).max(16) })
  .strict();
export type ConstructionParamDomains = z.infer<typeof constructionParamDomainSchema>;

/** Host-only part: rule references, hint gates, construction parameter domains. */
export const releaseManifestPrivateSchema = z
  .object({
    ruleRefs: z.array(ruleRefSchema).min(1).max(64),
    hintGateTable: z.array(hintGateSchema).max(64),
    constructionParamDomains: z.array(constructionParamDomainSchema).max(64),
  })
  .strict();
export type ReleaseManifestPrivate = z.infer<typeof releaseManifestPrivateSchema>;

export const releaseManifestSchema = z
  .object({
    public: releaseManifestPublicSchema,
    private: releaseManifestPrivateSchema,
  })
  .strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export function parseReleaseManifest(input: unknown): ReleaseManifest {
  return releaseManifestSchema.parse(input);
}

export function safeParseReleaseManifest(input: unknown): z.SafeParseReturnType<unknown, ReleaseManifest> {
  return releaseManifestSchema.safeParse(input);
}

export interface ReleaseRecord {
  releaseId: string;
  status: ReleaseStatus;
  manifest: ReleaseManifest;
}

/**
 * Content service port (B implements modules/content). loadRelease runs the
 * B §3 validation sequence: known manifest schema version; complete and
 * registry-matching ids (first batch renderer only rondo.cylinder@1, scene
 * protocol string "1"); physical public/private separation with structural
 * rejection of answer/correctIndex/private-tests/scoring/seed fields;
 * per-asset hash verification; complete fallback expression subsets; status
 * machine discipline. Unknown anything => stable-code rejection, never a
 * generic-renderer fallback.
 */
export interface ContentService {
  loadRelease(rootDir: string, releaseId: string): Promise<ReleaseRecord>;
  releaseStatus(releaseId: string): ReleaseStatus;
  getPublicQuestionSpec(questionInstanceId: string, visibility: MaterialVisibility): PublicQuestionSpec;
  /** Server-internal only; null for unknown/mismatched references (caller maps to the stable code). */
  resolveRules(releaseId: string, taskId: string): PrivateRuleSet | null;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// v2 (B-D10): C-line private release bindings manifest
//
// Shape follows the actual C bindings files verbatim (strict): a releaseId
// plus taskBindings; each binding points a task at a private rule file, may
// attach a frozen instance generator, and may enable transfer segments.
// No hintGateTable / constructionParamDomains in this format (actual files
// carry none; those stay in the B releaseManifestPrivateSchema).
// ---------------------------------------------------------------------------

/**
 * Task-flow segments enabled on multi-segment tasks.
 * - L2 cylinder transfer tasks use the four frozen segments.
 * - Value-set extension h0-mathl34-20261027-1 (L34-7): the adjudicated L4
 *   composite schemas add resp.l4.varCompare.v1 segments (bigger/valueA/
 *   valueB/ratio) and resp.l4.strangerComposite.v1 segments (faceSet/
 *   paperArea/volume beside paramRead). Additive only; L1/L2 bindings
 *   unchanged.
 * - GESP2 unit-1 delta: cpp.steps.v1 program tasks add the three step
 *   segments. Additive enum extension; existing files keep their values.
 */
export const TASK_SEGMENT_IDS = [
  // L2 strangerComposite (frozen)
  'paramRead',
  'edgePairing',
  'directionClaims',
  'areaValue',
  // L4 varCompare / strangerComposite (h0-mathl34-20261027-1)
  'bigger',
  'valueA',
  'valueB',
  'ratio',
  'faceSet',
  'paperArea',
  'volume',
  // cpp.steps.v1 program tasks (GESP2 unit-1 delta)
  'outputAnswer',
  'finalVariables',
  'conceptCheck',
] as const;
export type TaskSegmentId = (typeof TASK_SEGMENT_IDS)[number];

const relativeContentPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/, 'relative content path');

/** Reference from a task binding to its private rule file. */
export const ruleFileRefV2Schema = z
  .object({
    ruleId: idSchema,
    ruleVersion: idSchema,
    path: relativeContentPathSchema,
  })
  .strict();
export type RuleFileRefV2 = z.infer<typeof ruleFileRefV2Schema>;

/** Frozen instance generator reference (instances/<name>.json under the private root). */
export const instanceGeneratorRefV2Schema = z
  .object({
    kind: z.literal('frozen'),
    path: relativeContentPathSchema,
  })
  .strict();
export type InstanceGeneratorRefV2 = z.infer<typeof instanceGeneratorRefV2Schema>;

export const privateTaskBindingV2Schema = z
  .object({
    taskId: idSchema,
    ruleRef: ruleFileRefV2Schema,
    instanceGeneratorRef: instanceGeneratorRefV2Schema.optional(),
    enabledSegments: z.array(z.enum(TASK_SEGMENT_IDS)).min(1).max(8).optional(),
  })
  .strict();
export type PrivateTaskBindingV2 = z.infer<typeof privateTaskBindingV2Schema>;

/** Host-only per-release task→rule bindings exactly as C ships them. */
export const privateReleaseBindingsV2Schema = z
  .object({
    releaseId: idSchema,
    taskBindings: z.array(privateTaskBindingV2Schema).min(1).max(64),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    for (const binding of manifest.taskBindings) {
      if (seen.has(binding.taskId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate taskBinding taskId: ${binding.taskId}` });
      }
      seen.add(binding.taskId);
    }
  });
export type PrivateReleaseBindingsV2 = z.infer<typeof privateReleaseBindingsV2Schema>;

export function parsePrivateReleaseBindingsV2(input: unknown): PrivateReleaseBindingsV2 {
  return privateReleaseBindingsV2Schema.parse(input);
}

export function safeParsePrivateReleaseBindingsV2(
  input: unknown,
): z.SafeParseReturnType<unknown, PrivateReleaseBindingsV2> {
  return privateReleaseBindingsV2Schema.safeParse(input);
}
