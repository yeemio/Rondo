/**
 * Data-disposal SQL (export/deletion confirm phase; B-D9 single transaction).
 *
 * All statements delete only rows inside the authenticated family scope and
 * run strictly inside the caller's write transaction (asserted by the
 * storage port). Deletion order respects the FK graph (children first).
 * The dataOperation tombstone row itself is written by the caller and never
 * contains child text.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonicalize } from '../../modules/contracts/public/canonical';
import type { DeletionScope } from '../../modules/contracts/public/queries';

export type DisposalSpec =
  | { readonly kind: 'FAMILY_ALL'; readonly familyId: string }
  | { readonly kind: 'LEARNER'; readonly familyId: string; readonly learnerId: string }
  | { readonly kind: 'ATTEMPT'; readonly familyId: string; readonly attemptId: string };

export interface DisposalResult {
  /** table -> deleted row count; never contains any child content. */
  readonly deleted: Readonly<Record<string, number>>;
}

/** Read exactly the business rows disposal will remove. Session/receipt churn is not a scope change. */
export function inspectDeletionScope(db: DatabaseSync, spec: DisposalSpec): { scope: DeletionScope; fingerprint: string } {
  const family = spec.familyId;
  const params = spec.kind === 'FAMILY_ALL' ? [family] : [family, spec.kind === 'LEARNER' ? spec.learnerId : spec.attemptId];
  const attempts = `SELECT * FROM learningAttempt WHERE familyId = ?${spec.kind === 'LEARNER' ? ' AND learnerId = ?' : spec.kind === 'ATTEMPT' ? ' AND attemptId = ?' : ''}`;
  const attemptIds = `SELECT attemptId FROM (${attempts})`;
  const cycles = `SELECT c.* FROM learningCycle c WHERE c.attemptId IN (${attemptIds})`;
  const cycleIds = `SELECT cycleId FROM (${cycles})`;
  const submissions = `SELECT s.* FROM submission s WHERE s.cycleId IN (${cycleIds})`;
  const explanations = `SELECT x.* FROM explanationRevision x WHERE x.cycleId IN (${cycleIds})`;
  const instances = spec.kind === 'ATTEMPT'
    ? `SELECT q.* FROM questionInstance q WHERE q.questionInstanceId IN (SELECT questionInstanceId FROM (${cycles}))`
    : `SELECT * FROM questionInstance WHERE familyId = ?${spec.kind === 'LEARNER' ? ' AND learnerId = ?' : ''}`;
  const learnerSql = spec.kind === 'ATTEMPT'
    ? `SELECT * FROM learner WHERE learnerId IN (SELECT learnerId FROM (${attempts}))`
    : `SELECT * FROM learner WHERE familyId = ?${spec.kind === 'LEARNER' ? ' AND learnerId = ?' : ''}`;
  const rows = (sql: string, values: (string | number)[] = params): Record<string, unknown>[] =>
    (db.prepare(sql).all(...values) as Record<string, unknown>[]).sort((a, b) => canonicalize(a).localeCompare(canonicalize(b)));
  const learners = rows(learnerSql);
  const facts: Record<string, Record<string, unknown>[]> = {
    learningAttempt: rows(attempts), learningCycle: rows(cycles), questionInstance: rows(instances),
    prediction: rows(`SELECT * FROM prediction WHERE cycleId IN (${cycleIds})`),
    hintPresentation: rows(`SELECT * FROM hintPresentation WHERE cycleId IN (${cycleIds})`),
    learningEvent: rows(`SELECT * FROM learningEvent WHERE attemptId IN (${attemptIds})`),
    submission: rows(submissions),
    evaluation: rows(`SELECT * FROM evaluation WHERE submissionId IN (SELECT submissionId FROM (${submissions}))`),
    explanationRevision: rows(explanations),
    guardianObservation: rows(`SELECT * FROM guardianObservation WHERE explanationRevisionRef IN (SELECT revisionId FROM (${explanations}))`),
    assistanceRecord: rows(`SELECT * FROM assistanceRecord WHERE attemptId IN (${attemptIds})`),
    transferPlan: spec.kind === 'FAMILY_ALL'
      ? rows('SELECT * FROM transferPlan WHERE familyId = ?')
      : spec.kind === 'LEARNER'
        ? rows(`SELECT * FROM transferPlan WHERE familyId = ? AND (learnerId = ? OR observedInstanceId IN (SELECT questionInstanceId FROM (${instances})))`, [...params, ...params])
        : rows(`SELECT * FROM transferPlan WHERE familyId = ? AND observedInstanceId IN (SELECT questionInstanceId FROM (${instances}))`, [family, ...params]),
    learner: spec.kind === 'ATTEMPT' ? [] : learners,
    retentionPolicy: spec.kind === 'FAMILY_ALL' ? rows('SELECT * FROM retentionPolicy WHERE familyId = ?') : [],
  };
  const scope: DeletionScope = {
    target: spec.kind === 'FAMILY_ALL' ? 'ALL_FAMILY_DATA' : spec.kind,
    targetId: spec.kind === 'FAMILY_ALL' ? null : spec.kind === 'LEARNER' ? spec.learnerId : spec.attemptId,
    learners: learners.map((l) => ({ learnerId: String(l.learnerId), alias: String(l.alias) })),
    attempts: facts.learningAttempt.map((a) => ({ attemptId: String(a.attemptId), learnerId: String(a.learnerId),
      releaseId: String(a.releaseId), status: a.attemptStatus as DeletionScope['attempts'][number]['status'],
      startedAtMs: Number(a.startedAt), endedAtMs: a.endedAt === null ? null : Number(a.endedAt) })),
    counts: Object.fromEntries(Object.entries(facts).map(([table, values]) => [table, values.length])),
  };
  return { scope, fingerprint: createHash('sha256').update(canonicalize({ family, spec, learners, facts })).digest('hex') };
}

