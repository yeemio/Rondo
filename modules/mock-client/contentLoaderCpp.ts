/**
 * MOCK_ONLY cpp.steps.v1 content loader: statically imports the content/cpp
 * tree (public AND private — the mock acts as the dev-side Host) so the same
 * JSON files the release manifest hashes are the ones judged and served.
 *
 * NEVER imported by apps/web/src/main.tsx (product entry); only main.dev.tsx
 * (dev bundle), node tests and the mock store/evaluator reach this module.
 */
import type { AuthoredBlocks } from '../contracts/public/question';
import type { StepProgramStateV1 } from '../contracts/public/scene-steps';
import type { StepTaskTruthRule } from '../contracts/server/rules-steps';

import lessonsJson from '../../content/cpp/public/lessons.json';
import registryJson from '../../content/cpp/public/schemas/response-schemas.registry.json';
import bindingsJson from '../../content/cpp/private/bindings/u1-r1.bindings.private.json';
import answerHintsJson from '../../content/cpp/private/hints/answer-hints.json';
import ruleTrace from '../../content/cpp/private/rules/rule.cppU1.trace.v1.json';
import ruleBranch from '../../content/cpp/private/rules/rule.cppU1.branch.v1.json';
import ruleProgram from '../../content/cpp/private/rules/rule.cppU1.program.v1.json';
import instI1 from '../../content/cpp/private/instances/cpp.u1.i1.v1-instances.json';
import instI2 from '../../content/cpp/private/instances/cpp.u1.i2.v1-instances.json';
import instI3 from '../../content/cpp/private/instances/cpp.u1.i3.v1-instances.json';
import instS1 from '../../content/cpp/private/instances/cpp.u1.s1.v1-instances.json';
import instD1 from '../../content/cpp/private/instances/cpp.u1.d1.v1-instances.json';

import tG1 from '../../content/cpp/public/tasks/cpp.u1.g1.receipt-trace.v1.json';
import tG2 from '../../content/cpp/public/tasks/cpp.u1.g2.pack-sweets.v1.json';
import tG3 from '../../content/cpp/public/tasks/cpp.u1.g3.member-discount.v1.json';
import tG4 from '../../content/cpp/public/tasks/cpp.u1.g4.sales-sum.v1.json';
import tI1 from '../../content/cpp/public/tasks/cpp.u1.i1.fix-boundary.v1.json';
import tI2 from '../../content/cpp/public/tasks/cpp.u1.i2.enum-count.v1.json';
import tI3 from '../../content/cpp/public/tasks/cpp.u1.i3.build-digits.v1.json';
import tS1 from '../../content/cpp/public/tasks/cpp.u1.s1.stranger-transfer.v1.json';
import tD1 from '../../content/cpp/public/tasks/cpp.u1.d1.delayed-transfer.v1.json';

export const CPP_TASK_FAMILY = 'cpp.steps.v1';

export interface CppVisibilityRule {
  material: string;
  phases: string[];
  note?: string;
}

export interface CppStepConstraint {
  type: 'StepProgram';
  editableSlots: string[];
  slotDomains?: Record<string, number[]>;
  insertableKinds: Array<'ASSIGN' | 'OUTPUT' | 'IF' | 'FOR'>;
  deletableSteps: number[];
  maxProgramSteps: number;
  maxOutputLines: number;
}

export interface CppPublicTask {
  taskId: string;
  taskVersion: string;
  taskFamily: string;
  kind: 'GUIDED' | 'INDEPENDENT' | 'STRANGER' | 'DELAYED_TRANSFER';
  title: string;
  prompt: AuthoredBlocks;
  givens: StepProgramStateV1;
  givenLocks: string[];
  responseSchemaId: string;
  allowedOperationIds: string[];
  operationConstraints: CppStepConstraint[];
  visibility: CppVisibilityRule[];
  mission: string;
  hints: Array<{ level: number; label: string; text?: string; revealsAnswer?: boolean }>;
  explain: {
    selections: Array<{ itemId: string; prompt: string; options: Array<{ id: string; label: string }> }>;
    freeTextPrompt: string;
  };
  exitEvidence: string[];
  expressions: { stepTable: string; stateTrace: string };
}

