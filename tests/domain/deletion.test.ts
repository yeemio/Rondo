import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadyHarness, Harness, startAttempt, GUARDIAN_PASSPHRASE, WINDOW_REF } from '../fixtures/harness';
import type { ServerContext } from '../../modules/contracts/server/context';
import type { PublicProjection, DeletionScope } from '../../modules/contracts/public/queries';
import { parsePublicProjection } from '../../modules/contracts/public/queries';
import { parseEnvelope } from '../../modules/contracts/public/envelope';
import { CompilerService } from '../../workers/cpp/compiler.mjs';

type Status = Extract<PublicProjection, { kind: 'guardian.deletionStatus' }>;
const familyTarget = { scope: 'FAMILY' } as const;
async function prepare(h: Harness, ctx: ServerContext, target: DeletionScope['target'], targetId?: string, key = 'prepare-delete') {
  const receipt = await h.cmd(ctx, { kind: 'guardian.prepareDeletion', target: familyTarget, idempotencyKey: key,
    payload: { target, ...(targetId ? { targetId } : {}) } });
  assert.equal(receipt.status, 'APPLIED');
  const id = receipt.effectRefs.find((ref) => ref.startsWith('disposal:'))!.slice(9);
  const status = await h.server.query(ctx, { kind: 'guardian.deletionStatus', deletionId: id }) as Status;
  parsePublicProjection(status);
  assert.equal(status.phase, 'PREPARED');
  return status;
}
function confirm(h: Harness, ctx: ServerContext, prepared: Status, key = 'confirm-delete') {
  return h.cmd(ctx, { kind: 'guardian.confirmDeletion', target: familyTarget, idempotencyKey: key,
    payload: { preparedDeletionId: prepared.deletionId, scopeListHash: prepared.scopeHash } });
}
function dataCounts(h: Harness) {
  return Object.fromEntries(['learner', 'learningAttempt', 'learningCycle', 'questionInstance', 'prediction',
    'submission', 'evaluation', 'explanationRevision', 'hintPresentation', 'assistanceRecord', 'guardianObservation', 'learningEvent', 'transferPlan']
    .map((table) => [table, Number(h.storage.rawDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)]));
}
async function reenter(h: Harness) { await h.auth.unlockGuardian({ passphrase: GUARDIAN_PASSPHRASE }); return h.guardianContext(); }

test('deletion: confirms the named operation despite a newer preview; revocation and exact-key reentry preserve truth', async () => {
  const { harness: h, guardianCtx, learnerCtx, learnerId } = await createReadyHarness();
  try {
    const first = await startAttempt(h, learnerCtx, learnerId);
    const secondLearner = await h.createLearner(guardianCtx, 'surviving synthetic learner', 'survivor');
    const named = await prepare(h, guardianCtx, 'ATTEMPT', first.attemptId, 'named');
    assert.deepEqual(named.scope!.learners, [{ learnerId, alias: '小测' }]);
    assert.equal(named.scope!.attempts[0].startedAtMs, h.clock.now());
    const newer = await prepare(h, guardianCtx, 'LEARNER', secondLearner, 'newer');
    const oldSessions = h.storage.rawDatabase().prepare('SELECT sessionId FROM hostSession').all() as { sessionId: string }[];
    h.clock.advance(1234); // Preparation time itself is not part of the current fact fingerprint.
    const receipt = await confirm(h, guardianCtx, named);
    assert.equal(receipt.status, 'APPLIED');
    assert.equal((h.storage.rawDatabase().prepare('SELECT COUNT(*) n FROM learningAttempt').get()!).n, 0);
    assert.equal((h.storage.rawDatabase().prepare('SELECT COUNT(*) n FROM learner').get()!).n, 2);
    assert.equal(await h.auth.session(), null);
    for (const session of oldSessions) assert.equal(await h.auth.contextProvider(session.sessionId, WINDOW_REF), null);
    const unlocked = await reenter(h);
    const lookup = await h.server.lookupReceipt(unlocked, { idempotencyKey: 'confirm-delete', commandKind: 'guardian.confirmDeletion' });
    assert.equal(lookup.status, 'CONFIRMED');
    const result = await h.server.query(unlocked, { kind: 'guardian.deletionStatus', deletionId: named.deletionId, confirmationKey: 'confirm-delete' }) as Status;
    parsePublicProjection(result);
    assert.equal(result.phase, 'COMPLETED'); assert.equal(result.result!.deleted.learningAttempt, 1);
    assert.ok(Object.values(result.result!.remaining).every((n) => n === 0));
    assert.equal(result.result!.sessionsInvalidated, true);
    assert.deepEqual(await confirm(h, unlocked, named), receipt);
    assert.equal((await confirm(h, unlocked, named, 'second-confirm-key')).status, 'REJECTED');
    await assert.rejects(() => h.server.query(unlocked, { kind: 'guardian.deletionStatus', deletionId: named.deletionId, confirmationKey: 'wrong-key' }), (e: { code?: string }) => e.code === 'INVALID_OPERATION');
    await assert.rejects(() => h.cmd(unlocked, { kind: 'guardian.confirmDeletion', target: familyTarget, idempotencyKey: 'confirm-delete',
      payload: { preparedDeletionId: newer.deletionId, scopeListHash: newer.scopeHash } }), (e: { code?: string }) => e.code === 'IDEMPOTENCY_CONFLICT');
    assert.ok(h.storage.rawDatabase().prepare('SELECT * FROM learner WHERE learnerId = ?').get(secondLearner));
  } finally { await h.closeAll(); }
});