function run(db: DatabaseSync, sql: string, params: (string | number | null)[]): number {
  return db.prepare(sql).run(...params).changes as number;
}

function deleteAttemptSubtree(db: DatabaseSync, familyId: string, attemptIds: string[]): DisposalResult {
  const deleted: Record<string, number> = {};
  if (attemptIds.length === 0) return { deleted };
  attemptIds = (db.prepare(`SELECT attemptId FROM learningAttempt WHERE familyId = ? AND attemptId IN (${attemptIds.map(() => '?').join(', ')})`)
    .all(familyId, ...attemptIds) as { attemptId: string }[]).map((r) => r.attemptId);
  if (attemptIds.length === 0) return { deleted };
  const inList = attemptIds.map(() => '?').join(', ');
  // transferPlan.observedInstanceId -> questionInstance (defensive; no plans exist in v1)
  deleted.transferPlan = run(
    db,
    `DELETE FROM transferPlan WHERE familyId = ? AND observedInstanceId IN
       (SELECT c.questionInstanceId FROM learningCycle c WHERE c.attemptId IN (${inList}))`,
    [familyId, ...attemptIds],
  );
  deleted.evaluation = run(
    db,
    `DELETE FROM evaluation WHERE submissionId IN
       (SELECT s.submissionId FROM submission s JOIN learningCycle c ON c.cycleId = s.cycleId WHERE c.attemptId IN (${inList}))`,
    attemptIds,
  );
  deleted.submission = run(
    db,
    `DELETE FROM submission WHERE cycleId IN (SELECT cycleId FROM learningCycle WHERE attemptId IN (${inList}))`,
    attemptIds,
  );
  deleted.guardianObservation = run(
    db,
    `DELETE FROM guardianObservation WHERE explanationRevisionRef IN
       (SELECT x.revisionId FROM explanationRevision x JOIN learningCycle c ON c.cycleId = x.cycleId WHERE c.attemptId IN (${inList}))`,
    attemptIds,
  );
  deleted.explanationRevision = run(
    db,
    `DELETE FROM explanationRevision WHERE cycleId IN (SELECT cycleId FROM learningCycle WHERE attemptId IN (${inList}))`,
    attemptIds,
  );
  deleted.assistanceRecord = run(db, `DELETE FROM assistanceRecord WHERE familyId = ? AND attemptId IN (${inList})`, [
    familyId,
    ...attemptIds,
  ]);
  deleted.hintPresentation = run(
    db,
    `DELETE FROM hintPresentation WHERE cycleId IN (SELECT cycleId FROM learningCycle WHERE attemptId IN (${inList}))`,
    attemptIds,
  );
  deleted.prediction = run(
    db,
    `DELETE FROM prediction WHERE cycleId IN (SELECT cycleId FROM learningCycle WHERE attemptId IN (${inList}))`,
    attemptIds,
  );
  deleted.learningEvent = run(db, `DELETE FROM learningEvent WHERE familyId = ? AND attemptId IN (${inList})`, [
    familyId,
    ...attemptIds,
  ]);
  // Cycles must go before their question instances (learningCycle.questionInstanceId FK);
  // the instance ids are captured before the cycle rows disappear.
  const instanceIds = (
    db.prepare(`SELECT DISTINCT questionInstanceId FROM learningCycle WHERE attemptId IN (${inList})`).all(...attemptIds) as {
      questionInstanceId: string;
    }[]
  ).map((r) => r.questionInstanceId);
  deleted.learningCycle = run(db, `DELETE FROM learningCycle WHERE attemptId IN (${inList})`, attemptIds);
  deleted.questionInstance =
    instanceIds.length === 0
      ? 0
      : run(
          db,
          `DELETE FROM questionInstance WHERE familyId = ? AND questionInstanceId IN (${instanceIds.map(() => '?').join(', ')})`,
          [familyId, ...instanceIds],
        );
  // previousAttemptId REFERENCES learningAttempt (R2 attempt chaining): a
  // surviving successor's chain anchor is provenance metadata only, so it is
  // nulled when its predecessor is deleted -- otherwise the FK would block
  // removing aged-out terminal attempts. Invariant restoration, not counted
  // as a deleted row.
  run(
    db,
    `UPDATE learningAttempt SET previousAttemptId = NULL
       WHERE familyId = ? AND previousAttemptId IN (${inList})`,
    [familyId, ...attemptIds],
  );
  deleted.learningAttempt = run(db, `DELETE FROM learningAttempt WHERE familyId = ? AND attemptId IN (${inList})`, [
    familyId,
    ...attemptIds,
  ]);
  return { deleted };
}

