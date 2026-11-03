import type {CompilerService} from '../../workers/cpp/compiler.mjs';
/**
 * Test harness: one full local data root (SQLite file + content release +
 * auth + learning server) wired exactly the way A's composition will wire it.
 *
 * Everything is synthetic. Two families = two harnesses on two roots (the
 * product contract allows one family per data root); cross-family probing is
 * done by pointing family A's context at family B's object ids.
 *
 * The harness acts as the Host for context derivation: after each auth
 * operation it reads the newest hostSession row (direct DB read -- test-side
 * wiring, the same place A's composition derives contexts from) and builds
 * ServerContext values through the real contextProvider.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAuth, type LocalAuth } from '../../modules/learning/auth';
import { createLearningServer } from '../../modules/learning/index';
import { applyReleaseStatusChange } from '../../modules/learning/maintenance';
import { RondoContentService } from '../../modules/content';
import { SqliteStorage } from '../../adapters/sqlite/storage';
import type { ServerContext } from '../../modules/contracts/server/context';
import type { LearningServer, LearningPolicySet } from '../../modules/contracts/server/learning';
import type { PublicCommandEnvelope, CommandKind } from '../../modules/contracts/public/envelope';
import type { CommandReceipt } from '../../modules/contracts/public/receipts';
import { PROTOCOL_VERSION } from '../../modules/contracts/public/protocol';
import { writeSyntheticRelease, TASK_ORDER } from './release-fixture';
import { SYNTH_RELEASE_ID } from './release-fixture';

export { SYNTH_RELEASE_ID };

export const WINDOW_REF = 'win-main-trusted';
export const HOST_EPOCH = 'epoch-test-1';
export const SETUP_KEY = 'setup-key-synth-0001';
export const GUARDIAN_PASSPHRASE = 'synth-passphrase-42';

export function synthPolicy(): LearningPolicySet {
  const next = (i: number) => (i + 1 < TASK_ORDER.length ? [TASK_ORDER[i + 1]] : []);
  return {
    courseGraph: TASK_ORDER.map((taskId, i) => ({ taskId, nextTaskIds: next(i) })),
    hintPolicy: TASK_ORDER.map((taskId) => ({ taskId, maxLevel: 2 })),
    defaultRetention: { mode: 'UNTIL_GUARDIAN_DELETES' },
  };
}

export class TestClock {
  private ms = 1_790_000_000_000;
  now(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

export class TestIds {
  private counter = 0;
  constructor(private readonly tag: string) {}
  newId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.tag}-${String(this.counter).padStart(5, '0')}`;
  }
}

export interface HarnessOptions {
  readonly compiler?: CompilerService;
  readonly compilerFactory?: () => Promise<CompilerService>;
  /** Database file; defaults to a fresh temp file. ':memory:' for in-memory. */
  readonly dbFile?: string;
  /** Content root; defaults to a fresh temp dir. */
  readonly contentRoot?: string;
  readonly hostEpoch?: string;
  /**
   * Learning policy for the server (course graph / hint policy). Defaults to
   * the synthetic release's policy; pass a real release's course graph when
   * driving a real content release through multi-task cycles.
   */
  readonly policy?: LearningPolicySet;
}

export interface EnvelopeInit {
  readonly kind: CommandKind;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly target: { scope: 'FAMILY' } | { scope: 'LEARNER'; learnerId: string; attemptId?: string; cycleId?: string };
  readonly binding?: { releaseId: string; questionInstanceId: string; rendererContractVersion: string };
  readonly expectedAttemptVersion?: number;
  readonly commandId?: string;
}

interface SessionRow {
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

export class Harness {
  readonly clock = new TestClock();
  readonly ids: TestIds;
  /** Per-instance setup key so two synthetic roots derive DIFFERENT families. */
  readonly setupKey: string;
  readonly storage: SqliteStorage;
  readonly content: RondoContentService;
  readonly auth: LocalAuth;
  readonly server: LearningServer;
  readonly contentRoot: string;
  readonly dbFile: string;
  readonly hostEpochUsed: string;
  private readonly tempDirs: string[] = [];
  private closed = false;
  familyId = '';
  guardianActorId = '';

