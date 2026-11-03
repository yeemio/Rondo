import {mathLessonForRelease,applyMathOperation} from '../curriculum/math6';
import {mathOperationSchema} from '../contracts/public/math6';
import {evaluateMath6} from './math6-evaluate';
import {evaluateGespObjective} from './gesp-evaluate';
import {CompilerLifecycle,CompilerAdmissionRejected} from './compiler-lifecycle';
import {GESP_LESSONS} from '../curriculum/gesp';
import {gespReasoningOperationSchema} from '../contracts/public/gesp';
/**
 * createLearningServer -- the learning domain server (R1 scope).
 *
 * Frozen sources:
 * - modules/contracts/server/learning.ts -- the factory signature this module
 *   exports; all dependencies injected, no Electron import
 * - LIFECYCLE-DATA-API.md §4/§7 -- synchronous single-transaction command
 *   pipeline: authorize -> read prior receipt -> CAS -> validate/compute ->
 *   facts -> receipt -> commit; same key + same canonical hash returns the
 *   original receipt, same key + different hash is IDEMPOTENCY_CONFLICT
 * - LIFECYCLE-DATA-API.md §3/§6 -- attempt/cycle state machines, command
 *   catalogue semantics, stable error codes
 * - B-D1 (learningAttempt.version is the single CAS point), B-D2 (receipts
 *   carry no business results), B-D8 (payloadVersion '1')
 *
 * Rejection mapping: business rejections surface as REJECTED receipts with a
 * stable errorCode and are stored (replay of the same envelope returns the
 * same REJECTED receipt). VERSION_CONFLICT / IDEMPOTENCY_CONFLICT /
 * HOST_RECOVERING / PERSISTENCE_FAILED normally leave no receipt row. Only
 * a typed code reservation rejection or stale code-run version, before
 * admission or writes, commits a REJECTED receipt. Unknown deliveries retain
 * the ORIGINAL key and envelope.
 *
 * Internal seams used beyond the frozen ports (documented, failing closed):
 * - ContentServiceInternal (getTaskSpec/getHintContent/sampleGivens)
 * - storage.dispose(spec) for the two-phase deletion confirm
 * - concrete repository extras (see adapters/sqlite/repositories.ts)
 */
import { createHash } from 'node:crypto';
import {dailyDate,dailyEntrySnapshot,dailyEvents,dailyMembership,readDailySets,projectDailySet,selectDailyItems,evaluateDailyShort,type DailyMembership} from './daily';
import {dailyPoolEntry} from '../curriculum/daily';
import type {DailyEntry,DailyScope,DailyPlan} from '../contracts/public/daily';
import { activityStateSchema, type ActivityState, type CodeSnapshot, type CodeAvailability, type ActivityHistory } from '../contracts/public/activity';
import { COMPILER_CONTRACT, LEARNING_ACTIVITIES, supersededActivityNotice } from '../curriculum/mvp';
import compilerConfig from '../../workers/cpp/worker-lock.json';
import type { ActivityRule } from '../contracts/server/rules-activity';
import {AI_NEW_IDS,aiLabOperationSchema,applyAILabOperation,type NewAIId} from '../contracts/public/ai-lab';
import {evaluateAILab} from './ai-evaluate';
import { hashText, executeActivityCode, UNCONFIRMED_CODE_MESSAGE, reportCodeFailure, type StoredCodeRun } from './activity-code';
import { parseEnvelope, type PublicCommandEnvelope, type StructuredResponseItem, type RecordPredictionPayload } from '../contracts/public/envelope';
import { parsePublicQuery, deletionResultSchema, type DeletionScope, type DeletionResult, type PublicProjection, type PublicQuery } from '../contracts/public/queries';
import {
  parseCommandReceipt,
  type CommandReceipt,
  type ReceiptLookup,
} from '../contracts/public/receipts';
import { rondoError, versionConflictError, type RondoError, type RondoErrorCode } from '../contracts/public/errors';
import { PROTOCOL_VERSION } from '../contracts/public/protocol';
import { canonicalize, computePayloadHash } from '../contracts/public/canonical';
import type { CylinderStateV1, CylinderStateV2, PublicSceneState } from '../contracts/public/scene';
import { initialSceneStateFor, type FamilyRuleBody } from '../content';
import type { FrozenInstanceTruth } from '../contracts/server/rules-l34';
import { applyGridOperation, type GridBoardStateV1, type GridOperationV1 } from '../contracts/public/scene-gridboard';
import type { StepOperationV1, StepProgramStateV1, StepSpecV1 } from '../contracts/public/scene-steps';
import { validateStepEdit, traceLength, type StepEditConstraints } from '../scenes/steps/engine';
import type { ServerContext } from '../contracts/server/context';
import type {
  LearningServer,
  LearningServerDeps,
  ServerClock,
  IdGenerator,
} from '../contracts/server/learning';
import type {
  CommandReceiptRecord,
  LearningAttemptRecord,
  LearningCycleRecord,
  Repositories,
  RepoScope,
  StoragePort,
  DataOperationRecord,
} from '../contracts/server/storage';
import type { ContentService } from '../contracts/server/content';
import type { ContentServiceInternal, LoadedTaskSpec } from '../content';
import type { HintFile } from '../content/task-file';
import type { TaskRule } from '../contracts/server/rules';
import { evaluateResponse, evaluateResponseV2, evaluateResponseFamily, type EvaluationResult, type ConfirmedOperationActivity } from './evaluate';
import type { RuleBodyV2 } from '../contracts/server/rules';
import { applyCylinderOperation, visibilityForPhase } from './ops';
import type { DisposalSpec } from '../../adapters/sqlite/disposal';

export { learnerActorId, createLocalAuth, SCRYPT_PARAMS } from './auth';
export type { LocalAuth, LocalAuthDeps } from './auth';
export { lateralAreaMm2 } from './evaluate';
export type { EvaluationResult } from './evaluate';

const REJECT_RECEIPT_CODES: ReadonlySet<RondoErrorCode> = new Set<RondoErrorCode>([
  'INVALID_OPERATION',
  'FORBIDDEN',
  'CONTENT_UNAVAILABLE',
  'CONTENT_REVOKED',
  'UNKNOWN_RENDERER',
  'SCHEMA_MISMATCH',
  'CAPABILITY_UNAVAILABLE',
]);

const DELETION_PREVIEW_LIFETIME_MS = 15 * 60 * 1000;
const EVENT_PAYLOAD_VERSION = '1'; // B-D8
const RUBRIC_VERSION = 'rondo.rubric.v1';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function isRondoError(err: unknown): err is RondoError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'message' in err &&
    typeof (err as { code: unknown }).code === 'string'
  );
}

function zodToInvalidOperation(err: unknown): RondoError {
  const issues =
    err instanceof Error && Array.isArray((err as unknown as { issues?: unknown }).issues)
      ? ((err as unknown as { issues: { path: (string | number)[]; message: string }[] }).issues ?? [])
      : [];
  const first = issues[0];
  const detail = first ? `${first.path.join('.')}: ${first.message}` : 'schema validation failed';
  return rondoError('INVALID_OPERATION', `请求结构不合法（${detail.slice(0, 400)}）。`);
}

function toPublicReceipt(record: CommandReceiptRecord): CommandReceipt {
  return parseCommandReceipt({
    protocolVersion: PROTOCOL_VERSION,
    commandId: record.commandId,
    idempotencyKey: record.idempotencyKey,
    kind: record.kind,
    status: record.status,
    errorCode: record.errorCode ?? undefined,
    attemptVersion: record.attemptVersionAfter ?? undefined,
    changedKinds: JSON.parse(record.changedKindsJson) as string[],
    effectRefs: JSON.parse(record.effectRefsJson) as string[],
  });
}

// ---------------------------------------------------------------------------
// Server implementation
// ---------------------------------------------------------------------------

export function createLearningServer(deps: LearningServerDeps): LearningServer {
  return new LearningServerImpl(deps);
}

class LearningServerImpl {
  private closed = false;
  private inFlight = 0;

  private readonly compilerLifecycle?:CompilerLifecycle;
  constructor(private readonly deps: LearningServerDeps) {
    if(deps.compiler)this.compilerLifecycle=new CompilerLifecycle(deps.compiler,deps.compilerFactory);
  }

  private now(): number {
    return this.deps.time.now();
  }

  private content(): ContentServiceInternal {
    const candidate = this.deps.content as ContentService & Partial<ContentServiceInternal>;
    if (
      typeof candidate.getTaskSpec !== 'function' ||
      typeof candidate.getHintContent !== 'function' ||
      typeof candidate.sampleGivens !== 'function' ||
      typeof candidate.getRuleBodyV2 !== 'function'
    ) {
      throw rondoError('PERSISTENCE_FAILED', 'content service lacks internal capabilities');
    }
    return candidate as ContentServiceInternal;
  }

  private disposalCapable(): StoragePort & { dispose(spec: DisposalSpec): { deleted: Record<string, number> } } {
    const candidate = this.deps.storage as StoragePort & { dispose?: (spec: DisposalSpec) => unknown };
    if (typeof candidate.dispose !== 'function') {
      throw rondoError('PERSISTENCE_FAILED', 'storage lacks disposal capability');
    }
    return candidate as StoragePort & { dispose(spec: DisposalSpec): { deleted: Record<string, number> } };
  }

