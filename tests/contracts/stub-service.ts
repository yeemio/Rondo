/**
 * Test-only stub implementing the server ports (LearningServer) and
 * LocalAuthPort for the synthetic contract roundtrip.
 *
 * This is NOT a business implementation: it performs envelope runtime
 * validation, authorization/binding/phase/CAS stub semantics and idempotency
 * via the real canonical hash, but never judges responses and produces no
 * real learning facts (H0-SPEC §4).
 */
import { parseEnvelope, type PublicCommandEnvelope } from '../../modules/contracts/public/envelope';
import {
  parsePublicQuery,
  parsePublicProjection,
  type AttemptStatus,
  type CyclePhase,
  type PublicProjection,
} from '../../modules/contracts/public/queries';
import {
  parseCommandReceipt,
  parseReceiptLookup,
  type CommandReceipt,
  type ReceiptLookup,
} from '../../modules/contracts/public/receipts';
import { rondoError, versionConflictError, type RondoError, type RondoErrorCode } from '../../modules/contracts/public/errors';
import { computePayloadHash } from '../../modules/contracts/public/canonical';
import { PROTOCOL_VERSION } from '../../modules/contracts/public/protocol';
import { parsePublicQuestionSpec } from '../../modules/contracts/public/question';
import type { CylinderStateV1 } from '../../modules/contracts/public/scene';
import type { LearningServer } from '../../modules/contracts/server/learning';
import type { ServerContext } from '../../modules/contracts/server/context';
import type {
  AuthSession,
  EnterLearnerInput,
  LockResult,
  LocalAuthPort,
  SetupGuardianInput,
  UnlockGuardianInput,
} from '../../modules/contracts/public/auth';
import {
  parseAuthSession,
  parseEnterLearnerInput,
  parseLockResult,
  parseSetupGuardianInput,
  parseUnlockGuardianInput,
} from '../../modules/contracts/public/auth';
import { SYNTH_RELEASE_ID, SYNTH_RENDERER_CONTRACT_VERSION, SYNTH_RENDERER_ID, SYNTH_TASK_ID } from './synthetic';

function stubError(code: RondoErrorCode, message: string): RondoError {
  return rondoError(code, message);
}

interface StubLearner {
  learnerId: string;
  familyId: string;
  alias: string;
}

interface StubAttempt {
  attemptId: string;
  familyId: string;
  learnerId: string;
  releaseId: string;
  questionInstanceId: string;
  cycleId: string;
  attemptStatus: AttemptStatus;
  version: number;
  phase: CyclePhase;
  sceneState: CylinderStateV1;
  seq: number;
  createdAtMs: number;
}

interface StubEvent {
  seq: number;
  eventId: string;
  eventType: string;
  commandKind: PublicCommandEnvelope['kind'];
  occurredAtMs: number;
}

const FAMILY_ID = 'fam-stub-0001';
const HOST_EPOCH = 'epoch-stub-1';

interface StubRelease {
  status: 'AVAILABLE';
  rendererId: string;
  rendererContractVersion: string;
  taskId: string;
  title: string;
}

const RELEASES = new Map<string, StubRelease>([
  [
    SYNTH_RELEASE_ID,
    {
      status: 'AVAILABLE',
      rendererId: SYNTH_RENDERER_ID,
      rendererContractVersion: SYNTH_RENDERER_CONTRACT_VERSION,
      taskId: SYNTH_TASK_ID,
      title: '圆柱参数识别（合成课）',
    },
  ],
]);

const RENDERERS = new Map<string, Set<string>>([[SYNTH_RENDERER_ID, new Set<string>([SYNTH_RENDERER_CONTRACT_VERSION])]]);

function visibilityForPhase(phase: CyclePhase): 'PREDICTION' | 'OBSERVATION' | 'ASSESSMENT' | 'REVIEW' {
  switch (phase) {
    case 'PREDICT':
      return 'PREDICTION';
    case 'OPERATE':
      return 'OBSERVATION';
    case 'VERIFY':
      return 'ASSESSMENT';
    case 'EXPLAIN':
    case 'REVIEW':
      return 'REVIEW';
  }
}

