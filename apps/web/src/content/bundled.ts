/**
 * Bundled PUBLIC content for the player: task metadata, visibility matrices,
 * response form registries, lesson structure. Only files under the public
 * trees are imported here (content/{cylinder,themes-a,cpp}/public/**) — the
 * public build never touches any private/** tree (structural separation;
 * tests assert the public bundle contains no private markers).
 *
 * Integration W1: the cylinder strand (L1–L4), the themes strand (微课 + 主题一)
 * and the GESP-2 unit all bundle here; lessons follow the course-list order
 * (micro → theme → cylinder → cpp).
 */
import lessonsJson from '../../../../content/cylinder/public/lessons.json';
import registryJson from '../../../../content/cylinder/public/schemas/response-schemas.registry.json';
import themesLessonsJson from '../../../../content/themes-a/public/lessons.json';
import themesRegistryJson from '../../../../content/themes-a/public/schemas/response-schemas.registry.json';
import cppLessonsJson from '../../../../content/cpp/public/lessons.json';
import cppRegistryJson from '../../../../content/cpp/public/schemas/response-schemas.registry.json';
import tParamG1 from '../../../../content/cylinder/public/tasks/cyl.param.g1.view-invariance.v1.json';
import tParamG2 from '../../../../content/cylinder/public/tasks/cyl.param.g2.radius-change.v1.json';
import tParamG3 from '../../../../content/cylinder/public/tasks/cyl.param.g3.height-section.v1.json';
import tParamI1 from '../../../../content/cylinder/public/tasks/cyl.param.i1.identify-changes.v1.json';
import tParamI2 from '../../../../content/cylinder/public/tasks/cyl.param.i2.predict-single-change.v1.json';
import tNetG1 from '../../../../content/cylinder/public/tasks/cyl.net.g1.unroll-observe.v1.json';
import tNetG2 from '../../../../content/cylinder/public/tasks/cyl.net.g2.edge-pairing.v1.json';
import tNetG3 from '../../../../content/cylinder/public/tasks/cyl.net.g3.lateral-area.v1.json';
import tNetI1 from '../../../../content/cylinder/public/tasks/cyl.net.i1.pair-normal.v1.json';
import tNetI2 from '../../../../content/cylinder/public/tasks/cyl.net.i2.pair-tall-thin.v1.json';
import tNetI3 from '../../../../content/cylinder/public/tasks/cyl.net.i3.area-value-unit.v1.json';
import tNetS1 from '../../../../content/cylinder/public/tasks/cyl.net.s1.stranger-relabel.v1.json';
import tNetD1 from '../../../../content/cylinder/public/tasks/cyl.net.d1.delayed-transfer.v1.json';
import tFacesG1 from '../../../../content/cylinder/public/tasks/cyl.faces.g1.face-inventory.v1.json';
import tFacesG2 from '../../../../content/cylinder/public/tasks/cyl.faces.g2.one-lid-area.v1.json';
import tFacesG3 from '../../../../content/cylinder/public/tasks/cyl.faces.g3.full-surface.v1.json';
import tFacesI1 from '../../../../content/cylinder/public/tasks/cyl.faces.i1.faceset-new-instance.v1.json';
import tFacesI2 from '../../../../content/cylinder/public/tasks/cyl.faces.i2.lid-count-condition.v1.json';
import tFacesI3 from '../../../../content/cylinder/public/tasks/cyl.faces.i3.surface-value-unit.v1.json';
import tLayersG1 from '../../../../content/cylinder/public/tasks/cyl.layers.g1.stack-invariant.v1.json';
import tLayersG2 from '../../../../content/cylinder/public/tasks/cyl.layers.g2.layer-volume.v1.json';
import tLayersG3 from '../../../../content/cylinder/public/tasks/cyl.layers.g3.height-vs-radius.v1.json';
import tLayersI1 from '../../../../content/cylinder/public/tasks/cyl.layers.i1.volume-value-unit.v1.json';
import tLayersI2 from '../../../../content/cylinder/public/tasks/cyl.layers.i2.height-vs-radius-choice.v1.json';
import tLayersI3 from '../../../../content/cylinder/public/tasks/cyl.layers.i3.accumulate-count.v1.json';
import tLayersS1 from '../../../../content/cylinder/public/tasks/cyl.layers.s1.stranger-package.v1.json';
import tLayersD1 from '../../../../content/cylinder/public/tasks/cyl.layers.d1.delayed-transfer.v1.json';
import thM1D from '../../../../content/themes-a/public/tasks/thm.m1.diag.v1.json';
import thM1S from '../../../../content/themes-a/public/tasks/thm.m1.supp.v1.json';
import thM2D from '../../../../content/themes-a/public/tasks/thm.m2.diag.v1.json';
import thM2S from '../../../../content/themes-a/public/tasks/thm.m2.supp.v1.json';
import thM3D from '../../../../content/themes-a/public/tasks/thm.m3.diag.v1.json';
import thM3S from '../../../../content/themes-a/public/tasks/thm.m3.supp.v1.json';
import thM4D from '../../../../content/themes-a/public/tasks/thm.m4.diag.v1.json';
import thM4S from '../../../../content/themes-a/public/tasks/thm.m4.supp.v1.json';
import thF1G1 from '../../../../content/themes-a/public/tasks/thm.f1.g1.partition-circle.v1.json';
import thF1G2 from '../../../../content/themes-a/public/tasks/thm.f1.g2.partition-bar.v1.json';
import thF1I1 from '../../../../content/themes-a/public/tasks/thm.f1.i1.represent.v1.json';
import thF1S1 from '../../../../content/themes-a/public/tasks/thm.f1.s1.stranger-relabel.v1.json';
import thF1D1 from '../../../../content/themes-a/public/tasks/thm.f1.d1.delayed-transfer.v1.json';
import thF2G1 from '../../../../content/themes-a/public/tasks/thm.f2.g1.scale-bar.v1.json';
import thF2G2 from '../../../../content/themes-a/public/tasks/thm.f2.g2.equivalent-find.v1.json';
import thF2I1 from '../../../../content/themes-a/public/tasks/thm.f2.i1.numberline.v1.json';
import thF2S1 from '../../../../content/themes-a/public/tasks/thm.f2.s1.stranger.v1.json';
import thF2D1 from '../../../../content/themes-a/public/tasks/thm.f2.d1.delayed-transfer.v1.json';
import thF3G1 from '../../../../content/themes-a/public/tasks/thm.f3.g1.percent-board.v1.json';
import thF3G2 from '../../../../content/themes-a/public/tasks/thm.f3.g2.discount-chain.v1.json';
import thF3I1 from '../../../../content/themes-a/public/tasks/thm.f3.i1.allocate.v1.json';
import thF3S1 from '../../../../content/themes-a/public/tasks/thm.f3.s1.stranger.v1.json';
import thF3D1 from '../../../../content/themes-a/public/tasks/thm.f3.d1.delayed-transfer.v1.json';
import tCppG1 from '../../../../content/cpp/public/tasks/cpp.u1.g1.receipt-trace.v1.json';
import tCppG2 from '../../../../content/cpp/public/tasks/cpp.u1.g2.pack-sweets.v1.json';
import tCppG3 from '../../../../content/cpp/public/tasks/cpp.u1.g3.member-discount.v1.json';
import tCppG4 from '../../../../content/cpp/public/tasks/cpp.u1.g4.sales-sum.v1.json';
import tCppI1 from '../../../../content/cpp/public/tasks/cpp.u1.i1.fix-boundary.v1.json';
import tCppI2 from '../../../../content/cpp/public/tasks/cpp.u1.i2.enum-count.v1.json';
import tCppI3 from '../../../../content/cpp/public/tasks/cpp.u1.i3.build-digits.v1.json';
import tCppS1 from '../../../../content/cpp/public/tasks/cpp.u1.s1.stranger-transfer.v1.json';
import tCppD1 from '../../../../content/cpp/public/tasks/cpp.u1.d1.delayed-transfer.v1.json';
import type { AuthoredBlocks } from '../../../../modules/contracts/public/question';
import type { CylinderStateV1, CylinderStateV2 } from '../../../../modules/contracts/public/scene';
import type { GridBoardStateV1 } from '../../../../modules/contracts/public/scene-gridboard';
import type { StepProgramStateV1, StepSpecV1 } from '../../../../modules/contracts/public/scene-steps';

