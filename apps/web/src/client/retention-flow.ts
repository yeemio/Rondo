import type { RondoClient } from '../../../../modules/contracts/public/client';
import type { PublicProjection } from '../../../../modules/contracts/public/queries';
import { parseEnvelope } from '../../../../modules/contracts/public/envelope';

export type RetentionPreview = Extract<PublicProjection, { kind: 'guardian.retentionPreview' }>;
export type RetentionState = Extract<PublicProjection, { kind: 'guardian.retentionPolicy' }>;
export type RetentionIntent = { mode: RetentionPreview['mode']; rollingDays: number | null; previewVersion: string };
export type PendingRetention = { key: string; intent: RetentionIntent };

export function restorePendingRetention(raw: string | null): PendingRetention | null {
  try {
    const value = JSON.parse(raw ?? 'null') as PendingRetention | null;
    if (!value || typeof value.key !== 'string' || typeof value.intent?.previewVersion !== 'string') return null;
    if (value.intent.mode === 'UNTIL_GUARDIAN_DELETES' && value.intent.rollingDays === null) return value;
    if (value.intent.mode === 'ROLLING_DAYS' && Number.isInteger(value.intent.rollingDays) && value.intent.rollingDays! >= 1 && value.intent.rollingDays! <= 3650) return value;
    return null;
  } catch { return null; }
}

/** Save echoes only the reviewed version; it never fetches or accepts a new preview. */
export async function saveReviewedRetention(
  client: RondoClient, intent: RetentionIntent, pending: PendingRetention | null,
  remember: (value: PendingRetention | null) => void,
): Promise<RetentionState> {
  const request = pending ?? { key: `idem-${crypto.randomUUID()}`, intent };
  let receipt;
  try {
    if (pending) {
      const lookup = await client.receipt({ idempotencyKey: pending.key, commandKind: 'family.setRetention' });
      if (lookup.status !== 'CONFIRMED') throw new Error('上次保存请求仍未确认，请稍后按原请求继续核对；不会重复保存。');
      receipt = lookup.receipt;
    } else {
      remember(request);
      receipt = await client.command(parseEnvelope({ protocolVersion: 'rondo.v1', commandId: `cmd-${crypto.randomUUID()}`,
        idempotencyKey: request.key, kind: 'family.setRetention', target: { scope: 'FAMILY' },
        payload: { mode: intent.mode, ...(intent.mode === 'ROLLING_DAYS' ? { rollingDays: intent.rollingDays! } : {}), confirmedPreviewVersion: intent.previewVersion },
      }));
    }
  } catch (error) {
    const err = error as { code?: string; transport?: string };
    if (!pending && err.transport !== 'RECEIPT_UNKNOWN' && ['UNAUTHENTICATED', 'FORBIDDEN', 'INVALID_OPERATION', 'PERSISTENCE_FAILED', 'HOST_RECOVERING'].includes(err.code ?? '')) remember(null);
    throw error;
  }
  if (receipt.status !== 'APPLIED') { remember(null); throw new Error('政策未保存，原预览可能已过期或权限不足。请重新读取政策并审阅影响。'); }
  // Keep original key until authoritative readback succeeds, even if the write receipt is already known.
  const state = await client.query({ kind: 'guardian.retentionPolicy' });
  if (state.kind !== 'guardian.retentionPolicy') throw new Error('政策读取暂不可用，尚不能确认保存结果。');
  const actual = state.policy;
  if (!actual || actual.previewVersion !== request.intent.previewVersion || actual.mode !== request.intent.mode || actual.rollingDays !== request.intent.rollingDays) {
    remember(null); throw new Error('保存请求已应用，但当前政策已被再次修改。请重新读取当前政策并审阅影响。');
  }
  remember(null);
  return state;
}