test('deletion: new learner/attempt after family preview rejects with zero data deletion', async () => {
  const { harness: h, guardianCtx, learnerId, learnerCtx } = await createReadyHarness();
  try {
    await startAttempt(h, learnerCtx, learnerId);
    const old = await prepare(h, guardianCtx, 'ALL_FAMILY_DATA');
    const added = await h.createLearner(guardianCtx, 'new synthetic learner', 'new-after-preview');
    await reenter(h); const ctx = await h.enterLearner(added); await startAttempt(h, ctx, added, 'new-attempt');
    const before = dataCounts(h);
    assert.equal((await confirm(h, guardianCtx, old)).status, 'REJECTED');
    assert.deepEqual(dataCounts(h), before);
    assert.equal((await h.server.query(guardianCtx, { kind: 'guardian.deletionStatus', deletionId: old.deletionId }) as Status).phase, 'STALE');
  } finally { await h.closeAll(); }
});

test('deletion: added submissions and same-count content changes both invalidate the preview', async () => {
  const { harness: h, guardianCtx, learnerCtx, learnerId } = await createReadyHarness();
  try {
    const attempt = await startAttempt(h, learnerCtx, learnerId);
    const p = await prepare(h, guardianCtx, 'ATTEMPT', attempt.attemptId, 'before-submit');
    const db = h.storage.rawDatabase();
    db.prepare("INSERT INTO submission VALUES (?, ?, '{}', 1, '[]', '{}', NULL, ?, ?)").run('sub-added', attempt.cycleId, learnerCtx.actorId, h.clock.now());
    const before = dataCounts(h);
    assert.equal((await confirm(h, guardianCtx, p, 'reject-submit')).status, 'REJECTED');
    assert.deepEqual(dataCounts(h), before);
    const p2 = await prepare(h, guardianCtx, 'ATTEMPT', attempt.attemptId, 'before-edit');
    db.prepare("UPDATE submission SET responseJson = ? WHERE submissionId = 'sub-added'").run('["changed synthetic text"]');
    assert.equal((await confirm(h, guardianCtx, p2, 'reject-same-count')).status, 'REJECTED');
    assert.deepEqual(dataCounts(h), before);
    assert.equal(db.prepare("SELECT responseJson FROM submission WHERE submissionId = 'sub-added'").get()!.responseJson, '["changed synthetic text"]');
  } finally { await h.closeAll(); }
});

