/**
 * Canonical serialization and payload hash fixtures (B-D5; coordinator delta
 * item 3): key-order invariance, structural rules, and rejection of
 * non-finite / undefined values.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CanonicalizationError,
  PAYLOAD_HASH_SEPARATOR,
  canonicalize,
  computePayloadHash,
} from '../../modules/contracts/public/canonical';

test('separator is exactly one U+0000 byte', () => {
  assert.equal(PAYLOAD_HASH_SEPARATOR.length, 1);
  assert.equal(PAYLOAD_HASH_SEPARATOR.charCodeAt(0), 0);
});

test('canonicalize sorts object keys recursively and preserves array order', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({ z: { d: 4, c: 3 }, a: [2, 1] }), '{"a":[2,1],"z":{"c":3,"d":4}}');
  assert.equal(canonicalize(null), 'null');
  assert.equal(canonicalize(true), 'true');
  assert.equal(canonicalize(false), 'false');
  assert.equal(canonicalize('x"y'), '"x\\"y"');
  assert.equal(canonicalize(40), '40');
  assert.equal(canonicalize(3.14), '3.14');
  assert.equal(canonicalize([]), '[]');
  assert.equal(canonicalize({}), '{}');
});

test('canonicalize rejects NaN, Infinity, undefined, and non-plain values', () => {
  assert.throws(() => canonicalize(Number.NaN), CanonicalizationError);
  assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), CanonicalizationError);
  assert.throws(() => canonicalize({ a: undefined }), CanonicalizationError);
  assert.throws(() => canonicalize([undefined]), CanonicalizationError);
  assert.throws(() => canonicalize(1n), CanonicalizationError);
  assert.throws(() => canonicalize(new Date(0)), CanonicalizationError);
  assert.throws(() => canonicalize(new Map()), CanonicalizationError);
});

test('same payload under a different key order produces the same hash', async () => {
  const a = await computePayloadHash({
    protocolVersion: 'rondo.v1',
    kind: 'learning.submitResponse',
    payload: {
      response: [{ kind: 'numberWithUnit', quantityId: 'lateralArea', value: 251.2, unitId: 'cm2' }],
    },
    target: { scope: 'LEARNER', learnerId: 'lrn-0001', attemptId: 'att-0001' },
    binding: { releaseId: 'rel-1', questionInstanceId: 'qi-1', rendererContractVersion: '1' },
    expectedAttemptVersion: 3,
  });
  const b = await computePayloadHash({
    expectedAttemptVersion: 3,
    binding: { rendererContractVersion: '1', questionInstanceId: 'qi-1', releaseId: 'rel-1' },
    target: { attemptId: 'att-0001', learnerId: 'lrn-0001', scope: 'LEARNER' },
    payload: {
      response: [{ unitId: 'cm2', quantityId: 'lateralArea', value: 251.2, kind: 'numberWithUnit' }],
    },
    kind: 'learning.submitResponse',
    protocolVersion: 'rondo.v1',
  });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('hash inputs are distinguished: binding null vs present, expectedAttemptVersion absent vs present', async () => {
  const base = {
    protocolVersion: 'rondo.v1',
    kind: 'learning.recordPrediction',
    payload: { prediction: { claims: [{ propertyId: 'radius', direction: 'INCREASE' }] }, uncertain: false },
    target: { scope: 'LEARNER', learnerId: 'lrn-0001', attemptId: 'att-0001' },
  };
  const withoutBinding = await computePayloadHash(base);
  const withBinding = await computePayloadHash({
    ...base,
    binding: { releaseId: 'rel-1', questionInstanceId: 'qi-1', rendererContractVersion: '1' },
  });
  const withVersion = await computePayloadHash({ ...base, expectedAttemptVersion: 2 });
  assert.notEqual(withoutBinding, withBinding);
  assert.notEqual(withoutBinding, withVersion);
});

test('computePayloadHash rejects non-finite payloads (same key must never silently rehash)', async () => {
  await assert.rejects(
    () =>
      computePayloadHash({
        protocolVersion: 'rondo.v1',
        kind: 'learning.submitResponse',
        payload: { response: [{ kind: 'numberWithUnit', quantityId: 'q', value: Number.NaN, unitId: 'mm' }] },
        target: { scope: 'LEARNER', learnerId: 'lrn-1', attemptId: 'att-1' },
      }),
    CanonicalizationError,
  );
});
