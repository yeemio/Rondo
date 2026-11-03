/**
 * Learning server factory signature and port (server-only).
 *
 * Frozen sources:
 * - Coordinator delta item 1 + B server-ports-recommendation.md §2:
 *   createLearningServer(deps): LearningServer with deps
 *   { context, content, storage, time, ids, policy } and methods
 *   handleCommand / query / lookupReceipt / close (close idempotent).
 * - SHARED-CONTRACT.md "学习服务工厂" row (explicit factory export, all
 *   dependencies injected, no Electron import)
 * - LIFECYCLE-DATA-API.md §7 (synchronous command transaction sequence runs
 *   inside handleCommand; A's router only does envelope runtime validation
 *   plus context injection)
 *
 * H0 freezes the SIGNATURE. The implementation lands in B's
 * modules/learning/index.ts and must export exactly this shape:
 *
 *   export function createLearningServer(deps: LearningServerDeps): LearningServer;
 *
 * (re-export the types from this module rather than redefining them).
 */
import type { ServerContext, ServerContextProvider } from './context';
import type { ContentService } from './content';
import type { StoragePort } from './storage';
import type { PublicCommandEnvelope } from '../public/envelope';
import type { PublicProjection, PublicQuery } from '../public/queries';
import type { CommandReceipt, ReceiptLookup } from '../public/receipts';

/** Server millisecond clock; the only source of event/receipt times. */
export interface ServerClock {
  now(): number;
}

/** Server-side id generation (ULID or uuid v7 style text ids). */
export interface IdGenerator {
  newId(prefix: string): string;
}

export interface CourseGraphNode {
  readonly taskId: string;
  readonly nextTaskIds: readonly string[];
}

export interface HintPolicyEntry {
  readonly taskId: string;
  readonly maxLevel: number;
}

/**
 * Local registry (not remote): registered course graph, hint policy, retention
 * defaults. B/C may extend the field set via a versioned contract delta.
 */
export interface LearningPolicySet {
  readonly courseGraph: readonly CourseGraphNode[];
  readonly hintPolicy: readonly HintPolicyEntry[];
  readonly defaultRetention: {
    readonly mode: 'UNTIL_GUARDIAN_DELETES' | 'ROLLING_DAYS';
    readonly rollingDays?: number;
  };
}

export interface LearningServerDeps {
  readonly compiler?: import('../../../workers/cpp/compiler.mjs').CompilerService;
  /** Verified replacement of the same pinned worker, only after a settled capacity boundary. */
  readonly compilerFactory?: () => Promise<import('../../../workers/cpp/compiler.mjs').CompilerService>;
  /** Only Host authentication produces contexts; null => UNAUTHENTICATED. */
  readonly context: ServerContextProvider;
  readonly content: ContentService;
  readonly storage: StoragePort;
  readonly time: ServerClock;
  readonly ids: IdGenerator;
  readonly policy: LearningPolicySet;
}

export interface LearningServer {
  handleCommand(ctx: ServerContext, envelope: PublicCommandEnvelope): Promise<CommandReceipt>;
  query(ctx: ServerContext, request: PublicQuery): Promise<PublicProjection>;
  lookupReceipt(
    ctx: ServerContext,
    req: { idempotencyKey: string; commandKind: string },
  ): Promise<ReceiptLookup>;
  /**
   * Idempotent and safe to call repeatedly. After close, new commands are
   * rejected with a HOST_RECOVERING-class stable code and in-flight
   * transactions are drained (bounded wait). A's composition calls this;
   * close ORDER is defined in B server-ports-recommendation.md §5.
   */
  close(): Promise<void>;
}

/** The exact factory signature B's modules/learning/index.ts must export. */
export type CreateLearningServer = (deps: LearningServerDeps) => LearningServer;