test('deletion: expired/legacy preview, foreign/unknown target and mismatched operation/hash fail closed', async () => {
  const a = await createReadyHarness(), b = await createReadyHarness();
  try {
    const attempt = await startAttempt(a.harness, a.learnerCtx, a.learnerId);
    const p = await prepare(a.harness, a.guardianCtx, 'LEARNER', a.learnerId);
    const before = dataCounts(a.harness);
    for (const targetId of ['learner-unknown', b.learnerId]) {
      const receipt = await a.harness.cmd(a.guardianCtx, { kind: 'guardian.prepareDeletion', target: familyTarget,
        idempotencyKey: `foreign-${targetId}`, payload: { target: 'LEARNER', targetId } });
      assert.equal(receipt.status, 'REJECTED');
    }
    await assert.rejects(() => a.harness.server.query(b.guardianCtx, { kind: 'guardian.deletionStatus', deletionId: p.deletionId }), (e: { code?: string }) => e.code === 'INVALID_OPERATION');
    await assert.rejects(() => a.harness.server.query(a.learnerCtx, { kind: 'guardian.deletionStatus', deletionId: p.deletionId }), (e: { code?: string }) => e.code === 'FORBIDDEN');
    assert.throws(() => parseEnvelope({ protocolVersion: 'rondo.v1', commandId: 'malformed', idempotencyKey: 'malformed',
      kind: 'guardian.prepareDeletion', target: familyTarget, payload: { target: 'ALL_FAMILY_DATA', targetId: attempt.attemptId } }));
    assert.equal((await confirm(a.harness, a.guardianCtx, { ...p, scopeHash: '0'.repeat(64) }, 'wrong-hash')).status, 'REJECTED');
    assert.equal((await confirm(a.harness, a.guardianCtx, { ...p, deletionId: 'op-unknown' }, 'unknown-op')).status, 'REJECTED');
    a.harness.clock.advance(15 * 60 * 1000);
    assert.equal((await confirm(a.harness, a.guardianCtx, p, 'expired')).status, 'REJECTED');
    assert.equal((await a.harness.server.query(a.guardianCtx, { kind: 'guardian.deletionStatus', deletionId: p.deletionId }) as Status).phase, 'EXPIRED');
    a.harness.storage.rawDatabase().prepare('UPDATE dataOperation SET scopeJson = ? WHERE opId = ?').run('{"target":"ALL_FAMILY_DATA"}', p.deletionId);
    assert.equal((await a.harness.server.query(a.guardianCtx, { kind: 'guardian.deletionStatus', deletionId: p.deletionId }) as Status).phase, 'STALE');
    assert.deepEqual(dataCounts(a.harness), before);
  } finally { await a.harness.closeAll(); await b.harness.closeAll(); }
});

test('deletion: preparation/cancellation is non-destructive and an empty family has an honest zero result', async () => {
  const h = await Harness.create();
  try {
    await h.setupFamily(); const ctx = await h.guardianContext();
    const p = await prepare(h, ctx, 'ALL_FAMILY_DATA');
    const before = dataCounts(h);
    assert.ok(Object.values(before).every((n) => n === 0));
    // Cancel means no confirmation command: the prepared operation has no destructive side effect.
    assert.equal((await h.server.query(ctx, { kind: 'guardian.deletionStatus', deletionId: p.deletionId }) as Status).phase, 'PREPARED');
    assert.deepEqual(dataCounts(h), before); assert.ok(await h.auth.session());
    assert.equal((await confirm(h, ctx, p)).status, 'APPLIED');
    const result = await h.server.query(await reenter(h), { kind: 'guardian.deletionStatus', deletionId: p.deletionId, confirmationKey: 'confirm-delete' }) as Status;
    assert.equal(result.result!.deleted.learner, 0); assert.equal(result.result!.hostCopies, 'NOT_PRESENT');
    assert.ok(h.storage.rawDatabase().prepare('SELECT familyId FROM guardianCredential').get());
  } finally { await h.closeAll(); }
});