  private constructor(options: HarnessOptions) {
    this.contentRoot = options.contentRoot ?? '';
    this.dbFile = options.dbFile ?? '';
    this.hostEpochUsed = options.hostEpoch ?? HOST_EPOCH;
    const tag = Math.random().toString(36).slice(2, 7);
    this.ids = new TestIds(tag);
    this.setupKey = `setup-key-synth-${tag}`;
    this.storage = new SqliteStorage({ file: this.dbFile, now: () => this.clock.now() });
    this.content = new RondoContentService({ storage: this.storage, now: () => this.clock.now() });
    this.auth = createLocalAuth({
      storage: this.storage,
      time: { now: () => this.clock.now() },
      ids: this.ids,
      windowRef: WINDOW_REF,
      hostEpoch: this.hostEpochUsed,
    });
    this.server = createLearningServer({
      context: this.auth.contextProvider,
      content: this.content,
      storage: this.storage,
      time: { now: () => this.clock.now() },
      ids: this.ids,
      policy: options.policy ?? synthPolicy(),
      ...(options.compiler?{compiler:options.compiler}:{}),
      ...(options.compilerFactory?{compilerFactory:options.compilerFactory}:{}),
    });
  }

  static async create(options: HarnessOptions = {}): Promise<Harness> {
    let contentRoot = options.contentRoot;
    let dbFile = options.dbFile;
    const tempDirs: string[] = [];
    if (contentRoot === undefined) {
      contentRoot = await mkdtemp(join(tmpdir(), 'rondo-content-'));
      tempDirs.push(contentRoot);
    }
    if (dbFile === undefined) {
      const root = await mkdtemp(join(tmpdir(), 'rondo-root-'));
      tempDirs.push(root);
      dbFile = join(root, 'rondo.sqlite');
    }
    const harness = new Harness({ ...options, contentRoot, dbFile });
    harness.tempDirs.push(...tempDirs);
    await writeSyntheticRelease(contentRoot);
    await harness.content.loadRelease(contentRoot, SYNTH_RELEASE_ID);
    // Advance the status machine to AVAILABLE, idempotently across reopens.
    for (const step of [['DRAFT', 'REVIEWED'], ['REVIEWED', 'AVAILABLE']] as const) {
      const current = await harness.storage.read(async (repos) => repos.contentRelease.findById({ familyId: '', actorId: '' }, SYNTH_RELEASE_ID));
      if (current?.status === step[0]) {
        await applyReleaseStatusChange(harness.storage, () => harness.clock.now(), { releaseId: SYNTH_RELEASE_ID, to: step[1], reason: 'synth' });
      }
    }
    return harness;
  }

  envelope(init: EnvelopeInit): PublicCommandEnvelope {
    return ({
      protocolVersion: PROTOCOL_VERSION,
      commandId: init.commandId ?? `cmd-${init.idempotencyKey}`,
      idempotencyKey: init.idempotencyKey,
      kind: init.kind,
      target: init.target,
      ...(init.binding !== undefined ? { binding: init.binding } : {}),
      ...(init.expectedAttemptVersion !== undefined ? { expectedAttemptVersion: init.expectedAttemptVersion } : {}),
      payload: init.payload,
    } as unknown) as PublicCommandEnvelope;
  }

  async setupFamily(label = 'synth-family'): Promise<{ familyId: string; guardianActorId: string }> {
    const session = await this.auth.setupGuardian({
      idempotencyKey: this.setupKey,
      familyDisplayName: label,
      guardianDisplayName: `${label}-guardian`,
      passphrase: GUARDIAN_PASSPHRASE,
    });
    this.familyId = session.familyId;
    this.guardianActorId = session.actorId;
    return { familyId: session.familyId, guardianActorId: session.actorId };
  }

  async createLearner(guardianCtx: ServerContext, alias: string, key = `create-${alias}`): Promise<string> {
    const receipt = await this.server.handleCommand(
      guardianCtx,
      this.envelope({ kind: 'family.createLearner', idempotencyKey: key, payload: { alias }, target: { scope: 'FAMILY' } }),
    );
    if (receipt.status !== 'APPLIED') throw new Error(`createLearner failed: ${JSON.stringify(receipt)}`);
    const learnerRef = receipt.effectRefs.find((r) => r.startsWith('learner:'));
    return learnerRef!.slice('learner:'.length);
  }

