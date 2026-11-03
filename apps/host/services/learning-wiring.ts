import {MATH_REGISTERED_ACTIVITIES} from '../../../modules/curriculum/math6';
import {GESP_REGISTERED_ACTIVITIES} from '../../../modules/curriculum/gesp';
/**
 * Rondo learning wiring (A lane, integrated/ R2): the single Host service that
 * assembles B's learning domain behind the frozen composition seams.
 *
 * Assembly order (B-INTEGRATION §装配 / §启动对账):
 *   createSqliteStorage (the ONLY business connection: B's migration runner
 *   applies the frozen schema and asserts schemaVersion; the old A-owned
 *   RondoSqlite connection is deleted) ->
 *   RondoContentService({storage, now}) ->
 *   content.loadRelease(contentRoot, releaseId) for both first-batch releases,
 *   status machine advanced to AVAILABLE (host maintenance entry) ->
 *   createLocalAuth({storage, time, ids, windowRef, hostEpoch}) ->
 *   createLearningServer({context, content, storage, time, ids, policy}) ->
 *   applyRollingRetention(storage, {asOf, newOpId}) (hostEpoch advanced by
 *   apps/host/main.ts before boot) ->
 *   register every ROUTER_OPS + VIEW_OPS handler, then
 *   rondoRouter.assertAllOpsRegistered().
 *
 * A release that B's frozen content schemas cannot accept is REFUSED LOUDLY
 * (host-lifecycle `content-release-refused` + stderr) and recorded in
 * contentGaps — never silently skipped and never worked around. See the
 * wiring report's CONTRACT_CHANGE_REQUIRED items.
 *
 * Close order (B-INTEGRATION §close) is driven by apps/host/main.ts through
 * closeBusiness() / closeConnection(); this service's dispose hook is only a
 * backstop.
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getHostRuntime } from '../runtime';
import { createSqliteStorage, type SqliteStorage } from '../../../adapters/sqlite/storage';
import { assertSupportedSchemaVersion } from '../../../adapters/sqlite/schema/schemaVersion';
import { RondoContentService, type ContentServiceInternal } from '../../../modules/content';
import { createLocalAuth, type LocalAuth } from '../../../modules/learning/auth';
import { CompilerService } from '../../../workers/cpp/compiler.mjs';
import compilerConfig from '../../../workers/cpp/worker-lock.json';
import { createLearningServer } from '../../../modules/learning';
import { applyRollingRetention, applyReleaseStatusChange, buildExportPayload } from '../../../modules/learning/maintenance';
import type { LearningServer } from '../../../modules/contracts/server/learning';
import type { LearningPolicySet, ServerClock, IdGenerator } from '../../../modules/contracts/server/learning';
import type { ServerContext } from '../../../modules/contracts/server/context';
import type { StoragePort } from '../../../modules/contracts/server/storage';
import type { ReleaseRecord, ReleaseStatus } from '../../../modules/contracts/server/content';
import { safeParseEnvelope, commandKindSchema } from '../../../modules/contracts/public/envelope';
import { safeParsePublicQuery } from '../../../modules/contracts/public/queries';
import { idSchema } from '../../../modules/contracts/public/protocol';
import {
  safeParseSetupGuardianInput,
  safeParseUnlockGuardianInput,
  safeParseEnterLearnerInput,
} from '../../../modules/contracts/public/auth';
import { rondoError, type RondoError } from '../../../modules/contracts/public/errors';
import { rondoOpError } from './ipc-router';
import {AI_ACTIVITIES,supersededActivityNotice} from '../../../modules/curriculum/mvp';
import { ViewOps, callView } from './view-ops';

/** WindowRef recorded on issued sessions: the rondo://app trusted main window (sender/origin asserted by Desktop Main on every message). */
export const TRUSTED_WINDOW_REF = 'rondo://app/main';

/**
 * Course list (integration W1): every family release the Host loads at boot, in
 * course order — the prerequisite micro-lessons first (微课为先修入口：m1..m4
 * chain into Theme 1), then Theme 1's three lessons, the four cylinder
 * lessons, and the GESP-2 unit. loadRelease order follows this list;
 * policyFromReleases records the cross-release prerequisite edges that change
 * the next-step arrangement (micro → theme entry; strand progression).
 */