export interface UiTask {
  taskId: string;
  taskVersion: string;
  taskFamily: string;
  kind: string;
  title: string;
  prompt: AuthoredBlocks;
  givens: CylinderStateV1 | CylinderStateV2 | GridBoardStateV1 | StepProgramStateV1;
  givenLocks: string[];
  responseSchemaId: string;
  allowedOperationIds: string[];
  operationConstraints: Array<Record<string, unknown>>;
  /** Optional per the family contract deltas: dimension families only. */
  numericPolicy?: { pi: '3.14'; displayDecimals: number; acceptedUnitIds: string[] };
  visibility: Array<{ material: string; phases: string[]; rows?: string[]; note?: string }>;
  hints: Array<{ level: number; label: string; text?: string; revealsAnswer?: boolean }>;
  explain: {
    selections: Array<{ itemId: string; prompt: string; multi?: boolean; options: Array<{ id: string; label: string }> }>;
    freeTextPrompt: string;
  };
  exitEvidence: string[];
  /** themes families: board projection (CIRCLE_FLAT/RECT/DOTARRAY/PIE/BAR/…) */
  boardView?: string;
  /** cpp.steps.v1: the operate-phase mission card text (card.mission). */
  mission?: string;
}

export const CPP_TASK_FAMILY = 'cpp.steps.v1';

