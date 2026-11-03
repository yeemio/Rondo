/**
 * Public query catalog (closed) and projections.
 *
 * Frozen sources:
 * - LIFECYCLE-DATA-API.md §6 (query list; pagination by server seq/cursor;
 *   unknown/unavailable and empty records are returned distinctly)
 * - Coordinator delta item 7: learning.timeline paginates by the
 *   (attemptId, seq) cursor.
 * - H0-SPEC.md §1 queries.ts
 *
 * Unknown query kinds fail schema validation and surface as a stable error
 * (INVALID_OPERATION family) -- never as a silently empty result.
 *
 * Empty vs unavailable (per kind, server contract):
 * - learning.resumePoint: known learner without an active attempt returns
 *   attempt: null (empty). Content or session problems return errors, e.g.
 *   CONTENT_UNAVAILABLE / UNAUTHENTICATED (unavailable).
 * - learning.timeline: no events yet returns events: [] (empty).
 * - learning.receipt: NOT_FOUND means "no committed record under this key
 *   found now", never "the command never ran".
 */
import { z } from 'zod';
import { activityHistorySchema, codeSnapshotSchema, codeAvailabilitySchema } from './activity';
import { idSchema, positiveIntSchema } from './protocol';
import { commandKindSchema, RETENTION_MODES } from './envelope';
import { receiptLookupSchema } from './receipts';
import { publicQuestionSpecSchema } from './question';

export const ATTEMPT_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED', 'CONTENT_BLOCKED'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export const attemptStatusSchema = z.enum(ATTEMPT_STATUSES);

export const CYCLE_PHASES = ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] as const;
export type CyclePhase = (typeof CYCLE_PHASES)[number];
export const cyclePhaseSchema = z.enum(CYCLE_PHASES);

export const EXPORT_OPERATION_PHASES = [
  'PREPARED',
  'CONFIRMED',
  'CONFIRMED_FAILED',
  'COMPLETED',
  'COMPLETED_PARTIAL',
  'FAILED',
] as const;
export type ExportOperationPhase = (typeof EXPORT_OPERATION_PHASES)[number];

export const CODE_JOB_STATUSES = [
  'ADMITTED',
  'QUEUED',
  'COMPILING',
  'RUNNING',
  'FINISHED',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type CodeJobStatus = (typeof CODE_JOB_STATUSES)[number];

export const QUERY_KINDS = [
  'learning.activityHistory',
  'catalog.availableLessons',
  'learning.resumePoint',
  'learning.attemptView',
  'learning.questionView',
  'learning.timeline',
  'learning.receipt',
  'guardian.evidenceSummary',
  'guardian.retentionPreview',
  'guardian.retentionPolicy',
  'guardian.exportStatus',
  'guardian.deletionStatus',
  'code.runStatus',
  'code.availability',
] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

/** Timeline cursor base: last seen seq, 0 (or absent) means from the beginning. */
const afterSeqSchema = z.number().int().min(0);

export const publicQuerySchema = z
  .discriminatedUnion('kind', [
    z.object({kind: z.literal('learning.activityHistory'), learnerId: idSchema}).strict(),
    z.object({ kind: z.literal('catalog.availableLessons') }).strict(),
    z.object({ kind: z.literal('learning.resumePoint'), learnerId: idSchema }).strict(),
    z.object({ kind: z.literal('learning.attemptView'), attemptId: idSchema }).strict(),
    z
      .object({ kind: z.literal('learning.questionView'), attemptId: idSchema, cycleId: idSchema.optional() })
      .strict(),
    z
      .object({
        kind: z.literal('learning.timeline'),
        attemptId: idSchema,
        afterSeq: afterSeqSchema.optional(),
        limit: positiveIntSchema.max(500).optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal('learning.receipt'), idempotencyKey: idSchema, commandKind: commandKindSchema })
      .strict(),
    z
      .object({
        kind: z.literal('guardian.evidenceSummary'),
        learnerId: idSchema,
        attemptId: idSchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('guardian.retentionPreview'),
        mode: z.enum(RETENTION_MODES),
        rollingDays: z.number().int().min(1).max(3650).optional(),
      })
      .strict(),
    z.object({ kind: z.literal('guardian.retentionPolicy') }).strict(),
    z.object({ kind: z.literal('guardian.exportStatus'), exportId: idSchema }).strict(),
    z.object({ kind: z.literal('guardian.deletionStatus'), deletionId: idSchema, confirmationKey: idSchema.optional() }).strict(),
    z.object({ kind: z.literal('code.runStatus'), jobId: idSchema }).strict(),
    z.object({ kind: z.literal('code.availability'), attemptId: idSchema }).strict(),
  ])
  .superRefine((query, ctx) => {
    if (query.kind === 'guardian.retentionPreview' && query.mode === 'UNTIL_GUARDIAN_DELETES' && query.rollingDays !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'rollingDays does not apply to indefinite retention' });
    }
    if (query.kind === 'guardian.retentionPreview' && query.mode === 'ROLLING_DAYS' && query.rollingDays === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'rollingDays is required when previewing ROLLING_DAYS',
      });
    }
  });

