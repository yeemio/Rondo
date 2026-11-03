/**
 * L1/L2 bounded declarative rules (PrivateRuleSet).
 *
 * Frozen sources:
 * - SCENE-CONTRACTS.md §2 (pi = 157/50 = 3.14 exact decimal contract;
 *   integer mm arithmetic; explicit decimal rounding; no float/pixel epsilon)
 * - LIFECYCLE-DATA-API.md §2 (rules are data, never executed content strings)
 * - B proposals §F/B-D10 (H0 freezes only the two first-batch rule families:
 *   structured object-id matching for L1 parameter identification and L2 edge
 *   pairing; numeric comparison with unit + decimal discipline for L2
 *   lateral area; unchanging-item classification)
 * - H0-SPEC.md §2 rules.ts
 *
 * B implements the bounded evaluator with integer/rational arithmetic (B-D6);
 * C binds tasks to rule data. No general-purpose rule engine.
 *
 * Changelog:
 * - v2 (2026-10-27, B-D10 close-out): RULE_DSL_VERSION '2'. RuleBodyV2 is the
 *   discriminated union over the seven private rule truth shapes C actually
 *   ships (the v1-expressible body.rules plus the pendingDsl sidecar truths,
 *   consolidated per rule file; strict unknown-rejecting; cylinder snapshots
 *   domain-checked to r∈[5,100] / h∈[10,200] integer mm). The v1 two-family
 *   union and ruleset wrapper below stay exported and semantically unchanged
 *   (deprecated-by-v2) for the frozen v1 evaluator path; the v1 leaf schemas
 *   (quantity expressions, edge pairs, numeric quantity checks, the two rule
 *   family schemas) are carried into v2 members unchanged.
 * - v1: frozen H0 two-family DSL (PARAMETER_IDENTIFICATION_V1,
 *   NUMERIC_RELATION_V1) inside privateRuleSetSchema.
 */
import { z } from 'zod';
import { idSchema } from '../public/protocol';
import { HEIGHT_MM_MAX, HEIGHT_MM_MIN, RADIUS_MM_MAX, RADIUS_MM_MIN } from '../public/scene';

/** pi = 157/50 = 3.14 exactly (course-wide numeric contract). */
export const PI_NUMERATOR = 157;
export const PI_DENOMINATOR = 50;
export const PI_RATIONAL = { numerator: PI_NUMERATOR, denominator: PI_DENOMINATOR } as const;

/** Exact decimal literal, e.g. "3.14", "-0.05", "251.20". No exponent form. */
export const exactDecimalSchema = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'exact decimal literal');
export type ExactDecimal = string;

export const exactRationalSchema = z
  .object({
    numerator: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
    denominator: z.number().int().min(1).max(1_000_000_000),
  })
  .strict();
export type ExactRational = z.infer<typeof exactRationalSchema>;

/** Cylinder state reference usable inside a quantity expression. */
export const cylinderStateFactorSchema = z
  .object({ factor: z.enum(['radiusMm', 'heightMm']) })
  .strict();
export type CylinderStateFactor = z.infer<typeof cylinderStateFactorSchema>;

/** Explicit decimal rounding discipline; never a float tolerance. */
export const roundingSchema = z
  .object({
    mode: z.enum(['HALF_UP', 'HALF_EVEN', 'TRUNCATE']),
    decimalPlaces: z.number().int().min(0).max(6),
  })
  .strict();
export type RoundingSpec = z.infer<typeof roundingSchema>;

/**
 * Bounded quantity expression: a product of at most four factors, each an
 * exact rational constant or a cylinder state reference. Lateral area is
 * expressible as PI_RATIONAL x 2 x radiusMm x heightMm (2 x 157/50 = 157/25).
 */
export const quantityExpressionSchema = z
  .object({
    kind: z.literal('RATIONAL_PRODUCT_V1'),
    factors: z.array(z.union([exactRationalSchema, cylinderStateFactorSchema])).min(1).max(4),
  })
  .strict();
export type QuantityExpression = z.infer<typeof quantityExpressionSchema>;