const TASK_MAP: Record<string, UiTask> = {
  [tParamG1.taskId]: tParamG1 as UiTask,
  [tParamG2.taskId]: tParamG2 as UiTask,
  [tParamG3.taskId]: tParamG3 as UiTask,
  [tParamI1.taskId]: tParamI1 as UiTask,
  [tParamI2.taskId]: tParamI2 as UiTask,
  [tNetG1.taskId]: tNetG1 as UiTask,
  [tNetG2.taskId]: tNetG2 as UiTask,
  [tNetG3.taskId]: tNetG3 as UiTask,
  [tNetI1.taskId]: tNetI1 as UiTask,
  [tNetI2.taskId]: tNetI2 as UiTask,
  [tNetI3.taskId]: tNetI3 as UiTask,
  [tNetS1.taskId]: tNetS1 as UiTask,
  [tNetD1.taskId]: tNetD1 as UiTask,
  [tFacesG1.taskId]: tFacesG1 as UiTask,
  [tFacesG2.taskId]: tFacesG2 as UiTask,
  [tFacesG3.taskId]: tFacesG3 as UiTask,
  [tFacesI1.taskId]: tFacesI1 as UiTask,
  [tFacesI2.taskId]: tFacesI2 as UiTask,
  [tFacesI3.taskId]: tFacesI3 as UiTask,
  [tLayersG1.taskId]: tLayersG1 as UiTask,
  [tLayersG2.taskId]: tLayersG2 as UiTask,
  [tLayersG3.taskId]: tLayersG3 as UiTask,
  [tLayersI1.taskId]: tLayersI1 as UiTask,
  [tLayersI2.taskId]: tLayersI2 as UiTask,
  [tLayersI3.taskId]: tLayersI3 as UiTask,
  [tLayersS1.taskId]: tLayersS1 as UiTask,
  [tLayersD1.taskId]: tLayersD1 as UiTask,
  [thM1D.taskId]: thM1D as UiTask,
  [thM1S.taskId]: thM1S as UiTask,
  [thM2D.taskId]: thM2D as UiTask,
  [thM2S.taskId]: thM2S as UiTask,
  [thM3D.taskId]: thM3D as UiTask,
  [thM3S.taskId]: thM3S as UiTask,
  [thM4D.taskId]: thM4D as UiTask,
  [thM4S.taskId]: thM4S as UiTask,
  [thF1G1.taskId]: thF1G1 as UiTask,
  [thF1G2.taskId]: thF1G2 as UiTask,
  [thF1I1.taskId]: thF1I1 as UiTask,
  [thF1S1.taskId]: thF1S1 as UiTask,
  [thF1D1.taskId]: thF1D1 as UiTask,
  [thF2G1.taskId]: thF2G1 as UiTask,
  [thF2G2.taskId]: thF2G2 as UiTask,
  [thF2I1.taskId]: thF2I1 as UiTask,
  [thF2S1.taskId]: thF2S1 as UiTask,
  [thF2D1.taskId]: thF2D1 as UiTask,
  [thF3G1.taskId]: thF3G1 as UiTask,
  [thF3G2.taskId]: thF3G2 as UiTask,
  [thF3I1.taskId]: thF3I1 as UiTask,
  [thF3S1.taskId]: thF3S1 as UiTask,
  [thF3D1.taskId]: thF3D1 as UiTask,
  [tCppG1.taskId]: tCppG1 as UiTask,
  [tCppG2.taskId]: tCppG2 as UiTask,
  [tCppG3.taskId]: tCppG3 as UiTask,
  [tCppG4.taskId]: tCppG4 as UiTask,
  [tCppI1.taskId]: tCppI1 as UiTask,
  [tCppI2.taskId]: tCppI2 as UiTask,
  [tCppI3.taskId]: tCppI3 as UiTask,
  [tCppS1.taskId]: tCppS1 as UiTask,
  [tCppD1.taskId]: tCppD1 as UiTask,
};