function receiptKey(familyId: string, actorId: string, idempotencyKey: string): string {
  return `${familyId}::${actorId}::${idempotencyKey}`;
}

export class StubHarness {
  private readonly learners = new Map<string, StubLearner>();
  private readonly attempts = new Map<string, StubAttempt>();
  private readonly events = new Map<string, StubEvent[]>();
  private readonly receipts = new Map<string, { hash: string; receipt: CommandReceipt }>();
  private readonly idRegistry: string[] = [];
  private closed = false;
  private idCounter = 0;
  private clockMs = 1_790_000_000_000;
  private session: AuthSession | null = null;
  private setupIdempotencyKey: string | null = null;

  readonly auth: LocalAuthPort = {
    setupGuardian: (input: SetupGuardianInput) => this.setupGuardianImpl(input),
    unlockGuardian: (input: UnlockGuardianInput) => this.unlockGuardianImpl(input),
    enterLearner: (input: EnterLearnerInput) => this.enterLearnerImpl(input),
    lock: () => this.lockImpl(),
    session: () => Promise.resolve(this.session),
  };

  readonly server: LearningServer = {
    handleCommand: (ctx, envelope) => this.handleCommandImpl(ctx, envelope),
    query: (ctx, request) => this.queryImpl(ctx, request),
    lookupReceipt: (ctx, req) => this.lookupReceiptImpl(ctx, req),
    close: () => this.closeImpl(),
  };

  // -- contexts ---------------------------------------------------------------

  guardianContext(): ServerContext {
    return {
      familyId: FAMILY_ID,
      actorId: 'actor-guardian-0001',
      role: 'GUARDIAN',
      sessionId: 'sess-guardian-0001',
      windowRef: 'win-main-trusted',
      hostEpoch: HOST_EPOCH,
    };
  }

  learnerContext(learnerId: string): ServerContext {
    return {
      familyId: FAMILY_ID,
      actorId: `actor-${learnerId}`,
      role: 'LEARNER',
      learnerId,
      sessionId: `sess-${learnerId}`,
      windowRef: 'win-main-trusted',
      hostEpoch: HOST_EPOCH,
    };
  }

  /** A second synthetic family, for cross-family rejection proofs. */
  foreignLearnerContext(): ServerContext {
    return {
      familyId: 'fam-other-9999',
      actorId: 'actor-other-0001',
      role: 'LEARNER',
      learnerId: 'lrn-other-0001',
      sessionId: 'sess-other-0001',
      windowRef: 'win-other',
      hostEpoch: HOST_EPOCH,
    };
  }

  // -- LocalAuthPort stub ------------------------------------------------------

  private nextId(prefix: string): string {
    this.idCounter += 1;
    const id = `${prefix}-${String(this.idCounter).padStart(4, '0')}`;
    this.idRegistry.push(id);
    return id;
  }

  private now(): number {
    this.clockMs += 1000;
    return this.clockMs;
  }

  private async setupGuardianImpl(input: SetupGuardianInput): Promise<AuthSession> {
    const parsed = parseSetupGuardianInput(input);
    if (this.setupIdempotencyKey !== null) {
      if (this.setupIdempotencyKey === parsed.idempotencyKey) {
        return this.guardianSession(parsed.guardianDisplayName);
      }
      throw stubError('INVALID_OPERATION', 'data root already initialized; repeat setup is rejected');
    }
    this.setupIdempotencyKey = parsed.idempotencyKey;
    this.session = this.guardianSession(parsed.guardianDisplayName);
    return this.session;
  }

  private guardianSession(displayName: string): AuthSession {
    return parseAuthSession({
      role: 'GUARDIAN',
      actorId: 'actor-guardian-0001',
      familyId: FAMILY_ID,
      displayName,
      expiresAtMs: this.clockMs + 3_600_000,
    });
  }