const CPP_TASKS: Record<string, CppPublicTask> = {
  [tG1.taskId]: tG1 as CppPublicTask,
  [tG2.taskId]: tG2 as CppPublicTask,
  [tG3.taskId]: tG3 as CppPublicTask,
  [tG4.taskId]: tG4 as CppPublicTask,
  [tI1.taskId]: tI1 as CppPublicTask,
  [tI2.taskId]: tI2 as CppPublicTask,
  [tI3.taskId]: tI3 as CppPublicTask,
  [tS1.taskId]: tS1 as CppPublicTask,
  [tD1.taskId]: tD1 as CppPublicTask,
};

const CPP_RULES: Record<string, unknown> = {
  'rule.cppU1.trace.v1': ruleTrace,
  'rule.cppU1.branch.v1': ruleBranch,
  'rule.cppU1.program.v1': ruleProgram,
};

const CPP_INSTANCES: Record<string, { frozen: Array<{ instanceId: string; inputs: Record<string, number>; truth: Record<string, unknown>; answerHint: string }> }> = {
  'cpp.u1.i1.fix-boundary.v1': instI1 as never,
  'cpp.u1.i2.enum-count.v1': instI2 as never,
  'cpp.u1.i3.build-digits.v1': instI3 as never,
  'cpp.u1.s1.stranger-transfer.v1': instS1 as never,
  'cpp.u1.d1.delayed-transfer.v1': instD1 as never,
};

export interface CppLessonDef {
  lessonId: string;
  releaseId: string;
  title: string;
  taskFamily: string;
  taskOrder: string[];
  delayedTransferTaskId?: string;
  delayedTransferWindowDays?: { availableAfterDays: number; nominalEndDays: number };
  note?: string;
}

export const CPP_LESSONS = lessonsJson.lessons as CppLessonDef[];

export interface CppResponseRegistry {
  registryVersion: number;
  representationNote: string;
  schemas: Array<{
    schemaId: string;
    summary: string;
    predict?: { asks: Array<Record<string, unknown>> } | null;
    verify?: { items?: Array<Record<string, unknown>>; segments?: Array<{ id: string; label: string; item: Record<string, unknown> }> } | null;
    perTaskConcept?: Record<string, Record<string, unknown>>;
  }>;
}

export const CPP_RESPONSE_REGISTRY = registryJson as unknown as CppResponseRegistry;

export const CPP_ANSWER_HINTS = answerHintsJson as Record<string, Array<{ instanceId: string; level: number; text: string }>>;

interface CppBinding {
  taskId: string;
  ruleRef: { ruleId: string; ruleVersion: string; path: string };
  instanceGeneratorRef?: { kind: string; path: string };
  enabledSegments?: string[];
}

const CPP_BINDINGS = (bindingsJson as { taskBindings: CppBinding[] }).taskBindings;

export function hasCppTask(taskId: string): boolean {
  return taskId in CPP_TASKS;
}

export function getCppTask(taskId: string): CppPublicTask {
  const t = CPP_TASKS[taskId];
  if (!t) throw new Error(`MOCK cpp content: unknown task ${taskId}`);
  return t;
}

export function getCppBindingRuleId(taskId: string): string {
  const b = CPP_BINDINGS.find((x) => x.taskId === taskId);
  if (!b) throw new Error(`MOCK cpp content: no binding for ${taskId}`);
  return b.ruleRef.ruleId;
}

export function getCppEnabledSegments(taskId: string): string[] | undefined {
  return CPP_BINDINGS.find((x) => x.taskId === taskId)?.enabledSegments;
}

export function getCppRuleBody(taskId: string): StepTaskTruthRule {
  const ruleId = getCppBindingRuleId(taskId);
  const envelope = CPP_RULES[ruleId] as { body?: { kind?: string } } | undefined;
  const body = envelope?.body;
  if (body?.kind !== 'STEP_TASK_TRUTH') throw new Error(`MOCK cpp content: rule ${ruleId} is not STEP_TASK_TRUTH`);
  return body as unknown as StepTaskTruthRule;
}

export function getCppFrozenInstance(taskId: string): { instanceId: string; inputs: Record<string, number>; truth: Record<string, unknown>; answerHint: string } | null {
  const file = CPP_INSTANCES[taskId];
  if (!file || file.frozen.length === 0) return null;
  return file.frozen[0];
}

export function getCppAnswerHint(taskId: string): string | null {
  const list = CPP_ANSWER_HINTS[taskId];
  if (!list || list.length === 0) return null;
  return list[0].text;
}

/** Family-aware lookup used by the shared mock getTask seam. */
export function cppGetTask(taskId: string): CppPublicTask | undefined {
  return CPP_TASKS[taskId];
}