  async handleCommand(ctx: ServerContext, envelopeInput: PublicCommandEnvelope): Promise<CommandReceipt> {
    if (this.closed) {
      throw rondoError('HOST_RECOVERING', '服务器正在关闭，暂不接受新命令。');
    }
    let envelope: PublicCommandEnvelope;
    try {
      envelope = parseEnvelope(envelopeInput as unknown);
    } catch (err) {
      throw zodToInvalidOperation(err);
    }
    const hash = await computePayloadHash({
      protocolVersion: envelope.protocolVersion,
      kind: envelope.kind,
      payload: envelope.payload,
      target: envelope.target,
      binding: envelope.binding,
      expectedAttemptVersion: envelope.expectedAttemptVersion,
    });
    this.inFlight += 1;
    let admittedJobId:string|undefined, committed=false;
    try {
      const receipt = await this.deps.storage.tx(`cmd.${envelope.kind}`, async (repos) => {
        const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
        // Receipt read AFTER authorization context is established (the ctx is
        // resolved by the Host before this call; a stale session never gets here).
        const prior = await repos.commandReceipt.findByKey(scope, {
          familyId: ctx.familyId,
          actorId: ctx.actorId,
          idempotencyKey: envelope.idempotencyKey,
        });
        if (prior !== null) {
          if (prior.payloadHash !== hash) {
            throw rondoError('IDEMPOTENCY_CONFLICT', '同一幂等键被用于不同请求内容。');
          }
          return toPublicReceipt(prior);
        }
        let record: CommandReceiptRecord;
        try {
          const applied = await this.dispatch(ctx, envelope, repos, scope, jobId=>{admittedJobId=jobId;});
          record = {
            familyId: ctx.familyId,
            actorId: ctx.actorId,
            idempotencyKey: envelope.idempotencyKey,
            commandId: envelope.commandId,
            kind: envelope.kind,
            payloadHash: hash,
            bindingJson: envelope.binding === undefined ? null : canonicalize(envelope.binding),
            expectedAttemptVersion: envelope.expectedAttemptVersion ?? null,
            status: 'APPLIED',
            errorCode: null,
            effectRefsJson: canonicalize(applied.effectRefs),
            attemptVersionAfter: applied.attemptVersion ?? null,
            changedKindsJson: canonicalize(applied.changedKinds),
            at: this.now(),
          };
        } catch (err) {
          if (isRondoError(err) && (REJECT_RECEIPT_CODES.has(err.code) ||
              (envelope.kind==='code.requestRun'&&!admittedJobId&&
                (err instanceof CompilerAdmissionRejected||err.code==='VERSION_CONFLICT')))) {
            record = {
              familyId: ctx.familyId,
              actorId: ctx.actorId,
              idempotencyKey: envelope.idempotencyKey,
              commandId: envelope.commandId,
              kind: envelope.kind,
              payloadHash: hash,
              bindingJson: envelope.binding === undefined ? null : canonicalize(envelope.binding),
              expectedAttemptVersion: envelope.expectedAttemptVersion ?? null,
              status: 'REJECTED',
              errorCode: err.code,
              effectRefsJson: canonicalize([]),
              attemptVersionAfter: null,
              changedKindsJson: canonicalize([]),
              at: this.now(),
            };
          } else {
            throw err;
          }
        }
        const inserted = await repos.commandReceipt.tryInsert(scope, record);
        if (inserted === 'DUPLICATE') {
          const raced = await repos.commandReceipt.findByKey(scope, {
            familyId: ctx.familyId,
            actorId: ctx.actorId,
            idempotencyKey: envelope.idempotencyKey,
          });
          if (raced !== null && raced.payloadHash === hash) return toPublicReceipt(raced);
          throw rondoError('IDEMPOTENCY_CONFLICT', '同一幂等键被用于不同请求内容。');
        }
        return toPublicReceipt(record);
      });
      committed=true;
      if(receipt.status==='APPLIED' && (envelope.kind==='code.requestRun'||envelope.kind==='code.requestCancel')) await this.launchCode(ctx,receipt);
      if (receipt.status === 'APPLIED' && envelope.kind === 'guardian.confirmDeletion') await this.finishDeletionCopies(ctx, receipt);
      return receipt;
    } catch(error) {
      if(!committed&&admittedJobId)this.compilerLifecycle?.abort(admittedJobId);
      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  async query(ctx: ServerContext, requestInput: PublicQuery): Promise<PublicProjection> {
    if (this.closed) {
      throw rondoError('HOST_RECOVERING', '服务器正在关闭，暂不接受查询。');
    }
    let request: PublicQuery;
    try {
      request = parsePublicQuery(requestInput as unknown);
    } catch (err) {
      throw zodToInvalidOperation(err);
    }
    return this.deps.storage.read(async (repos) => this.runQuery(ctx, request, repos));
  }

  async lookupReceipt(ctx: ServerContext, req: { idempotencyKey: string; commandKind: string }): Promise<ReceiptLookup> {
    return this.deps.storage.read(async (repos) =>
      this.lookupReceiptInternal({ familyId: ctx.familyId, actorId: ctx.actorId }, repos, req.idempotencyKey, req.commandKind),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    for(const control of this.runningCode.values()) control.cancelled=true;
    await this.compilerLifecycle?.close();
    await Promise.all([...this.runningCode.values()].map(x=>x.promise));
    const deadline = Date.now() + 5000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async lookupReceiptInternal(
    scope: RepoScope,
    repos: Repositories,
    idempotencyKey: string,
    commandKind: string,
  ): Promise<ReceiptLookup> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw rondoError('INVALID_OPERATION', 'idempotencyKey 不合法。');
    }
    const prior = await repos.commandReceipt.findByKey(scope, {
      familyId: scope.familyId,
      actorId: scope.actorId,
      idempotencyKey,
    });
    if (prior === null || prior.kind !== commandKind) {
      return { status: 'NOT_FOUND' };
    }
    return { status: 'CONFIRMED', receipt: toPublicReceipt(prior) };
  }

  // -------------------------------------------------------------------------
  // Shared command helpers
  // -------------------------------------------------------------------------

  private async requireLearner(ctx: ServerContext, envelope: PublicCommandEnvelope, repos: Repositories): Promise<string> {
    if (envelope.target.scope !== 'LEARNER' || envelope.target.learnerId === undefined) {
      throw rondoError('FORBIDDEN', 'learning.* 命令需要 LEARNER 目标。');
    }
    if (ctx.role !== 'LEARNER' || ctx.learnerId !== envelope.target.learnerId) {
      throw rondoError('FORBIDDEN', '目标学习者必须与当前会话一致。');
    }
    const learner = await repos.learner.findById({ familyId: ctx.familyId, actorId: ctx.actorId }, envelope.target.learnerId);
    if (learner === null) {
      throw rondoError('FORBIDDEN', '该学习者不属于当前家庭。');
    }
    return learner.learnerId;
  }

  private async requireAttempt(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
  ): Promise<LearningAttemptRecord> {
    if (envelope.target.scope !== 'LEARNER' || envelope.target.attemptId === undefined) {
      throw rondoError('INVALID_OPERATION', '命令需要携带 attemptId 的 LEARNER 目标。');
    }
    const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
    const attempt = await repos.learningAttempt.findById(scope, envelope.target.attemptId);
    if (attempt === null) {
      // Unknown and cross-family attempts are uniformly invisible.
      throw rondoError('INVALID_OPERATION', `未知的 attempt：${envelope.target.attemptId}`);
    }
    if (attempt.learnerId !== envelope.target.learnerId) {
      throw rondoError('INVALID_OPERATION', 'attempt 不属于目标学习者。');
    }
    if (attempt.attemptStatus === 'CONTENT_BLOCKED') {
      // LIFECYCLE §2: REVOKED content stops further judging on bound attempts.
      throw rondoError('CONTENT_REVOKED', '该 attempt 绑定的内容已撤销，不能继续判题。');
    }
    if (envelope.binding !== undefined) {
      await this.validateBinding(scope, envelope, repos, attempt);
    }
    return attempt;
  }

  private async validateBinding(
    scope: RepoScope,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    attempt: LearningAttemptRecord,
  ): Promise<void> {
    const binding = envelope.binding!;
    const release = await repos.contentRelease.findById(scope, binding.releaseId);
    if (release === null || release.releaseId !== attempt.releaseId) {
      throw rondoError('CONTENT_UNAVAILABLE', `绑定引用了未知 release：${binding.releaseId}`);
    }
    const declarations = JSON.parse(release.rendererDeclarationsJson) as { rendererContractVersion: string }[];
    if (!declarations.some((d) => d.rendererContractVersion === binding.rendererContractVersion)) {
      throw rondoError('UNKNOWN_RENDERER', `renderer 契约版本未登记：${binding.rendererContractVersion}`);
    }
    const cycle = await repos.learningCycle.findCurrentByAttempt(scope, attempt.attemptId);
    if (cycle === null || cycle.questionInstanceId !== binding.questionInstanceId) {
      throw rondoError('INVALID_OPERATION', '绑定引用了不匹配的 questionInstanceId。');
    }
  }

  private async requireReleaseForNewWork(scope: RepoScope, releaseId: string, repos: Repositories): Promise<void> {
    const notice=supersededActivityNotice(releaseId);if(notice)throw rondoError('CONTENT_UNAVAILABLE',notice);
    const release = await repos.contentRelease.findById(scope, releaseId);
    if (release === null) {
      throw rondoError('CONTENT_UNAVAILABLE', `未知 release：${releaseId}`);
    }
    if (release.status === 'REVOKED') {
      throw rondoError('CONTENT_REVOKED', `内容已撤销：${releaseId}`);
    }
    if (release.status !== 'AVAILABLE') {
      throw rondoError('CONTENT_UNAVAILABLE', `内容当前不可用（${release.status}）：${releaseId}`);
    }
  }

  private async casAttempt(
    scope: RepoScope,
    repos: Repositories,
    attempt: LearningAttemptRecord,
    input: { nextStatus?: LearningAttemptRecord['attemptStatus']; endAttempt?: boolean; resultSummaryJson?: string | null },
  ): Promise<LearningAttemptRecord> {
    const updated = await repos.learningAttempt.updateWithCas(scope, {
      attemptId: attempt.attemptId,
      expectedVersion: attempt.version,
      ...input,
    });
    if (updated === null) {
      throw versionConflictError(attempt.version, '请重新读取 attempt 视图后以当前版本重试。');
    }
    return updated;
  }

  private async bumpAttempt(scope: RepoScope, repos: Repositories, attempt: LearningAttemptRecord): Promise<LearningAttemptRecord> {
    return this.casAttempt(scope, repos, attempt, {});
  }

  private async setPhase(
    scope: RepoScope,
    repos: Repositories,
    cycle: LearningCycleRecord,
    nextPhase: LearningCycleRecord['phase'],
  ): Promise<LearningCycleRecord> {
    const updated = await repos.learningCycle.updatePhaseWithCas(scope, {
      cycleId: cycle.cycleId,
      expectedStateVersion: cycle.stateVersion,
      nextPhase,
    });
    if (updated === null) {
      throw rondoError('PERSISTENCE_FAILED', 'cycle 状态推进失败，事务已回滚。');
    }
    return updated;
  }

  private async appendEvent(
    scope: RepoScope,
    repos: Repositories,
    envelope: PublicCommandEnvelope,
    attemptId: string,
    eventType: string,
    payload: unknown,
  ): Promise<string> {
    const event = await repos.learningEvent.append(scope, {
      attemptId,
      familyId: scope.familyId,
      commandKind: envelope.kind,
      eventType,
      payloadJson: canonicalize(payload),
      payloadVersion: EVENT_PAYLOAD_VERSION,
      occurredAt: this.now(),
    });
    return `event:${event.eventId}`;
  }

  private async taskSpecFor(
    scope: RepoScope,
    releaseId: string,
    taskId: string,
    repos: Repositories,
  ): Promise<{ taskSpec: LoadedTaskSpec; givens: { radiusMm: number; heightMm: number } | Record<string, unknown> }> {
    const content = this.content();
    const release = await repos.contentRelease.findById(scope, releaseId);
    if (release === null) {
      throw rondoError('CONTENT_UNAVAILABLE', `未知 release：${releaseId}`);
    }
    const taskSpec = content.getTaskSpec(releaseId, taskId);
    if (taskSpec === null) {
      throw rondoError('CONTENT_UNAVAILABLE', `release 未登记该任务：${taskId}`);
    }
    const cylinderFile = taskSpec.file as LoadedTaskSpec['file'] & { sampleParams?: boolean; givens: { radiusMm: number; heightMm: number } | Record<string, unknown> };
    const givens =
      cylinderFile.sampleParams === true
        ? content.sampleGivens(releaseId, taskId, this.deps.ids.newId('params'))
        : cylinderFile.givens;
    return { taskSpec, givens };
  }

  /** Family-aware initial confirmed state (cylinder V1/V2, gridboard, steps). */
  private initialConfirmedStateFor(
    releaseId: string,
    taskSpec: LoadedTaskSpec,
    givens: { radiusMm: number; heightMm: number } | Record<string, unknown>,
  ): PublicSceneState {
    const family = this.content().familyOf(releaseId);
    if (family === 'cylinder') {
      const cylTask = taskSpec.file as LoadedTaskSpec['file'] & {
        initialState?: { unrollPermille?: number; section?: CylinderStateV1['section']; selectedFaceIds?: string[]; layerCount?: number; visibleLayerCount?: number };
      };
      const base = {
        radiusMm: (givens as { radiusMm: number }).radiusMm,
        heightMm: (givens as { heightMm: number }).heightMm,
        unrollPermille: cylTask.initialState?.unrollPermille ?? 0,
        section: cylTask.initialState?.section ?? 'NONE',
        selectedFaceIds: cylTask.initialState?.selectedFaceIds ?? [],
      };
      if (cylTask.initialState?.layerCount !== undefined) {
        return { ...base, layerCount: cylTask.initialState.layerCount, visibleLayerCount: cylTask.initialState.visibleLayerCount ?? 0 };
      }
      return base;
    }
    return initialSceneStateFor(family, taskSpec.file, canonicalize(givens));
  }

  /**
   * Family-aware typed operation overlay. Cylinder keeps the v1 path (with
   * @2 layer ops via overlayOperation); gridboard applies its pure state
   * machine; steps validates the edit against the card's operation
   * constraints (shared engine — the same validation the UI preview uses).
   * Every family rejects out-of-domain edits as INVALID_OPERATION.
   */
  private applyFamilyOperation(
    releaseId: string,
    taskId: string,
    state: PublicSceneState,
    op: { type: string } & Record<string, unknown>,
  ): PublicSceneState {
    const family = this.content().familyOf(releaseId);
    if(family==='activity'){
      const activity=activityStateSchema.parse(state);
      if(op.type==='SaveActivityDraft') return activityStateSchema.parse({...activity,draft:op['draft']});
      if(activity.math){const q=mathLessonForRelease(releaseId,taskId),parsed=mathOperationSchema.safeParse(op);const next=q&&parsed.success?applyMathOperation(q,activity.math,parsed.data):null;if(!next)throw rondoError('INVALID_OPERATION','这项模型操作未登记或超出当前活动范围。');return activityStateSchema.parse({...activity,math:next});}
      if(activity.gesp){const parsed=gespReasoningOperationSchema.safeParse(op);if(!parsed.success||!GESP_LESSONS.some(q=>q.id===activity.gesp!.questionId))throw rondoError('INVALID_OPERATION','本题未登记这项推演操作。');return activityStateSchema.parse({...activity,gesp:{...activity.gesp,reasoning:{...activity.gesp.reasoning,[parsed.data.fieldId]:parsed.data.text}}});}
      if(activity.lab&&AI_NEW_IDS.includes(activity.activity as NewAIId)){const parsed=aiLabOperationSchema.safeParse(op);const next=parsed.success?applyAILabOperation(activity.activity as NewAIId,activity.lab,parsed.data):null;if(!next)throw rondoError('INVALID_OPERATION','这项操作未登记、超出本活动范围或阶段不符。');return activityStateSchema.parse({...activity,lab:next});}
      if(op.type==='SetActivityScale'&&activity.activity==='ratio') return activityStateSchema.parse({...activity,scale:op['value']});
      const allowed=activity.activity==='cpp'?['algorithm']:activity.activity==='ai-a7'?['hours','animals','bus']:[];
      if(op.type==='InspectActivityCard'&&allowed.includes(String(op['cardId']))) return {...activity,inspected:[...new Set([...activity.inspected,String(op['cardId'])])]};
      throw rondoError('INVALID_OPERATION','本活动未登记该操作。');
    }
    if (family === 'gridboard') {
      const grid = state as GridBoardStateV1;
      const next = applyGridOperation(grid, op as unknown as GridOperationV1);
      if (next === null) {
        throw rondoError('INVALID_OPERATION', '图板操作超出范围（格数/涂色数越界）。');
      }
      return next;
    }
    if (family === 'steps') {
      const step = state as StepProgramStateV1;
      if (op.type === 'EditStepProgram') {
        const taskSpec = this.content().getTaskSpec(releaseId, taskId);
        const constraints = (taskSpec?.file as { operationConstraints?: Array<Record<string, unknown>> } | undefined)?.operationConstraints ?? [];
        const raw = constraints.find((c) => c['type'] === 'StepProgram') ?? {};
        const constraint: StepEditConstraints = {
          editableSlots: Array.isArray(raw['editableSlots']) ? (raw['editableSlots'] as string[]) : [],
          insertableKinds: Array.isArray(raw['insertableKinds'])
            ? (raw['insertableKinds'] as StepEditConstraints['insertableKinds'])
            : [],
          deletableSteps: Array.isArray(raw['deletableSteps']) ? (raw['deletableSteps'] as number[]) : [],
          maxProgramSteps: typeof raw['maxProgramSteps'] === 'number' ? raw['maxProgramSteps'] : 64,
          maxOutputLines: typeof raw['maxOutputLines'] === 'number' ? raw['maxOutputLines'] : 8,
        };
        const verdict = validateStepEdit(step.program as StepSpecV1[], op['steps'] as StepSpecV1[], step.inputs, constraint);
        if (!verdict.ok) {
          throw rondoError('INVALID_OPERATION', verdict.rejection.message);
        }
        return { ...step, program: JSON.parse(JSON.stringify(op['steps'])) as StepSpecV1[] };
      }
      if (op.type === 'SetTraceCursor') {
        const len = traceLength(step.program as StepSpecV1[], step.inputs);
        const mode = op['mode'] as string;
        const cursor = mode === 'RESET' ? 0 : mode === 'END' ? len : Math.max(0, Math.min((op['index'] as number) ?? 0, len));
        return { ...step, cursorStep: cursor };
      }
      throw rondoError('INVALID_OPERATION', `未知步骤操作：${op.type}`);
    }
    // cylinder family: locked-dimension and domain checks stay server-side.
    if (op.type === 'SetDimension') {
      const taskSpec = this.content().getTaskSpec(releaseId, taskId);
      const cylFile = taskSpec?.file as { lockedDimensions?: boolean } | undefined;
      if (cylFile?.lockedDimensions === true) {
        throw rondoError('INVALID_OPERATION', '本题给定尺寸不可修改。');
      }
      const manifest = taskSpec?.manifest;
      const domain = manifest?.private.constructionParamDomains
        .find((d) => d.taskId === taskId)
        ?.domains.find((d) => d.paramId === (((op as unknown as { dimension?: string }).dimension ?? '') === 'RADIUS' ? 'radiusMm' : 'heightMm'));
      const valueMm = (op as { valueMm?: number }).valueMm;
      if (domain !== undefined && valueMm !== undefined && (valueMm < domain.min || valueMm > domain.max)) {
        throw rondoError('INVALID_OPERATION', `尺寸超出本任务允许范围（${domain.min}..${domain.max}）。`);
      }
    }
    return applyCylinderOperation(state as CylinderStateV1 | CylinderStateV2, op as Parameters<typeof applyCylinderOperation>[1]);
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private async dispatch(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
    onCodeAdmission:(jobId:string)=>void,
  ): Promise<{ effectRefs: string[]; changedKinds: string[]; attemptVersion?: number }> {
    const kind = envelope.kind;
    if((kind==='code.requestRun'||kind==='code.requestCancel')&&!this.deps.compiler) throw rondoError('CAPABILITY_UNAVAILABLE','本Host未配置代码执行能力。');
    
    const ns = kind.split('.')[0];
    if (ns === 'family' || ns === 'guardian') {
      if (ctx.role !== 'GUARDIAN') {
        throw rondoError('FORBIDDEN', `${ns}.* 命令需要监护人角色。`);
      }
    } else {
      await this.requireLearner(ctx, envelope, repos);
    }
    switch (kind) {
      case 'learning.startDaily': return this.cmdStartDaily(ctx,envelope,repos,scope);
      case 'learning.advanceDaily': return this.cmdAdvanceDaily(ctx,envelope,repos,scope);
      case 'learning.revealDaily': return this.cmdRevealDaily(ctx,envelope,repos,scope);
      case 'code.requestRun':
      case 'code.requestCancel':
        return this.cmdCode(ctx,envelope,repos,scope,onCodeAdmission);
      case 'family.createLearner':
        return this.cmdCreateLearner(ctx, envelope, repos, scope);
      case 'family.setRetention':
        return this.cmdSetRetention(ctx, envelope, repos, scope);
      case 'learning.startAttempt':
        return this.cmdStartAttempt(ctx, envelope, repos, scope);
      case 'learning.beginCycle':
        return this.cmdBeginCycle(ctx, envelope, repos, scope);
      case 'learning.recordPrediction':
        return this.cmdRecordPrediction(ctx, envelope, repos, scope);
      case 'learning.commitOperation':
        return this.cmdCommitOperation(ctx, envelope, repos, scope);
      case 'learning.reviseResponse':
        return this.cmdReviseResponse(ctx, envelope, repos, scope);
      case 'learning.submitResponse':
        return this.cmdSubmitResponse(ctx, envelope, repos, scope);
      case 'learning.requestHint':
        return this.cmdRequestHint(ctx, envelope, repos, scope);
      case 'learning.beginExplanation':
        return this.cmdBeginExplanation(ctx, envelope, repos, scope);
      case 'learning.saveExplanation':
        return this.cmdSaveExplanation(ctx, envelope, repos, scope);
      case 'learning.finishAttempt':
        return this.cmdFinishAttempt(ctx, envelope, repos, scope);
      case 'learning.pauseAttempt':
        return this.cmdPauseAttempt(ctx, envelope, repos, scope);
      case 'learning.resumeAttempt':
        return this.cmdResumeAttempt(ctx, envelope, repos, scope);
      case 'learning.endWithoutCompleting':
        return this.cmdEndWithoutCompleting(ctx, envelope, repos, scope);
      case 'guardian.recordAssistance':
        return this.cmdRecordAssistance(ctx, envelope, repos, scope);
      case 'guardian.annotateExplanation':
        return this.cmdAnnotateExplanation(ctx, envelope, repos, scope);
      case 'guardian.prepareExport':
        return this.cmdPrepareExport(ctx, envelope, repos, scope);
      case 'guardian.confirmExport':
        return this.cmdConfirmExport(ctx, envelope, repos, scope);
      case 'guardian.prepareDeletion':
        return this.cmdPrepareDeletion(ctx, envelope, repos, scope);
      case 'guardian.confirmDeletion':
        return this.cmdConfirmDeletion(ctx, envelope, repos, scope);
      default:
        throw rondoError('INVALID_OPERATION', `未实现的命令：${kind}`);
    }
  }

  // -- family ----------------------------------------------------------------

  private async cmdCreateLearner(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const payload = envelope.payload as Extract<PublicCommandEnvelope['payload'], { alias: string }>;
    const learnerId = this.deps.ids.newId('lrn');
    await repos.learner.insert(scope, {
      learnerId,
      familyId: ctx.familyId,
      alias: payload.alias,
      goalNote: payload.goal ?? null,
      status: 'ACTIVE',
      createdAt: this.now(),
    });
    return { effectRefs: [`learner:${learnerId}`], changedKinds: ['learning.resumePoint'] };
  }

  private async cmdSetRetention(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const payload = envelope.payload as Extract<PublicCommandEnvelope['payload'], { mode: 'UNTIL_GUARDIAN_DELETES' | 'ROLLING_DAYS'; confirmedPreviewVersion: string }>;
    const preview = await computeRetentionPreview(scope, repos, payload.mode, payload.rollingDays, this.now());
    const expectedVersion = preview.previewVersion;
    if (payload.confirmedPreviewVersion !== expectedVersion) {
      throw rondoError('INVALID_OPERATION', '保留策略预览版本不匹配，请刷新预览并重新确认。');
    }
    await repos.retentionPolicy.upsert(scope, {
      familyId: ctx.familyId,
      mode: payload.mode,
      rollingDays: payload.rollingDays ?? null,
      previewVersion: expectedVersion,
      setAt: this.now(),
    });
    return { effectRefs: [], changedKinds: ['guardian.retentionPreview', 'guardian.retentionPolicy'] };
  }

  // -- learning lifecycle ------------------------------------------------------

  private async cmdStartAttempt(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
    daily?:{entry:DailyEntry;setId?:string;index:number},
  ) {
    if (envelope.target.scope !== 'LEARNER') {
      throw rondoError('INVALID_OPERATION', 'startAttempt 需要 LEARNER 目标。');
    }
    const learnerId = envelope.target.learnerId;
    const payload = envelope.payload as { releaseId: string };
    await this.requireReleaseForNewWork(scope, payload.releaseId, repos);
    const active = await repos.learningAttempt.listByLearner(scope, learnerId);
    if (active.some((a) => a.attemptStatus === 'ACTIVE')) {
      throw rondoError('INVALID_OPERATION', '请先明确暂停当前正在进行的课程，再开始所选课程。');
    }
    if(!daily)for(const a of active.filter(a=>a.releaseId===payload.releaseId&&a.attemptStatus==='PAUSED')){
      if(!await dailyMembership(scope,repos,a))throw rondoError('INVALID_OPERATION', '本课已有暂停的学习记录，请继续原记录，完成后再重练。');
    }
    // Chain to the learner's most recent terminal attempt (COMPLETED/ABANDONED)
    // so the resume point follows the attempt chain; null until one exists.
    // listByLearner orders by startedAt ASC, so the last terminal row is the
    // latest. CONTENT_BLOCKED is intentionally not a chain anchor (rework R2
    // names COMPLETED/ABANDONED only).
    let previousAttemptId: string | null = null;
    for (const a of active) {
      if (a.attemptStatus === 'COMPLETED' || a.attemptStatus === 'ABANDONED') previousAttemptId = a.attemptId;
    }
    const release = await repos.contentRelease.findById(scope, payload.releaseId);
    if (release === null) {
      throw rondoError('CONTENT_UNAVAILABLE', `未知 release：${payload.releaseId}`);
    }
    const firstTaskId = (JSON.parse(release.courseVersionsJson) as { taskIds: string[] }).taskIds[0];
    const { taskSpec, givens } = await this.taskSpecFor(scope, payload.releaseId, firstTaskId, repos);
    if(daily&&(daily.entry.releaseId!==payload.releaseId||daily.entry.taskId!==firstTaskId||daily.entry.taskVersion!==taskSpec.taskVersion))throw rondoError('CONTENT_UNAVAILABLE','日常练习绑定的题目版本不匹配，未创建新的学习记录。');
    const now = this.now();
    const attemptId = this.deps.ids.newId('att');
    const cycleId = this.deps.ids.newId('cyc');
    const questionInstanceId = this.deps.ids.newId('qi');
    const confirmedState: PublicSceneState = this.initialConfirmedStateFor(payload.releaseId, taskSpec, givens);
    await repos.questionInstance.insert(scope, {
      questionInstanceId,
      familyId: ctx.familyId,
      learnerId,
      releaseId: payload.releaseId,
      taskId: firstTaskId,
      taskVersion: taskSpec.taskVersion,
      paramsJson: canonicalize(givens),
      createdAt: now,
    });
    await repos.learningAttempt.insert(scope, {
      attemptId,
      familyId: ctx.familyId,
      learnerId,
      releaseId: payload.releaseId,
      attemptStatus: 'ACTIVE',
      version: 1,
      previousAttemptId,
      startedAt: now,
      endedAt: null,
      resultSummaryJson: null,
    });
    await repos.learningCycle.insert(scope, {
      cycleId,
      attemptId,
      questionInstanceId,
      phase: daily?.entry.workflow==='daily.short.v1'?'OPERATE':'PREDICT',
      givensJson: canonicalize(givens),
      confirmedStateJson: canonicalize(confirmedState),
      stateVersion: 1,
      lastSeq: 0,
      createdAt: now,
    });
    const eventRef = await this.appendEvent(scope, repos, envelope, attemptId, 'ATTEMPT_STARTED', {
      releaseId: payload.releaseId,
      taskId: firstTaskId,
      givens,
    });
    if(daily)await this.appendEvent(scope,repos,envelope,attemptId,'DAILY_ITEM_STARTED',{
      version:'rondo.daily.v1',setId:daily.setId??attemptId,index:daily.index,entry:daily.entry,
    });
    return {
      effectRefs: [`attempt:${attemptId}`, `cycle:${cycleId}`, `questionInstance:${questionInstanceId}`, eventRef],
      changedKinds: ['learning.resumePoint', 'learning.attemptView', 'learning.questionView', 'learning.timeline'],
      attemptVersion: 1,
    };
  }

  private async requireDailyEntry(scope:RepoScope,repos:Repositories,entry:DailyEntry):Promise<void>{
    await this.requireReleaseForNewWork(scope,entry.releaseId,repos);
    const task=this.content().getTaskSpec(entry.releaseId,entry.taskId),pool=dailyPoolEntry(entry.poolId);
    if(!task||!pool||task.taskVersion!==entry.taskVersion||pool.releaseId!==entry.releaseId||pool.taskId!==entry.taskId||pool.workflow!==entry.workflow)throw rondoError('CONTENT_UNAVAILABLE','题组固定的题目版本暂不可用，原顺序和记录保留。');
  }

  private async cmdStartDaily(ctx:ServerContext,envelope:PublicCommandEnvelope,repos:Repositories,scope:RepoScope){
    const learnerId=await this.requireLearner(ctx,envelope,repos),payload=envelope.payload as {scope:DailyScope;mode:'today'|'practice';previousSetId?:string};
    const sets=await readDailySets(scope,repos,learnerId),today=dailyDate(this.now());
    const projected=await Promise.all(sets.map(set=>projectDailySet(scope,repos,learnerId,set)));
    const unfinished=projected.find(set=>set.status==='OPEN');
    const sameDay=[...projected].reverse().find(set=>set.date===today&&set.status!=='OPEN');
    const existing=unfinished??(payload.mode==='today'?sameDay:projected.find(set=>set.practiceOf===payload.previousSetId));
    if(existing)return {effectRefs:[`daily:${existing.setId}`],changedKinds:['learning.daily']};
    if(payload.mode==='practice'&&!projected.some(set=>set.setId===payload.previousSetId&&(set.status==='COMPLETE'||set.status==='UNAVAILABLE')))throw rondoError('INVALID_OPERATION','请先读回要复练的那一组，再开始新的练习。');
    if((await repos.learningAttempt.listByLearner(scope,learnerId,'ACTIVE')).length)throw rondoError('INVALID_OPERATION','请先保存并暂停当前活动，再开始这组练习。');
    const items=await selectDailyItems(scope,repos,learnerId,payload.scope,sets.filter(s=>s.plan.scope===payload.scope).length);
    for(const entry of items)await this.requireDailyEntry(scope,repos,entry);
    // All rejections precede writes. A later failure rolls the entire new group back.
    try{
      const first=await this.cmdStartAttempt(ctx,{...envelope,payload:{releaseId:items[0].releaseId}},repos,scope,{entry:dailyEntrySnapshot(dailyPoolEntry(items[0].poolId)!),index:0});
      const setId=first.effectRefs.find(ref=>ref.startsWith('attempt:'))!.slice(8);
      const plan:DailyPlan={version:'rondo.daily.v1',setId,scope:payload.scope,date:today,createdAt:this.now(),practiceOf:payload.previousSetId??null,items};
      await this.appendEvent(scope,repos,envelope,setId,'DAILY_SET_CREATED',plan);
      await this.appendEvent(scope,repos,envelope,setId,'DAILY_ITEM_LINKED',{index:0,attemptId:setId});
      return {effectRefs:[`daily:${setId}`,...first.effectRefs],changedKinds:['learning.daily',...first.changedKinds],attemptVersion:first.attemptVersion};
    }catch{throw rondoError('PERSISTENCE_FAILED','这组练习尚未保存，事务已回滚；请按原请求确认。');}
  }

  private async dailyCloseCheck(scope:RepoScope,repos:Repositories,attempt:LearningAttemptRecord,defer:boolean){
    const member=await dailyMembership(scope,repos,attempt);if(!member)throw rondoError('INVALID_OPERATION','这项学习不属于日常题组。');
    const cycle=await this.currentCycle(scope,repos,attempt),subs=await this.submissionsOfCycle(scope,repos,cycle.cycleId);
    const last=subs.at(-1),evaluation=last?await repos.evaluation.findOriginalBySubmission(scope,last.submissionId):null;
    if(!evaluation)throw rondoError('INVALID_OPERATION','先提交一次回答，看看具体反馈。');
    if(evaluation.outcome==='REVISE'&&(!defer||subs.length<2))throw rondoError('INVALID_OPERATION','先按反馈修改并再提交一次；仍需练习时，可明确选择留待复练。');
    if(evaluation.outcome==='UNSCORABLE'&&(JSON.parse(evaluation.feedbackJson).assessmentMode?.mode!=='OBSERVATION_RECORDED'))throw rondoError('INVALID_OPERATION','这次结果尚未核对，不能按通过进入下一题。');
    if(member.entry.workflow==='daily.short.v1'&&cycle.phase!=='VERIFY'&&attempt.attemptStatus!=='COMPLETED')throw rondoError('INVALID_OPERATION','先提交当前回答并读回反馈，再继续。');
    if(member.entry.workflow==='daily.model.v1'){
      const explanations=await repos.explanationRevision.listByCycle(scope,cycle.cycleId);
      if(cycle.phase!=='REVIEW'||!explanations.at(-1)||explanations.at(-1)!.freeText.trim().length<8)throw rondoError('INVALID_OPERATION','请先保存引用两个模型记录的解释，再继续。');
    }
    return {member,cycle,evaluation};
  }

  private async cmdAdvanceDaily(ctx:ServerContext,envelope:PublicCommandEnvelope,repos:Repositories,scope:RepoScope){
    const learnerId=await this.requireLearner(ctx,envelope,repos),attempt=await this.requireAttempt(ctx,envelope,repos);
    if(!envelope.binding)throw rondoError('INVALID_OPERATION','下一题需要绑定当前保存的回答。');
    const payload=envelope.payload as {setId:string;index:number;defer:boolean};
    const set=(await readDailySets(scope,repos,learnerId)).find(x=>x.plan.setId===payload.setId);
    if(!set||set.links[payload.index]?.attemptId!==attempt.attemptId)throw rondoError('FORBIDDEN','这道题不属于当前学习者的指定题组位置。');
    // A repeated click on the original position reads the existing successor; it never skips twice.
    if(set.closed||set.links.length>payload.index+1)return {effectRefs:[`daily:${set.plan.setId}`,`attempt:${set.links.at(-1)!.attemptId}`],changedKinds:['learning.daily']};
    this.checkExpectedVersion(attempt,envelope);
    const view=await projectDailySet(scope,repos,learnerId,set);
    if(view.status==='UNAVAILABLE')throw rondoError('CONTENT_UNAVAILABLE','本组有记录已移除或暂不可用，请保留现有记录并返回首页查看。');
    if(attempt.attemptStatus!=='ACTIVE'&&attempt.attemptStatus!=='COMPLETED')throw rondoError('INVALID_OPERATION','请先继续这道题，再进入下一题。');
    const {member,cycle}=await this.dailyCloseCheck(scope,repos,attempt,payload.defer);
    const next=set.plan.items[payload.index+1];if(next)await this.requireDailyEntry(scope,repos,next);
    if((await repos.learningAttempt.listByLearner(scope,learnerId,'ACTIVE')).some(a=>a.attemptId!==attempt.attemptId))throw rondoError('INVALID_OPERATION','另一项活动正在进行，请先暂停它再继续这组。');
    try{
      if(attempt.attemptStatus==='ACTIVE'){
        if(member.entry.workflow==='daily.short.v1'){
          await this.setPhase(scope,repos,cycle,'REVIEW');
          const summary=await this.buildResultSummary(scope,repos,attempt,[cycle]);
          await this.casAttempt(scope,repos,attempt,{nextStatus:'COMPLETED',endAttempt:true,resultSummaryJson:canonicalize(summary)});
          await this.appendEvent(scope,repos,envelope,attempt.attemptId,'DAILY_SHORT_FINISHED',{cycleId:cycle.cycleId,deferred:payload.defer,workflow:member.entry.workflow});
        }else await this.cmdFinishAttempt(ctx,envelope,repos,scope);
      }
      await this.appendEvent(scope,repos,envelope,attempt.attemptId,'DAILY_ITEM_CLOSED',{index:payload.index,attemptId:attempt.attemptId,deferred:payload.defer});
      let nextAttemptId=attempt.attemptId;
      if(next){
        const started=await this.cmdStartAttempt(ctx,{...envelope,payload:{releaseId:next.releaseId}},repos,scope,{entry:dailyEntrySnapshot(dailyPoolEntry(next.poolId)!),setId:set.plan.setId,index:payload.index+1});
        nextAttemptId=started.effectRefs.find(x=>x.startsWith('attempt:'))!.slice(8);
        const link={index:payload.index+1,attemptId:nextAttemptId};
        await this.appendEvent(scope,repos,envelope,attempt.attemptId,'DAILY_ITEM_LINKED',link);
        await this.appendEvent(scope,repos,envelope,nextAttemptId,'DAILY_SET_SNAPSHOT',{plan:set.plan,links:[...set.links,link]});
      }else await this.appendEvent(scope,repos,envelope,attempt.attemptId,'DAILY_SET_FINISHED',{finishedAt:this.now()});
      const owner=await repos.learningAttempt.findById(scope,attempt.attemptId);if(!owner)throw Error('missing current attempt');
      await this.bumpAttempt(scope,repos,owner);
      const current=await repos.learningAttempt.findById(scope,nextAttemptId);
      return {effectRefs:[`daily:${set.plan.setId}`,`attempt:${nextAttemptId}`],changedKinds:['learning.daily','learning.activityHistory','learning.resumePoint','learning.attemptView'],attemptVersion:current?.version};
    }catch{throw rondoError('PERSISTENCE_FAILED','下一题尚未确认，事务已回滚；请保留当前编辑并确认原请求。');}
  }

  private async cmdRevealDaily(ctx:ServerContext,envelope:PublicCommandEnvelope,repos:Repositories,scope:RepoScope){
    const attempt=await this.requireAttempt(ctx,envelope,repos);this.checkExpectedVersion(attempt,envelope);
    const member=await dailyMembership(scope,repos,attempt);
    if(!member||member.entry.workflow!=='daily.short.v1'||!envelope.binding||attempt.attemptStatus!=='ACTIVE')throw rondoError('INVALID_OPERATION','只有当前日常短练可请求这份解析。');
    const cycle=await this.currentCycle(scope,repos,attempt,'VERIFY');
    if(!await repos.submission.findLatestByCycle(scope,cycle.cycleId))throw rondoError('INVALID_OPERATION','先留下自己的回答，再查看解析。');
    if((await dailyEvents(scope,repos,attempt.attemptId)).some(e=>e.eventType==='DAILY_EXPLANATION_REQUESTED'))return {effectRefs:[`attempt:${attempt.attemptId}`],changedKinds:['learning.activityHistory','learning.daily'],attemptVersion:attempt.version};
    const updated=await this.bumpAttempt(scope,repos,attempt);
    await this.appendEvent(scope,repos,envelope,attempt.attemptId,'DAILY_EXPLANATION_REQUESTED',{cycleId:cycle.cycleId,workflow:member.entry.workflow});
    return {effectRefs:[`attempt:${attempt.attemptId}`],changedKinds:['learning.activityHistory','learning.daily'],attemptVersion:updated.version};
  }

  private async cmdBeginCycle(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    this.checkExpectedVersion(attempt, envelope);
    if(await dailyMembership(scope,repos,attempt))throw rondoError('INVALID_OPERATION','日常题组请用下一题继续，不能另开课程轮次。');
    if (attempt.attemptStatus !== 'ACTIVE') {
      throw rondoError('INVALID_OPERATION', `attempt 当前状态 ${attempt.attemptStatus}，不能开始新轮次。`);
    }
    const cycle = await repos.learningCycle.findCurrentByAttempt(scope, attempt.attemptId);
    if (cycle === null || cycle.phase !== 'REVIEW') {
      throw rondoError('INVALID_OPERATION', '只有当前轮次处于 REVIEW 时才能开始新轮次。');
    }
    const payload = envelope.payload as { taskId: string };
    const releaseRow = await repos.contentRelease.findById(scope, attempt.releaseId);
    if (releaseRow === null) {
      throw rondoError('CONTENT_UNAVAILABLE', `未知 release：${attempt.releaseId}`);
    }
    if (releaseRow.status === 'REVOKED') {
      throw rondoError('CONTENT_REVOKED', `内容已撤销：${attempt.releaseId}`);
    }
    if (releaseRow.status !== 'AVAILABLE') {
      throw rondoError('CONTENT_UNAVAILABLE', `内容当前不可用（${releaseRow.status}）。`);
    }
    const courseInfo = JSON.parse(releaseRow.courseVersionsJson) as { taskIds: string[] };
    if (!courseInfo.taskIds.includes(payload.taskId)) {
      throw rondoError('INVALID_OPERATION', `任务不在该 release 中：${payload.taskId}`);
    }
    const currentTaskId = await this.currentTaskIdOfCycle(scope, repos, cycle);
    const graphNode = this.deps.policy.courseGraph.find((n) => n.taskId === currentTaskId);
    if (!graphNode || !graphNode.nextTaskIds.includes(payload.taskId)) {
      throw rondoError('INVALID_OPERATION', `课程图不允许从 ${currentTaskId} 进入 ${payload.taskId}。`);
    }
    const { taskSpec, givens } = await this.taskSpecFor(scope, attempt.releaseId, payload.taskId, repos);
    const now = this.now();
    const cycleId = this.deps.ids.newId('cyc');
    const questionInstanceId = this.deps.ids.newId('qi');
    const confirmedState: PublicSceneState = this.initialConfirmedStateFor(attempt.releaseId, taskSpec, givens);
    await repos.questionInstance.insert(scope, {
      questionInstanceId,
      familyId: ctx.familyId,
      learnerId: attempt.learnerId,
      releaseId: attempt.releaseId,
      taskId: payload.taskId,
      taskVersion: taskSpec.taskVersion,
      paramsJson: canonicalize(givens),
      createdAt: now,
    });
    await repos.learningCycle.insert(scope, {
      cycleId,
      attemptId: attempt.attemptId,
      questionInstanceId,
      phase: 'PREDICT',
      givensJson: canonicalize(givens),
      confirmedStateJson: canonicalize(confirmedState),
      stateVersion: 1,
      lastSeq: 0,
      createdAt: now,
    });
    const updated = await this.casAttempt(scope, repos, attempt, {});
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'CYCLE_BEGUN', {
      cycleId,
      taskId: payload.taskId,
      givens,
    });
    return {
      effectRefs: [`cycle:${cycleId}`, `questionInstance:${questionInstanceId}`, eventRef],
      changedKinds: ['learning.attemptView', 'learning.questionView', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  private async currentTaskIdOfCycle(scope: RepoScope, repos: Repositories, cycle: LearningCycleRecord): Promise<string> {
    const instance = await repos.questionInstance.findById(scope, cycle.questionInstanceId);
    if (instance === null) {
      throw rondoError('PERSISTENCE_FAILED', 'cycle 引用的 questionInstance 不可读。');
    }
    return instance.taskId;
  }

  private async cmdRecordPrediction(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    if (attempt.attemptStatus !== 'ACTIVE') {
      throw rondoError('INVALID_OPERATION', `attempt 当前状态 ${attempt.attemptStatus}，不能记录预测。`);
    }
    const cycle = await this.currentCycle(scope, repos, attempt, 'PREDICT');
    const payload = envelope.payload as RecordPredictionPayload;
    if('kind' in payload.prediction){
      const instance=await repos.questionInstance.findById(scope,cycle.questionInstanceId);
      const activityId=payload.prediction.activityId;
      const registered=LEARNING_ACTIVITIES.find(a=>a.id===activityId && a.releaseId===attempt.releaseId && a.taskId===instance?.taskId);
      if(this.content().familyOf(attempt.releaseId)!=='activity'||!registered)throw rondoError('INVALID_OPERATION','猜想与当前活动不匹配，请重新打开这项学习。');
    }
    const inserted = await repos.prediction.insertFirst(scope, {
      cycleId: cycle.cycleId,
      contentJson: canonicalize(payload.prediction),
      uncertain: payload.uncertain,
      noteText: payload.explanation ?? null,
      recordedAt: this.now(),
    });
    if (inserted === 'ALREADY_EXISTS') {
      throw rondoError('INVALID_OPERATION', '首次预测已存在，不能覆盖。');
    }
    await this.setPhase(scope, repos, cycle, 'OPERATE');
    const updated = await this.bumpAttempt(scope, repos, attempt);
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'PREDICTION_RECORDED', {
      cycleId: cycle.cycleId,
      uncertain: payload.uncertain,
      claimCount: 'claims' in payload.prediction ? payload.prediction.claims.length : 1,
      ...('kind' in payload.prediction ? {predictionCarrier:payload.prediction.kind}:{}),
    });
    return {
      effectRefs: [`cycle:${cycle.cycleId}`, eventRef],
      changedKinds: ['learning.attemptView', 'learning.questionView', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  private async currentCycle(
    scope: RepoScope,
    repos: Repositories,
    attempt: LearningAttemptRecord,
    expectedPhase?: LearningCycleRecord['phase'],
    targetCycleId?: string,
  ): Promise<LearningCycleRecord> {
    const cycle =
      targetCycleId === undefined
        ? await repos.learningCycle.findCurrentByAttempt(scope, attempt.attemptId)
        : await repos.learningCycle.findById(scope, targetCycleId);
    if (cycle === null || cycle.attemptId !== attempt.attemptId) {
      throw rondoError('INVALID_OPERATION', '未知的 cycle。');
    }
    if (expectedPhase !== undefined && cycle.phase !== expectedPhase) {
      throw rondoError('INVALID_OPERATION', `该命令需要 ${expectedPhase} 阶段，当前 ${cycle.phase}。`);
    }
    return cycle;
  }

  private async cmdCommitOperation(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    this.checkExpectedVersion(attempt, envelope);
    if (attempt.attemptStatus !== 'ACTIVE') {
      throw rondoError('INVALID_OPERATION', `attempt 当前状态 ${attempt.attemptStatus}，不能提交操作。`);
    }
    let cycle = await this.currentCycle(scope, repos, attempt);
    const payload = envelope.payload as { operation: { type: string } & Record<string, unknown> };
    const daily=await dailyMembership(scope,repos,attempt);
    if(daily?.entry.workflow==='daily.short.v1'&&payload.operation.type!=='SaveActivityDraft')throw rondoError('INVALID_OPERATION','本次短练只保存回答草稿，不代替模型操作或推演记录。');
    const draftOnly=payload.operation.type==='SaveActivityDraft' && this.content().familyOf(attempt.releaseId)==='activity';
    if (draftOnly) { /* A draft changes no phase or submitted learning fact. */ } else if (cycle.phase === 'VERIFY') {
      const canRevise = await this.latestOutcomeIsRevise(scope, repos, cycle);
      if (!canRevise) {
        throw rondoError('INVALID_OPERATION', '当前阶段 VERIFY 且结果不是 REVISE，不能提交操作。');
      }
      cycle = await this.setPhase(scope, repos, cycle, 'OPERATE');
    } else if (cycle.phase !== 'OPERATE') {
      throw rondoError('INVALID_OPERATION', `commitOperation 需要 OPERATE 阶段，当前 ${cycle.phase}。`);
    }
    const instance = await repos.questionInstance.findById(scope, cycle.questionInstanceId);
    if (instance === null) {
      throw rondoError('PERSISTENCE_FAILED', 'questionInstance 不可读。');
    }
    const taskSpec = this.content().getTaskSpec(instance.releaseId, instance.taskId);
    if (taskSpec === null) {
      throw rondoError('CONTENT_UNAVAILABLE', '内容任务不可用。');
    }
    const op = payload.operation as { type: string } & Record<string, unknown>;
    if (!taskSpec.file.allowedOperationIds.includes(op.type)) {
      throw rondoError('INVALID_OPERATION', `该任务未开放操作 ${op.type}。`);
    }
    const nextState = this.applyFamilyOperation(
      instance.releaseId,
      instance.taskId,
      JSON.parse(cycle.confirmedStateJson) as PublicSceneState,
      op,
    );
    const confirmed = await repos.learningCycle.confirmState(scope, {
      cycleId: cycle.cycleId,
      expectedStateVersion: cycle.stateVersion,
      confirmedStateJson: canonicalize(nextState),
    });
    if (confirmed === null) {
      throw rondoError('PERSISTENCE_FAILED', '状态确认失败，事务已回滚。');
    }
    const updated = await this.casAttempt(scope, repos, attempt, {});
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'OPERATION_COMMITTED', {
      cycleId: cycle.cycleId,
      operation: op,
      stateAfter: nextState,
    });
    return {
      effectRefs: [`cycle:${cycle.cycleId}`, eventRef],
      changedKinds: ['learning.attemptView', 'learning.questionView', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  /**
   * Folds a cycle's confirmed learning.commitOperation events into the L4
   * activity summary (SetLayerCount values tried, visible-layer applies,
   * SetDimension axes, SelectFaces applies). Animation frames / camera moves
   * are ViewState and never appear here (activity gates count confirmed ops
   * only — authored stack rule note).
   */
  private async foldConfirmedActivity(
    scope: RepoScope,
    repos: Repositories,
    attemptId: string,
    cycleId: string,
  ): Promise<ConfirmedOperationActivity> {
    const activity: ConfirmedOperationActivity = {
      layerCountValues: [],
      visibleLayerCountValues: [],
      visibleLayerCountApplies: 0,
      setDimensionAxes: [],
      selectFacesApplies: 0,
    };
    let afterSeq = 0;
    for (;;) {
      const page = await repos.learningEvent.pageBySeq(scope, { attemptId, afterSeq, limit: 200 });
      if (page.length === 0) break;
      for (const event of page) {
        afterSeq = Math.max(afterSeq, event.seq);
        if (event.eventType !== 'OPERATION_COMMITTED') continue;
        let payload: { cycleId?: string; operation?: { type?: string } & Record<string, unknown> };
        try {
          payload = JSON.parse(event.payloadJson) as typeof payload;
        } catch {
          continue;
        }
        if (payload.cycleId !== cycleId || payload.operation === undefined) continue;
        const op = payload.operation;
        if (op.type === 'SetLayerCount' && typeof op['value'] === 'number' && !activity.layerCountValues.includes(op['value'])) {
          activity.layerCountValues.push(op['value']);
        } else if (op.type === 'SetVisibleLayerCount') {
          activity.visibleLayerCountApplies += 1;
          if (typeof op['value'] === 'number' && !activity.visibleLayerCountValues.includes(op['value'])) {
            activity.visibleLayerCountValues.push(op['value']);
          }
        } else if (op.type === 'SetDimension' && typeof op['dimension'] === 'string' && !activity.setDimensionAxes.includes(op['dimension'])) {
          activity.setDimensionAxes.push(op['dimension']);
        } else if (op.type === 'SelectFaces') {
          activity.selectFacesApplies += 1;
        }
      }
      if (page.length < 200) break;
    }
    return activity;
  }

  private async latestOutcomeIsRevise(scope: RepoScope, repos: Repositories, cycle: LearningCycleRecord): Promise<boolean> {
    const latest = await repos.submission.findLatestByCycle(scope, cycle.cycleId);
    if (latest === null) return false;
    const evaluation = await repos.evaluation.findOriginalBySubmission(scope, latest.submissionId);
    if(evaluation?.outcome==='REVISE')return true;
    const instance=await repos.questionInstance.findById(scope,cycle.questionInstanceId);
    return evaluation?.outcome==='UNSCORABLE' && instance?.taskId==='mvp.gesp.202303.p1.v1';
  }

  private checkExpectedVersion(attempt: LearningAttemptRecord, envelope: PublicCommandEnvelope): void {
    if (envelope.expectedAttemptVersion !== undefined && envelope.expectedAttemptVersion !== attempt.version) {
      throw versionConflictError(attempt.version, '请重新读取 attempt 视图后以当前版本重试。');
    }
  }

  private async cmdReviseResponse(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    this.checkExpectedVersion(attempt, envelope);
    if(await dailyMembership(scope,repos,attempt)&&attempt.attemptStatus!=='ACTIVE')throw rondoError('INVALID_OPERATION','请先继续当前练习，再修改回答。');
    const cycle = await this.currentCycle(scope, repos, attempt, 'VERIFY');
    if (!(await this.latestOutcomeIsRevise(scope, repos, cycle))) {
      throw rondoError('INVALID_OPERATION', '只有结果为 REVISE 时才能重新作答。');
    }
    await this.setPhase(scope, repos, cycle, 'OPERATE');
    const updated = await this.casAttempt(scope, repos, attempt, {});
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'RESPONSE_REVISE_OPENED', {
      cycleId: cycle.cycleId,
    });
    return {
      effectRefs: [`cycle:${cycle.cycleId}`, eventRef],
      changedKinds: ['learning.attemptView', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  private async cmdSubmitResponse(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    this.checkExpectedVersion(attempt, envelope);
    const notice=supersededActivityNotice(attempt.releaseId);if(notice)throw rondoError('CONTENT_UNAVAILABLE',notice);
    if(await dailyMembership(scope,repos,attempt)&&attempt.attemptStatus!=='ACTIVE')throw rondoError('INVALID_OPERATION','请先继续当前练习，再提交回答。');
    const cycle = await this.currentCycle(scope, repos, attempt, 'OPERATE');
    const instance = await repos.questionInstance.findById(scope, cycle.questionInstanceId);
    if (instance === null) {
      throw rondoError('PERSISTENCE_FAILED', 'questionInstance 不可读。');
    }
    const payload = envelope.payload as { response: StructuredResponseItem[] };
    const content = this.content();
    const givens = JSON.parse(cycle.givensJson) as CylinderStateV1;
    const snapshot = JSON.parse(cycle.confirmedStateJson) as CylinderStateV1;
    // v2 (RULE_DSL_VERSION '2') first: C-line rule truth bodies; family truths
    // (L3/L4 + GRID + STEP, integration W1) route through the family evaluator
    // with the frozen instance truth and the folded operation activity; the v1
    // path stays for releases that ship only the deprecated rules file.
    const ruleBody: FamilyRuleBody | null =
      typeof content.getRuleBody === 'function' ? content.getRuleBody(instance.releaseId, instance.taskId) : null;
    const ruleBodyV2 = ruleBody !== null ? content.getRuleBodyV2(instance.releaseId, instance.taskId) : null;
    let evaluationResult: EvaluationResult;
    let ruleVersion: string;
    if(ruleBody?.kind==='MVP_ACTIVITY_TRUTH_V1'){
      ruleVersion=instance.taskVersion;
      evaluationResult=await this.evaluateActivity(ruleBody,activityStateSchema.parse(snapshot),payload.response,scope,repos,attempt.attemptId,cycle.cycleId);
    } else if (ruleBodyV2 !== null) {
      ruleVersion = instance.taskVersion;
      const enabledSegments =
        typeof content.getEnabledSegments === 'function'
          ? content.getEnabledSegments(instance.releaseId, instance.taskId) ?? undefined
          : undefined;
      evaluationResult = evaluateResponseV2({
        rule: ruleBodyV2,
        taskId: instance.taskId,
        givens,
        snapshot,
        responseItems: payload.response,
        enabledSegments,
      });
    } else if (ruleBody !== null) {
      ruleVersion = instance.taskVersion;
      const instanceTruth =
        typeof content.getFrozenInstanceTruth === 'function'
          ? content.getFrozenInstanceTruth(instance.releaseId, instance.taskId)
          : null;
      const activity = await this.foldConfirmedActivity(scope, repos, attempt.attemptId, cycle.cycleId);
      evaluationResult = evaluateResponseFamily({
        rule: ruleBody as Exclude<FamilyRuleBody, RuleBodyV2 | ActivityRule>,
        taskId: instance.taskId,
        givens: JSON.parse(cycle.givensJson) as PublicSceneState,
        snapshot: JSON.parse(cycle.confirmedStateJson) as PublicSceneState,
        responseItems: payload.response,
        instanceTruth,
        activity,
      });
    } else {
      const ruleSet = content.resolveRules(instance.releaseId, instance.taskId);
      const rule = ruleSet !== null ? ruleSet.rules[0] : null;
      ruleVersion = ruleSet?.ruleSetVersion ?? instance.taskVersion;
      evaluationResult =
        rule !== null
          ? evaluateResponse({ rule, givens, snapshot, responseItems: payload.response })
          : {
              outcome: 'UNSCORABLE' as const,
              feedback: {
                ruleKind: 'NUMERIC_RELATION_V1' as const,
                scenarioMet: false,
                responseTypeOk: false,
                detail: '私有规则不可用，本次提交未被判定。',
              },
            };
    }
    const assistance = await this.assistanceSnapshot(scope, repos, cycle, instance);
    const prior = await repos.submission.findLatestByCycle(scope, cycle.cycleId);
    const now = this.now();
    const submissionId = this.deps.ids.newId('sub');
    const evaluationId = this.deps.ids.newId('evl');
    await repos.submission.insert(scope, {
      submissionId,
      cycleId: cycle.cycleId,
      stateSnapshotJson: cycle.confirmedStateJson,
      attemptVersionAtSubmit: attempt.version + 1,
      responseJson: canonicalize(payload.response),
      assistanceSnapshotJson: canonicalize(assistance),
      priorSubmissionId: prior?.submissionId ?? null,
      submittedBy: ctx.actorId,
      at: now,
    });
    await repos.evaluation.insert(scope, {
      evaluationId,
      submissionId,
      ruleVersion,
      outcome: evaluationResult.outcome,
      feedbackJson: canonicalize(evaluationResult.feedback),
      at: now,
    });
    await this.setPhase(scope, repos, cycle, 'VERIFY');
    const updated = await this.casAttempt(scope, repos, attempt, {});
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'SUBMISSION_RECORDED', {
      cycleId: cycle.cycleId,
      submissionId,
      evaluationId,
      outcome: evaluationResult.outcome,
    });
    return {
      effectRefs: [`submission:${submissionId}`, `evaluation:${evaluationId}`, eventRef],
      changedKinds: ['learning.attemptView', 'learning.questionView', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  private async assistanceSnapshot(
    scope: RepoScope,
    repos: Repositories,
    cycle: LearningCycleRecord,
    instance: { releaseId: string; taskId: string },
  ): Promise<{ categories: string[]; answerHintPresented: boolean; hintCount: number }> {
    const hints = await repos.hintPresentation.listByCycle(scope, cycle.cycleId);
    const content = this.content();
    let answerHintPresented = false;
    for (const hint of hints) {
      const gate = content
        .getTaskSpec(instance.releaseId, instance.taskId)
        ?.manifest.private.hintGateTable.find((g) => g.taskId === instance.taskId && g.hintLevel === hint.level);
      const hintContent = gate ? content.getHintContent(instance.releaseId, gate.contentRef) : null;
      if (hintContent?.revealsAnswer === true) answerHintPresented = true;
    }
    const assistanceRecords = await repos.assistanceRecord.listByAttempt(scope, cycle.attemptId);
    const categories = [...new Set(assistanceRecords.map((r) => r.category))].sort();
    return { categories, answerHintPresented, hintCount: hints.length };
  }

  private async cmdRequestHint(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    if (attempt.attemptStatus !== 'ACTIVE') {
      throw rondoError('INVALID_OPERATION', `attempt 当前状态 ${attempt.attemptStatus}，不能请求提示。`);
    }
    const cycle = await this.currentCycle(scope, repos, attempt);
    if (cycle.phase !== 'OPERATE' && cycle.phase !== 'VERIFY') {
      throw rondoError('INVALID_OPERATION', `提示只在 OPERATE/VERIFY 阶段可用，当前 ${cycle.phase}。`);
    }
    const instance = await repos.questionInstance.findById(scope, cycle.questionInstanceId);
    if (instance === null) {
      throw rondoError('PERSISTENCE_FAILED', 'questionInstance 不可读。');
    }
    const payload = envelope.payload as { hintLevel: number };
    const taskSpec = this.content().getTaskSpec(instance.releaseId, instance.taskId);
    if (taskSpec === null) {
      throw rondoError('CONTENT_UNAVAILABLE', '内容任务不可用。');
    }
    const maxLevel = this.deps.policy.hintPolicy.find((h) => h.taskId === instance.taskId)?.maxLevel ?? 0;
    if (payload.hintLevel > maxLevel) {
      throw rondoError('INVALID_OPERATION', `提示层级超出本任务允许上限（0..${maxLevel}）。`);
    }
    const gate = taskSpec.manifest.private.hintGateTable.find(
      (g) => g.taskId === instance.taskId && g.hintLevel === payload.hintLevel,
    );
    if (gate === undefined) {
      throw rondoError('INVALID_OPERATION', `该提示层级未登记（level ${payload.hintLevel}）。`);
    }
    const hintContent: HintFile | null = this.content().getHintContent(instance.releaseId, gate.contentRef);
    if (hintContent === null) {
      throw rondoError('INVALID_OPERATION', '提示内容不可用。');
    }
    const hintId = this.deps.ids.newId('hint');
    await repos.hintPresentation.insert(scope, {
      hintId,
      cycleId: cycle.cycleId,
      level: payload.hintLevel,
      contentVersion: hintContent.version,
      receiptRef: envelope.commandId,
      at: this.now(),
    });
    const updated = await this.bumpAttempt(scope, repos, attempt);
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'HINT_PRESENTED', {
      cycleId: cycle.cycleId,
      level: payload.hintLevel,
      revealsAnswer: hintContent.revealsAnswer,
    });
    return {
      effectRefs: [`hint:${hintId}`, eventRef],
      changedKinds: ['learning.questionView', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  private async cmdBeginExplanation(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    this.checkExpectedVersion(attempt, envelope);
    const daily=await dailyMembership(scope,repos,attempt);
    if(daily?.entry.workflow==='daily.short.v1')throw rondoError('INVALID_OPERATION','这道短练不用填写模板解释；请按反馈再试，或进入下一题。');
    const cycle = await this.currentCycle(scope, repos, attempt, 'VERIFY');
    const submissions = await (repos.submission as Repositories['submission'] & {
      listAllByCycle?: (scope: RepoScope, cycleId: string) => Promise<{ submissionId: string }[]>;
    }).listAllByCycle?.(scope, cycle.cycleId);
    if (submissions === undefined) {
      throw rondoError('PERSISTENCE_FAILED', 'storage lacks submission listing capability');
    }
    if (submissions.length === 0) {
      throw rondoError('INVALID_OPERATION', '至少需要一次有效提交和反馈才能进入解释阶段。');
    }
    if(daily){
      if(attempt.attemptStatus!=='ACTIVE')throw rondoError('INVALID_OPERATION','请先继续当前练习。');
      const evaluation=await repos.evaluation.findOriginalBySubmission(scope,submissions.at(-1)!.submissionId);
      if(!evaluation||evaluation.outcome==='UNSCORABLE'||evaluation.outcome==='REVISE'&&submissions.length<2)throw rondoError('INVALID_OPERATION','先按反馈修改并再提交一次，再说明模型比较的依据。');
    }
    await this.setPhase(scope, repos, cycle, 'EXPLAIN');
    const updated = await this.casAttempt(scope, repos, attempt, {});
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'EXPLANATION_BEGUN', {
      cycleId: cycle.cycleId,
    });
    return {
      effectRefs: [`cycle:${cycle.cycleId}`, eventRef],
      changedKinds: ['learning.attemptView', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  private async cmdSaveExplanation(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    this.checkExpectedVersion(attempt, envelope);
    const cycle = await this.currentCycle(scope, repos, attempt);
    if (cycle.phase !== 'EXPLAIN' && cycle.phase !== 'REVIEW') {
      throw rondoError('INVALID_OPERATION', `saveExplanation 需要 EXPLAIN 或 REVIEW 阶段，当前 ${cycle.phase}。`);
    }
    const payload = envelope.payload as {
      selections: { itemId: string; selectedOptionIds: string[] }[];
      freeText: string;
      transcribedByGuardian: boolean;
    };
    const daily=await dailyMembership(scope,repos,attempt);
    if(daily&&(daily.entry.workflow!=='daily.model.v1'||attempt.attemptStatus!=='ACTIVE'||payload.freeText.trim().length<8))throw rondoError('INVALID_OPERATION','请用至少8个字记录自己的模型比较依据；系统保留解释原文。');
    let scribeActorId: string | null = null;
    if (payload.transcribedByGuardian) {
      const session = await repos.hostSession.findActive(scope, ctx.sessionId, ctx.hostEpoch);
      if (session === null || session.guardianActorId === null) {
        throw rondoError('INVALID_OPERATION', '代录需要关联的监护人会话。');
      }
      scribeActorId = session.guardianActorId;
    }
    const revisionId = this.deps.ids.newId('rev');
    const latestSubmission = await repos.submission.findLatestByCycle(scope, cycle.cycleId);
    const existing = await repos.explanationRevision.listByCycle(scope, cycle.cycleId);
    await repos.explanationRevision.insert(scope, {
      revisionId,
      cycleId: cycle.cycleId,
      submissionRef: latestSubmission?.submissionId ?? null,
      structuredJson: canonicalize(payload.selections),
      freeText: payload.freeText,
      scribe: payload.transcribedByGuardian,
      scribeActorId,
      revisionOfId: existing.length > 0 ? existing[existing.length - 1].revisionId : null,
      at: this.now(),
    });
    let updated = attempt;
    if (cycle.phase === 'EXPLAIN') {
      await this.setPhase(scope, repos, cycle, 'REVIEW');
      updated = await this.casAttempt(scope, repos, attempt, {});
    } else {
      updated = await this.bumpAttempt(scope, repos, attempt);
    }
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'EXPLANATION_SAVED', {
      cycleId: cycle.cycleId,
      revisionId,
      scribe: payload.transcribedByGuardian,
    });
    return {
      effectRefs: [`explanation:${revisionId}`, eventRef],
      changedKinds: ['learning.attemptView', 'guardian.evidenceSummary', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  private async cmdFinishAttempt(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    this.checkExpectedVersion(attempt, envelope);
    const notice=supersededActivityNotice(attempt.releaseId);if(notice)throw rondoError('CONTENT_UNAVAILABLE',notice);
    if (attempt.attemptStatus !== 'ACTIVE') {
      throw rondoError('INVALID_OPERATION', `attempt 当前状态 ${attempt.attemptStatus}，不能完成。`);
    }
    const daily=await dailyMembership(scope,repos,attempt);
    if(daily?.entry.workflow==='daily.short.v1')throw rondoError('INVALID_OPERATION','短练请用题组中的下一题结束，不代填课程的预测和解释。');
    if(daily)await this.dailyCloseCheck(scope,repos,attempt,true);
    const cycles = await this.allCyclesOfAttempt(scope, repos, attempt.attemptId);
    if (cycles.length === 0 || cycles[cycles.length - 1].phase !== 'REVIEW') {
      throw rondoError('INVALID_OPERATION', '当前轮次未处于 REVIEW，不能完成 attempt。');
    }
    for (const cycle of cycles) {
      const prediction = await repos.prediction.findFirst(scope, cycle.cycleId);
      if (prediction === null) {
        throw rondoError('INVALID_OPERATION', '仍有必填活动未完成：预测。');
      }
      const submissions = await this.submissionsOfCycle(scope, repos, cycle.cycleId);
      if (submissions.length === 0) {
        throw rondoError('INVALID_OPERATION', '仍有必填活动未完成：提交。');
      }
      const explanations = await repos.explanationRevision.listByCycle(scope, cycle.cycleId);
      if (explanations.length === 0) {
        throw rondoError('INVALID_OPERATION', '仍有必填活动未完成：解释。');
      }
    }
    const summary = await this.buildResultSummary(scope, repos, attempt, cycles);
    const updated = await this.casAttempt(scope, repos, attempt, {
      nextStatus: 'COMPLETED',
      endAttempt: true,
      resultSummaryJson: canonicalize(summary),
    });
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'ATTEMPT_FINISHED', {
      summary,
    });
    return {
      effectRefs: [`attempt:${attempt.attemptId}`, eventRef],
      changedKinds: ['learning.resumePoint', 'learning.attemptView', 'learning.timeline', 'guardian.evidenceSummary'],
      attemptVersion: updated.version,
    };
  }

  private async cmdPauseAttempt(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    this.checkExpectedVersion(attempt, envelope);
    if (attempt.attemptStatus !== 'ACTIVE') {
      throw rondoError('INVALID_OPERATION', `只有 ACTIVE 才能暂停，当前 ${attempt.attemptStatus}。`);
    }
    const updated = await this.casAttempt(scope, repos, attempt, { nextStatus: 'PAUSED' });
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'ATTEMPT_PAUSED', {});
    return {
      effectRefs: [`attempt:${attempt.attemptId}`, eventRef],
      changedKinds: ['learning.resumePoint', 'learning.attemptView', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  private async cmdResumeAttempt(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    this.checkExpectedVersion(attempt, envelope);
    if (attempt.attemptStatus !== 'PAUSED') {
      throw rondoError('INVALID_OPERATION', `只有 PAUSED 才能恢复，当前 ${attempt.attemptStatus}。`);
    }
    const otherActive = (await repos.learningAttempt.listByLearner(scope, attempt.learnerId, 'ACTIVE'))
      .some((other) => other.attemptId !== attempt.attemptId);
    if (otherActive) throw rondoError('INVALID_OPERATION', '请先明确暂停当前正在进行的课程，再继续本课。');
    const release = await repos.contentRelease.findById(scope, attempt.releaseId);
    if (release === null) {
      throw rondoError('CONTENT_UNAVAILABLE', '内容绑定不可恢复：release 不存在。');
    }
    if (release.status === 'REVOKED') {
      throw rondoError('CONTENT_REVOKED', '内容已撤销，不能恢复该 attempt。');
    }
    const updated = await this.casAttempt(scope, repos, attempt, { nextStatus: 'ACTIVE' });
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'ATTEMPT_RESUMED', {});
    return {
      effectRefs: [`attempt:${attempt.attemptId}`, eventRef],
      changedKinds: ['learning.resumePoint', 'learning.attemptView', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  private async cmdEndWithoutCompleting(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const attempt = await this.requireAttempt(ctx, envelope, repos);
    if (attempt.attemptStatus !== 'ACTIVE' && attempt.attemptStatus !== 'PAUSED') {
      throw rondoError('INVALID_OPERATION', `attempt 当前状态 ${attempt.attemptStatus}，不能放弃。`);
    }
    const updated = await this.casAttempt(scope, repos, attempt, { nextStatus: 'ABANDONED', endAttempt: true });
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'ATTEMPT_ABANDONED', {});
    return {
      effectRefs: [`attempt:${attempt.attemptId}`, eventRef],
      changedKinds: ['learning.resumePoint', 'learning.attemptView', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  // -- guardian ---------------------------------------------------------------

  private async cmdRecordAssistance(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const payload = envelope.payload as {
      attemptId: string;
      eventId?: string;
      submissionId?: string;
      category: 'OPERATIVE' | 'RESTATE' | 'CONCEPT' | 'ANSWER';
      note: string;
    };
    const attempt = await repos.learningAttempt.findById(scope, payload.attemptId);
    if (attempt === null) {
      throw rondoError('INVALID_OPERATION', `未知的 attempt：${payload.attemptId}`);
    }
    let targetRef = `attempt:${payload.attemptId}`;
    if (payload.eventId !== undefined) {
      const events = await repos.learningEvent.pageBySeq(scope, { attemptId: attempt.attemptId, afterSeq: 0, limit: 1000000 });
      if (!events.some((e) => e.eventId === payload.eventId)) {
        throw rondoError('INVALID_OPERATION', `引用的事件不属于该 attempt：${payload.eventId}`);
      }
      targetRef = `event:${payload.eventId}`;
    }
    if (payload.submissionId !== undefined) {
      const submission = await repos.submission.findById(scope, payload.submissionId);
      if (submission === null) {
        throw rondoError('INVALID_OPERATION', `引用的提交不可见：${payload.submissionId}`);
      }
      const cycle = await repos.learningCycle.findById(scope, submission.cycleId);
      if (cycle === null || cycle.attemptId !== attempt.attemptId) {
        throw rondoError('INVALID_OPERATION', '引用的提交不属于该 attempt。');
      }
      targetRef = `submission:${payload.submissionId}`;
    }
    const recordId = this.deps.ids.newId('rec');
    // Assistance only records the intervention fact; the child's original
    // submissions/evaluations are never rewritten (PRODUCT §6/§7).
    await repos.assistanceRecord.insert(scope, {
      recordId,
      familyId: ctx.familyId,
      attemptId: attempt.attemptId,
      targetRef,
      category: payload.category,
      note: payload.note,
      recordedByActorId: ctx.actorId,
      revisionOfId: null,
      at: this.now(),
    });
    const updated = await this.bumpAttempt(scope, repos, attempt);
    const eventRef = await this.appendEvent(scope, repos, envelope, attempt.attemptId, 'ASSISTANCE_RECORDED', {
      recordId,
      category: payload.category,
      targetRef,
    });
    return {
      effectRefs: [`assistance:${recordId}`, eventRef],
      changedKinds: ['guardian.evidenceSummary', 'learning.timeline'],
      attemptVersion: updated.version,
    };
  }

  private async cmdAnnotateExplanation(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const payload = envelope.payload as {
      explanationRevisionRef: string;
      rubric: { condition: string; relation: string; basis: string };
      note?: string;
    };
    const revision = await (repos.explanationRevision as Repositories['explanationRevision'] & {
      findById?: (scope: RepoScope, id: string) => Promise<{ revisionId: string } | null>;
    }).findById?.(scope, payload.explanationRevisionRef);
    if (revision === undefined) {
      throw rondoError('PERSISTENCE_FAILED', 'storage lacks explanation lookup capability');
    }
    if (revision === null) {
      throw rondoError('INVALID_OPERATION', `未知的解释修订：${payload.explanationRevisionRef}`);
    }
    const observationId = this.deps.ids.newId('obs');
    await repos.guardianObservation.insert(scope, {
      observationId,
      explanationRevisionRef: payload.explanationRevisionRef,
      rubricVersion: RUBRIC_VERSION,
      conditionObserved: payload.rubric.condition,
      relationObserved: payload.rubric.relation,
      basisObserved: payload.rubric.basis,
      reviewerActorId: ctx.actorId,
      revisionOfId: null,
      at: this.now(),
    });
    return {
      effectRefs: [`observation:${observationId}`],
      changedKinds: ['guardian.evidenceSummary'],
    };
  }

  private async cmdPrepareExport(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const payload = envelope.payload as { scope: { categories: string[] } };
    const now = this.now();
    const scopeJson = canonicalize({ categories: payload.scope.categories, familyId: ctx.familyId, preparedAt: now });
    const opId = this.deps.ids.newId('op');
    await repos.dataOperation.insert(scope, {
      opId,
      familyId: ctx.familyId,
      kind: 'EXPORT',
      scopeJson,
      scopeHash: sha256Hex(scopeJson),
      phase: 'PREPARED',
      resultJson: null,
      preparedAt: now,
      confirmedAt: null,
    });
    return {
      effectRefs: [`export:${opId}`],
      changedKinds: ['guardian.exportStatus'],
    };
  }

  private async cmdConfirmExport(
    ctx: ServerContext,
    envelope: PublicCommandEnvelope,
    repos: Repositories,
    scope: RepoScope,
  ) {
    const payload = envelope.payload as { preparedVersion: string };
    const op = await repos.dataOperation.findById(scope, payload.preparedVersion);
    if (op === null || op.kind !== 'EXPORT') {
      throw rondoError('INVALID_OPERATION', `未知的导出准备版本：${payload.preparedVersion}`);
    }
    if (op.phase !== 'PREPARED') {
      throw rondoError('INVALID_OPERATION', `导出操作当前阶段 ${op.phase}，不能确认。`);
    }
    const ok = await repos.dataOperation.updatePhase(scope, { opId: op.opId, phase: 'CONFIRMED' });
    if (!ok) {
      throw rondoError('PERSISTENCE_FAILED', '导出确认失败，事务已回滚。');
    }
    return {
      effectRefs: [`export:${op.opId}`],
      changedKinds: ['guardian.exportStatus'],
    };
  }

  private deletionRepo(repos: Repositories) {
    return repos.dataOperation as typeof repos.dataOperation & {
      inspectDeletion(scope: RepoScope, spec: DisposalSpec): Promise<{ scope: DeletionScope; fingerprint: string }>;
      revokeDeletionSessions(scope: RepoScope, at: number): Promise<number>;
      completeDeletion(scope: RepoScope, opId: string, phase: 'COMPLETED' | 'COMPLETED_PARTIAL', resultJson: string, at: number): Promise<boolean>;
    };
  }

  private deletionSpec(familyId: string, target: DeletionScope['target'], targetId?: string | null): DisposalSpec {
    return target === 'ALL_FAMILY_DATA' ? { kind: 'FAMILY_ALL', familyId }
      : target === 'LEARNER' ? { kind: 'LEARNER', familyId, learnerId: targetId! }
      : { kind: 'ATTEMPT', familyId, attemptId: targetId! };
  }

  private async deletionSnapshot(scope: RepoScope, repos: Repositories, target: DeletionScope['target'], targetId?: string | null) {
    if (target === 'LEARNER' && !await repos.learner.findById(scope, targetId ?? ''))
      throw rondoError('INVALID_OPERATION', '删除目标不可用，请重新选择本家庭范围。');
    if (target === 'ATTEMPT' && !await repos.learningAttempt.findById(scope, targetId ?? ''))
      throw rondoError('INVALID_OPERATION', '删除目标不可用，请重新选择本家庭范围。');
    const snapshot = await this.deletionRepo(repos).inspectDeletion(scope, this.deletionSpec(scope.familyId, target, targetId));
    const runs: StoredCodeRun[] = [];
    for (const attempt of snapshot.scope.attempts) runs.push(...await this.codeRecords(scope, repos, attempt.attemptId));
    // A job can still hold a private check or enqueue a status write after its public state changes.
    if (runs.some((r) => !r.run.terminal || r.run.status === 'UNKNOWN' || this.runningCode.has(r.run.jobId)))
      throw rondoError('INVALID_OPERATION', '所选范围仍有未结束的代码作业，请等待或停止作业后重新预览。');
    return { ...snapshot, codeRuns: runs.map((r) => ({ jobId: r.run.jobId, instanceId: r.run.instanceId })) };
  }

  private async cmdPrepareDeletion(ctx: ServerContext, envelope: PublicCommandEnvelope, repos: Repositories, scope: RepoScope) {
    const payload = envelope.payload as { target: DeletionScope['target']; targetId?: string };
    const snapshot = await this.deletionSnapshot(scope, repos, payload.target, payload.targetId);
    // Only ids, counts and a digest survive as the tombstone: no aliases, drafts or child text.
    const scopeJson = canonicalize({ version: 2, target: payload.target, targetId: payload.targetId ?? null,
      learnerIds: snapshot.scope.learners.map((l) => l.learnerId), attemptIds: snapshot.scope.attempts.map((a) => a.attemptId),
      counts: snapshot.scope.counts, fingerprint: snapshot.fingerprint, codeRuns: snapshot.codeRuns });
    const opId = this.deps.ids.newId('op');
    await repos.dataOperation.insert(scope, { opId, familyId: ctx.familyId, kind: 'DELETION', scopeJson,
      scopeHash: sha256Hex(scopeJson), phase: 'PREPARED', resultJson: null, preparedAt: this.now(), confirmedAt: null });
    return { effectRefs: [`disposal:${opId}`], changedKinds: ['guardian.deletionStatus'] };
  }

  private async cmdConfirmDeletion(ctx: ServerContext, envelope: PublicCommandEnvelope, repos: Repositories, scope: RepoScope) {
    const payload = envelope.payload as { preparedDeletionId: string; scopeListHash: string };
    const prepared = await repos.dataOperation.findById(scope, payload.preparedDeletionId);
    if (!prepared || prepared.kind !== 'DELETION' || prepared.phase !== 'PREPARED' || prepared.scopeHash !== payload.scopeListHash)
      throw rondoError('INVALID_OPERATION', '删除准备操作或范围校验不匹配，请重新预览。');
    const old = JSON.parse(prepared.scopeJson) as { version?: number; target: DeletionScope['target']; targetId: string | null; fingerprint?: string };
    if (old.version !== 2 || this.now() >= prepared.preparedAt + DELETION_PREVIEW_LIFETIME_MS)
      throw rondoError('INVALID_OPERATION', '删除预览已过期，请重新预览并确认。');
    const current = await this.deletionSnapshot(scope, repos, old.target, old.targetId);
    if (current.fingerprint !== old.fingerprint)
      throw rondoError('INVALID_OPERATION', '学习记录或删除范围已变化，未删除任何数据，请重新预览。');
    const spec = this.deletionSpec(ctx.familyId, old.target, old.targetId);
    const disposal = this.disposalCapable().dispose(spec);
    const remaining = await this.deletionRepo(repos).inspectDeletion(scope, spec);
    if (Object.values(remaining.scope.counts).some((count) => count !== 0))
      throw rondoError('PERSISTENCE_FAILED', '删除后仍有范围内记录，事务已回滚。');
    const result: DeletionResult = { confirmationKey: envelope.idempotencyKey, deleted: { ...disposal.deleted },
      remaining: remaining.scope.counts, completedAtMs: this.now(), sessionsInvalidated: true,
      revokedSessionCount: await this.deletionRepo(repos).revokeDeletionSessions(scope, this.now()),
      hostCopies: current.codeRuns.length ? 'PENDING' : 'NOT_PRESENT', failedJobCount: 0 };
    if (!await this.deletionRepo(repos).completeDeletion(scope, prepared.opId,
      result.hostCopies === 'PENDING' ? 'COMPLETED_PARTIAL' : 'COMPLETED', canonicalize(result), this.now()))
      throw rondoError('PERSISTENCE_FAILED', '删除收尾失败，事务已回滚。');
    return { effectRefs: [`disposal:${prepared.opId}`], changedKinds: ['guardian.deletionStatus', 'learning.resumePoint'] };
  }

  private async finishDeletionCopies(ctx: ServerContext, receipt: CommandReceipt): Promise<void> {
    const opId = receipt.effectRefs.find((ref) => ref.startsWith('disposal:'))?.slice(9);
    if (!opId) return;
    const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
    // The SQL commit and receipt already exist. Cleanup failures must never masquerade as rollback.
    try {
      const op = await this.deps.storage.read((repos) => repos.dataOperation.findById(scope, opId));
      if (!op || op.kind !== 'DELETION' || !op.resultJson) return;
      const result = deletionResultSchema.parse(JSON.parse(op.resultJson));
      if (result.confirmationKey !== receipt.idempotencyKey || ['CLEARED', 'NOT_PRESENT'].includes(result.hostCopies)) return;
      const prepared = JSON.parse(op.scopeJson) as { codeRuns: { jobId: string; instanceId: string }[] };
      let failed = 0;
      for (const run of prepared.codeRuns) {
        try {
          const original = this.deps.compiler?.forgetDeletionRun?.(run.jobId, run.instanceId);
          const current = this.compilerLifecycle?.forgetDeletionRun(run.jobId, run.instanceId);
          if ((!original?.owned && !current?.owned) || (original?.pending ?? 0) > 0 || (current?.pending ?? 0) > 0) failed++;
        } catch { failed++; }
      }
      const updated: DeletionResult = { ...result, hostCopies: failed ? 'PARTIAL' : 'CLEARED', failedJobCount: failed };
      await this.deps.storage.tx('deletion.copies', async (repos) => {
        if (!await this.deletionRepo(repos).completeDeletion(scope, opId, failed ? 'COMPLETED_PARTIAL' : 'COMPLETED',
          canonicalize(updated), result.completedAtMs)) throw Error('Deletion copy result unavailable');
      });
    } catch { /* The committed PENDING/PARTIAL result remains queryable under the original key. */ }
  }

  private async allCyclesOfAttempt(scope: RepoScope, repos: Repositories, attemptId: string): Promise<LearningCycleRecord[]> {
    const raw = repos.learningCycle as unknown as {
      listByAttempt?: (scope: RepoScope, attemptId: string) => Promise<LearningCycleRecord[]>;
    };
    if (typeof raw.listByAttempt !== 'function') {
      throw rondoError('PERSISTENCE_FAILED', 'storage lacks cycle listing capability');
    }
    return raw.listByAttempt(scope, attemptId);
  }

  private async submissionsOfCycle(
    scope: RepoScope,
    repos: Repositories,
    cycleId: string,
  ): Promise<{ submissionId: string; at: number }[]> {
    const raw = repos.submission as unknown as {
      listAllByCycle?: (scope: RepoScope, cycleId: string) => Promise<{ submissionId: string; at: number }[]>;
    };
    if (typeof raw.listAllByCycle !== 'function') {
      throw rondoError('PERSISTENCE_FAILED', 'storage lacks submission listing capability');
    }
    return raw.listAllByCycle(scope, cycleId);
  }

  private async buildResultSummary(
    scope: RepoScope,
    repos: Repositories,
    attempt: LearningAttemptRecord,
    cycles: LearningCycleRecord[],
  ): Promise<Record<string, unknown>> {
    const daily=await dailyMembership(scope,repos,attempt);
    const explanationRequested=daily?(await dailyEvents(scope,repos,attempt.attemptId)).some(e=>e.eventType==='DAILY_EXPLANATION_REQUESTED'):false;
    const perCycle: Record<string, unknown>[] = [];
    for (const cycle of cycles) {
      const instance = await repos.questionInstance.findById(scope, cycle.questionInstanceId);
      const subs = await this.submissionsOfCycle(scope, repos, cycle.cycleId);
      let finalOutcome: string | null = null;
      if (subs.length > 0) {
        const evaluation = await repos.evaluation.findOriginalBySubmission(scope, subs[subs.length - 1].submissionId);
        finalOutcome = evaluation?.outcome ?? null;
      }
      const assistance = await repos.assistanceRecord.listByAttempt(scope, attempt.attemptId);
      const answerAssisted =
        explanationRequested || assistance.some((r) => r.category === 'ANSWER') ||
        (await this.cycleHasAnswerHint(scope, repos, cycle, instance?.releaseId ?? attempt.releaseId, instance?.taskId ?? ''));
      const hints = await repos.hintPresentation.listByCycle(scope, cycle.cycleId);
      perCycle.push({
        cycleId: cycle.cycleId,
        taskId: instance?.taskId ?? null,
        finalOutcome,
        hintCount: hints.length,
        answerAssisted,
        ...(daily?{workflow:daily.entry.workflow,explanationRequested}:{}),
        independence: daily?'NOT_ASSESSED':answerAssisted ? 'ANSWER_ASSISTED' : hints.length > 0 || assistance.length > 0 ? 'ASSISTED' : 'INDEPENDENT',
      });
    }
    return {
      completedAt: this.now(),
      cycles: perCycle,
      // Completion of the flow is NOT mastery (PRODUCT §7): no unlock, no level.
      note: '完成流程不等于掌握；数值、单位与构造条件由冻结规则判定。',
    };
  }

  private async cycleHasAnswerHint(
    scope: RepoScope,
    repos: Repositories,
    cycle: LearningCycleRecord,
    releaseId: string,
    taskId: string,
  ): Promise<boolean> {
    const hints = await repos.hintPresentation.listByCycle(scope, cycle.cycleId);
    if (hints.length === 0) return false;
    const content = this.content();
    const taskSpec = content.getTaskSpec(releaseId, taskId);
    if (taskSpec === null) return false;
    for (const hint of hints) {
      const gate = taskSpec.manifest.private.hintGateTable.find((g) => g.taskId === taskId && g.hintLevel === hint.level);
      const hintContent = gate ? content.getHintContent(releaseId, gate.contentRef) : null;
      if (hintContent?.revealsAnswer === true) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Queries
  // MVP v1 keeps code admission, drafts, grading and history in this same domain service.
  private runningCode = new Map<string, {cancelled:boolean; promise:Promise<void>}>();

  private async codeRecords(scope: RepoScope, repos: Repositories, attemptId: string): Promise<StoredCodeRun[]> {
    const latest = new Map<string, StoredCodeRun>();
    let afterSeq=0;
    for (;;) {
      const events=await repos.learningEvent.pageBySeq(scope,{attemptId,afterSeq,limit:200});
      for(const event of events) if(event.eventType==='CODE_RUN_STATUS') {
        const value=JSON.parse(event.payloadJson) as StoredCodeRun; latest.set(value.run.jobId,value);
      }
      if(events.length<200)break;
      afterSeq=events[events.length-1].seq;
    }
    return [...latest.values()];
  }

  private codeAvailability(rule:FamilyRuleBody|null):CodeAvailability {
    if(!this.compilerLifecycle||rule?.kind!=='MVP_ACTIVITY_TRUTH_V1'||!['cpp','gesp-program'].includes(rule.activity))return {available:false,reason:'UNAVAILABLE'};
    // Use the same task capacity as reserve, without reserving, rotating or submitting anything.
    const {available,reason}=this.compilerLifecycle.capability(1+(rule.gesp?.codeCases??rule.privateInputs).length);
    return {available,reason};
  }

  private publicCode(stored:StoredCodeRun):CodeSnapshot {
    const run=stored.run;
    const current=this.compilerLifecycle?.capability().instanceId;
    const uncertain=!run.terminal&&(run.instanceId!==current||this.compilerLifecycle?.isUnresolved(run.jobId));
    // Projection only: never rewrite old events or expose raw infrastructure diagnostics.
    if(uncertain)return {...run,status:'UNKNOWN',terminal:true,stderr:UNCONFIRMED_CODE_MESSAGE};
    return ['UNKNOWN','CAPABILITY_UNAVAILABLE','INTERNAL_ERROR'].includes(run.status)?{...run,stderr:UNCONFIRMED_CODE_MESSAGE}:run;
  }

  private async cmdCode(ctx:ServerContext,envelope:PublicCommandEnvelope,repos:Repositories,scope:RepoScope,onCodeAdmission:(jobId:string)=>void){
    const attempt=await this.requireAttempt(ctx,envelope,repos);
    this.checkExpectedVersion(attempt,envelope);
    const cycle=await this.currentCycle(scope,repos,attempt);
    const instance=await repos.questionInstance.findById(scope,cycle.questionInstanceId);
    const rule=instance ? this.content().getRuleBody(instance.releaseId,instance.taskId) : null;
    if(rule?.kind!=='MVP_ACTIVITY_TRUTH_V1'||!['cpp','gesp-program'].includes(rule.activity)) throw rondoError('INVALID_OPERATION','当前任务不支持真实C++。');
    if(envelope.kind==='code.requestCancel'){
      const {jobId}=envelope.payload as {jobId:string};
      const stored=(await this.codeRecords(scope,repos,attempt.attemptId)).find(x=>x.run.jobId===jobId);
      if(!stored)throw rondoError('FORBIDDEN','作业不属于本次学习。');
      return {effectRefs:[`cancel:${jobId}`,`job:${jobId}`],changedKinds:['code.runStatus'],attemptVersion:attempt.version};
    }
    if(attempt.attemptStatus!=='ACTIVE'||cycle.phase!=='OPERATE')throw rondoError('INVALID_OPERATION','请先完成预测并进入操作阶段。');
    if(!envelope.binding||envelope.expectedAttemptVersion===undefined)throw rondoError('INVALID_OPERATION','运行必须绑定题目、renderer和attempt版本。');
    const p=envelope.payload as {source:string;stdin:string;taskId:string;compilerContractId:string};
    if(p.taskId!==instance!.taskId||p.compilerContractId!==COMPILER_CONTRACT)throw rondoError('INVALID_OPERATION','任务或编译合同不匹配。');
    if(Buffer.byteLength(p.source)>32768||Buffer.byteLength(p.stdin)>16384)throw rondoError('INVALID_OPERATION','源码限32KiB，输入限16KiB（UTF-8）。');
    if(!this.compilerLifecycle)throw rondoError('CAPABILITY_UNAVAILABLE','本机隔离编译器不可用。');
    const prior=await this.codeRecords(scope,repos,attempt.attemptId);
    if(prior.some(x=>!this.publicCode(x).terminal))throw rondoError('INVALID_OPERATION','已有运行未结束，请等待或停止。');
    const jobId=this.deps.ids.newId('job');
    const lease=await this.compilerLifecycle.reserve(jobId,1+(rule.gesp?.codeCases??rule.privateInputs).length);
    onCodeAdmission(jobId);
    const stored:StoredCodeRun={privatePassed:null,run:{jobId,requestId:envelope.idempotencyKey,attemptId:attempt.attemptId,cycleId:cycle.cycleId,questionInstanceId:cycle.questionInstanceId,taskId:instance!.taskId,attemptVersion:attempt.version,source:p.source,stdin:p.stdin,sourceHash:hashText(p.source),inputHash:hashText(p.stdin),compilerContractId:p.compilerContractId,imageId:compilerConfig.imageId,instanceId:lease.instanceId,workerJobId:null,status:'QUEUED',terminal:false,stdout:'',stderr:'',createdAt:this.now(),updatedAt:this.now()}};
    await this.appendEvent(scope,repos,envelope,attempt.attemptId,'CODE_RUN_STATUS',stored);
    const updated=await this.bumpAttempt(scope,repos,attempt);
    return {effectRefs:[`job:${jobId}`],changedKinds:['code.runStatus','learning.attemptView'],attemptVersion:updated.version};
  }

  private async launchCode(ctx:ServerContext,receipt:CommandReceipt):Promise<void>{
    const jobRef=receipt.effectRefs.find(x=>x.startsWith('job:'));
    if(!jobRef||!this.deps.compiler)return;
    const jobId=jobRef.slice(4), scope={familyId:ctx.familyId,actorId:ctx.actorId};
    if(receipt.kind==='code.requestCancel'){
      const running=this.runningCode.get(jobId);if(running)running.cancelled=true;return;
    }
    if(this.runningCode.has(jobId))return;
    const control={cancelled:false,promise:Promise.resolve()};
    // Claim synchronously before reading facts, so duplicate receipts cannot launch two loops.
    this.runningCode.set(jobId,control);
    try{
      const data=await this.deps.storage.read(async repos=>{
        if(!ctx.learnerId)return null;
        for(const attempt of await repos.learningAttempt.listByLearner(scope,ctx.learnerId)){
          const record=(await this.codeRecords(scope,repos,attempt.attemptId)).find(x=>x.run.jobId===jobId);
          if(record)return record;
        }
        return null;
      });
      const lease=this.compilerLifecycle?.forRun(jobId);
      if(!data||data.run.terminal||!lease||data.run.instanceId!==lease.instanceId){this.runningCode.delete(jobId);return;}
      const rule=this.content().getRuleBody((await this.deps.storage.read(repos=>repos.learningAttempt.findById(scope,data.run.attemptId)))!.releaseId,data.run.taskId);
      if(rule?.kind!=='MVP_ACTIVITY_TRUTH_V1')throw Error('Admitted rule unavailable');
      let persisted=false;
      const persist=async(stored:StoredCodeRun)=>{await this.deps.storage.tx('code.status',async repos=>{
        const attempt=await repos.learningAttempt.findById(scope,stored.run.attemptId);
        if(!attempt)throw Error('Admitted attempt unavailable');
        await repos.learningEvent.append(scope,{attemptId:attempt.attemptId,familyId:scope.familyId,commandKind:'code.requestRun',eventType:'CODE_RUN_STATUS',payloadJson:canonicalize(stored),payloadVersion:'1',occurredAt:this.now()});
      });if(stored.run.terminal)persisted=true;};
      control.promise=executeActivityCode(lease.compiler,data,rule.gesp?.codeCases??rule.privateInputs,persist,()=>control.cancelled)
        .catch(()=>{})
        .finally(()=>{this.compilerLifecycle?.settle(jobId,data.run.status,persisted);this.runningCode.delete(jobId);});
    }catch(error){
      reportCodeFailure({jobId,instanceId:this.compilerLifecycle?.forRun(jobId)?.instanceId??'unknown'},
        {stage:'LAUNCH',operation:'PREPARE',category:'UNKNOWN',workerJobId:null});
      this.compilerLifecycle?.settle(jobId,'UNKNOWN',false);this.runningCode.delete(jobId);throw error;
    }
  }

  private async evaluateActivity(rule:ActivityRule,state:ActivityState,response:StructuredResponseItem[],scope:RepoScope,repos:Repositories,attemptId:string,cycleId:string):Promise<EvaluationResult>{
    const attempt=await repos.learningAttempt.findById(scope,attemptId);
    const daily=attempt?await dailyMembership(scope,repos,attempt):null;
    if(daily?.entry.workflow==='daily.short.v1')return evaluateDailyShort(daily.entry,rule,state,response);
    if(rule.activity==='math6'){if(!state.math||response.length!==1||response[0].kind!=='mathAnswer')throw rondoError('INVALID_OPERATION','请提交当前数学活动的登记回答。');return evaluateMath6(rule,state.math,response[0]);}
    if(rule.activity==='gesp-objective'||rule.activity==='gesp-program'){
      const truth=rule.gesp,record=state.gesp,question=GESP_LESSONS.find(q=>q.id===truth?.questionId);
      if(!truth||!record||record.questionId!==truth.questionId||!question)throw rondoError('INVALID_OPERATION','题目与本次推演不匹配。');
      const reasoned=Object.values(record.reasoning).every(text=>text.trim().length>0);
      let correct=false,scorable=true;
      if(rule.activity==='gesp-objective')return evaluateGespObjective(rule,record,response);
      else{
        if(response.length!==1||response[0].kind!=='codeRun')throw rondoError('INVALID_OPERATION','请提交本题一次真实运行。');
        const item=response[0],stored=(await this.codeRecords(scope,repos,attemptId)).find(x=>x.run.jobId===item.jobId);
        if(!stored||stored.run.cycleId!==cycleId||stored.run.source!==item.source||stored.run.stdin!==item.stdin)throw rondoError('INVALID_OPERATION','代码或输入已经变化，请运行当前版本再提交。');
        const run=this.publicCode(stored);scorable=run.terminal&&!['UNKNOWN','CAPABILITY_UNAVAILABLE','INTERNAL_ERROR'].includes(run.status);correct=scorable&&reasoned&&stored.privatePassed===true;
      }
      const detail=!scorable?UNCONFIRMED_CODE_MESSAGE:!reasoned?'请把输入理解、关键步骤和边界核对分别留在推演记录里，再提交。':correct?(rule.activity==='gesp-program'?'程序已通过本题课程登记的有限用例；这不等同官方全套评测通过。推演文字已保存，仍需你说明依据。':'这次选择与课程语义核对一致。推演原文已保存，接着说明自己的依据；一次选择不代表掌握。'):'再核对本题的条件、执行顺序和边界；样例输出或编译成功本身不能保证正确。';
      return{outcome:!scorable?'UNSCORABLE':correct?'CORRECT':'REVISE',feedback:{ruleKind:'FAMILY_TRUTH_V1',scenarioMet:reasoned,responseTypeOk:true,itemResults:[{key:'gesp',label:'本题核对',verdict:correct?'CORRECT':'REVISE',feedback:detail}],diagnostics:[detail],reveal:{explanation:rule.explanation,...(rule.referenceSource?{referenceSource:rule.referenceSource}:{})}}};
    }
    if(AI_NEW_IDS.includes(rule.activity as NewAIId)){if(response.length!==1||response[0].kind!=='aiLabAnswer')throw rondoError('INVALID_OPERATION','本题需要登记的AI活动回答。');return evaluateAILab(rule,state,response[0]);}
    let correct=false,scorable=true,detail='请对照对象与资料，重新检查各项关系。';
    if(rule.activity==='ratio'){
      if(response.length!==2||response.filter(x=>x.kind==='singleChoice').length!==1||response.filter(x=>x.kind==='fractionValue'&&x.quantityId==='juice-share').length!==1)throw rondoError('INVALID_OPERATION','本题需要一个比的选择和一个整份饮料份额。');
      const fraction=response.find(x=>x.kind==='fractionValue');
      const choice=response.find(x=>x.kind==='singleChoice'&&x.selectionId==='ratio');
      correct=state.scale===2 && choice?.kind==='singleChoice'&&choice.optionId==='3-to-2'&&fraction?.kind==='fractionValue'&&fraction.numerator*5===fraction.denominator*3;
      detail=correct?'比的顺序与整份饮料的范围都对应上了。':'分别检查比的顺序、整份饮料包含哪些杯，以及是否把两种杯数同时扩大两倍。';
    } else if(rule.activity==='ai-a7'){
      if(response.length!==3||new Set(response.filter(x=>x.kind==='singleChoice').map(x=>x.selectionId)).size!==3)throw rondoError('INVALID_OPERATION','请给三项说法各提交一次判断。');
      correct=Object.entries(rule.choices).every(([id,value])=>state.inspected.includes(id)&&response.some(x=>x.kind==='singleChoice'&&x.selectionId===id&&x.optionId===value));
      detail=correct?'判断均能追溯到给定资料；资料缺失的说法仍需向可靠来源确认。':'逐张打开资料卡，区分“明确冲突”和“没有依据”；资料没提到，不等于已经证伪。';
    } else {
      if(response.length!==1||response[0].kind!=='codeRun')throw rondoError('INVALID_OPERATION','本题提交必须绑定一次真实代码运行。');
      const item=response.find(x=>x.kind==='codeRun');
      const record=item?.kind==='codeRun' ? (await this.codeRecords(scope,repos,attemptId)).find(x=>x.run.jobId===item.jobId):null;
      if(!record||item?.kind!=='codeRun'||record.run.cycleId!==cycleId||record.run.source!==item.source||record.run.stdin!==item.stdin)throw rondoError('INVALID_OPERATION','代码或输入已改变，不能提交旧结果。请运行当前版本。');
      const run=this.publicCode(record);
      scorable=run.terminal&&!['UNKNOWN','CAPABILITY_UNAVAILABLE','INTERNAL_ERROR'].includes(run.status);
      correct=scorable&&record.privatePassed===true&&state.inspected.includes('algorithm');
      detail=!scorable?UNCONFIRMED_CODE_MESSAGE:correct?'程序通过本题已登记的边界检查。流程完成不等于掌握。':'样例运行与题目正确性分开核对。请检查跨行字母顺序、Z后回到A、行长度和多余空格。';
    }
    return {outcome:!scorable?'UNSCORABLE':correct?'CORRECT':'REVISE',feedback:{ruleKind:'FAMILY_TRUTH_V1',scenarioMet:correct,responseTypeOk:true,itemResults:[{key:'activity',label:'活动核对',verdict:correct?'CORRECT':'REVISE',feedback:detail}],diagnostics:[detail],reveal:{explanation:rule.explanation,...(rule.referenceSource?{referenceSource:rule.referenceSource}:{})}}};
  }

  private async activityHistory(ctx:ServerContext,repos:Repositories,learnerId:string):Promise<PublicProjection>{
    const scope={familyId:ctx.familyId,actorId:ctx.actorId};
    if(ctx.role==='LEARNER'&&ctx.learnerId!==learnerId)throw rondoError('FORBIDDEN','不能读取其他学习者的历史。');
    if(!await repos.learner.findById(scope,learnerId))throw rondoError('FORBIDDEN','学习者不可见。');
    const result:ActivityHistory={kind:'learning.activityHistory',learnerId,attempts:[]};
    for(const attempt of await repos.learningAttempt.listByLearner(scope,learnerId)){
      if(!attempt.releaseId.startsWith('rondo.mvp.'))continue;
      const daily=await dailyMembership(scope,repos,attempt);
      const dailyReveal=daily?.entry.workflow==='daily.short.v1'&&(await dailyEvents(scope,repos,attempt.attemptId)).some(e=>e.eventType==='DAILY_EXPLANATION_REQUESTED');
      const cycles:ActivityHistory['attempts'][number]['cycles']=[];
      for(const cycle of await this.allCyclesOfAttempt(scope,repos,attempt.attemptId)){
        const instance=await repos.questionInstance.findById(scope,cycle.questionInstanceId);
        const submissions=[];
        for(const sub of await (repos.submission as typeof repos.submission & {listAllByCycle(s:RepoScope,id:string):Promise<import('../contracts/server/storage').SubmissionRecord[]>}).listAllByCycle(scope,cycle.cycleId)){
          const ev=await repos.evaluation.findOriginalBySubmission(scope,sub.submissionId);
          const feedback=ev?JSON.parse(ev.feedbackJson):{};
          if(cycle.phase!=='REVIEW'&&!dailyReveal) delete feedback.reveal;
          const snapshot=activityStateSchema.parse(JSON.parse(sub.stateSnapshotJson));
          submissions.push({submissionId:sub.submissionId,response:JSON.parse(sub.responseJson),outcome:ev?.outcome??'UNSCORABLE',feedback,...(snapshot.lab?{lab:snapshot.lab}:{}),...(snapshot.gesp?{gesp:snapshot.gesp}:{}),...(snapshot.math?{math:snapshot.math}:{}),at:sub.at});
        }
        const prediction=await repos.prediction.findFirst(scope,cycle.cycleId);
        const presented=await repos.hintPresentation.listByCycle(scope,cycle.cycleId),taskSpec=instance?this.content().getTaskSpec(instance.releaseId,instance.taskId):null;
        const hints=presented.map(h=>{const gate=taskSpec?.manifest.private.hintGateTable.find(g=>g.taskId===instance?.taskId&&g.hintLevel===h.level);return{level:h.level,text:gate&&instance?this.content().getHintContent(instance.releaseId,gate.contentRef)?.text??'提示暂不可用':'提示暂不可用',at:h.at};});
        const operations:NonNullable<ActivityHistory['attempts'][number]['cycles'][number]['operations']>=[];let afterSeq=0;
        for(;;){const events=await repos.learningEvent.pageBySeq(scope,{attemptId:attempt.attemptId,afterSeq,limit:200});for(const event of events)if(event.eventType==='OPERATION_COMMITTED'){const p=JSON.parse(event.payloadJson);if(p.cycleId===cycle.cycleId&&p.operation?.type!=='SaveActivityDraft')operations.push({operation:p.operation,...(p.stateAfter?.lab?{labAfter:activityStateSchema.parse(p.stateAfter).lab}:{}),...(p.stateAfter?.gesp?{gespAfter:activityStateSchema.parse(p.stateAfter).gesp}:{}),...(p.stateAfter?.math?{mathAfter:activityStateSchema.parse(p.stateAfter).math}:{}),at:event.occurredAt});}if(events.length<200)break;afterSeq=events.at(-1)!.seq;}
        cycles.push({cycleId:cycle.cycleId,taskId:instance?.taskId??'',phase:cycle.phase,hints,operations,state:activityStateSchema.parse(JSON.parse(cycle.confirmedStateJson)),prediction:prediction?{...prediction,content:JSON.parse(prediction.contentJson)}:null,submissions,explanations:(await repos.explanationRevision.listByCycle(scope,cycle.cycleId)).map(x=>({revisionId:x.revisionId,text:x.freeText,at:x.at})),runs:(await this.codeRecords(scope,repos,attempt.attemptId)).filter(x=>x.run.cycleId===cycle.cycleId).map(x=>this.publicCode(x))});
      }
      result.attempts.push({attemptId:attempt.attemptId,releaseId:attempt.releaseId,status:attempt.attemptStatus,...(daily?{daily:{setId:daily.setId,index:daily.index,workflow:daily.entry.workflow,poolId:daily.entry.poolId,title:daily.entry.title}}:{}),previousAttemptId:attempt.previousAttemptId,startedAt:attempt.startedAt,cycles});
    }
    return result;
  }
  // -------------------------------------------------------------------------

  private async runQuery(ctx: ServerContext, request: PublicQuery, repos: Repositories): Promise<PublicProjection> {
    const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
    switch (request.kind) {
      case 'learning.daily': {
        if(ctx.role!=='LEARNER'||ctx.learnerId!==request.learnerId||!await repos.learner.findById(scope,request.learnerId))throw rondoError('FORBIDDEN','只能读取当前学习者的日常练习。');
        const sets=await readDailySets(scope,repos,request.learnerId);
        const views=await Promise.all(sets.map(set=>projectDailySet(scope,repos,request.learnerId,set)));
        const selected=request.setId?views.find(set=>set.setId===request.setId):views.find(set=>set.status==='OPEN')??views.at(-1);
        if(request.setId&&!selected)throw rondoError('FORBIDDEN','这组练习不可见或已随原记录移除。');
        return {kind:'learning.daily',learnerId:request.learnerId,serverDate:dailyDate(this.now()),set:selected??null};
      }
      case 'learning.activityHistory': return this.activityHistory(ctx,repos,request.learnerId);
      case 'catalog.availableLessons': {
        const releases = await repos.contentRelease.findByStatus(scope, 'AVAILABLE');
        const lessons = releases.flatMap((release) => {
          const info = JSON.parse(release.courseVersionsJson) as { taskIds: string[]; titles: Record<string, string> };
          const firstTask = info.taskIds[0];
          return [{ releaseId: release.releaseId, taskId: firstTask, title: info.titles[firstTask] ?? firstTask }];
        });
        return { kind: 'catalog.availableLessons', lessons };
      }
      case 'learning.resumePoint': {
        const learner = await repos.learner.findById(scope, request.learnerId);
        if (learner === null) {
          throw rondoError('FORBIDDEN', '该学习者不属于当前家庭。');
        }
        const unfinished = (await repos.learningAttempt.listByLearner(scope, request.learnerId))
          .filter((attempt) => attempt.attemptStatus === 'ACTIVE' || attempt.attemptStatus === 'PAUSED');
        const candidates = [];
        for (const attempt of unfinished) {
          const events = await repos.learningEvent.pageBySeq(scope, { attemptId: attempt.attemptId, afterSeq: 0, limit: 1000000 });
          candidates.push({ attempt, lastActivity: Math.max(attempt.startedAt, ...events.map((event) => event.occurredAt)) });
        }
        candidates.sort((a, b) => Number(b.attempt.attemptStatus === 'ACTIVE') - Number(a.attempt.attemptStatus === 'ACTIVE')
          || b.lastActivity - a.lastActivity || b.attempt.startedAt - a.attempt.startedAt || b.attempt.attemptId.localeCompare(a.attempt.attemptId));
        const latest = candidates[0]?.attempt;
        if (latest === undefined) {
          return { kind: 'learning.resumePoint', learnerId: request.learnerId, attempt: null };
        }
        const cycle = await repos.learningCycle.findCurrentByAttempt(scope, latest.attemptId);
        if (cycle === null) {
          return { kind: 'learning.resumePoint', learnerId: request.learnerId, attempt: null };
        }
        return {
          kind: 'learning.resumePoint',
          learnerId: request.learnerId,
          attempt: { attemptId: latest.attemptId, cycleId: cycle.cycleId, phase: cycle.phase, version: latest.version },
        };
      }
      case 'learning.attemptView': {
        const attempt = await repos.learningAttempt.findById(scope, request.attemptId);
        if (attempt === null) {
          throw rondoError('INVALID_OPERATION', `未知的 attempt：${request.attemptId}`);
        }
        const daily=await dailyMembership(scope,repos,attempt);
        const cycle = await repos.learningCycle.findCurrentByAttempt(scope, attempt.attemptId);
        return {
          kind: 'learning.attemptView',
          attemptId: attempt.attemptId,
          learnerId: attempt.learnerId,
          releaseId: attempt.releaseId,
          questionInstanceId: cycle?.questionInstanceId ?? '',
          attemptStatus: attempt.attemptStatus,
          ...(daily?{daily:{setId:daily.setId,index:daily.index,workflow:daily.entry.workflow,poolId:daily.entry.poolId,title:daily.entry.title}}:{}),
          version: attempt.version,
          currentCycle:
            cycle === null
              ? null
              : { cycleId: cycle.cycleId, phase: cycle.phase, questionInstanceId: cycle.questionInstanceId },
        };
      }
      case 'learning.questionView': {
        const attempt = await repos.learningAttempt.findById(scope, request.attemptId);
        if (attempt === null) {
          throw rondoError('INVALID_OPERATION', `未知的 attempt：${request.attemptId}`);
        }
        const cycle = await this.currentCycle(scope, repos, attempt, undefined, request.cycleId);
        const instance = await repos.questionInstance.findById(scope, cycle.questionInstanceId);
        if (instance === null) {
          throw rondoError('PERSISTENCE_FAILED', 'questionInstance 不可读。');
        }
        const content = this.content();
        const spec = content.getPublicQuestionSpecFor(instance, visibilityForPhase(cycle.phase));
        // Live confirmed state replaces the givens-based scene state.
        const specWithState = { ...spec, scene: { ...spec.scene, state: JSON.parse(cycle.confirmedStateJson) as CylinderStateV1 } };
        // Presented hints become visible material (persistent fact -> projection).
        const hints = await repos.hintPresentation.listByCycle(scope, cycle.cycleId);
        const taskSpec = content.getTaskSpec(instance.releaseId, instance.taskId);
        const hintBlocks = [];
        for (const hint of hints) {
          const gate = taskSpec?.manifest.private.hintGateTable.find((g) => g.taskId === instance.taskId && g.hintLevel === hint.level);
          const hintContent = gate ? content.getHintContent(instance.releaseId, gate.contentRef) : null;
          if (hintContent !== null) {
            hintBlocks.push({ type: 'TEXT' as const, text: `提示（层级 ${hint.level}）：${hintContent.text}` });
          }
        }
        const specWithHints = hintBlocks.length > 0 ? { ...specWithState, prompt: [...specWithState.prompt, ...hintBlocks] } : specWithState;
        return { kind: 'learning.questionView', spec: specWithHints };
      }
      case 'learning.timeline': {
        const attempt = await repos.learningAttempt.findById(scope, request.attemptId);
        if (attempt === null) {
          throw rondoError('INVALID_OPERATION', `未知的 attempt：${request.attemptId}`);
        }
        const limit = request.limit ?? 100;
        const events = await repos.learningEvent.pageBySeq(scope, {
          attemptId: attempt.attemptId,
          afterSeq: request.afterSeq ?? 0,
          limit: limit + 1,
        });
        const page = events.slice(0, limit);
        const last = page[page.length - 1];
        const hasMore = events.length > limit && last !== undefined;
        return {
          kind: 'learning.timeline',
          attemptId: attempt.attemptId,
          events: page.map((e) => ({
            seq: e.seq,
            eventId: e.eventId,
            eventType: e.eventType,
            commandKind: e.commandKind,
            occurredAtMs: e.occurredAt,
          })),
          ...(hasMore && last ? { nextAfterSeq: last.seq } : {}),
        };
      }
      case 'learning.receipt': {
        const result = await this.lookupReceiptInternal(scope, repos, request.idempotencyKey, request.commandKind);
        return { kind: 'learning.receipt', result };
      }
      case 'guardian.evidenceSummary': {
        if (ctx.role !== 'GUARDIAN') {
          throw rondoError('FORBIDDEN', 'guardian.evidenceSummary 需要监护人角色。');
        }
        type EvidenceType = 'PREDICTION' | 'SUBMISSION' | 'EVALUATION' | 'EXPLANATION' | 'ASSISTANCE' | 'OBSERVATION' | 'HINT';
        const items: { evidenceType: EvidenceType; refId: string; atMs: number }[] = [];
        const learners = await repos.learner.listByFamily(scope, scope.familyId);
        const targetLearners = request.learnerId !== undefined ? learners.filter((l) => l.learnerId === request.learnerId) : learners;
        if (request.learnerId !== undefined && targetLearners.length === 0) {
          throw rondoError('FORBIDDEN', '该学习者不属于当前家庭。');
        }
        for (const learner of targetLearners) {
          const attempts = (await repos.learningAttempt.listByLearner(scope, learner.learnerId)).filter(
            (a) => request.attemptId === undefined || a.attemptId === request.attemptId,
          );
          for (const attempt of attempts) {
            const cycles = await this.allCyclesOfAttempt(scope, repos, attempt.attemptId);
            for (const cycle of cycles) {
              const prediction = await repos.prediction.findFirst(scope, cycle.cycleId);
              if (prediction !== null) items.push({ evidenceType: 'PREDICTION' as const, refId: cycle.cycleId, atMs: prediction.recordedAt });
              const subs = await this.submissionsOfCycle(scope, repos, cycle.cycleId);
              for (const sub of subs) {
                items.push({ evidenceType: 'SUBMISSION' as const, refId: sub.submissionId, atMs: sub.at });
                const evaluation = await repos.evaluation.findOriginalBySubmission(scope, sub.submissionId);
                if (evaluation !== null) items.push({ evidenceType: 'EVALUATION' as const, refId: evaluation.evaluationId, atMs: evaluation.at });
              }
              const hints = await repos.hintPresentation.listByCycle(scope, cycle.cycleId);
              for (const hint of hints) items.push({ evidenceType: 'HINT' as const, refId: hint.hintId, atMs: hint.at });
              const explanations = await repos.explanationRevision.listByCycle(scope, cycle.cycleId);
              for (const explanation of explanations) {
                items.push({ evidenceType: 'EXPLANATION' as const, refId: explanation.revisionId, atMs: explanation.at });
                const observations = await repos.guardianObservation.listByExplanationRevision(scope, explanation.revisionId);
                for (const obs of observations) items.push({ evidenceType: 'OBSERVATION' as const, refId: obs.observationId, atMs: obs.at });
              }
            }
            const assistance = await repos.assistanceRecord.listByAttempt(scope, attempt.attemptId);
            for (const record of assistance) items.push({ evidenceType: 'ASSISTANCE' as const, refId: record.recordId, atMs: record.at });
          }
        }
        items.sort((a, b) => a.atMs - b.atMs);
        return {
          kind: 'guardian.evidenceSummary',
          ...(request.learnerId !== undefined ? { learnerId: request.learnerId } : {}),
          ...(request.attemptId !== undefined ? { attemptId: request.attemptId } : {}),
          items: items.slice(0, 1000),
        };
      }
      case 'guardian.retentionPolicy': {
        if (ctx.role !== 'GUARDIAN') throw rondoError('FORBIDDEN', '保留政策需要监护人角色。');
        const policy = await repos.retentionPolicy.find(scope, scope.familyId);
        const ops = repos.dataOperation as Repositories['dataOperation'] & {
          listByFamilyAndKind?: (scope: RepoScope, kind: 'DELETION') => Promise<DataOperationRecord[]>;
        };
        if (!ops.listByFamilyAndKind) throw rondoError('PERSISTENCE_FAILED', 'storage lacks retention cleanup readback');
        const completed = (await ops.listByFamilyAndKind(scope, 'DELETION')).filter((op) =>
          op.phase === 'COMPLETED' && (JSON.parse(op.scopeJson) as { retentionSweep?: boolean }).retentionSweep === true,
        ).sort((a, b) => b.preparedAt - a.preparedAt);
        const last = completed[0];
        return { kind: 'guardian.retentionPolicy',
          policy: policy ? { mode: policy.mode, rollingDays: policy.rollingDays, setAt: policy.setAt, previewVersion: policy.previewVersion } : null,
          lastCleanup: last ? { checkedAt: last.preparedAt, deletedAttemptCount: (JSON.parse(last.resultJson ?? '{}') as { deletedAttempts: number }).deletedAttempts } : null,
        };
      }
      case 'guardian.retentionPreview': {
        if (ctx.role !== 'GUARDIAN') throw rondoError('FORBIDDEN', '保留预览需要监护人角色。');
        const preview = await computeRetentionPreview(scope, repos, request.mode, request.rollingDays, this.now());
        return { kind: 'guardian.retentionPreview', mode: request.mode,
          rollingDays: request.mode === 'ROLLING_DAYS' ? request.rollingDays! : null, ...preview };
      }
      case 'guardian.deletionStatus': {
        if (ctx.role !== 'GUARDIAN') throw rondoError('FORBIDDEN', '删除状态需要监护人解锁。');
        const op = await repos.dataOperation.findById(scope, request.deletionId);
        if (!op || op.kind !== 'DELETION') throw rondoError('INVALID_OPERATION', '删除准备操作不可用。');
        const old = JSON.parse(op.scopeJson) as { version?: number; target: DeletionScope['target']; targetId: string | null; fingerprint?: string };
        const base = { kind: 'guardian.deletionStatus' as const, deletionId: op.opId, scopeHash: op.scopeHash,
          preparedAtMs: op.preparedAt, expiresAtMs: op.preparedAt + DELETION_PREVIEW_LIFETIME_MS };
        if (op.phase === 'COMPLETED' || op.phase === 'COMPLETED_PARTIAL') {
          const result = deletionResultSchema.safeParse(op.resultJson ? JSON.parse(op.resultJson) : null);
          if (!result.success || !request.confirmationKey || request.confirmationKey !== result.data.confirmationKey)
            throw rondoError('INVALID_OPERATION', '请使用原确认键核对该删除结果。');
          return { ...base, phase: op.phase, scope: null, result: result.data };
        }
        if (old.version !== 2 || op.phase !== 'PREPARED') return { ...base, phase: 'STALE', scope: null, result: null };
        if (this.now() >= base.expiresAtMs) return { ...base, phase: 'EXPIRED', scope: null, result: null };
        try {
          const current = await this.deletionSnapshot(scope, repos, old.target, old.targetId);
          if (current.fingerprint !== old.fingerprint) return { ...base, phase: 'STALE', scope: null, result: null };
          return { ...base, phase: 'PREPARED', scope: current.scope, result: null };
        } catch (error) {
          if (isRondoError(error) && error.code === 'INVALID_OPERATION') return { ...base, phase: 'STALE', scope: null, result: null };
          throw error;
        }
      }
      case 'guardian.exportStatus': {
        if (ctx.role !== 'GUARDIAN') {
          throw rondoError('FORBIDDEN', 'guardian.exportStatus 需要监护人角色。');
        }
        const op = await repos.dataOperation.findById(scope, request.exportId);
        if (op === null) {
          throw rondoError('INVALID_OPERATION', `未知的操作：${request.exportId}`);
        }
        return { kind: 'guardian.exportStatus', exportId: op.opId, phase: op.phase, scopeHash: op.scopeHash };
      }
      case 'code.availability': {
        const attempt=await repos.learningAttempt.findById(scope,request.attemptId);
        if(!attempt||ctx.role==='LEARNER'&&attempt.learnerId!==ctx.learnerId)throw rondoError('FORBIDDEN','当前编程任务不可见。');
        const cycle=await this.currentCycle(scope,repos,attempt);
        const instance=await repos.questionInstance.findById(scope,cycle.questionInstanceId);
        const rule=instance?this.content().getRuleBody(instance.releaseId,instance.taskId):null;
        return {kind:'code.availability',attemptId:attempt.attemptId,questionInstanceId:cycle.questionInstanceId,availability:this.codeAvailability(rule)};
      }
      case 'code.runStatus': {
        const learners=ctx.role==='LEARNER' ? [ctx.learnerId!] : (await repos.learner.listByFamily(scope,ctx.familyId)).map(x=>x.learnerId);
        for(const learnerId of learners)for(const attempt of await repos.learningAttempt.listByLearner(scope,learnerId)){
          const stored=(await this.codeRecords(scope,repos,attempt.attemptId)).find(x=>x.run.jobId===request.jobId);
          if(stored){
            const run=this.publicCode(stored);
            const status=run.terminal?(run.status==='CANCELLED'?'CANCELLED':run.status==='UNKNOWN'?'UNKNOWN':'FINISHED'):
              ['QUEUED','COMPILING','RUNNING','CANCEL_REQUESTED'].includes(run.status)?run.status:'RUNNING';
            const rule=this.content().getRuleBody(attempt.releaseId,run.taskId);
            return {kind:'code.runStatus',jobId:request.jobId,status:status as import('../contracts/public/queries').CodeJobStatus,run,availability:this.codeAvailability(rule)};
          }
        }
        throw rondoError('FORBIDDEN','作业不可见。');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Retention preview (shared by setRetention and guardian.retentionPreview)
// ---------------------------------------------------------------------------

export interface RetentionPreview {
  readonly affectedAttemptIds: string[];
  readonly affectedAttempts: Array<{ attemptId: string; learnerAlias: string; releaseId: string;
    status: LearningAttemptRecord['attemptStatus']; startedAt: number; lastActivityAt: number }>;
  readonly affectedCount: number;
  readonly warnings: string[];
  readonly checkedAt: number;
  readonly cutoffAt: number | null;
  readonly previewVersion: string;
}

export async function computeRetentionPreview(
  scope: RepoScope, repos: Repositories, mode: 'UNTIL_GUARDIAN_DELETES' | 'ROLLING_DAYS',
  rollingDays: number | undefined, now: number,
): Promise<RetentionPreview> {
  if (mode === 'ROLLING_DAYS' ? !Number.isInteger(rollingDays) || rollingDays! < 1 || rollingDays! > 3650 : rollingDays !== undefined) {
    throw rondoError('INVALID_OPERATION', '请明确选择有效的保留天数。');
  }
  const policy = await repos.retentionPolicy.find(scope, scope.familyId);
  const cutoff = mode === 'ROLLING_DAYS' ? now - rollingDays! * 24 * 60 * 60 * 1000 : null;
  const affected: RetentionPreview['affectedAttempts'] = [];
  let activeCount = 0;
  if (cutoff !== null) {
    for (const learner of await repos.learner.listByFamily(scope, scope.familyId)) {
      for (const attempt of await repos.learningAttempt.listByLearner(scope, learner.learnerId)) {
        if (attempt.attemptStatus === 'ACTIVE' || attempt.attemptStatus === 'PAUSED') { activeCount++; continue; }
        const events = await repos.learningEvent.pageBySeq(scope, { attemptId: attempt.attemptId, afterSeq: 0, limit: 1000000 });
        const lastActivity = Math.max(attempt.startedAt, attempt.endedAt ?? 0, ...events.map((e) => e.occurredAt));
        if (lastActivity < cutoff) affected.push({ attemptId: attempt.attemptId, learnerAlias: learner.alias,
          releaseId: attempt.releaseId, status: attempt.attemptStatus, startedAt: attempt.startedAt, lastActivityAt: lastActivity });
      }
    }
  }
  affected.sort((a, b) => a.attemptId.localeCompare(b.attemptId));
  const ids = affected.map((a) => a.attemptId);
  return { affectedAttemptIds: ids, affectedAttempts: affected, affectedCount: affected.length, checkedAt: now, cutoffAt: cutoff,
    warnings: activeCount ? ['进行中和暂停的学习尝试不会被滚动清理。'] : [],
    previewVersion: computeRetentionPreviewVersion(scope.familyId, mode, rollingDays, ids, { affectedAttempts: affected, previousPolicy: policy }),
  };
}

/** Server-issued confirmation binds the reviewed facts and preceding policy, not a moving cutoff clock. */
export function computeRetentionPreviewVersion(
  familyId: string, mode: 'UNTIL_GUARDIAN_DELETES' | 'ROLLING_DAYS', rollingDays: number | undefined,
  affectedAttemptIds: readonly string[], reviewedContext: unknown = null,
): string {
  return sha256Hex(canonicalize({ familyId, mode, rollingDays: rollingDays ?? null,
    affectedAttemptIds: [...affectedAttemptIds], reviewedContext }));
}
