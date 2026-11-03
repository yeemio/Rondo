import {mathResponseSchema} from './math6';
import {GESP_ACTIVITIES} from './gesp';
/**
 * Public command envelope: 23-kind closed CommandKind set, per-kind payload
 * schemas, target/binding shapes.
 *
 * Frozen sources:
 * - LIFECYCLE-DATA-API.md §5 (envelope shape) and §6 (command catalogue)
 * - SHARED-CONTRACT.md ("H0 必须冻结的真实接口"; binding completeness;
 *   actor/familyId from renderer are never authorization evidence)
 * - H0-SPEC.md §1 envelope.ts; coordinator delta items (binding all-or-nothing;
 *   expectedAttemptVersion is the single CAS point per B-D1)
 *
 * Renderer-visible: no server/sqlite/Node imports.
 */
import { z } from 'zod';
import {AI_NEW_IDS,aiLabResponseSchema} from './ai-lab';
import { activityOperationSchema } from './activity';
import { idSchema, positiveIntSchema, protocolVersionSchema } from './protocol';
import { cylinderOperationV1Schema, cylinderOperationV2Schema } from './scene';
import { gridOperationV1Schema } from './scene-gridboard';
import { stepOperationV1Schema } from './scene-steps';

export const COMMAND_KINDS = [
  'family.createLearner',
  'family.setRetention',
  'learning.startAttempt',
  'learning.beginCycle',
  'learning.recordPrediction',
  'learning.commitOperation',
  'learning.reviseResponse',
  'learning.submitResponse',
  'learning.requestHint',
  'learning.beginExplanation',
  'learning.saveExplanation',
  'learning.finishAttempt',
  'learning.pauseAttempt',
  'learning.resumeAttempt',
  'learning.endWithoutCompleting',
  'guardian.recordAssistance',
  'guardian.annotateExplanation',
  'guardian.prepareExport',
  'guardian.confirmExport',
  'guardian.prepareDeletion',
  'guardian.confirmDeletion',
  'code.requestRun',
  'code.requestCancel',
] as const;

export type CommandKind = (typeof COMMAND_KINDS)[number];

export const commandKindSchema = z.enum(COMMAND_KINDS);

export function parseCommandKind(input: unknown): CommandKind {
  return commandKindSchema.parse(input);
}

export function safeParseCommandKind(input: unknown): z.SafeParseReturnType<unknown, CommandKind> {
  return commandKindSchema.safeParse(input);
}

/**
 * Kinds whose envelope must carry expectedAttemptVersion (the single CAS point
 * on learningAttempt.version, B-D1). The envelope-level field is required for
 * these kinds and absent-forbidden nowhere else; payloads never duplicate it.
 */
export const KINDS_REQUIRING_EXPECTED_ATTEMPT_VERSION: ReadonlySet<CommandKind> = new Set<CommandKind>([
  'learning.beginCycle',
  'learning.commitOperation',
  'learning.reviseResponse',
  'learning.submitResponse',
  'learning.beginExplanation',
  'learning.saveExplanation',
  'learning.finishAttempt',
  'learning.pauseAttempt',
  'learning.resumeAttempt',
]);

// ---------------------------------------------------------------------------
// Shared payload primitives
// ---------------------------------------------------------------------------

const emptyPayloadSchema = z.object({}).strict();

export const RETENTION_MODES = ['UNTIL_GUARDIAN_DELETES', 'ROLLING_DAYS'] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

/**
 * Property-direction claim property ids. Value-set extension h0-mathl34-20261027-1
 * (L34-7): 'layerThickness' and 'totalVolume' join the L1 trio so the adjudicated
 * resp.l4.stackInvariant.v1 verify item (propertyJudgments over those two
 * properties) can be submitted. Direction semantics are unchanged.
 */
export const PREDICTION_CLAIM_PROPERTY_IDS = ['radius', 'diameter', 'height', 'layerThickness', 'totalVolume'] as const;
export type PredictionClaimPropertyId = (typeof PREDICTION_CLAIM_PROPERTY_IDS)[number];

