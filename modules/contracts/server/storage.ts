/**
 * Storage / transaction port and typed repository bundle (server-only).
 *
 * Frozen sources:
 * - B server-ports-recommendation.md §4 and coordinator delta item 2:
 *   StoragePort { tx(name, fn) BEGIN IMMEDIATE short transaction;
 *   read(fn) read-only; schemaVersion(); close(): Promise<CloseReport> }.
 *   The Repositories bundle is obtainable ONLY inside tx/read callbacks --
 *   enforced structurally, since Repositories never escapes the callback.
 * - B sqlite-schema-recommendation.md §1/§2 (21-table groups; server-generated
 *   ids; INTEGER millisecond timestamps; server-monotonic seq; bound
 *   parameters; foreign keys ON; repositories must not embed DDL)
 * - LIFECYCLE-DATA-API.md §7 (all repository methods carry authenticated
 *   scope; cross-family objects are uniformly FORBIDDEN-invisible)
 *
 * Types only. B implements adapters/sqlite/** (excluding A-owned schema/**).
 */
import type { ServerContext } from './context';
import type { CommandKind } from '../public/envelope';
import type { CyclePhase } from '../public/queries';
import type { AttemptStatus } from '../public/queries';
import type { ReleaseStatus } from './content';

export interface Closeable {
  close(): Promise<void>;
}

/** Scope derived from ServerContext; carried explicitly by every repository call. */
export interface RepoScope {
  readonly familyId: string;
  readonly actorId: string;
}

export interface TxHandle {
  readonly txName: string;
  readonly txId: string;
}

/** Facts returned by storage.close() (B server-ports §5 step 4); connection close itself is A's job. */
export interface CloseReport {
  readonly pendingTransactions: number;
  readonly releasedStatements: number;
  readonly walCheckpointed: boolean;
}

/**
 * StoragePort deliberately does not extend Closeable: its close returns a
 * CloseReport (facts for A's shutdown orchestration), not void.
 */
export interface StoragePort {
  /** Short write transaction (BEGIN IMMEDIATE). Repositories live only inside fn. */
  tx<T>(name: string, fn: (repos: Repositories, tx: TxHandle) => Promise<T>): Promise<T>;
  /** Read-only access; repositories live only inside fn. */
  read<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
  /** Checked on open; mismatch => SCHEMA_MISMATCH. */
  schemaVersion(): number;
  close(): Promise<CloseReport>;
}

// ---------------------------------------------------------------------------
// Records (mirror adapters/sqlite/schema/0001_init.sql; timestamps are
// INTEGER epoch milliseconds, ids are server-generated text)
// ---------------------------------------------------------------------------

export interface FamilyRecord {
  familyId: string;
  displayName: string;
  createdAt: number;
}

export interface GuardianActorRecord {
  actorId: string;
  familyId: string;
  displayName: string;
  createdAt: number;
}

/** Credential material exists only Host-side; never projected, never logged. */
export interface GuardianCredentialRecord {
  familyId: string;
  algorithm: 'scrypt';
  paramsJson: string;
  salt: string;
  derivedKey: string;
  failedAttempts: number;
  lockUntil: number | null;
}

export type LearnerStatus = 'ACTIVE' | 'ARCHIVED';

export interface LearnerRecord {
  learnerId: string;
  familyId: string;
  alias: string;
  goalNote: string | null;
  status: LearnerStatus;
  createdAt: number;
}

export interface HostSessionRecord {
  sessionId: string;
  familyId: string;
  role: 'GUARDIAN' | 'LEARNER';
  guardianActorId: string | null;
  learnerId: string | null;
  windowRef: string;
  hostEpoch: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revocationVersion: number;
}

export interface ContentReleaseRecord {
  releaseId: string;
  status: ReleaseStatus;
  courseVersionsJson: string;
  rendererDeclarationsJson: string;
  publicManifestHash: string;
  createdAt: number;
  statusChangedAt: number;
  statusReason: string | null;
}

export interface QuestionInstanceRecord {
  questionInstanceId: string;
  familyId: string;
  learnerId: string;
  releaseId: string;
  taskId: string;
  taskVersion: string;
  paramsJson: string;
  createdAt: number;
}

export interface LearningAttemptRecord {
  attemptId: string;
  familyId: string;
  learnerId: string;
  releaseId: string;
  attemptStatus: AttemptStatus;
  /** Single CAS point (B-D1): every fact write on this attempt bumps it. */
  version: number;
  previousAttemptId: string | null;
  startedAt: number;
  endedAt: number | null;
  resultSummaryJson: string | null;
}

export interface LearningCycleRecord {
  cycleId: string;
  attemptId: string;
  questionInstanceId: string;
  phase: CyclePhase;
  givensJson: string;
  confirmedStateJson: string;
  stateVersion: number;
  lastSeq: number;
  createdAt: number;
}

