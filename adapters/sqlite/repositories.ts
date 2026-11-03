/**
 * Typed repositories for the 21 business tables of schema/0001_init.sql.
 *
 * Frozen sources:
 * - modules/contracts/server/storage.ts (ports; every method carries RepoScope)
 * - LIFECYCLE-DATA-API.md §7 (all repository methods carry authenticated
 *   scope; cross-family objects are uniformly FORBIDDEN-invisible; bound
 *   parameters only; server-generated ids; no DDL in repositories)
 * - B-D1 (learningAttempt.version is the single CAS point; the adapter owns
 *   the bump, callers never write version)
 *
 * Scope discipline per table group:
 * - family/guardianActor/learner/learningAttempt/questionInstance/dataOperation/
 *   transferPlan/commandReceipt: rows whose familyId differs from the scope are
 *   invisible (find* returns null / excludes them).
 * - learningCycle/prediction/hintPresentation/submission/evaluation/
 *   explanationRevision/guardianObservation: no family column of their own --
 *   reads join up to learningAttempt and enforce the family there.
 * - contentRelease: global server registry (not family data); scope unused.
 * - hostSession: the authentication bootstrap table. findActive looks the
 *   session up by sessionId/hostEpoch -- the session row is where the family
 *   scope comes FROM, so it cannot be pre-filtered by one. Callers must still
 *   check expiresAt against the current clock (the port signature has no now).
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  AssistanceCategory,
  AssistanceRecordRecord,
  CommandReceiptRecord,
  ContentReleaseRecord,
  DataOperationPhase,
  DataOperationRecord,
  EvaluationRecord,
  ExplanationRevisionRecord,
  FamilyRecord,
  GuardianActorRecord,
  GuardianCredentialRecord,
  GuardianObservationRecord,
  HintPresentationRecord,
  HostSessionRecord,
  LearnerRecord,
  LearnerStatus,
  LearningAttemptRecord,
  LearningCycleRecord,
  LearningEventRecord,
  PredictionRecord,
  RepoScope,
  RetentionPolicyRecord,
  SubmissionRecord,
  TransferPlanRecord,
  TransferPlanStatus,
} from '../../modules/contracts/server/storage';
import type { AttemptStatus, CyclePhase } from '../../modules/contracts/public/queries';
import type { CommandKind } from '../../modules/contracts/public/envelope';
import type { ReleaseStatus } from '../../modules/contracts/server/content';
import { inspectDeletionScope, type DisposalSpec } from './disposal';

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  return row[key] as string;
}
function num(row: Row, key: string): number {
  return row[key] as number;
}
function numOrNull(row: Row, key: string): number | null {
  const v = row[key];
  return v === null || v === undefined ? null : (v as number);
}
function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined ? null : (v as string);
}
function bool(row: Row, key: string): boolean {
  return row[key] === 1;
}

function mapFamily(row: Row): FamilyRecord {
  return { familyId: str(row, 'familyId'), displayName: str(row, 'displayName'), createdAt: num(row, 'createdAt') };
}
function mapGuardianActor(row: Row): GuardianActorRecord {
  return {
    actorId: str(row, 'actorId'),
    familyId: str(row, 'familyId'),
    displayName: str(row, 'displayName'),
    createdAt: num(row, 'createdAt'),
  };
}
function mapGuardianCredential(row: Row): GuardianCredentialRecord {
  return {
    familyId: str(row, 'familyId'),
    algorithm: 'scrypt',
    paramsJson: str(row, 'paramsJson'),
    salt: str(row, 'salt'),
    derivedKey: str(row, 'derivedKey'),
    failedAttempts: num(row, 'failedAttempts'),
    lockUntil: numOrNull(row, 'lockUntil'),
  };
}
function mapLearner(row: Row): LearnerRecord {
  return {
    learnerId: str(row, 'learnerId'),
    familyId: str(row, 'familyId'),
    alias: str(row, 'alias'),
    goalNote: strOrNull(row, 'goalNote'),
    status: str(row, 'status') as LearnerStatus,
    createdAt: num(row, 'createdAt'),
  };
}
function mapHostSession(row: Row): HostSessionRecord {
  return {
    sessionId: str(row, 'sessionId'),
    familyId: str(row, 'familyId'),
    role: str(row, 'role') as HostSessionRecord['role'],
    guardianActorId: strOrNull(row, 'guardianActorId'),
    learnerId: strOrNull(row, 'learnerId'),
    windowRef: str(row, 'windowRef'),
    hostEpoch: str(row, 'hostEpoch'),
    issuedAt: num(row, 'issuedAt'),
    expiresAt: num(row, 'expiresAt'),
    revokedAt: numOrNull(row, 'revokedAt'),
    revocationVersion: num(row, 'revocationVersion'),
  };
}
function mapContentRelease(row: Row): ContentReleaseRecord {
  return {
    releaseId: str(row, 'releaseId'),
    status: str(row, 'status') as ReleaseStatus,
    courseVersionsJson: str(row, 'courseVersionsJson'),
    rendererDeclarationsJson: str(row, 'rendererDeclarationsJson'),
    publicManifestHash: str(row, 'publicManifestHash'),
    createdAt: num(row, 'createdAt'),
    statusChangedAt: num(row, 'statusChangedAt'),
    statusReason: strOrNull(row, 'statusReason'),
  };
}
function mapQuestionInstance(row: Row): import('../../modules/contracts/server/storage').QuestionInstanceRecord {
  return {
    questionInstanceId: str(row, 'questionInstanceId'),
    familyId: str(row, 'familyId'),
    learnerId: str(row, 'learnerId'),
    releaseId: str(row, 'releaseId'),
    taskId: str(row, 'taskId'),
    taskVersion: str(row, 'taskVersion'),
    paramsJson: str(row, 'paramsJson'),
    createdAt: num(row, 'createdAt'),
  };
}
function mapAttempt(row: Row): LearningAttemptRecord {
  return {
    attemptId: str(row, 'attemptId'),
    familyId: str(row, 'familyId'),
    learnerId: str(row, 'learnerId'),
    releaseId: str(row, 'releaseId'),
    attemptStatus: str(row, 'attemptStatus') as AttemptStatus,
    version: num(row, 'version'),
    previousAttemptId: strOrNull(row, 'previousAttemptId'),
    startedAt: num(row, 'startedAt'),
    endedAt: numOrNull(row, 'endedAt'),
    resultSummaryJson: strOrNull(row, 'resultSummaryJson'),
  };
}
function mapCycle(row: Row): LearningCycleRecord {
  return {
    cycleId: str(row, 'cycleId'),
    attemptId: str(row, 'attemptId'),
    questionInstanceId: str(row, 'questionInstanceId'),
    phase: str(row, 'phase') as CyclePhase,
    givensJson: str(row, 'givensJson'),
    confirmedStateJson: str(row, 'confirmedStateJson'),
    stateVersion: num(row, 'stateVersion'),
    lastSeq: num(row, 'lastSeq'),
    createdAt: num(row, 'createdAt'),
  };
}
function mapPrediction(row: Row): PredictionRecord {
  return {
    cycleId: str(row, 'cycleId'),
    contentJson: str(row, 'contentJson'),
    uncertain: bool(row, 'uncertain'),
    noteText: strOrNull(row, 'noteText'),
    recordedAt: num(row, 'recordedAt'),
  };
}
function mapHint(row: Row): HintPresentationRecord {
  return {
    hintId: str(row, 'hintId'),
    cycleId: str(row, 'cycleId'),
    level: num(row, 'level'),
    contentVersion: str(row, 'contentVersion'),
    receiptRef: str(row, 'receiptRef'),
    at: num(row, 'at'),
  };
}
function mapEvent(row: Row): LearningEventRecord {
  return {
    eventId: str(row, 'eventId'),
    attemptId: str(row, 'attemptId'),
    seq: num(row, 'seq'),
    familyId: str(row, 'familyId'),
    commandKind: str(row, 'commandKind') as CommandKind,
    eventType: str(row, 'eventType'),
    payloadJson: str(row, 'payloadJson'),
    payloadVersion: str(row, 'payloadVersion'),
    occurredAt: num(row, 'occurredAt'),
  };
}
function mapSubmission(row: Row): SubmissionRecord {
  return {
    submissionId: str(row, 'submissionId'),
    cycleId: str(row, 'cycleId'),
    stateSnapshotJson: str(row, 'stateSnapshotJson'),
    attemptVersionAtSubmit: num(row, 'attemptVersionAtSubmit'),
    responseJson: str(row, 'responseJson'),
    assistanceSnapshotJson: str(row, 'assistanceSnapshotJson'),
    priorSubmissionId: strOrNull(row, 'priorSubmissionId'),
    submittedBy: str(row, 'submittedBy'),
    at: num(row, 'at'),
  };
}
function mapEvaluation(row: Row): EvaluationRecord {
  return {
    evaluationId: str(row, 'evaluationId'),
    submissionId: str(row, 'submissionId'),
    ruleVersion: str(row, 'ruleVersion'),
    outcome: str(row, 'outcome') as EvaluationRecord['outcome'],
    feedbackJson: str(row, 'feedbackJson'),
    at: num(row, 'at'),
  };
}
function mapExplanation(row: Row): ExplanationRevisionRecord {
  return {
    revisionId: str(row, 'revisionId'),
    cycleId: str(row, 'cycleId'),
    submissionRef: strOrNull(row, 'submissionRef'),
    structuredJson: str(row, 'structuredJson'),
    freeText: str(row, 'freeText'),
    scribe: bool(row, 'scribe'),
    scribeActorId: strOrNull(row, 'scribeActorId'),
    revisionOfId: strOrNull(row, 'revisionOfId'),
    at: num(row, 'at'),
  };
}
function mapAssistance(row: Row): AssistanceRecordRecord {
  return {
    recordId: str(row, 'recordId'),
    familyId: str(row, 'familyId'),
    attemptId: str(row, 'attemptId'),
    targetRef: str(row, 'targetRef'),
    category: str(row, 'category') as AssistanceCategory,
    note: str(row, 'note'),
    recordedByActorId: str(row, 'recordedByActorId'),
    revisionOfId: strOrNull(row, 'revisionOfId'),
    at: num(row, 'at'),
  };
}
function mapObservation(row: Row): GuardianObservationRecord {
  return {
    observationId: str(row, 'observationId'),
    explanationRevisionRef: str(row, 'explanationRevisionRef'),
    rubricVersion: str(row, 'rubricVersion'),
    conditionObserved: str(row, 'conditionObserved'),
    relationObserved: str(row, 'relationObserved'),
    basisObserved: str(row, 'basisObserved'),
    reviewerActorId: str(row, 'reviewerActorId'),
    revisionOfId: strOrNull(row, 'revisionOfId'),
    at: num(row, 'at'),
  };
}
function mapReceipt(row: Row): CommandReceiptRecord {
  return {
    familyId: str(row, 'familyId'),
    actorId: str(row, 'actorId'),
    idempotencyKey: str(row, 'idempotencyKey'),
    commandId: str(row, 'commandId'),
    kind: str(row, 'kind') as CommandKind,
    payloadHash: str(row, 'payloadHash'),
    bindingJson: strOrNull(row, 'bindingJson'),
    expectedAttemptVersion: numOrNull(row, 'expectedAttemptVersion'),
    status: str(row, 'status') as CommandReceiptRecord['status'],
    errorCode: strOrNull(row, 'errorCode'),
    effectRefsJson: str(row, 'effectRefsJson'),
    attemptVersionAfter: numOrNull(row, 'attemptVersionAfter'),
    changedKindsJson: str(row, 'changedKindsJson'),
    at: num(row, 'at'),
  };
}
function mapRetention(row: Row): RetentionPolicyRecord {
  return {
    familyId: str(row, 'familyId'),
    mode: str(row, 'mode') as RetentionPolicyRecord['mode'],
    rollingDays: numOrNull(row, 'rollingDays'),
    previewVersion: str(row, 'previewVersion'),
    setAt: num(row, 'setAt'),
  };
}
function mapDataOperation(row: Row): DataOperationRecord {
  return {
    opId: str(row, 'opId'),
    familyId: str(row, 'familyId'),
    kind: str(row, 'kind') as DataOperationRecord['kind'],
    scopeJson: str(row, 'scopeJson'),
    scopeHash: str(row, 'scopeHash'),
    phase: str(row, 'phase') as DataOperationPhase,
    resultJson: strOrNull(row, 'resultJson'),
    preparedAt: num(row, 'preparedAt'),
    confirmedAt: numOrNull(row, 'confirmedAt'),
  };
}
function mapTransferPlan(row: Row): TransferPlanRecord {
  return {
    planId: str(row, 'planId'),
    familyId: str(row, 'familyId'),
    learnerId: str(row, 'learnerId'),
    targetTaskRef: str(row, 'targetTaskRef'),
    status: str(row, 'status') as TransferPlanStatus,
    availableAt: numOrNull(row, 'availableAt'),
    startedAt: numOrNull(row, 'startedAt'),
    observedInstanceId: strOrNull(row, 'observedInstanceId'),
    actualIntervalDays: numOrNull(row, 'actualIntervalDays'),
  };
}

// ---------------------------------------------------------------------------
// Repository bundle
// ---------------------------------------------------------------------------

export interface RepositoryDeps {
  readonly db: DatabaseSync;
  readonly now: () => number;
  /** Shared prepared-statement cache (one entry per distinct SQL string). */
  readonly statementCache: Map<string, StatementSync>;
}