export const predictionClaimSchema = z
  .object({
    propertyId: z.enum(PREDICTION_CLAIM_PROPERTY_IDS),
    direction: z.enum(['INCREASE', 'DECREASE', 'UNCHANGED']),
  })
  .strict();
export type PredictionClaim = z.infer<typeof predictionClaimSchema>;

export const structuredResponseItemSchema = z.discriminatedUnion('kind', [
  mathResponseSchema,
  aiLabResponseSchema,
  z.object({ kind: z.literal('codeRun'), jobId: idSchema, source: z.string().min(1).max(32768), stdin: z.string().max(16384) }).strict(),
  z
    .object({
      kind: z.literal('propertyJudgments'),
      claims: z.array(predictionClaimSchema).min(1).max(16),
    })
    .strict(),
  z
    .object({
      kind: z.literal('objectMapping'),
      pairs: z
        .array(
          z
            .object({ leftId: idSchema, rightId: idSchema })
            .strict(),
        )
        .min(1)
        .max(16),
    })
    .strict(),
  z
    .object({
      kind: z.literal('numberWithUnit'),
      quantityId: idSchema,
      value: z.number().refine(Number.isFinite, { message: 'value must be finite' }),
      unitId: idSchema,
    })
    .strict(),
  // themes.micro.v1 / themes.frac.v1 verify carriers (THEMES-A contract delta
  // 2026-10-27, mirroring the approved GESP2 carrier precedent): a fraction is
  // two bounded integers (never a free-text "a/b" string, so a typing slip
  // cannot masquerade as a conceptual fraction answer), and a single-choice
  // claim is the selection id + option id pair.
  z
    .object({
      kind: z.literal('fractionValue'),
      quantityId: idSchema,
      numerator: z.number().int().min(0).max(9999),
      denominator: z.number().int().min(1).max(9999),
    })
    .strict(),
  z
    .object({
      kind: z.literal('singleChoice'),
      selectionId: idSchema,
      optionId: idSchema,
    })
    .strict(),
  // cpp.steps.v1 verify carriers (GESP2 unit-1 contract delta §4; structured
  // per-line integer entry, never free text, so typing format cannot fail a
  // conceptual answer — UNIT-SPEC §6.1/§6.6)
  z
    .object({
      kind: z.literal('outputLines'),
      quantityId: idSchema,
      lines: z.array(z.string().regex(/^-?\d+$/, 'one integer per line').max(16)).min(1).max(8),
    })
    .strict(),
  z
    .object({
      kind: z.literal('variableValues'),
      values: z
        .array(
          z
            .object({
              varId: idSchema,
              value: z.number().int().min(-1_000_000_000).max(1_000_000_000),
            })
            .strict(),
        )
        .min(1)
        .max(16),
    })
    .strict(),
  z
    .object({
      kind: z.literal('branchTrace'),
      marks: z
        .array(
          z
            .object({ checkpointId: idSchema, outcome: z.enum(['TAKEN', 'SKIPPED']) })
            .strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
]);
export type StructuredResponseItem = z.infer<typeof structuredResponseItemSchema>;

export const ASSISTANCE_CATEGORIES = ['OPERATIVE', 'RESTATE', 'CONCEPT', 'ANSWER'] as const;
export type AssistanceCategory = (typeof ASSISTANCE_CATEGORIES)[number];

export const RUBRIC_RATINGS = ['NOT_OBSERVED', 'EMERGING', 'ESTABLISHED'] as const;
export type RubricRating = (typeof RUBRIC_RATINGS)[number];

/** Rubric triple aligned with the guardianObservation columns (condition/relation/basis). */
export const rubricSchema = z
  .object({
    condition: z.enum(RUBRIC_RATINGS),
    relation: z.enum(RUBRIC_RATINGS),
    basis: z.enum(RUBRIC_RATINGS),
  })
  .strict();
export type Rubric = z.infer<typeof rubricSchema>;

export const EXPORT_CATEGORIES = [
  'ALIASES',
  'CONTENT_VERSIONS',
  'PROCESS',
  'SUBMISSIONS',
  'FEEDBACK',
  'EXPLANATIONS',
  'GUARDIAN_ANNOTATIONS',
] as const;
export type ExportCategory = (typeof EXPORT_CATEGORIES)[number];

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha-256 hex string');

// ---------------------------------------------------------------------------
// Per-kind payload schemas (minimal fields per H0-SPEC §1; B/C may add fields
// via versioned contract delta, the kind set itself never grows silently)
// ---------------------------------------------------------------------------

export const createLearnerPayloadSchema = z
  .object({
    alias: z.string().min(1).max(64),
    goal: z.string().max(500).optional(),
  })
  .strict();

export const setRetentionPayloadSchema = z
  .object({
    mode: z.enum(RETENTION_MODES),
    rollingDays: z.number().int().min(1).max(3650).optional(),
    confirmedPreviewVersion: idSchema,
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.mode === 'ROLLING_DAYS' && p.rollingDays === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'rollingDays is required when mode is ROLLING_DAYS',
      });
    }
  });

