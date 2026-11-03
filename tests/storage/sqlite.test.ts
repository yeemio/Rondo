/**
 * Storage tests: schema/migration runner, pragmas, unique constraints, CAS,
 * transaction rollback, scope invisibility, close semantics, corrupted-file
 * refusal.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../../adapters/sqlite/storage';
import { backupDatabaseToFile } from '../../adapters/sqlite/connection';

async function tempFile(): Promise<{ file: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'rondo-storage-'));
  return { file: join(dir, 'rondo.sqlite'), dir };
}

test('fresh database migrates to schemaVersion 1 with all 21 business tables', async () => {
  const { file, dir } = await tempFile();
  try {
    const storage = new SqliteStorage({ file, now: () => 1 });
    assert.equal(storage.schemaVersion(), 1);
    const tables = storage.rawDatabase()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const expected of [
      'family', 'guardianActor', 'guardianCredential', 'learner', 'hostSession',
      'contentRelease', 'questionInstance', 'learningAttempt', 'learningCycle',
      'prediction', 'hintPresentation', 'learningEvent', 'submission', 'evaluation',
      'explanationRevision', 'assistanceRecord', 'guardianObservation',
      'commandReceipt', 'retentionPolicy', 'dataOperation', 'transferPlan',
      'schema_migrations',
    ]) {
      assert.ok(names.includes(expected), `missing table ${expected}`);
    }
    const appliedAt = storage.rawDatabase().prepare('SELECT appliedAt FROM schema_migrations WHERE version = 1').get() as { appliedAt: number };
    assert.equal(appliedAt.appliedAt, 1); // real clock written by the runner
    await storage.close();
    storage.closeConnection();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('per-connection pragmas: WAL, foreign keys, synchronous FULL', async () => {
  const { file, dir } = await tempFile();
  try {
    const storage = new SqliteStorage({ file, now: () => 1 });
    const db = storage.rawDatabase();
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous, 2); // FULL
    await storage.close();
    storage.closeConnection();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('foreign keys are enforced (learner with unknown family rejected)', async () => {
  const storage = new SqliteStorage({ file: ':memory:', now: () => 1 });
  await storage.close();
  const storage2 = new SqliteStorage({ file: ':memory:', now: () => 1 });
  await assert.rejects(
    () =>
      storage2.tx('t', async (repos) => {
        await repos.learner.insert(
          { familyId: 'fam-none', actorId: 'x' },
          { learnerId: 'lrn-x', familyId: 'fam-none', alias: 'x', goalNote: null, status: 'ACTIVE', createdAt: 1 },
        );
      }),
    /FOREIGN KEY/,
  );
  await storage2.close();
  storage2.closeConnection();
});

test('commandReceipt duplicate key is reported, not silently overwritten', async () => {
  const storage = new SqliteStorage({ file: ':memory:', now: () => 1 });
  try {
    await storage.tx('seed', async (repos) => {
      await repos.family.insert({ familyId: 'fam-a', actorId: 'x' }, { familyId: 'fam-a', displayName: 'A', createdAt: 1 });
    });
    const record = {
      familyId: 'fam-a', actorId: 'actor-a', idempotencyKey: 'k1', commandId: 'c1', kind: 'learning.startAttempt' as const,
      payloadHash: 'h1', bindingJson: null, expectedAttemptVersion: null, status: 'APPLIED' as const, errorCode: null,
      effectRefsJson: '[]', attemptVersionAfter: 1, changedKindsJson: '[]', at: 1,
    };
    await storage.tx('t', async (repos) => {
      assert.equal(await repos.commandReceipt.tryInsert({ familyId: 'fam-a', actorId: 'actor-a' }, record), 'INSERTED');
      assert.equal(await repos.commandReceipt.tryInsert({ familyId: 'fam-a', actorId: 'actor-a' }, record), 'DUPLICATE');
    });
    const rows = await storage.read(async (repos) =>
      repos.commandReceipt.findByKey({ familyId: 'fam-a', actorId: 'actor-a' }, { familyId: 'fam-a', actorId: 'actor-a', idempotencyKey: 'k1' }),
    );
    assert.ok(rows !== null);
    // Another family's scope cannot see the receipt at all.
    const invisible = await storage.read(async (repos) =>
      repos.commandReceipt.findByKey({ familyId: 'fam-b', actorId: 'actor-b' }, { familyId: 'fam-a', actorId: 'actor-a', idempotencyKey: 'k1' }),
    );
    assert.equal(invisible, null);
  } finally {
    await storage.close();
    storage.closeConnection();
  }
});

test('CAS: correct version bumps once, stale version returns null', async () => {
  const storage = new SqliteStorage({ file: ':memory:', now: () => 1 });
  try {
    await storage.tx('seed', async (repos) => {
      await repos.family.insert({ familyId: 'fam-a', actorId: 'x' }, { familyId: 'fam-a', displayName: 'A', createdAt: 1 });
      await repos.guardianActor.insert({ familyId: 'fam-a', actorId: 'x' }, { actorId: 'actor-a', familyId: 'fam-a', displayName: 'G', createdAt: 1 });
      await repos.learner.insert({ familyId: 'fam-a', actorId: 'x' }, { learnerId: 'lrn-a', familyId: 'fam-a', alias: 'a', goalNote: null, status: 'ACTIVE', createdAt: 1 });
      await repos.contentRelease.insert({ familyId: '', actorId: '' }, { releaseId: 'rel-1', status: 'AVAILABLE', courseVersionsJson: '{}', rendererDeclarationsJson: '[]', publicManifestHash: 'h', createdAt: 1, statusChangedAt: 1, statusReason: null });
      await repos.learningAttempt.insert({ familyId: 'fam-a', actorId: 'x' }, { attemptId: 'att-1', familyId: 'fam-a', learnerId: 'lrn-a', releaseId: 'rel-1', attemptStatus: 'ACTIVE', version: 1, previousAttemptId: null, startedAt: 1, endedAt: null, resultSummaryJson: null });
    });
    await storage.tx('cas', async (repos) => {
      const stale = await repos.learningAttempt.updateWithCas(
        { familyId: 'fam-a', actorId: 'x' },
        { attemptId: 'att-1', expectedVersion: 99 },
      );
      assert.equal(stale, null);
      const ok = await repos.learningAttempt.updateWithCas(
        { familyId: 'fam-a', actorId: 'x' },
        { attemptId: 'att-1', expectedVersion: 1, nextStatus: 'PAUSED' },
      );
      assert.ok(ok !== null && ok.version === 2 && ok.attemptStatus === 'PAUSED');
    });
  } finally {
    await storage.close();
    storage.closeConnection();
  }
});

test('prediction is insert-first-only; evaluation is one-per-submission', async () => {
  const storage = new SqliteStorage({ file: ':memory:', now: () => 1 });
  try {
    await storage.tx('seed', async (repos) => {
      await repos.family.insert({ familyId: 'fam-a', actorId: 'x' }, { familyId: 'fam-a', displayName: 'A', createdAt: 1 });
      await repos.guardianActor.insert({ familyId: 'fam-a', actorId: 'x' }, { actorId: 'actor-a', familyId: 'fam-a', displayName: 'G', createdAt: 1 });
      await repos.learner.insert({ familyId: 'fam-a', actorId: 'x' }, { learnerId: 'lrn-a', familyId: 'fam-a', alias: 'a', goalNote: null, status: 'ACTIVE', createdAt: 1 });
      await repos.contentRelease.insert({ familyId: '', actorId: '' }, { releaseId: 'rel-1', status: 'AVAILABLE', courseVersionsJson: '{}', rendererDeclarationsJson: '[]', publicManifestHash: 'h', createdAt: 1, statusChangedAt: 1, statusReason: null });
      await repos.learningAttempt.insert({ familyId: 'fam-a', actorId: 'x' }, { attemptId: 'att-1', familyId: 'fam-a', learnerId: 'lrn-a', releaseId: 'rel-1', attemptStatus: 'ACTIVE', version: 1, previousAttemptId: null, startedAt: 1, endedAt: null, resultSummaryJson: null });
      await repos.questionInstance.insert({ familyId: 'fam-a', actorId: 'x' }, { questionInstanceId: 'qi-1', familyId: 'fam-a', learnerId: 'lrn-a', releaseId: 'rel-1', taskId: 't', taskVersion: '1', paramsJson: '{}', createdAt: 1 });
      await repos.learningCycle.insert({ familyId: 'fam-a', actorId: 'x' }, { cycleId: 'cyc-1', attemptId: 'att-1', questionInstanceId: 'qi-1', phase: 'PREDICT', givensJson: '{}', confirmedStateJson: '{}', stateVersion: 1, lastSeq: 0, createdAt: 1 });
      // First prediction inserts, second is refused.
      assert.equal(
        await repos.prediction.insertFirst({ familyId: 'fam-a', actorId: 'x' }, { cycleId: 'cyc-1', contentJson: '{"claims":[]}', uncertain: true, noteText: null, recordedAt: 1 }),
        'INSERTED',
      );
      assert.equal(
        await repos.prediction.insertFirst({ familyId: 'fam-a', actorId: 'x' }, { cycleId: 'cyc-1', contentJson: '{"claims":[1]}', uncertain: false, noteText: null, recordedAt: 2 }),
        'ALREADY_EXISTS',
      );
      // Submissions + one evaluation per submission (UNIQUE enforced by DDL).
      await repos.submission.insert({ familyId: 'fam-a', actorId: 'x' }, { submissionId: 'sub-1', cycleId: 'cyc-1', stateSnapshotJson: '{}', attemptVersionAtSubmit: 2, responseJson: '[]', assistanceSnapshotJson: '{}', priorSubmissionId: null, submittedBy: 'actor', at: 1 });
      await repos.evaluation.insert({ familyId: 'fam-a', actorId: 'x' }, { evaluationId: 'evl-1', submissionId: 'sub-1', ruleVersion: '1', outcome: 'CORRECT', feedbackJson: '{}', at: 1 });
      await assert.rejects(
        () => repos.evaluation.insert({ familyId: 'fam-a', actorId: 'x' }, { evaluationId: 'evl-2', submissionId: 'sub-1', ruleVersion: '1', outcome: 'CORRECT', feedbackJson: '{}', at: 2 }),
        /UNIQUE/,
      );
      // Event seq is server-monotonic and unique per attempt.
      const e1 = await repos.learningEvent.append({ familyId: 'fam-a', actorId: 'x' }, { attemptId: 'att-1', familyId: 'fam-a', commandKind: 'learning.commitOperation', eventType: 'OPERATION_COMMITTED', payloadJson: '{}', payloadVersion: '1', occurredAt: 1 });
      const e2 = await repos.learningEvent.append({ familyId: 'fam-a', actorId: 'x' }, { attemptId: 'att-1', familyId: 'fam-a', commandKind: 'learning.commitOperation', eventType: 'OPERATION_COMMITTED', payloadJson: '{}', payloadVersion: '1', occurredAt: 2 });
      assert.equal(e2.seq, e1.seq + 1);
    });
  } finally {
    await storage.close();
    storage.closeConnection();
  }
});

test('tx rollback leaves no half-saved rows; close freezes the port', async () => {
  const storage = new SqliteStorage({ file: ':memory:', now: () => 1 });
  await storage.tx('rollback', async (repos) => {
    await repos.family.insert({ familyId: 'fam-a', actorId: 'x' }, { familyId: 'fam-a', displayName: 'A', createdAt: 1 });
    throw new Error('boom');
  }).catch(() => undefined);
  const count = storage.rawDatabase().prepare('SELECT COUNT(*) c FROM family').get() as { c: number };
  assert.equal(count.c, 0);
  const report = await storage.close();
  assert.equal(report.pendingTransactions, 0);
  assert.ok(report.releasedStatements > 0);
  assert.equal(report.walCheckpointed, true);
  await assert.rejects(() => storage.tx('after-close', async () => undefined), /PERSISTENCE_FAILED/);
  await storage.close(); // idempotent
  storage.closeConnection();
});

test('schemaVersion mismatch on open is refused (tampered migrations table)', async () => {
  const { file, dir } = await tempFile();
  try {
    const first = new SqliteStorage({ file, now: () => 1 });
    await first.close();
    first.closeConnection();
    first.rawDatabase(); // connection closed; tamper via a fresh connection
    const { DatabaseSync } = await import('node:sqlite');
    const tamper = new DatabaseSync(file);
    tamper.exec('UPDATE schema_migrations SET version = 7 WHERE version = 1');
    tamper.close();
    // Migrations claim version 2 while schemaVersion.ts pins 1 -> mismatch.
    // Note: the runner treats unknown-higher as applied; the explicit check
    // is what catches it. Simulate by removing our knowledge row instead.
    const tamper2 = new DatabaseSync(file);
    tamper2.exec('UPDATE schema_migrations SET version = 7 WHERE version = 2');
    tamper2.close();
    let threw = false;
    try {
      const second = new SqliteStorage({ file, now: () => 2 });
      await second.close();
      second.closeConnection();
    } catch (err) {
      threw = true;
      assert.ok((err as Error).message.includes('SCHEMA_MISMATCH'));
    }
    assert.ok(threw, 'opening a mismatched schema must fail');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupted database file is never silently replaced', async () => {
  const { file, dir } = await tempFile();
  try {
    const first = new SqliteStorage({ file, now: () => 1 });
    await first.close();
    first.closeConnection();
    // Garble the header so the file is not a database anymore.
    const original = await readFile(file);
    await writeFile(file, Buffer.from('this is definitely not a sqlite database'.repeat(10)));
    let threw = false;
    try {
      const second = new SqliteStorage({ file, now: () => 2 });
      await second.close();
      second.closeConnection();
    } catch {
      threw = true;
    }
    assert.ok(threw, 'opening a corrupted file must throw');
    const after = await readFile(file);
    assert.ok(after.equals(Buffer.from('this is definitely not a sqlite database'.repeat(10))), 'file must be untouched');
    void original;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('VACUUM INTO produces a consistent snapshot with identical rows', async () => {
  const { file, dir } = await tempFile();
  try {
    const storage = new SqliteStorage({ file, now: () => 1 });
    await storage.tx('seed', async (repos) => {
      await repos.family.insert({ familyId: 'fam-a', actorId: 'x' }, { familyId: 'fam-a', displayName: 'A', createdAt: 1 });
    });
    const backupFile = join(dir, 'backup.sqlite');
    backupDatabaseToFile(storage.rawDatabase(), backupFile);
    const { DatabaseSync } = await import('node:sqlite');
    const restored = new DatabaseSync(backupFile);
    const rows = restored.prepare('SELECT COUNT(*) c FROM family').get() as { c: number };
    assert.equal(rows.c, 1);
    const integrity = restored.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    assert.equal(integrity.integrity_check, 'ok');
    restored.close();
    await storage.close();
    storage.closeConnection();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
