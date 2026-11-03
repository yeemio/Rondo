/**
 * Host-maintenance helpers (server-internal, NOT public commands).
 *
 * These implement the surfaces LIFECYCLE §2/§9 requires that have no entry in
 * the frozen 23-command catalogue: local content status transitions (with the
 * REVOKED -> CONTENT_BLOCKED sweep), export completion after the desktop save
 * dialog, export payload assembly for the narrow desktop port, and the
 * rolling-retention sweep at startup. A's composition calls them directly;
 * C never sees them.
 */
import { createHash } from 'node:crypto';
import type { ContentServiceInternal } from '../content';
import { visibilityForPhase } from './ops';
import type { LearningCycleRecord } from '../contracts/server/storage';
import { canonicalize } from '../contracts/public/canonical';
import { rondoError } from '../contracts/public/errors';
import { CONTENT_TRANSITIONS, type ReleaseStatus } from '../contracts/server/content';
import type { StoragePort, Repositories, RepoScope, DataOperationPhase, SubmissionRecord } from '../contracts/server/storage';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Validated content-release status transition (content status machine,
 * LIFECYCLE §2). Transitioning a published release to REVOKED marks every
 * ACTIVE/PAUSED attempt bound to it CONTENT_BLOCKED in the same transaction,
 * appending a CONTENT_BLOCKED event per attempt.
 */
export async function applyReleaseStatusChange(
  storage: StoragePort,
  now: () => number,
  input: { releaseId: string; to: ReleaseStatus; reason: string | null },
): Promise<void> {
  await storage.tx('content.statusChange', async (repos) => {
    const release = await repos.contentRelease.findById({ familyId: '', actorId: '' }, input.releaseId);
    if (release === null) {
      throw rondoError('CONTENT_UNAVAILABLE', `未知 release：${input.releaseId}`);
    }
    if (!CONTENT_TRANSITIONS[release.status].includes(input.to)) {
      throw rondoError('INVALID_OPERATION', `内容状态机不允许 ${release.status} -> ${input.to}。`);
    }
    const ok = await repos.contentRelease.updateStatus(
      { familyId: '', actorId: '' },
      { releaseId: input.releaseId, from: release.status, to: input.to, reason: input.reason },
    );
    if (!ok) {
      throw rondoError('PERSISTENCE_FAILED', '内容状态更新失败，事务已回滚。');
    }
    if (input.to === 'REVOKED') {
      const sweepCapable = repos.learningAttempt as Repositories['learningAttempt'] & {
        listNonTerminalUnscoped?: (statuses: readonly ('ACTIVE' | 'PAUSED')[]) => Promise<
          { attemptId: string; familyId: string; learnerId: string; releaseId: string; version: number }[]
        >;
      };
      if (typeof sweepCapable.listNonTerminalUnscoped !== 'function') {
        throw rondoError('PERSISTENCE_FAILED', 'storage lacks the revocation sweep seam');
      }
      const active = await sweepCapable.listNonTerminalUnscoped(['ACTIVE', 'PAUSED']);
      for (const attempt of active) {
        if (attempt.releaseId !== input.releaseId) continue;
        const scope: RepoScope = { familyId: attempt.familyId, actorId: 'host-content-maintenance' };
        const updated = await repos.learningAttempt.updateWithCas(scope, {
          attemptId: attempt.attemptId,
          expectedVersion: attempt.version,
          nextStatus: 'CONTENT_BLOCKED',
          endAttempt: true,
        });
        if (updated === null) continue; // raced with a concurrent transition; next sweep catches it
        await repos.learningEvent.append(scope, {
          attemptId: attempt.attemptId,
          familyId: attempt.familyId,
          commandKind: 'learning.pauseAttempt', // closest catalogue kind for a host-forced state change
          eventType: 'CONTENT_BLOCKED',
          payloadJson: canonicalize({ releaseId: input.releaseId, reason: input.reason }),
          payloadVersion: '1',
          occurredAt: now(),
        });
      }
    }
  });
}

/** Completes an export after the desktop save dialog (A calls this with the save outcome). */
export async function finishExport(
  storage: StoragePort,
  scope: RepoScope,
  input: { opId: string; outcome: 'COMPLETED' | 'CONFIRMED_FAILED' | 'FAILED'; savedToLabel?: string },
): Promise<void> {
  await storage.tx('export.finish', async (repos) => {
    const op = await repos.dataOperation.findById(scope, input.opId);
    if (op === null || op.kind !== 'EXPORT') {
      throw rondoError('INVALID_OPERATION', `未知的导出操作：${input.opId}`);
    }
    if (op.phase !== 'CONFIRMED') {
      throw rondoError('INVALID_OPERATION', `导出操作当前阶段 ${op.phase}，不能收尾。`);
    }
    const resultJson =
      input.outcome === 'COMPLETED'
        ? canonicalize({ saved: true, savedToLabel: input.savedToLabel ?? null })
        : canonicalize({ saved: false, reason: input.outcome });
    const ok = await repos.dataOperation.updatePhase(scope, {
      opId: input.opId,
      phase: input.outcome as DataOperationPhase,
      resultJson,
    });
    if (!ok) {
      throw rondoError('PERSISTENCE_FAILED', '导出收尾失败，事务已回滚。');
    }
  });
}

