/**
 * L3/L4 cylinder rule truth DSL (integration W1 formalization, 2026-10-27,
 * H0 delta H0-DELTA-INTEGRATION-20261027-3; parent h0-20261027-2 plus the
 * THEMES-A / GESP2 family deltas merged in the same batch).
 *
 * The five rule files MATH-L3L4 shipped as pendingDsl sidecars
 * (rule.cylFaces.set / rule.cylFaces.area / rule.cylLayers.stack /
 * rule.cylLayers.volume / rule.cylLayers.transfer) are formalized here as
 * executable rule kinds, following the THEMES-A GRID_TASK_TRUTH precedent
 * (rule files carry `body: { kind, entries }`) and the rules-v2 precedent
 * (strict shapes, fields lifted verbatim from the C truth, only the `kind`
 * discriminator added). Rules are data, never executed content strings
 * (LIFECYCLE §2).
 *
 * Semantics frozen per the authored truth (rule file `note` blocks):
 * - 面组合（FACE_SET_TRUTH）: 面集合三行判定（cyl-face-* × 算入/不算入/不确定）
 *   + 盖面数判定 + 快照=声明双校验；分项反馈不点名行、不显示正确行数。
 * - 表面积求和（COMBO_AREA_TRUTH）: 组合面积 = C×h + 盖数×πr² 一步有理
 *   （π=157/50），两位小数十进制规则，等价书写归一，容差不取浮点
 *   epsilon；Δ=2πr² 分支（LID_DELTA）同。
 * - 层累加体积（LAYER_STACK_TRUTH）: 层不变量（层数改变不改变总体积）、
 *   层厚/每层/总量与累计边界一步有理；活动校验以确认操作事件为准
 *   （动画帧/相机不计）。
 * - 双方案体积对比（VOLUME_COMPARE_TRUTH）: bigger/valueA/valueB/ratio 四路
 *   分项 + mis-linear-choice 决策诊断；判分不依赖当前快照（改场景不能把
 *   错答变对）。
 * - 四段复合（TRANSFER4_TRUTH）: paramRead/faceSet/paperArea/volume 四段
 *   分别判分、分别反馈；段间不互相提示正确值。
 *
 * Numeric readback truths (数值读回) reuse the frozen v2 NUMERIC_READBACK /
 * PARAM_IDENTIFY kinds in rules.ts — no new kind here.
 */
import { z } from 'zod';
import { idSchema } from '../public/protocol';
import { exactDecimalSchema } from './rules';

export const L34_RULE_KINDS = [
  'FACE_SET_TRUTH',
  'COMBO_AREA_TRUTH',
  'LAYER_STACK_TRUTH',
  'VOLUME_COMPARE_TRUTH',
  'TRANSFER4_TRUTH',
] as const;
export type L34RuleKind = (typeof L34_RULE_KINDS)[number];

// ---------------------------------------------------------------------------
// Shared leaves
// ---------------------------------------------------------------------------

/** The three cylinder faces a faces task asks about (侧面/上盖面/下盖面). */
export const L34_FACE_IDS = ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'] as const;
export type L34FaceId = (typeof L34_FACE_IDS)[number];

const faceIdSchema = z.enum(L34_FACE_IDS);

/** Truth row for one face (a submitted 算入/不算入/不确定 row judges against it). */
const faceRowSchema = z.enum(['opt-include', 'opt-exclude']);
export type L34FaceRow = z.infer<typeof faceRowSchema>;

/** Authored face-set truth: every face carries include/exclude. */
export const l34FaceSetSchema = z.record(faceIdSchema, faceRowSchema);
export type L34FaceSet = z.infer<typeof l34FaceSetSchema>;

/** Guided-task judging snapshot pins (integer mm, r∈[5,100], h∈[10,200]). */
const snapshotV1Schema = z
  .object({
    radiusMm: z.number().int().min(5).max(100),
    heightMm: z.number().int().min(10).max(200),
  })
  .strict();
