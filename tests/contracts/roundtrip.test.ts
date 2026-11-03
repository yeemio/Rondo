/**
 * Positive synthetic roundtrip (H0-SPEC §4):
 * synthetic family setup (auth stub) -> family.createLearner -> enterLearner
 * -> learning.startAttempt -> learning.recordPrediction ->
 * learning.commitOperation(SetDimension) -> learning.submitResponse ->
 * receipt lookup with the ORIGINAL key -> attemptView / questionView /
 * timeline / resumePoint projections; plus idempotent replay and close
 * semantics at the type level (LearningServer port).
 *
 * Every envelope and every projection passes runtime schema validation.
 * The stub never judges; no real learning facts are produced.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseEnvelope } from '../../modules/contracts/public/envelope';
import type { PublicCommandEnvelope } from '../../modules/contracts/public/envelope';
import { parseCommandReceipt } from '../../modules/contracts/public/receipts';
import type { CommandReceipt, ReceiptLookup } from '../../modules/contracts/public/receipts';
import { parsePublicQuestionSpec } from '../../modules/contracts/public/question';
import type { PublicProjection } from '../../modules/contracts/public/queries';
import type { ServerContext } from '../../modules/contracts/server/context';
import { createStubHarness, asRondoError } from './stub-service';
import {
  SYNTH_COMMITTED_RADIUS_MM,
  SYNTH_PROTOCOL_VERSION,
  SYNTH_RELEASE_ID,
  SYNTH_RENDERER_CONTRACT_VERSION,
} from './synthetic';

function effectRef(receipt: CommandReceipt, type: string): string {
  const found = receipt.effectRefs.find((ref) => ref.startsWith(`${type}:`));
  assert.ok(found, `receipt must carry effectRef "${type}:..." (got ${JSON.stringify(receipt.effectRefs)})`);
  return found.slice(type.length + 1);
}

function asProjection<K extends PublicProjection['kind']>(
  projection: PublicProjection,
  kind: K,
): Extract<PublicProjection, { kind: K }> {
  if (projection.kind !== kind) {
    throw new Error(`expected projection kind ${kind}, got ${String(projection.kind)}`);
  }
  return projection as Extract<PublicProjection, { kind: K }>;
}

test('synthetic roundtrip: setup -> startAttempt -> recordPrediction -> commitOperation -> submitResponse -> receipt -> projections', async () => {
  const h = createStubHarness();

  // 1. Synthetic family setup via the auth stub.
  const setup = await h.auth.setupGuardian({
    idempotencyKey: 'auth-setup-0001',
    familyDisplayName: 'Rondo 合成家庭',
    guardianDisplayName: 'Guardian',
    passphrase: 'stub-passphrase-0001',
  });
  assert.equal(setup.role, 'GUARDIAN');
  assert.ok(setup.familyId.length > 0);

  const guardianCtx: ServerContext = h.guardianContext();

  // 2. Create a learner through the command port (guardian role).
  const createLearnerEnv = parseEnvelope({
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-synth-0001',
    idempotencyKey: 'idem-create-learner-0001',
    kind: 'family.createLearner',
    target: { scope: 'FAMILY' },
    payload: { alias: 'Mio', goal: '理解圆柱参数' },
  });
  const createLearnerReceipt = parseCommandReceipt(await h.server.handleCommand(guardianCtx, createLearnerEnv));
  assert.equal(createLearnerReceipt.status, 'APPLIED');
  assert.equal(createLearnerReceipt.kind, 'family.createLearner');
  const learnerId = effectRef(createLearnerReceipt, 'learner');

  // 3. Enter the learner session (guardian session required by the port).
  const learnerSession = await h.auth.enterLearner({ learnerId });
  assert.equal(learnerSession.role, 'LEARNER');
  assert.equal(learnerSession.learnerId, learnerId);
  const learnerCtx: ServerContext = h.learnerContext(learnerId);

  // 4. startAttempt: no binding yet (questionInstanceId does not exist).
  const startEnv = parseEnvelope({
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-synth-0002',
    idempotencyKey: 'idem-start-attempt-0001',
    kind: 'learning.startAttempt',
    target: { scope: 'LEARNER', learnerId },
    payload: { releaseId: SYNTH_RELEASE_ID },
  });
  const startReceipt = parseCommandReceipt(await h.server.handleCommand(learnerCtx, startEnv));
  assert.equal(startReceipt.status, 'APPLIED');
  assert.equal(startReceipt.attemptVersion, 1);
  const attemptId = effectRef(startReceipt, 'attempt');
  const cycleId = effectRef(startReceipt, 'cycle');
  const questionInstanceId = effectRef(startReceipt, 'questionInstance');

  // Binding is all-or-nothing: full triple from now on.
  const binding = {
    releaseId: SYNTH_RELEASE_ID,
    questionInstanceId,
    rendererContractVersion: SYNTH_RENDERER_CONTRACT_VERSION,
  };

  // 5. recordPrediction: first prediction moves PREDICT -> OPERATE.
  const predictEnv = parseEnvelope({
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-synth-0003',
    idempotencyKey: 'idem-record-prediction-0001',
    kind: 'learning.recordPrediction',
    target: { scope: 'LEARNER', learnerId, attemptId, cycleId },
    binding,
    payload: {
      prediction: { claims: [{ propertyId: 'diameter', direction: 'INCREASE' }] },
      uncertain: false,
    },
  });
  const predictReceipt = parseCommandReceipt(await h.server.handleCommand(learnerCtx, predictEnv));
  assert.equal(predictReceipt.status, 'APPLIED');
  effectRef(predictReceipt, 'event');

  // 6. commitOperation(SetDimension RADIUS): expectedAttemptVersion = 1 (CAS point).
  const operationEnv = parseEnvelope({
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-synth-0004',
    idempotencyKey: 'idem-commit-operation-0001',
    kind: 'learning.commitOperation',
    target: { scope: 'LEARNER', learnerId, attemptId, cycleId },
    binding,
    expectedAttemptVersion: 1,
    payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: SYNTH_COMMITTED_RADIUS_MM } },
  });
  const operationReceipt = parseCommandReceipt(await h.server.handleCommand(learnerCtx, operationEnv));
  assert.equal(operationReceipt.status, 'APPLIED');
  assert.equal(operationReceipt.attemptVersion, 2);

  // 7. submitResponse: structured response, expectedAttemptVersion = 2.
  const submitEnv: PublicCommandEnvelope = parseEnvelope({
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-synth-0005',
    idempotencyKey: 'idem-submit-response-0001',
    kind: 'learning.submitResponse',
    target: { scope: 'LEARNER', learnerId, attemptId, cycleId },
    binding,
    expectedAttemptVersion: 2,
    payload: {
      response: [
        {
          kind: 'propertyJudgments',
          claims: [
            { propertyId: 'radius', direction: 'INCREASE' },
            { propertyId: 'height', direction: 'UNCHANGED' },
          ],
        },
      ],
    },
  });
  const submitReceipt = parseCommandReceipt(await h.server.handleCommand(learnerCtx, submitEnv));
  assert.equal(submitReceipt.status, 'APPLIED');
  assert.equal(submitReceipt.attemptVersion, 3);
  const submissionId = effectRef(submitReceipt, 'submission');
  assert.ok(submissionId.length > 0);
  // Receipt carries identity + status + version + changedKinds + effectRefs; no business result.
  assert.deepEqual(Object.keys(submitReceipt).sort(), [
    'attemptVersion',
    'changedKinds',
    'commandId',
    'effectRefs',
    'idempotencyKey',
    'kind',
    'protocolVersion',
    'status',
  ]);

  // 8. Receipt lookup with the ORIGINAL key (never a new key).
  const lookup: ReceiptLookup = await h.server.lookupReceipt(learnerCtx, {
    idempotencyKey: 'idem-submit-response-0001',
    commandKind: 'learning.submitResponse',
  });
  assert.equal(lookup.status, 'CONFIRMED');
  assert.deepEqual(lookup.status === 'CONFIRMED' ? lookup.receipt : null, submitReceipt);

  // 9. Idempotent replay at the type level: same envelope, same key, same
  // canonical hash -> the original receipt shape, byte-for-byte equal.
  const replayReceipt: CommandReceipt = await h.server.handleCommand(learnerCtx, submitEnv);
  assert.deepEqual(replayReceipt, submitReceipt);

  // 10. attemptView projection.
  const attemptView = asProjection(
    await h.server.query(learnerCtx, { kind: 'learning.attemptView', attemptId }),
    'learning.attemptView',
  );
  assert.equal(attemptView.attemptStatus, 'ACTIVE');
  assert.equal(attemptView.version, 3);
  assert.equal(attemptView.currentCycle?.phase, 'VERIFY');
  assert.equal(attemptView.currentCycle?.questionInstanceId, questionInstanceId);

  // 11. questionView returns a schema-valid PublicQuestionSpec with the
  // current materialVisibility projection (VERIFY -> ASSESSMENT).
  const questionView = asProjection(
    await h.server.query(learnerCtx, { kind: 'learning.questionView', attemptId, cycleId }),
    'learning.questionView',
  );
  const spec = parsePublicQuestionSpec(questionView.spec);
  assert.equal(spec.materialVisibility, 'ASSESSMENT');
  assert.equal((spec.scene.state as { radiusMm: number }).radiusMm, SYNTH_COMMITTED_RADIUS_MM);
  assert.equal(spec.scene.rendererContractVersion, SYNTH_RENDERER_CONTRACT_VERSION);

  // 12. timeline paginates by the (attemptId, seq) cursor.
  const timelinePage1 = asProjection(
    await h.server.query(learnerCtx, { kind: 'learning.timeline', attemptId, limit: 3 }),
    'learning.timeline',
  );
  const seqs = timelinePage1.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(seqs.length, 3);
  const afterSeq = seqs[seqs.length - 1];
  assert.equal(timelinePage1.nextAfterSeq, afterSeq);
  const timelineRest = asProjection(
    await h.server.query(learnerCtx, { kind: 'learning.timeline', attemptId, afterSeq }),
    'learning.timeline',
  );
  for (const e of timelineRest.events) {
    assert.ok(e.seq > afterSeq);
  }
  assert.equal(timelineRest.events.length + seqs.length, 4); // 4 events in this chain
  assert.equal(timelineRest.nextAfterSeq, undefined);

  // 13. resumePoint points at the active attempt; availableLessons lists the synthetic release.
  const resume = asProjection(
    await h.server.query(learnerCtx, { kind: 'learning.resumePoint', learnerId }),
    'learning.resumePoint',
  );
  assert.equal(resume.attempt?.attemptId, attemptId);
  assert.equal(resume.attempt?.phase, 'VERIFY');
  const lessons = asProjection(
    await h.server.query(guardianCtx, { kind: 'catalog.availableLessons' }),
    'catalog.availableLessons',
  );
  assert.ok(lessons.lessons.some((l) => l.releaseId === SYNTH_RELEASE_ID));
});

test('close is idempotent and freezes new commands with HOST_RECOVERING', async () => {
  const h = createStubHarness();
  const guardianCtx = h.guardianContext();
  await h.server.close();
  await h.server.close(); // idempotent
  const env = parseEnvelope({
    protocolVersion: SYNTH_PROTOCOL_VERSION,
    commandId: 'cmd-synth-close-0001',
    idempotencyKey: 'idem-after-close-0001',
    kind: 'family.createLearner',
    target: { scope: 'FAMILY' },
    payload: { alias: 'Nobody' },
  });
  await assert.rejects(
    () => h.server.handleCommand(guardianCtx, env),
    (err: unknown) => {
      const rondoErr = asRondoError(err);
      return rondoErr !== null && rondoErr.code === 'HOST_RECOVERING';
    },
  );
});