/** Closed event projection: never serialize server-internal event objects wholesale. */
function publicExportEvent(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const keys: Record<string, readonly string[]> = {
    ATTEMPT_STARTED: ['releaseId', 'taskId', 'givens'], CYCLE_BEGUN: ['cycleId', 'taskId', 'givens'],
    PREDICTION_RECORDED: ['cycleId', 'uncertain', 'claimCount', 'predictionCarrier'],
    OPERATION_COMMITTED: ['cycleId', 'operation', 'stateAfter'], RESPONSE_REVISE_OPENED: ['cycleId'],
    SUBMISSION_RECORDED: ['cycleId', 'submissionId', 'evaluationId', 'outcome'],
    HINT_PRESENTED: ['cycleId', 'level', 'revealsAnswer'], EXPLANATION_BEGUN: ['cycleId'],
    EXPLANATION_SAVED: ['cycleId', 'revisionId', 'scribe'], ATTEMPT_FINISHED: ['summary'],
    ASSISTANCE_RECORDED: ['recordId', 'category', 'targetRef'], CONTENT_BLOCKED: ['releaseId', 'reason'],
  };
  if (type === 'CODE_RUN_STATUS') {
    const run = payload.run as Record<string, unknown> | undefined;
    return run ? pick(run, ['jobId', 'attemptId', 'cycleId', 'questionInstanceId', 'taskId', 'source', 'stdin', 'status', 'terminal', 'stdout', 'stderr', 'createdAt', 'updatedAt']) : {};
  }
  return pick(payload, keys[type] ?? []);
}
function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

export const EXPORT_CATEGORIES = [
  'ALIASES',
  'CONTENT_VERSIONS',
  'PROCESS',
  'SUBMISSIONS',
  'FEEDBACK',
  'EXPLANATIONS',
  'GUARDIAN_ANNOTATIONS',
] as const;
export type ExportCategory = (typeof EXPORT_CATEGORIES)[number];

/**
 * Builds the minimal family export payload (LIFECYCLE §9): aliases, public
 * content versions, learning process, submissions, published feedback,
 * explanations and guardian annotations. Credentials, private rules/tests,
 * other families and control records are never included.
 */