  /** Newest session row (test-side Host wiring; direct DB read). */
  private latestSession(role?: 'GUARDIAN' | 'LEARNER'): SessionRow {
    const db = this.storage.rawDatabase();
    const rows = (
      role === undefined
        ? db.prepare('SELECT * FROM hostSession ORDER BY issuedAt DESC, rowid DESC')
        : db.prepare('SELECT * FROM hostSession WHERE role = ? ORDER BY issuedAt DESC, rowid DESC')
    ).all(...(role === undefined ? [] : [role])) as unknown as SessionRow[];
    return rows[0];
  }

  /** Derives the guardian ServerContext through the REAL contextProvider. */
  async guardianContext(): Promise<ServerContext> {
    const row = this.latestSession('GUARDIAN');
    const ctx = await this.auth.contextProvider(row.sessionId, WINDOW_REF);
    if (ctx === null) throw new Error('guardian context could not be derived (session inactive?)');
    return ctx;
  }

  /** Newest learner session of the given learner, derived through the provider. */
  async learnerContext(learnerId: string): Promise<ServerContext> {
    const db = this.storage.rawDatabase();
    const row = db
      .prepare('SELECT * FROM hostSession WHERE role = ? AND learnerId = ? AND revokedAt IS NULL ORDER BY issuedAt DESC, rowid DESC LIMIT 1')
      .get('LEARNER', learnerId) as unknown as SessionRow | undefined;
    if (row === undefined) throw new Error(`no learner session for ${learnerId}`);
    const ctx = await this.auth.contextProvider(row.sessionId, WINDOW_REF);
    if (ctx === null) throw new Error('learner context could not be derived (session inactive?)');
    return ctx;
  }

  async enterLearner(learnerId: string): Promise<ServerContext> {
    await this.auth.enterLearner({ learnerId });
    return this.learnerContext(learnerId);
  }

  async cmd(ctx: ServerContext, init: EnvelopeInit): Promise<CommandReceipt> {
    return this.server.handleCommand(ctx, this.envelope(init));
  }

  async closeAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.server.close();
    await this.content.close();
    await this.storage.close();
    this.storage.closeConnection();
    for (const dir of this.tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Creates a harness with an initialized family and one learner, ready to start attempts. */
export async function createReadyHarness(
  options: HarnessOptions = {},
): Promise<{ harness: Harness; learnerId: string; guardianCtx: ServerContext; learnerCtx: ServerContext }> {
  const harness = await Harness.create(options);
  await harness.setupFamily();
  const guardianCtx = await harness.guardianContext();
  const learnerId = await harness.createLearner(guardianCtx, '小测');
  const learnerCtx = await harness.enterLearner(learnerId);
  return { harness, learnerId, guardianCtx, learnerCtx };
}

/** Starts an attempt and returns the ids the flow needs. */
export async function startAttempt(
  harness: Harness,
  learnerCtx: ServerContext,
  learnerId: string,
  key = 'start-attempt-1',
): Promise<{ attemptId: string; cycleId: string; questionInstanceId: string; version: number }> {
  const receipt = await harness.cmd(learnerCtx, {
    kind: 'learning.startAttempt',
    idempotencyKey: key,
    payload: { releaseId: SYNTH_RELEASE_ID },
    target: { scope: 'LEARNER', learnerId },
  });
  if (receipt.status !== 'APPLIED') throw new Error(`startAttempt failed: ${JSON.stringify(receipt)}`);
  const attemptId = receipt.effectRefs.find((r) => r.startsWith('attempt:'))!.slice('attempt:'.length);
  const cycleId = receipt.effectRefs.find((r) => r.startsWith('cycle:'))!.slice('cycle:'.length);
  const questionInstanceId = receipt.effectRefs.find((r) => r.startsWith('questionInstance:'))!.slice('questionInstance:'.length);
  return { attemptId, cycleId, questionInstanceId, version: receipt.attemptVersion ?? 1 };
}
