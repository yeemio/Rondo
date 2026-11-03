/**
 * RondoClient: the only surface the desktop preload exposes to the Web UI.
 *
 * Frozen sources:
 * - LIFECYCLE-DATA-API.md §5 (client interface; preload exposes exactly these
 *   methods plus fixed-signature invalidation subscription)
 * - SHARED-CONTRACT.md ("H0 必须冻结的真实接口" RondoClient row)
 * - H0-SPEC.md §1 client.ts
 *
 * Subscriptions carry only attemptId/version/changedKinds -- no business
 * payload. On notification, the UI re-queries through authorized queries.
 */
import { z } from 'zod';
import { idSchema, positiveIntSchema } from './protocol';
import type { PublicCommandEnvelope } from './envelope';
import type { CommandReceipt, ReceiptLookup } from './receipts';
import type { PublicProjection, PublicQuery } from './queries';

export const invalidationNoticeSchema = z
  .object({
    attemptId: idSchema,
    version: positiveIntSchema,
    changedKinds: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict();

export type InvalidationNotice = z.infer<typeof invalidationNoticeSchema>;

export function parseInvalidationNotice(input: unknown): InvalidationNotice {
  return invalidationNoticeSchema.parse(input);
}

export function safeParseInvalidationNotice(input: unknown): z.SafeParseReturnType<unknown, InvalidationNotice> {
  return invalidationNoticeSchema.safeParse(input);
}

export type Unsubscribe = () => void;

export interface RondoClient {
  command(envelope: PublicCommandEnvelope): Promise<CommandReceipt>;
  query(request: PublicQuery): Promise<PublicProjection>;
  receipt(request: { idempotencyKey: string; commandKind: string }): Promise<ReceiptLookup>;
  subscribeInvalidation(cb: (notice: InvalidationNotice) => void): Unsubscribe;
}
