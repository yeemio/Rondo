/**
 * Negative fixtures (H0-SPEC §4): the schema/port rejection surface.
 *
 * Covered: unknown kind; unknown envelope/payload fields; partial binding;
 * out-of-range and non-integer geometry (radiusMm=4, 30.5, ...); forbidden
 * question-spec fields; unknown query kind; cross-family target; unknown
 * rendererContractVersion; idempotency conflict; version conflict;
 * code.* capability gating; required expectedAttemptVersion.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { safeParseEnvelope, safeParseCommandKind, parseEnvelope } from '../../modules/contracts/public/envelope';
import { safeParseCylinderStateV1 } from '../../modules/contracts/public/scene';
import { safeParsePublicQuestionSpec } from '../../modules/contracts/public/question';
import { safeParsePublicQuery } from '../../modules/contracts/public/queries';
import { parseRondoError } from '../../modules/contracts/public/errors';
import type { ServerContext } from '../../modules/contracts/server/context';
import { createStubHarness, asRondoError, StubHarness } from './stub-service';
import {
  SYNTH_INITIAL_STATE,
  SYNTH_PROTOCOL_VERSION,
  SYNTH_RELEASE_ID,
  SYNTH_RENDERER_CONTRACT_VERSION,
  sampleQuestionSpec,
} from './synthetic';

const validBase = {
  protocolVersion: SYNTH_PROTOCOL_VERSION,
  commandId: 'cmd-neg-0001',
  idempotencyKey: 'idem-neg-0001',
  kind: 'family.createLearner',
  target: { scope: 'FAMILY' },
  payload: { alias: 'Mio' },
};

// ---------------------------------------------------------------------------
// Schema-level rejections
// ---------------------------------------------------------------------------

test('unknown command kind is rejected by the closed kind set', () => {
  assert.equal(safeParseCommandKind('learning.noSuchCommand').success, false);
  assert.equal(
    safeParseEnvelope({ ...validBase, kind: 'learning.noSuchCommand', payload: {} }).success,
    false,
  );
  assert.equal(safeParseEnvelope({ ...validBase, kind: 'setScore', payload: {} }).success, false);
});

test('unknown envelope fields are rejected (strict)', () => {
  // Renderer-supplied actor/familyId must never ride on the envelope.
  assert.equal(safeParseEnvelope({ ...validBase, actorId: 'actor-smuggled', familyId: 'fam-smuggled' }).success, false);
});

test('unknown payload fields are rejected (strict)', () => {
  assert.equal(
    safeParseEnvelope({ ...validBase, payload: { alias: 'Mio', familyId: 'fam-smuggled' } }).success,
    false,
  );
  assert.equal(safeParseEnvelope({ ...validBase, payload: { alias: 'Mio', role: 'GUARDIAN' } }).success, false);
});

test('binding is all-or-nothing: partial bindings are rejected', () => {
  assert.equal(
    safeParseEnvelope({ ...validBase, binding: { releaseId: SYNTH_RELEASE_ID } }).success,
    false,
  );
  assert.equal(
    safeParseEnvelope({
      ...validBase,
      binding: { releaseId: SYNTH_RELEASE_ID, questionInstanceId: 'qi-1' },
    }).success,
    false,
  );
});

test('kinds that CAS require expectedAttemptVersion; omitting it fails the schema', () => {
  const submitWithoutVersion = {
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-neg-0002',
    idempotencyKey: 'idem-neg-0002',
    kind: 'learning.reviseResponse',
    target: { scope: 'LEARNER', learnerId: 'lrn-x', attemptId: 'att-x', cycleId: 'cyc-x' },
    binding: {
      releaseId: SYNTH_RELEASE_ID,
      questionInstanceId: 'qi-x',
      rendererContractVersion: SYNTH_RENDERER_CONTRACT_VERSION,
    },
    payload: {},
  };
  assert.equal(safeParseEnvelope(submitWithoutVersion).success, false);
  assert.equal(safeParseEnvelope({ ...submitWithoutVersion, expectedAttemptVersion: 1 }).success, true);
});

test('geometry values out of range or non-integer are rejected', () => {
  assert.equal(safeParseCylinderStateV1({ ...SYNTH_INITIAL_STATE, radiusMm: 4 }).success, false);
  assert.equal(safeParseCylinderStateV1({ ...SYNTH_INITIAL_STATE, radiusMm: 101 }).success, false);
  assert.equal(safeParseCylinderStateV1({ ...SYNTH_INITIAL_STATE, radiusMm: 30.5 }).success, false);
  assert.equal(safeParseCylinderStateV1({ ...SYNTH_INITIAL_STATE, heightMm: 9 }).success, false);
  assert.equal(safeParseCylinderStateV1({ ...SYNTH_INITIAL_STATE, heightMm: 201 }).success, false);
  assert.equal(safeParseCylinderStateV1({ ...SYNTH_INITIAL_STATE, unrollPermille: 1001 }).success, false);
  assert.equal(safeParseCylinderStateV1({ ...SYNTH_INITIAL_STATE, unrollPermille: 12.5 }).success, false);
  assert.equal(safeParseCylinderStateV1({ ...SYNTH_INITIAL_STATE, section: 'DIAGONAL' }).success, false);
  // Radius 4 also fails through the operation payload (dimension-aware range).
  assert.equal(
    safeParseEnvelope({
      ...validBase,
      kind: 'learning.commitOperation',
      target: { scope: 'LEARNER', learnerId: 'lrn-x', attemptId: 'att-x' },
      expectedAttemptVersion: 1,
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 4 } },
    }).success,
    false,
  );
  // HEIGHT has a different range: radius range values do not apply.
  assert.equal(
    safeParseEnvelope({
      ...validBase,
      kind: 'learning.commitOperation',
      target: { scope: 'LEARNER', learnerId: 'lrn-x', attemptId: 'att-x' },
      expectedAttemptVersion: 1,
      payload: { operation: { type: 'SetDimension', dimension: 'HEIGHT', valueMm: 8 } },
    }).success,
    false,
  );
});

test('predictions without claims and without the uncertain flag are rejected', () => {
  assert.equal(
    safeParseEnvelope({
      ...validBase,
      kind: 'learning.recordPrediction',
      target: { scope: 'LEARNER', learnerId: 'lrn-x', attemptId: 'att-x' },
      payload: { prediction: { claims: [] }, uncertain: false },
    }).success,
    false,
  );
});

test('PublicQuestionSpec rejects forbidden private fields (structural rejection)', () => {
  const spec = sampleQuestionSpec();
  for (const forbidden of ['answer', 'correctIndex', 'privateTests', 'scoringFunction', 'seed', 'answerHash']) {
    const mutated = { ...spec, [forbidden]: forbidden === 'correctIndex' ? 2 : 'leak' };
    assert.equal(safeParsePublicQuestionSpec(mutated).success, false, `field ${forbidden} must be rejected`);
  }
  assert.equal(safeParsePublicQuestionSpec(spec).success, true);
});

test('unknown query kinds are rejected, never silently empty', () => {
  assert.equal(safeParsePublicQuery({ kind: 'learning.everything' }).success, false);
  assert.equal(safeParsePublicQuery({ kind: 'debug.rawSql', sql: 'SELECT * FROM submission' }).success, false);
});

// ---------------------------------------------------------------------------
// Port-level (stub) rejections
// ---------------------------------------------------------------------------

interface Prepared {
  harness: StubHarness;
  learnerCtx: ServerContext;
  learnerId: string;
  attemptId: string;
  cycleId: string;
  questionInstanceId: string;
  binding: { releaseId: string; questionInstanceId: string; rendererContractVersion: string };
}

async function prepareLearnerAttempt(): Promise<Prepared> {
  const harness = createStubHarness();
  const guardianCtx = harness.guardianContext();
  await harness.auth.setupGuardian({
    idempotencyKey: 'auth-setup-neg',
    familyDisplayName: 'Rondo 合成家庭',
    guardianDisplayName: 'Guardian',
    passphrase: 'stub-passphrase-0001',
  });
  const createReceipt = await harness.server.handleCommand(
    guardianCtx,
    parseEnvelope({
      protocolVersion: SYNTH_PROTOCOL_VERSION,
      commandId: 'cmd-neg-create-0001',
      idempotencyKey: 'idem-neg-create-0001',
      kind: 'family.createLearner',
      target: { scope: 'FAMILY' },
      payload: { alias: 'Mio' },
    }),
  );
  const learnerId = createReceipt.effectRefs
    .find((ref) => ref.startsWith('learner:'))
    ?.slice('learner:'.length);
  assert.ok(learnerId);
  const learnerCtx = harness.learnerContext(learnerId);
  const startReceipt = await harness.server.handleCommand(
    learnerCtx,
    parseEnvelope({
      protocolVersion: SYNTH_PROTOCOL_VERSION,
      commandId: 'cmd-neg-start-0001',
      idempotencyKey: 'idem-neg-start-0001',
      kind: 'learning.startAttempt',
      target: { scope: 'LEARNER', learnerId },
      payload: { releaseId: SYNTH_RELEASE_ID },
    }),
  );
  const attemptId = startReceipt.effectRefs.find((r) => r.startsWith('attempt:'))?.slice('attempt:'.length);
  const cycleId = startReceipt.effectRefs.find((r) => r.startsWith('cycle:'))?.slice('cycle:'.length);
  const questionInstanceId = startReceipt.effectRefs
    .find((r) => r.startsWith('questionInstance:'))
    ?.slice('questionInstance:'.length);
  assert.ok(attemptId && cycleId && questionInstanceId);
  await harness.server.handleCommand(
    learnerCtx,
    parseEnvelope({
      protocolVersion: SYNTH_PROTOCOL_VERSION,
      commandId: 'cmd-neg-pred-0001',
      idempotencyKey: 'idem-neg-pred-0001',
      kind: 'learning.recordPrediction',
      target: { scope: 'LEARNER', learnerId, attemptId, cycleId },
      binding: { releaseId: SYNTH_RELEASE_ID, questionInstanceId, rendererContractVersion: SYNTH_RENDERER_CONTRACT_VERSION },
      payload: { prediction: { claims: [{ propertyId: 'diameter', direction: 'UNCHANGED' }] }, uncertain: false },
    }),
  );
  return {
    harness,
    learnerCtx,
    learnerId,
    attemptId,
    cycleId,
    questionInstanceId,
    binding: { releaseId: SYNTH_RELEASE_ID, questionInstanceId, rendererContractVersion: SYNTH_RENDERER_CONTRACT_VERSION },
  };
}

function rejectedWith(err: unknown, code: string): boolean {
  const rondoErr = asRondoError(err);
  if (rondoErr === null) return false;
  assert.doesNotThrow(() => parseRondoError(rondoErr));
  return rondoErr.code === code;
}

test('cross-family learner target is rejected with FORBIDDEN', async () => {
  const prepared = await prepareLearnerAttempt();
  const foreignCtx = prepared.harness.foreignLearnerContext();
  const env = parseEnvelope({
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-neg-cross-0001',
    idempotencyKey: 'idem-neg-cross-0001',
    kind: 'learning.startAttempt',
    target: { scope: 'LEARNER', learnerId: prepared.learnerId },
    payload: { releaseId: SYNTH_RELEASE_ID },
  });
  await assert.rejects(() => prepared.harness.server.handleCommand(foreignCtx, env), (err: unknown) =>
    rejectedWith(err, 'FORBIDDEN'),
  );
});

test('unknown rendererContractVersion is rejected with UNKNOWN_RENDERER', async () => {
  const prepared = await prepareLearnerAttempt();
  const env = parseEnvelope({
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-neg-renderer-0001',
    idempotencyKey: 'idem-neg-renderer-0001',
    kind: 'learning.commitOperation',
    target: { scope: 'LEARNER', learnerId: prepared.learnerId, attemptId: prepared.attemptId, cycleId: prepared.cycleId },
    binding: { releaseId: SYNTH_RELEASE_ID, questionInstanceId: prepared.questionInstanceId, rendererContractVersion: '99' },
    expectedAttemptVersion: 1,
    payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
  });
  await assert.rejects(() => prepared.harness.server.handleCommand(prepared.learnerCtx, env), (err: unknown) =>
    rejectedWith(err, 'UNKNOWN_RENDERER'),
  );
});

test('stale expectedAttemptVersion is rejected with VERSION_CONFLICT carrying currentVisibleVersion', async () => {
  const prepared = await prepareLearnerAttempt();
  const env = parseEnvelope({
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-neg-version-0001',
    idempotencyKey: 'idem-neg-version-0001',
    kind: 'learning.commitOperation',
    target: { scope: 'LEARNER', learnerId: prepared.learnerId, attemptId: prepared.attemptId, cycleId: prepared.cycleId },
    binding: prepared.binding,
    expectedAttemptVersion: 99,
    payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
  });
  await assert.rejects(
    () => prepared.harness.server.handleCommand(prepared.learnerCtx, env),
    (err: unknown) => {
      const rondoErr = asRondoError(err);
      if (rondoErr === null || rondoErr.code !== 'VERSION_CONFLICT') return false;
      return rondoErr.context?.currentVisibleVersion === 1;
    },
  );
});

test('same idempotency key with a different payload is rejected with IDEMPOTENCY_CONFLICT', async () => {
  const prepared = await prepareLearnerAttempt();
  const baseEnv = {
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-neg-idem-0001',
    idempotencyKey: 'idem-neg-same-key',
    kind: 'learning.commitOperation',
    target: {
      scope: 'LEARNER' as const,
      learnerId: prepared.learnerId,
      attemptId: prepared.attemptId,
      cycleId: prepared.cycleId,
    },
    binding: prepared.binding,
    expectedAttemptVersion: 1,
  };
  const first = await prepared.harness.server.handleCommand(
    prepared.learnerCtx,
    parseEnvelope({ ...baseEnv, payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } } }),
  );
  assert.equal(first.status, 'APPLIED');
  await assert.rejects(
    () =>
      prepared.harness.server.handleCommand(
        prepared.learnerCtx,
        parseEnvelope({ ...baseEnv, payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 50 } } }),
      ),
    (err: unknown) => rejectedWith(err, 'IDEMPOTENCY_CONFLICT'),
  );
});

test('code.* commands return CAPABILITY_UNAVAILABLE in the first batch', async () => {
  const prepared = await prepareLearnerAttempt();
  const env = parseEnvelope({
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-neg-code-0001',
    idempotencyKey: 'idem-neg-code-0001',
    kind: 'code.requestRun',
    target: { scope: 'LEARNER', learnerId: prepared.learnerId },
    payload: { source: '#include <iostream>\nint main() { return 0; }\n', compilerContractId: 'cpp11.v1', taskId: 'task-x' },
  });
  await assert.rejects(() => prepared.harness.server.handleCommand(prepared.learnerCtx, env), (err: unknown) =>
    rejectedWith(err, 'CAPABILITY_UNAVAILABLE'),
  );
});

test('guardian commands are refused for learner-role contexts (FORBIDDEN)', async () => {
  const prepared = await prepareLearnerAttempt();
  const env = parseEnvelope({
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-neg-role-0001',
    idempotencyKey: 'idem-neg-role-0001',
    kind: 'guardian.prepareExport',
    target: { scope: 'FAMILY' },
    payload: { scope: { categories: ['PROCESS'] } },
  });
  await assert.rejects(() => prepared.harness.server.handleCommand(prepared.learnerCtx, env), (err: unknown) =>
    rejectedWith(err, 'FORBIDDEN'),
  );
});
