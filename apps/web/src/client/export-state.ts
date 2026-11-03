import type { RondoClient } from '../../../../modules/contracts/public/client';
import { parseEnvelope } from '../../../../modules/contracts/public/envelope';

type Remember = (ref: string | null, pending?: string | null) => void;

/** Only genuinely unknown delivery keeps the original prepare key for receipt recovery. */
export async function prepareExportReference(client: RondoClient, categories: string[], pending: string | null, remember: Remember): Promise<string> {
  try {
    let receipt;
    if (pending) {
      const lookup = await client.receipt({ idempotencyKey: pending, commandKind: 'guardian.prepareExport' });
      if (lookup.status !== 'CONFIRMED') throw new Error('上次准备请求尚未确认，请稍后继续核对；不会重复创建导出。');
      receipt = lookup.receipt;
    } else {
      const key = `idem-${crypto.randomUUID()}`;
      remember(null, key);
      receipt = await client.command(parseEnvelope({
        protocolVersion: 'rondo.v1', commandId: `cmd-${crypto.randomUUID()}`, idempotencyKey: key,
        kind: 'guardian.prepareExport', target: { scope: 'FAMILY' }, payload: { scope: { categories } },
      }));
    }
    if (receipt.status !== 'APPLIED') { remember(null); throw new Error(`准备导出被拒绝：${receipt.errorCode}`); }
    const ref = receipt.effectRefs.find((r) => r.startsWith('export:'))?.slice(7);
    if (!ref) throw new Error('导出预览未建立，请继续核对上次请求。');
    remember(ref);
    return ref;
  } catch (error) {
    const err = error as { code?: string; transport?: string };
    if (!pending && err.transport !== 'RECEIPT_UNKNOWN' && ['UNAUTHENTICATED', 'FORBIDDEN'].includes(err.code ?? '')) remember(null);
    throw error;
  }
}
