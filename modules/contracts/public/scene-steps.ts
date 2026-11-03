/**
 * Step-program scene contracts (rondo.steps@1): the teaching-model step card
 * family for taskFamily cpp.steps.v1 (GESP 2 unit 1).
 *
 * Frozen sources (GESP2 contract delta, approved 2026-10-27):
 * - ARCHITECTURE §9 (rondo-step.v1: variable assignment, sequential
 *   arithmetic, structured if, bounded for; at most 200 steps; real C++
 *   execution stays R4-gated)
 * - GESP2-CONTRACT-DELTA §2/§3 (StepProgramStateV1, StepOperationV1,
 *   StepSpecV1 semantics; A-1..A-9 adjudications)
 * - SCENE-CONTRACTS §1/§6 (dual DOM expressions STEP_TABLE/STATE_TRACE,
 *   keyboard equivalence, no WebGL dependency)
 *
 * Renderer-visible: no server/sqlite/Node imports. Expressions and conditions
 * travel as bounded source strings; the shared pure interpreter
 * (modules/scenes/steps/engine.ts) is the single grammar+semantics authority
 * for both the UI preview and server-side rule recomputation — there is
 * exactly one implementation of rondo-step.v1 evaluation in this tree.
 */
import { z } from 'zod';
import { idSchema, nonNegativeIntSchema } from './protocol';

export const STEP_RENDERER_ID = 'rondo.steps' as const;
export const STEP_RENDERER_CONTRACT_VERSION = '1' as const;

/** Teaching-model integer domain: |v| <= 10^9 (A-4); out-of-range hard-stops. */
export const STEP_VALUE_LIMIT = 1_000_000_000;
/** Teaching-model step budget: executed ASSIGN/OUTPUT statements (A-9). */
export const STEP_BUDGET = 200;
/** Card-level statement-count ceiling used by editor validation. */
export const STEP_MAX_STATEMENTS = 64;
/** Max output lines a step program may produce (answer-entry form budget). */
export const STEP_MAX_OUTPUT_LINES = 8;

/**
 * Bounded expression/condition source text. Grammar is enforced by the shared
 * engine parser (int literals, identifiers, + - * / % and parentheses;
 * comparisons == != < <= > >=, && || ! for conditions); this schema only
 * bounds the surface so envelopes can never carry oversized programs.
 */
const stepTextSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_+\-*/%() !=<>&|]+$/, 'step expression/condition charset');

const stepVarSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z_0-9]*$/, 'step variable identifier')
  .max(16);

/**
 * StepSpecV1 (CONTRACT-DELTA §3). FOR is the three-part bounded form
 * `for (var = from; var cmp bound; var = var + 1)` — step fixed at +1,
 * shown read-only (A-2); loop var is read-only inside the body and
 * from/bound are evaluated once before the loop (A-6).
 */
export const stepSpecV1Schema: z.ZodType<StepSpecV1> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({ kind: z.literal('ASSIGN'), var: stepVarSchema, expr: stepTextSchema })
      .strict(),
    z
      .object({ kind: z.literal('OUTPUT'), expr: stepTextSchema })
      .strict(),
    z
      .object({
        kind: z.literal('IF'),
        checkpointId: idSchema.optional(),
        cond: stepTextSchema,
        then: z.array(stepSpecV1Schema).max(8),
        else: z.array(stepSpecV1Schema).max(8),
      })
      .strict(),
    z
      .object({
        kind: z.literal('FOR'),
        var: stepVarSchema,
        from: stepTextSchema,
        bound: stepTextSchema,
        cmp: z.enum(['<', '<=']),
        body: z.array(stepSpecV1Schema).min(1).max(8),
      })
      .strict(),
  ]),
);

export type StepSpecV1 =
  | { kind: 'ASSIGN'; var: string; expr: string }
  | { kind: 'OUTPUT'; expr: string }
  | { kind: 'IF'; checkpointId?: string; cond: string; then: StepSpecV1[]; else: StepSpecV1[] }
  | { kind: 'FOR'; var: string; from: string; bound: string; cmp: '<' | '<='; body: StepSpecV1[] };

