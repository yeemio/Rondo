/**
 * MOCK_ONLY content loader: statically imports the whole content tree
 * (public AND private — the mock acts as the dev-side Host) so the same JSON
 * files the release manifest hashes are the ones served to the player.
 *
 * NEVER imported by apps/web/src/main.tsx (product entry). Only
 * main.dev.tsx (dev bundle) and node tests reach this module.
 */
import type { CylinderStateV1, CylinderStateV2, CylinderOperationV1, CylinderOperationV2 } from '../contracts/public/scene';
import { themesGetTask } from './contentLoaderThemes';
import { cppGetTask } from './contentLoaderCpp';
import type { AuthoredBlocks, MaterialVisibility } from '../contracts/public/question';

import lessonsJson from '../../content/cylinder/public/lessons.json';
import registryJson from '../../content/cylinder/public/schemas/response-schemas.registry.json';
import bindingsL1Json from '../../content/cylinder/private/bindings/l1-r1.bindings.private.json';
import bindingsL2Json from '../../content/cylinder/private/bindings/l2-r1.bindings.private.json';
import bindingsL3Json from '../../content/cylinder/private/bindings/l3-r1.bindings.private.json';
import bindingsL4Json from '../../content/cylinder/private/bindings/l4-r1.bindings.private.json';
import answerHintsJson from '../../content/cylinder/private/hints/answer-hints.json';
import ruleChangeClassify from '../../content/cylinder/private/rules/rule.cylParam.changeClassify.v1.json';
import ruleReadback from '../../content/cylinder/private/rules/rule.cylParam.readback.v1.json';
import ruleIdentify from '../../content/cylinder/private/rules/rule.cylParam.identify.v1.json';
import rulePairing from '../../content/cylinder/private/rules/rule.cylNet.pairing.v1.json';
import ruleDirection from '../../content/cylinder/private/rules/rule.cylNet.direction.v1.json';
import ruleArea from '../../content/cylinder/private/rules/rule.cylNet.area.v1.json';
import ruleTransfer from '../../content/cylinder/private/rules/rule.cylNet.transfer.v1.json';
import ruleFacesSet from '../../content/cylinder/private/rules/rule.cylFaces.set.v1.json';
import ruleFacesArea from '../../content/cylinder/private/rules/rule.cylFaces.area.v1.json';
import ruleLayersStack from '../../content/cylinder/private/rules/rule.cylLayers.stack.v1.json';
import ruleLayersVolume from '../../content/cylinder/private/rules/rule.cylLayers.volume.v1.json';
import ruleLayersTransfer from '../../content/cylinder/private/rules/rule.cylLayers.transfer.v1.json';
import instI1 from '../../content/cylinder/private/instances/cyl.param.i1.v1-instances.json';
import instI2 from '../../content/cylinder/private/instances/cyl.param.i2.v1-instances.json';
import instNetI3 from '../../content/cylinder/private/instances/cyl.net.i3.v1-instances.json';
import instNetS1 from '../../content/cylinder/private/instances/cyl.net.s1.v1-instances.json';
import instNetD1 from '../../content/cylinder/private/instances/cyl.net.d1.v1-instances.json';
import instFacesI1 from '../../content/cylinder/private/instances/cyl.faces.i1.v1-instances.json';
import instFacesI2 from '../../content/cylinder/private/instances/cyl.faces.i2.v1-instances.json';
import instFacesI3 from '../../content/cylinder/private/instances/cyl.faces.i3.v1-instances.json';
import instLayersI1 from '../../content/cylinder/private/instances/cyl.layers.i1.v1-instances.json';
import instLayersI2 from '../../content/cylinder/private/instances/cyl.layers.i2.v1-instances.json';
import instLayersI3 from '../../content/cylinder/private/instances/cyl.layers.i3.v1-instances.json';
import instLayersS1 from '../../content/cylinder/private/instances/cyl.layers.s1.v1-instances.json';
import instLayersD1 from '../../content/cylinder/private/instances/cyl.layers.d1.v1-instances.json';