export const startAttemptPayloadSchema = z
  .object({ releaseId: idSchema })
  .strict();

export const beginCyclePayloadSchema = z
  .object({ taskId: idSchema })
  .strict();

export const recordPredictionPayloadSchema = z
  .object({
    prediction: z.union([
      z.object({ claims: z.array(predictionClaimSchema).max(16) }).strict(),
      z.object({kind:z.literal('activity.statement.v1'),activityId:z.enum(['ratio','cpp','ai-a7',...AI_NEW_IDS,...GESP_ACTIVITIES,'math6']),statement:z.string().max(2000).refine(value=>value.trim().length>0,'请先写下你的猜想。').refine(value=>new TextEncoder().encode(value).byteLength<=6000,'猜想文字请控制在6000字节内。')}).strict(),
    ]),
    uncertain: z.boolean(),
    explanation: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if ('claims' in p.prediction && !p.uncertain && p.prediction.claims.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'claims must be non-empty unless uncertain is true',
      });
    }
  });

/**
 * learning.commitOperation carries the versioned renderer-family operation
 * union: V1 ops for @1 cylinder tasks plus SetLayerCount /
 * SetVisibleLayerCount for @2 (h0-mathl34-20261027-1 / L34-1), gridboard ops
 * (THEMES-A delta) and steps ops (GESP2 delta). Envelope syntax accepts the
 * superset; which subset a task may use stays task-side (allowedOperationIds +
 * renderer contract version) and is rejected as INVALID_OPERATION there.
 */
export const commitOperationPayloadSchema = z
  .object({
    operation: z.union([activityOperationSchema, cylinderOperationV1Schema, cylinderOperationV2Schema, gridOperationV1Schema, stepOperationV1Schema]),
  })
  .strict();

export const submitResponsePayloadSchema = z
  .object({ response: z.array(structuredResponseItemSchema).min(1).max(16) })
  .strict();

export const requestHintPayloadSchema = z
  .object({ hintLevel: z.number().int().min(0).max(5) })
  .strict();

export const saveExplanationPayloadSchema = z
  .object({
    selections: z
      .array(
        z
          .object({ itemId: idSchema, selectedOptionIds: z.array(idSchema).min(1).max(16) })
          .strict(),
      )
      .max(32),
    freeText: z.string().min(1).max(4000),
    transcribedByGuardian: z.boolean(),
  })
  .strict();

/** Explicit end intent is required to abandon an attempt. */
export const endWithoutCompletingPayloadSchema = z
  .object({ confirmAbandon: z.literal(true) })
  .strict();