export type L34SnapshotV1 = z.infer<typeof snapshotV1Schema>;

/** Layers-family judging snapshot additionally pins the layer count. */
const snapshotLayersSchema = snapshotV1Schema
  .extend({ layerCount: z.number().int().min(1).max(40) })
  .strict();
export type L34SnapshotLayers = z.infer<typeof snapshotLayersSchema>;

/**
 * Confirmed-operation activity gate (L4). Counted from confirmed
 * learning.commitOperation events only — animation frames and camera moves
 * never count (authored stack rule note).
 */
const activityGateSchema = z
  .object({
    /** SetLayerCount values the learner must have confirmed (e.g. both 8 and 16). */
    setLayerCountValues: z.array(z.number().int().min(1).max(40)).max(8).optional(),
    /** Minimum confirmed SetVisibleLayerCount applies. */
    setVisibleLayerCountAppliesMin: z.number().int().min(0).max(40).optional(),
    /** The visible-layer count the cumulative walk must have reached. */
    visibleLayerCountReached: z.number().int().min(0).max(40).optional(),
    /** SetDimension axes that must each be confirmed at least once. */
    setDimensionAxes: z.array(z.enum(['RADIUS', 'HEIGHT'])).max(2).optional(),
  })
  .strict();
export type L34ActivityGate = z.infer<typeof activityGateSchema>;

// ---------------------------------------------------------------------------
// FACE_SET_TRUTH (rule.cylFaces.set.v1)
// ---------------------------------------------------------------------------

export const faceSetEntryV1Schema = z
  .object({
    /** Packaging condition the truth is authored against (有底无盖 …). */
    condition: z.string().min(1).max(64).optional(),
    /** Guided-task truth rows; instance tasks resolve via `fromInstance`. */
    faceSet: l34FaceSetSchema.optional(),
    /** 盖面数判定 truth (0/1/2 个盖面). */
    lidCount: z.enum(['opt-0', 'opt-1', 'opt-2']).optional(),
    /** 快照选面必须等于声明集合（双校验门，mismatch gates judging）。 */
    snapshotMustEqualDeclaration: z.boolean(),
    /** Faces judged in the two comparison bundles (标签筒/封口罐). */
    compareOnly: z
      .object({
        labelTube: z.array(faceIdSchema).min(1).max(3),
        sealedTube: z.array(faceIdSchema).min(1).max(3),
      })
      .strict()
      .optional(),
    /** Frozen instance the per-instance truth resolves from. */
    fromInstance: idSchema.optional(),
  })
  .strict()
  .refine((e) => e.faceSet !== undefined || e.fromInstance !== undefined, {
    message: 'faceSet entry must carry authored rows or point at a frozen instance',
  });
export type FaceSetEntryV1 = z.infer<typeof faceSetEntryV1Schema>;

export const faceSetFeedbackV1Schema = z
  .object({
    reviseGeneric: z.string().min(1).max(200),
    missingLowerVariant: z.string().min(1).max(200).optional(),
    snapshotMismatch: z.string().min(1).max(200),
    policy: z.string().min(1).max(400),
  })
  .strict();
export type FaceSetFeedbackV1 = z.infer<typeof faceSetFeedbackV1Schema>;

export const faceSetTruthRuleV1Schema = z
  .object({
    kind: z.literal('FACE_SET_TRUTH'),
    entries: z.record(faceSetEntryV1Schema).refine((e) => Object.keys(e).length >= 1, 'at least one task entry'),
    feedback: faceSetFeedbackV1Schema,
  })
  .strict();
export type FaceSetTruthRuleV1 = z.infer<typeof faceSetTruthRuleV1Schema>;

// ---------------------------------------------------------------------------
// COMBO_AREA_TRUTH (rule.cylFaces.area.v1)
// ---------------------------------------------------------------------------