export class SqliteRepositories {
  readonly family: FamilyRepo;
  readonly guardianActor: GuardianActorRepo;
  readonly guardianCredential: GuardianCredentialRepo;
  readonly learner: LearnerRepo;
  readonly hostSession: HostSessionRepo;
  readonly contentRelease: ContentReleaseRepo;
  readonly questionInstance: QuestionInstanceRepo;
  readonly learningAttempt: LearningAttemptRepo;
  readonly learningCycle: LearningCycleRepo;
  readonly prediction: PredictionRepo;
  readonly hintPresentation: HintPresentationRepo;
  readonly learningEvent: LearningEventRepo;
  readonly submission: SubmissionRepo;
  readonly evaluation: EvaluationRepo;
  readonly explanationRevision: ExplanationRevisionRepo;
  readonly assistanceRecord: AssistanceRepo;
  readonly guardianObservation: GuardianObservationRepo;
  readonly commandReceipt: CommandReceiptRepo;
  readonly retentionPolicy: RetentionPolicyRepo;
  readonly dataOperation: DataOperationRepo;
  readonly transferPlan: TransferPlanRepo;

  constructor(private readonly deps: RepositoryDeps) {
    this.family = new FamilyRepo(deps);
    this.guardianActor = new GuardianActorRepo(deps);
    this.guardianCredential = new GuardianCredentialRepo(deps);
    this.learner = new LearnerRepo(deps);
    this.hostSession = new HostSessionRepo(deps);
    this.contentRelease = new ContentReleaseRepo(deps);
    this.questionInstance = new QuestionInstanceRepo(deps);
    this.learningAttempt = new LearningAttemptRepo(deps);
    this.learningCycle = new LearningCycleRepo(deps);
    this.prediction = new PredictionRepo(deps);
    this.hintPresentation = new HintPresentationRepo(deps);
    this.learningEvent = new LearningEventRepo(deps);
    this.submission = new SubmissionRepo(deps);
    this.evaluation = new EvaluationRepo(deps);
    this.explanationRevision = new ExplanationRevisionRepo(deps);
    this.assistanceRecord = new AssistanceRepo(deps);
    this.guardianObservation = new GuardianObservationRepo(deps);
    this.commandReceipt = new CommandReceiptRepo(deps);
    this.retentionPolicy = new RetentionPolicyRepo(deps);
    this.dataOperation = new DataOperationRepo(deps);
    this.transferPlan = new TransferPlanRepo(deps);
  }