/** themes families (micro lessons + Theme 1) — board tasks ride rondo.gridboard@1. */
const THEMES_TASK_PREFIXES = ['thm.m', 'thm.f'];
export function isThemesTask(taskId: string): boolean {
  return THEMES_TASK_PREFIXES.some((p) => taskId.startsWith(p));
}

export function isStepsTask(task: UiTask): task is UiTask & { givens: StepProgramStateV1 } {
  return task.taskFamily === CPP_TASK_FAMILY;
}

/** Steps-family editor constraints (task file operationConstraints[0]). */
export interface StepsConstraints {
  type: 'StepProgram';
  editableSlots: string[];
  slotDomains?: Record<string, number[]>;
  insertableKinds: Array<'ASSIGN' | 'OUTPUT' | 'IF' | 'FOR'>;
  deletableSteps: number[];
  maxProgramSteps: number;
  maxOutputLines: number;
}

export function stepsConstraintsOf(task: UiTask): StepsConstraints | null {
  const c = task.operationConstraints.find((x) => (x as { type?: string }).type === 'StepProgram');
  return (c as unknown as StepsConstraints) ?? null;
}

export function getUiTask(taskId: string): UiTask {
  const t = TASK_MAP[taskId];
  if (!t) throw new Error(`未知任务 ${taskId}`);
  return t;
}

export function materialVisible(task: UiTask, material: string, phase: string): boolean {
  return task.visibility.find((v) => v.material === material)?.phases.includes(phase) ?? false;
}

export interface LessonView {
  lessonId: string;
  releaseId: string;
  title: string;
  taskOrder: string[];
  delayedTransferTaskId?: string;
}

/** Course-list order: micro lessons → Theme 1 → cylinder L1–L4 → GESP-2 unit. */
export const LESSONS: LessonView[] = [
  ...(themesLessonsJson.lessons as LessonView[]).filter((l) => l.lessonId.startsWith('themes.micro.')),
  ...(themesLessonsJson.lessons as LessonView[]).filter((l) => !l.lessonId.startsWith('themes.micro.')),
  ...(lessonsJson.lessons as LessonView[]),
  ...(cppLessonsJson.lessons as LessonView[]),
];