test('deletion: disposal failure after SQL writes rolls back data, session invalidation, phase and receipt', async () => {
  const { harness: h, guardianCtx, learnerCtx, learnerId } = await createReadyHarness();
  try {
    await startAttempt(h, learnerCtx, learnerId);
    const p = await prepare(h, guardianCtx, 'ALL_FAMILY_DATA'); const before = dataCounts(h);
    const original = h.storage.dispose.bind(h.storage);
    h.storage.dispose = (spec) => { original(spec); throw Error('injected disposal failure after writes'); };
    await assert.rejects(() => confirm(h, guardianCtx, p), /injected disposal failure/);
    h.storage.dispose = original;
    assert.deepEqual(dataCounts(h), before); assert.ok(await h.auth.session());
    assert.equal((await h.server.lookupReceipt(guardianCtx, { idempotencyKey: 'confirm-delete', commandKind: 'guardian.confirmDeletion' })).status, 'NOT_FOUND');
    assert.equal((await h.server.query(guardianCtx, { kind: 'guardian.deletionStatus', deletionId: p.deletionId }) as Status).phase, 'PREPARED');
  } finally { await h.closeAll(); }
});

test('deletion: a later family deletion preserves the original deletion receipt and cannot repeat the first delete', async () => {
  const { harness: h, guardianCtx, learnerCtx, learnerId } = await createReadyHarness();
  try {
    await startAttempt(h, learnerCtx, learnerId); const first = await prepare(h, guardianCtx, 'ALL_FAMILY_DATA', undefined, 'prepare-first');
    const receipt = await confirm(h, guardianCtx, first, 'confirm-first'); const nextCtx = await reenter(h);
    await h.createLearner(nextCtx, 'later learner', 'later-learner');
    const second = await prepare(h, nextCtx, 'ALL_FAMILY_DATA', undefined, 'prepare-second');
    assert.equal((await confirm(h, nextCtx, second, 'confirm-second')).status, 'APPLIED');
    const lastCtx = await reenter(h);
    assert.deepEqual(await confirm(h, lastCtx, first, 'confirm-first'), receipt);
    const lookup = await h.server.lookupReceipt(lastCtx, { idempotencyKey: 'confirm-first', commandKind: 'guardian.confirmDeletion' });
    assert.equal(lookup.status, 'CONFIRMED');
    assert.equal(h.storage.rawDatabase().prepare("SELECT COUNT(*) n FROM dataOperation WHERE kind = 'DELETION' AND phase = 'COMPLETED'").get()!.n, 2);
  } finally { await h.closeAll(); }
});

function compilerFixture() {
  const compiler = new CompilerService({ compilerContractId: 'synthetic', imageId: 'synthetic-no-container', platform: 'synthetic' });
  const internals = compiler as unknown as { jobs: Map<string, Record<string, unknown>>; requests: Map<string, string> };
  const put = (run: string, suffix: string, state = 'OK') => {
    const id = `${run}-${suffix}-worker`, requestId = `${run}-${suffix}`;
    internals.jobs.set(id, { id, requestId, source: 'synthetic private source', stdin: 'synthetic input', state,
      containers: [], container: null, result: { execution: { stdout: 'synthetic output' } } }); internals.requests.set(requestId, id); return id;
  };
  return { compiler, internals, put };
}
async function seedRun(h: Harness, ctx: ServerContext, attemptId: string, jobId: string, instanceId: string, terminal: boolean, status: string) {
  await h.storage.tx('synthetic-run', (repos) => repos.learningEvent.append({ familyId: ctx.familyId, actorId: ctx.actorId }, {
    familyId: ctx.familyId, attemptId, commandKind: 'code.requestRun', eventType: 'CODE_RUN_STATUS', payloadVersion: '1', occurredAt: h.clock.now(),
    payloadJson: JSON.stringify({ privatePassed: null, run: { jobId, instanceId, terminal, status, source: 'synthetic private source', stdin: 'synthetic input' } }),
  }));
}