  private async unlockGuardianImpl(input: UnlockGuardianInput): Promise<AuthSession> {
    const parsed = parseUnlockGuardianInput(input);
    if (this.setupIdempotencyKey === null) {
      throw stubError('UNAUTHENTICATED', 'no guardian configured on this data root');
    }
    if (parsed.passphrase.length < 8) {
      throw stubError('UNAUTHENTICATED', 'invalid passphrase');
    }
    this.session = this.guardianSession('Guardian');
    return this.session;
  }

  private async enterLearnerImpl(input: EnterLearnerInput): Promise<AuthSession> {
    const parsed = parseEnterLearnerInput(input);
    if (this.session === null || this.session.role !== 'GUARDIAN') {
      throw stubError('UNAUTHENTICATED', 'a guardian session is required before entering a learner');
    }
    const learner = this.learners.get(parsed.learnerId);
    if (!learner || learner.familyId !== this.session.familyId) {
      throw stubError('FORBIDDEN', 'learner does not belong to the current family');
    }
    this.session = parseAuthSession({
      role: 'LEARNER',
      actorId: `actor-${parsed.learnerId}`,
      familyId: this.session.familyId,
      displayName: learner.alias,
      learnerId: parsed.learnerId,
      expiresAtMs: this.clockMs + 900_000,
    });
    return this.session;
  }

  private async lockImpl(): Promise<LockResult> {
    this.session = null;
    return parseLockResult({ locked: true });
  }

  // -- LearningServer stub -----------------------------------------------------

  private authorize(ctx: ServerContext, envelope: PublicCommandEnvelope): void {
    if (envelope.kind.startsWith('code.')) {
      // First batch: the code capability is not enabled (LIFECYCLE §6).
      throw stubError('CAPABILITY_UNAVAILABLE', `code capability not enabled in first batch: ${envelope.kind}`);
    }
    if (envelope.target.scope === 'LEARNER') {
      const learner = this.learners.get(envelope.target.learnerId);
      if (!learner || learner.familyId !== ctx.familyId) {
        throw stubError('FORBIDDEN', 'target learner does not belong to the authenticated family');
      }
    }
    const ns = envelope.kind.split('.')[0];
    if (ns === 'family' || ns === 'guardian') {
      if (ctx.role !== 'GUARDIAN') {
        throw stubError('FORBIDDEN', `${ns}.* commands require the guardian role`);
      }
      return;
    }
    if (ctx.role !== 'LEARNER') {
      throw stubError('FORBIDDEN', 'learning.* commands require the learner role');
    }
    if (envelope.target.scope !== 'LEARNER') {
      throw stubError('FORBIDDEN', 'learning.* commands must target the session learner');
    }
    if (ctx.learnerId !== envelope.target.learnerId) {
      throw stubError('FORBIDDEN', 'target learner must match the session learner');
    }
  }

  private checkBinding(envelope: PublicCommandEnvelope): void {
    const binding = envelope.binding;
    if (binding === undefined) return;
    const release = RELEASES.get(binding.releaseId);
    if (!release) {
      throw stubError('CONTENT_UNAVAILABLE', `unknown release: ${binding.releaseId}`);
    }
    if (release.status !== 'AVAILABLE') {
      throw stubError('CONTENT_UNAVAILABLE', `release is not AVAILABLE: ${binding.releaseId}`);
    }
    const versions = RENDERERS.get(release.rendererId);
    if (!versions || !versions.has(binding.rendererContractVersion)) {
      throw stubError(
        'UNKNOWN_RENDERER',
        `renderer contract version not registered: ${release.rendererId}@${binding.rendererContractVersion}`,
      );
    }
  }