import tParamG1 from '../../content/cylinder/public/tasks/cyl.param.g1.view-invariance.v1.json';
import tParamG2 from '../../content/cylinder/public/tasks/cyl.param.g2.radius-change.v1.json';
import tParamG3 from '../../content/cylinder/public/tasks/cyl.param.g3.height-section.v1.json';
import tParamI1 from '../../content/cylinder/public/tasks/cyl.param.i1.identify-changes.v1.json';
import tParamI2 from '../../content/cylinder/public/tasks/cyl.param.i2.predict-single-change.v1.json';
import tNetG1 from '../../content/cylinder/public/tasks/cyl.net.g1.unroll-observe.v1.json';
import tNetG2 from '../../content/cylinder/public/tasks/cyl.net.g2.edge-pairing.v1.json';
import tNetG3 from '../../content/cylinder/public/tasks/cyl.net.g3.lateral-area.v1.json';
import tNetI1 from '../../content/cylinder/public/tasks/cyl.net.i1.pair-normal.v1.json';
import tNetI2 from '../../content/cylinder/public/tasks/cyl.net.i2.pair-tall-thin.v1.json';
import tNetI3 from '../../content/cylinder/public/tasks/cyl.net.i3.area-value-unit.v1.json';
import tNetS1 from '../../content/cylinder/public/tasks/cyl.net.s1.stranger-relabel.v1.json';
import tNetD1 from '../../content/cylinder/public/tasks/cyl.net.d1.delayed-transfer.v1.json';
import tFacesG1 from '../../content/cylinder/public/tasks/cyl.faces.g1.face-inventory.v1.json';
import tFacesG2 from '../../content/cylinder/public/tasks/cyl.faces.g2.one-lid-area.v1.json';
import tFacesG3 from '../../content/cylinder/public/tasks/cyl.faces.g3.full-surface.v1.json';
import tFacesI1 from '../../content/cylinder/public/tasks/cyl.faces.i1.faceset-new-instance.v1.json';
import tFacesI2 from '../../content/cylinder/public/tasks/cyl.faces.i2.lid-count-condition.v1.json';
import tFacesI3 from '../../content/cylinder/public/tasks/cyl.faces.i3.surface-value-unit.v1.json';
import tLayersG1 from '../../content/cylinder/public/tasks/cyl.layers.g1.stack-invariant.v1.json';
import tLayersG2 from '../../content/cylinder/public/tasks/cyl.layers.g2.layer-volume.v1.json';
import tLayersG3 from '../../content/cylinder/public/tasks/cyl.layers.g3.height-vs-radius.v1.json';
import tLayersI1 from '../../content/cylinder/public/tasks/cyl.layers.i1.volume-value-unit.v1.json';
import tLayersI2 from '../../content/cylinder/public/tasks/cyl.layers.i2.height-vs-radius-choice.v1.json';
import tLayersI3 from '../../content/cylinder/public/tasks/cyl.layers.i3.accumulate-count.v1.json';
import tLayersS1 from '../../content/cylinder/public/tasks/cyl.layers.s1.stranger-package.v1.json';
import tLayersD1 from '../../content/cylinder/public/tasks/cyl.layers.d1.delayed-transfer.v1.json';

// ---------------------------------------------------------------------------
// public task shape (mirrors scripts/build-content.mjs; zod-validated in
// tests/content — keeping this hand-written keeps the mock free of a second
// schema copy drifting from the generator)
// ---------------------------------------------------------------------------
export interface OperationConstraint {
  type: 'SetDimension' | 'SetUnroll' | 'SetSection' | 'SelectFaces' | 'SetLayerCount' | 'SetVisibleLayerCount';
  dimension?: 'RADIUS' | 'HEIGHT';
  valuesMm?: number[];
  minMm?: number;
  maxMm?: number;
  sections?: string[];
  minPermille?: number;
  maxPermille?: number;
  allowedFaceIds?: string[];
  values?: number[];
  min?: number;
  max?: number;
}

export interface VisibilityRule {
  material: string;
  phases: string[];
  rows?: string[];
  note?: string;
}

export interface HintMeta {
  level: number;
  label: string;
  text?: string;
}

export interface ExplainSelectionOption {
  id: string;
  label: string;
}
export interface ExplainSelection {
  itemId: string;
  prompt: string;
  multi?: boolean;
  options: ExplainSelectionOption[];
}
export interface TaskExplain {
  selections: ExplainSelection[];
  freeTextPrompt: string;
}

export interface PublicTask {
  taskId: string;
  taskVersion: string;
  taskFamily: 'cylinder.parameters.v1' | 'cylinder.net.v1' | 'cylinder.faces.v1' | 'cylinder.layers.v1';
  kind: 'GUIDED' | 'INDEPENDENT' | 'STRANGER' | 'DELAYED_TRANSFER';
  title: string;
  prompt: AuthoredBlocks;
  givens: CylinderStateV1 | CylinderStateV2;
  givenLocks: string[];
  responseSchemaId: string;
  allowedOperationIds: Array<CylinderOperationV1['type'] | CylinderOperationV2['type']>;
  operationConstraints: OperationConstraint[];
  numericPolicy: { pi: '3.14'; displayDecimals: number; acceptedUnitIds: string[] };
  visibility: VisibilityRule[];
  hints: HintMeta[];
  explain: TaskExplain;
  exitEvidence: string[];
  expressions: { webgl2: string; svgDom: string };
}

