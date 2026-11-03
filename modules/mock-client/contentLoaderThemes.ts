/**
 * MOCK_ONLY themes (themes.micro.v1 / themes.frac.v1) content loader:
 * statically imports the content/themes-a tree (public AND private — the mock
 * acts as the dev-side Host) so the same JSON files the release manifest
 * hashes are the ones judged and served.
 *
 * NEVER imported by apps/web/src/main.tsx (product entry); only main.dev.tsx
 * (dev bundle), node tests and the mock store/evaluator reach this module.
 */
import type { AuthoredBlocks } from '../contracts/public/question';
import type { GridBoardStateV1 } from '../contracts/public/scene-gridboard';
import type { CylinderStateV1 } from '../contracts/public/scene';
import type { GridTaskTruthRuleV1 } from '../contracts/server/rules-themes';

import lessonsJson from '../../content/themes-a/public/lessons.json';
import registryJson from '../../content/themes-a/public/schemas/response-schemas.registry.json';
import bindingsM1 from '../../content/themes-a/private/bindings/m1-r1.bindings.private.json';
import bindingsM2 from '../../content/themes-a/private/bindings/m2-r1.bindings.private.json';
import bindingsM3 from '../../content/themes-a/private/bindings/m3-r1.bindings.private.json';
import bindingsM4 from '../../content/themes-a/private/bindings/m4-r1.bindings.private.json';
import bindingsL1 from '../../content/themes-a/private/bindings/t1l1-r1.bindings.private.json';
import bindingsL2 from '../../content/themes-a/private/bindings/t1l2-r1.bindings.private.json';
import bindingsL3 from '../../content/themes-a/private/bindings/t1l3-r1.bindings.private.json';
import answerHintsJson from '../../content/themes-a/private/hints/answer-hints.json';
import ruleM1 from '../../content/themes-a/private/rules/rule.thm.m1.v1.json';
import ruleM2 from '../../content/themes-a/private/rules/rule.thm.m2.v1.json';
import ruleM3 from '../../content/themes-a/private/rules/rule.thm.m3.v1.json';
import ruleM4 from '../../content/themes-a/private/rules/rule.thm.m4.v1.json';
import ruleF1 from '../../content/themes-a/private/rules/rule.thm.f1.v1.json';
import ruleF2 from '../../content/themes-a/private/rules/rule.thm.f2.v1.json';
import ruleF3 from '../../content/themes-a/private/rules/rule.thm.f3.v1.json';
import instF1I1 from '../../content/themes-a/private/instances/thm.f1.i1.v1-instances.json';
import instF1S1 from '../../content/themes-a/private/instances/thm.f1.s1.v1-instances.json';
import instF1D1 from '../../content/themes-a/private/instances/thm.f1.d1.v1-instances.json';
import instF2I1 from '../../content/themes-a/private/instances/thm.f2.i1.v1-instances.json';
import instF2S1 from '../../content/themes-a/private/instances/thm.f2.s1.v1-instances.json';
import instF2D1 from '../../content/themes-a/private/instances/thm.f2.d1.v1-instances.json';
import instF3I1 from '../../content/themes-a/private/instances/thm.f3.i1.v1-instances.json';
import instF3S1 from '../../content/themes-a/private/instances/thm.f3.s1.v1-instances.json';
import instF3D1 from '../../content/themes-a/private/instances/thm.f3.d1.v1-instances.json';

import tM1D from '../../content/themes-a/public/tasks/thm.m1.diag.v1.json';
import tM1S from '../../content/themes-a/public/tasks/thm.m1.supp.v1.json';
import tM2D from '../../content/themes-a/public/tasks/thm.m2.diag.v1.json';
import tM2S from '../../content/themes-a/public/tasks/thm.m2.supp.v1.json';
import tM3D from '../../content/themes-a/public/tasks/thm.m3.diag.v1.json';
import tM3S from '../../content/themes-a/public/tasks/thm.m3.supp.v1.json';
import tM4D from '../../content/themes-a/public/tasks/thm.m4.diag.v1.json';
import tM4S from '../../content/themes-a/public/tasks/thm.m4.supp.v1.json';
import tF1G1 from '../../content/themes-a/public/tasks/thm.f1.g1.partition-circle.v1.json';
import tF1G2 from '../../content/themes-a/public/tasks/thm.f1.g2.partition-bar.v1.json';
import tF1I1 from '../../content/themes-a/public/tasks/thm.f1.i1.represent.v1.json';
import tF1S1 from '../../content/themes-a/public/tasks/thm.f1.s1.stranger-relabel.v1.json';
import tF1D1 from '../../content/themes-a/public/tasks/thm.f1.d1.delayed-transfer.v1.json';
import tF2G1 from '../../content/themes-a/public/tasks/thm.f2.g1.scale-bar.v1.json';
import tF2G2 from '../../content/themes-a/public/tasks/thm.f2.g2.equivalent-find.v1.json';
import tF2I1 from '../../content/themes-a/public/tasks/thm.f2.i1.numberline.v1.json';
import tF2S1 from '../../content/themes-a/public/tasks/thm.f2.s1.stranger.v1.json';
import tF2D1 from '../../content/themes-a/public/tasks/thm.f2.d1.delayed-transfer.v1.json';
import tF3G1 from '../../content/themes-a/public/tasks/thm.f3.g1.percent-board.v1.json';
import tF3G2 from '../../content/themes-a/public/tasks/thm.f3.g2.discount-chain.v1.json';
import tF3I1 from '../../content/themes-a/public/tasks/thm.f3.i1.allocate.v1.json';
import tF3S1 from '../../content/themes-a/public/tasks/thm.f3.s1.stranger.v1.json';
import tF3D1 from '../../content/themes-a/public/tasks/thm.f3.d1.delayed-transfer.v1.json';

