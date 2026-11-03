/**
 * Unit tests for adapters/desktop-client: IPC unwrap, schema validation and
 * the delivery-unknown receipt replay rule (original key, never resend).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRondoClient,
  RondoClientError,
} from '../../adapters/desktop-client/index';
import type { RondoPreloadApi } from '../../adapters/desktop-client/preload-api';
import type { IpcResult } from '../../adapters/desktop-client/ipc-result';
import { PROTOCOL_VERSION } from '../../modules/contracts/public/protocol';
import { parseEnvelope } from '../../modules/contracts/public/envelope';
import { randomUUID } from 'node:crypto';

const validEnvelope = parseEnvelope({
  protocolVersion: PROTOCOL_VERSION,
  commandId: randomUUID(),
  idempotencyKey: randomUUID(),
  kind: 'family.createLearner',
  target: { scope: 'FAMILY' },
  payload: { alias: 't' },
});

const validReceipt = {
  protocolVersion: PROTOCOL_VERSION,
  commandId: validEnvelope.commandId,
  idempotencyKey: validEnvelope.idempotencyKey,
  kind: 'family.createLearner' as const,
  status: 'REJECTED' as const,
  errorCode: 'CAPABILITY_UNAVAILABLE' as const,
  changedKinds: [],
  effectRefs: [],
};

function surfaceWith(commandImpl: (envelope: unknown) => Promise<IpcResult<unknown>>): RondoPreloadApi & {
  receiptCalls: unknown[];
} {
  const holder = {
    receiptCalls: [] as unknown[],
  };
  const api: RondoPreloadApi = {
    command: commandImpl,
    query: async () => ({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'x' } }),
    receipt: async (request: unknown) => {
      holder.receiptCalls.push(request);
      return { ok: true, value: { status: 'NOT_FOUND' } };
    },
    subscribeInvalidation: () => () => undefined,
  };
  return Object.assign(api, holder);
}

test('command returns a validated receipt', async () => {
  const api = surfaceWith(async () => ({ ok: true, value: validReceipt }));
  const client = createRondoClient(api);
  const receipt = await client.command(validEnvelope);
  assert.equal(receipt.status, 'REJECTED');
  assert.equal(receipt.errorCode, 'CAPABILITY_UNAVAILABLE');
});

test('command surfaces domain errors with frozen codes', async () => {
  const api = surfaceWith(async () => ({ ok: false, error: { code: 'SCHEMA_MISMATCH', message: 'bad' } }));
  const client = createRondoClient(api);
  await assert.rejects(client.command(validEnvelope), (error: unknown) => {
    assert.ok(error instanceof RondoClientError);
    assert.equal(error.code, 'SCHEMA_MISMATCH');
    return true;
  });
});

test('RECEIPT_UNKNOWN replays the ORIGINAL key via receipt lookup', async () => {
  let seenEnvelope: unknown = null;
  let commandCalls = 0;
  const api = surfaceWith(async (envelope: unknown) => {
    commandCalls += 1;
    seenEnvelope = envelope;
    return { ok: false, error: { code: 'HOST_RECOVERING', message: 'gone' }, transport: 'RECEIPT_UNKNOWN' as const };
  });
  // First lookup finds nothing; the error must surface as RECEIPT_UNKNOWN.
  const client = createRondoClient(api);
  await assert.rejects(client.command(validEnvelope), (error: unknown) => {
    assert.ok(error instanceof RondoClientError);
    assert.equal(error.transport, 'RECEIPT_UNKNOWN');
    return true;
  });
  assert.equal(commandCalls, 1, 'the command must NOT be resent');
  assert.equal(api.receiptCalls.length, 1);
  assert.deepEqual(api.receiptCalls[0], {
    idempotencyKey: validEnvelope.idempotencyKey,
    commandKind: 'family.createLearner',
  });
  assert.equal((seenEnvelope as { idempotencyKey: string }).idempotencyKey, validEnvelope.idempotencyKey);
});

test('RECEIPT_UNKNOWN with CONFIRMED lookup returns the stored receipt without resending', async () => {
  let commandCalls = 0;
  const confirmed = { status: 'CONFIRMED', receipt: validReceipt };
  const api: RondoPreloadApi = {
    command: async () => {
      commandCalls += 1;
      return { ok: false, error: { code: 'HOST_RECOVERING', message: 'gone' }, transport: 'RECEIPT_UNKNOWN' as const };
    },
    query: async () => ({ ok: true, value: {} }),
    receipt: async () => ({ ok: true, value: confirmed }),
    subscribeInvalidation: () => () => undefined,
  };
  const client = createRondoClient(api);
  const receipt = await client.command(validEnvelope);
  assert.equal(receipt.idempotencyKey, validEnvelope.idempotencyKey);
  assert.equal(commandCalls, 1);
});

test('query validates the projection shape', async () => {
  const api: RondoPreloadApi = {
    command: async () => ({ ok: true, value: validReceipt }),
    query: async () => ({ ok: true, value: { kind: 'catalog.availableLessons', lessons: 'not-an-array' } }),
    receipt: async () => ({ ok: true, value: { status: 'NOT_FOUND' } }),
    subscribeInvalidation: () => () => undefined,
  };
  const client = createRondoClient(api);
  await assert.rejects(client.query({ kind: 'catalog.availableLessons' }), (error: unknown) => {
    assert.ok(error instanceof RondoClientError);
    assert.equal(error.code, 'SCHEMA_MISMATCH');
    return true;
  });
});

test('subscribeInvalidation forwards only schema-valid notices', async () => {
  const received: unknown[] = [];
  const sinks: Array<(notice: unknown) => void> = [];
  const api: RondoPreloadApi = {
    command: async () => ({ ok: true, value: validReceipt }),
    query: async () => ({ ok: true, value: {} }),
    receipt: async () => ({ ok: true, value: { status: 'NOT_FOUND' } }),
    subscribeInvalidation: (cb) => {
      sinks.push(cb);
      return () => {
        const index = sinks.indexOf(cb);
        if (index >= 0) sinks.splice(index, 1);
      };
    },
  };
  const client = createRondoClient(api);
  client.subscribeInvalidation((notice) => received.push(notice));
  const push = (notice: unknown) => {
    for (const sink of [...sinks]) sink(notice);
  };
  push({ attemptId: 'a', version: 1, changedKinds: ['x'] });
  push({ garbage: true });
  push({ attemptId: 'a', version: -3, changedKinds: [] });
  assert.equal(received.length, 1);
});