  private async handleCommandImpl(ctx: ServerContext, envelopeInput: PublicCommandEnvelope): Promise<CommandReceipt> {
    if (this.closed) {
      throw stubError('HOST_RECOVERING', 'server is closed to new commands');
    }
    // Runtime schema validation: unknown kinds/fields/versions are rejected here.
    const envelope = parseEnvelope(envelopeInput as unknown);
    this.authorize(ctx, envelope);
    this.checkBinding(envelope);
    const hash = await computePayloadHash({
      protocolVersion: envelope.protocolVersion,
      kind: envelope.kind,
      payload: envelope.payload,
      target: envelope.target,
      binding: envelope.binding,
      expectedAttemptVersion: envelope.expectedAttemptVersion,
    });
    const key = receiptKey(ctx.familyId, ctx.actorId, envelope.idempotencyKey);
    const prior = this.receipts.get(key);
    if (prior) {
      if (prior.hash === hash) return prior.receipt;
      throw stubError('IDEMPOTENCY_CONFLICT', 'same idempotency key replayed with a different payload');
    }
    const receipt = await this.dispatch(ctx, envelope);
    this.receipts.set(key, { hash, receipt });
    return receipt;
  }

  private requireAttempt(ctx: ServerContext, envelope: PublicCommandEnvelope): StubAttempt {
    if (envelope.target.scope !== 'LEARNER' || envelope.target.attemptId === undefined) {
      throw stubError('INVALID_OPERATION', 'command requires a LEARNER target carrying attemptId');
    }
    const attempt = this.attempts.get(envelope.target.attemptId);
    if (!attempt) {
      throw stubError('INVALID_OPERATION', `unknown attempt: ${envelope.target.attemptId}`);
    }
    if (attempt.familyId !== ctx.familyId) {
      throw stubError('FORBIDDEN', 'cross-family attempt rejected');
    }
    if (attempt.learnerId !== envelope.target.learnerId) {
      throw stubError('INVALID_OPERATION', 'attempt does not belong to the target learner');
    }
    return attempt;
  }

  private checkExpectedVersion(attempt: StubAttempt, expected: number | undefined): void {
    if (expected !== attempt.version) {
      throw versionConflictError(attempt.version, 'Re-read the attempt view and retry with the current version.');
    }
  }

  private appendEvent(attempt: StubAttempt, eventType: string, envelope: PublicCommandEnvelope): string {
    attempt.seq += 1;
    const eventId = this.nextId('evt');
    const list = this.events.get(attempt.attemptId) ?? [];
    list.push({ seq: attempt.seq, eventId, eventType, commandKind: envelope.kind, occurredAtMs: this.now() });
    this.events.set(attempt.attemptId, list);
    return eventId;
  }

  private buildReceipt(
    envelope: PublicCommandEnvelope,
    opts: { effectRefs: string[]; changedKinds: string[]; attemptVersion?: number },
  ): CommandReceipt {
    return parseCommandReceipt({
      protocolVersion: PROTOCOL_VERSION,
      commandId: envelope.commandId,
      idempotencyKey: envelope.idempotencyKey,
      kind: envelope.kind,
      status: 'APPLIED',
      attemptVersion: opts.attemptVersion,
      changedKinds: opts.changedKinds,
      effectRefs: opts.effectRefs,
    });
  }

