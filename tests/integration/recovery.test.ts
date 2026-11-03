/**
 * Integration tests: persistence across close/reopen (commit-then-lose-response),
 * backup to a new directory preserving the evidence chain, close semantics,
 * cross-root isolation on real files.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Harness,
  createReadyHarness,
  startAttempt,
  GUARDIAN_PASSPHRASE,
  WINDOW_REF,
  type EnvelopeInit,
} from '../fixtures/harness';
import { asRondoError } from '../contracts/stub-service';
import { backupDatabaseToFile } from '../../adapters/sqlite/connection';

async function driveAttemptFlow(harness: Harness, learnerId: string, learnerCtx: Parameters<Harness['cmd']>[0], keyPrefix: string) {
  const att = await startAttempt(harness, learnerCtx, learnerId, `${keyPrefix}-start`);
  const target = { scope: 'LEARNER' as const, learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
  const pred = await harness.cmd(learnerCtx, {
    kind: 'learning.recordPrediction',
    idempotencyKey: `${keyPrefix}-pred`,
    payload: { prediction: { claims: [{ propertyId: 'radius', direction: 'INCREASE' }] }, uncertain: false },
    target,
  });
  const op = await harness.cmd(learnerCtx, {
    kind: 'learning.commitOperation',
    idempotencyKey: `${keyPrefix}-op`,
    payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
    target,
    expectedAttemptVersion: pred.attemptVersion!,
  });
  const sub = await harness.cmd(learnerCtx, {
    kind: 'learning.submitResponse',
    idempotencyKey: `${keyPrefix}-sub`,
    payload: { response: [{ kind: 'propertyJudgments', claims: [
      { propertyId: 'radius', direction: 'INCREASE' },
      { propertyId: 'diameter', direction: 'INCREASE' },
      { propertyId: 'height', direction: 'UNCHANGED' },
    ] }] },
    target,
    expectedAttemptVersion: op.attemptVersion!,
  });
  return { att, receipts: { pred, op, sub }, target };
}

test('commit-then-lost-response: reopening the same root finds the original facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rondo-reopen-'));
  const dbFile = join(root, 'rondo.sqlite');
  const contentRoot = await mkdtemp(join(tmpdir(), 'rondo-reopen-content-'));
  try {
    // Session 1: run the flow; pretend the last response never reached the UI.
    const first = await createReadyHarness({ dbFile, contentRoot });
    const flow = await driveAttemptFlow(first.harness, first.learnerId, first.learnerCtx, 'rc');
    const submitReceipt = flow.receipts.sub;
    await first.harness.server.close();
    await first.harness.content.close();
    await first.harness.storage.close();
    first.harness.storage.closeConnection();

    // Session 2: brand-new instances on the same file, advanced host epoch.
    const second = await Harness.create({ dbFile, contentRoot, hostEpoch: 'epoch-restart-2' });
    try {
      const session = await second.auth.unlockGuardian({ passphrase: GUARDIAN_PASSPHRASE });
      assert.equal(session.familyId, first.harness.familyId);
      const learnerCtx = await second.enterLearner(first.learnerId);
      // The lost-response command resolves via the ORIGINAL key.
      const lookup = await second.server.lookupReceipt(learnerCtx, {
        idempotencyKey: 'rc-sub',
        commandKind: 'learning.submitResponse',
      });
      assert.equal(lookup.status, 'CONFIRMED');
      assert.deepEqual(lookup.receipt, submitReceipt);
      // State is identical: same attempt version, same events, same evaluation.
      const view = await second.server.query(learnerCtx, { kind: 'learning.attemptView', attemptId: flow.att.attemptId });
      assert.ok(view.kind === 'learning.attemptView');
      assert.equal(view.version, submitReceipt.attemptVersion);
      assert.equal(view.currentCycle?.phase, 'VERIFY');
      const timeline = await second.server.query(learnerCtx, { kind: 'learning.timeline', attemptId: flow.att.attemptId });
      assert.ok(timeline.kind === 'learning.timeline');
      assert.equal(timeline.events.length, 4);
      const evalRow = second.storage.rawDatabase().prepare('SELECT outcome FROM evaluation').get() as { outcome: string };
      assert.equal(evalRow.outcome, 'CORRECT');
      // Replaying the SAME envelope/key on the new server creates no new facts.
      const replay = await second.cmd(learnerCtx, {
        kind: 'learning.submitResponse',
        idempotencyKey: 'rc-sub',
        payload: { response: [{ kind: 'propertyJudgments', claims: [
          { propertyId: 'radius', direction: 'INCREASE' },
          { propertyId: 'diameter', direction: 'INCREASE' },
          { propertyId: 'height', direction: 'UNCHANGED' },
        ] }] },
        target: flow.target,
        expectedAttemptVersion: flow.receipts.op.attemptVersion!,
      });
      assert.deepEqual(replay, submitReceipt);
      const subs = second.storage.rawDatabase().prepare('SELECT COUNT(*) c FROM submission').get() as { c: number };
      assert.equal(subs.c, 1);
    } finally {
      await second.closeAll();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(contentRoot, { recursive: true, force: true });
  }
});

test('backup into a new directory preserves the full evidence chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rondo-backup-'));
  const dbFile = join(root, 'rondo.sqlite');
  const contentRoot = await mkdtemp(join(tmpdir(), 'rondo-backup-content-'));
  try {
    const h = await createReadyHarness({ dbFile, contentRoot });
    const flow = await driveAttemptFlow(h.harness, h.learnerId, h.learnerCtx, 'bk');
    // Consistent snapshot into a NEW directory (old root stays for rollback).
    const backupRoot = await mkdtemp(join(tmpdir(), 'rondo-backup-restore-'));
    const backupFile = join(backupRoot, 'rondo.sqlite');
    backupDatabaseToFile(h.harness.storage.rawDatabase(), backupFile);
    // Read both databases and compare the evidence chain.
    const { DatabaseSync } = await import('node:sqlite');
    const a = h.harness.storage.rawDatabase();
    const b = new DatabaseSync(backupFile);
    for (const table of ['family', 'learner', 'learningAttempt', 'learningCycle', 'prediction', 'learningEvent', 'submission', 'evaluation', 'commandReceipt']) {
      const rowsA = a.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
      const rowsB = b.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
      assert.equal(rowsA.length, rowsB.length, `table ${table} row count`);
      assert.deepEqual(rowsB, rowsA, `table ${table} contents`);
    }
    // And the backup is a fully usable NEW root: open it, find the receipts.
    const restored = await Harness.create({ dbFile: backupFile, contentRoot, hostEpoch: 'epoch-backup-1' });
    try {
      const session = await restored.auth.unlockGuardian({ passphrase: GUARDIAN_PASSPHRASE });
      assert.equal(session.familyId, h.harness.familyId);
      const lookup = await restored.server.lookupReceipt({ familyId: session.familyId, actorId: `learner-actor:${h.learnerId}`, sessionId: '', windowRef: WINDOW_REF, hostEpoch: 'epoch-backup-1', role: 'LEARNER', learnerId: h.learnerId }, {
        idempotencyKey: 'bk-sub',
        commandKind: 'learning.submitResponse',
      });
      assert.equal(lookup.status, 'CONFIRMED');
      assert.deepEqual(lookup.receipt, flow.receipts.sub);
    } finally {
      await restored.closeAll();
      b.close();
      await rm(backupRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(contentRoot, { recursive: true, force: true });
  }
});

test('close(): new commands rejected with HOST_RECOVERING; repeated close is safe', async () => {
  const h = await createReadyHarness();
  try {
    await h.harness.server.close();
    await h.harness.server.close(); // idempotent
    const init: EnvelopeInit = {
      kind: 'family.createLearner',
      idempotencyKey: 'after-close',
      payload: { alias: 'nobody' },
      target: { scope: 'FAMILY' },
    };
    await assert.rejects(
      () => h.harness.cmd(h.guardianCtx, init),
      (err: unknown) => asRondoError(err)?.code === 'HOST_RECOVERING',
    );
    await assert.rejects(
      () => h.harness.server.query(h.guardianCtx, { kind: 'catalog.availableLessons' }),
      (err: unknown) => asRondoError(err)?.code === 'HOST_RECOVERING',
    );
  } finally {
    await h.harness.closeAll();
  }
});

test('two real roots stay mutually unreachable end to end', async () => {
  const a = await createReadyHarness();
  const b = await createReadyHarness();
  try {
    const attA = await startAttempt(a.harness, a.learnerCtx, a.learnerId);
    // Family B cannot see family A's receipts, attempts, or evidence.
    const lookup = await b.harness.server.lookupReceipt(b.guardianCtx, { idempotencyKey: 'start-attempt-1', commandKind: 'learning.startAttempt' });
    assert.equal(lookup.status, 'NOT_FOUND');
    await assert.rejects(
      () => b.harness.server.query(b.guardianCtx, { kind: 'learning.attemptView', attemptId: attA.attemptId }),
      (err: unknown) => asRondoError(err)?.code === 'INVALID_OPERATION',
    );
    const exportPrep = await b.harness.cmd(b.guardianCtx, {
      kind: 'guardian.prepareDeletion',
      idempotencyKey: 'iso-del',
      payload: { target: 'ALL_FAMILY_DATA' },
      target: { scope: 'FAMILY' },
    });
    assert.equal(exportPrep.status, 'APPLIED');
    const opId = exportPrep.effectRefs.find((r) => r.startsWith('disposal:'))!.slice('disposal:'.length);
    const status = await b.harness.server.query(b.guardianCtx, { kind: 'guardian.exportStatus', exportId: opId });
    const del = await b.harness.cmd(b.guardianCtx, {
      kind: 'guardian.confirmDeletion',
      idempotencyKey: 'iso-del-conf',
      payload: { scopeListHash: (status as { scopeHash: string }).scopeHash },
      target: { scope: 'FAMILY' },
    });
    assert.equal(del.status, 'APPLIED');
    // Deleting family B's data left family A completely untouched.
    const aCount = a.harness.storage.rawDatabase().prepare('SELECT COUNT(*) c FROM learningAttempt').get() as { c: number };
    assert.equal(aCount.c, 1);
    const aView = await a.harness.server.query(a.learnerCtx, { kind: 'learning.attemptView', attemptId: attA.attemptId });
    assert.ok(aView.kind === 'learning.attemptView');
    assert.equal(aView.attemptStatus, 'ACTIVE');
  } finally {
    await a.harness.closeAll();
    await b.harness.closeAll();
  }
});