export const recordAssistancePayloadSchema = z
  .object({
    attemptId: idSchema,
    eventId: idSchema.optional(),
    submissionId: idSchema.optional(),
    category: z.enum(ASSISTANCE_CATEGORIES),
    note: z.string().min(1).max(2000),
  })
  .strict();

export const annotateExplanationPayloadSchema = z
  .object({
    explanationRevisionRef: idSchema,
    rubric: rubricSchema,
    note: z.string().max(2000).optional(),
  })
  .strict();

export const prepareExportPayloadSchema = z
  .object({
    scope: z
      .object({ categories: z.array(z.enum(EXPORT_CATEGORIES)).min(1).max(7) })
      .strict(),
  })
  .strict();

export const confirmExportPayloadSchema = z
  .object({ preparedVersion: idSchema })
  .strict();

export const prepareDeletionPayloadSchema = z
  .object({
    target: z.enum(['ALL_FAMILY_DATA', 'LEARNER', 'ATTEMPT']),
    targetId: idSchema.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.target !== 'ALL_FAMILY_DATA' && p.targetId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `targetId is required for target ${p.target}`,
      });
    }
    if (p.target === 'ALL_FAMILY_DATA' && p.targetId !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ALL_FAMILY_DATA does not accept targetId' });
    }
  });

export const confirmDeletionPayloadSchema = z
  .object({ preparedDeletionId: idSchema, scopeListHash: sha256HexSchema })
  .strict();

/** ARCHITECTURE §9 resource contract: source capped at 32 KiB; execution itself is a later, separately gated capability. */
export const requestRunPayloadSchema = z
  .object({
    source: z.string().min(1).max(32768),
    compilerContractId: idSchema,
    taskId: idSchema,
    stdin: z.string().max(16384).default(''),
  })
  .strict();

export const requestCancelPayloadSchema = z
  .object({ jobId: idSchema })
  .strict();

const payloadSchemaByKind = {
  'family.createLearner': createLearnerPayloadSchema,
  'family.setRetention': setRetentionPayloadSchema,
  'learning.startAttempt': startAttemptPayloadSchema,
  'learning.beginCycle': beginCyclePayloadSchema,
  'learning.recordPrediction': recordPredictionPayloadSchema,
  'learning.commitOperation': commitOperationPayloadSchema,
  'learning.reviseResponse': emptyPayloadSchema,
  'learning.submitResponse': submitResponsePayloadSchema,
  'learning.requestHint': requestHintPayloadSchema,
  'learning.beginExplanation': emptyPayloadSchema,
  'learning.saveExplanation': saveExplanationPayloadSchema,
  'learning.finishAttempt': emptyPayloadSchema,
  'learning.pauseAttempt': emptyPayloadSchema,
  'learning.resumeAttempt': emptyPayloadSchema,
  'learning.endWithoutCompleting': endWithoutCompletingPayloadSchema,
  'guardian.recordAssistance': recordAssistancePayloadSchema,
  'guardian.annotateExplanation': annotateExplanationPayloadSchema,
  'guardian.prepareExport': prepareExportPayloadSchema,
  'guardian.confirmExport': confirmExportPayloadSchema,
  'guardian.prepareDeletion': prepareDeletionPayloadSchema,
  'guardian.confirmDeletion': confirmDeletionPayloadSchema,
  'code.requestRun': requestRunPayloadSchema,
  'code.requestCancel': requestCancelPayloadSchema,
} satisfies Record<CommandKind, z.ZodTypeAny>;

/** Runtime payload schema per kind; closed over the 23-kind set. */
export const PAYLOAD_SCHEMA_BY_KIND: Readonly<Record<CommandKind, z.ZodTypeAny>> = payloadSchemaByKind;