/** Renderer contract version per task family (L34-1: layers=@2, others=@1). */
export function rendererContractVersionOf(taskId: string): '1' | '2' {
  return getTask(taskId).taskFamily === 'cylinder.layers.v1' ? '2' : '1';
}

export interface FrozenInstance {
  instanceId: string;
  initial: { radiusMm: number; heightMm: number };
  script?: { dimension: 'RADIUS' | 'HEIGHT'; fromMm: number; toMm: number; publicInPrompt?: boolean };
  truth: Record<string, unknown>;
  answerHint: string;
  givenDiameterCm?: string;
  givenCircumferenceCm?: string;
  condition?: string;
  variants?: Record<string, { radiusMm: number; heightMm: number }>;
  layer?: { layerCount: number; thicknessMm: number };
  targetCm3?: string;
  migration?: Record<string, unknown>;
}

const TASKS: Record<string, PublicTask> = {
  [tParamG1.taskId]: tParamG1 as PublicTask,
  [tParamG2.taskId]: tParamG2 as PublicTask,
  [tParamG3.taskId]: tParamG3 as PublicTask,
  [tParamI1.taskId]: tParamI1 as PublicTask,
  [tParamI2.taskId]: tParamI2 as PublicTask,
  [tNetG1.taskId]: tNetG1 as PublicTask,
  [tNetG2.taskId]: tNetG2 as PublicTask,
  [tNetG3.taskId]: tNetG3 as PublicTask,
  [tNetI1.taskId]: tNetI1 as PublicTask,
  [tNetI2.taskId]: tNetI2 as PublicTask,
  [tNetI3.taskId]: tNetI3 as PublicTask,
  [tNetS1.taskId]: tNetS1 as PublicTask,
  [tNetD1.taskId]: tNetD1 as PublicTask,
  [tFacesG1.taskId]: tFacesG1 as PublicTask,
  [tFacesG2.taskId]: tFacesG2 as PublicTask,
  [tFacesG3.taskId]: tFacesG3 as PublicTask,
  [tFacesI1.taskId]: tFacesI1 as PublicTask,
  [tFacesI2.taskId]: tFacesI2 as PublicTask,
  [tFacesI3.taskId]: tFacesI3 as PublicTask,
  [tLayersG1.taskId]: tLayersG1 as PublicTask,
  [tLayersG2.taskId]: tLayersG2 as PublicTask,
  [tLayersG3.taskId]: tLayersG3 as PublicTask,
  [tLayersI1.taskId]: tLayersI1 as PublicTask,
  [tLayersI2.taskId]: tLayersI2 as PublicTask,
  [tLayersI3.taskId]: tLayersI3 as PublicTask,
  [tLayersS1.taskId]: tLayersS1 as PublicTask,
  [tLayersD1.taskId]: tLayersD1 as PublicTask,
};

const RULES: Record<string, unknown> = {
  'rule.cylParam.changeClassify.v1': ruleChangeClassify,
  'rule.cylParam.readback.v1': ruleReadback,
  'rule.cylParam.identify.v1': ruleIdentify,
  'rule.cylNet.pairing.v1': rulePairing,
  'rule.cylNet.direction.v1': ruleDirection,
  'rule.cylNet.area.v1': ruleArea,
  'rule.cylNet.transfer.v1': ruleTransfer,
  'rule.cylFaces.set.v1': ruleFacesSet,
  'rule.cylFaces.area.v1': ruleFacesArea,
  'rule.cylLayers.stack.v1': ruleLayersStack,
  'rule.cylLayers.volume.v1': ruleLayersVolume,
  'rule.cylLayers.transfer.v1': ruleLayersTransfer,
};

const INSTANCES: Record<string, { frozen: FrozenInstance[] }> = {
  'cyl.param.i1.identify-changes.v1': instI1 as { frozen: FrozenInstance[] },
  'cyl.param.i2.predict-single-change.v1': instI2 as { frozen: FrozenInstance[] },
  'cyl.net.i3.area-value-unit.v1': instNetI3 as { frozen: FrozenInstance[] },
  'cyl.net.s1.stranger-relabel.v1': instNetS1 as { frozen: FrozenInstance[] },
  'cyl.net.d1.delayed-transfer.v1': instNetD1 as { frozen: FrozenInstance[] },
  'cyl.faces.i1.faceset-new-instance.v1': instFacesI1 as { frozen: FrozenInstance[] },
  'cyl.faces.i2.lid-count-condition.v1': instFacesI2 as { frozen: FrozenInstance[] },
  'cyl.faces.i3.surface-value-unit.v1': instFacesI3 as { frozen: FrozenInstance[] },
  'cyl.layers.i1.volume-value-unit.v1': instLayersI1 as { frozen: FrozenInstance[] },
  'cyl.layers.i2.height-vs-radius-choice.v1': instLayersI2 as { frozen: FrozenInstance[] },
  'cyl.layers.i3.accumulate-count.v1': instLayersI3 as { frozen: FrozenInstance[] },
  'cyl.layers.s1.stranger-package.v1': instLayersS1 as { frozen: FrozenInstance[] },
  'cyl.layers.d1.delayed-transfer.v1': instLayersD1 as { frozen: FrozenInstance[] },
};