  /** Number of distinct prepared statements currently held. */
  statementCount(): number {
    return this.deps.statementCache.size;
  }
}

/** Base helper: shared prepared-statement cache over the single connection. */
class RepoBase {
  constructor(protected readonly deps: RepositoryDeps) {}
  protected stmt(sql: string): StatementSync {
    const cached = this.deps.statementCache.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.deps.db.prepare(sql);
    this.deps.statementCache.set(sql, prepared);
    return prepared;
  }
  protected get now(): number {
    return this.deps.now();
  }
}

class FamilyRepo extends RepoBase {
  async insert(_scope: RepoScope, record: FamilyRecord): Promise<void> {
    this.stmt('INSERT INTO family (familyId, displayName, createdAt) VALUES (?, ?, ?)').run(
      record.familyId,
      record.displayName,
      record.createdAt,
    );
  }
  async findById(scope: RepoScope, familyId: string): Promise<FamilyRecord | null> {
    if (familyId !== scope.familyId) return null;
    const row = this.stmt('SELECT * FROM family WHERE familyId = ?').get(familyId) as Row | undefined;
    return row ? mapFamily(row) : null;
  }
  /** B-internal maintenance seam: every family on this data root (retention sweep). */
  async listAll(): Promise<FamilyRecord[]> {
    const rows = this.stmt('SELECT * FROM family ORDER BY createdAt ASC').all() as Row[];
    return rows.map(mapFamily);
  }
}

class GuardianActorRepo extends RepoBase {
  async insert(_scope: RepoScope, record: GuardianActorRecord): Promise<void> {
    this.stmt('INSERT INTO guardianActor (actorId, familyId, displayName, createdAt) VALUES (?, ?, ?, ?)').run(
      record.actorId,
      record.familyId,
      record.displayName,
      record.createdAt,
    );
  }
  async findById(scope: RepoScope, actorId: string): Promise<GuardianActorRecord | null> {
    const row = this.stmt('SELECT * FROM guardianActor WHERE actorId = ?').get(actorId) as Row | undefined;
    return row && row.familyId === scope.familyId ? mapGuardianActor(row) : null;
  }
  async listByFamily(scope: RepoScope, familyId: string): Promise<GuardianActorRecord[]> {
    const rows = this.stmt('SELECT * FROM guardianActor WHERE familyId = ? ORDER BY createdAt ASC').all(familyId) as Row[];
    return familyId === scope.familyId ? rows.map(mapGuardianActor) : [];
  }
}