export type CreateLearnerPayload = z.infer<typeof createLearnerPayloadSchema>;
export type SetRetentionPayload = z.infer<typeof setRetentionPayloadSchema>;
export type StartAttemptPayload = z.infer<typeof startAttemptPayloadSchema>;
export type BeginCyclePayload = z.infer<typeof beginCyclePayloadSchema>;
export type RecordPredictionPayload = z.infer<typeof recordPredictionPayloadSchema>;
export type CommitOperationPayload = z.infer<typeof commitOperationPayloadSchema>;
export type ReviseResponsePayload = z.infer<typeof emptyPayloadSchema>;
export type SubmitResponsePayload = z.infer<typeof submitResponsePayloadSchema>;
export type RequestHintPayload = z.infer<typeof requestHintPayloadSchema>;
export type BeginExplanationPayload = z.infer<typeof emptyPayloadSchema>;
export type SaveExplanationPayload = z.infer<typeof saveExplanationPayloadSchema>;
export type FinishAttemptPayload = z.infer<typeof emptyPayloadSchema>;
export type PauseAttemptPayload = z.infer<typeof emptyPayloadSchema>;
export type ResumeAttemptPayload = z.infer<typeof emptyPayloadSchema>;
export type EndWithoutCompletingPayload = z.infer<typeof endWithoutCompletingPayloadSchema>;
export type RecordAssistancePayload = z.infer<typeof recordAssistancePayloadSchema>;
export type AnnotateExplanationPayload = z.infer<typeof annotateExplanationPayloadSchema>;
export type PrepareExportPayload = z.infer<typeof prepareExportPayloadSchema>;
export type ConfirmExportPayload = z.infer<typeof confirmExportPayloadSchema>;
export type PrepareDeletionPayload = z.infer<typeof prepareDeletionPayloadSchema>;
export type ConfirmDeletionPayload = z.infer<typeof confirmDeletionPayloadSchema>;
export type RequestRunPayload = z.infer<typeof requestRunPayloadSchema>;
export type RequestCancelPayload = z.infer<typeof requestCancelPayloadSchema>;

export type CommandPayload =
  | CreateLearnerPayload
  | SetRetentionPayload
  | StartAttemptPayload
  | BeginCyclePayload
  | RecordPredictionPayload
  | CommitOperationPayload
  | ReviseResponsePayload
  | SubmitResponsePayload
  | RequestHintPayload
  | BeginExplanationPayload
  | SaveExplanationPayload
  | FinishAttemptPayload
  | PauseAttemptPayload
  | ResumeAttemptPayload
  | EndWithoutCompletingPayload
  | RecordAssistancePayload
  | AnnotateExplanationPayload
  | PrepareExportPayload
  | ConfirmExportPayload
  | PrepareDeletionPayload
  | ConfirmDeletionPayload
  | RequestRunPayload
  | RequestCancelPayload;

// ---------------------------------------------------------------------------
// Target / binding / envelope
// ---------------------------------------------------------------------------

/**
 * Target claims a FAMILY or LEARNER scope. Learner ids coming from the
 * renderer are objects of verification, never authorization evidence
 * (LIFECYCLE §7: client-supplied learnerId is a claim, not a permission).
 */
export const targetSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('FAMILY') }).strict(),
  z
    .object({
      scope: z.literal('LEARNER'),
      learnerId: idSchema,
      attemptId: idSchema.optional(),
      cycleId: idSchema.optional(),
    })
    .strict(),
]);
export type CommandTarget = z.infer<typeof targetSchema>;

/**
 * Binding is all-or-nothing (coordinator delta item 5 / B §A): the three
 * fields appear together and are checked together. A partial binding (e.g.
 * only releaseId) fails schema validation.
 */
export const bindingSchema = z
  .object({
    releaseId: idSchema,
    questionInstanceId: idSchema,
    rendererContractVersion: idSchema,
  })
  .strict();
export type CommandBinding = z.infer<typeof bindingSchema>;

const envelopeCommonShape = {
  protocolVersion: protocolVersionSchema,
  commandId: idSchema,
  idempotencyKey: idSchema,
  target: targetSchema,
  binding: bindingSchema.optional(),
  expectedAttemptVersion: positiveIntSchema.optional(),
};