export type PublicQuery = z.infer<typeof publicQuerySchema>;

export function parsePublicQuery(input: unknown): PublicQuery {
  return publicQuerySchema.parse(input);
}

export function safeParsePublicQuery(input: unknown): z.SafeParseReturnType<unknown, PublicQuery> {
  return publicQuerySchema.safeParse(input);
}

// ---------------------------------------------------------------------------
// Projections (tagged with the query kind for runtime validation)
// ---------------------------------------------------------------------------

const lessonSummarySchema = z
  .object({ releaseId: idSchema, taskId: idSchema, title: z.string().min(1).max(200) })
  .strict();
export type LessonSummary = z.infer<typeof lessonSummarySchema>;

const timelineEventSchema = z
  .object({
    seq: positiveIntSchema,
    eventId: idSchema,
    eventType: z.string().min(1).max(64),
    commandKind: commandKindSchema,
    occurredAtMs: z.number().int().min(0),
  })
  .strict();
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

const evidenceItemSchema = z
  .object({
    evidenceType: z.enum(['PREDICTION', 'SUBMISSION', 'EVALUATION', 'EXPLANATION', 'ASSISTANCE', 'OBSERVATION', 'HINT']),
    refId: idSchema,
    atMs: z.number().int().min(0),
  })
  .strict();
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

const deletionCountsSchema = z.record(z.number().int().min(0));
export const deletionScopeSchema = z.object({
  target: z.enum(['ALL_FAMILY_DATA', 'LEARNER', 'ATTEMPT']),
  targetId: idSchema.nullable(),
  learners: z.array(z.object({ learnerId: idSchema, alias: z.string() }).strict()),
  attempts: z.array(z.object({ attemptId: idSchema, learnerId: idSchema, releaseId: idSchema,
    status: attemptStatusSchema, startedAtMs: z.number().int().min(0), endedAtMs: z.number().int().min(0).nullable() }).strict()),
  counts: deletionCountsSchema,
}).strict();
export type DeletionScope = z.infer<typeof deletionScopeSchema>;
export const deletionResultSchema = z.object({
  confirmationKey: idSchema,
  deleted: deletionCountsSchema,
  remaining: deletionCountsSchema,
  completedAtMs: z.number().int().min(0),
  sessionsInvalidated: z.literal(true),
  revokedSessionCount: z.number().int().min(0),
  hostCopies: z.enum(['NOT_PRESENT', 'PENDING', 'CLEARED', 'PARTIAL']),
  failedJobCount: z.number().int().min(0),
}).strict();
export type DeletionResult = z.infer<typeof deletionResultSchema>;

