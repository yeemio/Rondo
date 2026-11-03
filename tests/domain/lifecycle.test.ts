/**
 * Domain tests: attempt/cycle lifecycle, phases, CAS versions, content
 * status machine (RETIRED / REVOKED / CONTENT_BLOCKED), bindings.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createReadyHarness,
  startAttempt,
  SYNTH_RELEASE_ID,
  type EnvelopeInit,
} from '../fixtures/harness';
import { asRondoError } from '../contracts/stub-service';
import { applyReleaseStatusChange } from '../../modules/learning/maintenance';
import type { CommandReceipt } from '../../modules/contracts/public/receipts';

async function rejected(harness: Awaited<ReturnType<typeof createReadyHarness>>, init: EnvelopeInit): Promise<string> {
  const receipt = await harness.harness.cmd(init.target.scope === 'FAMILY' ? harness.guardianCtx : harness.learnerCtx, init);
  return receipt.status === 'REJECTED' ? (receipt.errorCode ?? 'REJECTED') : 'APPLIED';
}

test('full cycle flow walks PREDICT..REVIEW with monotonic attempt versions', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    let version = 1;
    const expectVersion = (receipt: CommandReceipt) => {
      version += 1;
      assert.equal(receipt.attemptVersion, version);
    };

    const pred = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 't-pred',
      payload: { prediction: { claims: [{ propertyId: 'radius', direction: 'INCREASE' }] }, uncertain: false },
      target,
    });
    expectVersion(pred);
    const op = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 't-op',
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
      target,
      expectedAttemptVersion: pred.attemptVersion,
    });
    expectVersion(op);
    const sub = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 't-sub',
      payload: { response: [{ kind: 'propertyJudgments', claims: [
        { propertyId: 'radius', direction: 'INCREASE' },
        { propertyId: 'diameter', direction: 'INCREASE' },
        { propertyId: 'height', direction: 'UNCHANGED' },
      ] }] },
      target,
      expectedAttemptVersion: op.attemptVersion,
    });
    expectVersion(sub);
    const bex = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.beginExplanation',
      idempotencyKey: 't-bex',
      payload: {},
      target,
      expectedAttemptVersion: sub.attemptVersion,
    });
    expectVersion(bex);
    const sex = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.saveExplanation',
      idempotencyKey: 't-sex',
      payload: { selections: [], freeText: '半径变大直径也变大', transcribedByGuardian: false },
      target,
      expectedAttemptVersion: bex.attemptVersion,
    });
    expectVersion(sex);
    const fin = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.finishAttempt',
      idempotencyKey: 't-fin',
      payload: {},
      target,
      expectedAttemptVersion: sex.attemptVersion,
    });
    expectVersion(fin);

    const view = await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId: att.attemptId });
    assert.ok(view.kind === 'learning.attemptView');
    assert.equal(view.attemptStatus, 'COMPLETED');
    assert.equal(view.version, version);
    assert.equal(view.currentCycle?.phase, 'REVIEW');
    // First prediction is preserved verbatim.
    const predictionRow = h.harness.storage.rawDatabase().prepare('SELECT contentJson FROM prediction').get() as { contentJson: string };
    assert.deepEqual(JSON.parse(predictionRow.contentJson), { claims: [{ propertyId: 'radius', direction: 'INCREASE' }] });
  } finally {
    await h.harness.closeAll();
  }
});

test('phase violations are rejected; first prediction cannot be overwritten', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    // commitOperation in PREDICT
    assert.equal(
      await rejected(h, {
        kind: 'learning.commitOperation',
        idempotencyKey: 'p-op',
        payload: { operation: { type: 'SetSection', section: 'AXIAL' } },
        target,
        expectedAttemptVersion: 1,
      }),
      'INVALID_OPERATION',
    );
    // submitResponse in PREDICT
    assert.equal(
      await rejected(h, {
        kind: 'learning.submitResponse',
        idempotencyKey: 'p-sub',
        payload: { response: [{ kind: 'propertyJudgments', claims: [{ propertyId: 'radius', direction: 'UNCHANGED' }] }] },
        target,
        expectedAttemptVersion: 1,
      }),
      'INVALID_OPERATION',
    );
    // beginExplanation without a submission
    assert.equal(
      await rejected(h, {
        kind: 'learning.beginExplanation',
        idempotencyKey: 'p-bex',
        payload: {},
        target,
        expectedAttemptVersion: 1,
      }),
      'INVALID_OPERATION',
    );
    // record prediction, then attempt to record again with a NEW key
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'p-pred-1',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    const second = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'p-pred-2',
      payload: { prediction: { claims: [{ propertyId: 'radius', direction: 'DECREASE' }] }, uncertain: false },
      target,
    });
    assert.equal(second.status, 'REJECTED');
    assert.equal(second.errorCode, 'INVALID_OPERATION');
    const count = h.harness.storage.rawDatabase().prepare('SELECT COUNT(*) c FROM prediction').get() as { c: number };
    assert.equal(count.c, 1);
  } finally {
    await h.harness.closeAll();
  }
});

test('stale expectedAttemptVersion returns VERSION_CONFLICT with the visible version', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'v-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    }); // version 2 now
    await assert.rejects(
      () =>
        h.harness.cmd(h.learnerCtx, {
          kind: 'learning.commitOperation',
          idempotencyKey: 'v-op-stale',
          payload: { operation: { type: 'SetSection', section: 'AXIAL' } },
          target,
          expectedAttemptVersion: 1, // stale
        }),
      (err: unknown) => {
        const rondo = asRondoError(err);
        return rondo?.code === 'VERSION_CONFLICT' && rondo.context?.currentVisibleVersion === 2;
      },
    );
  } finally {
    await h.harness.closeAll();
  }
});

test('revise loop: wrong answer -> REVISE -> reviseResponse -> OPERATE -> corrected resubmission', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'r-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'r-op',
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
      target,
      expectedAttemptVersion: 2,
    });
    const wrong = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'r-sub-wrong',
      payload: { response: [{ kind: 'propertyJudgments', claims: [
        { propertyId: 'radius', direction: 'INCREASE' },
        { propertyId: 'diameter', direction: 'UNCHANGED' },
        { propertyId: 'height', direction: 'UNCHANGED' },
      ] }] },
      target,
      expectedAttemptVersion: 3,
    });
    assert.equal(wrong.status, 'APPLIED');
    const wrongEval = h.harness.storage.rawDatabase().prepare('SELECT outcome FROM evaluation ORDER BY at ASC').get() as { outcome: string };
    assert.equal(wrongEval.outcome, 'REVISE');
    const revise = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.reviseResponse',
      idempotencyKey: 'r-revise',
      payload: {},
      target,
      expectedAttemptVersion: wrong.attemptVersion!,
    });
    assert.equal(revise.status, 'APPLIED');
    const corrected = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'r-sub-right',
      payload: { response: [{ kind: 'propertyJudgments', claims: [
        { propertyId: 'radius', direction: 'INCREASE' },
        { propertyId: 'diameter', direction: 'INCREASE' },
        { propertyId: 'height', direction: 'UNCHANGED' },
      ] }] },
      target,
      expectedAttemptVersion: revise.attemptVersion!,
    });
    assert.equal(corrected.status, 'APPLIED');
    const subs = h.harness.storage.rawDatabase().prepare('SELECT COUNT(*) c FROM submission').get() as { c: number };
    assert.equal(subs.c, 2);
    const chain = h.harness.storage.rawDatabase().prepare('SELECT priorSubmissionId FROM submission ORDER BY at ASC').all() as {
      priorSubmissionId: string | null;
    }[];
    assert.equal(chain[0].priorSubmissionId, null);
    assert.notEqual(chain[0].priorSubmissionId, chain[1].priorSubmissionId); // second references the first
  } finally {
    await h.harness.closeAll();
  }
});

test('RETIRED: no new attempts, existing attempts resumable; REVOKED: CONTENT_BLOCKED + rejection, history kept', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    // Pause, retire the release.
    const pause = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.pauseAttempt',
      idempotencyKey: 's-pause',
      payload: {},
      target,
      expectedAttemptVersion: 1,
    });
    assert.equal(pause.status, 'APPLIED');
    await applyReleaseStatusChange(h.harness.storage, () => h.harness.clock.now(), { releaseId: SYNTH_RELEASE_ID, to: 'RETIRED', reason: 'synth retire' });
    // New attempt on a RETIRED release is blocked.
    const blocked = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.startAttempt',
      idempotencyKey: 's-start-2',
      payload: { releaseId: SYNTH_RELEASE_ID },
      target: { scope: 'LEARNER', learnerId: h.learnerId },
    });
    assert.equal(blocked.status, 'REJECTED');
    assert.equal(blocked.errorCode, 'CONTENT_UNAVAILABLE');
    // The existing attempt still resumes (full old binding).
    const resume = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.resumeAttempt',
      idempotencyKey: 's-resume',
      payload: {},
      target,
      expectedAttemptVersion: pause.attemptVersion!,
    });
    assert.equal(resume.status, 'APPLIED');

    // Now revoke: the attempt becomes CONTENT_BLOCKED and further judging stops.
    await applyReleaseStatusChange(h.harness.storage, () => h.harness.clock.now(), { releaseId: SYNTH_RELEASE_ID, to: 'REVOKED', reason: 'synth revoke' });
    const view = await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId: att.attemptId });
    assert.ok(view.kind === 'learning.attemptView');
    assert.equal(view.attemptStatus, 'CONTENT_BLOCKED');
    const after = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 's-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    assert.equal(after.status, 'REJECTED');
    assert.equal(after.errorCode, 'CONTENT_REVOKED');
    const restart = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.startAttempt',
      idempotencyKey: 's-start-3',
      payload: { releaseId: SYNTH_RELEASE_ID },
      target: { scope: 'LEARNER', learnerId: h.learnerId },
    });
    assert.equal(restart.status, 'REJECTED');
    assert.equal(restart.errorCode, 'CONTENT_REVOKED');
    // History (events) stays queryable.
    const timeline = await h.harness.server.query(h.learnerCtx, { kind: 'learning.timeline', attemptId: att.attemptId });
    assert.ok(timeline.kind === 'learning.timeline');
    assert.ok(timeline.events.length >= 2);
  } finally {
    await h.harness.closeAll();
  }
});

test('binding checks: unknown renderer version and mismatched instance are rejected', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    const badRenderer = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'b-op-1',
      payload: { operation: { type: 'SetSection', section: 'AXIAL' } },
      target,
      expectedAttemptVersion: 1,
      binding: { releaseId: SYNTH_RELEASE_ID, questionInstanceId: att.questionInstanceId, rendererContractVersion: '9' },
    });
    assert.equal(badRenderer.status, 'REJECTED');
    assert.equal(badRenderer.errorCode, 'UNKNOWN_RENDERER');
    const badInstance = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'b-op-2',
      payload: { operation: { type: 'SetSection', section: 'AXIAL' } },
      target,
      expectedAttemptVersion: 1,
      binding: { releaseId: SYNTH_RELEASE_ID, questionInstanceId: 'qi-not-the-one', rendererContractVersion: '1' },
    });
    assert.equal(badInstance.status, 'REJECTED');
    assert.equal(badInstance.errorCode, 'INVALID_OPERATION');
  } finally {
    await h.harness.closeAll();
  }
});

test('code.* commands return CAPABILITY_UNAVAILABLE receipts', async () => {
  const h = await createReadyHarness();
  try {
    const receipt = await h.harness.cmd(h.learnerCtx, {
      kind: 'code.requestRun',
      idempotencyKey: 'code-1',
      payload: { source: 'int main() { return 0; }', compilerContractId: 'cpp.1', taskId: 'task-l1-guided' },
      target: { scope: 'LEARNER', learnerId: h.learnerId },
    });
    assert.equal(receipt.status, 'REJECTED');
    assert.equal(receipt.errorCode, 'CAPABILITY_UNAVAILABLE');
  } finally {
    await h.harness.closeAll();
  }
});

test('endWithoutCompleting abandons; a fresh attempt may then start', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const end = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.endWithoutCompleting',
      idempotencyKey: 'e-end',
      payload: { confirmAbandon: true },
      target: { scope: 'LEARNER', learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId },
    });
    assert.equal(end.status, 'APPLIED');
    const view = await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId: att.attemptId });
    assert.ok(view.kind === 'learning.attemptView');
    assert.equal(view.attemptStatus, 'ABANDONED');
    const again = await startAttempt(h.harness, h.learnerCtx, h.learnerId, 'e-start-2');
    assert.ok(again.attemptId !== att.attemptId);
  } finally {
    await h.harness.closeAll();
  }
});

test('beginCycle follows the registered course graph and requires REVIEW', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    // Not REVIEW yet.
    assert.equal(
      await rejected(h, {
        kind: 'learning.beginCycle',
        idempotencyKey: 'g-early',
        payload: { taskId: 'task-l1-independent' },
        target,
        expectedAttemptVersion: 1,
      }),
      'INVALID_OPERATION',
    );
    // Complete the first cycle minimally.
    const pred = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'g-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    const op = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'g-op',
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
      target,
      expectedAttemptVersion: pred.attemptVersion!,
    });
    const sub = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'g-sub',
      payload: { response: [{ kind: 'propertyJudgments', claims: [
        { propertyId: 'radius', direction: 'INCREASE' },
        { propertyId: 'diameter', direction: 'INCREASE' },
        { propertyId: 'height', direction: 'UNCHANGED' },
      ] }] },
      target,
      expectedAttemptVersion: op.attemptVersion!,
    });
    const bex = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.beginExplanation',
      idempotencyKey: 'g-bex',
      payload: {},
      target,
      expectedAttemptVersion: sub.attemptVersion!,
    });
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.saveExplanation',
      idempotencyKey: 'g-sex',
      payload: { selections: [], freeText: '因为半径变了', transcribedByGuardian: false },
      target,
      expectedAttemptVersion: bex.attemptVersion!,
    });
    // Graph jump ahead (l2-guided) is rejected; the registered next task works.
    assert.equal(
      await rejected(h, {
        kind: 'learning.beginCycle',
        idempotencyKey: 'g-jump',
        payload: { taskId: 'task-l2-guided' },
        target,
        expectedAttemptVersion: bex.attemptVersion! + 1,
      }),
      'INVALID_OPERATION',
    );
    const next = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.beginCycle',
      idempotencyKey: 'g-next',
      payload: { taskId: 'task-l1-independent' },
      target,
      expectedAttemptVersion: bex.attemptVersion! + 1,
    });
    assert.equal(next.status, 'APPLIED');
    const view = await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId: att.attemptId });
    assert.ok(view.kind === 'learning.attemptView');
    assert.equal(view.currentCycle?.phase, 'PREDICT');
    // New cycle has its own instance and a fresh first prediction slot.
    const predictions = h.harness.storage.rawDatabase().prepare('SELECT COUNT(*) c FROM prediction').get() as { c: number };
    assert.equal(predictions.c, 1);
  } finally {
    await h.harness.closeAll();
  }
});

test('stale beginCycle rejects with VERSION_CONFLICT carrying the visible version and leaves the attempt untouched', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'bc-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    }); // version 2 now
    await assert.rejects(
      () =>
        h.harness.cmd(h.learnerCtx, {
          kind: 'learning.beginCycle',
          idempotencyKey: 'bc-stale',
          payload: { taskId: 'task-l1-independent' },
          target,
          expectedAttemptVersion: 1, // stale
        }),
      (err: unknown) => {
        const rondo = asRondoError(err);
        return rondo?.code === 'VERSION_CONFLICT' && rondo.context?.currentVisibleVersion === 2;
      },
    );
    // The attempt keeps its version and no cycle row was inserted.
    const view = await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId: att.attemptId });
    assert.ok(view.kind === 'learning.attemptView');
    assert.equal(view.version, 2);
    const cycles = h.harness.storage.rawDatabase().prepare('SELECT COUNT(*) c FROM learningCycle').get() as { c: number };
    assert.equal(cycles.c, 1);
  } finally {
    await h.harness.closeAll();
  }
});

test('startAttempt chains to the most recent terminal attempt via previousAttemptId', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    // Walk the full cycle to REVIEW, then finish (COMPLETED), version 1..7.
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'c-pred',
      payload: { prediction: { claims: [{ propertyId: 'radius', direction: 'INCREASE' }] }, uncertain: false },
      target,
    });
    const op = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'c-op',
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
      target,
      expectedAttemptVersion: 2,
    });
    const sub = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'c-sub',
      payload: { response: [{ kind: 'propertyJudgments', claims: [
        { propertyId: 'radius', direction: 'INCREASE' },
        { propertyId: 'diameter', direction: 'INCREASE' },
        { propertyId: 'height', direction: 'UNCHANGED' },
      ] }] },
      target,
      expectedAttemptVersion: op.attemptVersion!,
    });
    const bex = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.beginExplanation',
      idempotencyKey: 'c-bex',
      payload: {},
      target,
      expectedAttemptVersion: sub.attemptVersion!,
    });
    const sex = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.saveExplanation',
      idempotencyKey: 'c-sex',
      payload: { selections: [], freeText: '半径变大直径也变大', transcribedByGuardian: false },
      target,
      expectedAttemptVersion: bex.attemptVersion!,
    });
    const fin = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.finishAttempt',
      idempotencyKey: 'c-fin',
      payload: {},
      target,
      expectedAttemptVersion: sex.attemptVersion!,
    });
    assert.equal(fin.status, 'APPLIED');
    const attemptRow = (id: string) =>
      h.harness.storage
        .rawDatabase()
        .prepare('SELECT attemptId, previousAttemptId, attemptStatus, version, endedAt, resultSummaryJson FROM learningAttempt WHERE attemptId = ?')
        .get(id) as {
        attemptId: string;
        previousAttemptId: string | null;
        attemptStatus: string;
        version: number;
        endedAt: number | null;
        resultSummaryJson: string | null;
      };
    const finished = attemptRow(att.attemptId);
    assert.equal(finished.attemptStatus, 'COMPLETED');
    assert.equal(finished.previousAttemptId, null); // first-ever attempt has no predecessor
    // A fresh attempt chains to the just-completed one.
    const again = await startAttempt(h.harness, h.learnerCtx, h.learnerId, 'c-start-2');
    const successor = attemptRow(again.attemptId);
    assert.equal(successor.previousAttemptId, att.attemptId);
    assert.equal(successor.attemptStatus, 'ACTIVE');
    assert.equal(successor.version, 1);
    // The completed attempt's terminal state and data are untouched.
    assert.deepEqual(attemptRow(att.attemptId), finished);
  } finally {
    await h.harness.closeAll();
  }
});
