import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadyHarness, startAttempt, GUARDIAN_PASSPHRASE } from '../fixtures/harness';
import type { PublicProjection } from '../../modules/contracts/public/queries';
import { executeDisposal } from '../../adapters/sqlite/disposal';

test('deletion: SQL relationships, surviving successor, other-family subtree and content-free tombstone', async () => {
  const { harness: h, guardianCtx, learnerCtx, learnerId } = await createReadyHarness();
  try {
    const a = await startAttempt(h, learnerCtx, learnerId); const db = h.storage.rawDatabase(); const at = h.clock.now();
    db.prepare("INSERT INTO prediction VALUES (?, '{}', 1, 'synthetic original child text', ?)").run(a.cycleId, at);
    db.prepare("INSERT INTO hintPresentation VALUES ('hint-a', ?, 1, 'v1', 'receipt-a', ?)").run(a.cycleId, at);
    db.prepare("INSERT INTO submission VALUES ('sub-a', ?, '{}', 1, '[]', '{}', NULL, ?, ?)").run(a.cycleId, learnerCtx.actorId, at);
    db.prepare("INSERT INTO submission VALUES ('sub-b', ?, '{}', 1, '[]', '{}', 'sub-a', ?, ?)").run(a.cycleId, learnerCtx.actorId, at);
    db.prepare("INSERT INTO evaluation VALUES ('eval-a', 'sub-a', 'v1', 'CORRECT', '{}', ?)").run(at);
    db.prepare("INSERT INTO explanationRevision VALUES ('explain-a', ?, 'sub-a', '{}', 'synthetic original child text', 0, NULL, NULL, ?)").run(a.cycleId, at);
    db.prepare("INSERT INTO explanationRevision VALUES ('explain-b', ?, 'sub-b', '{}', 'synthetic revision', 0, NULL, 'explain-a', ?)").run(a.cycleId, at);
    db.prepare("INSERT INTO guardianObservation VALUES ('observe-a', 'explain-a', 'v1', 'NOT_OBSERVED', 'NOT_OBSERVED', 'NOT_OBSERVED', ?, NULL, ?)").run(guardianCtx.actorId, at);
    db.prepare("INSERT INTO assistanceRecord VALUES ('assist-a', ?, ?, 'sub-a', 'OPERATIVE', 'synthetic help text', ?, NULL, ?)").run(h.familyId, a.attemptId, guardianCtx.actorId, at);
    db.prepare("INSERT INTO transferPlan VALUES ('plan-a', ?, ?, 'task-a', 'OBSERVED', NULL, NULL, ?, 7)").run(h.familyId, learnerId, a.questionInstanceId);
    db.prepare("UPDATE learningAttempt SET attemptStatus = 'COMPLETED', endedAt = ? WHERE attemptId = ?").run(at, a.attemptId);
    const survivor = await startAttempt(h, learnerCtx, learnerId, 'surviving-attempt');
    assert.equal(db.prepare('SELECT previousAttemptId FROM learningAttempt WHERE attemptId = ?').get(survivor.attemptId)!.previousAttemptId, a.attemptId);
    db.prepare("INSERT INTO family VALUES ('family-other', 'synthetic other family', ?)").run(at);
    db.prepare("INSERT INTO learner VALUES ('learner-other', 'family-other', 'synthetic foreign learner', NULL, 'ACTIVE', ?)").run(at);
    const release = db.prepare('SELECT releaseId FROM learningAttempt WHERE attemptId = ?').get(a.attemptId)!.releaseId as string;
    db.prepare("INSERT INTO learningAttempt VALUES ('attempt-other', 'family-other', 'learner-other', ?, 'ACTIVE', 1, NULL, ?, NULL, NULL)").run(release, at);
    db.prepare("INSERT INTO questionInstance VALUES ('instance-other', 'family-other', 'learner-other', ?, 'task-other', '1', '{}', ?)").run(release, at);
    db.prepare("INSERT INTO learningCycle VALUES ('cycle-other', 'attempt-other', 'instance-other', 'PREDICT', '{}', '{}', 1, 0, ?)").run(at);
    db.prepare("INSERT INTO prediction VALUES ('cycle-other', '{}', 1, 'foreign original text', ?)").run(at);
    // Adapter's family boundary remains enforced even when called with another family's attempt id.
    await h.storage.tx('foreign-disposal-probe', async () => {
      assert.deepEqual(executeDisposal(db, { kind: 'ATTEMPT', familyId: h.familyId, attemptId: 'attempt-other' }).deleted, {});
    });
    const prep = await h.cmd(guardianCtx, { kind: 'guardian.prepareDeletion', target: { scope: 'FAMILY' }, idempotencyKey: 'relationships-prepare', payload: { target: 'ATTEMPT', targetId: a.attemptId } });
    const id = prep.effectRefs[0].slice(9);
    type Status = Extract<PublicProjection, { kind: 'guardian.deletionStatus' }>;
    const p = await h.server.query(guardianCtx, { kind: 'guardian.deletionStatus', deletionId: id }) as Status;
    assert.equal(p.scope!.counts.submission, 2); assert.equal(p.scope!.counts.guardianObservation, 1);
    assert.equal((await h.cmd(guardianCtx, { kind: 'guardian.confirmDeletion', target: { scope: 'FAMILY' }, idempotencyKey: 'relationships-confirm', payload: { preparedDeletionId: id, scopeListHash: p.scopeHash } })).status, 'APPLIED');
    for (const [table, key, value] of [['prediction', 'cycleId', a.cycleId], ['hintPresentation', 'hintId', 'hint-a'],
      ['submission', 'submissionId', 'sub-a'], ['evaluation', 'evaluationId', 'eval-a'], ['explanationRevision', 'revisionId', 'explain-a'],
      ['guardianObservation', 'observationId', 'observe-a'], ['assistanceRecord', 'recordId', 'assist-a'], ['transferPlan', 'planId', 'plan-a'],
      ['learningEvent', 'attemptId', a.attemptId], ['learningCycle', 'cycleId', a.cycleId], ['questionInstance', 'questionInstanceId', a.questionInstanceId]]) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${key} = ?`).get(value)!.n, 0, table);
    }
    assert.equal(db.prepare('SELECT previousAttemptId FROM learningAttempt WHERE attemptId = ?').get(survivor.attemptId)!.previousAttemptId, null);
    assert.ok(db.prepare("SELECT * FROM prediction WHERE cycleId = 'cycle-other'").get());
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const tomb = JSON.stringify(db.prepare('SELECT scopeJson, resultJson FROM dataOperation WHERE opId = ?').get(id));
    assert.ok(!tomb.includes('synthetic original child text')); assert.ok(!tomb.includes('synthetic help text'));
    await h.auth.unlockGuardian({ passphrase: GUARDIAN_PASSPHRASE }); const ctx = await h.guardianContext();
    const familyPrep = await h.cmd(ctx, { kind: 'guardian.prepareDeletion', target: { scope: 'FAMILY' }, idempotencyKey: 'all-prepare', payload: { target: 'ALL_FAMILY_DATA' } });
    const familyId = familyPrep.effectRefs[0].slice(9);
    const familyStatus = await h.server.query(ctx, { kind: 'guardian.deletionStatus', deletionId: familyId }) as Status;
    assert.equal((await h.cmd(ctx, { kind: 'guardian.confirmDeletion', target: { scope: 'FAMILY' }, idempotencyKey: 'all-confirm', payload: { preparedDeletionId: familyId, scopeListHash: familyStatus.scopeHash } })).status, 'APPLIED');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM learningAttempt WHERE familyId = ?').get(h.familyId)!.n, 0);
    assert.ok(db.prepare("SELECT * FROM learningAttempt WHERE attemptId = 'attempt-other'").get());
    assert.ok(db.prepare("SELECT * FROM prediction WHERE cycleId = 'cycle-other'").get());
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { await h.closeAll(); }
});
