/**
 * themes.micro.v1 / themes.frac.v1 private rule truth DSL (THEMES-A contract
 * delta, 2026-10-27). New module beside the frozen cylinder v2 DSL (rules.ts
 * stays untouched), mirroring the approved GESP2 rules-steps.ts precedent.
 *
 * Rules are data, never executed content strings (LIFECYCLE §2). The Host
 * recomputes every judgment with the shared pure judge
 * (modules/scenes/gridboard/judge.ts): numbers compare as exact rationals
 * after the declared decimal rounding (never a float tolerance), fractions
 * compare either literally (EXACT) or by reduced equality (REDUCED_EQUALS),
 * choices and mappings compare stable object ids, and misconception
 * diagnostics match authored patterns WITHOUT ever revealing an expected
 * value in feedback.
 */
import { z } from 'zod';
import { idSchema } from '../public/protocol';

export const THEMES_RULE_KINDS = ['GRID_TASK_TRUTH'] as const;
export type ThemesRuleKind = (typeof THEMES_RULE_KINDS)[number];

/** Exact decimal literal, e.g. "64.00", "7.5", "16". No exponent form. */
const exactDecimalSchema = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'exact decimal literal');

/** Explicit decimal rounding discipline; never a float tolerance. */
const roundingSchema = z
  .object({ mode: z.literal('HALF_UP'), decimalPlaces: z.number().int().min(0).max(4) })
  .strict();
export type ThemesRounding = z.infer<typeof roundingSchema>;

// ---------------------------------------------------------------------------
// Check shapes (one per verify item the task asks)
// ---------------------------------------------------------------------------

/** Where a numeric truth comes from: an authored constant or the confirmed board/circle snapshot. */
const numberSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('AUTHORED'),
      /** canonical unit the expectedDecimal is expressed in */
      unitId: idSchema,
      expectedDecimal: exactDecimalSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('FROM_STATE'),
      /** GRID_CELLS = rows×cols（格数/个数）; GRID_AREA_CM2 = rows×cols（每格 1 cm²）;
       * FILLED_PERCENT = filled（百格板）; DIAMETER_CM = 2×radiusMm/10; RADIUS_CM = radiusMm/10. */
      derive: z.enum(['GRID_CELLS', 'GRID_AREA_CM2', 'FILLED_PERCENT', 'DIAMETER_CM', 'RADIUS_CM']),
    })
    .strict(),
]);
export type ThemesNumberSource = z.infer<typeof numberSourceSchema>;

const numberCheckSchema = z
  .object({
    id: idSchema,
    kind: z.literal('number'),
    quantityId: idSchema,
    source: numberSourceSchema,
    acceptedUnitIds: z.array(idSchema).min(1).max(8),
    rounding: roundingSchema,
    /** human label for the verify item result row */
    label: z.string().min(1).max(64),
  })
  .strict();
export type ThemesNumberCheck = z.infer<typeof numberCheckSchema>;

const fractionComparisonSchema = z.discriminatedUnion('kind', [
  /** submitted num/den must literally equal the truth's num/den as typed */
  z.object({ kind: z.literal('EXACT') }).strict(),
  /** submitted fraction, reduced, equals the truth (等值判断) */
  z
    .object({ kind: z.literal('REDUCED_EQUALS') })
    .strict(),
]);
export type ThemesFractionComparison = z.infer<typeof fractionComparisonSchema>;

const fractionSourceSchema = z.discriminatedUnion('kind', [
  /** truth from the confirmed board state (filled/cols) */
  z.object({ kind: z.literal('FROM_STATE') }).strict(),
  /** authored fraction truth (problem-chain answers, 读点答案) */
  z
    .object({ kind: z.literal('AUTHORED'), numerator: z.number().int().min(0).max(9999), denominator: z.number().int().min(1).max(9999) })
    .strict(),
]);
export type ThemesFractionSource = z.infer<typeof fractionSourceSchema>;

const fractionCheckSchema = z
  .object({
    id: idSchema,
    kind: z.literal('fraction'),
    quantityId: idSchema,
    source: fractionSourceSchema,
    comparison: fractionComparisonSchema,
    label: z.string().min(1).max(64),
  })
  .strict();
export type ThemesFractionCheck = z.infer<typeof fractionCheckSchema>;

const choiceCheckSchema = z
  .object({
    id: idSchema,
    kind: z.literal('choice'),
    selectionId: idSchema,
    correctOptionId: idSchema,
    label: z.string().min(1).max(64),
  })
  .strict();
export type ThemesChoiceCheck = z.infer<typeof choiceCheckSchema>;

const mappingCheckSchema = z
  .object({
    id: idSchema,
    kind: z.literal('mapping'),
    expectedPairs: z.array(z.object({ leftId: idSchema, rightId: idSchema }).strict()).min(1).max(12),
    label: z.string().min(1).max(64),
  })
  .strict();
export type ThemesMappingCheck = z.infer<typeof mappingCheckSchema>;

export const themesCheckSchema = z.discriminatedUnion('kind', [
  numberCheckSchema,
  fractionCheckSchema,
  choiceCheckSchema,
  mappingCheckSchema,
]);
export type ThemesCheck = z.infer<typeof themesCheckSchema>;

