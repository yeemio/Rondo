/**
 * Domain tests: guardianship governance -- retention two-step, export
 * prepare/confirm, deletion prepare/confirm with scope binding, rolling
 * retention sweep.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createReadyHarness, startAttempt, GUARDIAN_PASSPHRASE } from '../fixtures/harness';
import { asRondoError } from '../contracts/stub-service';
import {
  finishExport,
  buildExportPayload,
  applyRollingRetention,
} from '../../modules/learning/maintenance';

function guardianScope(familyId: string) {
  return { familyId, actorId: 'test-guardian' };
}

test('setRetention requires the exact reviewed preview version', async () => {
  const h = await createReadyHarness();
  try {
    const preview = await h.harness.server.query(h.guardianCtx, {
      kind: 'guardian.retentionPreview',
      mode: 'ROLLING_DAYS',
      rollingDays: 90,
    });
    assert.ok(preview.kind === 'guardian.retentionPreview');
    // Wrong confirmedPreviewVersion -> stable rejection.
    const wrong = await h.harness.cmd(h.guardianCtx, {
      kind: 'family.setRetention',
      idempotencyKey: 'ret-wrong',
      payload: { mode: 'ROLLING_DAYS', rollingDays: 90, confirmedPreviewVersion: 'not-the-version' },
      target: { scope: 'FAMILY' },
    });
    assert.equal(wrong.status, 'REJECTED');
    assert.equal(wrong.errorCode, 'INVALID_OPERATION');
    const version = preview.previewVersion;
    const right = await h.harness.cmd(h.guardianCtx, {
      kind: 'family.setRetention',
      idempotencyKey: 'ret-right',
      payload: { mode: 'ROLLING_DAYS', rollingDays: 90, confirmedPreviewVersion: version },
      target: { scope: 'FAMILY' },
    });
    assert.equal(right.status, 'APPLIED');
    const policy = h.harness.storage.rawDatabase().prepare('SELECT mode, rollingDays FROM retentionPolicy').get() as {
      mode: string;
      rollingDays: number;
    };
    assert.equal(policy.mode, 'ROLLING_DAYS');
    assert.equal(policy.rollingDays, 90);
  } finally {
    await h.harness.closeAll();
  }
});

test('retention preview lists only aged-out terminal attempts and warns about active ones', async () => {
  const h = await createReadyHarness();
  try {
    // Attempt 1: complete it and age it out.
    const first = await startAttempt(h.harness, h.learnerCtx, h.learnerId, 'age-1');
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: first.attemptId, cycleId: first.cycleId };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'age-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    const op = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'age-op',
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
      target,
      expectedAttemptVersion: 2,
    });
    const sub = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'age-sub',
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
      idempotencyKey: 'age-bex',
      payload: {},
      target,
      expectedAttemptVersion: sub.attemptVersion!,
    });
    const sex = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.saveExplanation',
      idempotencyKey: 'age-sex',
      payload: { selections: [], freeText: '说完了', transcribedByGuardian: false },
      target,
      expectedAttemptVersion: bex.attemptVersion!,
    });
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.finishAttempt',
      idempotencyKey: 'age-fin',
      payload: {},
      target,
      expectedAttemptVersion: sex.attemptVersion!,
    });
    // Age the clock 100 days; the window is 90.
    h.harness.clock.advance(100 * 24 * 60 * 60 * 1000);
    const preview = await h.harness.server.query(h.guardianCtx, {
      kind: 'guardian.retentionPreview',
      mode: 'ROLLING_DAYS',
      rollingDays: 90,
    });
    assert.ok(preview.kind === 'guardian.retentionPreview');
    assert.deepEqual(preview.affectedAttemptIds, [first.attemptId]);
    // A second, ACTIVE attempt is never listed, only warned about.
    await startAttempt(h.harness, h.learnerCtx, h.learnerId, 'age-2');
    const preview2 = await h.harness.server.query(h.guardianCtx, {
      kind: 'guardian.retentionPreview',
      mode: 'ROLLING_DAYS',
      rollingDays: 90,
    });
    assert.ok(preview2.kind === 'guardian.retentionPreview');
    assert.deepEqual(preview2.affectedAttemptIds, [first.attemptId]);
    assert.ok(preview2.warnings.some((w) => w.includes('进行中')));

    // Sweep: recorded policy + old attempt -> deleted with a counts-only tombstone.
    const version = preview2.previewVersion;
    await h.harness.cmd(h.guardianCtx, {
      kind: 'family.setRetention',
      idempotencyKey: 'age-ret',
      payload: { mode: 'ROLLING_DAYS', rollingDays: 90, confirmedPreviewVersion: version },
      target: { scope: 'FAMILY' },
    });
    const sweep = await applyRollingRetention(h.harness.storage, {
      asOf: h.harness.clock.now(),
      newOpId: () => `op-sweep-${Math.random().toString(36).slice(2, 8)}`,
    });
    assert.deepEqual(sweep.deletedAttempts, [first.attemptId]);
    const gone = h.harness.storage.rawDatabase()
      .prepare("SELECT COUNT(*) c FROM learningAttempt WHERE attemptId = ?")
      .get(first.attemptId) as { c: number };
    assert.equal(gone.c, 0);
    const tombstone = h.harness.storage.rawDatabase()
      .prepare("SELECT resultJson FROM dataOperation WHERE scopeJson LIKE '%retentionSweep%'")
      .get() as { resultJson: string };
    assert.ok(!tombstone.resultJson.includes('小测'), 'tombstone must not contain child text');
  } finally {
    await h.harness.closeAll();
  }
});

test('export: prepare -> confirm -> finish with payload assembly, no credentials', async () => {
  const h = await createReadyHarness();
  try {
    await startAttempt(h.harness, h.learnerCtx, h.learnerId, 'ex-1');
    const prepare = await h.harness.cmd(h.guardianCtx, {
      kind: 'guardian.prepareExport',
      idempotencyKey: 'ex-prep',
      payload: { scope: { categories: ['ALIASES', 'CONTENT_VERSIONS', 'PROCESS', 'SUBMISSIONS', 'FEEDBACK', 'EXPLANATIONS', 'GUARDIAN_ANNOTATIONS'] } },
      target: { scope: 'FAMILY' },
    });
    assert.equal(prepare.status, 'APPLIED');
    const opId = prepare.effectRefs.find((r) => r.startsWith('export:'))!.slice('export:'.length);
    const status1 = await h.harness.server.query(h.guardianCtx, { kind: 'guardian.exportStatus', exportId: opId });
    assert.ok(status1.kind === 'guardian.exportStatus');
    assert.equal(status1.phase, 'PREPARED');
    assert.ok((status1.scopeHash ?? '').length >= 16);
    // Confirming an unknown preparedVersion is rejected.
    const bad = await h.harness.cmd(h.guardianCtx, {
      kind: 'guardian.confirmExport',
      idempotencyKey: 'ex-conf-bad',
      payload: { preparedVersion: 'op-not-existing' },
      target: { scope: 'FAMILY' },
    });
    assert.equal(bad.status, 'REJECTED');
    const confirm = await h.harness.cmd(h.guardianCtx, {
      kind: 'guardian.confirmExport',
      idempotencyKey: 'ex-conf',
      payload: { preparedVersion: opId },
      target: { scope: 'FAMILY' },
    });
    assert.equal(confirm.status, 'APPLIED');
    const status2 = await h.harness.server.query(h.guardianCtx, { kind: 'guardian.exportStatus', exportId: opId });
    assert.ok(status2.kind === 'guardian.exportStatus');
    assert.equal(status2.phase, 'CONFIRMED');
    // Host-side completion after the (stubbed) desktop save dialog.
    await finishExport(h.harness.storage, guardianScope(h.harness.familyId), { opId, outcome: 'COMPLETED', savedToLabel: 'rondo-export.json' });
    const status3 = await h.harness.server.query(h.guardianCtx, { kind: 'guardian.exportStatus', exportId: opId });
    assert.ok(status3.kind === 'guardian.exportStatus');
    assert.equal(status3.phase, 'COMPLETED');
    // Payload assembly: process events present; no credential material anywhere.
    const payload = await buildExportPayload(h.harness.storage, guardianScope(h.harness.familyId), opId, () => h.harness.clock.now(), h.harness.content);
    const serialized = JSON.stringify(payload);
    assert.ok((payload.categories.PROCESS as unknown[]).length >= 1);
    assert.ok(!serialized.includes('derivedKey'));
    assert.ok(!serialized.includes('salt'));
    assert.ok(!serialized.includes('ruleSet'));
  } finally {
    await h.harness.closeAll();
  }
});

test('deletion: two-phase with scope-hash binding; learner scope removes only that learner', async () => {
  const h = await createReadyHarness();
  try {
    // Second learner with its own attempt.
    const learner2 = await h.harness.createLearner(h.guardianCtx, '小贝', 'create-小贝');
    await h.harness.auth.unlockGuardian({ passphrase: GUARDIAN_PASSPHRASE }); // guardian session for enterLearner
    const l2ctx = await h.harness.enterLearner(learner2);
    await startAttempt(h.harness, l2ctx, learner2, 'del-2');
    await startAttempt(h.harness, h.learnerCtx, h.learnerId, 'del-1');

    const prepare = await h.harness.cmd(h.guardianCtx, {
      kind: 'guardian.prepareDeletion',
      idempotencyKey: 'del-prep',
      payload: { target: 'LEARNER', targetId: learner2 },
      target: { scope: 'FAMILY' },
    });
    assert.equal(prepare.status, 'APPLIED');
    const opId = prepare.effectRefs.find((r) => r.startsWith('disposal:'))!.slice('disposal:'.length);
    const status = await h.harness.server.query(h.guardianCtx, { kind: 'guardian.exportStatus', exportId: opId });
    assert.ok(status.kind === 'guardian.exportStatus');
    assert.equal(status.phase, 'PREPARED');
    const preparedScopeHash = status.scopeHash!;
    // Wrong scopeListHash rejected.
    const wrong = await h.harness.cmd(h.guardianCtx, {
      kind: 'guardian.confirmDeletion',
      idempotencyKey: 'del-conf-wrong',
      payload: { preparedDeletionId: opId, scopeListHash: '0'.repeat(64) },
      target: { scope: 'FAMILY' },
    });
    assert.equal(wrong.status, 'REJECTED');
    assert.equal(wrong.errorCode, 'INVALID_OPERATION');
    // Correct hash from the prepared op.
    const confirm = await h.harness.cmd(h.guardianCtx, {
      kind: 'guardian.confirmDeletion',
      idempotencyKey: 'del-conf',
      payload: { preparedDeletionId: opId, scopeListHash: preparedScopeHash },
      target: { scope: 'FAMILY' },
    });
    assert.equal(confirm.status, 'APPLIED');
    // The learner and its subtree are gone; the other learner remains.
    const learnerRows = h.harness.storage.rawDatabase().prepare('SELECT learnerId FROM learner ORDER BY learnerId').all() as {
      learnerId: string;
    }[];
    assert.deepEqual(learnerRows.map((r) => r.learnerId), [h.learnerId]);
    const attempts = h.harness.storage.rawDatabase().prepare('SELECT COUNT(*) c FROM learningAttempt').get() as { c: number };
    assert.equal(attempts.c, 1);
    // Tombstone: completed, counts only, no child alias text.
    const tomb = h.harness.storage.rawDatabase()
      .prepare('SELECT phase, resultJson FROM dataOperation WHERE opId = ?')
      .get(opId) as { phase: string; resultJson: string };
    assert.equal(tomb.phase, 'COMPLETED');
    assert.ok(!tomb.resultJson.includes('小贝'));
    // The surviving learner still queries its own attempt.
    const view = await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId: (await h.harness.storage.read(async (repos) => (await repos.learningAttempt.listByLearner({ familyId: h.harness.familyId, actorId: 'x' }, h.learnerId))[0].attemptId)) });
    assert.ok(view.kind === 'learning.attemptView');
  } finally {
    await h.harness.closeAll();
  }
});

test('recordAssistance rejects foreign attempts; annotations attach to visible revisions only', async () => {
  const h = await createReadyHarness();
  try {
    const foreign = await h.harness.cmd(h.guardianCtx, {
      kind: 'guardian.recordAssistance',
      idempotencyKey: 'as-foreign',
      payload: { attemptId: 'att-not-in-this-db', category: 'RESTATE', note: 'x' },
      target: { scope: 'FAMILY' },
    });
    assert.equal(foreign.status, 'REJECTED');
    assert.equal(foreign.errorCode, 'INVALID_OPERATION');
    const annotate = await h.harness.cmd(h.guardianCtx, {
      kind: 'guardian.annotateExplanation',
      idempotencyKey: 'as-unknown',
      payload: { explanationRevisionRef: 'rev-does-not-exist', rubric: { condition: 'NOT_OBSERVED', relation: 'NOT_OBSERVED', basis: 'NOT_OBSERVED' } },
      target: { scope: 'FAMILY' },
    });
    assert.equal(annotate.status, 'REJECTED');
    void asRondoError;
  } finally {
    await h.harness.closeAll();
  }
});