  private async dispatch(ctx: ServerContext, envelope: PublicCommandEnvelope): Promise<CommandReceipt> {
    switch (envelope.kind) {
      case 'family.createLearner': {
        const learnerId = this.nextId('lrn');
        this.learners.set(learnerId, { learnerId, familyId: ctx.familyId, alias: envelope.payload.alias });
        return this.buildReceipt(envelope, {
          effectRefs: [`learner:${learnerId}`],
          changedKinds: ['learning.resumePoint'],
        });
      }
      case 'learning.startAttempt': {
        const target = envelope.target;
        if (target.scope !== 'LEARNER') {
          throw stubError('INVALID_OPERATION', 'startAttempt requires a LEARNER target');
        }
        const release = RELEASES.get(envelope.payload.releaseId);
        if (!release) {
          throw stubError('CONTENT_UNAVAILABLE', `unknown release: ${envelope.payload.releaseId}`);
        }
        if (release.status !== 'AVAILABLE') {
          throw stubError('CONTENT_UNAVAILABLE', `release is not AVAILABLE: ${envelope.payload.releaseId}`);
        }
        const attemptId = this.nextId('att');
        const cycleId = this.nextId('cyc');
        const questionInstanceId = this.nextId('qi');
        const attempt: StubAttempt = {
          attemptId,
          familyId: ctx.familyId,
          learnerId: target.learnerId,
          releaseId: envelope.payload.releaseId,
          questionInstanceId,
          cycleId,
          attemptStatus: 'ACTIVE',
          version: 1,
          phase: 'PREDICT',
          sceneState: { radiusMm: 30, heightMm: 80, unrollPermille: 0, section: 'NONE', selectedFaceIds: [] },
          seq: 0,
          createdAtMs: this.now(),
        };
        this.attempts.set(attemptId, attempt);
        const eventId = this.appendEvent(attempt, 'ATTEMPT_STARTED', envelope);
        return this.buildReceipt(envelope, {
          effectRefs: [
            `attempt:${attemptId}`,
            `cycle:${cycleId}`,
            `questionInstance:${questionInstanceId}`,
            `event:${eventId}`,
          ],
          changedKinds: ['learning.resumePoint', 'learning.attemptView', 'learning.timeline'],
          attemptVersion: 1,
        });
      }
      case 'learning.recordPrediction': {
        const attempt = this.requireAttempt(ctx, envelope);
        if (attempt.phase !== 'PREDICT') {
          throw stubError('INVALID_OPERATION', `recordPrediction requires PREDICT phase, current ${attempt.phase}`);
        }
        attempt.phase = 'OPERATE';
        const eventId = this.appendEvent(attempt, 'PREDICTION_RECORDED', envelope);
        return this.buildReceipt(envelope, {
          effectRefs: [`attempt:${attempt.attemptId}`, `event:${eventId}`],
          changedKinds: ['learning.attemptView', 'learning.questionView', 'learning.timeline'],
        });
      }
      case 'learning.commitOperation': {
        const attempt = this.requireAttempt(ctx, envelope);
        this.checkExpectedVersion(attempt, envelope.expectedAttemptVersion);
        if (attempt.phase !== 'OPERATE') {
          throw stubError('INVALID_OPERATION', `commitOperation requires OPERATE phase, current ${attempt.phase}`);
        }
        const op = envelope.payload.operation;
        if (op.type === 'SetDimension') {
          if (op.dimension === 'RADIUS') attempt.sceneState.radiusMm = op.valueMm;
          else attempt.sceneState.heightMm = op.valueMm;
        } else if (op.type === 'SetUnroll') {
          attempt.sceneState.unrollPermille = op.valuePermille;
        } else if (op.type === 'SetSection') {
          attempt.sceneState.section = op.section;
        } else {
          attempt.sceneState.selectedFaceIds = [...op.faceIds];
        }
        attempt.version += 1;
        const eventId = this.appendEvent(attempt, 'OPERATION_COMMITTED', envelope);
        return this.buildReceipt(envelope, {
          effectRefs: [`attempt:${attempt.attemptId}`, `event:${eventId}`],
          changedKinds: ['learning.attemptView', 'learning.questionView', 'learning.timeline'],
          attemptVersion: attempt.version,
        });
      }
      case 'learning.submitResponse': {
        const attempt = this.requireAttempt(ctx, envelope);
        this.checkExpectedVersion(attempt, envelope.expectedAttemptVersion);
        if (attempt.phase !== 'OPERATE') {
          throw stubError('INVALID_OPERATION', `submitResponse requires OPERATE phase, current ${attempt.phase}`);
        }
        attempt.phase = 'VERIFY';
        const submissionId = this.nextId('sub');
        attempt.version += 1;
        const eventId = this.appendEvent(attempt, 'SUBMISSION_RECORDED', envelope);
        return this.buildReceipt(envelope, {
          effectRefs: [`attempt:${attempt.attemptId}`, `submission:${submissionId}`, `event:${eventId}`],
          changedKinds: ['learning.attemptView', 'learning.timeline'],
          attemptVersion: attempt.version,
        });
      }
      default:
        // Real product commands not exercised by the H0 roundtrip; the stub
        // refuses them with a named reason. CAPABILITY_UNAVAILABLE is reserved
        // for un-enabled conditional capabilities (code.*), so this is INVALID_OPERATION.
        throw stubError('INVALID_OPERATION', `command not implemented in H0 stub: ${envelope.kind}`);
    }
  }