function envelopeMember<K extends CommandKind>(
  kind: K,
  payload: z.ZodTypeAny,
  requireExpectedVersion: boolean,
) {
  const shape = requireExpectedVersion
    ? { ...envelopeCommonShape, kind: z.literal(kind), payload, expectedAttemptVersion: positiveIntSchema }
    : { ...envelopeCommonShape, kind: z.literal(kind), payload };
  return z.object(shape).strict();
}

export const envelopeSchema = z.discriminatedUnion('kind', [
  envelopeMember('family.createLearner', payloadSchemaByKind['family.createLearner'], false),
  envelopeMember('family.setRetention', payloadSchemaByKind['family.setRetention'], false),
  envelopeMember('learning.startAttempt', payloadSchemaByKind['learning.startAttempt'], false),
  envelopeMember('learning.beginCycle', payloadSchemaByKind['learning.beginCycle'], true),
  envelopeMember('learning.recordPrediction', payloadSchemaByKind['learning.recordPrediction'], false),
  envelopeMember('learning.commitOperation', payloadSchemaByKind['learning.commitOperation'], true),
  envelopeMember('learning.reviseResponse', payloadSchemaByKind['learning.reviseResponse'], true),
  envelopeMember('learning.submitResponse', payloadSchemaByKind['learning.submitResponse'], true),
  envelopeMember('learning.requestHint', payloadSchemaByKind['learning.requestHint'], false),
  envelopeMember('learning.beginExplanation', payloadSchemaByKind['learning.beginExplanation'], true),
  envelopeMember('learning.saveExplanation', payloadSchemaByKind['learning.saveExplanation'], true),
  envelopeMember('learning.finishAttempt', payloadSchemaByKind['learning.finishAttempt'], true),
  envelopeMember('learning.pauseAttempt', payloadSchemaByKind['learning.pauseAttempt'], true),
  envelopeMember('learning.resumeAttempt', payloadSchemaByKind['learning.resumeAttempt'], true),
  envelopeMember('learning.endWithoutCompleting', payloadSchemaByKind['learning.endWithoutCompleting'], false),
  envelopeMember('guardian.recordAssistance', payloadSchemaByKind['guardian.recordAssistance'], false),
  envelopeMember('guardian.annotateExplanation', payloadSchemaByKind['guardian.annotateExplanation'], false),
  envelopeMember('guardian.prepareExport', payloadSchemaByKind['guardian.prepareExport'], false),
  envelopeMember('guardian.confirmExport', payloadSchemaByKind['guardian.confirmExport'], false),
  envelopeMember('guardian.prepareDeletion', payloadSchemaByKind['guardian.prepareDeletion'], false),
  envelopeMember('guardian.confirmDeletion', payloadSchemaByKind['guardian.confirmDeletion'], false),
  envelopeMember('code.requestRun', payloadSchemaByKind['code.requestRun'], false),
  envelopeMember('code.requestCancel', payloadSchemaByKind['code.requestCancel'], false),
]);

export type PublicCommandEnvelope = z.infer<typeof envelopeSchema>;

export function parseEnvelope(input: unknown): PublicCommandEnvelope {
  return envelopeSchema.parse(input);
}

export function safeParseEnvelope(input: unknown): z.SafeParseReturnType<unknown, PublicCommandEnvelope> {
  return envelopeSchema.safeParse(input);
}

export function parseTarget(input: unknown): CommandTarget {
  return targetSchema.parse(input);
}

export function safeParseTarget(input: unknown): z.SafeParseReturnType<unknown, CommandTarget> {
  return targetSchema.safeParse(input);
}

export function parseBinding(input: unknown): CommandBinding {
  return bindingSchema.parse(input);
}

export function safeParseBinding(input: unknown): z.SafeParseReturnType<unknown, CommandBinding> {
  return bindingSchema.safeParse(input);
}