export function safeParseStepSpecV1(input: unknown): z.SafeParseReturnType<unknown, StepSpecV1> {
  return stepSpecV1Schema.safeParse(input);
}

/** Frozen inputs (givens) for one run; values inside the teaching-model domain. */
const stepInputsV1Schema = z.record(
  z.number().int().min(-STEP_VALUE_LIMIT).max(STEP_VALUE_LIMIT),
);

export const stepProgramStateV1Schema = z
  .object({
    program: z.array(stepSpecV1Schema).min(1).max(STEP_MAX_STATEMENTS),
    inputs: stepInputsV1Schema,
    cursorStep: nonNegativeIntSchema,
  })
  .strict();

export type StepProgramStateV1 = z.infer<typeof stepProgramStateV1Schema>;

export function parseStepProgramStateV1(input: unknown): StepProgramStateV1 {
  return stepProgramStateV1Schema.parse(input);
}

export function safeParseStepProgramStateV1(input: unknown): z.SafeParseReturnType<unknown, StepProgramStateV1> {
  return stepProgramStateV1Schema.safeParse(input);
}

export const STEP_OPERATION_TYPES = ['EditStepProgram', 'SetTraceCursor'] as const;
export type StepOperationType = (typeof STEP_OPERATION_TYPES)[number];

/**
 * Typed operations for the steps family (CONTRACT-DELTA §2): whole-card
 * normalized program submission (draft lives in ViewState) and trace cursor
 * control. Both travel through the existing learning.commitOperation channel;
 * no new command kinds, no new error codes.
 */
export const stepOperationV1Schema = z
  .discriminatedUnion('type', [
    z
      .object({ type: z.literal('EditStepProgram'), steps: z.array(stepSpecV1Schema).min(1).max(STEP_MAX_STATEMENTS) })
      .strict(),
    z
      .object({ type: z.literal('SetTraceCursor'), mode: z.enum(['RESET', 'END', 'AT']), index: nonNegativeIntSchema.optional() })
      .strict(),
  ])
  .superRefine((op, ctx) => {
    if (op.type === 'SetTraceCursor' && op.mode === 'AT' && op.index === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SetTraceCursor AT requires index' });
    }
  });

export type StepOperationV1 = z.infer<typeof stepOperationV1Schema>;

export function parseStepOperationV1(input: unknown): StepOperationV1 {
  return stepOperationV1Schema.parse(input);
}

export function safeParseStepOperationV1(input: unknown): z.SafeParseReturnType<unknown, StepOperationV1> {
  return stepOperationV1Schema.safeParse(input);
}

/**
 * Per-task editor constraints (narrow the family-wide allowance; the server
 * re-validates every EditStepProgram against these before applying).
 * Slot paths address the CURRENT card positionally:
 *   step[<topIndex>].expr | .cond | .cmp | .bound | .from
 *   step[<i>].body[<j>].cond | ... (nested bodies/branches, same member names)
 */
export const stepEditorConstraintsV1Schema = z
  .object({
    type: z.literal('StepProgram'),
    editableSlots: z.array(z.string().min(3).max(64)).max(32),
    /** Optional literal domains for editable slots (e.g. bound ∈ {5,10,100}). */
    slotDomains: z.record(z.array(z.number().int().min(-STEP_VALUE_LIMIT).max(STEP_VALUE_LIMIT)).min(1).max(16)).optional(),
    insertableKinds: z.array(z.enum(['ASSIGN', 'OUTPUT', 'IF', 'FOR'])).max(4),
    /** Top-level positions (in the current card) that may be deleted. */
    deletableSteps: z.array(z.number().int().min(0).max(63)).max(32),
    maxProgramSteps: z.number().int().min(1).max(STEP_MAX_STATEMENTS),
    maxOutputLines: z.number().int().min(1).max(STEP_MAX_OUTPUT_LINES),
  })
  .strict();

export type StepEditorConstraintsV1 = z.infer<typeof stepEditorConstraintsV1Schema>;
