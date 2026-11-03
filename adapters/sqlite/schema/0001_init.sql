-- Rondo H0 SQLite schema, migration 0001 (schemaVersion = 1).
--
-- Frozen sources:
--   LIFECYCLE-DATA-API.md §7 (nine table groups, minimal persistence rules)
--   preparation/B/sqlite-schema-recommendation.md §2 (21 tables, columns,
--     constraints) and §3 (index list) -- table names/constraints follow that
--     file per coordinator delta item 6.
--   B-D1: learningAttempt.version is the single CAS point.
--   B-D7: NO code job tables in schemaVersion 1 (code.* => CAPABILITY_UNAVAILABLE).
--   B-D8: learningEvent.payloadVersion initial '1'.
--
-- Conventions (see SCHEMA-README.md):
--   ids are server-generated text (ULID / uuid v7 style); timestamps are
--   INTEGER epoch milliseconds from the server clock; seq is INTEGER and
--   server-monotonic; structured payloads are canonical JSON text while
--   identity/scope/enum/version/seq stay on dedicated columns; every write
--   uses bound parameters; foreign keys ON and WAL are per-connection
--   pragmas set by the adapter, not by this file.

-- ---------------------------------------------------------------------------
-- Group 2.1: family / learner / guardian & sessions (local identity data)
-- ---------------------------------------------------------------------------