  private lookupReceiptInternal(ctx: ServerContext, idempotencyKey: string, commandKind: string): ReceiptLookup {
    const prior = this.receipts.get(receiptKey(ctx.familyId, ctx.actorId, idempotencyKey));
    if (!prior || prior.receipt.kind !== commandKind) {
      return parseReceiptLookup({ status: 'NOT_FOUND' });
    }
    return parseReceiptLookup({ status: 'CONFIRMED', receipt: prior.receipt });
  }

  private async lookupReceiptImpl(
    ctx: ServerContext,
    req: { idempotencyKey: string; commandKind: string },
  ): Promise<ReceiptLookup> {
    return this.lookupReceiptInternal(ctx, req.idempotencyKey, req.commandKind);
  }

  private async queryImpl(ctx: ServerContext, requestInput: Parameters<LearningServer['query']>[1]): Promise<PublicProjection> {
    const request = parsePublicQuery(requestInput as unknown);
    switch (request.kind) {
      case 'learning.attemptView': {
        const attempt = this.requireVisibleAttempt(ctx, request.attemptId);
        return parsePublicProjection({
          kind: 'learning.attemptView',
          attemptId: attempt.attemptId,
          learnerId: attempt.learnerId,
          releaseId: attempt.releaseId,
          questionInstanceId: attempt.questionInstanceId,
          attemptStatus: attempt.attemptStatus,
          version: attempt.version,
          currentCycle: {
            cycleId: attempt.cycleId,
            phase: attempt.phase,
            questionInstanceId: attempt.questionInstanceId,
          },
        });
      }
      case 'learning.questionView': {
        const attempt = this.requireVisibleAttempt(ctx, request.attemptId);
        if (request.cycleId !== undefined && request.cycleId !== attempt.cycleId) {
          throw stubError('INVALID_OPERATION', `unknown cycle for attempt: ${request.cycleId}`);
        }
        return parsePublicProjection({ kind: 'learning.questionView', spec: this.buildQuestionSpec(attempt) });
      }
      case 'learning.timeline': {
        const attempt = this.requireVisibleAttempt(ctx, request.attemptId);
        const all = this.events.get(attempt.attemptId) ?? [];
        const afterSeq = request.afterSeq ?? 0;
        const limit = request.limit ?? 100;
        const page = all.filter((e) => e.seq > afterSeq).slice(0, limit);
        const last = page[page.length - 1];
        const hasMore = last !== undefined && all.some((e) => e.seq > last.seq);
        return parsePublicProjection({
          kind: 'learning.timeline',
          attemptId: attempt.attemptId,
          events: page.map((e) => ({
            seq: e.seq,
            eventId: e.eventId,
            eventType: e.eventType,
            commandKind: e.commandKind,
            occurredAtMs: e.occurredAtMs,
          })),
          ...(hasMore ? { nextAfterSeq: last.seq } : {}),
        });
      }
      case 'learning.resumePoint': {
        const learner = this.learners.get(request.learnerId);
        if (!learner || learner.familyId !== ctx.familyId) {
          throw stubError('FORBIDDEN', 'cross-family learner rejected');
        }
        const active = [...this.attempts.values()]
          .filter((a) => a.learnerId === request.learnerId && a.attemptStatus === 'ACTIVE')
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        const latest = active[0];
        return parsePublicProjection({
          kind: 'learning.resumePoint',
          learnerId: request.learnerId,
          attempt: latest
            ? {
                attemptId: latest.attemptId,
                cycleId: latest.cycleId,
                phase: latest.phase,
                version: latest.version,
              }
            : null,
        });
      }
      case 'catalog.availableLessons': {
        const lessons = [...RELEASES.entries()]
          .filter(([, release]) => release.status === 'AVAILABLE')
          .map(([releaseId, release]) => ({ releaseId, taskId: release.taskId, title: release.title }));
        return parsePublicProjection({ kind: 'catalog.availableLessons', lessons });
      }
      case 'learning.receipt': {
        const result = this.lookupReceiptInternal(ctx, request.idempotencyKey, request.commandKind);
        return parsePublicProjection({ kind: 'learning.receipt', result });
      }
      case 'guardian.evidenceSummary': {
        if (ctx.role !== 'GUARDIAN') {
          throw stubError('FORBIDDEN', 'guardian.evidenceSummary requires the guardian role');
        }
        return parsePublicProjection({
          kind: 'guardian.evidenceSummary',
          learnerId: request.learnerId,
          ...(request.attemptId !== undefined ? { attemptId: request.attemptId } : {}),
          items: [],
        });
      }
      case 'code.runStatus': {
        throw stubError('CAPABILITY_UNAVAILABLE', 'code capability not enabled in first batch');
      }
      default:
        throw stubError('INVALID_OPERATION', `query not implemented in H0 stub: ${request.kind}`);
    }
  }

