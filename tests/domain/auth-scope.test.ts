/**
 * Domain tests: authentication, family scope, forged identities, host epoch.
 *
 * Evidence plan (B §I): two synthetic families mutually unreachable; forged
 * guardian/learner rejected; locked and epoch-invalidated sessions rejected.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadyHarness, startAttempt, Harness, GUARDIAN_PASSPHRASE, HOST_EPOCH, WINDOW_REF } from '../fixtures/harness';
import { asRondoError } from '../contracts/stub-service';

test('setupGuardian is idempotent by key and admits exactly one family', async () => {
  const { harness } = await createReadyHarness();
  try {
    const session = await harness.auth.setupGuardian({
      idempotencyKey: harness.setupKey,
      familyDisplayName: 'synth-family',
      guardianDisplayName: 'synth-family-guardian',
      passphrase: GUARDIAN_PASSPHRASE,
    });
    const families = harness.storage.rawDatabase().prepare('SELECT COUNT(*) c FROM family').get() as { c: number };
    assert.equal(families.c, 1);
    // Repeat with the same key returns the SAME family.
    assert.equal(session.familyId, harness.familyId);
    // A different key cannot create a second family.
    await assert.rejects(
      () =>
        harness.auth.setupGuardian({
          idempotencyKey: 'other-key-0002',
          familyDisplayName: 'second',
          guardianDisplayName: 'second-guardian',
          passphrase: GUARDIAN_PASSPHRASE,
        }),
      (err: unknown) => asRondoError(err)?.code === 'INVALID_OPERATION',
    );
    const after = harness.storage.rawDatabase().prepare('SELECT COUNT(*) c FROM family').get() as { c: number };
    assert.equal(after.c, 1);
  } finally {
    await harness.closeAll();
  }
});

test('repeat setup with same key but wrong passphrase is rejected', async () => {
  const { harness } = await createReadyHarness();
  try {
    await assert.rejects(
      () =>
        harness.auth.setupGuardian({
          idempotencyKey: harness.setupKey,
          familyDisplayName: 'synth-family',
          guardianDisplayName: 'synth-family-guardian',
          passphrase: 'wrong-passphrase-1',
        }),
      (err: unknown) => asRondoError(err)?.code === 'UNAUTHENTICATED',
    );
  } finally {
    await harness.closeAll();
  }
});

test('unlock failures throttle into a lockout', async () => {
  const harness = await Harness.create();
  try {
    await harness.setupFamily();
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(
        () => harness.auth.unlockGuardian({ passphrase: 'definitely-wrong' }),
        (err: unknown) => asRondoError(err)?.code === 'UNAUTHENTICATED',
      );
    }
    // Sixth attempt is locked out even with the CORRECT passphrase.
    await assert.rejects(
      () => harness.auth.unlockGuardian({ passphrase: GUARDIAN_PASSPHRASE }),
      (err: unknown) => {
        const rondo = asRondoError(err);
        return rondo?.code === 'UNAUTHENTICATED' && typeof rondo.context?.retryAfterMs === 'number';
      },
    );
    const row = harness.storage.rawDatabase().prepare('SELECT failedAttempts, lockUntil FROM guardianCredential').get() as {
      failedAttempts: number;
      lockUntil: number | null;
    };
    assert.equal(row.failedAttempts, 5);
    assert.ok(row.lockUntil !== null && row.lockUntil > harness.clock.now());
  } finally {
    await harness.closeAll();
  }
});

test('lock revokes the current session; the context provider refuses the old ref', async () => {
  const { harness, learnerId } = await createReadyHarness();
  try {
    const ctx = await harness.learnerContext(learnerId);
    assert.ok(ctx !== null);
    await harness.auth.lock(); // revokes the CURRENT (learner) session
    const session = await harness.auth.session();
    assert.equal(session, null);
    const providerResult = await harness.auth.contextProvider(ctx.sessionId, WINDOW_REF);
    assert.equal(providerResult, null);
  } finally {
    await harness.closeAll();
  }
});

test('ordinary learner sessions last four hours without granting guardian powers', async () => {
  const { harness, learnerId, learnerCtx } = await createReadyHarness();
  try {
    const session = await harness.auth.session();
    assert.equal(session?.role, 'LEARNER');
    const expiresAt = session!.expiresAtMs;
    assert.equal(expiresAt - harness.clock.now(), 4 * 60 * 60 * 1000);
    harness.clock.advance(16 * 60 * 1000);
    assert.equal((await harness.auth.session())?.expiresAtMs, expiresAt);
    assert.equal((await harness.auth.contextProvider(learnerCtx.sessionId, WINDOW_REF))?.role, 'LEARNER');
    const denied = await harness.cmd(learnerCtx, {
      kind: 'guardian.prepareExport', idempotencyKey: 'four-hour-export-denied',
      payload: { scope: { categories: ['ALIASES'] } }, target: { scope: 'FAMILY' },
    });
    assert.equal(denied.status, 'REJECTED');
    assert.equal(denied.errorCode, 'FORBIDDEN');
    await assert.rejects(() => harness.auth.enterLearner({ learnerId }),
      (err: unknown) => asRondoError(err)?.code === 'UNAUTHENTICATED');
    harness.clock.advance(expiresAt - harness.clock.now() - 1);
    assert.equal((await harness.auth.session())?.learnerId, learnerId);
    harness.clock.advance(1);
    assert.equal(await harness.auth.session(), null);
    assert.equal(await harness.auth.contextProvider(learnerCtx.sessionId, WINDOW_REF), null);
    await harness.auth.unlockGuardian({ passphrase: GUARDIAN_PASSPHRASE });
    const reentered = await harness.auth.enterLearner({ learnerId });
    assert.equal(reentered.role, 'LEARNER');
    assert.equal(reentered.expiresAtMs - harness.clock.now(), 4 * 60 * 60 * 1000);
  } finally {
    await harness.closeAll();
  }
});

test('advancing the host epoch invalidates every older session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rondo-epoch-'));
  const dbFile = `${root}/rondo.sqlite`;
  const mk = async (epoch: string) => {
    const harness = await Harness.create({ dbFile, hostEpoch: epoch });
    return harness;
  };
  const first = await mk('epoch-1');
  await first.setupFamily();
  const ctx1 = await first.guardianContext();
  assert.ok(ctx1 !== null);
  await first.server.close();
  await first.content.close();
  await first.storage.close();
  first.storage.closeConnection();

  // Same data root, restarted Host with an ADVANCED epoch: old sessions dead.
  const second = await mk('epoch-2');
  try {
    const revived = await second.auth.contextProvider(ctx1.sessionId, WINDOW_REF);
    assert.equal(revived, null);
    // The guardian must re-unlock; the passphrase still works (B-D4).
    const session = await second.auth.unlockGuardian({ passphrase: GUARDIAN_PASSPHRASE });
    assert.equal(session.familyId, first.familyId);
  } finally {
    await second.closeAll();
    await rm(root, { recursive: true, force: true });
  }
  void HOST_EPOCH;
});

test('forged role/learner claims are rejected by the command surface', async () => {
  const { harness, learnerId, guardianCtx, learnerCtx } = await createReadyHarness();
  try {
    const att = await startAttempt(harness, learnerCtx, learnerId);
    // Guardian session cannot issue learning.* commands (stable rejection).
    const asGuardian = await harness.cmd(guardianCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'forge-1',
      payload: { operation: { type: 'SetSection', section: 'AXIAL' } },
      target: { scope: 'LEARNER', learnerId, attemptId: att.attemptId },
      expectedAttemptVersion: 1,
    });
    assert.equal(asGuardian.status, 'REJECTED');
    assert.equal(asGuardian.errorCode, 'FORBIDDEN');
    // Learner session cannot claim another learner id.
    const asImpostor = await harness.cmd(learnerCtx, {
      kind: 'learning.startAttempt',
      idempotencyKey: 'forge-2',
      payload: { releaseId: 'rel-cyl-synth-0001' },
      target: { scope: 'LEARNER', learnerId: 'lrn-somebody-else' },
    });
    assert.equal(asImpostor.status, 'REJECTED');
    assert.equal(asImpostor.errorCode, 'FORBIDDEN');
    // Learner session cannot issue guardian commands.
    const asLearner = await harness.cmd(learnerCtx, {
      kind: 'guardian.prepareExport',
      idempotencyKey: 'forge-3',
      payload: { scope: { categories: ['ALIASES'] } },
      target: { scope: 'FAMILY' },
    });
    assert.equal(asLearner.status, 'REJECTED');
    assert.equal(asLearner.errorCode, 'FORBIDDEN');
  } finally {
    await harness.closeAll();
  }
});

test('enterLearner refuses learners outside the family; two roots are mutually unreachable', async () => {
  const a = await createReadyHarness();
  const b = await createReadyHarness();
  try {
    // enterLearner with the OTHER root's learner id: not in this family's DB.
    // (Re-establish the guardian session first: the harness left a learner session active.)
    await a.harness.auth.unlockGuardian({ passphrase: GUARDIAN_PASSPHRASE });
    await assert.rejects(
      () => a.harness.auth.enterLearner({ learnerId: b.learnerId }),
      (err: unknown) => asRondoError(err)?.code === 'FORBIDDEN',
    );
    // Family A context probing family B objects: uniformly invisible.
    const attB = await startAttempt(b.harness, b.learnerCtx, b.learnerId);
    await assert.rejects(
      () => a.harness.server.query(a.guardianCtx, { kind: 'learning.attemptView', attemptId: attB.attemptId }),
      (err: unknown) => asRondoError(err)?.code === 'INVALID_OPERATION',
    );
    const lookup = await a.harness.server.lookupReceipt(a.guardianCtx, { idempotencyKey: 'start-attempt-1', commandKind: 'learning.startAttempt' });
    assert.equal(lookup.status, 'NOT_FOUND');
    // Cross-family learner in the evidence summary: uniformly FORBIDDEN-invisible.
    await assert.rejects(
      () => a.harness.server.query(a.guardianCtx, { kind: 'guardian.evidenceSummary', learnerId: b.learnerId }),
      (err: unknown) => asRondoError(err)?.code === 'FORBIDDEN',
    );
    const ownEvidence = await a.harness.server.query(a.guardianCtx, { kind: 'guardian.evidenceSummary', learnerId: a.learnerId });
    assert.ok(ownEvidence.kind === 'guardian.evidenceSummary');
    assert.equal(ownEvidence.items.length, 0);
  } finally {
    await a.harness.closeAll();
    await b.harness.closeAll();
  }
});

test('a second family inserted into the same DB is invisible to the first family', async () => {
  const { harness, learnerId, learnerCtx } = await createReadyHarness();
  try {
    // White-box: plant a foreign family + learner directly in the same file.
    const db = harness.storage.rawDatabase();
    db.prepare('INSERT INTO family (familyId, displayName, createdAt) VALUES (?, ?, ?)').run('fam-foreign-1', 'Foreign', 1);
    db.prepare('INSERT INTO learner (learnerId, familyId, alias, status, createdAt) VALUES (?, ?, ?, ?, ?)').run(
      'lrn-foreign-1',
      'fam-foreign-1',
      '外部孩子',
      'ACTIVE',
      1,
    );
    // Repository-level invisibility for the authenticated scope.
    const visible = await harness.storage.read(async (repos) =>
      repos.learner.findById({ familyId: harness.familyId, actorId: 'x' }, 'lrn-foreign-1'),
    );
    assert.equal(visible, null);
    // Command-level: target claims the foreign learner.
    const cross = await harness.cmd(learnerCtx, {
      kind: 'learning.startAttempt',
      idempotencyKey: 'cross-1',
      payload: { releaseId: 'rel-cyl-synth-0001' },
      target: { scope: 'LEARNER', learnerId: 'lrn-foreign-1' },
    });
    assert.equal(cross.status, 'REJECTED');
    assert.equal(cross.errorCode, 'FORBIDDEN');
    // And the original learner still works.
    const att = await startAttempt(harness, learnerCtx, learnerId, 'cross-ok-1');
    assert.ok(att.attemptId.length > 0);
  } finally {
    await harness.closeAll();
  }
});