// ---------------------------------------------------------------------------
// Scenario gate (the operable object must reach a verifiable confirmed state)
// ---------------------------------------------------------------------------

const scenarioSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('GRID_AT'),
      rows: z.number().int().min(1).max(24).optional(),
      cols: z.number().int().min(1).max(24).optional(),
      filled: z.number().int().min(0).max(576).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('FRACTION_REDUCED_EQUALS'),
      numerator: z.number().int().min(0).max(9999),
      denominator: z.number().int().min(1).max(9999),
    })
    .strict(),
  z.object({ kind: z.literal('CYLINDER_RADIUS'), radiusMm: z.number().int().min(5).max(100) }).strict(),
]);
export type ThemesScenario = z.infer<typeof scenarioSchema>;

// ---------------------------------------------------------------------------
// Misconception diagnostics (authored matchers; feedback never leaks answers)
// ---------------------------------------------------------------------------

const diagnosticMatcherSchema = z.discriminatedUnion('kind', [
  /** submitted number value exactly equals the given decimal in the given unit (canonical comparison after unit conversion) */
  z
    .object({ kind: z.literal('VALUE_EQUALS'), unitId: idSchema, value: exactDecimalSchema })
    .strict(),
  /** numeric value correct, unit wrong */
  z.object({ kind: z.literal('UNIT_MISMATCH') }).strict(),
  /** value equals expected×2 / expected÷2 (半径直径不加倍/重复加倍) */
  z.object({ kind: z.literal('OFF_BY_FACTOR'), factor: z.union([z.literal(2), z.literal(0.5)]) }).strict(),
  /** fraction submitted with numerator and denominator swapped */
  z.object({ kind: z.literal('FRACTION_SWAPPED') }).strict(),
  /** only the numerator was scaled: num matches target×m, den matches the pre-scale denominator */
  z
    .object({
      kind: z.literal('FRACTION_NUMERATOR_ONLY_SCALED'),
      preNumerator: z.number().int().min(0).max(9999),
      preDenominator: z.number().int().min(1).max(9999),
      multiplier: z.number().int().min(2).max(9),
    })
    .strict(),
  /** only the denominator was scaled */
  z
    .object({
      kind: z.literal('FRACTION_DENOMINATOR_ONLY_SCALED'),
      preNumerator: z.number().int().min(0).max(9999),
      preDenominator: z.number().int().min(1).max(9999),
      multiplier: z.number().int().min(2).max(9),
    })
    .strict(),
]);
export type ThemesDiagnosticMatcher = z.infer<typeof diagnosticMatcherSchema>;

const diagnosticRuleSchema = z
  .object({
    tag: idSchema,
    /** which check the matcher applies to (diagnostics bind to one wrong item) */
    checkId: idSchema,
    when: diagnosticMatcherSchema,
    feedback: z.string().min(1).max(200),
  })
  .strict();
export type ThemesDiagnosticRule = z.infer<typeof diagnosticRuleSchema>;

// ---------------------------------------------------------------------------
// Micro-lesson diagnosis decision (微课短诊断的判定阈值，服务端事实)
// ---------------------------------------------------------------------------

const diagnosisSchema = z
  .object({
    /** PASS 当且仅当：首次提交即全部判对，且此前未使用答案级提示（h4）。 */
    passRule: z.literal('ALL_CHECKS_FIRST_SUBMISSION_NO_ANSWER_HINT'),
    supplementTaskId: idSchema,
  })
  .strict();
export type ThemesDiagnosis = z.infer<typeof diagnosisSchema>;

// ---------------------------------------------------------------------------
// Entry + rule
// ---------------------------------------------------------------------------

const revealNoteSchema = z.object({ checkId: idSchema, text: z.string().min(1).max(200) });

export const gridTaskTruthEntryV1Schema = z
  .object({
    checks: z.array(themesCheckSchema).min(1).max(8),
    scenario: scenarioSchema.optional(),
    scenarioFeedback: z.string().min(1).max(200).optional(),
    diagnostics: z.array(diagnosticRuleSchema).max(12).optional(),
    /** REVIEW-stage answer reveal lines, one per check, computed by the judge from the truth */
    reveal: z.array(revealNoteSchema).min(1).max(8),
    feedback: z.object({ reviseGeneric: z.string().min(1).max(200) }).strict().optional(),
    diagnosis: diagnosisSchema.optional(),
  })
  .strict();
export type GridTaskTruthEntryV1 = z.infer<typeof gridTaskTruthEntryV1Schema>;

export const gridTaskTruthRuleV1Schema = z
  .object({
    kind: z.literal('GRID_TASK_TRUTH'),
    entries: z
      .record(gridTaskTruthEntryV1Schema)
      .refine((e) => Object.keys(e).length >= 1, 'at least one task entry'),
  })
  .strict();
export type GridTaskTruthRuleV1 = z.infer<typeof gridTaskTruthRuleV1Schema>;

export const ruleBodyThemesV1Schema = z.discriminatedUnion('kind', [gridTaskTruthRuleV1Schema]);
export type RuleBodyThemesV1 = z.infer<typeof ruleBodyThemesV1Schema>;

export function safeParseRuleBodyThemesV1(input: unknown): z.SafeParseReturnType<unknown, RuleBodyThemesV1> {
  return ruleBodyThemesV1Schema.safeParse(input);
}
