/**
 * Command receipts and receipt lookup.
 *
 * Frozen sources:
 * - LIFECYCLE-DATA-API.md §1 (receipt identity), §4 (APPLIED/REJECTED/ADMITTED,
 *   NOT_FOUND semantics), §5 (client receipt query)
 * - Coordinator delta item 4 / B proposals §A (B-D2): CommandReceipt field set
 *   is closed to identity + status + version + changedKinds + effectRefs;
 *   business results are never embedded -- refresh reads projections instead.
 * - H0-SPEC.md §1 receipts.ts
 *
 * Receipt field set (closed; strict schema rejects anything else):
 *   protocolVersion, commandId, idempotencyKey, kind, status,
 *   errorCode?, attemptVersion?, changedKinds, effectRefs
 *
 * ADMITTED is retained in the type for future async execution admission but
 * is never emitted in the first batch (code.* returns CAPABILITY_UNAVAILABLE).
 */
import { z } from 'zod';
import { idSchema, positiveIntSchema, protocolVersionSchema } from './protocol';
import { commandKindSchema } from './envelope';
import { rondoErrorCodeSchema } from './errors';

export const RECEIPT_STATUSES = ['APPLIED', 'REJECTED', 'ADMITTED'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/**
 * Effect reference strings, convention "<type>:<id>" -- e.g.
 * "attempt:att-0001", "submission:sub-0007". Types used by H0:
 * learner / attempt / cycle / questionInstance / event / submission /
 * evaluation / explanation / hint / export / disposal.
 */
export const effectRefSchema = z
  .string()
  .regex(/^[a-z][A-Za-z0-9]{1,30}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'effect ref must be "<type>:<id>"');

export const commandReceiptSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    commandId: idSchema,
    idempotencyKey: idSchema,
    kind: commandKindSchema,
    status: z.enum(RECEIPT_STATUSES),
    errorCode: rondoErrorCodeSchema.optional(),
    attemptVersion: positiveIntSchema.optional(),
    changedKinds: z.array(z.string().min(1).max(64)).max(32),
    effectRefs: z.array(effectRefSchema).max(16),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (receipt.status === 'REJECTED' && receipt.errorCode === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'REJECTED receipts must carry errorCode' });
    }
    if (receipt.status !== 'REJECTED' && receipt.errorCode !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'errorCode is only allowed on REJECTED receipts' });
    }
  });

export type CommandReceipt = z.infer<typeof commandReceiptSchema>;

export function parseCommandReceipt(input: unknown): CommandReceipt {
  return commandReceiptSchema.parse(input);
}

export function safeParseCommandReceipt(input: unknown): z.SafeParseReturnType<unknown, CommandReceipt> {
  return commandReceiptSchema.safeParse(input);
}

/**
 * NOT_FOUND means "no committed record found under this key right now"; it
 * never proves the original command never executed (LIFECYCLE §4). Replay
 * uses the ORIGINAL key and envelope; switching keys is forbidden.
 * IDEMPOTENCY_CONFLICT travels as a RondoError, not as a receipt state.
 */
export const receiptLookupSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('CONFIRMED'),
      receipt: commandReceiptSchema,
    })
    .strict(),
  z.object({ status: z.literal('NOT_FOUND') }).strict(),
]);

export type ReceiptLookup = z.infer<typeof receiptLookupSchema>;

export function parseReceiptLookup(input: unknown): ReceiptLookup {
  return receiptLookupSchema.parse(input);
}

export function safeParseReceiptLookup(input: unknown): z.SafeParseReturnType<unknown, ReceiptLookup> {
  return receiptLookupSchema.safeParse(input);
}
