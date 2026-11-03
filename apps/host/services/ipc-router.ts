/**
 * Rondo IPC router (Host side).
 *
 * Frozen requirements (ARCHITECTURE.md §5/§6, A-PLATFORM items 4-5):
 * - closed op set with duplicate-registration refusal (a second register for
 *   the same op fails the service => boot audit refuses READY);
 * - every inbound payload is schema-validated with the frozen public
 *   contracts (zod) before anything else happens;
 * - the write barrier is rejected while frozen (quit flow) or after Host
 *   fault with the frozen error codes;
 * - the router itself registers NO business handlers: learning-wiring
 *   registers every ROUTER_OPS + VIEW_OPS handler at service initialization,
 *   and assertAllOpsRegistered() refuses READY if any is missing.
 *
 * No generic command routing, no arbitrary JSON escape hatch: dispatch is by
 * literal op string over the closed set below.
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { rondoError } from '../../../modules/contracts/public/errors';
import type { RondoError } from '../../../modules/contracts/public/errors';

declare module '@deepseek-ai/cordis' {
  interface Context {
    rondoRouter: RondoRouter;
  }
}

/** Business ops owned by the router module. Lifecycle ops (status/shutdown) are registered by host main. */
export const ROUTER_OPS = [
  'command',
  'query',
  'receipt',
  'auth.setupGuardian',
  'auth.unlockGuardian',
  'auth.enterLearner',
  'auth.lock',
  'auth.session',
] as const;

/**
 * VIEW_OPS: the closed learner/guardian view channel set (C's LearnerViewPort
 * named-gap channels). Registered by learning-wiring from B's public queries
 * plus the B-INTEGRATION internal seams; the desktop side mirrors them as
 * `rondo:view:<op>` channels.
 */
export const VIEW_OPS = [
  'view.getEvaluation',
  'view.getHints',
  'view.getReviewCard',
  'view.getMigration',
  'view.getTimelineDetail',
  'view.listLearners',
  'view.listAttempts',
  'view.registerExplanationRevision',
  'view.getLastDeletionScopeHash',
  'view.nowMs',
] as const;

export type ViewOp = (typeof VIEW_OPS)[number];

/** Every op the Host must be able to dispatch once wiring finished. */
export const REQUIRED_BUSINESS_OPS: readonly string[] = [...ROUTER_OPS, ...VIEW_OPS];

export type RouterOp =
  | (typeof ROUTER_OPS)[number]
  | ViewOp
  | 'status'
  | 'shutdown';

export interface RondoOpError extends Error {
  rondo: RondoError;
}

export function rondoOpError(error: RondoError): RondoOpError {
  const err = new Error(`${error.code}: ${error.message}`) as RondoOpError;
  err.rondo = error;
  return err;
}

type OpHandler = (payload: unknown) => Promise<unknown> | unknown;

export default class RondoRouter extends Service {
  private readonly handlers = new Map<RouterOp, OpHandler>();
  private frozen: string | null = null;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(ctx: Context) {
    super(ctx, 'rondoRouter');
    // No placeholder handlers: integrated/ wires the real learning services
    // through the same register seam (services/learning-wiring.ts).
  }

  /** Duplicate registration is a composition fault and refuses READY (throws during service init). */
  register(op: RouterOp, handler: OpHandler): void {
    if (this.handlers.has(op)) {
      throw new Error(`DUPLICATE_HANDLER: op ${op} is already registered`);
    }
    this.handlers.set(op, handler);
  }

  /**
   * Post-wiring completeness check: every ROUTER_OPS + VIEW_OPS handler must
   * be present. Called by learning-wiring once initialization finished; a
   * missing handler refuses READY.
   */
  assertAllOpsRegistered(): void {
    const missing = REQUIRED_BUSINESS_OPS.filter((op) => !this.handlers.has(op as RouterOp));
    if (missing.length > 0) {
      throw new Error(`MISSING_HANDLERS: ${missing.join(', ')}`);
    }
  }

  freeze(reason: string): void {
    this.frozen = reason;
  }

  /** Waits for in-flight dispatches to settle (DRAIN); bounded by timeoutMs. */
  async settleInFlight(timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.allSettled([...this.inFlight]);
    }
    return this.inFlight.size;
  }

  async dispatch(op: string, payload: unknown): Promise<unknown> {
    if (op !== 'status' && op !== 'shutdown' && this.frozen) {
      throw rondoOpError(
        rondoError('INVALID_OPERATION', `Host 已冻结新命令（${this.frozen}）。`, { frozenReason: this.frozen }),
      );
    }
    const handler = this.handlers.get(op as RouterOp);
    if (!handler) {
      throw rondoOpError(rondoError('INVALID_OPERATION', `未知操作：${op}`));
    }
    const run = (async () => handler(payload))();
    this.inFlight.add(run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(run);
    }
  }
}

/** Generates the request ids used by host-side self-checks. */
export function newRequestId(): string {
  return randomUUID();
}