export const RELEASE_IDS = [
  'rondo.mvp.math-ratio-r1', 'rondo.mvp.gesp-202303-p1-r1',
  ...AI_ACTIVITIES.map(a=>a.releaseId),
  ...GESP_REGISTERED_ACTIVITIES.map(a=>a.releaseId),
  ...MATH_REGISTERED_ACTIVITIES.map(a=>a.releaseId),
  // 先修微课（themes.micro.v1 — prerequisite entry strand）
  'rondo.thm.m1-r1',
  'rondo.thm.m2-r1',
  'rondo.thm.m3-r1',
  'rondo.thm.m4-r1',
  // 主题一（themes.frac.v1）
  'rondo.thm.t1l1-r1',
  'rondo.thm.t1l2-r1',
  'rondo.thm.t1l3-r1',
  // 圆柱四课（cylinder.parameters/net/faces/layers.v1）
  'rondo.cyl.l1-r1',
  'rondo.cyl.l2-r1',
  'rondo.cyl.l3-r1',
  'rondo.cyl.l4-r1',
  // GESP 2 第 1 单元（cpp.steps.v1）
  'rondo.cpp.u1-r1',
] as const;

/** LIFECYCLE §9 suggested default (displayed as a suggestion, not a mandate). */
const SUGGESTED_ROLLING_DAYS = 180;

export interface RondoLearningCloseReport {
  readonly pendingTransactions: number;
  readonly releasedStatements: number;
  readonly walCheckpointed: boolean;
  readonly schemaVersion: number;
}

export interface ContentGap {
  readonly releaseId: string;
  readonly code: string;
  readonly message: string;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    rondoLearning: RondoLearningService;
  }
}

function errorFacts(err: unknown): { code: string; message: string } {
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    return { code: String((err as { code: unknown }).code), message: String((err as { message: unknown }).message) };
  }
  return { code: 'PERSISTENCE_FAILED', message: err instanceof Error ? err.message : String(err) };
}

function isRondoErrorLike(err: unknown): err is RondoError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'message' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    typeof (err as { message: unknown }).message === 'string' &&
    !('rondo' in err)
  );
}

function isZodErrorLike(err: unknown): boolean {
  return err instanceof Error && Array.isArray((err as unknown as { issues?: unknown }).issues);
}

/** Normalizes B's plain-object RondoError throwables (and zod failures) into router op errors. */
async function rondo<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isZodErrorLike(err)) {
      throw rondoOpError(rondoError('SCHEMA_MISMATCH', '请求未通过 schema 校验。'));
    }
    if (isRondoErrorLike(err)) {
      throw rondoOpError(err);
    }
    throw err;
  }
}

/**
 * Minimal LearningPolicySet derived from the loaded release manifests.
 * Cross-family (integration W1): within each release the graph follows the
 * release task order (C's lessons.json taskOrder with the delayed-transfer
 * task appended last); across releases it records exactly the prerequisite
 * edges that change the next-step arrangement in the RELEASE_IDS course-list
 * order — each release's last task points at the next release's first task
 * (微课 m1→…→m4→主题一 t1l1→…, strand progression into the cylinder lessons
 * and the GESP-2 unit). No other cross-release edges are invented.
 */
function policyFromReleases(releases: readonly ReleaseRecord[]): LearningPolicySet {
  const nextByTask = new Map<string, string[]>();
  const hintMax = new Map<string, number>();
  const byCourseOrder = releases.filter(record=>!supersededActivityNotice(record.releaseId)).sort(
    (a, b) => RELEASE_IDS.indexOf(a.releaseId as (typeof RELEASE_IDS)[number]) - RELEASE_IDS.indexOf(b.releaseId as (typeof RELEASE_IDS)[number]),
  );
  for (let r = 0; r < byCourseOrder.length; r += 1) {
    const record = byCourseOrder[r];
    const taskIds = record.manifest.public.taskIds;
    for (let i = 0; i < taskIds.length; i += 1) {
      if (i + 1 < taskIds.length) {
        const nexts = nextByTask.get(taskIds[i]) ?? [];
        if (!nexts.includes(taskIds[i + 1])) nexts.push(taskIds[i + 1]);
        nextByTask.set(taskIds[i], nexts);
      } else {
        // last task of this release: the next release's first task is the
        // prerequisite-driven next step (course-list order)
        const nextRelease = byCourseOrder[r + 1];
        const nexts = nextByTask.get(taskIds[i]) ?? [];
        const nextFirst = nextRelease?.manifest.public.taskIds[0];
        if (nextFirst !== undefined && !nexts.includes(nextFirst)) nexts.push(nextFirst);
        nextByTask.set(taskIds[i], nexts);
      }
    }
    for (const gate of record.manifest.private.hintGateTable) {
      hintMax.set(gate.taskId, Math.max(hintMax.get(gate.taskId) ?? 0, gate.hintLevel));
    }
  }
  return {
    courseGraph: [...nextByTask.entries()].map(([taskId, nextTaskIds]) => ({ taskId, nextTaskIds })),
    hintPolicy: [...hintMax.entries()].map(([taskId, maxLevel]) => ({ taskId, maxLevel })),
    defaultRetention: { mode: 'ROLLING_DAYS', rollingDays: SUGGESTED_ROLLING_DAYS },
  };
}