// response form registry (predict asks / verify items; shapes documented in
// scripts/build-content.mjs)
export const RESPONSE_REGISTRY = registryJson as unknown as {
  propertyLabels: Record<string, string>;
  directionLabels: Record<string, string>;
  schemas: Array<{
    schemaId: string;
    summary: string;
    predict:
      | {
          asks: Array<{
            id: string;
            kind: string;
            prompt: string;
            properties?: string[];
            optionalUncertain?: boolean;
            options?: Array<{ id: string; label: string }>;
            units?: Array<{ id: string; label: string }>;
            quantityLabel?: string;
            leftIds?: string[];
            rightOptions?: Array<{ id: string; label: string }>;
            directionOptions?: Array<{ id: string; label: string }>;
          }>;
        }
      | null;
    verify:
      | {
          items?: Array<Record<string, unknown>>;
          segments?: Array<{ id: string; label: string; item: Record<string, unknown> }>;
        }
      | null;
  }>;
};

// themes response registry (public tree; shapes documented in
// scripts/build-content-themes.mjs)
export const THEMES_RESPONSE_REGISTRY = themesRegistryJson as unknown as {
  registryVersion: string;
  representationNote: string;
  schemas: Array<{
    schemaId: string;
    summary: string;
    predict:
      | {
          asks: Array<{
            id: string;
            kind: string;
            prompt: string;
            properties?: string[];
            optionalUncertain?: boolean;
            options?: Array<{ id: string; label: string }>;
            units?: Array<{ id: string; label: string }>;
            quantityLabel?: string;
            leftIds?: string[];
            rightOptions?: Array<{ id: string; label: string }>;
          }>;
        }
      | null;
    verify:
      | {
          items?: Array<Record<string, unknown>>;
          segments?: Array<{ id: string; label: string; item: Record<string, unknown> }>;
        }
      | null;
  }>;
};

// cpp.steps.v1 response registry (predict asks may carry a `tasks` filter;
// program.v1 carries perTaskConcept selections for the conceptCheck segment)
export interface CppAsk {
  id: string;
  kind: string;
  prompt: string;
  optionalUncertain?: boolean;
  maxLines?: number;
  quantityLabel?: string;
  tasks?: string[];
  options?: Array<{ id: string; label: string }>;
}

export interface CppVerifyItem {
  kind: string;
  quantityId?: string;
  prompt: string;
  maxLines?: number;
  variables?: Array<{ id: string; label: string }>;
  checkpoints?: Array<{ checkpointId: string; label: string }>;
  options?: Array<{ id: string; label: string }>;
  selectionId?: string;
}

export const CPP_RESPONSE_REGISTRY = cppRegistryJson as unknown as {
  schemas: Array<{
    schemaId: string;
    summary: string;
    predict?: { asks: CppAsk[] } | null;
    verify?: { items?: CppVerifyItem[]; segments?: Array<{ id: string; label: string; item: CppVerifyItem }> } | null;
    perTaskConcept?: Record<string, CppVerifyItem & { kind: string; selectionId: string; options: Array<{ id: string; label: string }> }>;
  }>;
};

/** cpp program.v1 enabled segments mirror the private bindings (same precedent as cylinder D1/S1 in the player). */
export const CPP_ENABLED_SEGMENTS: Record<string, string[]> = {
  'cpp.u1.i1.fix-boundary.v1': ['outputAnswer', 'finalVariables', 'conceptCheck'],
  'cpp.u1.i2.enum-count.v1': ['outputAnswer', 'finalVariables', 'conceptCheck'],
  'cpp.u1.i3.build-digits.v1': ['outputAnswer', 'finalVariables', 'conceptCheck'],
  'cpp.u1.s1.stranger-transfer.v1': ['outputAnswer', 'finalVariables', 'conceptCheck'],
  'cpp.u1.d1.delayed-transfer.v1': ['outputAnswer', 'finalVariables', 'conceptCheck'],
};

export type { StepProgramStateV1, StepSpecV1 };

export function getSchema(schemaId: string) {
  const s =
    RESPONSE_REGISTRY.schemas.find((x) => x.schemaId === schemaId) ??
    THEMES_RESPONSE_REGISTRY.schemas.find((x) => x.schemaId === schemaId) ??
    CPP_RESPONSE_REGISTRY.schemas.find((x) => x.schemaId === schemaId);
  if (!s) throw new Error(`未知 response schema ${schemaId}`);
  return s;
}