test('deletion: nonterminal and UNKNOWN jobs reject deletion; safe terminal copies clear only after commit', async () => {
  const fixture = compilerFixture(); const ready = await createReadyHarness({ compiler: fixture.compiler }); const h = ready.harness;
  try {
    const a = await startAttempt(h, ready.learnerCtx, ready.learnerId);
    await seedRun(h, ready.learnerCtx, a.attemptId, 'logical-1', fixture.compiler.capability().instanceId, false, 'RUNNING');
    const before = dataCounts(h);
    let receipt = await h.cmd(ready.guardianCtx, { kind: 'guardian.prepareDeletion', idempotencyKey: 'active', target: familyTarget, payload: { target: 'ALL_FAMILY_DATA' } });
    assert.equal(receipt.status, 'REJECTED'); assert.deepEqual(dataCounts(h), before);
    await seedRun(h, ready.learnerCtx, a.attemptId, 'logical-1', fixture.compiler.capability().instanceId, true, 'UNKNOWN');
    receipt = await h.cmd(ready.guardianCtx, { kind: 'guardian.prepareDeletion', idempotencyKey: 'unknown', target: familyTarget, payload: { target: 'ALL_FAMILY_DATA' } });
    assert.equal(receipt.status, 'REJECTED');
    await seedRun(h, ready.learnerCtx, a.attemptId, 'logical-1', fixture.compiler.capability().instanceId, true, 'OK');
    const deleted = fixture.put('logical-1', 'visible'); fixture.put('logical-1', 'private-0');
    const kept = fixture.put('logical-10', 'visible');
    const prepared = await prepare(h, ready.guardianCtx, 'ALL_FAMILY_DATA');
    assert.ok(fixture.internals.jobs.has(deleted));
    assert.equal((await confirm(h, ready.guardianCtx, prepared)).status, 'APPLIED');
    assert.ok(!fixture.internals.jobs.has(deleted)); assert.ok(fixture.internals.jobs.has(kept));
    const result = await h.server.query(await reenter(h), { kind: 'guardian.deletionStatus', deletionId: prepared.deletionId, confirmationKey: 'confirm-delete' }) as Status;
    assert.equal(result.result!.hostCopies, 'CLEARED');
    const tomb = h.storage.rawDatabase().prepare('SELECT scopeJson, resultJson FROM dataOperation WHERE opId = ?').get(prepared.deletionId)!;
    assert.ok(!JSON.stringify(tomb).includes('synthetic private source')); assert.ok(!JSON.stringify(tomb).includes('小测'));
  } finally { await h.closeAll(); }
});

test('deletion: post-commit memory cleanup failure remains partial and recovers by the original key without another delete', async () => {
  const fixture = compilerFixture(); const ready = await createReadyHarness({ compiler: fixture.compiler }); const h = ready.harness;
  try {
    const a = await startAttempt(h, ready.learnerCtx, ready.learnerId);
    await seedRun(h, ready.learnerCtx, a.attemptId, 'logical-fail', fixture.compiler.capability().instanceId, true, 'OK');
    const id = fixture.put('logical-fail', 'visible');
    const p = await prepare(h, ready.guardianCtx, 'LEARNER', ready.learnerId);
    const original = fixture.compiler.forgetDeletionRun!.bind(fixture.compiler);
    fixture.compiler.forgetDeletionRun = () => { throw Error('injected cleanup failure'); };
    assert.equal((await confirm(h, ready.guardianCtx, p)).status, 'APPLIED');
    assert.equal(h.storage.rawDatabase().prepare('SELECT COUNT(*) n FROM learner').get()!.n, 0);
    const unlocked = await reenter(h);
    let status = await h.server.query(unlocked, { kind: 'guardian.deletionStatus', deletionId: p.deletionId, confirmationKey: 'confirm-delete' }) as Status;
    assert.equal(status.phase, 'COMPLETED_PARTIAL'); assert.equal(status.result!.failedJobCount, 1); assert.ok(fixture.internals.jobs.has(id));
    fixture.compiler.forgetDeletionRun = original;
    assert.equal((await confirm(h, unlocked, p)).status, 'APPLIED');
    assert.ok(!fixture.internals.jobs.has(id));
    status = await h.server.query(unlocked, { kind: 'guardian.deletionStatus', deletionId: p.deletionId, confirmationKey: 'confirm-delete' }) as Status;
    assert.equal(status.phase, 'COMPLETED'); assert.equal(status.result!.deleted.learner, 1);
  } finally { await h.closeAll(); }
});