CREATE TABLE family (
  familyId TEXT PRIMARY KEY,
  displayName TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE guardianActor (
  actorId TEXT PRIMARY KEY,
  familyId TEXT NOT NULL REFERENCES family(familyId),
  displayName TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

-- Single row per family; an empty table is the "data root uninitialized" test
-- used by setupGuardian. Raw passphrases never reach this table or logs.
CREATE TABLE guardianCredential (
  familyId TEXT PRIMARY KEY REFERENCES family(familyId),
  algorithm TEXT NOT NULL DEFAULT 'scrypt' CHECK (algorithm = 'scrypt'),
  paramsJson TEXT NOT NULL,             -- scrypt N/r/p, fixed with the schema
  salt TEXT NOT NULL,                   -- random per credential
  derivedKey TEXT NOT NULL,             -- scrypt derivation, never projected
  failedAttempts INTEGER NOT NULL DEFAULT 0,
  lockUntil INTEGER
);

CREATE TABLE learner (
  learnerId TEXT PRIMARY KEY,
  familyId TEXT NOT NULL REFERENCES family(familyId),
  alias TEXT NOT NULL,
  goalNote TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  createdAt INTEGER NOT NULL
);

-- Sessions are produced only by Host authentication; bound to the trusted
-- window and the Host epoch. Epoch advance invalidates every older session (B-D4).
CREATE TABLE hostSession (
  sessionId TEXT PRIMARY KEY,
  familyId TEXT NOT NULL REFERENCES family(familyId),
  role TEXT NOT NULL CHECK (role IN ('GUARDIAN', 'LEARNER')),
  guardianActorId TEXT REFERENCES guardianActor(actorId),
  learnerId TEXT REFERENCES learner(learnerId),
  windowRef TEXT NOT NULL,
  hostEpoch TEXT NOT NULL,
  issuedAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  revokedAt INTEGER,
  revocationVersion INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_hostSession_familyId ON hostSession(familyId);
CREATE INDEX idx_hostSession_expiresAt ON hostSession(expiresAt);

-- ---------------------------------------------------------------------------
-- Group 2.2: content release / question instance
-- ---------------------------------------------------------------------------

CREATE TABLE contentRelease (
  releaseId TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'REVIEWED', 'AVAILABLE', 'RETIRED', 'REVOKED')),
  courseVersionsJson TEXT NOT NULL,
  rendererDeclarationsJson TEXT NOT NULL,
  publicManifestHash TEXT NOT NULL,     -- public assets only; no private hashes
  createdAt INTEGER NOT NULL,
  statusChangedAt INTEGER NOT NULL,
  statusReason TEXT
);

CREATE TABLE questionInstance (
  questionInstanceId TEXT PRIMARY KEY,
  familyId TEXT NOT NULL REFERENCES family(familyId),
  learnerId TEXT NOT NULL REFERENCES learner(learnerId),
  releaseId TEXT NOT NULL REFERENCES contentRelease(releaseId),
  taskId TEXT NOT NULL,
  taskVersion TEXT NOT NULL,
  paramsJson TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX idx_questionInstance_family ON questionInstance(familyId, learnerId);

-- ---------------------------------------------------------------------------
-- Group 2.3: attempt / cycle / scene confirmed state (children's learning data)
-- ---------------------------------------------------------------------------

CREATE TABLE learningAttempt (
  attemptId TEXT PRIMARY KEY,
  familyId TEXT NOT NULL REFERENCES family(familyId),
  learnerId TEXT NOT NULL REFERENCES learner(learnerId),
  releaseId TEXT NOT NULL REFERENCES contentRelease(releaseId),
  attemptStatus TEXT NOT NULL CHECK (attemptStatus IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED', 'CONTENT_BLOCKED')),
  version INTEGER NOT NULL CHECK (version >= 1),  -- single CAS point (B-D1)
  previousAttemptId TEXT REFERENCES learningAttempt(attemptId),
  startedAt INTEGER NOT NULL,
  endedAt INTEGER,
  resultSummaryJson TEXT
);
CREATE INDEX idx_learningAttempt_family ON learningAttempt(familyId, learnerId, attemptStatus);

CREATE TABLE learningCycle (
  cycleId TEXT PRIMARY KEY,
  attemptId TEXT NOT NULL REFERENCES learningAttempt(attemptId),
  questionInstanceId TEXT NOT NULL REFERENCES questionInstance(questionInstanceId),
  phase TEXT NOT NULL CHECK (phase IN ('PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW')),
  givensJson TEXT NOT NULL,
  confirmedStateJson TEXT NOT NULL,     -- server-confirmed domain state; ViewState never stored
  stateVersion INTEGER NOT NULL CHECK (stateVersion >= 1),
  lastSeq INTEGER NOT NULL DEFAULT 0 CHECK (lastSeq >= 0),
  createdAt INTEGER NOT NULL
);
CREATE INDEX idx_learningCycle_attempt ON learningCycle(attemptId);

-- 1:1 with cycle, insert-only: the first prediction can never be overwritten.
CREATE TABLE prediction (
  cycleId TEXT PRIMARY KEY REFERENCES learningCycle(cycleId),
  contentJson TEXT NOT NULL,
  uncertain INTEGER NOT NULL CHECK (uncertain IN (0, 1)),
  noteText TEXT,
  recordedAt INTEGER NOT NULL
);

CREATE TABLE hintPresentation (
  hintId TEXT PRIMARY KEY,
  cycleId TEXT NOT NULL REFERENCES learningCycle(cycleId),
  level INTEGER NOT NULL CHECK (level >= 0),
  contentVersion TEXT NOT NULL,
  receiptRef TEXT NOT NULL,
  at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Group 2.4: events / submissions / evaluations (learning data & results)
-- ---------------------------------------------------------------------------

CREATE TABLE learningEvent (
  eventId TEXT PRIMARY KEY,
  attemptId TEXT NOT NULL REFERENCES learningAttempt(attemptId),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  familyId TEXT NOT NULL REFERENCES family(familyId),  -- redundant scope column for export/deletion scans
  commandKind TEXT NOT NULL,
  eventType TEXT NOT NULL,
  payloadJson TEXT NOT NULL,
  payloadVersion TEXT NOT NULL DEFAULT '1',  -- B-D8; initial '1'
  occurredAt INTEGER NOT NULL,
  UNIQUE (attemptId, seq)                    -- server-monotonic seq per attempt
);
CREATE INDEX idx_learningEvent_family ON learningEvent(familyId, attemptId);

CREATE TABLE submission (
  submissionId TEXT PRIMARY KEY,
  cycleId TEXT NOT NULL REFERENCES learningCycle(cycleId),
  stateSnapshotJson TEXT NOT NULL,      -- full confirmed snapshot copy, replay-safe
  attemptVersionAtSubmit INTEGER NOT NULL CHECK (attemptVersionAtSubmit >= 1),
  responseJson TEXT NOT NULL,           -- response as submitted, never overwritten
  assistanceSnapshotJson TEXT NOT NULL,
  priorSubmissionId TEXT REFERENCES submission(submissionId),  -- corrections reference the previous
  submittedBy TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_submission_cycle ON submission(cycleId);

CREATE TABLE evaluation (
  evaluationId TEXT PRIMARY KEY,
  submissionId TEXT NOT NULL UNIQUE REFERENCES submission(submissionId),  -- one original evaluation per submission
  ruleVersion TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('CORRECT', 'REVISE', 'UNSCORABLE')),
  feedbackJson TEXT NOT NULL,
  at INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Group 2.5: explanations / assistance / guardian observation
-- ---------------------------------------------------------------------------

CREATE TABLE explanationRevision (
  revisionId TEXT PRIMARY KEY,
  cycleId TEXT NOT NULL REFERENCES learningCycle(cycleId),
  submissionRef TEXT,
  structuredJson TEXT NOT NULL,
  freeText TEXT NOT NULL,
  scribe INTEGER NOT NULL CHECK (scribe IN (0, 1)),
  scribeActorId TEXT REFERENCES guardianActor(actorId),
  revisionOfId TEXT REFERENCES explanationRevision(revisionId),
  at INTEGER NOT NULL
);
CREATE INDEX idx_explanationRevision_cycle ON explanationRevision(cycleId);

CREATE TABLE assistanceRecord (
  recordId TEXT PRIMARY KEY,
  familyId TEXT NOT NULL REFERENCES family(familyId),
  attemptId TEXT NOT NULL REFERENCES learningAttempt(attemptId),
  targetRef TEXT NOT NULL,              -- concrete event/submission reference
  category TEXT NOT NULL CHECK (category IN ('OPERATIVE', 'RESTATE', 'CONCEPT', 'ANSWER')),
  note TEXT NOT NULL,
  recordedByActorId TEXT NOT NULL REFERENCES guardianActor(actorId),
  revisionOfId TEXT REFERENCES assistanceRecord(recordId),
  at INTEGER NOT NULL
);
CREATE INDEX idx_assistanceRecord_attempt ON assistanceRecord(attemptId);

CREATE TABLE guardianObservation (
  observationId TEXT PRIMARY KEY,
  explanationRevisionRef TEXT NOT NULL REFERENCES explanationRevision(revisionId),
  rubricVersion TEXT NOT NULL,
  conditionObserved TEXT NOT NULL,      -- rubric triple stored as three columns
  relationObserved TEXT NOT NULL,
  basisObserved TEXT NOT NULL,
  reviewerActorId TEXT NOT NULL REFERENCES guardianActor(actorId),
  revisionOfId TEXT REFERENCES guardianObservation(observationId),
  at INTEGER NOT NULL
);
CREATE INDEX idx_guardianObservation_ref ON guardianObservation(explanationRevisionRef);

-- ---------------------------------------------------------------------------
-- Group 2.6: idempotent command receipts (business consistency data)
-- ---------------------------------------------------------------------------

CREATE TABLE commandReceipt (
  familyId TEXT NOT NULL REFERENCES family(familyId),
  actorId TEXT NOT NULL,                -- authenticated actor from ServerContext only
  idempotencyKey TEXT NOT NULL,
  commandId TEXT NOT NULL,
  kind TEXT NOT NULL,
  payloadHash TEXT NOT NULL,            -- canonical hash; same key + different hash => IDEMPOTENCY_CONFLICT
  bindingJson TEXT,
  expectedAttemptVersion INTEGER,
  status TEXT NOT NULL CHECK (status IN ('APPLIED', 'REJECTED')),
  errorCode TEXT,
  effectRefsJson TEXT NOT NULL,
  attemptVersionAfter INTEGER,
  changedKindsJson TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (familyId, actorId, idempotencyKey)
);
CREATE INDEX idx_commandReceipt_commandId ON commandReceipt(commandId);

-- ---------------------------------------------------------------------------
-- Group 2.7: data governance (retention / export / deletion)
-- ---------------------------------------------------------------------------

CREATE TABLE retentionPolicy (
  familyId TEXT PRIMARY KEY REFERENCES family(familyId),
  mode TEXT NOT NULL CHECK (mode IN ('UNTIL_GUARDIAN_DELETES', 'ROLLING_DAYS')),
  rollingDays INTEGER CHECK (rollingDays IS NULL OR (rollingDays >= 1 AND rollingDays <= 3650)),
  previewVersion TEXT NOT NULL,         -- confirmed scope preview version
  setAt INTEGER NOT NULL
);

CREATE TABLE dataOperation (
  opId TEXT PRIMARY KEY,
  familyId TEXT NOT NULL REFERENCES family(familyId),
  kind TEXT NOT NULL CHECK (kind IN ('EXPORT', 'DELETION')),
  scopeJson TEXT NOT NULL,
  scopeHash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('PREPARED', 'CONFIRMED', 'CONFIRMED_FAILED', 'COMPLETED', 'COMPLETED_PARTIAL', 'FAILED')),
  resultJson TEXT,                      -- disposal result summary, never child text
  preparedAt INTEGER NOT NULL,
  confirmedAt INTEGER
);
CREATE INDEX idx_dataOperation_family ON dataOperation(familyId, kind, phase);

-- ---------------------------------------------------------------------------
-- Group 2.8: deferred transfer (learning data; not a notification grant)
-- ---------------------------------------------------------------------------

CREATE TABLE transferPlan (
  planId TEXT PRIMARY KEY,
  familyId TEXT NOT NULL REFERENCES family(familyId),
  learnerId TEXT NOT NULL REFERENCES learner(learnerId),
  targetTaskRef TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PLANNED', 'AVAILABLE', 'STARTED', 'OBSERVED', 'DEFERRED', 'CANCELLED')),
  availableAt INTEGER,
  startedAt INTEGER,
  observedInstanceId TEXT REFERENCES questionInstance(questionInstanceId),
  actualIntervalDays INTEGER
);

-- Group 2.9 (code job tables): intentionally NOT created in schemaVersion 1
-- (B-D7). Enabling the real capability requires a versioned migration from A.

-- ---------------------------------------------------------------------------
-- Migration bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  appliedAt INTEGER NOT NULL
);

INSERT INTO schema_migrations (version, name, appliedAt) VALUES (1, '0001_init', 0);
-- appliedAt is written with the real server clock by the migration runner;
-- the placeholder 0 exists only so the row is part of this atomic migration.