/** COMBO = faceSet 三行 + paper-area 数值；LID_DELTA = Δ 面积数值 + 概念归属单选。 */
export const comboTaskFormSchema = z.enum(['COMBO', 'LID_DELTA']);

export const comboAreaEntryV1Schema = z
  .object({
    taskForm: comboTaskFormSchema,
    /** Judging pin; instance tasks carry the same pins beside fromInstance. */
    snapshot: snapshotV1Schema.optional(),
    /** COMBO 面集合 truth rows (LID_DELTA 判定不问面集合). */
    faceSet: l34FaceSetSchema.optional(),
    /** 快照选面必须等于声明集合（COMBO 门）。 */
    snapshotMustEqualDeclaration: z.boolean().optional(),
    /** 快照只需包含声明集合（i2/i3 变体；不设等于门）。 */
    snapshotSubsetOnly: z.boolean().optional(),
    /** 组合面积 / Δ面积 truth，exact cm² decimal（C×h + 盖数×πr² 或 2πr²）。 */
    expectedCm2: exactDecimalSchema,
    /** LID_DELTA 概念归属 truth（多用纸归属单选）。 */
    attribution: idSchema.optional(),
    /** 建议单判定 truth（g3 附建议单变体；REVIEW 揭示锚点）。 */
    advice: z
      .object({ usable: idSchema, problem: idSchema })
      .strict()
      .optional(),
    fromInstance: idSchema.optional(),
  })
  .strict();
export type ComboAreaEntryV1 = z.infer<typeof comboAreaEntryV1Schema>;

/** Authored misconception diagnostic: stable tag + restricted feedback (never the expected value). */
const diagnosticFeedbackV1Schema = z
  .object({ tag: idSchema, feedback: z.string().min(1).max(200) })
  .strict();
export type DiagnosticFeedbackV1 = z.infer<typeof diagnosticFeedbackV1Schema>;

export const comboAreaDiagnosticsV1Schema = z
  .object({
    /** 提交值=πr²（LID_DELTA）或 C×h+πr²（COMBO 漏一盖）→ 漏盖面签名。 */
    misOneLidMissing: diagnosticFeedbackV1Schema,
    /** 提交值=C×h（两侧盖全漏）→ 漏盖面签名变体。 */
    misLidsMissing: diagnosticFeedbackV1Schema,
    /** 提交值=2×C×h（公式模式匹配）→ 侧面翻倍签名。 */
    misDoubleSide: diagnosticFeedbackV1Schema,
    /** 数值对单位错 → 单位签名。 */
    unitMismatch: diagnosticFeedbackV1Schema,
  })
  .strict();
export type ComboAreaDiagnosticsV1 = z.infer<typeof comboAreaDiagnosticsV1Schema>;

export const comboAreaTruthRuleV1Schema = z
  .object({
    kind: z.literal('COMBO_AREA_TRUTH'),
    entries: z.record(comboAreaEntryV1Schema).refine((e) => Object.keys(e).length >= 1, 'at least one task entry'),
    diagnostics: comboAreaDiagnosticsV1Schema,
    feedback: z.object({ numericRevise: z.string().min(1).max(200) }).strict(),
  })
  .strict();
export type ComboAreaTruthRuleV1 = z.infer<typeof comboAreaTruthRuleV1Schema>;

// ---------------------------------------------------------------------------
// LAYER_STACK_TRUTH (rule.cylLayers.stack.v1)
// ---------------------------------------------------------------------------

/** STACK_INVARIANT = g1 层不变量；LAYER_VOLUME = g2 层厚/每层/总量；ACCUMULATE = i3 累计边界。 */
export const stackTaskFormSchema = z.enum(['STACK_INVARIANT', 'LAYER_VOLUME', 'ACCUMULATE']);