export interface PredictionRecord {
  cycleId: string;
  contentJson: string;
  uncertain: boolean;
  noteText: string | null;
  recordedAt: number;
}

export interface HintPresentationRecord {
  hintId: string;
  cycleId: string;
  level: number;
  contentVersion: string;
  receiptRef: string;
  at: number;
}

export interface LearningEventRecord {
  eventId: string;
  attemptId: string;
  /** Server-monotonic per attempt; UNIQUE(attemptId, seq) in storage. */
  seq: number;
  familyId: string;
  commandKind: CommandKind;
  eventType: string;
  payloadJson: string;
  /** Initial '1' (B-D8); projection parsers select by event type + version. */
  payloadVersion: string;
  occurredAt: number;
}

export interface SubmissionRecord {
  submissionId: string;
  cycleId: string;
  /** Full confirmed snapshot copy, not a bare reference (replay-safe). */
  stateSnapshotJson: string;
  attemptVersionAtSubmit: number;
  responseJson: string;
  assistanceSnapshotJson: string;
  priorSubmissionId: string | null;
  submittedBy: string;
  at: number;
}

export interface EvaluationRecord {
  evaluationId: string;
  submissionId: string;
  ruleVersion: string;
  outcome: 'CORRECT' | 'REVISE' | 'UNSCORABLE';
  feedbackJson: string;
  at: number;
}

export interface ExplanationRevisionRecord {
  revisionId: string;
  cycleId: string;
  submissionRef: string | null;
  structuredJson: string;
  freeText: string;
  scribe: boolean;
  scribeActorId: string | null;
  revisionOfId: string | null;
  at: number;
}

export type AssistanceCategory = 'OPERATIVE' | 'RESTATE' | 'CONCEPT' | 'ANSWER';

export interface AssistanceRecordRecord {
  recordId: string;
  familyId: string;
  attemptId: string;
  targetRef: string;
  category: AssistanceCategory;
  note: string;
  recordedByActorId: string;
  revisionOfId: string | null;
  at: number;
}

export interface GuardianObservationRecord {
  observationId: string;
  explanationRevisionRef: string;
  rubricVersion: string;
  conditionObserved: string;
  relationObserved: string;
  basisObserved: string;
  reviewerActorId: string;
  revisionOfId: string | null;
  at: number;
}

export interface CommandReceiptRecord {
  familyId: string;
  actorId: string;
  idempotencyKey: string;
  commandId: string;
  kind: CommandKind;
  /** Canonical hash (public/contracts canonical.ts); same key + different hash => IDEMPOTENCY_CONFLICT. */
  payloadHash: string;
  bindingJson: string | null;
  expectedAttemptVersion: number | null;
  status: 'APPLIED' | 'REJECTED';
  errorCode: string | null;
  effectRefsJson: string;
  attemptVersionAfter: number | null;
  changedKindsJson: string;
  at: number;
}

export interface RetentionPolicyRecord {
  familyId: string;
  mode: 'UNTIL_GUARDIAN_DELETES' | 'ROLLING_DAYS';
  rollingDays: number | null;
  previewVersion: string;
  setAt: number;
}

export type DataOperationPhase =
  | 'PREPARED'
  | 'CONFIRMED'
  | 'CONFIRMED_FAILED'
  | 'COMPLETED'
  | 'COMPLETED_PARTIAL'
  | 'FAILED';

export interface DataOperationRecord {
  opId: string;
  familyId: string;
  kind: 'EXPORT' | 'DELETION';
  scopeJson: string;
  scopeHash: string;
  phase: DataOperationPhase;
  resultJson: string | null;
  preparedAt: number;
  confirmedAt: number | null;
}

export type TransferPlanStatus = 'PLANNED' | 'AVAILABLE' | 'STARTED' | 'OBSERVED' | 'DEFERRED' | 'CANCELLED';

export interface TransferPlanRecord {
  planId: string;
  familyId: string;
  learnerId: string;
  targetTaskRef: string;
  status: TransferPlanStatus;
  availableAt: number | null;
  startedAt: number | null;
  observedInstanceId: string | null;
  actualIntervalDays: number | null;
}

// ---------------------------------------------------------------------------
// Repository ports (one per schema table; every method carries RepoScope)
// ---------------------------------------------------------------------------

export interface FamilyRepository {
  insert(scope: RepoScope, record: FamilyRecord): Promise<void>;
  findById(scope: RepoScope, familyId: string): Promise<FamilyRecord | null>;
}

