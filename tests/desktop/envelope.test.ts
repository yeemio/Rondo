/**
 * Unit tests for the Main<->Host wire envelope guards (pure, Electron-free).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_WIRE_VERSION,
  isHostReadyMessage,
  isHostWireResponse,
  isHostWireEvent,
  parseHostWireRequest,
  transportCodeForLostRequest,
} from '../../apps/host/envelope';
import { PROTOCOL_VERSION } from '../../modules/contracts/public/protocol';

function sampleRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    direction: 'request',
    wireVersion: HOST_WIRE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    requestId: 'req-1',
    hostEpoch: 'epoch-a',
    kind: 'command',
    sender: { source: 'desktop-main', windowId: 1, webContentsId: 2 },
    payload: {},
    ...overrides,
  };
}

function sampleResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    direction: 'response',
    wireVersion: HOST_WIRE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    requestId: 'req-1',
    hostEpoch: 'epoch-a',
    kind: 'command',
    ok: true,
    result: {},
    ...overrides,
  };
}

test('ready message guard accepts only well-formed ready', () => {
  assert.equal(isHostReadyMessage({ direction: 'ready', wireVersion: 1, hostEpoch: 'e', identity: {} }), false);
  const good = { direction: 'ready', wireVersion: 1, protocolVersion: PROTOCOL_VERSION, hostEpoch: 'e', identity: { hostPhase: 'READY' } };
  assert.equal(isHostReadyMessage(good), true);
  assert.equal(isHostReadyMessage('nope'), false);
});

test('response guard rejects foreign shapes', () => {
  assert.equal(isHostWireResponse(sampleResponse()), true);
  assert.equal(isHostWireResponse(sampleResponse({ wireVersion: 2 })), false);
  assert.equal(isHostWireResponse(sampleResponse({ protocolVersion: 'other.v9' })), false);
  assert.equal(isHostWireResponse({ direction: 'response', wireVersion: 1, ok: false }), false);
});

test('event guard recognizes invalidation events', () => {
  const event = {
    direction: 'event',
    wireVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    hostEpoch: 'e',
    kind: 'invalidation',
    notice: {},
  };
  assert.equal(isHostWireEvent(event), true);
  assert.equal(isHostWireEvent({ ...event, kind: 'other' }), false);
});

test('host request parser enforces epoch and sender binding', () => {
  const ok = parseHostWireRequest(sampleRequest(), 'epoch-a');
  assert.equal(ok.ok, true);

  assert.equal(parseHostWireRequest(sampleRequest({ hostEpoch: 'epoch-old' }), 'epoch-a').ok, false);
  assert.equal(parseHostWireRequest(sampleRequest({ sender: { source: 'renderer', windowId: 1, webContentsId: 2 } }), 'epoch-a').ok, false);
  assert.equal(parseHostWireRequest(sampleRequest({ wireVersion: 9 }), 'epoch-a').ok, false);
  assert.equal(parseHostWireRequest('string', 'epoch-a').ok, false);
  assert.equal(parseHostWireRequest(sampleRequest({ kind: 'format-disk' }), 'epoch-a').ok, false);
});

test('lost write requests classify as RECEIPT_UNKNOWN, reads as disconnect/timeout', () => {
  assert.equal(transportCodeForLostRequest('command', false), 'RECEIPT_UNKNOWN');
  assert.equal(transportCodeForLostRequest('command', true), 'RECEIPT_UNKNOWN');
  assert.equal(transportCodeForLostRequest('query', false), 'HOST_DISCONNECTED');
  assert.equal(transportCodeForLostRequest('query', true), 'HOST_RESPONSE_UNKNOWN');
  assert.equal(transportCodeForLostRequest('receipt', true), 'HOST_RESPONSE_UNKNOWN');
});