interface SessionIdRow {
  sessionId: string;
}

export default class RondoLearningService extends Service {
  private initialized = false;
  private businessClosed = false;
  private lastCloseReport: RondoLearningCloseReport | null = null;
  private currentSessionId: string | null = null;
  private hostEpoch = '';
  private dataRootDir = '';
  private sqliteVersionValue = '';

  readonly registeredReleases: string[] = [];
  readonly contentGaps: ContentGap[] = [];
  policy: LearningPolicySet = { courseGraph: [], hintPolicy: [], defaultRetention: { mode: 'UNTIL_GUARDIAN_DELETES' } };
  storage: SqliteStorage | null = null;
  content: RondoContentService | null = null;
  auth: LocalAuth | null = null;
  server: LearningServer | null = null;
  private viewOps: ViewOps | null = null;
  private clock: ServerClock = { now: () => Date.now() };
  private ids: IdGenerator = { newId: (prefix) => `${prefix}-${randomUUID()}` };

  constructor(ctx: Context) {
    super(ctx, 'rondoLearning');
    ctx.effect(() => () => {
      void this.ensureClosedBackstop();
    });
  }

  private log(event: string, facts: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: Date.now(), event, ...facts });
    try {
      appendFileSync(join(this.dataRootDir || getHostRuntime().dataRoot, 'technical', 'logs', 'host-lifecycle.log'), `${line}\n`);
    } catch {
      // Logging must never block the wiring; stderr already carries the loud gap lines.
    }
  }

  /** Structured entry-routing signal: a guardian credential exists. */
  async guardianConfigured(): Promise<boolean> {
    const storage = this.storage;
    if (!storage || this.businessClosed) return false;
    const cred = await storage.read(async (repos) => {
      // B internal seam (repositories.ts implements findAny; the frozen
      // GuardianCredentialRepository interface stays narrow) — same
      // capability-cast discipline as modules/learning/auth.ts.
      const gc = repos.guardianCredential as typeof repos.guardianCredential & {
        findAny(): Promise<unknown>;
      };
      return typeof gc.findAny === 'function' ? gc.findAny() : null;
    });
    return cred !== null;
  }

  /**
   * Full wiring. Called by apps/host/main.ts after boot() settled the service
   * tree and before the Host reports READY; any throw refuses READY.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const runtime = getHostRuntime();
    this.hostEpoch = runtime.hostEpoch;
    this.dataRootDir = runtime.dataRoot;
    mkdirSync(join(runtime.dataRoot, 'technical', 'logs'), { recursive: true });
    this.log('learning-wiring-start', { contentRoot: runtime.contentRoot, hostEpoch: this.hostEpoch });

    // 1. Single business connection (B storage: migrations + schemaVersion assert).
    const dbFile = join(runtime.dataRoot, 'learning', 'learning.sqlite');
    mkdirSync(dirname(dbFile), { recursive: true });
    this.storage = createSqliteStorage({ file: dbFile, now: this.clock.now });
    this.sqliteVersionValue = String(
      (this.storage.rawDatabase().prepare('select sqlite_version() as v').get() as { v: unknown })['v'],
    );
    this.log('learning-db-open', { dbFile, schemaVersion: this.storage.schemaVersion(), sqliteVersion: this.sqliteVersionValue });

    // 2. Content service + both first-batch releases (loud refusal on gap).
    this.content = new RondoContentService({ storage: this.storage, now: this.clock.now });
    const records: ReleaseRecord[] = [];
    for (const releaseId of RELEASE_IDS) {
      try {
        const record = await this.content.loadRelease(runtime.contentRoot, releaseId);
        await this.advanceToAvailable(releaseId);
        records.push(record);
        this.registeredReleases.push(releaseId);
        this.log('content-release-registered', { releaseId, status: 'AVAILABLE' });
      } catch (err) {
        const facts = errorFacts(err);
        this.contentGaps.push({ releaseId, ...facts });
        this.log('content-release-refused', { releaseId, ...facts });
        process.stderr.write(`rondo-host: content release REFUSED: ${releaseId}: ${facts.code}: ${facts.message}\n`);
      }
    }
    if (this.contentGaps.length > 0) {
      this.log('content-gaps', { gaps: this.contentGaps });
    }
    this.policy = policyFromReleases(records);

    // 3. Auth + learning server.
    this.auth = createLocalAuth({
      storage: this.storage,
      time: this.clock,
      ids: this.ids,
      windowRef: TRUSTED_WINDOW_REF,
      hostEpoch: this.hostEpoch,
    });
    const compiler = new CompilerService(compilerConfig);
    try { await compiler.verify(); } catch (err) { this.log('compiler-unavailable', {message: String(err)}); }
    this.server = createLearningServer({
      compiler,
      compilerFactory: async () => { const next = new CompilerService(compilerConfig); try { await next.verify(); return next; } catch (error) { await next.close(); throw error; } },
      context: this.auth.contextProvider,
      content: this.content,
      storage: this.storage,
      time: this.clock,
      ids: this.ids,
      policy: this.policy,
    });

    // 4. Startup reconciliation: rolling retention sweep (confirmed cleanups only).
    await applyRollingRetention(this.storage, { asOf: this.clock.now(), newOpId: () => this.ids.newId('op') });

    // 5. Register the full router surface and prove completeness.
    this.viewOps = new ViewOps({
      storage: this.storage as StoragePort,
      content: this.content as ContentServiceInternal,
      now: this.clock.now,
    });
    this.registerOps();
    this.ctx.rondoRouter.assertAllOpsRegistered();
    this.initialized = true;
    this.log('learning-wiring-ready', {
      registeredReleases: this.registeredReleases,
      contentGaps: this.contentGaps,
    });
  }

  private async advanceToAvailable(releaseId: string): Promise<void> {
    for (const step of [['DRAFT', 'REVIEWED'], ['REVIEWED', 'AVAILABLE']] as const) {
      const current = await this.storage!.read(
        async (repos) => await repos.contentRelease.findById({ familyId: '', actorId: '' }, releaseId),
      );
      if (current !== null && current.status === (step[0] as ReleaseStatus)) {
        await applyReleaseStatusChange(this.storage!, this.clock.now, {
          releaseId,
          to: step[1] as ReleaseStatus,
          reason: 'host-startup-reconcile',
        });
      }
    }
  }

  // -- identity / recovery facts for apps/host/main.ts ---------------------------

  sqliteVersion(): string {
    return this.sqliteVersionValue;
  }

  schemaVersion(): number {
    return this.storage?.schemaVersion() ?? 0;
  }

  /** Recovery re-verification on an existing data root (B storage assertion). */
  verifyRecovery(): { schemaVersion: number; sqliteVersion: string } {
    if (this.storage === null) throw new Error('RONDO_LEARNING_NOT_INITIALIZED');
    const version = this.storage.schemaVersion();
    assertSupportedSchemaVersion(version);
    return { schemaVersion: version, sqliteVersion: this.sqliteVersionValue };
  }

  // -- close order (driven by main.ts; dispose hook is the backstop) --------------

  /** server.close -> content.close -> storage.close, returning the CloseReport facts. */
  async closeBusiness(): Promise<RondoLearningCloseReport> {
    if (this.businessClosed) return this.lastCloseReport!;
    this.businessClosed = true;
    if (this.server !== null) await this.server.close();
    if (this.content !== null) await this.content.close();
    if (this.storage !== null) {
      const report = await this.storage.close();
      this.lastCloseReport = { ...report, schemaVersion: this.storage.schemaVersion() };
      return this.lastCloseReport;
    }
    this.lastCloseReport = { pendingTransactions: 0, releasedStatements: 0, walCheckpointed: false, schemaVersion: 0 };
    return this.lastCloseReport;
  }

  /** Connection close is A's job per B-INTEGRATION §close step 5. */
  closeConnection(): void {
    try {
      this.storage?.closeConnection();
    } catch {
      // close() must have run first; ignore double-close.
    }
  }

  private async ensureClosedBackstop(): Promise<void> {
    if (!this.businessClosed && this.storage !== null) {
      try {
        await this.closeBusiness();
      } catch {
        // Main's shutdown owns the ordered close + logging.
      }
    }
    this.closeConnection();
  }

  // -- session tracking (same derivation the B test harness performs) ---------------

  private async readNewestSessionId(): Promise<string | null> {
    if (this.storage === null) return null;
    const row = this.storage
      .rawDatabase()
      .prepare(
        'SELECT sessionId FROM hostSession WHERE hostEpoch = ? AND revokedAt IS NULL ORDER BY issuedAt DESC, rowid DESC LIMIT 1',
      )
      .get(this.hostEpoch) as SessionIdRow | undefined;
    return row?.sessionId ?? null;
  }

  private async requireContext(): Promise<ServerContext> {
    if (this.currentSessionId === null || this.auth === null) {
      throw rondoError('UNAUTHENTICATED', '没有活动会话。');
    }
    const ctx = await this.auth.contextProvider(this.currentSessionId, TRUSTED_WINDOW_REF);
    if (ctx === null) {
      throw rondoError('UNAUTHENTICATED', '会话已失效，请重新进入。');
    }
    return ctx;
  }

  /** Browser export uses the same live trusted context as commands; no renderer scope claims. */
  async browserExport(opId: string) {
    const ctx = await this.requireContext();
    if (ctx.role !== 'GUARDIAN') throw rondoError('FORBIDDEN', '导出需要监护人解锁。');
    if (!this.storage || !this.content || this.businessClosed) throw rondoError('INVALID_OPERATION', 'Host 尚未就绪。');
    return buildExportPayload(this.storage, { familyId: ctx.familyId, actorId: ctx.actorId }, opId, this.clock.now, this.content);
  }

  // -- router op registration -------------------------------------------------------

  private registerOps(): void {
    const router = this.ctx.rondoRouter;
    const server = this.server!;
    const auth = this.auth!;
    const views = this.viewOps!;

    const requireId = (payload: unknown, field: string): string => {
      if (typeof payload !== 'object' || payload === null) {
        throw rondoOpError(rondoError('SCHEMA_MISMATCH', '视图查询负载必须是对象。'));
      }
      const value = (payload as Record<string, unknown>)[field];
      const parsed = idSchema.safeParse(value);
      if (!parsed.success) {
        throw rondoOpError(rondoError('SCHEMA_MISMATCH', `视图查询负载字段 ${field} 未通过 schema 校验。`));
      }
      return parsed.data;
    };
    const requireEmpty = (payload: unknown): void => {
      if (payload !== undefined && payload !== null && Object.keys(payload as object).length > 0) {
        throw rondoOpError(rondoError('SCHEMA_MISMATCH', '该视图查询不接受参数。'));
      }
    };

    router.register('command', (payload) =>
      rondo(async () => {
        const parsed = safeParseEnvelope(payload);
        if (!parsed.success) {
          throw rondoOpError(rondoError('SCHEMA_MISMATCH', '命令信封未通过 schema 校验。', { issues: parsed.error.issues.length }));
        }
        const ctx = await this.requireContext();
        return server.handleCommand(ctx, parsed.data);
      }),
    );

    router.register('query', (payload) =>
      rondo(async () => {
        const parsed = safeParsePublicQuery(payload);
        if (!parsed.success) {
          throw rondoOpError(rondoError('SCHEMA_MISMATCH', '查询请求未通过 schema 校验。', { issues: parsed.error.issues.length }));
        }
        const ctx = await this.requireContext();
        return server.query(ctx, parsed.data);
      }),
    );

    router.register('receipt', (payload) =>
      rondo(async () => {
        if (typeof payload !== 'object' || payload === null) {
          throw rondoOpError(rondoError('SCHEMA_MISMATCH', '回执查询负载必须是对象。'));
        }
        const record = payload as Record<string, unknown>;
        const key = idSchema.safeParse(record['idempotencyKey']);
        const kind = commandKindSchema.safeParse(record['commandKind']);
        if (!key.success || !kind.success) {
          throw rondoOpError(rondoError('SCHEMA_MISMATCH', '回执查询负载未通过 schema 校验。'));
        }
        const ctx = await this.requireContext();
        return server.lookupReceipt(ctx, { idempotencyKey: key.data, commandKind: kind.data });
      }),
    );

    const trackSession = <T>(run: () => Promise<T>): Promise<T> =>
      rondo(async () => {
        const result = await run();
        this.currentSessionId = await this.readNewestSessionId();
        return result;
      });

    router.register('auth.setupGuardian', (payload) =>
      trackSession(async () => {
        if (!safeParseSetupGuardianInput(payload).success) {
          throw rondoOpError(rondoError('SCHEMA_MISMATCH', '认证操作 setupGuardian 负载未通过 schema 校验。'));
        }
        return auth.setupGuardian(payload as never);
      }),
    );
    router.register('auth.unlockGuardian', (payload) =>
      trackSession(async () => {
        if (!safeParseUnlockGuardianInput(payload).success) {
          throw rondoOpError(rondoError('SCHEMA_MISMATCH', '认证操作 unlockGuardian 负载未通过 schema 校验。'));
        }
        return auth.unlockGuardian(payload as never);
      }),
    );
    router.register('auth.enterLearner', (payload) =>
      trackSession(async () => {
        if (!safeParseEnterLearnerInput(payload).success) {
          throw rondoOpError(rondoError('SCHEMA_MISMATCH', '认证操作 enterLearner 负载未通过 schema 校验。'));
        }
        return auth.enterLearner(payload as never);
      }),
    );
    router.register('auth.lock', () =>
      rondo(async () => {
        const result = await auth.lock();
        this.currentSessionId = null;
        return result;
      }),
    );
    router.register('auth.session', () => rondo(() => auth.session()));

    // VIEW_OPS: authorization mirrors the command path (context required,
    // family scoping + own-learner discipline inside ViewOps).
    const view = <T>(payload: unknown, pick: (ctx: ServerContext) => Promise<T>): Promise<T> =>
      callView(async () => {
        const ctx = await this.requireContext();
        return pick(ctx);
      });

    router.register('view.getEvaluation', (payload) => view(payload, (ctx) => views.getEvaluation(ctx, requireId(payload, 'cycleId'))));
    router.register('view.getHints', (payload) => view(payload, (ctx) => views.getHints(ctx, requireId(payload, 'cycleId'))));
    router.register('view.getReviewCard', (payload) => view(payload, (ctx) => views.getReviewCard(ctx, requireId(payload, 'cycleId'))));
    router.register('view.getMigration', (payload) => view(payload, (ctx) => views.getMigration(ctx, requireId(payload, 'learnerId'))));
    router.register('view.getTimelineDetail', (payload) => view(payload, (ctx) => views.getTimelineDetail(ctx, requireId(payload, 'attemptId'))));
    router.register('view.listLearners', (payload) => view(payload, (ctx) => (requireEmpty(payload), views.listLearners(ctx))));
    router.register('view.listAttempts', (payload) =>
      view(payload, (ctx) => {
        if (payload === undefined || payload === null || Object.keys(payload as object).length === 0) {
          return views.listAttempts(ctx, undefined);
        }
        return views.listAttempts(ctx, requireId(payload, 'learnerId'));
      }),
    );
    router.register('view.registerExplanationRevision', (payload) =>
      view(payload, (ctx) => views.registerExplanationRevision(ctx, requireId(payload, 'cycleId'))),
    );
    router.register('view.getLastDeletionScopeHash', (payload) =>
      view(payload, (ctx) => (requireEmpty(payload), views.getLastDeletionScopeHash(ctx))),
    );
    router.register('view.nowMs', (payload) => view(payload, () => (requireEmpty(payload), Promise.resolve(views.nowMs()))));
  }
}