export async function buildExportPayload(
  storage: StoragePort,
  scope: RepoScope,
  opId: string,
  now: () => number,
  publicContent: Pick<ContentServiceInternal, 'getPublicQuestionSpecFor'>,
): Promise<{ schemaVersion: number; generatedAt: number; scopeHash: string; categories: Record<string, unknown> }> {
  return storage.read(async (repos) => {
    const op = await repos.dataOperation.findById(scope, opId);
    if (op === null || op.kind !== 'EXPORT') {
      throw rondoError('INVALID_OPERATION', `未知的导出操作：${opId}`);
    }
    if (!['CONFIRMED', 'COMPLETED'].includes(op.phase)) {
      throw rondoError('INVALID_OPERATION', '请先确认导出范围。');
    }
    const declared = (JSON.parse(op.scopeJson) as { categories: ExportCategory[] }).categories;
    const categories: Record<string, unknown> = {};
    if (declared.includes('ALIASES')) {
      const learners = await repos.learner.listByFamily(scope, scope.familyId);
      categories.ALIASES = learners.map((l) => ({
        learnerId: l.learnerId,
        alias: l.alias,
        goalNote: l.goalNote,
        createdAt: l.createdAt,
      }));
    }
    const learners = await repos.learner.listByFamily(scope, scope.familyId);
    const attempts = [];
    for (const learner of learners) {
      attempts.push(...(await repos.learningAttempt.listByLearner(scope, learner.learnerId)));
    }
    if (declared.includes('CONTENT_VERSIONS')) {
      const listCycles = repos.learningCycle as Repositories['learningCycle'] & {
        listByAttempt?: (scope: RepoScope, attemptId: string) => Promise<LearningCycleRecord[]>;
      };
      if (!listCycles.listByAttempt) throw rondoError('PERSISTENCE_FAILED', 'storage lacks export cycle listing');
      const versions = [];
      for (const releaseId of new Set(attempts.map((a) => a.releaseId))) {
        const release = await repos.contentRelease.findById({ familyId: '', actorId: '' }, releaseId);
        if (!release) throw rondoError('CONTENT_UNAVAILABLE', '导出涉及的内容版本不可用。');
        const tasks = [];
        for (const attempt of attempts.filter((a) => a.releaseId === releaseId)) {
          for (const cycle of await listCycles.listByAttempt(scope, attempt.attemptId)) {
            const q = await repos.questionInstance.findById(scope, cycle.questionInstanceId);
            if (!q) throw rondoError('CONTENT_UNAVAILABLE', '导出涉及的公开题目不可用。');
            // Same public projection as learning.questionView, using this cycle's earned visibility.
            const publicQuestion = publicContent.getPublicQuestionSpecFor(q, visibilityForPhase(cycle.phase));
            tasks.push({ questionInstanceId: q.questionInstanceId, learnerId: q.learnerId, taskId: q.taskId,
              taskVersion: q.taskVersion, cycleId: cycle.cycleId, publicQuestion });
          }
        }
        versions.push({ releaseId, status: release.status, courseVersions: JSON.parse(release.courseVersionsJson),
          publicManifestHash: release.publicManifestHash, tasks,
          attempts: attempts.filter((a) => a.releaseId === releaseId).map((a) => ({
            attemptId: a.attemptId, learnerId: a.learnerId, status: a.attemptStatus, startedAt: a.startedAt, endedAt: a.endedAt,
          })),
        });
      }
      categories.CONTENT_VERSIONS = versions;
    }
    if (declared.includes('PROCESS')) {
      const process = [];
      for (const attempt of attempts) {
        const events = await repos.learningEvent.pageBySeq(scope, { attemptId: attempt.attemptId, afterSeq: 0, limit: 1000000 });
        process.push(
          ...events.map((e) => ({
            attemptId: e.attemptId,
            seq: e.seq,
            eventType: e.eventType,
            payload: publicExportEvent(e.eventType, JSON.parse(e.payloadJson)),
            payloadVersion: e.payloadVersion,
            occurredAt: e.occurredAt,
          })),
        );
      }
      categories.PROCESS = process;
    }
    if (declared.includes('SUBMISSIONS') || declared.includes('FEEDBACK') || declared.includes('EXPLANATIONS') || declared.includes('GUARDIAN_ANNOTATIONS')) {
      const listCycles = repos.learningCycle as unknown as {
        listByAttempt?: (scope: RepoScope, attemptId: string) => Promise<{ cycleId: string; questionInstanceId: string }[]>;
      };
      const listSubs = repos.submission as unknown as {
        listAllByCycle?: (scope: RepoScope, cycleId: string) => Promise<SubmissionRecord[]>;
      };
      if (typeof listCycles.listByAttempt !== 'function' || typeof listSubs.listAllByCycle !== 'function') {
        throw rondoError('PERSISTENCE_FAILED', 'storage lacks export listing seams');
      }
      if (declared.includes('SUBMISSIONS')) {
        const subs = [];
        for (const attempt of attempts) {
          for (const cycle of await listCycles.listByAttempt(scope, attempt.attemptId)) {
            subs.push(...(await listSubs.listAllByCycle(scope, cycle.cycleId)).map((sub) => ({
              submissionId: sub.submissionId, cycleId: sub.cycleId,
              stateSnapshot: JSON.parse(sub.stateSnapshotJson), response: JSON.parse(sub.responseJson),
              assistanceSnapshot: JSON.parse(sub.assistanceSnapshotJson),
              attemptVersionAtSubmit: sub.attemptVersionAtSubmit, priorSubmissionId: sub.priorSubmissionId, at: sub.at,
            })));
          }
        }
        categories.SUBMISSIONS = subs;
      }
      if (declared.includes('FEEDBACK') || declared.includes('EXPLANATIONS') || declared.includes('GUARDIAN_ANNOTATIONS')) {
        const feedback = [];
        const explanations = [];
        const annotations = [];
        for (const attempt of attempts) {
          for (const cycle of await listCycles.listByAttempt(scope, attempt.attemptId)) {
            for (const sub of (await listSubs.listAllByCycle(scope, cycle.cycleId)) as { submissionId: string }[]) {
              if (declared.includes('FEEDBACK')) {
                const evaluation = await repos.evaluation.findOriginalBySubmission(scope, sub.submissionId);
                if (evaluation !== null) {
                  feedback.push({
                    submissionId: evaluation.submissionId,
                    outcome: evaluation.outcome,
                    feedback: JSON.parse(evaluation.feedbackJson),
                    ruleVersion: evaluation.ruleVersion,
                    at: evaluation.at,
                  });
                }
              }
            }
            if (declared.includes('EXPLANATIONS') || declared.includes('GUARDIAN_ANNOTATIONS')) {
              for (const explanation of await repos.explanationRevision.listByCycle(scope, cycle.cycleId)) {
                if (declared.includes('EXPLANATIONS')) {
                  explanations.push({
                    revisionId: explanation.revisionId,
                    cycleId: explanation.cycleId,
                    structured: JSON.parse(explanation.structuredJson),
                    freeText: explanation.freeText,
                    scribe: explanation.scribe,
                    at: explanation.at,
                  });
                }
                if (declared.includes('GUARDIAN_ANNOTATIONS')) {
                  for (const observation of await repos.guardianObservation.listByExplanationRevision(scope, explanation.revisionId)) {
                    annotations.push({
                      observationId: observation.observationId,
                      explanationRevisionRef: observation.explanationRevisionRef,
                      rubric: {
                        condition: observation.conditionObserved,
                        relation: observation.relationObserved,
                        basis: observation.basisObserved,
                      },
                      at: observation.at,
                    });
                  }
                }
              }
            }
          }
          if (declared.includes('GUARDIAN_ANNOTATIONS')) {
            for (const record of await repos.assistanceRecord.listByAttempt(scope, attempt.attemptId)) {
              annotations.push({
                recordId: record.recordId,
                attemptId: record.attemptId,
                targetRef: record.targetRef,
                category: record.category,
                note: record.note,
                at: record.at,
              });
            }
          }
        }
        if (declared.includes('FEEDBACK')) categories.FEEDBACK = feedback;
        if (declared.includes('EXPLANATIONS')) categories.EXPLANATIONS = explanations;
        if (declared.includes('GUARDIAN_ANNOTATIONS')) categories.GUARDIAN_ANNOTATIONS = annotations;
      }
    }
    return {
      schemaVersion: 1,
      generatedAt: now(),
      scopeHash: op.scopeHash,
      categories,
    };
  });
}

