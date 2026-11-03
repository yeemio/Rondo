import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RondoClient } from '../../modules/contracts/public/client';
import type { CommandReceipt } from '../../modules/contracts/public/receipts';
import { prepareExportReference } from '../../apps/web/src/client/export-state';
const applied: CommandReceipt = { protocolVersion: 'rondo.v1', commandId: 'cmd-test', idempotencyKey: 'idem-test', kind: 'guardian.prepareExport', status: 'APPLIED', effectRefs: ['export:op-resumed'], changedKinds: ['guardian.exportStatus'] };

for (const code of ['UNAUTHENTICATED', 'FORBIDDEN']) test(`explicit ${code} prepare denial clears pending; after unlock a new prepare succeeds`, async () => {
  let commands = 0;
  const state = { ref: null as string | null, pending: null as string | null };
  const remember = (ref: string | null, pending: string | null = null) => { state.ref = ref; state.pending = pending; };
  const client = { command: async () => { if (++commands === 1) throw { code, message: 'denied' }; return applied; }, receipt: async () => { throw new Error('must not query nonexistent receipt'); } } as unknown as RondoClient;
  await assert.rejects(prepareExportReference(client, ['ALIASES'], null, remember), (e: unknown) => (e as { code: string }).code === code);
  assert.equal(state.pending, null); assert.equal(state.ref, null);
  assert.equal(await prepareExportReference(client, ['ALIASES'], state.pending, remember), 'op-resumed');
  assert.equal(commands, 2); assert.equal(state.ref, 'op-resumed'); assert.equal(state.pending, null);
});

test('unknown prepare delivery retains original key through missing receipt and auth denial, then recovers original ref without resending', async () => {
  let commands = 0; let receiptMode = 'missing'; const keys: string[] = [];
  const state = { ref: null as string | null, pending: null as string | null };
  const remember = (ref: string | null, pending: string | null = null) => { state.ref = ref; state.pending = pending; };
  const client = {
    command: async () => { commands++; throw { code: 'HOST_RECOVERING', transport: 'RECEIPT_UNKNOWN' }; },
    receipt: async (request: { idempotencyKey: string }) => {
      keys.push(request.idempotencyKey);
      if (receiptMode === 'denied') throw { code: 'UNAUTHENTICATED' };
      return receiptMode === 'missing' ? { status: 'NOT_FOUND' } : { status: 'CONFIRMED', receipt: applied };
    },
  } as unknown as RondoClient;
  await assert.rejects(prepareExportReference(client, ['ALIASES'], null, remember));
  const original = state.pending; assert.ok(original);
  await assert.rejects(prepareExportReference(client, ['ALIASES'], state.pending, remember));
  assert.equal(state.pending, original);
  receiptMode = 'denied'; await assert.rejects(prepareExportReference(client, ['ALIASES'], state.pending, remember));
  assert.equal(state.pending, original);
  receiptMode = 'confirmed'; assert.equal(await prepareExportReference(client, ['ALIASES'], state.pending, remember), 'op-resumed');
  assert.equal(commands, 1); assert.deepEqual(keys, [original, original, original]); assert.equal(state.pending, null);
});