export interface GuardianActorRepository {
  insert(scope: RepoScope, record: GuardianActorRecord): Promise<void>;
  findById(scope: RepoScope, actorId: string): Promise<GuardianActorRecord | null>;
  listByFamily(scope: RepoScope, familyId: string): Promise<GuardianActorRecord[]>;
}

export interface GuardianCredentialRepository {
  /** Single-family creation inside the setupGuardian transaction; empty-table check is the "uninitialized data root" test. */
  insert(scope: RepoScope, record: GuardianCredentialRecord): Promise<void>;
  find(scope: RepoScope, familyId: string): Promise<GuardianCredentialRecord | null>;
  recordFailedAttempt(scope: RepoScope, familyId: string, lockUntil: number | null): Promise<void>;
}

export interface LearnerRepository {
  insert(scope: RepoScope, record: LearnerRecord): Promise<void>;
  findById(scope: RepoScope, learnerId: string): Promise<LearnerRecord | null>;
  listByFamily(scope: RepoScope, familyId: string): Promise<LearnerRecord[]>;
}

export interface HostSessionRepository {
  insert(scope: RepoScope, record: HostSessionRecord): Promise<void>;
  /** Active = not expired, not revoked, hostEpoch matches. */
  findActive(scope: RepoScope, sessionId: string, hostEpoch: string): Promise<HostSessionRecord | null>;
  revoke(scope: RepoScope, sessionId: string): Promise<boolean>;
}

export interface ContentReleaseRepository {
  insert(scope: RepoScope, record: ContentReleaseRecord): Promise<void>;
  findById(scope: RepoScope, releaseId: string): Promise<ContentReleaseRecord | null>;
  findByStatus(scope: RepoScope, status: ReleaseStatus): Promise<ContentReleaseRecord[]>;
  /** Status-machine transition; false when the from-status no longer matches. */
  updateStatus(
    scope: RepoScope,
    input: { releaseId: string; from: ReleaseStatus; to: ReleaseStatus; reason: string | null },
  ): Promise<boolean>;
}

export interface QuestionInstanceRepository {
  insert(scope: RepoScope, record: QuestionInstanceRecord): Promise<void>;
  findById(scope: RepoScope, questionInstanceId: string): Promise<QuestionInstanceRecord | null>;
  listByFamily(scope: RepoScope, familyId: string): Promise<QuestionInstanceRecord[]>;
}

export interface LearningAttemptRepository {
  insert(scope: RepoScope, record: LearningAttemptRecord): Promise<void>;
  findById(scope: RepoScope, attemptId: string): Promise<LearningAttemptRecord | null>;
  listByLearner(scope: RepoScope, learnerId: string, status?: AttemptStatus): Promise<LearningAttemptRecord[]>;
  /**
   * CAS on version (B-D1): applies the mutation only when the stored version
   * equals expectedVersion, bumps version by one, returns the updated record;
   * null on conflict. The adapter owns the bump; callers never write version.
   */
  updateWithCas(
    scope: RepoScope,
    input: {
      attemptId: string;
      expectedVersion: number;
      nextStatus?: AttemptStatus;
      endAttempt?: boolean;
      resultSummaryJson?: string | null;
    },
  ): Promise<LearningAttemptRecord | null>;
}

export interface LearningCycleRepository {
  insert(scope: RepoScope, record: LearningCycleRecord): Promise<void>;
  findById(scope: RepoScope, cycleId: string): Promise<LearningCycleRecord | null>;
  findCurrentByAttempt(scope: RepoScope, attemptId: string): Promise<LearningCycleRecord | null>;
  updatePhaseWithCas(
    scope: RepoScope,
    input: { cycleId: string; expectedStateVersion: number; nextPhase: CyclePhase },
  ): Promise<LearningCycleRecord | null>;
  confirmState(
    scope: RepoScope,
    input: { cycleId: string; expectedStateVersion: number; confirmedStateJson: string },
  ): Promise<LearningCycleRecord | null>;
}

export interface PredictionRepository {
  /** First prediction only; never updated once present (PREDICT phase rule). */
  insertFirst(scope: RepoScope, record: PredictionRecord): Promise<'INSERTED' | 'ALREADY_EXISTS'>;
  findFirst(scope: RepoScope, cycleId: string): Promise<PredictionRecord | null>;
}

export interface HintPresentationRepository {
  insert(scope: RepoScope, record: HintPresentationRecord): Promise<void>;
  listByCycle(scope: RepoScope, cycleId: string): Promise<HintPresentationRecord[]>;
}

export interface LearningEventRepository {
  /** Server assigns the monotonic seq; UNIQUE(attemptId, seq) in storage. */
  append(
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
  ): Promise<LearningEventRecord>;
  pageBySeq(
    scope: RepoScope,
    input: { attemptId: string; afterSeq: number; limit: number },
  ): Promise<LearningEventRecord[]>;
}