export const publicProjectionSchema = z.discriminatedUnion('kind', [
  activityHistorySchema,
  z
    .object({
      kind: z.literal('catalog.availableLessons'),
      lessons: z.array(lessonSummarySchema).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('learning.resumePoint'),
      learnerId: idSchema,
      attempt: z
        .object({
          attemptId: idSchema,
          cycleId: idSchema,
          phase: cyclePhaseSchema,
          version: positiveIntSchema,
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('learning.attemptView'),
      attemptId: idSchema,
      learnerId: idSchema,
      releaseId: idSchema,
      questionInstanceId: idSchema,
      attemptStatus: attemptStatusSchema,
      version: positiveIntSchema,
      currentCycle: z
        .object({
          cycleId: idSchema,
          phase: cyclePhaseSchema,
          questionInstanceId: idSchema,
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('learning.questionView'),
      spec: publicQuestionSpecSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('learning.timeline'),
      attemptId: idSchema,
      events: z.array(timelineEventSchema).max(500),
      /** Absent when there are no further pages. Pagination cursor is (attemptId, seq). */
      nextAfterSeq: positiveIntSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('learning.receipt'),
      result: receiptLookupSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('guardian.evidenceSummary'),
      learnerId: idSchema.optional(),
      attemptId: idSchema.optional(),
      items: z.array(evidenceItemSchema).max(1000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('guardian.retentionPreview'),
      mode: z.enum(RETENTION_MODES),
      rollingDays: z.number().int().min(1).max(3650).nullable(),
      checkedAt: z.number().int().nonnegative(),
      cutoffAt: z.number().int().nullable(),
      previewVersion: idSchema,
      affectedAttempts: z.array(z.object({ attemptId: idSchema, learnerAlias: z.string(), releaseId: idSchema,
        status: attemptStatusSchema, startedAt: z.number().int(), lastActivityAt: z.number().int() }).strict()).max(10000),
      affectedAttemptIds: z.array(idSchema).max(10000),
      affectedCount: z.number().int().min(0),
      warnings: z.array(z.string().max(500)).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal('guardian.retentionPolicy'),
      policy: z.object({ mode: z.enum(RETENTION_MODES), rollingDays: z.number().int().nullable(),
        setAt: z.number().int(), previewVersion: idSchema }).strict().nullable(),
      lastCleanup: z.object({ checkedAt: z.number().int(), deletedAttemptCount: z.number().int().nonnegative() }).strict().nullable(),
    }).strict(),
  z.object({
      kind: z.literal('guardian.exportStatus'),
      exportId: idSchema,
      phase: z.enum(EXPORT_OPERATION_PHASES),
      scopeHash: z.string().min(16).max(128).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('guardian.deletionStatus'),
      deletionId: idSchema,
      phase: z.enum(['PREPARED', 'STALE', 'EXPIRED', 'COMPLETED', 'COMPLETED_PARTIAL']),
      scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
      preparedAtMs: z.number().int().min(0),
      expiresAtMs: z.number().int().min(0),
      scope: deletionScopeSchema.nullable(),
      result: deletionResultSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('code.runStatus'),
      jobId: idSchema,
      status: z.enum(CODE_JOB_STATUSES),
      run: codeSnapshotSchema.optional(),
      availability: codeAvailabilitySchema.optional(),
    })
    .strict(),
  // Admission for the currently bound task, including tasks with no historical run.
  z.object({
    kind: z.literal('code.availability'),
    attemptId: idSchema,
    questionInstanceId: idSchema,
    availability: codeAvailabilitySchema,
  }).strict(),
]);

export type PublicProjection = z.infer<typeof publicProjectionSchema>;

export function parsePublicProjection(input: unknown): PublicProjection {
  return publicProjectionSchema.parse(input);
}

export function safeParsePublicProjection(input: unknown): z.SafeParseReturnType<unknown, PublicProjection> {
  return publicProjectionSchema.safeParse(input);
}
