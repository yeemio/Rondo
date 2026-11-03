import { parseEnvelope, type PublicCommandEnvelope } from '../../../../modules/contracts/public/envelope';
import type { RondoClient } from '../../../../modules/contracts/public/client';
import type { CommandReceipt } from '../../../../modules/contracts/public/receipts';
import type { DeletionScope } from '../../../../modules/contracts/public/queries';
import { clearExportObjectUrls } from './browser-export';

export interface DeletionCopyScope { familyId: string; target: DeletionScope['target']; learnerIds: string[]; attemptIds: string[]; }
export interface DeletionJournal {
  familyId: string;
  envelope: PublicCommandEnvelope;
  deletionId?: string;
  copies?: DeletionCopyScope;
  cleanup?: { removedDrafts: number; removedExportRefs: number; revokedUrls: number; failed: string[] };
}
export const deletionJournalKey = (familyId: string) => `rondo.deletion.${familyId}`;

/** This journal contains only deletion intent and opaque ids, never learning text or credentials. */
export function readDeletionJournal(store: Pick<Storage, 'getItem'>, familyId: string): DeletionJournal | null {
  const raw = store.getItem(deletionJournalKey(familyId));
  if (!raw) return null;
  const value = JSON.parse(raw) as DeletionJournal;
  const envelope = parseEnvelope(value.envelope);
  if (value.familyId !== familyId || envelope.target.scope !== 'FAMILY' ||
      !['guardian.prepareDeletion', 'guardian.confirmDeletion'].includes(envelope.kind) ||
      (value.copies && value.copies.familyId !== familyId)) throw Error('删除恢复标识不属于当前家庭。');
  if (value.copies && (!['ALL_FAMILY_DATA', 'LEARNER', 'ATTEMPT'].includes(value.copies.target) ||
      !Array.isArray(value.copies.learnerIds) || !value.copies.learnerIds.every((id) => typeof id === 'string') ||
      !Array.isArray(value.copies.attemptIds) || !value.copies.attemptIds.every((id) => typeof id === 'string')))
    throw Error('删除副本恢复范围不可读，请保留原记录。');
  if (envelope.kind === 'guardian.confirmDeletion' && value.deletionId !== (envelope.payload as { preparedDeletionId: string }).preparedDeletionId)
    throw Error('删除恢复标识不一致，请保留原记录。');
  return { ...value, envelope };
}

export async function deliverDeletion(client: RondoClient, journal: DeletionJournal, recover: boolean): Promise<CommandReceipt> {
  const envelope = journal.envelope;
  let receipt: CommandReceipt | undefined;
  if (recover) {
    const lookup = await client.receipt({ idempotencyKey: envelope.idempotencyKey, commandKind: envelope.kind });
    if (lookup.status === 'CONFIRMED') receipt = lookup.receipt;
  }
  // NOT_FOUND does not prove non-delivery. Replaying this exact envelope cannot widen its reviewed scope.
  receipt ??= await client.command(envelope);
  if (receipt.idempotencyKey !== envelope.idempotencyKey || receipt.kind !== envelope.kind)
    throw Error('回执与原删除请求不匹配，尚未确认结果。');
  return receipt;
}

/** Known app keys only; arbitrary browser storage, Downloads and backups are outside this boundary. */
export function clearDeletionCopies(copies: DeletionCopyScope, local: Pick<Storage, 'getItem' | 'removeItem'>,
  session: Pick<Storage, 'getItem' | 'removeItem'>): NonNullable<DeletionJournal['cleanup']> {
  const result = { removedDrafts: 0, removedExportRefs: 0, revokedUrls: 0, failed: [] as string[] };
  for (const learnerId of copies.learnerIds) for (const prefix of ['rondo.mvp.pending.', 'rondo.draft.']) {
    const key = prefix + learnerId;
    try {
      const raw = local.getItem(key);
      if (!raw) continue;
      const value = JSON.parse(raw) as { familyId?: string; envelope?: unknown };
      if (value.familyId !== undefined && value.familyId !== copies.familyId) { result.failed.push(key); continue; }
      const envelope = parseEnvelope(value.envelope ?? value);
      if (envelope.target.scope !== 'LEARNER' || envelope.target.learnerId !== learnerId) { result.failed.push(key); continue; }
      if (copies.target === 'ATTEMPT' && (!envelope.target.attemptId || !copies.attemptIds.includes(envelope.target.attemptId))) continue;
      local.removeItem(key);
      if (local.getItem(key) !== null) throw Error('Draft remains');
      result.removedDrafts++;
    } catch { result.failed.push(key); }
  }
  const exportKey = `rondo.export.${copies.familyId}`;
  try {
    if (session.getItem(exportKey) !== null) { session.removeItem(exportKey); if (session.getItem(exportKey) !== null) throw Error('Export reference remains'); result.removedExportRefs++; }
  } catch { result.failed.push(exportKey); }
  // Full-family deletion removes the policy and its receipt, so its old recovery key can no longer resolve.
  if (copies.target === 'ALL_FAMILY_DATA') {
    const retentionKey = `rondo.retention.pending.${copies.familyId}`;
    try {
      session.removeItem(retentionKey);
      if (session.getItem(retentionKey) !== null) throw Error('Retention recovery reference remains');
    } catch { result.failed.push(retentionKey); }
  }
  const urls = clearExportObjectUrls(copies.familyId);
  result.revokedUrls = urls.revoked;
  if (urls.failed) result.failed.push('本标签页临时导出链接');
  return result;
}