const judgmentSchema = z
  .object({
    propertyId: z.enum(['radius', 'diameter', 'height']),
    direction: z.enum(['INCREASE', 'DECREASE', 'UNCHANGED']),
  })
  .strict();

/** L1: which parameters actually determine the cylinder (enum matching). */
export const parameterIdentificationRuleSchema = z
  .object({
    ruleKind: z.literal('PARAMETER_IDENTIFICATION_V1'),
    expectedJudgments: z.array(judgmentSchema).min(1).max(8),
  })
  .strict();
export type ParameterIdentificationRule = z.infer<typeof parameterIdentificationRuleSchema>;

/** L2: stable object-id pairing between cylinder objects and net edges. */
export const edgePairSchema = z
  .object({ cylinderObjectId: idSchema, netEdgeId: idSchema })
  .strict();
export type EdgePair = z.infer<typeof edgePairSchema>;

export const numericQuantityCheckSchema = z
  .object({
    quantityId: idSchema,
    expected: quantityExpressionSchema,
    acceptedUnitIds: z.array(idSchema).min(1).max(8),
    rounding: roundingSchema,
    /** Exact match after applying the declared rounding; equivalence across accepted units is normalized server-side. */
    comparison: z.literal('EXACT_AFTER_ROUNDING'),
  })
  .strict();
export type NumericQuantityCheck = z.infer<typeof numericQuantityCheckSchema>;

/** L2: edge correspondence + numeric/unit comparison (e.g. lateral area). */
export const numericRelationRuleSchema = z
  .object({
    ruleKind: z.literal('NUMERIC_RELATION_V1'),
    expectedEdgeMapping: z.array(edgePairSchema).min(1).max(8),
    quantityChecks: z.array(numericQuantityCheckSchema).min(1).max(8),
  })
  .strict();
export type NumericRelationRule = z.infer<typeof numericRelationRuleSchema>;

/**
 * @deprecated Deprecated-by-v2: superseded by `ruleBodyV2Schema`
 * (RULE_DSL_VERSION '2'), which covers the seven truth kinds C actually
 * ships. The v1 union stays exported and semantically unchanged for the
 * frozen v1 evaluator path (modules/learning/evaluate.ts).
 */
const taskRuleSchema = z.discriminatedUnion('ruleKind', [
  parameterIdentificationRuleSchema,
  numericRelationRuleSchema,
]);
export type TaskRule = z.infer<typeof taskRuleSchema>;

/**
 * Private, Host-only rule set; travels with a content release, frozen per release version.
 *
 * @deprecated Deprecated-by-v2: see `ruleBodyV2Schema`. Kept semantically
 * unchanged; modules/content loadRelease still parses this shape today.
 */
export const privateRuleSetSchema = z
  .object({
    ruleSetVersion: idSchema,
    rules: z.array(taskRuleSchema).min(1).max(32),
  })
  .strict();

export type PrivateRuleSet = z.infer<typeof privateRuleSetSchema>;

/** @deprecated Deprecated-by-v2: see `ruleBodyV2Schema`. Semantically unchanged. */
export function parsePrivateRuleSet(input: unknown): PrivateRuleSet {
  return privateRuleSetSchema.parse(input);
}