export interface SubmissionRepository {
  insert(scope: RepoScope, record: SubmissionRecord): Promise<void>;
  findById(scope: RepoScope, submissionId: string): Promise<SubmissionRecord | null>;
  findLatestByCycle(scope: RepoScope, cycleId: string): Promise<SubmissionRecord | null>;
}

export interface EvaluationRepository {
  insert(scope: RepoScope, record: EvaluationRecord): Promise<void>;
  findOriginalBySubmission(scope: RepoScope, submissionId: string): Promise<EvaluationRecord | null>;
}

export interface ExplanationRevisionRepository {
  insert(scope: RepoScope, record: ExplanationRevisionRecord): Promise<void>;
  listByCycle(scope: RepoScope, cycleId: string): Promise<ExplanationRevisionRecord[]>;
}

export interface AssistanceRepository {
  insert(scope: RepoScope, record: AssistanceRecordRecord): Promise<void>;
  listByAttempt(scope: RepoScope, attemptId: string): Promise<AssistanceRecordRecord[]>;
}

export interface GuardianObservationRepository {
  insert(scope: RepoScope, record: GuardianObservationRecord): Promise<void>;
  listByExplanationRevision(scope: RepoScope, explanationRevisionRef: string): Promise<GuardianObservationRecord[]>;
}

export interface CommandReceiptRepository {
  /** Atomic insert against UNIQUE(familyId, actorId, idempotencyKey). */
  tryInsert(scope: RepoScope, record: CommandReceiptRecord): Promise<'INSERTED' | 'DUPLICATE'>;
  findByKey(
    scope: RepoScope,
    input: { familyId: string; actorId: string; idempotencyKey: string },
  ): Promise<CommandReceiptRecord | null>;
  findByCommandId(scope: RepoScope, commandId: string): Promise<CommandReceiptRecord | null>;
}

export interface RetentionPolicyRepository {
  upsert(scope: RepoScope, record: RetentionPolicyRecord): Promise<void>;
  find(scope: RepoScope, familyId: string): Promise<RetentionPolicyRecord | null>;
}

export interface DataOperationRepository {
  insert(scope: RepoScope, record: DataOperationRecord): Promise<void>;
  findById(scope: RepoScope, opId: string): Promise<DataOperationRecord | null>;
  updatePhase(
    scope: RepoScope,
    input: { opId: string; phase: DataOperationPhase; resultJson?: string | null },
  ): Promise<boolean>;
}

export interface TransferPlanRepository {
  insert(scope: RepoScope, record: TransferPlanRecord): Promise<void>;
  findById(scope: RepoScope, planId: string): Promise<TransferPlanRecord | null>;
  listDue(scope: RepoScope, asOf: number): Promise<TransferPlanRecord[]>;
  updateStatus(
    scope: RepoScope,
    input: { planId: string; status: TransferPlanStatus; startedAt?: number; observedInstanceId?: string; actualIntervalDays?: number },
  ): Promise<boolean>;
}

/**
 * Typed repository bundle mirroring the 21 tables of
 * adapters/sqlite/schema/0001_init.sql. Obtainable ONLY via StoragePort.tx /
 * StoragePort.read callbacks. Code-job tables are intentionally absent in
 * schemaVersion 1 (B-D7): code.* commands return CAPABILITY_UNAVAILABLE.
 */
export interface Repositories {
  readonly family: FamilyRepository;
  readonly guardianActor: GuardianActorRepository;
  readonly guardianCredential: GuardianCredentialRepository;
  readonly learner: LearnerRepository;
  readonly hostSession: HostSessionRepository;
  readonly contentRelease: ContentReleaseRepository;
  readonly questionInstance: QuestionInstanceRepository;
  readonly learningAttempt: LearningAttemptRepository;
  readonly learningCycle: LearningCycleRepository;
  readonly prediction: PredictionRepository;
  readonly hintPresentation: HintPresentationRepository;
  readonly learningEvent: LearningEventRepository;
  readonly submission: SubmissionRepository;
  readonly evaluation: EvaluationRepository;
  readonly explanationRevision: ExplanationRevisionRepository;
  readonly assistanceRecord: AssistanceRepository;
  readonly guardianObservation: GuardianObservationRepository;
  readonly commandReceipt: CommandReceiptRepository;
  readonly retentionPolicy: RetentionPolicyRepository;
  readonly dataOperation: DataOperationRepository;
  readonly transferPlan: TransferPlanRepository;
}

/** Convenience helper: derive the mandatory repository scope from a verified context. */
export function repoScopeFromContext(ctx: ServerContext): RepoScope {
  return { familyId: ctx.familyId, actorId: ctx.actorId };
}