/**
 * Rolling-retention sweep (host startup maintenance; LIFECYCLE §9: a running
 * App only claims cleanup it actually performed). Deletes terminal attempts
 * past the family's rolling window and records a dataOperation tombstone
 * whose result carries counts only -- never child text.
 */
export async function applyRollingRetention(
  storage: StoragePort,
  input: { asOf: number; newOpId: () => string },
): Promise<{ familiesSwept: number; deletedAttempts: string[] }> {
  const disposalCapable = storage as StoragePort & { dispose?: (spec: unknown) => { deleted: Record<string, number> } };
  if (typeof disposalCapable.dispose !== 'function') {
    throw rondoError('PERSISTENCE_FAILED', 'storage lacks disposal capability');
  }
  const newOpId = input.newOpId;
  const dispose = disposalCapable.dispose.bind(disposalCapable);
  const deletedAttempts: string[] = [];
  let familiesSwept = 0;
  await storage.tx('retention.sweep', async (repos) => {
    const familyCapable = repos.family as unknown as { listAll?: () => Promise<{ familyId: string }[]> };
    if (typeof familyCapable.listAll !== 'function') {
      throw rondoError('PERSISTENCE_FAILED', 'storage lacks family listing seam');
    }
    const families = await familyCapable.listAll();
    for (const family of families) {
      const scope: RepoScope = { familyId: family.familyId, actorId: 'host-retention-sweep' };
      const policy = await repos.retentionPolicy.find(scope, family.familyId);
      if (policy === null || policy.mode !== 'ROLLING_DAYS' || policy.rollingDays === null) continue;
      const cutoff = input.asOf - policy.rollingDays * 24 * 60 * 60 * 1000;
      const learners = await repos.learner.listByFamily(scope, family.familyId);
      const affected: string[] = [];
      for (const learner of learners) {
        const attempts = await repos.learningAttempt.listByLearner(scope, learner.learnerId);
        for (const attempt of attempts) {
          if (attempt.attemptStatus === 'ACTIVE' || attempt.attemptStatus === 'PAUSED') continue;
          const events = await repos.learningEvent.pageBySeq(scope, { attemptId: attempt.attemptId, afterSeq: 0, limit: 1000000 });
          const lastActivity = Math.max(attempt.startedAt, attempt.endedAt ?? 0, ...events.map((e) => e.occurredAt));
          if (lastActivity < cutoff) affected.push(attempt.attemptId);
        }
      }
      if (affected.length === 0) continue;
      familiesSwept += 1;
      const scopeJson = canonicalize({ retentionSweep: true, cutoff, attemptIds: affected });
      await repos.dataOperation.insert(scope, {
        opId: newOpId(),
        familyId: family.familyId,
        kind: 'DELETION',
        scopeJson,
        scopeHash: sha256Hex(scopeJson),
        phase: 'COMPLETED',
        resultJson: canonicalize({ deletedAttempts: affected.length }),
        preparedAt: input.asOf,
        confirmedAt: input.asOf,
      });
      for (const attemptId of affected) {
        dispose({ kind: 'ATTEMPT', familyId: family.familyId, attemptId });
        deletedAttempts.push(attemptId);
      }
    }
  });
  return { familiesSwept, deletedAttempts };
}