/** @deprecated Deprecated-by-v2: see `ruleBodyV2Schema`. Semantically unchanged. */
export function safeParsePrivateRuleSet(input: unknown): z.SafeParseReturnType<unknown, PrivateRuleSet> {
  return privateRuleSetSchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// v2 (B-D10): C-line private rule truth DSL — RULE_DSL_VERSION '2'
//
// One RuleBodyV2 kind per private rule file C actually ships under
// content/cylinder/private/rules/. Fields are taken verbatim from the C data
// (body.rules + the pendingDsl sidecar, consolidated); strict mode rejects
// unknown fields; cylinder snapshots are domain-checked to the registered
// integer-mm ranges. No fields are invented: the only v2-added field is the
// `kind` discriminator itself.
// ---------------------------------------------------------------------------

export const RULE_DSL_VERSION = '2' as const;

export const RULE_V2_KINDS = [
  'PARAM_CHANGE_CLASSIFY',
  'NUMERIC_READBACK',
  'PARAM_IDENTIFY',
  'EDGE_DIRECTION',
  'EDGE_PAIRING',
  'LATERAL_AREA',
  'TRANSFER_CHECK',
] as const;
export type RuleBodyV2Kind = (typeof RULE_V2_KINDS)[number];

/** Pinned judging state for non-instance tasks; integer mm, r∈[5,100], h∈[10,200]. */
export const cylinderSnapshotV2Schema = z
  .object({
    radiusMm: z.number().int().min(RADIUS_MM_MIN).max(RADIUS_MM_MAX),
    heightMm: z.number().int().min(HEIGHT_MM_MIN).max(HEIGHT_MM_MAX),
  })
  .strict();
export type CylinderSnapshotV2 = z.infer<typeof cylinderSnapshotV2Schema>;

/** G3 section-selection truth: the cylinder part whose length equals the section edge. */
export const sectionPairV2Schema = z
  .object({ leftId: idSchema, rightId: idSchema })
  .strict();
export type SectionPairV2 = z.infer<typeof sectionPairV2Schema>;

/**
 * One per-task numeric readback truth: read a quantity as an exact cm
 * decimal. `snapshot` pins the judging state when the task has no frozen
 * instance file; `sectionPair` is the G3 section-selection truth.
 */
export const numericReadbackEntryV2Schema = z
  .object({
    snapshot: cylinderSnapshotV2Schema.optional(),
    quantityId: idSchema,
    acceptedUnitIds: z.array(idSchema).min(1).max(8),
    expectedCm: exactDecimalSchema,
    sectionPair: sectionPairV2Schema.optional(),
  })
  .strict();
export type NumericReadbackEntryV2 = z.infer<typeof numericReadbackEntryV2Schema>;

/** taskId → readback truth; at least one entry. */
export const numericReadbackMapV2Schema = z
  .record(numericReadbackEntryV2Schema)
  .refine((entries) => Object.keys(entries).length >= 1, 'numericReadback must carry at least one task entry');
export type NumericReadbackMapV2 = z.infer<typeof numericReadbackMapV2Schema>;

/** REVISE feedback variants for the L1 numeric kinds; never leak expected values. */
export const numericReadbackFeedbackV2Schema = z
  .object({
    numericRevise: z.string().min(1).optional(),
    sectionRevise: z.string().min(1).optional(),
  })
  .strict()
  .refine((f) => f.numericRevise !== undefined || f.sectionRevise !== undefined, 'feedback must carry at least one variant');

export const directionFeedbackV2Schema = z
  .object({ reviseGeneric: z.string().min(1) })
  .strict();
export type DirectionFeedbackV2 = z.infer<typeof directionFeedbackV2Schema>;

export const pairingFeedbackV2Schema = z
  .object({
    reviseGeneric: z.array(z.string().min(1)).min(1).max(8),
    policy: z.string().min(1),
  })
  .strict();
export type PairingFeedbackV2 = z.infer<typeof pairingFeedbackV2Schema>;

export const areaFeedbackV2Schema = z
  .object({ numericRevise: z.string().min(1) })
  .strict();
export type AreaFeedbackV2 = z.infer<typeof areaFeedbackV2Schema>;

/** Lateral-area diagnostic labels (mis-base-area-added / unit-mismatch). */
export const areaDiagnosticsV2Schema = z
  .object({
    misBaseAreaAdded: z.string().min(1),
    unitMismatch: z.string().min(1),
  })
  .strict();
export type AreaDiagnosticsV2 = z.infer<typeof areaDiagnosticsV2Schema>;

/** taskId → mis-appearance-long-edge diagnostic for appearance-based pairing mistakes. */
export const pairingDiagnosticsV2Schema = z.record(
  z
    .object({
      misAppearanceLongEdge: z.string().min(1),
      feedbackVariant: z.string().min(1),
    })
    .strict(),
);
export type PairingDiagnosticsV2 = z.infer<typeof pairingDiagnosticsV2Schema>;

/** L1 view-invariance truth: classify the unchanged dimensions. */
export const paramChangeClassifyV2Schema = z
  .object({
    kind: z.literal('PARAM_CHANGE_CLASSIFY'),
    rules: z.array(parameterIdentificationRuleSchema).min(1).max(8),
  })
  .strict();
export type ParamChangeClassifyV2 = z.infer<typeof paramChangeClassifyV2Schema>;

/** L1 readback truth: branch judgments + per-task numeric readback (d=2r, height). */
export const numericReadbackV2Schema = z
  .object({
    kind: z.literal('NUMERIC_READBACK'),
    rules: z.array(parameterIdentificationRuleSchema).min(1).max(8),
    numericReadback: numericReadbackMapV2Schema,
    feedback: numericReadbackFeedbackV2Schema.optional(),
  })
  .strict();
export type NumericReadbackV2 = z.infer<typeof numericReadbackV2Schema>;

/** L1 identify truth: direction judgments + predicted new value (e.g. new diameter). */
export const paramIdentifyV2Schema = z
  .object({
    kind: z.literal('PARAM_IDENTIFY'),
    rules: z.array(parameterIdentificationRuleSchema).min(1).max(8),
    numericReadback: numericReadbackMapV2Schema,
    feedback: numericReadbackFeedbackV2Schema.optional(),
  })
  .strict();
export type ParamIdentifyV2 = z.infer<typeof paramIdentifyV2Schema>;

/** L2 pure direction truth: edge→part mapping only (v1 quantityChecks>=1 gap). */
export const edgeDirectionV2Schema = z
  .object({
    kind: z.literal('EDGE_DIRECTION'),
    expectedEdgeMapping: z.array(edgePairSchema).min(1).max(8),
    feedback: directionFeedbackV2Schema.optional(),
  })
  .strict();
export type EdgeDirectionV2 = z.infer<typeof edgeDirectionV2Schema>;

/** L2 pure pairing truth: edge↔part mapping + appearance-miss diagnostics. */
export const edgePairingV2Schema = z
  .object({
    kind: z.literal('EDGE_PAIRING'),
    expectedEdgeMapping: z.array(edgePairSchema).min(1).max(8),
    diagnostics: pairingDiagnosticsV2Schema.optional(),
    feedback: pairingFeedbackV2Schema.optional(),
  })
  .strict();
export type EdgePairingV2 = z.infer<typeof edgePairingV2Schema>;

/** L2 pure numeric truth: lateral-area quantity check (v1 edge-mapping>=1 gap). */
export const lateralAreaV2Schema = z
  .object({
    kind: z.literal('LATERAL_AREA'),
    quantityChecks: z.array(numericQuantityCheckSchema).min(1).max(8),
    diagnostics: areaDiagnosticsV2Schema.optional(),
    feedback: areaFeedbackV2Schema.optional(),
  })
  .strict();
export type LateralAreaV2 = z.infer<typeof lateralAreaV2Schema>;

/** L2 transfer truth: full mapping + quantity variants (fully v1-expressible). */
export const transferCheckV2Schema = z
  .object({
    kind: z.literal('TRANSFER_CHECK'),
    rules: z.array(numericRelationRuleSchema).min(1).max(8),
  })
  .strict();
export type TransferCheckV2 = z.infer<typeof transferCheckV2Schema>;

/** The v2 private rule truth body: one kind per C private rule file. */
export const ruleBodyV2Schema = z.discriminatedUnion('kind', [
  paramChangeClassifyV2Schema,
  numericReadbackV2Schema,
  paramIdentifyV2Schema,
  edgeDirectionV2Schema,
  edgePairingV2Schema,
  lateralAreaV2Schema,
  transferCheckV2Schema,
]);
export type RuleBodyV2 = z.infer<typeof ruleBodyV2Schema>;

export function safeParseRuleBodyV2(input: unknown): z.SafeParseReturnType<unknown, RuleBodyV2> {
  return ruleBodyV2Schema.safeParse(input);
}