export const layerStackEntryV1Schema = z
  .object({
    taskForm: stackTaskFormSchema,
    snapshot: z.union([snapshotV1Schema, snapshotLayersSchema]).optional(),
    /** STACK_INVARIANT: 层厚/总体积方向判定 truth。 */
    directions: z
      .object({
        layerThickness: z.enum(['INCREASE', 'DECREASE', 'UNCHANGED']),
        totalVolume: z.enum(['INCREASE', 'DECREASE', 'UNCHANGED']),
      })
      .strict()
      .optional(),
    /** STACK_INVARIANT 总体积 truth (exact cm³ decimal)。 */
    volumeCm3: exactDecimalSchema.optional(),
    /** STACK_INVARIANT 8 层/16 层对比读数 truth。 */
    compare16: z
      .object({ perLayerCm3: exactDecimalSchema, totalCm3: exactDecimalSchema })
      .strict()
      .optional(),
    /** LAYER_VOLUME truths（层厚一位小数 cm）。 */
    thicknessCm: z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9])?$/, 'one-decimal cm literal').optional(),
    perLayerCm3: exactDecimalSchema.optional(),
    totalCm3: exactDecimalSchema.optional(),
    /** ACCUMULATE 目标累计（exact cm³ decimal，如 "100.00"）。 */
    targetCm3: exactDecimalSchema.optional(),
    activity: activityGateSchema.optional(),
    fromInstance: idSchema.optional(),
  })
  .strict();
export type LayerStackEntryV1 = z.infer<typeof layerStackEntryV1Schema>;

export const layerStackFeedbackV1Schema = z
  .object({
    invariantRevise: z.string().min(1).max(200),
    activityRevise: z.string().min(1).max(200),
    boundaryRevise: z.string().min(1).max(200).optional(),
    cumulativeRevise: z.string().min(1).max(200).optional(),
  })
  .strict();
export type LayerStackFeedbackV1 = z.infer<typeof layerStackFeedbackV1Schema>;

export const layerStackTruthRuleV1Schema = z
  .object({
    kind: z.literal('LAYER_STACK_TRUTH'),
    entries: z.record(layerStackEntryV1Schema).refine((e) => Object.keys(e).length >= 1, 'at least one task entry'),
    feedback: layerStackFeedbackV1Schema,
  })
  .strict();
export type LayerStackTruthRuleV1 = z.infer<typeof layerStackTruthRuleV1Schema>;

// ---------------------------------------------------------------------------
// VOLUME_COMPARE_TRUTH (rule.cylLayers.volume.v1)
// ---------------------------------------------------------------------------

/** VAR_COMPARE = bigger/valueA/valueB(/ratio)；VOLUME_VALUE = 体积数值+单位。 */
export const volumeTaskFormSchema = z.enum(['VAR_COMPARE', 'VOLUME_VALUE']);