  private requireVisibleAttempt(ctx: ServerContext, attemptId: string): StubAttempt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw stubError('INVALID_OPERATION', `unknown attempt: ${attemptId}`);
    }
    if (attempt.familyId !== ctx.familyId) {
      throw stubError('FORBIDDEN', 'cross-family attempt rejected');
    }
    return attempt;
  }

  private buildQuestionSpec(attempt: StubAttempt): ReturnType<typeof parsePublicQuestionSpec> {
    return parsePublicQuestionSpec({
      questionInstanceId: attempt.questionInstanceId,
      releaseId: attempt.releaseId,
      taskId: RELEASES.get(attempt.releaseId)?.taskId ?? SYNTH_TASK_ID,
      taskVersion: '1',
      prompt: [
        { type: 'TEXT', text: '合成任务：改变半径后，哪些量会变化？' },
        {
          type: 'MEASUREMENT_TABLE',
          columns: [
            { label: '半径', unitId: 'mm' },
            { label: '高度', unitId: 'mm' },
          ],
          rows: [[String(attempt.sceneState.radiusMm), String(attempt.sceneState.heightMm)]],
        },
      ],
      responseSchemaId: 'rondo.response.propertyJudgments.v1',
      numericPolicy: { pi: '3.14', displayDecimals: 2, acceptedUnitIds: ['mm', 'cm'] },
      scene: {
        rendererId: SYNTH_RENDERER_ID,
        rendererContractVersion: SYNTH_RENDERER_CONTRACT_VERSION,
        state: attempt.sceneState,
      },
      allowedOperationIds: ['SetDimension', 'SetSection'],
      materialVisibility: visibilityForPhase(attempt.phase),
    });
  }

  private async closeImpl(): Promise<void> {
    this.closed = true;
  }
}

export function createStubHarness(): StubHarness {
  return new StubHarness();
}

/** Narrow an unknown thrown value to a RondoError for assertions; returns null when it is not one. */
export function asRondoError(err: unknown): RondoError | null {
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    const candidate = err as { code: unknown; message: unknown };
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return err as RondoError;
    }
  }
  return null;
}
