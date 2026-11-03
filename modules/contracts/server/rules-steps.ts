/**
 * cpp.steps.v1 private rule truth DSL (GESP2 unit-1 contract delta §5,
 * approved 2026-10-27). New module beside the frozen cylinder v2 DSL
 * (rules.ts stays untouched — A-10).
 *
 * Rules are data, never executed content strings (LIFECYCLE §2). The Host
 * recomputes every judgment with the shared pure stepper
 * (modules/scenes/steps/engine.ts): expected outputs are exact per-line
 * string comparisons under the declared normalization, variable finals are
 * compared name-exactly in the int domain, hidden cases rerun the submitted
 * program with frozen inputs, and the stepper enforces the 200-step budget.
 *
 * Changelog:
 * - v1 (2026-10-27, GESP2 unit 1): STEP_RULE_KINDS = EXPECTED_OUTPUT
 *   (reserved, first batch binds no task — same precedent as
 *   resp.l1.changeClassify.v1) + STEP_TASK_TRUTH. One minimal addition over
 *   the approved draft: the optional `judging.outputSource` flag that freezes
 *   UNIT-SPEC §6 semantics — 'AUTHORED' (typed output compared to the
 *   authored expectedLines; construction tasks i1/i2/i3/s1/d1 and g2) vs
 *   'SNAPSHOT_RERUN' (typed output compared to the submitted snapshot's own
 *   recomputation; trace tasks g1/g3/g4 per spec §4). Variable finals are
 *   always judged against the submitted snapshot's recomputation (§6.2).
 */
import { z } from 'zod';
import { idSchema } from '../public/protocol';

export const STEP_RULE_KINDS = ['EXPECTED_OUTPUT', 'STEP_TASK_TRUTH'] as const;
export type StepRuleKind = (typeof STEP_RULE_KINDS)[number];

const intLiteralLine = z.string().regex(/^-?\d+$/, 'one integer per output line');

/** Single run case: rerun with replaced inputs, expected output lines. */
export const stepRunCaseV1Schema = z.object({
  caseId: idSchema,
  inputs: z.record(z.number().int().min(-1_000_000_000).max(1_000_000_000)),
  expectedLines: z.array(intLiteralLine).min(1).max(8),
}).strict();
export type StepRunCaseV1 = z.infer<typeof stepRunCaseV1Schema>;

export const branchCheckpointV1Schema = z.object({
  checkpointId: idSchema,
  expected: z.enum(['TAKEN', 'SKIPPED']),
}).strict();
export type BranchCheckpointV1 = z.infer<typeof branchCheckpointV1Schema>;

export const conceptCheckV1Schema = z.object({
  selectionId: idSchema, // corresponds to explain/predict-verify concept choice
  correctOptionId: idSchema,
}).strict();
export type ConceptCheckV1 = z.infer<typeof conceptCheckV1Schema>;

export const numberCheckV1Schema = z.object({
  itemId: idSchema, // corresponds to verify numberValue item (e.g. loop trip count)
  expected: z.number().int().min(-1_000_000_000).max(1_000_000_000),
}).strict();
export type NumberCheckV1 = z.infer<typeof numberCheckV1Schema>;

export const structuralConstraintsV1Schema = z.object({
  requiredConstructs: z.array(z.enum(['IF', 'FOR'])).max(2),
  maxProgramSteps: z.number().int().min(1).max(40), // card-level budget, below the global 200
  maxOutputLines: z.number().int().min(1).max(8),
}).strict();
export type StructuralConstraintsV1 = z.infer<typeof structuralConstraintsV1Schema>;

/** How the typed output answer is keyed (UNIT-SPEC §6; see module header). */
export const stepJudgingV1Schema = z.object({
  outputSource: z.enum(['AUTHORED', 'SNAPSHOT_RERUN']),
}).strict();
export type StepJudgingV1 = z.infer<typeof stepJudgingV1Schema>;

/**
 * Pure run-and-read task truth: taskId → expected lines + finals.
 * Reserved minimal kind; first batch binds no task (delta §5).
 */
export const expectedOutputEntryV1Schema = z.object({
  visibleCase: stepRunCaseV1Schema,
  expectedFinalVariables: z.record(z.number().int()).optional(),
  normalization: z.literal('LINES_TRIM_TRAILING_WS_DROP_TRAILING_EMPTY'),
  feedback: z.object({ reviseGeneric: z.string().min(1) }).strict().optional(),
}).strict();

export const expectedOutputRuleSchema = z.object({
  kind: z.literal('EXPECTED_OUTPUT'),
  entries: z.record(expectedOutputEntryV1Schema)
    .refine((e) => Object.keys(e).length >= 1, 'at least one task entry'),
}).strict();
export type ExpectedOutputRule = z.infer<typeof expectedOutputRuleSchema>;

/**
 * Construct/repair/read-program task truth: visible case (+ hidden reruns) +
 * trace/concept/number/structural truths. Diagnostics never carry expected
 * values (v2 diagnostics style).
 */
export const stepTaskTruthEntryV1Schema = z.object({
  visibleCase: stepRunCaseV1Schema,
  hiddenCases: z.array(stepRunCaseV1Schema).max(4),
  /** Authored branch truth for the canonical card (REVIEW reveal anchor);
   * judging recomputes from the submitted snapshot. */
  branchCheckpoints: z.array(branchCheckpointV1Schema).max(8).optional(),
  conceptChecks: z.array(conceptCheckV1Schema).max(8).optional(),
  numberChecks: z.array(numberCheckV1Schema).max(4).optional(),
  structural: structuralConstraintsV1Schema.optional(),
  judging: stepJudgingV1Schema.optional(), // default 'AUTHORED'
  diagnostics: z.object({
    offByOneBound: z.string().min(1).optional(),
    samplePassedHiddenFailed: z.string().min(1).optional(),
    divRounding: z.string().min(1).optional(),
  }).strict().optional(),
  feedback: z.object({ reviseGeneric: z.string().min(1) }).strict().optional(),
}).strict();
export type StepTaskTruthEntryV1 = z.infer<typeof stepTaskTruthEntryV1Schema>;

export const stepTaskTruthRuleSchema = z.object({
  kind: z.literal('STEP_TASK_TRUTH'),
  stepBudget: z.literal(200), // matches ARCHITECTURE §9 / A-9
  entries: z.record(stepTaskTruthEntryV1Schema)
    .refine((e) => Object.keys(e).length >= 1, 'at least one task entry'),
}).strict();
export type StepTaskTruthRule = z.infer<typeof stepTaskTruthRuleSchema>;

export const ruleBodyStepsV1Schema = z.discriminatedUnion('kind', [
  expectedOutputRuleSchema,
  stepTaskTruthRuleSchema,
]);
export type RuleBodyStepsV1 = z.infer<typeof ruleBodyStepsV1Schema>;

export function safeParseRuleBodyStepsV1(input: unknown): z.SafeParseReturnType<unknown, RuleBodyStepsV1> {
  return ruleBodyStepsV1Schema.safeParse(input);
}