export interface LessonDef {
  lessonId: string;
  releaseId: string;
  title: string;
  taskFamily: string;
  taskOrder: string[];
  delayedTransferTaskId?: string;
  delayedTransferWindowDays?: { availableAfterDays: number; nominalEndDays: number };
}

export const LESSONS = lessonsJson.lessons as LessonDef[];

export interface ResponseSchemaRegistry {
  registryVersion: string;
  propertyLabels: Record<string, string>;
  directionLabels: Record<string, string>;
  schemas: Array<{
    schemaId: string;
    summary: string;
    predict: unknown;
    verify: unknown;
    /** L34-7 附注：复合段 prompt 实例化（仅 paramRead 段），taskId → segmentId → prompt */
    segmentPromptOverrides?: Record<string, Record<string, string>>;
  }>;
}

export const RESPONSE_REGISTRY = registryJson as unknown as ResponseSchemaRegistry;

export interface TaskBinding {
  taskId: string;
  ruleRef: { ruleId: string; ruleVersion: string; path: string };
  instanceGeneratorRef?: { kind: string; path: string };
  enabledSegments?: string[];
}

const BINDINGS: Record<string, string> = {};
for (const b of [
  ...bindingsL1Json.taskBindings,
  ...bindingsL2Json.taskBindings,
  ...bindingsL3Json.taskBindings,
  ...bindingsL4Json.taskBindings,
] as TaskBinding[]) {
  BINDINGS[b.taskId] = b.ruleRef.ruleId;
}
export const TASK_BINDINGS = BINDINGS;
export const TASK_ENABLED_SEGMENTS: Record<string, string[]> = {};
for (const b of [
  ...bindingsL1Json.taskBindings,
  ...bindingsL2Json.taskBindings,
  ...bindingsL3Json.taskBindings,
  ...bindingsL4Json.taskBindings,
] as TaskBinding[]) {
  if (b.enabledSegments) TASK_ENABLED_SEGMENTS[b.taskId] = b.enabledSegments;
}

export const ANSWER_HINTS = answerHintsJson as Record<string, Array<{ instanceId: string; level: number; text: string }>>;

export function getTask(taskId: string): PublicTask {
  const t = TASKS[taskId] ?? themesGetTask(taskId) ?? cppGetTask(taskId);
  if (!t) throw new Error(`MOCK content: unknown task ${taskId}`);
  return t as PublicTask;
}

export function hasTask(taskId: string): boolean {
  return taskId in TASKS;
}

export function getRule(ruleId: string): unknown {
  return RULES[ruleId];
}

export function getBindingRuleId(taskId: string): string {
  const ruleId = TASK_BINDINGS[taskId];
  if (!ruleId) throw new Error(`MOCK content: no binding for ${taskId}`);
  return ruleId;
}

/** First frozen instance for a task (first-batch releases freeze exactly one). */
export function getFrozenInstance(taskId: string): FrozenInstance | null {
  const file = INSTANCES[taskId];
  if (!file || file.frozen.length === 0) return null;
  return file.frozen[0];
}

export function lessonByRelease(releaseId: string): LessonDef {
  const l = LESSONS.find((x) => x.releaseId === releaseId);
  if (!l) throw new Error(`MOCK content: unknown release ${releaseId}`);
  return l;
}

export function lessonByTask(taskId: string): LessonDef {
  const l = LESSONS.find((x) => x.taskOrder.includes(taskId) || x.delayedTransferTaskId === taskId);
  if (!l) throw new Error(`MOCK content: no lesson for task ${taskId}`);
  return l;
}

/** phase → materialVisibility single value (frozen four-档 projection). */
export function visibilityForPhase(phase: string): MaterialVisibility {
  switch (phase) {
    case 'PREDICT':
      return 'PREDICTION';
    case 'OPERATE':
      return 'OBSERVATION';
    case 'REVIEW':
      return 'REVIEW';
    default:
      return 'ASSESSMENT';
  }
}
