/**
 * MOCK_ONLY in-memory domain store implementing the LIFECYCLE-DATA-API
 * semantics (phases, CAS versioning, receipts/idempotency, events, retention,
 * delayed-transfer state machine) as the dev-side stand-in for A's Host + B's
 * learning server. Not in the product build graph.
 */
import type {
  AuthSession,
} from '../contracts/public/auth';
import type { PublicCommandEnvelope, CommandPayload } from '../contracts/public/envelope';
import type { CommandReceipt } from '../contracts/public/receipts';
import type { PublicProjection, PublicQuery } from '../contracts/public/queries';
import type { RondoError } from '../contracts/public/errors';
import type { CylinderStateV1, CylinderStateV2, CylinderOperationV1, CylinderOperationV2 } from '../contracts/public/scene';
import type { GridBoardStateV1 } from '../contracts/public/scene-gridboard';
import { applyGridOperation, type GridOperationV1 } from '../contracts/public/scene-gridboard';
import type { StepProgramStateV1, StepOperationV1, StepSpecV1 } from '../contracts/public/scene-steps';
import { computePayloadHash } from '../contracts/public/canonical';
import {
  ANSWER_HINTS,
  getFrozenInstance,
  getTask,
  hasTask,
  LESSONS,
  lessonByRelease,
  lessonByTask,
  rendererContractVersionOf,
  visibilityForPhase,
  type PublicTask,
} from './contentLoader';
import {
  getThemesAnswerHint,
  getThemesFrozenInstance,
  getThemesRuleEntry,
  getThemesTask,
  hasThemesTask,
  THEMES_LESSONS,
  type ThemesPublicTask,
} from './contentLoaderThemes';
import {
  getCppAnswerHint,
  getCppEnabledSegments,
  getCppTask,
  hasCppTask,
  CPP_LESSONS,
  type CppPublicTask,
} from './contentLoaderCpp';
import { traceLength, validateStepEdit } from '../scenes/steps/engine';
import { evaluateResponse, type CycleActivity, type EvaluationResult } from './evaluator';

export function mockError(code: RondoError['code'], message: string, context?: Record<string, string | number | boolean | null>): RondoError {
  return context === undefined ? { code, message } : { code, message, context };
}

/** Simulates "committed but the receipt never reached the UI" once. */
export class MockDeliveryLostError extends Error {
  constructor(public readonly commandId: string) {
    super(`MOCK: delivery of command ${commandId} lost after commit`);
  }
}

/** rondo.cylinder@1/@2, rondo.gridboard@1 or rondo.steps@1 scene state (family union). */
type AnySceneState = CylinderStateV1 | CylinderStateV2 | GridBoardStateV1 | StepProgramStateV1;

/** Any-task view across every content family (public fields only). */
export type AnyPublicTask = PublicTask | ThemesPublicTask | CppPublicTask;

const ALL_LESSONS = [...LESSONS, ...THEMES_LESSONS, ...CPP_LESSONS];

export interface MockCycle {
  cycleId: string;
  attemptId: string;
  questionInstanceId: string;
  taskId: string;
  phase: 'PREDICT' | 'OPERATE' | 'VERIFY' | 'EXPLAIN' | 'REVIEW';
  prediction: { claims: Array<{ propertyId: string; direction: string }>; uncertain: boolean; explanation?: string; atMs: number } | null;
  sceneState: AnySceneState;
  initialState: AnySceneState;
  scriptApplied: boolean;
  submissions: Array<{ submissionId: string; seq: number; response: unknown; verdict: 'CORRECT' | 'REVISE'; atMs: number }>;
  explanation: { selections: unknown; freeText: string; transcribedByGuardian: boolean; atMs: number } | null;
  hints: Array<{ level: number; text: string; marksAnswerAssistance: boolean; atMs: number }>;
  assistance: Array<{ category: string; note: string; atMs: number }>;
  /** 微课诊断判定（服务端事实）：首次提交全对且未用答案级提示 → PASS，否则 SUPPLEMENT。 */
  diagnosis?: { outcome: 'PASS' | 'SUPPLEMENT'; supplementTaskId: string; atMs: number };
}

export interface MockAttempt {
  attemptId: string;
  learnerId: string;
  familyId: string;
  releaseId: string;
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ABANDONED' | 'CONTENT_BLOCKED';
  version: number;
  cycles: string[];
  currentCycleId: string | null;
  startedAtMs: number;
  finishedAtMs?: number | null;
}

interface MockEvent {
  eventId: string;
  attemptId: string;
  seq: number;
  eventType: string;
  commandKind: string;
  occurredAtMs: number;
  payload?: Record<string, unknown>;
}

interface MockFamily {
  familyId: string;
  displayName: string;
  guardianActorId: string;
  guardianName: string;
  passphrase: string; // MOCK_ONLY: real Host uses scrypt+salt, never stores raw
  retention: { mode: 'UNTIL_GUARDIAN_DELETES' | 'ROLLING_DAYS'; rollingDays?: number; previewVersion: string };
  learners: Array<{ learnerId: string; actorId: string; alias: string; goal?: string }>;
}

export interface MockMigration {
  state: 'PLANNED' | 'AVAILABLE' | 'STARTED' | 'OBSERVED' | 'DEFERRED' | 'CANCELLED';
  learnerId: string;
  sourceAttemptId: string;
  taskId: string;
  plannedAtMs: number;
  availableAtMs: number;
  nominalEndMs: number;
  startedAtMs?: number;
  observedAtMs?: number;
  actualIntervalDays?: number;
  attemptId?: string;
}

export interface MockStoreOptions {
  now?: () => number;
  /** drop the receipt of the NEXT applied command once (delivery-unknown test) */
  dropReceiptOnce?: boolean;
  /** drop the receipt of the next applied command matching one of these kinds (once per option) */
  dropReceiptKindsOnce?: string[];
}

export class MockStore {
  private family: MockFamily | null = null;
  get hasFamily(): boolean {
    return this.family !== null;
  }
  private session: AuthSession | null = null;
  private attempts = new Map<string, MockAttempt>();
  private cycles = new Map<string, MockCycle>();
  private events: MockEvent[] = [];
  private receipts = new Map<string, { hash: string; receipt: CommandReceipt }>();
  private evaluations = new Map<string, EvaluationResult>();
  private migrations = new Map<string, MockMigration>();
  private exports = new Map<string, { phase: string; scopeHash: string; categories: string[] }>();
  private explanations = new Map<string, { cycleId: string; text: string; atMs: number; revision: number }>();
  private counter = 0;
  private seqByAttempt = new Map<string, number>();
  private now: () => number;
  private dropReceiptOnce = false;
  private dropReceiptKindsOnce: string[];

  constructor(opts: MockStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.dropReceiptOnce = opts.dropReceiptOnce ?? false;
    this.dropReceiptKindsOnce = opts.dropReceiptKindsOnce ? [...opts.dropReceiptKindsOnce] : [];
  }

  // ----- content family union (cylinder + themes + cpp) -----
  private taskFor(taskId: string): AnyPublicTask {
    if (hasThemesTask(taskId)) return getThemesTask(taskId);
    if (hasCppTask(taskId)) return getCppTask(taskId);
    return getTask(taskId);
  }

  private hasAnyTask(taskId: string): boolean {
    return hasTask(taskId) || hasThemesTask(taskId) || hasCppTask(taskId);
  }

  private lessonByReleaseAny(releaseId: string): (typeof ALL_LESSONS)[number] {
    const l = ALL_LESSONS.find((x) => x.releaseId === releaseId);
    if (!l) throw mockError('INVALID_OPERATION', `MOCK content: unknown release ${releaseId}`);
    return l;
  }

  private lessonByTaskAny(taskId: string): (typeof ALL_LESSONS)[number] {
    const l = ALL_LESSONS.find((x) => x.taskOrder.includes(taskId) || x.delayedTransferTaskId === taskId);
    if (!l) throw mockError('INVALID_OPERATION', `MOCK content: no lesson for task ${taskId}`);
    return l;
  }

  // ----- identity -----
  get currentSession(): AuthSession | null {
    return this.session;
  }

  nowMs(): number {
    return this.now();
  }

