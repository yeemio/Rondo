import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope } from '../../modules/contracts/public/envelope';
import type { RondoClient } from '../../modules/contracts/public/client';
import type { CommandReceipt } from '../../modules/contracts/public/receipts';
import { clearDeletionCopies, deletionJournalKey, deliverDeletion, readDeletionJournal, type DeletionJournal } from '../../apps/web/src/client/deletion-state';
import { clearExportObjectUrls, downloadExportFile } from '../../apps/web/src/client/browser-export';

function store(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const envelope = parseEnvelope({ protocolVersion: 'rondo.v1', commandId: 'delete-command', idempotencyKey: 'original-delete-key',
  kind: 'guardian.confirmDeletion', target: { scope: 'FAMILY' }, payload: { preparedDeletionId: 'operation-1', scopeListHash: 'a'.repeat(64) } });
const journal: DeletionJournal = { familyId: 'family-1', envelope, deletionId: 'operation-1', copies: { familyId: 'family-1', target: 'ATTEMPT', learnerIds: ['learner-1'], attemptIds: ['attempt-1'] } };
const applied: CommandReceipt = { protocolVersion: 'rondo.v1', commandId: envelope.commandId, idempotencyKey: envelope.idempotencyKey,
  kind: envelope.kind, status: 'APPLIED', changedKinds: ['guardian.deletionStatus'], effectRefs: ['disposal:operation-1'] };
function draft(learnerId: string, attemptId: string) {
  return parseEnvelope({ protocolVersion: 'rondo.v1', commandId: `draft-${attemptId}`, idempotencyKey: `draft-${attemptId}`,
    kind: 'learning.recordPrediction', target: { scope: 'LEARNER', learnerId, attemptId }, payload: { prediction: { claims: [] }, uncertain: true } });
}

test('deletion: lost response after commit recovers the original receipt without a second command', async () => {
  let writes = 0; let lookups = 0;
  const client = { command: async (sent: unknown) => { writes++; assert.deepEqual(sent, envelope); throw Object.assign(Error('response lost after commit'), { transport: 'RECEIPT_UNKNOWN' }); },
    receipt: async (req: { idempotencyKey: string; commandKind: string }) => { lookups++; assert.equal(req.idempotencyKey, envelope.idempotencyKey); return { status: 'CONFIRMED', receipt: applied }; } } as unknown as RondoClient;
  await assert.rejects(() => deliverDeletion(client, journal, false), /response lost/);
  assert.deepEqual(await deliverDeletion(client, journal, true), applied);
  assert.equal(writes, 1); assert.equal(lookups, 1);
});

test('deletion: NOT_FOUND replays only the exact original request; mismatched and rejected receipts never imply success', async () => {
  const sent: unknown[] = [];
  const client = { receipt: async () => ({ status: 'NOT_FOUND' }), command: async (value: unknown) => { sent.push(value); return applied; } } as unknown as RondoClient;
  await deliverDeletion(client, journal, true); await deliverDeletion(client, journal, true);
  assert.deepEqual(sent, [envelope, envelope]);
  const wrong = { ...client, command: async () => ({ ...applied, idempotencyKey: 'wrong-key' }) } as unknown as RondoClient;
  await assert.rejects(() => deliverDeletion(wrong, journal, false), /不匹配/);
  const rejected = { ...client, command: async () => ({ ...applied, status: 'REJECTED', errorCode: 'INVALID_OPERATION', effectRefs: [] }) } as unknown as RondoClient;
  assert.equal((await deliverDeletion(rejected, journal, false)).status, 'REJECTED');
});

test('deletion: opaque journal survives reentry and rejects foreign-family/malformed operation binding', () => {
  const session = store({ [deletionJournalKey('family-1')]: JSON.stringify(journal), 'rondo.export.family-1': 'export-ref' });
  assert.deepEqual(readDeletionJournal(session, 'family-1'), journal);
  assert.equal(readDeletionJournal(session, 'family-other'), null);
  session.setItem(deletionJournalKey('family-1'), JSON.stringify({ ...journal, familyId: 'family-other' }));
  assert.throws(() => readDeletionJournal(session, 'family-1'), /不属于/);
  session.setItem(deletionJournalKey('family-1'), JSON.stringify({ ...journal, deletionId: 'operation-other' }));
  assert.throws(() => readDeletionJournal(session, 'family-1'), /不一致/);
  // Local cancellation removes the preview journal only; it has no data-copy cleanup side effects.
  session.removeItem(deletionJournalKey('family-1'));
  assert.equal(session.getItem('rondo.export.family-1'), 'export-ref');
});

test('deletion: exact known drafts/export references clear; surviving attempts, other families and unrelated keys remain', () => {
  const local = store({
    'rondo.mvp.pending.learner-1': JSON.stringify({ familyId: 'family-1', learnerId: 'learner-1', envelope: draft('learner-1', 'attempt-1') }),
    'rondo.draft.learner-1': JSON.stringify(draft('learner-1', 'attempt-survives')),
    'rondo.mvp.pending.learner-other': JSON.stringify({ familyId: 'family-other', envelope: draft('learner-other', 'attempt-other') }),
    unrelated: 'preserve',
  });
  const session = store({ 'rondo.export.family-1': 'target-ref', 'rondo.export.family-other': 'keep-ref', unrelated: 'preserve' });
  const result = clearDeletionCopies(journal.copies!, local, session);
  assert.equal(result.removedDrafts, 1); assert.equal(result.removedExportRefs, 1); assert.deepEqual(result.failed, []);
  assert.equal(local.getItem('rondo.mvp.pending.learner-1'), null);
  assert.ok(local.getItem('rondo.draft.learner-1')); assert.ok(local.getItem('rondo.mvp.pending.learner-other'));
  assert.equal(session.getItem('rondo.export.family-other'), 'keep-ref'); assert.equal(local.getItem('unrelated'), 'preserve');
  assert.deepEqual(clearDeletionCopies(journal.copies!, local, session), { removedDrafts: 0, removedExportRefs: 0, revokedUrls: 0, failed: [] });
  const all = { ...journal.copies!, target: 'LEARNER' as const };
  assert.equal(clearDeletionCopies(all, local, session).removedDrafts, 1);
});

test('deletion: blocked/corrupt or foreign-owned draft remains explicitly partial', () => {
  const local = store({ 'rondo.mvp.pending.learner-1': JSON.stringify({ familyId: 'family-other', envelope: draft('learner-1', 'attempt-1') }), 'rondo.draft.learner-1': '{bad' });
  const session = { getItem: () => 'not-empty', removeItem: () => { throw Error('storage blocked'); } };
  const result = clearDeletionCopies(journal.copies!, local, session);
  assert.equal(result.removedDrafts, 0); assert.equal(result.removedExportRefs, 0); assert.equal(result.failed.length, 3);
  assert.ok(local.getItem('rondo.mvp.pending.learner-1')); assert.ok(local.getItem('rondo.draft.learner-1'));
});

test('deletion: only full-family deletion retires that family pending retention recovery', () => {
  const key = 'rondo.retention.pending.family-1';
  const other = 'rondo.retention.pending.family-other';
  const session = store({ [key]: 'pending-policy', [other]: 'other-policy' });
  const local = store();
  for (const target of ['ATTEMPT', 'LEARNER'] as const) {
    clearDeletionCopies({ ...journal.copies!, target }, local, session);
    assert.equal(session.getItem(key), 'pending-policy');
  }
  const result = clearDeletionCopies({ ...journal.copies!, target: 'ALL_FAMILY_DATA' }, local, session);
  assert.equal(session.getItem(key), null);
  assert.equal(session.getItem(other), 'other-policy');
  assert.deepEqual(result.failed, []);
  const blocked = { getItem: (name: string) => name === key ? 'pending-policy' : null, removeItem: () => {} };
  assert.ok(clearDeletionCopies({ ...journal.copies!, target: 'ALL_FAMILY_DATA' }, local, blocked).failed.includes(key));
});

test('deletion: current-family Blob URLs revoke immediately and idempotently, preserving normal per-file clicks and timers', (t) => {
  let next = 0, clicks = 0; const revoked: string[] = [], timers: Array<() => void> = [];
  t.mock.method(URL, 'createObjectURL', () => `blob:deletion-${++next}`);
  t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
  t.mock.method(globalThis, 'setTimeout', ((fn: () => void, ms: number) => { assert.equal(ms, 30_000); timers.push(fn); return 0; }) as unknown as typeof setTimeout);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { appendChild() {} }, createElement: () => ({ remove() {}, click() { clicks++; } }) } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else Reflect.deleteProperty(globalThis, 'document'); });
  const file = { name: 'synthetic.json', type: 'application/json;charset=utf-8' as const, text: 'synthetic text' };
  assert.equal(downloadExportFile(file, 'family-1').delivery, 'DOWNLOAD_INITIATED');
  assert.equal(downloadExportFile(file, 'family-other').delivery, 'DOWNLOAD_INITIATED'); assert.equal(clicks, 2);
  assert.deepEqual(clearExportObjectUrls('family-1'), { revoked: 1, failed: 0 });
  assert.deepEqual(revoked, ['blob:deletion-1']); assert.equal(timers.length, 2);
  assert.deepEqual(clearExportObjectUrls('family-1'), { revoked: 0, failed: 0 });
  timers.forEach((fn) => fn()); assert.ok(revoked.includes('blob:deletion-2'));
  assert.deepEqual(clearExportObjectUrls('family-other'), { revoked: 0, failed: 0 });
});
