import {z} from 'zod';
import {idSchema} from './protocol';

/** Daily v1 is an explicit workflow, not a claim that a full source lesson was completed. */
export const dailyScopeSchema=z.enum(['math','gesp']);
export type DailyScope=z.infer<typeof dailyScopeSchema>;
export const dailyWorkflowSchema=z.enum(['daily.short.v1','daily.model.v1']);
export const dailyAttemptTagSchema=z.object({setId:idSchema,index:z.number().int().min(0).max(5),workflow:dailyWorkflowSchema,poolId:idSchema,title:z.string().max(200)}).strict();
export const dailyEntrySchema=z.object({
  poolId:idSchema,lessonId:idSchema,releaseId:idSchema,taskId:idSchema,taskVersion:idSchema,
  workflow:dailyWorkflowSchema,questionIds:z.array(idSchema).min(1).max(8),
  title:z.string().min(1).max(200),skill:z.string().min(1).max(80),
  prompt:z.string().min(1).max(2000),scopeNote:z.string().max(1000),
  selectionBasis:z.string().min(1).max(1000),
}).strict();
export type DailyEntry=z.infer<typeof dailyEntrySchema>;
export const dailyPlanSchema=z.object({
  version:z.literal('rondo.daily.v1'),setId:idSchema,scope:dailyScopeSchema,
  date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),createdAt:z.number().int().nonnegative(),
  practiceOf:idSchema.nullable(),items:z.array(dailyEntrySchema.extend({reason:z.string().max(1000)}).strict()).length(6),
}).strict();
export type DailyPlan=z.infer<typeof dailyPlanSchema>;
export const dailyItemViewSchema=dailyEntrySchema.extend({
  reason:z.string().max(1000),attemptId:idSchema.nullable(),
  state:z.enum(['QUEUED','ACTIVE','PAUSED','DONE','MISSING','BLOCKED']),
  result:z.enum(['NOT_CHECKED','CORRECT','CORRECTED','REVIEW','OBSERVED']),
  submissionCount:z.number().int().nonnegative(),hintCount:z.number().int().nonnegative(),
  explanationRequested:z.boolean(),
}).strict();
export type DailyItemView=z.infer<typeof dailyItemViewSchema>;
export const dailySetViewSchema=z.object({
  setId:idSchema,version:z.literal('rondo.daily.v1'),scope:dailyScopeSchema,date:z.string(),
  createdAt:z.number().int().nonnegative(),practiceOf:idSchema.nullable(),
  status:z.enum(['OPEN','COMPLETE','UNAVAILABLE']),currentIndex:z.number().int().min(0).max(6),
  items:z.array(dailyItemViewSchema).length(6),
}).strict();
export type DailySetView=z.infer<typeof dailySetViewSchema>;
export const dailyProjectionSchema=z.object({
  kind:z.literal('learning.daily'),learnerId:idSchema,serverDate:z.string(),
  set:dailySetViewSchema.nullable(),
}).strict();
export type DailyProjection=z.infer<typeof dailyProjectionSchema>;
export const startDailyPayloadSchema=z.object({
  scope:dailyScopeSchema,mode:z.enum(['today','practice']),previousSetId:idSchema.optional(),
}).strict().superRefine((p,ctx)=>{
  if((p.mode==='practice')!==(p.previousSetId!==undefined))ctx.addIssue({code:z.ZodIssueCode.custom,message:'practice requires its previous set; today does not accept one'});
});
export const advanceDailyPayloadSchema=z.object({setId:idSchema,index:z.number().int().min(0).max(5),defer:z.boolean()}).strict();
