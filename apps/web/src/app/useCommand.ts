/**
 * useCommand: UI delivery-state machine per command —
 * DRAFT → SENDING → CONFIRMED, or RECEIPT_UNKNOWN with original-key lookup.
 *
 * Contract invariants (LIFECYCLE §4 / C-EXPERIENCE §5):
 * - the ORIGINAL envelope + idempotency key is persisted in the local draft
 *   area before submit; unknown outcomes are resolved by querying that key,
 *   never by minting a new one;
 * - no optimistic success: until a receipt arrives the UI shows 未保存/发送中.
 */
import { useCallback, useRef, useState } from 'react';
import { parseEnvelope } from '../../../../modules/contracts/public/envelope';
import type { PublicCommandEnvelope, CommandKind } from '../../../../modules/contracts/public/envelope';
import type { CommandReceipt } from '../../../../modules/contracts/public/receipts';
import type { RondoClient } from '../../../../modules/contracts/public/client';
import { newId } from './prediction';

export type DeliveryState = 'IDLE' | 'DRAFT' | 'SENDING' | 'CONFIRMED' | 'RECEIPT_UNKNOWN';

export interface CommandStatus {
  state: DeliveryState;
  receipt: CommandReceipt | null;
  error: string | null;
  lastKey: string | null;
  lastKind: CommandKind | null;
}

const DRAFT_PREFIX = 'rondo.draft.';

function persistEnvelope(learnerKey: string, envelope: PublicCommandEnvelope): void {
  try {
    localStorage.setItem(DRAFT_PREFIX + learnerKey, JSON.stringify(envelope));
  } catch {
    /* draft area is best-effort; the authority is always the Host */
  }
}

function clearEnvelope(learnerKey: string): void {
  try {
    localStorage.removeItem(DRAFT_PREFIX + learnerKey);
  } catch {
    /* ignore */
  }
}

export function useCommand(client: RondoClient, learnerKey: string) {
  const [status, setStatus] = useState<CommandStatus>({ state: 'IDLE', receipt: null, error: null, lastKey: null, lastKind: null });
  const inflight = useRef(false);

  const send = useCallback(
    async (build: (ids: { commandId: string; idempotencyKey: string }) => Record<string, unknown>): Promise<CommandReceipt | null> => {
      if (inflight.current) return null;
      inflight.current = true;
      const commandId = newId('cmd');
      const idempotencyKey = newId('idem');
      let kind: CommandKind | null = null;
      try {
        // runtime schema validation at the edge (LIFECYCLE §5) — same pattern
        // as the H0 contract fixtures. Inside the try: a throw here must NOT
        // strand the inflight guard (it used to live outside and silently
        // brick every later command).
        const envelope: PublicCommandEnvelope = parseEnvelope(build({ commandId, idempotencyKey }));
        kind = envelope.kind;
        persistEnvelope(learnerKey, envelope);
        setStatus({ state: 'SENDING', receipt: null, error: null, lastKey: idempotencyKey, lastKind: envelope.kind });
        const receipt = await client.command(envelope);
        if (receipt.status === 'APPLIED' || receipt.status === 'ADMITTED') {
          clearEnvelope(learnerKey);
          setStatus({ state: 'CONFIRMED', receipt, error: null, lastKey: idempotencyKey, lastKind: envelope.kind });
        } else {
          // REJECTED carries a stable errorCode; the form stays editable
          setStatus({ state: 'IDLE', receipt, error: receipt.errorCode ?? 'REJECTED', lastKey: idempotencyKey, lastKind: envelope.kind });
        }
        return receipt;
      } catch (err) {
        setStatus({
          state: 'RECEIPT_UNKNOWN',
          receipt: null,
          error: err instanceof Error ? err.message : String(err),
          lastKey: idempotencyKey,
          lastKind: kind,
        });
        return null;
      } finally {
        inflight.current = false;
      }
    },
    [client, learnerKey],
  );

  /** Resolve an unknown outcome with the ORIGINAL key (never a new one). */
  const resolveUnknown = useCallback(
    async (idempotencyKey: string, commandKind: CommandKind): Promise<boolean> => {
      setStatus((s) => ({ ...s, state: 'SENDING' }));
      try {
        const lookup = await client.receipt({ idempotencyKey, commandKind });
        if (lookup.status === 'CONFIRMED') {
          clearEnvelope(learnerKey);
          setStatus({ state: 'CONFIRMED', receipt: lookup.receipt, error: null, lastKey: idempotencyKey, lastKind: commandKind });
          return true;
        }
        setStatus({
          state: 'RECEIPT_UNKNOWN',
          receipt: null,
          error: '尚未查到回执（NOT_FOUND 不代表未执行），请稍后再查或保持页面等待。',
          lastKey: idempotencyKey,
          lastKind: commandKind,
        });
        return false;
      } catch (err) {
        setStatus({
          state: 'RECEIPT_UNKNOWN',
          receipt: null,
          error: err instanceof Error ? err.message : String(err),
          lastKey: idempotencyKey,
          lastKind: commandKind,
        });
        return false;
      }
    },
    [client, learnerKey],
  );

  return { status, send, resolveUnknown };
}