class GuardianCredentialRepo extends RepoBase {
  async insert(_scope: RepoScope, record: GuardianCredentialRecord): Promise<void> {
    this.stmt(
      'INSERT INTO guardianCredential (familyId, algorithm, paramsJson, salt, derivedKey, failedAttempts, lockUntil) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(record.familyId, record.algorithm, record.paramsJson, record.salt, record.derivedKey, record.failedAttempts, record.lockUntil);
  }
  async find(scope: RepoScope, familyId: string): Promise<GuardianCredentialRecord | null> {
    if (familyId !== scope.familyId) return null;
    const row = this.stmt('SELECT * FROM guardianCredential WHERE familyId = ?').get(familyId) as Row | undefined;
    return row ? mapGuardianCredential(row) : null;
  }
  /**
   * Bootstrap seam for LocalAuthPort (setupGuardian/unlockGuardian run before
   * any family scope exists). The empty-table result IS the "uninitialized
   * data root" test named in the schema comments; one family per data root.
   */
  async findAny(): Promise<GuardianCredentialRecord | null> {
    const row = this.stmt('SELECT * FROM guardianCredential LIMIT 1').get() as Row | undefined;
    return row ? mapGuardianCredential(row) : null;
  }
  /** Bootstrap seam: clears the failure counter after a successful unlock. */
  async clearFailures(familyId: string): Promise<void> {
    this.stmt('UPDATE guardianCredential SET failedAttempts = 0, lockUntil = NULL WHERE familyId = ?').run(familyId);
  }
  async recordFailedAttempt(scope: RepoScope, familyId: string, lockUntil: number | null): Promise<void> {
    if (familyId !== scope.familyId) return;
    this.stmt('UPDATE guardianCredential SET failedAttempts = failedAttempts + 1, lockUntil = ? WHERE familyId = ?').run(
      lockUntil,
      familyId,
    );
  }
}

class LearnerRepo extends RepoBase {
  async insert(_scope: RepoScope, record: LearnerRecord): Promise<void> {
    this.stmt('INSERT INTO learner (learnerId, familyId, alias, goalNote, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(
      record.learnerId,
      record.familyId,
      record.alias,
      record.goalNote,
      record.status,
      record.createdAt,
    );
  }
  async findById(scope: RepoScope, learnerId: string): Promise<LearnerRecord | null> {
    const row = this.stmt('SELECT * FROM learner WHERE learnerId = ?').get(learnerId) as Row | undefined;
    return row && row.familyId === scope.familyId ? mapLearner(row) : null;
  }
  async listByFamily(scope: RepoScope, familyId: string): Promise<LearnerRecord[]> {
    if (familyId !== scope.familyId) return [];
    const rows = this.stmt('SELECT * FROM learner WHERE familyId = ? ORDER BY createdAt ASC').all(familyId) as Row[];
    return rows.map(mapLearner);
  }
}

class HostSessionRepo extends RepoBase {
  async insert(_scope: RepoScope, record: HostSessionRecord): Promise<void> {
    this.stmt(
      'INSERT INTO hostSession (sessionId, familyId, role, guardianActorId, learnerId, windowRef, hostEpoch, issuedAt, expiresAt, revokedAt, revocationVersion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.sessionId,
      record.familyId,
      record.role,
      record.guardianActorId,
      record.learnerId,
      record.windowRef,
      record.hostEpoch,
      record.issuedAt,
      record.expiresAt,
      record.revokedAt,
      record.revocationVersion,
    );
  }
  async findActive(scope: RepoScope, sessionId: string, hostEpoch: string): Promise<HostSessionRecord | null> {
    void scope; // bootstrap table: the session row derives the family scope; callers check expiry
    const row = this.stmt(
      'SELECT * FROM hostSession WHERE sessionId = ? AND hostEpoch = ? AND revokedAt IS NULL',
    ).get(sessionId, hostEpoch) as Row | undefined;
    return row ? mapHostSession(row) : null;
  }
  async revoke(scope: RepoScope, sessionId: string): Promise<boolean> {
    void scope;
    const result = this.stmt(
      'UPDATE hostSession SET revokedAt = ?, revocationVersion = revocationVersion + 1 WHERE sessionId = ? AND revokedAt IS NULL',
    ).run(this.now, sessionId);
    return result.changes === 1;
  }
}

class ContentReleaseRepo extends RepoBase {
  async insert(_scope: RepoScope, record: ContentReleaseRecord): Promise<void> {
    this.stmt(
      'INSERT INTO contentRelease (releaseId, status, courseVersionsJson, rendererDeclarationsJson, publicManifestHash, createdAt, statusChangedAt, statusReason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.releaseId,
      record.status,
      record.courseVersionsJson,
      record.rendererDeclarationsJson,
      record.publicManifestHash,
      record.createdAt,
      record.statusChangedAt,
      record.statusReason,
    );
  }
  async findById(_scope: RepoScope, releaseId: string): Promise<ContentReleaseRecord | null> {
    const row = this.stmt('SELECT * FROM contentRelease WHERE releaseId = ?').get(releaseId) as Row | undefined;
    return row ? mapContentRelease(row) : null;
  }
  async findByStatus(_scope: RepoScope, status: ReleaseStatus): Promise<ContentReleaseRecord[]> {
    const rows = this.stmt('SELECT * FROM contentRelease WHERE status = ? ORDER BY releaseId ASC').all(status) as Row[];
    return rows.map(mapContentRelease);
  }
  async updateStatus(
    _scope: RepoScope,
    input: { releaseId: string; from: ReleaseStatus; to: ReleaseStatus; reason: string | null },
  ): Promise<boolean> {
    const result = this.stmt(
      'UPDATE contentRelease SET status = ?, statusChangedAt = ?, statusReason = ? WHERE releaseId = ? AND status = ?',
    ).run(input.to, this.now, input.reason, input.releaseId, input.from);
    return result.changes === 1;
  }
}

class QuestionInstanceRepo extends RepoBase {
  async insert(_scope: RepoScope, record: ReturnType<typeof mapQuestionInstance>): Promise<void> {
    this.stmt(
      'INSERT INTO questionInstance (questionInstanceId, familyId, learnerId, releaseId, taskId, taskVersion, paramsJson, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.questionInstanceId,
      record.familyId,
      record.learnerId,
      record.releaseId,
      record.taskId,
      record.taskVersion,
      record.paramsJson,
      record.createdAt,
    );
  }
  async findById(scope: RepoScope, questionInstanceId: string): Promise<ReturnType<typeof mapQuestionInstance> | null> {
    const row = this.stmt('SELECT * FROM questionInstance WHERE questionInstanceId = ?').get(questionInstanceId) as Row | undefined;
    return row && row.familyId === scope.familyId ? mapQuestionInstance(row) : null;
  }
  /**
   * B-internal seam for the content service (public-material projection):
   * looks an instance up without a family scope. Public question material
   * carries no family identifiers; family authorization is enforced by the
   * learning server on the attempt/cycle before any projection is returned
   * to a client. Synchronous because the frozen ContentService port method
   * is synchronous.
   */
  findByIdUnscopedSync(questionInstanceId: string): ReturnType<typeof mapQuestionInstance> | null {
    const row = this.stmt('SELECT * FROM questionInstance WHERE questionInstanceId = ?').get(questionInstanceId) as Row | undefined;
    return row ? mapQuestionInstance(row) : null;
  }
  async listByFamily(scope: RepoScope, familyId: string): Promise<ReturnType<typeof mapQuestionInstance>[]> {
    if (familyId !== scope.familyId) return [];
    const rows = this.stmt('SELECT * FROM questionInstance WHERE familyId = ? ORDER BY createdAt ASC').all(familyId) as Row[];
    return rows.map(mapQuestionInstance);
  }
}

class LearningAttemptRepo extends RepoBase {
  async insert(_scope: RepoScope, record: LearningAttemptRecord): Promise<void> {
    this.stmt(
      'INSERT INTO learningAttempt (attemptId, familyId, learnerId, releaseId, attemptStatus, version, previousAttemptId, startedAt, endedAt, resultSummaryJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.attemptId,
      record.familyId,
      record.learnerId,
      record.releaseId,
      record.attemptStatus,
      record.version,
      record.previousAttemptId,
      record.startedAt,
      record.endedAt,
      record.resultSummaryJson,
    );
  }
  async findById(scope: RepoScope, attemptId: string): Promise<LearningAttemptRecord | null> {
    const row = this.stmt('SELECT * FROM learningAttempt WHERE attemptId = ?').get(attemptId) as Row | undefined;
    return row && row.familyId === scope.familyId ? mapAttempt(row) : null;
  }
  async listByLearner(scope: RepoScope, learnerId: string, status?: AttemptStatus): Promise<LearningAttemptRecord[]> {
    const rows = (status === undefined
      ? this.stmt('SELECT * FROM learningAttempt WHERE familyId = ? AND learnerId = ? ORDER BY startedAt ASC')
      : this.stmt('SELECT * FROM learningAttempt WHERE familyId = ? AND learnerId = ? AND attemptStatus = ? ORDER BY startedAt ASC')
    ).all(...(status === undefined ? [scope.familyId, learnerId] : [scope.familyId, learnerId, status])) as Row[];
    return rows.map(mapAttempt);
  }
  async updateWithCas(
    scope: RepoScope,
    input: {
      attemptId: string;
      expectedVersion: number;
      nextStatus?: AttemptStatus;
      endAttempt?: boolean;
      resultSummaryJson?: string | null;
    },
  ): Promise<LearningAttemptRecord | null> {
    const result = this.stmt(
      `UPDATE learningAttempt SET
         version = version + 1,
         attemptStatus = COALESCE(?, attemptStatus),
         endedAt = CASE WHEN ? THEN ? ELSE endedAt END,
         resultSummaryJson = COALESCE(?, resultSummaryJson)
       WHERE attemptId = ? AND familyId = ? AND version = ?`,
    ).run(
      input.nextStatus ?? null,
      input.endAttempt ? 1 : 0,
      input.endAttempt ? this.now : null,
      input.resultSummaryJson ?? null,
      input.attemptId,
      scope.familyId,
      input.expectedVersion,
    );
    if (result.changes !== 1) return null;
    const row = this.stmt('SELECT * FROM learningAttempt WHERE attemptId = ?').get(input.attemptId) as Row;
    return mapAttempt(row);
  }
  /**
   * B-internal maintenance seam (release revocation sweep): all non-terminal
   * attempts regardless of family -- the sweep runs for every family on the
   * local data root and re-scopes each write to the attempt's own family.
   */
  async listNonTerminalUnscoped(statuses: readonly AttemptStatus[]): Promise<LearningAttemptRecord[]> {
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.stmt(
      `SELECT * FROM learningAttempt WHERE attemptStatus IN (${placeholders}) ORDER BY startedAt ASC`,
    ).all(...statuses) as Row[];
    return rows.map(mapAttempt);
  }
}

class LearningCycleRepo extends RepoBase {
  async insert(_scope: RepoScope, record: LearningCycleRecord): Promise<void> {
    this.stmt(
      'INSERT INTO learningCycle (cycleId, attemptId, questionInstanceId, phase, givensJson, confirmedStateJson, stateVersion, lastSeq, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.cycleId,
      record.attemptId,
      record.questionInstanceId,
      record.phase,
      record.givensJson,
      record.confirmedStateJson,
      record.stateVersion,
      record.lastSeq,
      record.createdAt,
    );
  }
  async findById(scope: RepoScope, cycleId: string): Promise<LearningCycleRecord | null> {
    const row = this.stmt(
      'SELECT c.* FROM learningCycle c JOIN learningAttempt a ON a.attemptId = c.attemptId WHERE c.cycleId = ? AND a.familyId = ?',
    ).get(cycleId, scope.familyId) as Row | undefined;
    return row ? mapCycle(row) : null;
  }
  async findCurrentByAttempt(scope: RepoScope, attemptId: string): Promise<LearningCycleRecord | null> {
    const row = this.stmt(
      `SELECT c.* FROM learningCycle c JOIN learningAttempt a ON a.attemptId = c.attemptId
       WHERE c.attemptId = ? AND a.familyId = ?
       ORDER BY c.createdAt DESC, c.cycleId DESC LIMIT 1`,
    ).get(attemptId, scope.familyId) as Row | undefined;
    return row ? mapCycle(row) : null;
  }
  /** B-internal seam: all cycles of an attempt, oldest first (summaries/exports). */
  async listByAttempt(scope: RepoScope, attemptId: string): Promise<LearningCycleRecord[]> {
    const rows = this.stmt(
      `SELECT c.* FROM learningCycle c JOIN learningAttempt a ON a.attemptId = c.attemptId
       WHERE c.attemptId = ? AND a.familyId = ?
       ORDER BY c.createdAt ASC, c.cycleId ASC`,
    ).all(attemptId, scope.familyId) as Row[];
    return rows.map(mapCycle);
  }
  async updatePhaseWithCas(
    scope: RepoScope,
    input: { cycleId: string; expectedStateVersion: number; nextPhase: CyclePhase },
  ): Promise<LearningCycleRecord | null> {
    const result = this.stmt(
      'UPDATE learningCycle SET phase = ?, stateVersion = stateVersion + 1 WHERE cycleId = ? AND stateVersion = ?',
    ).run(input.nextPhase, input.cycleId, input.expectedStateVersion);
    if (result.changes !== 1) return null;
    return this.findById(scope, input.cycleId);
  }
  async confirmState(
    scope: RepoScope,
    input: { cycleId: string; expectedStateVersion: number; confirmedStateJson: string },
  ): Promise<LearningCycleRecord | null> {
    const result = this.stmt(
      'UPDATE learningCycle SET confirmedStateJson = ?, stateVersion = stateVersion + 1 WHERE cycleId = ? AND stateVersion = ?',
    ).run(input.confirmedStateJson, input.cycleId, input.expectedStateVersion);
    if (result.changes !== 1) return null;
    return this.findById(scope, input.cycleId);
  }
}

class PredictionRepo extends RepoBase {
  async insertFirst(_scope: RepoScope, record: PredictionRecord): Promise<'INSERTED' | 'ALREADY_EXISTS'> {
    const existing = this.stmt('SELECT cycleId FROM prediction WHERE cycleId = ?').get(record.cycleId) as Row | undefined;
    if (existing !== undefined) return 'ALREADY_EXISTS';
    this.stmt('INSERT INTO prediction (cycleId, contentJson, uncertain, noteText, recordedAt) VALUES (?, ?, ?, ?, ?)').run(
      record.cycleId,
      record.contentJson,
      record.uncertain ? 1 : 0,
      record.noteText,
      record.recordedAt,
    );
    return 'INSERTED';
  }
  async findFirst(scope: RepoScope, cycleId: string): Promise<PredictionRecord | null> {
    const row = this.stmt(
      'SELECT p.* FROM prediction p JOIN learningCycle c ON c.cycleId = p.cycleId JOIN learningAttempt a ON a.attemptId = c.attemptId WHERE p.cycleId = ? AND a.familyId = ?',
    ).get(cycleId, scope.familyId) as Row | undefined;
    return row ? mapPrediction(row) : null;
  }
}

class HintPresentationRepo extends RepoBase {
  async insert(_scope: RepoScope, record: HintPresentationRecord): Promise<void> {
    this.stmt('INSERT INTO hintPresentation (hintId, cycleId, level, contentVersion, receiptRef, at) VALUES (?, ?, ?, ?, ?, ?)').run(
      record.hintId,
      record.cycleId,
      record.level,
      record.contentVersion,
      record.receiptRef,
      record.at,
    );
  }
  async listByCycle(scope: RepoScope, cycleId: string): Promise<HintPresentationRecord[]> {
    const rows = this.stmt(
      `SELECT h.* FROM hintPresentation h
       JOIN learningCycle c ON c.cycleId = h.cycleId
       JOIN learningAttempt a ON a.attemptId = c.attemptId
       WHERE h.cycleId = ? AND a.familyId = ? ORDER BY h.at ASC, h.hintId ASC`,
    ).all(cycleId, scope.familyId) as Row[];
    return rows.map(mapHint);
  }
}

class LearningEventRepo extends RepoBase {
  async append(
    scope: RepoScope,
    input: {
      attemptId: string;
      familyId: string;
      commandKind: CommandKind;
      eventType: string;
      payloadJson: string;
      payloadVersion: string;
      occurredAt: number;
    },
  ): Promise<LearningEventRecord> {
    if (input.familyId !== scope.familyId) {
      throw new Error('FORBIDDEN: event append family scope mismatch');
    }
    const maxRow = this.stmt('SELECT MAX(seq) AS m FROM learningEvent WHERE attemptId = ?').get(input.attemptId) as {
      m: number | null;
    };
    const seq = (maxRow.m ?? 0) + 1;
    const eventId = `evt-${input.attemptId}-${seq}`;
    this.stmt(
      'INSERT INTO learningEvent (eventId, attemptId, seq, familyId, commandKind, eventType, payloadJson, payloadVersion, occurredAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      eventId,
      input.attemptId,
      seq,
      input.familyId,
      input.commandKind,
      input.eventType,
      input.payloadJson,
      input.payloadVersion,
      input.occurredAt,
    );
    this.stmt('UPDATE learningCycle SET lastSeq = ? WHERE attemptId = ? AND cycleId = (SELECT cycleId FROM learningCycle WHERE attemptId = ? ORDER BY createdAt DESC, cycleId DESC LIMIT 1)').run(
      seq,
      input.attemptId,
      input.attemptId,
    );
    return {
      eventId,
      attemptId: input.attemptId,
      seq,
      familyId: input.familyId,
      commandKind: input.commandKind,
      eventType: input.eventType,
      payloadJson: input.payloadJson,
      payloadVersion: input.payloadVersion,
      occurredAt: input.occurredAt,
    };
  }
  async pageBySeq(
    scope: RepoScope,
    input: { attemptId: string; afterSeq: number; limit: number },
  ): Promise<LearningEventRecord[]> {
    const rows = this.stmt(
      'SELECT * FROM learningEvent WHERE familyId = ? AND attemptId = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all(scope.familyId, input.attemptId, input.afterSeq, input.limit) as Row[];
    return rows.map(mapEvent);
  }
}

class SubmissionRepo extends RepoBase {
  async insert(_scope: RepoScope, record: SubmissionRecord): Promise<void> {
    this.stmt(
      'INSERT INTO submission (submissionId, cycleId, stateSnapshotJson, attemptVersionAtSubmit, responseJson, assistanceSnapshotJson, priorSubmissionId, submittedBy, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.submissionId,
      record.cycleId,
      record.stateSnapshotJson,
      record.attemptVersionAtSubmit,
      record.responseJson,
      record.assistanceSnapshotJson,
      record.priorSubmissionId,
      record.submittedBy,
      record.at,
    );
  }
  async findById(scope: RepoScope, submissionId: string): Promise<SubmissionRecord | null> {
    const row = this.stmt(
      `SELECT s.* FROM submission s
       JOIN learningCycle c ON c.cycleId = s.cycleId
       JOIN learningAttempt a ON a.attemptId = c.attemptId
       WHERE s.submissionId = ? AND a.familyId = ?`,
    ).get(submissionId, scope.familyId) as Row | undefined;
    return row ? mapSubmission(row) : null;
  }
  async findLatestByCycle(scope: RepoScope, cycleId: string): Promise<SubmissionRecord | null> {
    const row = this.stmt(
      `SELECT s.* FROM submission s
       JOIN learningCycle c ON c.cycleId = s.cycleId
       JOIN learningAttempt a ON a.attemptId = c.attemptId
       WHERE s.cycleId = ? AND a.familyId = ?
       ORDER BY s.at DESC, s.submissionId DESC LIMIT 1`,
    ).get(cycleId, scope.familyId) as Row | undefined;
    return row ? mapSubmission(row) : null;
  }
  /** B-internal seam: every submission of a cycle (evidence summaries/exports). */
  async listAllByCycle(scope: RepoScope, cycleId: string): Promise<SubmissionRecord[]> {
    const rows = this.stmt(
      `SELECT s.* FROM submission s
       JOIN learningCycle c ON c.cycleId = s.cycleId
       JOIN learningAttempt a ON a.attemptId = c.attemptId
       WHERE s.cycleId = ? AND a.familyId = ?
       ORDER BY s.at ASC, s.submissionId ASC`,
    ).all(cycleId, scope.familyId) as Row[];
    return rows.map(mapSubmission);
  }
}

class EvaluationRepo extends RepoBase {
  async insert(_scope: RepoScope, record: EvaluationRecord): Promise<void> {
    this.stmt('INSERT INTO evaluation (evaluationId, submissionId, ruleVersion, outcome, feedbackJson, at) VALUES (?, ?, ?, ?, ?, ?)').run(
      record.evaluationId,
      record.submissionId,
      record.ruleVersion,
      record.outcome,
      record.feedbackJson,
      record.at,
    );
  }
  async findOriginalBySubmission(scope: RepoScope, submissionId: string): Promise<EvaluationRecord | null> {
    const row = this.stmt(
      `SELECT e.* FROM evaluation e
       JOIN submission s ON s.submissionId = e.submissionId
       JOIN learningCycle c ON c.cycleId = s.cycleId
       JOIN learningAttempt a ON a.attemptId = c.attemptId
       WHERE e.submissionId = ? AND a.familyId = ?`,
    ).get(submissionId, scope.familyId) as Row | undefined;
    return row ? mapEvaluation(row) : null;
  }
}

class ExplanationRevisionRepo extends RepoBase {
  async insert(_scope: RepoScope, record: ExplanationRevisionRecord): Promise<void> {
    this.stmt(
      'INSERT INTO explanationRevision (revisionId, cycleId, submissionRef, structuredJson, freeText, scribe, scribeActorId, revisionOfId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.revisionId,
      record.cycleId,
      record.submissionRef,
      record.structuredJson,
      record.freeText,
      record.scribe ? 1 : 0,
      record.scribeActorId,
      record.revisionOfId,
      record.at,
    );
  }
  async listByCycle(scope: RepoScope, cycleId: string): Promise<ExplanationRevisionRecord[]> {
    const rows = this.stmt(
      `SELECT x.* FROM explanationRevision x
       JOIN learningCycle c ON c.cycleId = x.cycleId
       JOIN learningAttempt a ON a.attemptId = c.attemptId
       WHERE x.cycleId = ? AND a.familyId = ?
       ORDER BY x.at ASC, x.revisionId ASC`,
    ).all(cycleId, scope.familyId) as Row[];
    return rows.map(mapExplanation);
  }
  /** B-internal seam: single revision by id, family-scoped via the attempt join. */
  async findById(scope: RepoScope, revisionId: string): Promise<ExplanationRevisionRecord | null> {
    const row = this.stmt(
      `SELECT x.* FROM explanationRevision x
       JOIN learningCycle c ON c.cycleId = x.cycleId
       JOIN learningAttempt a ON a.attemptId = c.attemptId
       WHERE x.revisionId = ? AND a.familyId = ?`,
    ).get(revisionId, scope.familyId) as Row | undefined;
    return row ? mapExplanation(row) : null;
  }
}

class AssistanceRepo extends RepoBase {
  async insert(_scope: RepoScope, record: AssistanceRecordRecord): Promise<void> {
    this.stmt(
      'INSERT INTO assistanceRecord (recordId, familyId, attemptId, targetRef, category, note, recordedByActorId, revisionOfId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.recordId,
      record.familyId,
      record.attemptId,
      record.targetRef,
      record.category,
      record.note,
      record.recordedByActorId,
      record.revisionOfId,
      record.at,
    );
  }
  async listByAttempt(scope: RepoScope, attemptId: string): Promise<AssistanceRecordRecord[]> {
    const rows = this.stmt('SELECT * FROM assistanceRecord WHERE familyId = ? AND attemptId = ? ORDER BY at ASC, recordId ASC').all(
      scope.familyId,
      attemptId,
    ) as Row[];
    return rows.map(mapAssistance);
  }
}

class GuardianObservationRepo extends RepoBase {
  async insert(_scope: RepoScope, record: GuardianObservationRecord): Promise<void> {
    this.stmt(
      'INSERT INTO guardianObservation (observationId, explanationRevisionRef, rubricVersion, conditionObserved, relationObserved, basisObserved, reviewerActorId, revisionOfId, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.observationId,
      record.explanationRevisionRef,
      record.rubricVersion,
      record.conditionObserved,
      record.relationObserved,
      record.basisObserved,
      record.reviewerActorId,
      record.revisionOfId,
      record.at,
    );
  }
  async listByExplanationRevision(scope: RepoScope, explanationRevisionRef: string): Promise<GuardianObservationRecord[]> {
    const rows = this.stmt(
      `SELECT g.* FROM guardianObservation g
       JOIN explanationRevision x ON x.revisionId = g.explanationRevisionRef
       JOIN learningCycle c ON c.cycleId = x.cycleId
       JOIN learningAttempt a ON a.attemptId = c.attemptId
       WHERE g.explanationRevisionRef = ? AND a.familyId = ?
       ORDER BY g.at ASC, g.observationId ASC`,
    ).all(explanationRevisionRef, scope.familyId) as Row[];
    return rows.map(mapObservation);
  }
}

class CommandReceiptRepo extends RepoBase {
  async tryInsert(_scope: RepoScope, record: CommandReceiptRecord): Promise<'INSERTED' | 'DUPLICATE'> {
    const existing = this.stmt(
      'SELECT idempotencyKey FROM commandReceipt WHERE familyId = ? AND actorId = ? AND idempotencyKey = ?',
    ).get(record.familyId, record.actorId, record.idempotencyKey) as Row | undefined;
    if (existing !== undefined) return 'DUPLICATE';
    this.stmt(
      'INSERT INTO commandReceipt (familyId, actorId, idempotencyKey, commandId, kind, payloadHash, bindingJson, expectedAttemptVersion, status, errorCode, effectRefsJson, attemptVersionAfter, changedKindsJson, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.familyId,
      record.actorId,
      record.idempotencyKey,
      record.commandId,
      record.kind,
      record.payloadHash,
      record.bindingJson,
      record.expectedAttemptVersion,
      record.status,
      record.errorCode,
      record.effectRefsJson,
      record.attemptVersionAfter,
      record.changedKindsJson,
      record.at,
    );
    return 'INSERTED';
  }
  async findByKey(
    scope: RepoScope,
    input: { familyId: string; actorId: string; idempotencyKey: string },
  ): Promise<CommandReceiptRecord | null> {
    if (input.familyId !== scope.familyId) return null;
    const row = this.stmt(
      'SELECT * FROM commandReceipt WHERE familyId = ? AND actorId = ? AND idempotencyKey = ?',
    ).get(input.familyId, input.actorId, input.idempotencyKey) as Row | undefined;
    return row ? mapReceipt(row) : null;
  }
  async findByCommandId(scope: RepoScope, commandId: string): Promise<CommandReceiptRecord | null> {
    const row = this.stmt('SELECT * FROM commandReceipt WHERE familyId = ? AND commandId = ?').get(scope.familyId, commandId) as
      | Row
      | undefined;
    return row ? mapReceipt(row) : null;
  }
}

class RetentionPolicyRepo extends RepoBase {
  async upsert(_scope: RepoScope, record: RetentionPolicyRecord): Promise<void> {
    this.stmt(
      'INSERT INTO retentionPolicy (familyId, mode, rollingDays, previewVersion, setAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(familyId) DO UPDATE SET mode = excluded.mode, rollingDays = excluded.rollingDays, previewVersion = excluded.previewVersion, setAt = excluded.setAt',
    ).run(record.familyId, record.mode, record.rollingDays, record.previewVersion, record.setAt);
  }
  async find(scope: RepoScope, familyId: string): Promise<RetentionPolicyRecord | null> {
    if (familyId !== scope.familyId) return null;
    const row = this.stmt('SELECT * FROM retentionPolicy WHERE familyId = ?').get(familyId) as Row | undefined;
    return row ? mapRetention(row) : null;
  }
}

class DataOperationRepo extends RepoBase {
  /** Deletion-only snapshot and session revocation; both share the command transaction. */
  async inspectDeletion(scope: RepoScope, spec: DisposalSpec) {
    if (spec.familyId !== scope.familyId) throw new Error('Deletion family scope mismatch');
    return inspectDeletionScope(this.deps.db, spec);
  }
  async revokeDeletionSessions(scope: RepoScope, at: number): Promise<number> {
    return Number(this.stmt('UPDATE hostSession SET revokedAt = ?, revocationVersion = revocationVersion + 1 WHERE familyId = ? AND revokedAt IS NULL')
      .run(at, scope.familyId).changes);
  }
  async completeDeletion(scope: RepoScope, opId: string, phase: 'COMPLETED' | 'COMPLETED_PARTIAL', resultJson: string, at: number): Promise<boolean> {
    return this.stmt("UPDATE dataOperation SET phase = ?, resultJson = ?, confirmedAt = ? WHERE opId = ? AND familyId = ? AND kind = 'DELETION'")
      .run(phase, resultJson, at, opId, scope.familyId).changes === 1;
  }
  async insert(_scope: RepoScope, record: DataOperationRecord): Promise<void> {
    this.stmt(
      'INSERT INTO dataOperation (opId, familyId, kind, scopeJson, scopeHash, phase, resultJson, preparedAt, confirmedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(record.opId, record.familyId, record.kind, record.scopeJson, record.scopeHash, record.phase, record.resultJson, record.preparedAt, record.confirmedAt);
  }
  async findById(scope: RepoScope, opId: string): Promise<DataOperationRecord | null> {
    const row = this.stmt('SELECT * FROM dataOperation WHERE opId = ? AND familyId = ?').get(opId, scope.familyId) as Row | undefined;
    return row ? mapDataOperation(row) : null;
  }
  /** B-internal seam: family's operations of one kind, oldest first (two-phase confirm). */
  async listByFamilyAndKind(
    scope: RepoScope,
    kind: 'EXPORT' | 'DELETION',
  ): Promise<DataOperationRecord[]> {
    const rows = this.stmt(
      'SELECT * FROM dataOperation WHERE familyId = ? AND kind = ? ORDER BY preparedAt ASC, opId ASC',
    ).all(scope.familyId, kind) as Row[];
    return rows.map(mapDataOperation);
  }
  async updatePhase(
    scope: RepoScope,
    input: { opId: string; phase: DataOperationPhase; resultJson?: string | null },
  ): Promise<boolean> {
    const setsConfirmed = input.phase === 'CONFIRMED' || input.phase === 'CONFIRMED_FAILED';
    const result = this.stmt(
      `UPDATE dataOperation SET phase = ?,
         resultJson = COALESCE(?, resultJson),
         confirmedAt = CASE WHEN ? THEN ? ELSE confirmedAt END
       WHERE opId = ? AND familyId = ?`,
    ).run(input.phase, input.resultJson ?? null, setsConfirmed ? 1 : 0, setsConfirmed ? this.now : null, input.opId, scope.familyId);
    return result.changes === 1;
  }
}

class TransferPlanRepo extends RepoBase {
  async insert(_scope: RepoScope, record: TransferPlanRecord): Promise<void> {
    this.stmt(
      'INSERT INTO transferPlan (planId, familyId, learnerId, targetTaskRef, status, availableAt, startedAt, observedInstanceId, actualIntervalDays) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      record.planId,
      record.familyId,
      record.learnerId,
      record.targetTaskRef,
      record.status,
      record.availableAt,
      record.startedAt,
      record.observedInstanceId,
      record.actualIntervalDays,
    );
  }
  async findById(scope: RepoScope, planId: string): Promise<TransferPlanRecord | null> {
    const row = this.stmt('SELECT * FROM transferPlan WHERE planId = ? AND familyId = ?').get(planId, scope.familyId) as Row | undefined;
    return row ? mapTransferPlan(row) : null;
  }
  async listDue(scope: RepoScope, asOf: number): Promise<TransferPlanRecord[]> {
    const rows = this.stmt(
      "SELECT * FROM transferPlan WHERE familyId = ? AND status IN ('PLANNED', 'AVAILABLE') AND availableAt IS NOT NULL AND availableAt <= ? ORDER BY availableAt ASC",
    ).all(scope.familyId, asOf) as Row[];
    return rows.map(mapTransferPlan);
  }
  async updateStatus(
    scope: RepoScope,
    input: { planId: string; status: TransferPlanStatus; startedAt?: number; observedInstanceId?: string; actualIntervalDays?: number },
  ): Promise<boolean> {
    const result = this.stmt(
      `UPDATE transferPlan SET status = ?,
         startedAt = COALESCE(?, startedAt),
         observedInstanceId = COALESCE(?, observedInstanceId),
         actualIntervalDays = COALESCE(?, actualIntervalDays)
       WHERE planId = ? AND familyId = ?`,
    ).run(input.status, input.startedAt ?? null, input.observedInstanceId ?? null, input.actualIntervalDays ?? null, input.planId, scope.familyId);
    return result.changes === 1;
  }
}