export const THEMES_TASK_FAMILIES = ['themes.micro.v1', 'themes.frac.v1'] as const;

export interface ThemesOperationConstraint {
  type: 'SetGridSize' | 'SetFilled' | 'ScaleBoth' | 'SetDimension';
  rowsValues?: number[];
  colsValues?: number[];
  maxCount?: number;
  multipliers?: number[];
  dimension?: 'RADIUS' | 'HEIGHT';
  minMm?: number;
  maxMm?: number;
}

export interface ThemesPublicTask {
  taskId: string;
  taskVersion: string;
  taskFamily: string;
  kind: 'GUIDED' | 'INDEPENDENT' | 'STRANGER' | 'DELAYED_TRANSFER';
  title: string;
  boardView: string;
  prompt: AuthoredBlocks;
  givens: GridBoardStateV1 | CylinderStateV1;
  givenLocks: string[];
  responseSchemaId: string;
  allowedOperationIds: string[];
  operationConstraints: ThemesOperationConstraint[];
  visibility: Array<{ material: string; phases: string[]; note?: string }>;
  hints: Array<{ level: number; label: string; text?: string }>;
  explain: {
    selections: Array<{ itemId: string; prompt: string; multi?: boolean; options: Array<{ id: string; label: string }> }>;
    freeTextPrompt: string;
  };
  exitEvidence: string[];
  expressions: { boardSvg: string; boardTable: string };
}

const THEMES_TASKS: Record<string, ThemesPublicTask> = {
  [tM1D.taskId]: tM1D as ThemesPublicTask,
  [tM1S.taskId]: tM1S as ThemesPublicTask,
  [tM2D.taskId]: tM2D as ThemesPublicTask,
  [tM2S.taskId]: tM2S as ThemesPublicTask,
  [tM3D.taskId]: tM3D as ThemesPublicTask,
  [tM3S.taskId]: tM3S as ThemesPublicTask,
  [tM4D.taskId]: tM4D as ThemesPublicTask,
  [tM4S.taskId]: tM4S as ThemesPublicTask,
  [tF1G1.taskId]: tF1G1 as ThemesPublicTask,
  [tF1G2.taskId]: tF1G2 as ThemesPublicTask,
  [tF1I1.taskId]: tF1I1 as ThemesPublicTask,
  [tF1S1.taskId]: tF1S1 as ThemesPublicTask,
  [tF1D1.taskId]: tF1D1 as ThemesPublicTask,
  [tF2G1.taskId]: tF2G1 as ThemesPublicTask,
  [tF2G2.taskId]: tF2G2 as ThemesPublicTask,
  [tF2I1.taskId]: tF2I1 as ThemesPublicTask,
  [tF2S1.taskId]: tF2S1 as ThemesPublicTask,
  [tF2D1.taskId]: tF2D1 as ThemesPublicTask,
  [tF3G1.taskId]: tF3G1 as ThemesPublicTask,
  [tF3G2.taskId]: tF3G2 as ThemesPublicTask,
  [tF3I1.taskId]: tF3I1 as ThemesPublicTask,
  [tF3S1.taskId]: tF3S1 as ThemesPublicTask,
  [tF3D1.taskId]: tF3D1 as ThemesPublicTask,
};

const THEMES_RULES: Record<string, unknown> = {
  'rule.thm.m1.v1': ruleM1,
  'rule.thm.m2.v1': ruleM2,
  'rule.thm.m3.v1': ruleM3,
  'rule.thm.m4.v1': ruleM4,
  'rule.thm.f1.v1': ruleF1,
  'rule.thm.f2.v1': ruleF2,
  'rule.thm.f3.v1': ruleF3,
};