export function executeDisposal(db: DatabaseSync, spec: DisposalSpec): DisposalResult {
  switch (spec.kind) {
    case 'ATTEMPT':
      return deleteAttemptSubtree(db, spec.familyId, [spec.attemptId]);
    case 'LEARNER': {
      const deleted: Record<string, number> = {};
      const attemptIds = (
        db.prepare('SELECT attemptId FROM learningAttempt WHERE familyId = ? AND learnerId = ?').all(spec.familyId, spec.learnerId) as {
          attemptId: string;
        }[]
      ).map((r) => r.attemptId);
      const subtree = deleteAttemptSubtree(db, spec.familyId, attemptIds);
      Object.assign(deleted, subtree.deleted);
      // Learner-scoped sessions must go before the learner row (FK).
      deleted.hostSession = run(db, 'DELETE FROM hostSession WHERE familyId = ? AND learnerId = ?', [
        spec.familyId,
        spec.learnerId,
      ]);
      deleted.transferPlan = (deleted.transferPlan ?? 0) + run(db, 'DELETE FROM transferPlan WHERE familyId = ? AND learnerId = ?', [
        spec.familyId,
        spec.learnerId,
      ]);
      deleted.questionInstance =
        (deleted.questionInstance ?? 0) +
        run(db, 'DELETE FROM questionInstance WHERE familyId = ? AND learnerId = ?', [spec.familyId, spec.learnerId]);
      // Idempotency receipts of the learner's derived actor reference nothing
      // else after the facts are gone; removing them keeps replay from
      // resurrecting receipts about deleted data.
      deleted.commandReceipt = run(
        db,
        "DELETE FROM commandReceipt WHERE familyId = ? AND actorId = ? AND actorId LIKE 'learner-actor:%'",
        [spec.familyId, `learner-actor:${spec.learnerId}`],
      );
      deleted.learner = run(db, 'DELETE FROM learner WHERE familyId = ? AND learnerId = ?', [spec.familyId, spec.learnerId]);
      return { deleted };
    }
    case 'FAMILY_ALL': {
      const deleted: Record<string, number> = {};
      const attemptIds = (db.prepare('SELECT attemptId FROM learningAttempt WHERE familyId = ?').all(spec.familyId) as {
        attemptId: string;
      }[]).map((r) => r.attemptId);
      const subtree = deleteAttemptSubtree(db, spec.familyId, attemptIds);
      Object.assign(deleted, subtree.deleted);
      deleted.learningEvent = (deleted.learningEvent ?? 0) + run(db, 'DELETE FROM learningEvent WHERE familyId = ?', [spec.familyId]);
      deleted.assistanceRecord =
        (deleted.assistanceRecord ?? 0) + run(db, 'DELETE FROM assistanceRecord WHERE familyId = ?', [spec.familyId]);
      deleted.transferPlan = (deleted.transferPlan ?? 0) + run(db, 'DELETE FROM transferPlan WHERE familyId = ?', [spec.familyId]);
      deleted.questionInstance =
        (deleted.questionInstance ?? 0) + run(db, 'DELETE FROM questionInstance WHERE familyId = ?', [spec.familyId]);
      deleted.hostSession = run(db, 'DELETE FROM hostSession WHERE familyId = ?', [spec.familyId]);
      // Content-free deletion receipts remain recoverable across a later family deletion.
      deleted.commandReceipt = run(db, "DELETE FROM commandReceipt WHERE familyId = ? AND kind <> 'guardian.confirmDeletion'", [spec.familyId]);
      deleted.retentionPolicy = run(db, 'DELETE FROM retentionPolicy WHERE familyId = ?', [spec.familyId]);
      deleted.learner = run(db, 'DELETE FROM learner WHERE familyId = ?', [spec.familyId]);
      // The family row, guardian actors and the guardian credential stay:
      // dataOperation.familyId references family (the deletion tombstone must
      // survive), and the guardian auth root is what lets the family log in to
      // see the deleted state. Child learning data is fully gone.
      return { deleted };
    }
  }
}