  newId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${String(this.counter).padStart(6, '0')}`;
  }

  setupGuardian(input: {
    idempotencyKey: string;
    familyDisplayName: string;
    guardianDisplayName: string;
    passphrase: string;
  }): AuthSession {
    const existing = this.receipts.get(`setup|setup|${input.idempotencyKey}`);
    if (existing) {
      if (!this.family) throw mockError('PERSISTENCE_FAILED', 'MOCK: receipt without family');
      return this.guardianSession();
    }
    if (this.family) {
      throw mockError('INVALID_OPERATION', '本机数据根已初始化，不能重复设置家庭。');
    }
    const familyId = this.newId('fam');
    const actorId = this.newId('actor');
    this.family = {
      familyId,
      displayName: input.familyDisplayName,
      guardianActorId: actorId,
      guardianName: input.guardianDisplayName,
      passphrase: input.passphrase,
      retention: { mode: 'UNTIL_GUARDIAN_DELETES', previewVersion: this.newId('pv') },
      learners: [],
    };
    this.receipts.set(`setup|setup|${input.idempotencyKey}`, {
      hash: 'setup',
      receipt: {
        protocolVersion: 'rondo.v1',
        commandId: this.newId('cmd'),
        idempotencyKey: input.idempotencyKey,
        kind: 'family.createLearner',
        status: 'APPLIED',
        changedKinds: ['FAMILY'],
        effectRefs: [`learner:${actorId}`],
      },
    });
    return this.guardianSession();
  }

  private guardianSession(): AuthSession {
    if (!this.family) throw mockError('UNAUTHENTICATED', '尚未初始化家庭。');
    this.session = {
      role: 'GUARDIAN',
      actorId: this.family.guardianActorId,
      familyId: this.family.familyId,
      displayName: this.family.guardianName,
      expiresAtMs: this.now() + 30 * 60_000,
    };
    return this.session;
  }

  unlockGuardian(passphrase: string): AuthSession {
    if (!this.family) throw mockError('UNAUTHENTICATED', '本机未初始化。');
    if (passphrase !== this.family.passphrase) {
      throw mockError('UNAUTHENTICATED', '监护口令不正确。');
    }
    return this.guardianSession();
  }

  enterLearner(learnerId: string): AuthSession {
    if (!this.family) throw mockError('UNAUTHENTICATED', '本机未初始化。');
    if (!this.session || this.session.role !== 'GUARDIAN') {
      throw mockError('FORBIDDEN', '需要监护会话才能切换学习者。');
    }
    const learner = this.family.learners.find((l) => l.learnerId === learnerId);
    if (!learner) throw mockError('FORBIDDEN', '该学习者不属于本家庭。');
    this.session = {
      role: 'LEARNER',
      actorId: learner.actorId,
      familyId: this.family.familyId,
      displayName: learner.alias,
      learnerId,
      expiresAtMs: this.now() + 45 * 60_000,
    };
    return this.session;
  }

  lock(): { locked: true } {
    this.session = null;
    return { locked: true };
  }

  createLearner(alias: string, goal?: string): string {
    this.requireGuardian();
    const learnerId = this.newId('learner');
    const actorId = this.newId('actor');
    this.family!.learners.push({ learnerId, actorId, alias, goal });
    return learnerId;
  }

  listLearners(): Array<{ learnerId: string; alias: string }> {
    return this.family ? this.family.learners.map((l) => ({ learnerId: l.learnerId, alias: l.alias })) : [];
  }

  private requireGuardian(): MockFamily {
    if (!this.session || this.session.role !== 'GUARDIAN' || !this.family) {
      throw mockError('UNAUTHENTICATED', '需要监护会话。');
    }
    return this.family;
  }

  private requireLearner(target?: { scope: 'FAMILY' } | { scope: 'LEARNER'; learnerId: string }): { family: MockFamily; learnerId: string } {
    if (!this.session || this.session.role !== 'LEARNER' || !this.family || !this.session.learnerId) {
      throw mockError('UNAUTHENTICATED', '需要学习者会话。');
    }
    if (target && target.scope === 'LEARNER' && target.learnerId !== this.session.learnerId) {
      throw mockError('FORBIDDEN', '只能操作自己的学习任务。');
    }
    return { family: this.family, learnerId: this.session.learnerId };
  }

  // ----- command plumbing -----
  async handleCommand(envelope: PublicCommandEnvelope): Promise<CommandReceipt> {
    const session = this.session;
    if (!session) throw mockError('UNAUTHENTICATED', '没有活动会话。');
    const key = `${session.familyId}|${session.actorId}|${envelope.idempotencyKey}`;
    const hash = await computePayloadHash({
      protocolVersion: envelope.protocolVersion,
      kind: envelope.kind,
      payload: envelope.payload,
      target: envelope.target,
      binding: envelope.binding ?? null,
      expectedAttemptVersion: envelope.expectedAttemptVersion ?? undefined,
    });
    const prior = this.receipts.get(key);
    if (prior) {
      if (prior.hash !== hash) throw mockError('IDEMPOTENCY_CONFLICT', '同一幂等键的命令内容不同。');
      return prior.receipt;
    }
    const receipt = this.dispatch(envelope);
    this.receipts.set(key, { hash, receipt });
    if (this.dropReceiptOnce) {
      this.dropReceiptOnce = false;
      throw new MockDeliveryLostError(envelope.commandId);
    }
    const kindIdx = this.dropReceiptKindsOnce.indexOf(envelope.kind);
    if (kindIdx >= 0) {
      this.dropReceiptKindsOnce.splice(kindIdx, 1);
      throw new MockDeliveryLostError(envelope.commandId);
    }
    return receipt;
  }

  lookupReceipt(actorId: string, idempotencyKey: string, commandKind: string): { status: 'CONFIRMED'; receipt: CommandReceipt } | { status: 'NOT_FOUND' } {
    if (!this.session) throw mockError('UNAUTHENTICATED', '没有活动会话。');
    const key = `${this.session.familyId}|${actorId}|${idempotencyKey}`;
    const hit = this.receipts.get(key);
    if (hit && hit.receipt.kind === commandKind) return { status: 'CONFIRMED' as const, receipt: hit.receipt };
    return { status: 'NOT_FOUND' };
  }

  private dispatch(env: PublicCommandEnvelope): CommandReceipt {
    const base = {
      protocolVersion: 'rondo.v1' as const,
      commandId: env.commandId,
      idempotencyKey: env.idempotencyKey,
      kind: env.kind,
    };
    const applied = (changedKinds: string[], effectRefs: string[], attemptVersion?: number): CommandReceipt => ({
      ...base,
      status: 'APPLIED',
      changedKinds,
      effectRefs,
      ...(attemptVersion !== undefined ? { attemptVersion } : {}),
    });
    const rejected = (errorCode: RondoError['code']): CommandReceipt => ({
      ...base,
      status: 'REJECTED',
      errorCode,
      changedKinds: [],
      effectRefs: [],
    });

    const payload = env.payload as Record<string, unknown>;

    switch (env.kind) {
      case 'family.createLearner': {
        this.requireGuardian();
        const learnerId = this.createLearner(String(payload.alias), payload.goal ? String(payload.goal) : undefined);
        return applied(['LEARNER'], [`learner:${learnerId}`]);
      }
      case 'family.setRetention': {
        const fam = this.requireGuardian();
        const mode = payload.mode as 'UNTIL_GUARDIAN_DELETES' | 'ROLLING_DAYS';
        if (String(payload.confirmedPreviewVersion) !== fam.retention.previewVersion) {
          throw mockError('VERSION_CONFLICT', '保留政策预览已更新，请重新预览确认。', {
            currentVisibleVersion: 1,
            recoveryHint: '重新执行 guardian.retentionPreview 后再确认。',
          });
        }
        fam.retention = { mode, rollingDays: payload.rollingDays as number | undefined, previewVersion: this.newId('pv') };
        return applied(['RETENTION'], [`disposal:${this.newId('ret')}`]);
      }
      case 'learning.startAttempt': {
        const { learnerId } = this.requireLearner(env.target);
        const releaseId = String(payload.releaseId);
        const lesson = this.lessonByReleaseAny(releaseId);
        for (const att of this.attempts.values()) {
          if (att.learnerId === learnerId && att.releaseId === releaseId && (att.status === 'ACTIVE' || att.status === 'PAUSED')) {
            // course-graph resume: a not-yet-started attempt for this release
            // re-points to the delayed-transfer task when its window opens
            const mig0 = this.migrations.get(learnerId);
            const inWindow =
              lesson.delayedTransferTaskId !== undefined &&
              mig0 !== undefined &&
              mig0.taskId === lesson.delayedTransferTaskId &&
              (mig0.state === 'PLANNED' || mig0.state === 'DEFERRED') &&
              this.now() >= mig0.availableAtMs;
            const cur = att.currentCycleId ? this.cycles.get(att.currentCycleId) : undefined;
            if (inWindow && cur && cur.phase === 'PREDICT' && cur.taskId === lesson.taskOrder[0]) {
              this.openCycle(att, lesson.delayedTransferTaskId!);
              mig0!.state = 'STARTED';
              mig0!.startedAtMs = this.now();
              mig0!.attemptId = att.attemptId;
              this.recordEvent(att, 'MIGRATION_STARTED', env.kind, { taskId: lesson.delayedTransferTaskId });
              return applied(['ATTEMPT', 'CYCLE'], [`attempt:${att.attemptId}`, `cycle:${att.currentCycleId}`], att.version);
            }
            return applied(['ATTEMPT'], [`attempt:${att.attemptId}`], att.version);
          }
        }
        const attemptId = this.newId('att');
        const attempt: MockAttempt = {
          attemptId,
          learnerId,
          familyId: this.family!.familyId,
          releaseId,
          status: 'ACTIVE',
          version: 1,
          cycles: [],
          currentCycleId: null,
          startedAtMs: this.now(),
        };
        this.attempts.set(attemptId, attempt);
        // course-graph behavior: when a delayed-transfer review is in its
        // window for this learner, a new attempt for the release opens
        // directly at the migration target task
        const mig = this.migrations.get(learnerId);
        const delayedFirst =
          lesson.delayedTransferTaskId !== undefined &&
          mig !== undefined &&
          mig.taskId === lesson.delayedTransferTaskId &&
          (mig.state === 'PLANNED' || mig.state === 'DEFERRED') &&
          this.now() >= mig.availableAtMs;
        this.openCycle(attempt, delayedFirst ? lesson.delayedTransferTaskId! : lesson.taskOrder[0]);
        if (delayedFirst && mig) {
          mig.state = 'STARTED';
          mig.startedAtMs = this.now();
          mig.attemptId = attemptId;
          this.recordEvent(attempt, 'MIGRATION_STARTED', env.kind, { taskId: lesson.delayedTransferTaskId });
        }
        return applied(['ATTEMPT', 'CYCLE'], [`attempt:${attemptId}`, `cycle:${attempt.currentCycleId}`], 1);
      }
      case 'learning.beginCycle': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        this.casVersion(env, attempt);
        const cycle = this.currentCycle(attempt);
        if (cycle.phase !== 'REVIEW') {
          throw mockError('INVALID_OPERATION', '当前任务尚未完成回看，不能开始下一题。');
        }
        const taskId = String(payload.taskId);
        const lesson = this.lessonByTaskAny(taskId);
        const delayedId = lesson.delayedTransferTaskId;
        if (delayedId && taskId === delayedId) {
          const mig = this.migrations.get(attempt.learnerId);
          if (!mig || mig.taskId !== taskId) {
            throw mockError('INVALID_OPERATION', '回看练习尚未安排。');
          }
          if (mig.state === 'CANCELLED' || mig.state === 'OBSERVED') {
            throw mockError('INVALID_OPERATION', '该回看练习已结束或已取消。');
          }
          if (this.now() < mig.availableAtMs) {
            throw mockError('INVALID_OPERATION', '回看练习还没到开始窗口。');
          }
        } else {
          const order = lesson.taskOrder;
          const idx = order.indexOf(cycle.taskId);
          if (idx === -1 || idx + 1 >= order.length || order[idx + 1] !== taskId) {
            throw mockError('INVALID_OPERATION', '下一题必须按课程顺序开始。');
          }
        }
        this.openCycle(attempt, taskId);
        const mig = this.migrations.get(attempt.learnerId);
        if (mig && mig.taskId === taskId && (mig.state === 'PLANNED' || mig.state === 'AVAILABLE' || mig.state === 'DEFERRED')) {
          mig.state = 'STARTED';
          mig.startedAtMs = this.now();
          mig.attemptId = attempt.attemptId;
          this.recordEvent(attempt, 'MIGRATION_STARTED', env.kind, { taskId });
        }
        return applied(['CYCLE'], [`cycle:${attempt.currentCycleId}`], attempt.version);
      }
      case 'learning.recordPrediction': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        const cycle = this.currentCycle(attempt);
        if (cycle.phase !== 'PREDICT') throw mockError('INVALID_OPERATION', '当前阶段不能提交预测。');
        if (cycle.prediction) throw mockError('INVALID_OPERATION', '首次预测已保存，不能覆盖。');
        const claims = ((payload.prediction as { claims?: Array<{ propertyId: string; direction: string }> })?.claims ?? []) as Array<{ propertyId: string; direction: string }>;
        const uncertain = Boolean(payload.uncertain);
        if (!uncertain && claims.length === 0) {
          throw mockError('INVALID_OPERATION', '预测内容为空：请给出判断或明确选「不确定」。');
        }
        cycle.prediction = {
          claims,
          uncertain,
          explanation: payload.explanation ? String(payload.explanation) : undefined,
          atMs: this.now(),
        };
        this.recordEvent(attempt, 'PREDICTION_RECORDED', env.kind, {
          claims,
          uncertain,
          explanation: payload.explanation ?? null,
        });
        // content-script staged change (A-21 mechanism; C report dependency)
        const instance = getFrozenInstance(cycle.taskId);
        if (instance?.script && !cycle.scriptApplied) {
          const s = instance.script;
          cycle.sceneState =
            s.dimension === 'RADIUS'
              ? { ...cycle.sceneState, radiusMm: s.toMm }
              : { ...cycle.sceneState, heightMm: s.toMm };
          cycle.scriptApplied = true;
          this.recordEvent(attempt, 'SCRIPT_CHANGE_APPLIED', 'learning.commitOperation', {
            source: 'content-script',
            dimension: s.dimension,
            fromMm: s.fromMm,
            toMm: s.toMm,
          });
        }
        cycle.phase = 'OPERATE';
        attempt.version += 1;
        return applied(['CYCLE', 'EVENT'], [`cycle:${cycle.cycleId}`, `event:${this.lastEventId()}`], attempt.version);
      }
      case 'learning.commitOperation': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        const cycle = this.currentCycle(attempt);
        if (cycle.phase !== 'OPERATE' && !(cycle.phase === 'VERIFY' && this.latestVerdict(cycle) === 'REVISE')) {
          throw mockError('INVALID_OPERATION', '当前阶段不能执行该操作。');
        }
        this.casVersion(env, attempt);
        const op = (payload as { operation: CylinderOperationV1 | CylinderOperationV2 | GridOperationV1 | StepOperationV1 }).operation;
        this.checkOperationAllowed(cycle.taskId, op, cycle.sceneState);
        const before = cloneState(cycle.sceneState);
        cycle.sceneState = overlayState(cycle.taskId, cycle.sceneState, op);
        cycle.phase = 'OPERATE';
        attempt.version += 1;
        this.recordEvent(attempt, 'OPERATION_CONFIRMED', env.kind, { before, after: cloneState(cycle.sceneState), operation: op });
        return applied(['SCENE_STATE', 'EVENT'], [`event:${this.lastEventId()}`], attempt.version);
      }
      case 'learning.reviseResponse': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        const cycle = this.currentCycle(attempt);
        if (cycle.phase !== 'VERIFY' || this.latestVerdict(cycle) !== 'REVISE') {
          throw mockError('INVALID_OPERATION', '只有核对结果为「再试一次」时才能修改答案。');
        }
        this.casVersion(env, attempt);
        cycle.phase = 'OPERATE';
        attempt.version += 1;
        this.recordEvent(attempt, 'REVISE_ENTERED', env.kind, {});
        return applied(['CYCLE'], [`cycle:${cycle.cycleId}`], attempt.version);
      }
      case 'learning.submitResponse': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        const cycle = this.currentCycle(attempt);
        if (cycle.phase !== 'OPERATE') throw mockError('INVALID_OPERATION', '当前阶段不能提交作答。');
        this.casVersion(env, attempt);
        const response = (payload as { response: unknown[] }).response;
        if (!Array.isArray(response) || response.length === 0) {
          throw mockError('INVALID_OPERATION', '作答内容为空。');
        }
        const result = evaluateResponse(cycle.taskId, response as never, cycle.sceneState, this.cycleActivity(attempt, cycle));
        // 答案级提示标志先行合并，诊断判定要看到它（h4 后不判具备）。
        if (cycle.hints.some((h) => h.marksAnswerAssistance)) result.answerAssistanceActive = true;
        // 微课诊断判定：服务端事实（判分结果 + 首次提交 + 是否用过答案级提示），
        // 记入学习事实（事件），不做前端判分。首次提交 = 当前列表为空（push 在判定之后）。
        if (cycle.diagnosis === undefined && hasThemesTask(cycle.taskId)) {
          const { entry } = getThemesRuleEntry(cycle.taskId);
          if (entry.diagnosis !== undefined) {
            const outcome: 'PASS' | 'SUPPLEMENT' =
              result.verdict === 'CORRECT' && cycle.submissions.length === 0 && !result.answerAssistanceActive ? 'PASS' : 'SUPPLEMENT';
            cycle.diagnosis = { outcome, supplementTaskId: entry.diagnosis.supplementTaskId, atMs: this.now() };
            this.recordEvent(attempt, 'MICRO_DIAGNOSIS_DECIDED', env.kind, {
              taskId: cycle.taskId,
              outcome,
              supplementTaskId: entry.diagnosis.supplementTaskId,
              firstSubmissionVerdict: result.verdict,
              answerAssistanceUsed: result.answerAssistanceActive,
            });
          }
        }
        const submissionId = this.newId('sub');
        const evaluationId = this.newId('evl');
        this.evaluations.set(submissionId, result);
        cycle.submissions.push({
          submissionId,
          seq: cycle.submissions.length + 1,
          response,
          verdict: result.verdict,
          atMs: this.now(),
        });
        cycle.phase = 'VERIFY';
        attempt.version += 1;
        this.recordEvent(attempt, 'SUBMISSION_EVALUATED', env.kind, {
          submissionId,
          evaluationId,
          verdict: result.verdict,
          itemResults: result.itemResults.map((r) => ({ key: r.key, verdict: r.verdict })),
          response,
          snapshot: cloneState(cycle.sceneState),
        });
        return applied(
          ['SUBMISSION', 'EVALUATION', 'CYCLE', 'EVENT'],
          [`submission:${submissionId}`, `evaluation:${evaluationId}`, `event:${this.lastEventId()}`],
          attempt.version,
        );
      }
      case 'learning.requestHint': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        const cycle = this.currentCycle(attempt);
        const level = payload.hintLevel as number;
        const task = this.taskFor(cycle.taskId);
        if (level === 4) {
          const text = this.answerHintText(cycle.taskId, cycle.sceneState);
          cycle.hints.push({ level: 4, text, marksAnswerAssistance: true, atMs: this.now() });
        } else {
          const hintsOfTask = task.hints as Array<{ level: number; label: string; text?: string }>;
          const hint = hintsOfTask.find((h) => h.level === level);
          if (!hint?.text) throw mockError('INVALID_OPERATION', '该提示层级未登记。');
          // replay of the same level does not double count (idempotency above
          // catches identical envelopes; a NEW key asking the same level is a
          // new request and counts — mirroring the contract's "再次索取新提示使用新命令")
          cycle.hints.push({ level, text: hint.text, marksAnswerAssistance: false, atMs: this.now() });
        }
        this.recordEvent(attempt, 'HINT_SHOWN', env.kind, { level });
        return applied(['HINT', 'EVENT'], [`hint:${this.newId('hnt')}`, `event:${this.lastEventId()}`], attempt.version);
      }
      case 'learning.beginExplanation': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        const cycle = this.currentCycle(attempt);
        if (cycle.phase !== 'VERIFY') throw mockError('INVALID_OPERATION', '核对阶段之后才能解释。');
        if (cycle.submissions.length === 0) throw mockError('INVALID_OPERATION', '至少需要一次有效提交。');
        this.casVersion(env, attempt);
        cycle.phase = 'EXPLAIN';
        attempt.version += 1;
        this.recordEvent(attempt, 'EXPLAIN_ENTERED', env.kind, {});
        return applied(['CYCLE'], [`cycle:${cycle.cycleId}`], attempt.version);
      }
      case 'learning.saveExplanation': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        const cycle = this.currentCycle(attempt);
        if (cycle.phase !== 'EXPLAIN' && cycle.phase !== 'REVIEW') {
          throw mockError('INVALID_OPERATION', '当前阶段不能保存解释。');
        }
        this.casVersion(env, attempt);
        const freeText = String(payload.freeText ?? '');
        if (freeText.trim().length === 0) throw mockError('INVALID_OPERATION', '请写下你的解释（不能为空）。');
        cycle.explanation = {
          selections: payload.selections,
          freeText,
          transcribedByGuardian: Boolean(payload.transcribedByGuardian),
          atMs: this.now(),
        };
        cycle.phase = 'REVIEW';
        attempt.version += 1;
        this.recordEvent(attempt, 'EXPLANATION_SAVED', env.kind, {
          transcribedByGuardian: Boolean(payload.transcribedByGuardian),
          freeTextLength: freeText.length,
        });
        this.checkMigrationObserved(attempt, cycle);
        return applied(['EXPLANATION', 'CYCLE', 'EVENT'], [`explanation:${this.newId('exp')}`, `event:${this.lastEventId()}`], attempt.version);
      }
      case 'learning.finishAttempt': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        this.casVersion(env, attempt);
        for (const cid of attempt.cycles) {
          const c = this.cycles.get(cid)!;
          if (c.phase !== 'REVIEW') {
            throw mockError('INVALID_OPERATION', '还有任务未完成（需要提交与解释），不能结束本次学习。');
          }
        }
        attempt.status = 'COMPLETED';
        attempt.finishedAtMs = this.now();
        attempt.version += 1;
        this.recordEvent(attempt, 'ATTEMPT_FINISHED', env.kind, {});
        const lesson = this.lessonByReleaseAny(attempt.releaseId);
        if (lesson.delayedTransferTaskId && !this.migrations.has(attempt.learnerId)) {
          const availableAtMs = attempt.finishedAtMs + lesson.delayedTransferWindowDays!.availableAfterDays * 86_400_000;
          this.migrations.set(attempt.learnerId, {
            state: 'PLANNED',
            learnerId: attempt.learnerId,
            sourceAttemptId: attempt.attemptId,
            taskId: lesson.delayedTransferTaskId,
            plannedAtMs: attempt.finishedAtMs,
            availableAtMs,
            nominalEndMs: attempt.finishedAtMs + lesson.delayedTransferWindowDays!.nominalEndDays * 86_400_000,
          });
          this.recordEvent(attempt, 'MIGRATION_PLANNED', env.kind, { availableAtMs });
        }
        return applied(['ATTEMPT_STATUS', 'MIGRATION'], [`attempt:${attempt.attemptId}`, `event:${this.lastEventId()}`], attempt.version);
      }
      case 'learning.pauseAttempt': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        this.casVersion(env, attempt);
        if (attempt.status !== 'ACTIVE') throw mockError('INVALID_OPERATION', '只有进行中的尝试能暂停。');
        attempt.status = 'PAUSED';
        attempt.version += 1;
        return applied(['ATTEMPT_STATUS'], [`attempt:${attempt.attemptId}`], attempt.version);
      }
      case 'learning.resumeAttempt': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        this.casVersion(env, attempt);
        if (attempt.status !== 'PAUSED') throw mockError('INVALID_OPERATION', '只有已暂停的尝试能恢复。');
        attempt.status = 'ACTIVE';
        attempt.version += 1;
        return applied(['ATTEMPT_STATUS'], [`attempt:${attempt.attemptId}`], attempt.version);
      }
      case 'learning.endWithoutCompleting': {
        this.requireLearner(env.target);
        const attempt = this.attemptFor(env);
        if (attempt.status === 'COMPLETED' || attempt.status === 'ABANDONED') {
          throw mockError('INVALID_OPERATION', '该尝试已结束。');
        }
        attempt.status = 'ABANDONED';
        attempt.version += 1;
        this.recordEvent(attempt, 'ATTEMPT_ABANDONED', env.kind, {});
        return applied(['ATTEMPT_STATUS'], [`attempt:${attempt.attemptId}`], attempt.version);
      }
      case 'guardian.recordAssistance': {
        this.requireGuardian();
        const attempt = this.attempts.get(String(payload.attemptId));
        if (!attempt || attempt.familyId !== this.family!.familyId) {
          throw mockError('FORBIDDEN', '对象不可见。');
        }
        const cycle = this.currentCycle(attempt);
        cycle.assistance.push({ category: String(payload.category), note: String(payload.note), atMs: this.now() });
        this.recordEvent(attempt, 'ASSISTANCE_RECORDED', env.kind, {
          category: payload.category,
          note: payload.note,
          eventId: payload.eventId ?? null,
          submissionId: payload.submissionId ?? null,
        });
        return applied(['ASSISTANCE', 'EVENT'], [`event:${this.lastEventId()}`]);
      }
      case 'guardian.annotateExplanation': {
        this.requireGuardian();
        const revisionRef = String(payload.explanationRevisionRef);
        const rec = this.explanations.get(revisionRef);
        if (!rec) throw mockError('INVALID_OPERATION', '解释记录不存在。');
        const attempt = [...this.attempts.values()].find(
          (a) => a.familyId === this.family!.familyId && a.cycles.includes(rec.cycleId),
        );
        if (!attempt) throw mockError('FORBIDDEN', '对象不可见。');
        this.recordEvent(attempt, 'OBSERVATION_RECORDED', env.kind, { rubric: payload.rubric, note: payload.note ?? null });
        return applied(['OBSERVATION', 'EVENT'], [`event:${this.lastEventId()}`]);
      }
      case 'guardian.prepareExport': {
        this.requireGuardian();
        const exportId = this.newId('exp-op');
        const categories = (payload.scope as { categories: string[] }).categories;
        this.exports.set(exportId, { phase: 'PREPARED', scopeHash: this.newId('sh'), categories });
        return applied(['EXPORT'], [`export:${exportId}`]);
      }
      case 'guardian.confirmExport': {
        this.requireGuardian();
        const ref = String(payload.preparedVersion);
        const ex = this.exports.get(ref) ?? [...this.exports.entries()].find(([, v]) => v.scopeHash === ref)?.[0];
        if (!ex) throw mockError('INVALID_OPERATION', '导出预览不存在。');
        const record = this.exports.get(String(ex));
        if (record) record.phase = 'COMPLETED';
        return applied(['EXPORT'], [`export:${ex}`]);
      }
      case 'guardian.prepareDeletion': {
        this.requireGuardian();
        const scopeListHash = this.computeScopeHash(String(payload.target), payload.targetId as string | undefined);
        this.scopeListHashStore.set('last', scopeListHash);
        return applied(['DISPOSAL'], [`disposal:${this.newId('del')}`]);
      }
      case 'guardian.confirmDeletion': {
        this.requireGuardian();
        const expected = this.scopeListHashStore.get('last');
        if (!expected || String(payload.scopeListHash) !== expected) {
          throw mockError('VERSION_CONFLICT', '删除范围已变化，请重新预览。', {
            currentVisibleVersion: 1,
            recoveryHint: '重新执行 prepareDeletion 并确认新的范围清单。',
          });
        }
        // revoke sessions, drop family data, read back remaining
        this.session = null;
        this.family = null;
        this.attempts.clear();
        this.cycles.clear();
        this.events = [];
        this.evaluations.clear();
        this.migrations.clear();
        this.exports.clear();
        this.explanations.clear();
        this.scopeListHashStore.clear();
        return applied(['DISPOSAL'], [], undefined);
      }
      case 'code.requestRun':
      case 'code.requestCancel':
        return rejected('CAPABILITY_UNAVAILABLE');
      default: {
        const kind = (env as unknown as { kind?: string }).kind ?? 'unknown';
        throw mockError('INVALID_OPERATION', `MOCK: 未实现的命令 ${kind}`);
      }
    }
  }

  private scopeListHashStore = new Map<string, string>();

  private computeScopeHash(target: string, targetId?: string): string {
    const ids =
      target === 'ALL_FAMILY_DATA'
        ? ['ALL']
        : target === 'LEARNER'
          ? this.family?.learners.filter((l) => l.learnerId === targetId).map((l) => l.learnerId) ?? []
          : targetId
            ? [targetId]
            : [];
    let h = 0;
    for (const id of ids) h = (h * 31 + id.length) | 0;
    return h.toString(16).padStart(8, '0').repeat(8);
  }

  // ----- queries -----
  handleQuery(req: PublicQuery): PublicProjection {
    switch (req.kind) {
      case 'catalog.availableLessons': {
        const lessons: Array<{ releaseId: string; taskId: string; title: string }> = [];
        for (const l of ALL_LESSONS) {
          for (const taskId of l.taskOrder) {
            lessons.push({ releaseId: l.releaseId, taskId, title: this.taskFor(taskId).title });
          }
        }
        return { kind: 'catalog.availableLessons', lessons };
      }
      case 'learning.resumePoint': {
        const { learnerId } = this.requireLearner();
        const active = [...this.attempts.values()]
          .filter((a) => a.learnerId === learnerId && (a.status === 'ACTIVE' || a.status === 'PAUSED'))
          .sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
        if (!active || !active.currentCycleId) {
          return { kind: 'learning.resumePoint', learnerId, attempt: null };
        }
        const cycle = this.cycles.get(active.currentCycleId)!;
        return {
          kind: 'learning.resumePoint',
          learnerId,
          attempt: { attemptId: active.attemptId, cycleId: cycle.cycleId, phase: cycle.phase, version: active.version },
        };
      }
      case 'learning.attemptView': {
        const attempt = this.attempts.get(req.attemptId);
        if (!attempt) throw mockError('INVALID_OPERATION', '尝试不存在。');
        this.assertFamilyVisible(attempt);
        const current = attempt.currentCycleId ? this.cycles.get(attempt.currentCycleId)! : null;
        return {
          kind: 'learning.attemptView',
          attemptId: attempt.attemptId,
          learnerId: attempt.learnerId,
          releaseId: attempt.releaseId,
          questionInstanceId: current?.questionInstanceId ?? 'qi-none',
          attemptStatus: attempt.status,
          version: attempt.version,
          currentCycle: current
            ? { cycleId: current.cycleId, phase: current.phase, questionInstanceId: current.questionInstanceId }
            : null,
        };
      }
      case 'learning.questionView': {
        const attempt = this.attempts.get(req.attemptId);
        if (!attempt) throw mockError('INVALID_OPERATION', '尝试不存在。');
        this.assertFamilyVisible(attempt);
        const cycleId = req.cycleId ?? attempt.currentCycleId ?? attempt.cycles[attempt.cycles.length - 1];
        const cycle = this.cycles.get(cycleId);
        if (!cycle) throw mockError('INVALID_OPERATION', '题目不存在。');
        const task = this.taskFor(cycle.taskId);
        // family dispatch: themes micro① rides the cylinder renderer; other
        // themes tasks are gridboard; cpp tasks are steps; cylinder tasks keep
        // the L34-1 dual-version boundary (a V2 state can never be served to
        // an @1 task and vice versa).
        const isThemes = hasThemesTask(cycle.taskId);
        const isCpp = hasCppTask(cycle.taskId);
        let rendererId = 'rondo.cylinder';
        let rendererContractVersion: string = rendererContractVersionOf(cycle.taskId);
        if (isThemes) {
          rendererId = 'radiusMm' in cycle.sceneState ? 'rondo.cylinder' : 'rondo.gridboard';
          rendererContractVersion = '1';
        } else if (isCpp) {
          rendererId = 'rondo.steps';
          rendererContractVersion = '1';
        } else if (rendererContractVersion === '1' ? !isStateV1(cycle.sceneState) : !isStateV2(cycle.sceneState)) {
          throw mockError('SCHEMA_MISMATCH', '场景状态与任务绑定的渲染器合同版本不符。');
        }
        return {
          kind: 'learning.questionView',
          spec: {
            questionInstanceId: cycle.questionInstanceId,
            releaseId: attempt.releaseId,
            taskId: cycle.taskId,
            taskVersion: task.taskVersion,
            prompt: task.prompt,
            responseSchemaId: task.responseSchemaId,
            numericPolicy: 'numericPolicy' in task ? (task as PublicTask).numericPolicy : undefined,
            scene: {
              rendererId,
              rendererContractVersion,
              state: cycle.sceneState,
            },
            allowedOperationIds: task.allowedOperationIds,
            materialVisibility: visibilityForPhase(cycle.phase),
          },
        };
      }
      case 'learning.timeline': {
        const attempt = this.attempts.get(req.attemptId);
        if (!attempt) throw mockError('INVALID_OPERATION', '尝试不存在。');
        this.assertFamilyVisible(attempt);
        const all = this.events.filter((e) => e.attemptId === attempt.attemptId && e.seq > (req.afterSeq ?? 0));
        const page = all.slice(0, req.limit ?? 100);
        return {
          kind: 'learning.timeline',
          attemptId: attempt.attemptId,
          events: page.map((e) => ({
            seq: e.seq,
            eventId: e.eventId,
            eventType: e.eventType,
            commandKind: e.commandKind as never,
            occurredAtMs: e.occurredAtMs,
          })),
          ...(all.length > page.length ? { nextAfterSeq: page[page.length - 1].seq } : {}),
        };
      }
      case 'learning.receipt': {
        if (!this.session) throw mockError('UNAUTHENTICATED', '没有活动会话。');
        const result = this.lookupReceipt(this.session.actorId, req.idempotencyKey, req.commandKind);
        return { kind: 'learning.receipt', result };
      }
      case 'guardian.evidenceSummary': {
        this.requireGuardian();
        const items: Array<{ evidenceType: 'PREDICTION' | 'OBSERVATION' | 'SUBMISSION' | 'EVALUATION' | 'EXPLANATION' | 'ASSISTANCE' | 'HINT'; refId: string; atMs: number }> = [];
        for (const e of this.events) {
          const attempt = this.attempts.get(e.attemptId);
          if (!attempt || attempt.learnerId !== req.learnerId) continue;
          const map: Record<string, 'PREDICTION' | 'OBSERVATION' | 'SUBMISSION' | 'EVALUATION' | 'EXPLANATION' | 'ASSISTANCE' | 'HINT'> = {
            PREDICTION_RECORDED: 'PREDICTION',
            SUBMISSION_EVALUATED: 'EVALUATION',
            EXPLANATION_SAVED: 'EXPLANATION',
            ASSISTANCE_RECORDED: 'ASSISTANCE',
            OBSERVATION_RECORDED: 'OBSERVATION',
            HINT_SHOWN: 'HINT',
          };
          const t = map[e.eventType];
          if (t) items.push({ evidenceType: t, refId: e.eventId, atMs: e.occurredAtMs });
        }
        return { kind: 'guardian.evidenceSummary', learnerId: req.learnerId, attemptId: req.attemptId, items };
      }
      case 'guardian.retentionPreview':
      case 'guardian.retentionPolicy':
        this.requireGuardian();
        throw mockError('CAPABILITY_UNAVAILABLE', '新版保留政策流程仅产品 Host 支持。');
      case 'guardian.exportStatus': {
        this.requireGuardian();
        const ex = this.exports.get(req.exportId);
        if (!ex) throw mockError('INVALID_OPERATION', '导出记录不存在。');
        return { kind: 'guardian.exportStatus', exportId: req.exportId, phase: ex.phase as never, scopeHash: ex.scopeHash };
      }
      case 'code.runStatus':
        throw mockError('CAPABILITY_UNAVAILABLE', '此能力未启用。');
      default:
        throw mockError('INVALID_OPERATION', 'MOCK: 未知查询');
    }
  }

  // ----- view extensions (MOCK_ONLY; named gaps in the C report) -----
  getEvaluation(cycleId: string) {
    const cycle = this.cycles.get(cycleId);
    if (!cycle) throw mockError('INVALID_OPERATION', 'cycle 不存在');
    const last = cycle.submissions[cycle.submissions.length - 1];
    if (!last) return null;
    const evalRes = this.evaluations.get(last.submissionId)!;
    return { submissionId: last.submissionId, seq: last.seq, atMs: last.atMs, ...evalRes };
  }

  getHints(cycleId: string) {
    return this.cycles.get(cycleId)?.hints ?? [];
  }

  getReviewCard(cycleId: string) {
    const cycle = this.cycles.get(cycleId);
    if (!cycle) throw mockError('INVALID_OPERATION', 'cycle 不存在');
    const evalRes = cycle.submissions.length
      ? this.evaluations.get(cycle.submissions[cycle.submissions.length - 1].submissionId)!
      : null;
    return {
      taskId: cycle.taskId,
      taskTitle: this.taskFor(cycle.taskId).title,
      phase: cycle.phase,
      prediction: cycle.prediction,
      submissions: cycle.submissions.map((s) => ({
        submissionId: s.submissionId,
        seq: s.seq,
        verdict: s.verdict,
        atMs: s.atMs,
      })),
      evaluation: evalRes ? { verdict: evalRes.verdict, itemResults: evalRes.itemResults } : null,
      // answer reveal only after REVIEW reached (judging already done)
      reveal: cycle.phase === 'REVIEW' && evalRes ? evalRes.reveal : null,
      hints: cycle.hints.map((h) => ({ level: h.level, marksAnswerAssistance: h.marksAnswerAssistance })),
      assistance: cycle.assistance,
      snapshot: cycle.sceneState,
      initialState: cycle.initialState,
      // 微课诊断判定（服务端事实；无诊断块的任务为 null）
      diagnosis: cycle.diagnosis ?? null,
    };
  }

  getTimelineDetail(attemptId: string) {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw mockError('INVALID_OPERATION', '尝试不存在');
    this.assertFamilyVisible(attempt);
    return {
      attemptId,
      status: attempt.status,
      events: this.events
        .filter((e) => e.attemptId === attemptId)
        .map((e) => ({ ...e, taskTitle: safeTaskTitle(e.payload?.taskId as string | undefined) })),
    };
  }

  getMigration(learnerId: string) {
    const mig = this.migrations.get(learnerId);
    if (!mig) return null;
    const state: MockMigration['state'] =
      (mig.state === 'PLANNED' || mig.state === 'DEFERRED') && this.now() >= mig.availableAtMs
        ? 'AVAILABLE'
        : mig.state;
    const remainingMs = Math.max(0, mig.availableAtMs - this.now());
    return {
      ...mig,
      state,
      remainingDays: Math.ceil(remainingMs / 86_400_000),
      nominalEndDays: Math.ceil(Math.max(0, mig.nominalEndMs - this.now()) / 86_400_000),
      taskTitle: this.taskFor(mig.taskId).title,
    };
  }

  /** MOCK_ONLY: the scope hash of the last prepareDeletion (UI confirm path). */
  getLastDeletionScopeHash(): string | null {
    return this.scopeListHashStore.get('last') ?? null;
  }

  deferMigration(learnerId: string, days: number) {
    const mig = this.migrations.get(learnerId);
    if (!mig) throw mockError('INVALID_OPERATION', '没有回看练习安排。');
    if (mig.state === 'STARTED' || mig.state === 'OBSERVED') throw mockError('INVALID_OPERATION', '已开始，不能改期。');
    mig.availableAtMs += days * 86_400_000;
    mig.nominalEndMs += days * 86_400_000;
    if (mig.state !== 'PLANNED' && mig.state !== 'DEFERRED') {
      throw mockError('INVALID_OPERATION', '当前状态不能改期。');
    }
    mig.state = 'DEFERRED';
  }

  listAttempts(learnerId?: string) {
    return [...this.attempts.values()]
      .filter((a) => (learnerId ? a.learnerId === learnerId : true))
      .map((a) => ({ ...a }));
  }

  getCycle(cycleId: string): MockCycle | undefined {
    return this.cycles.get(cycleId);
  }

  registerExplanationRevision(cycleId: string): string {
    const cycle = this.cycles.get(cycleId);
    if (!cycle?.explanation) throw mockError('INVALID_OPERATION', '解释不存在');
    const revisionId = this.newId('exprev');
    this.explanations.set(revisionId, {
      cycleId,
      text: cycle.explanation.freeText,
      atMs: cycle.explanation.atMs,
      revision: 1,
    });
    return revisionId;
  }

  // ----- internals -----
  private attemptFor(env: PublicCommandEnvelope): MockAttempt {
    const target = env.target as { scope: string; attemptId?: string };
    const attemptId = target.attemptId;
    const attempt = attemptId ? this.attempts.get(attemptId) : undefined;
    if (!attempt) throw mockError('INVALID_OPERATION', '尝试不存在。');
    this.assertFamilyVisible(attempt);
    return attempt;
  }

  private assertFamilyVisible(attempt: MockAttempt): void {
    if (!this.session || attempt.familyId !== this.session.familyId) {
      throw mockError('FORBIDDEN', '对象不可见。');
    }
    if (this.session.role === 'LEARNER' && attempt.learnerId !== this.session.learnerId) {
      throw mockError('FORBIDDEN', '对象不可见。');
    }
  }

  private casVersion(env: PublicCommandEnvelope, attempt: MockAttempt): void {
    if (env.expectedAttemptVersion !== undefined && env.expectedAttemptVersion !== attempt.version) {
      throw mockError('VERSION_CONFLICT', '操作所基于的版本已过期。', {
        currentVisibleVersion: attempt.version,
        recoveryHint: '请刷新后用当前版本重试。',
      });
    }
  }

  private currentCycle(attempt: MockAttempt): MockCycle {
    if (!attempt.currentCycleId) throw mockError('INVALID_OPERATION', '没有当前任务。');
    return this.cycles.get(attempt.currentCycleId)!;
  }

  private latestVerdict(cycle: MockCycle): 'CORRECT' | 'REVISE' | null {
    const last = cycle.submissions[cycle.submissions.length - 1];
    return last ? last.verdict : null;
  }

  private openCycle(attempt: MockAttempt, taskId: string): MockCycle {
    if (!this.hasAnyTask(taskId)) throw mockError('INVALID_OPERATION', `未知任务 ${taskId}`);
    const task = this.taskFor(taskId);
    // frozen instances replace the placeholder givens (cylinder I1/I2/...,
    // themes i/s/d tasks); cpp givens carry the frozen step program verbatim
    const themesInstance = hasThemesTask(taskId) ? getThemesFrozenInstance(taskId) : null;
    const initial: AnySceneState =
      themesInstance !== null
        ? { ...themesInstance.initial }
        : hasCppTask(taskId)
          ? { ...(task as CppPublicTask).givens }
          : { ...(task as PublicTask).givens };
    const cycleId = this.newId('cyc');
    const qiId = this.newId('qi');
    const cycle: MockCycle = {
      cycleId,
      attemptId: attempt.attemptId,
      questionInstanceId: qiId,
      taskId,
      phase: 'PREDICT',
      prediction: null,
      sceneState: initial,
      initialState: cloneState(initial),
      scriptApplied: false,
      submissions: [],
      explanation: null,
      hints: [],
      assistance: [],
    };
    this.cycles.set(cycleId, cycle);
    attempt.cycles.push(cycleId);
    attempt.currentCycleId = cycleId;
    this.recordEvent(attempt, 'CYCLE_OPENED', 'learning.beginCycle', { taskId });
    return cycle;
  }

  private checkOperationAllowed(taskId: string, op: CylinderOperationV1 | CylinderOperationV2 | GridOperationV1 | StepOperationV1, state: AnySceneState): void {
    // Task whitelist first, for EVERY family (cross-family ops like
    // SetDimension on a board task are rejected here — the family gates below
    // only narrow further).
    const whitelisted = this.taskFor(taskId).allowedOperationIds as string[];
    if (!whitelisted.includes(op.type)) {
      throw mockError('INVALID_OPERATION', `本题不允许操作 ${op.type}。`);
    }
    if (op.type === 'SetGridSize' || op.type === 'SetFilled' || op.type === 'ScaleBoth') {
      this.checkGridOperationAllowed(taskId, op);
      return;
    }
    if (op.type === 'EditStepProgram' || op.type === 'SetTraceCursor') {
      this.checkStepOperationAllowed(taskId, op, state);
      return;
    }
    const task = this.taskFor(taskId) as PublicTask;
    // dual-version guard (L34-1): V2-only operation types are refused outright
    // for @1 tasks (task whitelists alone would also catch it; this makes the
    // rejection-matrix boundary explicit)
    if (
      rendererContractVersionOf(taskId) === '1' &&
      (op.type === 'SetLayerCount' || op.type === 'SetVisibleLayerCount')
    ) {
      throw mockError('INVALID_OPERATION', `本题绑定的渲染器合同 @1 不支持操作 ${op.type}。`);
    }
    if (!task.allowedOperationIds.includes(op.type)) {
      throw mockError('INVALID_OPERATION', `本题不允许操作 ${op.type}。`);
    }
    for (const c of task.operationConstraints) {
      if (c.type !== op.type) continue;
      if (op.type === 'SetDimension' && c.type === 'SetDimension') {
        if (c.dimension && op.dimension !== c.dimension) {
          continue; // constraint row for the other dimension — not applicable
        }
        if (c.valuesMm && !c.valuesMm.includes(op.valueMm)) {
          throw mockError('INVALID_OPERATION', '数值不在本题允许的改动值内。');
        }
        if (c.minMm !== undefined && op.valueMm < c.minMm) throw mockError('INVALID_OPERATION', '数值过小。');
        if (c.maxMm !== undefined && op.valueMm > c.maxMm) throw mockError('INVALID_OPERATION', '数值过大。');
      }
      if (op.type === 'SetUnroll' && c.type === 'SetUnroll') {
        if (c.minPermille !== undefined && op.valuePermille < c.minPermille) throw mockError('INVALID_OPERATION', '展开进度过小。');
        if (c.maxPermille !== undefined && op.valuePermille > c.maxPermille) throw mockError('INVALID_OPERATION', '展开进度过大。');
      }
      if (op.type === 'SetSection' && c.type === 'SetSection') {
        if (c.sections && !c.sections.includes(op.section)) throw mockError('INVALID_OPERATION', '该截面不在允许范围。');
      }
      if (op.type === 'SelectFaces' && c.type === 'SelectFaces') {
        if (c.allowedFaceIds && op.faceIds.some((f) => !c.allowedFaceIds!.includes(f))) {
          throw mockError('INVALID_OPERATION', '面 ID 不在本题白名单内。');
        }
      }
      if (op.type === 'SetLayerCount' && c.type === 'SetLayerCount') {
        if (c.values && !c.values.includes(op.value)) {
          throw mockError('INVALID_OPERATION', '层数不在本题允许值内。');
        }
        if (c.min !== undefined && op.value < c.min) throw mockError('INVALID_OPERATION', '层数过小。');
        if (c.max !== undefined && op.value > c.max) throw mockError('INVALID_OPERATION', '层数过大。');
      }
    }
  }

  /**
   * Grid-board operation gate (themes families): enumerated row/col choices,
   * filled cap, allowed scale multipliers — plus the shared range/invariant
   * checks in applyGridOperation (filled <= rows×cols etc.).
   */
  private checkGridOperationAllowed(taskId: string, op: GridOperationV1): void {
    const task = getThemesTask(taskId);
    for (const c of task.operationConstraints) {
      if (c.type !== op.type) continue;
      if (op.type === 'SetGridSize' && c.type === 'SetGridSize') {
        if (op.rows !== undefined && c.rowsValues !== undefined && !c.rowsValues.includes(op.rows)) {
          throw mockError('INVALID_OPERATION', '行数不在本题允许的取值内。');
        }
        if (op.cols !== undefined && c.colsValues !== undefined && !c.colsValues.includes(op.cols)) {
          throw mockError('INVALID_OPERATION', '份数（列数）不在本题允许的取值内。');
        }
      }
      if (op.type === 'SetFilled' && c.type === 'SetFilled') {
        if (c.maxCount !== undefined && op.count > c.maxCount) throw mockError('INVALID_OPERATION', '涂色份数过大。');
      }
      if (op.type === 'ScaleBoth' && c.type === 'ScaleBoth') {
        if (c.multipliers !== undefined && !c.multipliers.includes(op.multiplier)) {
          throw mockError('INVALID_OPERATION', '该缩放倍数不在本题允许范围。');
        }
      }
    }
  }

  /**
   * Step-card operation gate (cpp family): the shared engine grammar gate
   * uses (engine.validateStepEdit / traceLength). EditStepProgram must parse,
   * respect the card's slot/insert/delete constraints, and complete within
   * the 200-step budget and the card's output-line cap.
   */
  private checkStepOperationAllowed(taskId: string, op: StepOperationV1, state: AnySceneState): void {
    const task = getCppTask(taskId);
    if (!('program' in state)) throw mockError('INVALID_OPERATION', '本题不是步骤卡任务。');
    const constraint = task.operationConstraints.find((c) => c.type === 'StepProgram');
    if (!constraint) throw mockError('INVALID_OPERATION', '本题没有登记步骤卡约束。');
    if (op.type === 'EditStepProgram') {
      const verdict = validateStepEdit(state.program as StepSpecV1[], op.steps, state.inputs, constraint);
      if (!verdict.ok) {
        throw mockError('INVALID_OPERATION', verdict.rejection.message, { code: verdict.rejection.code });
      }
      return;
    }
    // SetTraceCursor: cursor clamping happens in overlayState(); nothing else to gate
  }

  /** Confirmed-operation activity for the CURRENT cycle (L4 activity checks). */
  private cycleActivity(attempt: MockAttempt, cycle: MockCycle): CycleActivity {
    const activity: CycleActivity = {
      layerCountValues: [],
      visibleLayerCountValues: [],
      visibleLayerCountApplies: 0,
      setDimensionAxes: [],
      selectFacesApplies: 0,
    };
    for (const e of this.events) {
      if (e.attemptId !== attempt.attemptId || e.eventType !== 'OPERATION_CONFIRMED') continue;
      const op = e.payload?.operation as Record<string, unknown> | undefined;
      if (!op) continue;
      if (op.type === 'SetLayerCount' && !activity.layerCountValues.includes(op.value as number)) {
        activity.layerCountValues.push(op.value as number);
      }
      if (op.type === 'SetVisibleLayerCount') {
        activity.visibleLayerCountApplies += 1;
        if (!activity.visibleLayerCountValues.includes(op.value as number)) {
          activity.visibleLayerCountValues.push(op.value as number);
        }
      }
      if (op.type === 'SetDimension' && !activity.setDimensionAxes.includes(op.dimension as string)) {
        activity.setDimensionAxes.push(op.dimension as string);
      }
      if (op.type === 'SelectFaces') activity.selectFacesApplies += 1;
    }
    void cycle;
    return activity;
  }

  private recordEvent(attempt: MockAttempt, eventType: string, commandKind: string, payload: Record<string, unknown>): void {
    const seq = (this.seqByAttempt.get(attempt.attemptId) ?? 0) + 1;
    this.seqByAttempt.set(attempt.attemptId, seq);
    this.events.push({
      eventId: this.newId('evt'),
      attemptId: attempt.attemptId,
      seq,
      eventType,
      commandKind,
      occurredAtMs: this.now(),
      payload,
    });
  }

  /** answer-level hint text: frozen instance text, static task text, or the
   *  snapshot-computed value for the G3 exploration task (all private-side). */
  private answerHintText(taskId: string, snapshot: AnySceneState): string {
    if (hasThemesTask(taskId)) {
      const inst = getThemesFrozenInstance(taskId);
      if (inst?.answerHint) return inst.answerHint;
      return getThemesAnswerHint(taskId) ?? '（本题无答案级提示）';
    }
    if (hasCppTask(taskId)) {
      return getCppAnswerHint(taskId) ?? '（本题无答案级提示）';
    }
    const cyl = snapshot as CylinderStateV1;
    const inst = getFrozenInstance(taskId);
    if (inst?.answerHint) return inst.answerHint;
    const list = ANSWER_HINTS[taskId];
    if (list && list.length > 0 && list[0].instanceId === 'static') return list[0].text;
    if (taskId === 'cyl.net.g3.lateral-area.v1') {
      const c = (2 * 157 * cyl.radiusMm) / 50 / 10;
      const area = (2 * 157 * cyl.radiusMm * cyl.heightMm) / 50 / 100;
      return `C = 2×3.14×${(cyl.radiusMm / 10).toFixed(1)} = ${c.toFixed(2)} cm；S侧 = ${c.toFixed(2)}×${(cyl.heightMm / 10).toFixed(1)} = ${area.toFixed(2)} cm²。`;
    }
    return '（本题无答案级提示）';
  }

  private lastEventId(): string {
    return this.events[this.events.length - 1]?.eventId ?? 'evt-none';
  }

  private checkMigrationObserved(attempt: MockAttempt, cycle: MockCycle): void {
    const mig = this.migrations.get(attempt.learnerId);
    if (!mig || mig.sourceAttemptId === attempt.attemptId) return;
    if (mig.taskId !== cycle.taskId || mig.state !== 'STARTED') return;
    mig.state = 'OBSERVED';
    mig.observedAtMs = this.now();
    // actual interval = observed - SOURCE attempt finish (plannedAtMs), not
    // the started timestamp — the delay being measured starts at the source
    mig.actualIntervalDays = Math.round((mig.observedAtMs - mig.plannedAtMs) / 86_400_000);
  }
}

function isStateV1(s: AnySceneState): boolean {
  return (s as CylinderStateV2).layerCount === undefined;
}
function isStateV2(s: AnySceneState): s is CylinderStateV2 {
  return (s as CylinderStateV2).layerCount !== undefined && (s as CylinderStateV2).visibleLayerCount !== undefined;
}

function overlay(state: CylinderStateV1 | CylinderStateV2, op: CylinderOperationV1 | CylinderOperationV2): CylinderStateV1 | CylinderStateV2 {
  switch (op.type) {
    case 'SetDimension':
      return op.dimension === 'RADIUS' ? { ...state, radiusMm: op.valueMm } : { ...state, heightMm: op.valueMm };
    case 'SetUnroll':
      return { ...state, unrollPermille: op.valuePermille };
    case 'SetSection':
      return { ...state, section: op.section };
    case 'SelectFaces':
      return { ...state, selectedFaceIds: op.faceIds };
    case 'SetLayerCount': {
      const s = state as CylinderStateV2;
      return { ...s, layerCount: op.value, visibleLayerCount: Math.min(s.visibleLayerCount, op.value) };
    }
    case 'SetVisibleLayerCount': {
      const s = state as CylinderStateV2;
      if (op.value > s.layerCount) {
        throw mockError('INVALID_OPERATION', `可见层数 ${op.value} 超过当前层数 ${s.layerCount}。`);
      }
      return { ...s, visibleLayerCount: op.value };
    }
  }
}

function overlayState(
  taskId: string,
  state: AnySceneState,
  op: CylinderOperationV1 | CylinderOperationV2 | GridOperationV1 | StepOperationV1,
): AnySceneState {
  if (op.type === 'SetGridSize' || op.type === 'SetFilled' || op.type === 'ScaleBoth') {
    if (!('cols' in state)) throw mockError('INVALID_OPERATION', '本题不是图板任务。');
    const next = applyGridOperation(state, op);
    if (next === null) throw mockError('INVALID_OPERATION', '操作超出图板范围。');
    return next;
  }
  if (op.type === 'EditStepProgram') {
    if (!('program' in state)) throw mockError('INVALID_OPERATION', '本题不是步骤卡任务。');
    const task = getCppTask(taskId);
    const constraint = task.operationConstraints.find((c) => c.type === 'StepProgram')!;
    const verdict = validateStepEdit(state.program as StepSpecV1[], op.steps, state.inputs, constraint);
    if (!verdict.ok) throw mockError('INVALID_OPERATION', verdict.rejection.message, { code: verdict.rejection.code });
    return { ...state, program: JSON.parse(JSON.stringify(op.steps)) as StepSpecV1[] };
  }
  if (op.type === 'SetTraceCursor') {
    if (!('program' in state)) throw mockError('INVALID_OPERATION', '本题不是步骤卡任务。');
    const len = traceLength(state.program as StepSpecV1[], state.inputs);
    const cursor =
      op.mode === 'RESET' ? 0 : op.mode === 'END' ? len : Math.max(0, Math.min(op.index ?? 0, len));
    return { ...state, cursorStep: cursor };
  }
  if (!('radiusMm' in state)) throw mockError('INVALID_OPERATION', '本题不是圆（圆柱）任务。');
  return overlay(state as CylinderStateV1 | CylinderStateV2, op as CylinderOperationV1 | CylinderOperationV2);
}

function cloneState(state: AnySceneState): AnySceneState {
  return JSON.parse(JSON.stringify(state)) as AnySceneState;
}

function safeTaskTitle(taskId?: string): string | undefined {
  if (!taskId || !hasTask(taskId)) return undefined;
  return getTask(taskId).title;
}

// content module indirection removed (no cycle: contentLoader never imports store)