export interface ThemesFrozenInstance {
  instanceId: string;
  initial: { rows: number; cols: number; filled: number };
  truth: Record<string, unknown>;
  answerHint: string;
}

const THEMES_INSTANCES: Record<string, { frozen: ThemesFrozenInstance[] }> = {
  'thm.f1.i1.represent.v1': instF1I1 as never,
  'thm.f1.s1.stranger-relabel.v1': instF1S1 as never,
  'thm.f1.d1.delayed-transfer.v1': instF1D1 as never,
  'thm.f2.i1.numberline.v1': instF2I1 as never,
  'thm.f2.s1.stranger.v1': instF2S1 as never,
  'thm.f2.d1.delayed-transfer.v1': instF2D1 as never,
  'thm.f3.i1.allocate.v1': instF3I1 as never,
  'thm.f3.s1.stranger.v1': instF3S1 as never,
  'thm.f3.d1.delayed-transfer.v1': instF3D1 as never,
};

export interface ThemesLessonDef {
  lessonId: string;
  releaseId: string;
  title: string;
  taskFamily: string;
  lessonKind: 'micro' | 'theme';
  taskOrder: string[];
  delayedTransferTaskId?: string;
  delayedTransferWindowDays?: { availableAfterDays: number; nominalEndDays: number };
}

export const THEMES_LESSONS = lessonsJson.lessons as ThemesLessonDef[];

export const THEMES_RESPONSE_REGISTRY = registryJson as unknown as {
  registryVersion: string;
  representationNote: string;
  schemas: Array<{
    schemaId: string;
    summary: string;
    predict?: { asks: Array<Record<string, unknown>> } | null;
    verify?: { items?: Array<Record<string, unknown>>; segments?: Array<{ id: string; label: string; item: Record<string, unknown> }> } | null;
  }>;
};

export const THEMES_ANSWER_HINTS = answerHintsJson as Record<string, Array<{ instanceId: string; level: number; text: string }>>;

interface ThemesBinding {
  taskId: string;
  ruleRef: { ruleId: string; ruleVersion: string; path: string };
  instanceGeneratorRef?: { kind: string; path: string };
  enabledSegments?: string[];
}

const THEMES_BINDINGS = [
  ...bindingsM1.taskBindings,
  ...bindingsM2.taskBindings,
  ...bindingsM3.taskBindings,
  ...bindingsM4.taskBindings,
  ...bindingsL1.taskBindings,
  ...bindingsL2.taskBindings,
  ...bindingsL3.taskBindings,
] as ThemesBinding[];

const TASK_TO_RULE: Record<string, string> = {};
for (const b of THEMES_BINDINGS) TASK_TO_RULE[b.taskId] = b.ruleRef.ruleId;

export function hasThemesTask(taskId: string): boolean {
  return taskId in THEMES_TASKS;
}

export function getThemesTask(taskId: string): ThemesPublicTask {
  const t = THEMES_TASKS[taskId];
  if (!t) throw new Error(`MOCK themes content: unknown task ${taskId}`);
  return t;
}

export function getThemesBindingRuleId(taskId: string): string {
  const ruleId = TASK_TO_RULE[taskId];
  if (!ruleId) throw new Error(`MOCK themes content: no binding for ${taskId}`);
  return ruleId;
}

/** The GRID_TASK_TRUTH body bound to the task (rule files carry `body.kind`). */
export function getThemesRuleEntry(
  taskId: string,
): { entry: GridTaskTruthRuleV1['entries'][string]; ruleId: string } {
  const ruleId = getThemesBindingRuleId(taskId);
  const envelope = THEMES_RULES[ruleId] as { body?: { kind?: string; entries?: Record<string, unknown> } };
  const body = envelope?.body;
  if (body?.kind !== 'GRID_TASK_TRUTH') throw new Error(`MOCK themes content: rule ${ruleId} is not GRID_TASK_TRUTH`);
  const entry = (body.entries as Record<string, GridTaskTruthRuleV1['entries'][string]>)[taskId];
  if (!entry) throw new Error(`MOCK themes content: rule ${ruleId} has no entry for ${taskId}`);
  return { entry, ruleId };
}

export function getThemesFrozenInstance(taskId: string): ThemesFrozenInstance | null {
  const file = THEMES_INSTANCES[taskId];
  if (!file || file.frozen.length === 0) return null;
  return file.frozen[0];
}

export function getThemesAnswerHint(taskId: string): string | null {
  const list = THEMES_ANSWER_HINTS[taskId];
  if (!list || list.length === 0) return null;
  return list[0].text;
}

/** Family-aware lookup used by the shared mock getTask seam. */
export function themesGetTask(taskId: string): ThemesPublicTask | undefined {
  return THEMES_TASKS[taskId];
}