export const volumeCompareEntryV1Schema = z
  .object({
    taskForm: volumeTaskFormSchema,
    /** VAR_COMPARE guided 双方案快照（判分不依赖当前场景快照）。 */
    variants: z
      .object({
        planA: snapshotV1Schema,
        planB: snapshotV1Schema,
      })
      .strict()
      .optional(),
    /** 哪个方案装得多（opt-plan-a / opt-plan-b）。 */
    bigger: idSchema.optional(),
    valueACm3: exactDecimalSchema.optional(),
    valueBCm3: exactDecimalSchema.optional(),
    /** 半径加倍体积倍数单选 truth（g3 变体）。 */
    ratio: idSchema.optional(),
    /** 复算段 truth（底面积/两方案复算，REVIEW 揭示锚点）。 */
    recheck: z
      .object({ baseCm3: exactDecimalSchema, recheckBCm3: exactDecimalSchema, recheckACm3: exactDecimalSchema })
      .strict()
      .optional(),
    /** VOLUME_VALUE 公式模式诊断签名值（exact cm³ decimal）。 */
    diagnostics: z
      .object({
        misCircumferenceTimesH: exactDecimalSchema.optional(),
        misPiRh: exactDecimalSchema.optional(),
        /** I2 决策诊断说明（bigger=A 且两数值正确时记 mis-linear-choice）。 */
        misLinearChoice: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    activity: activityGateSchema.optional(),
    fromInstance: idSchema.optional(),
  })
  .strict();
export type VolumeCompareEntryV1 = z.infer<typeof volumeCompareEntryV1Schema>;

export const volumeCompareFeedbackV1Schema = z
  .object({
    misCircumferenceTimesH: z.string().min(1).max(200).optional(),
    misPiRh: z.string().min(1).max(200).optional(),
    misLinearChoice: z.string().min(1).max(200).optional(),
    unitMismatch: z.string().min(1).max(200).optional(),
    numericRevise: z.string().min(1).max(200),
    ratioRevise: z.string().min(1).max(200).optional(),
    activityRevise: z.string().min(1).max(200).optional(),
  })
  .strict();
export type VolumeCompareFeedbackV1 = z.infer<typeof volumeCompareFeedbackV1Schema>;

export const volumeCompareTruthRuleV1Schema = z
  .object({
    kind: z.literal('VOLUME_COMPARE_TRUTH'),
    entries: z.record(volumeCompareEntryV1Schema).refine((e) => Object.keys(e).length >= 1, 'at least one task entry'),
    feedback: volumeCompareFeedbackV1Schema,
  })
  .strict();
export type VolumeCompareTruthRuleV1 = z.infer<typeof volumeCompareTruthRuleV1Schema>;

// ---------------------------------------------------------------------------
// TRANSFER4_TRUTH (rule.cylLayers.transfer.v1)
// ---------------------------------------------------------------------------

export const transfer4EntryV1Schema = z
  .object({
    fromInstance: idSchema,
    /** 面集合段要求快照选面等于声明集合。 */
    snapshotMustEqualDeclaration: z.boolean(),
  })
  .strict();
export type Transfer4EntryV1 = z.infer<typeof transfer4EntryV1Schema>;

export const transfer4FeedbackV1Schema = z
  .object({
    paramReadRevise: z.string().min(1).max(200),
    faceSetRevise: z.string().min(1).max(200),
    paperRevise: z.string().min(1).max(200),
    volumeRevise: z.string().min(1).max(200),
    policy: z.string().min(1).max(400),
  })
  .strict();
export type Transfer4FeedbackV1 = z.infer<typeof transfer4FeedbackV1Schema>;

export const transfer4TruthRuleV1Schema = z
  .object({
    kind: z.literal('TRANSFER4_TRUTH'),
    entries: z.record(transfer4EntryV1Schema).refine((e) => Object.keys(e).length >= 1, 'at least one task entry'),
    feedback: transfer4FeedbackV1Schema,
  })
  .strict();
export type Transfer4TruthRuleV1 = z.infer<typeof transfer4TruthRuleV1Schema>;

// ---------------------------------------------------------------------------
// Union + parse helpers
// ---------------------------------------------------------------------------

export const ruleBodyL34V1Schema = z.discriminatedUnion('kind', [
  faceSetTruthRuleV1Schema,
  comboAreaTruthRuleV1Schema,
  layerStackTruthRuleV1Schema,
  volumeCompareTruthRuleV1Schema,
  transfer4TruthRuleV1Schema,
]);
export type RuleBodyL34V1 = z.infer<typeof ruleBodyL34V1Schema>;

export function safeParseRuleBodyL34V1(input: unknown): z.SafeParseReturnType<unknown, RuleBodyL34V1> {
  return ruleBodyL34V1Schema.safeParse(input);
}

/**
 * The frozen-instance truth block the evaluator resolves `fromInstance`
 * entries against (first frozen entry of the bound generator file; this
 * batch ships exactly one frozen instance per task).
 */
export const frozenInstanceTruthSchema = z
  .object({
    instanceId: idSchema,
    initial: z.record(z.unknown()),
    truth: z.record(z.unknown()),
  })
  .strict();
export type FrozenInstanceTruth = z.infer<typeof frozenInstanceTruthSchema>;
