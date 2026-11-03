import {mathStateSchema,mathOperationSchema} from './math6';
/** MVP activity renderer v1: authored objects and saved learner drafts, never grading truth. */
import { z } from 'zod';
import {GESP_ACTIVITIES,gespStateSchema,gespReasoningOperationSchema} from './gesp';
import {AI_NEW_IDS,aiLabStateSchema,aiLabOperationSchema} from './ai-lab';
export const activityDraftSchema = z.object({ prediction: z.string().max(2000), uncertain: z.boolean().optional(), answerText: z.string().max(8000), explanation: z.string().max(4000), source: z.string().max(32768), stdin: z.string().max(16384) }).strict();
export const activityStateSchema = z.object({ activity: z.enum(['ratio', 'cpp', 'ai-a7',...AI_NEW_IDS,...GESP_ACTIVITIES,'math6']), scale: z.number().int().min(1).max(4), inspected: z.array(z.string().max(64)).max(8), draft: activityDraftSchema, lab:aiLabStateSchema.optional(),gesp:gespStateSchema.optional(),math:mathStateSchema.optional() }).strict();
export type ActivityState = z.infer<typeof activityStateSchema>;
export const activityOperationSchema = z.discriminatedUnion('type', [
  ...mathOperationSchema.options,
  ...aiLabOperationSchema.options,
  gespReasoningOperationSchema,
  z.object({ type: z.literal('SetActivityScale'), value: z.number().int().min(1).max(4) }).strict(),
  z.object({ type: z.literal('InspectActivityCard'), cardId: z.enum(['hours', 'animals', 'bus', 'algorithm']) }).strict(),
  z.object({ type: z.literal('SaveActivityDraft'), draft: activityDraftSchema }).strict(),
]);
export const codeSnapshotSchema = z.object({ jobId: z.string(), requestId: z.string(), attemptId: z.string(), cycleId: z.string(), taskId: z.string(), questionInstanceId: z.string(), attemptVersion: z.number(), source: z.string(), stdin: z.string(), sourceHash: z.string(), inputHash: z.string(), compilerContractId: z.string(), imageId: z.string(), instanceId: z.string(), workerJobId: z.string().nullable(), status: z.string(), terminal: z.boolean(), stdout: z.string(), stderr: z.string(), createdAt: z.number(), updatedAt: z.number() }).strict();
export type CodeSnapshot = z.infer<typeof codeSnapshotSchema>;
/** Current admission state, separate from immutable snapshots and private worker diagnostics. */
export const codeAvailabilitySchema = z.object({available:z.boolean(),reason:z.enum(['READY','BUSY','UNCONFIRMED','UNAVAILABLE','CAPACITY'])}).strict();
export type CodeAvailability = z.infer<typeof codeAvailabilitySchema>;
export const activityHistorySchema = z.object({ kind: z.literal('learning.activityHistory'), learnerId: z.string(), attempts: z.array(z.object({ attemptId: z.string(), releaseId: z.string(), status: z.string(), previousAttemptId: z.string().nullable(), startedAt: z.number(), cycles: z.array(z.object({ cycleId: z.string(), taskId: z.string(), phase: z.string(), state: activityStateSchema, prediction: z.unknown(), submissions: z.array(z.object({ submissionId: z.string(), response: z.unknown(), outcome: z.string(), feedback: z.unknown(), lab:aiLabStateSchema.optional(),gesp:gespStateSchema.optional(),math:mathStateSchema.optional(), at: z.number() }).strict()), explanations: z.array(z.object({ revisionId: z.string(), text: z.string(), at: z.number() }).strict()), hints:z.array(z.object({level:z.number(),text:z.string(),at:z.number()}).strict()).optional(),operations:z.array(z.object({operation:z.unknown(),labAfter:aiLabStateSchema.optional(),gespAfter:gespStateSchema.optional(),mathAfter:mathStateSchema.optional(),at:z.number()}).strict()).optional(),runs: z.array(codeSnapshotSchema) }).strict()) }).strict()) }).strict();
export type ActivityHistory = z.infer<typeof activityHistorySchema>;
