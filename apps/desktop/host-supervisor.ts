/**
 * Host supervisor (Desktop Main side).
 *
 * Frozen requirements (ARCHITECTURE §6 / A-PLATFORM item 4):
 * - start the DSH Host with utilityProcess.fork against the packaged fixed
 *   entry (never child_process, never the user PATH), passing the
 *   independent data root and an explicit environment whitelist only;
 * - every request/response is epoch-bound: late responses from a non-current
 *   Host epoch, unknown request ids or kind mismatches are dropped and
 *   counted;
 * - when the Host dies, pending write commands resolve with
 *   RECEIPT_UNKNOWN transport semantics (the client replays the ORIGINAL
 *   idempotency key through the receipt query); reads resolve with
 *   HOST_DISCONNECTED and may be resent;
 * - shutdown handshake with escalation: DRAIN ack -> exit event; on timeout,
 *   SIGTERM then SIGKILL, and exit is still awaited (HOST_EXIT_UNPROVEN if
 *   the process never exits).
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { UtilityProcess } from 'electron';
import { utilityProcess } from 'electron';
import {
  HOST_SENDER_MAIN,
  HOST_WIRE_VERSION,
  isHostReadyMessage,
  isHostWireEvent,
  isHostWireResponse,
  transportCodeForLostRequest,
  type HostIdentityReport,
  type HostRequestKind,
  type HostSenderBinding,
  type HostWireRequest,
} from '../host/envelope';
import { PROTOCOL_VERSION } from '../../modules/contracts/public/protocol';
import type { HostPhase } from '../../modules/contracts/public/desktop';
import type { LifecycleLog } from './lifecycle-log';

/**
 * Environment whitelist handed to the Host. HOME/TMPDIR are pinned INSIDE the
 * Rondo data root so no user ~/.dsh layer or shared temp leaks in.
 * RONDO_CONTENT_ROOT is the packaged content directory (dist/content, the B
 * release layout produced by the content build).
 */
export function buildHostEnv(dataRoot: string, contentRoot: string): NodeJS.ProcessEnv {
  return {
    RONDO_DATA_ROOT: dataRoot,
    RONDO_CONTENT_ROOT: contentRoot,
    HOME: join(dataRoot, 'technical', 'home'),
    TMPDIR: join(dataRoot, 'temporary'),
    PATH: '/usr/bin:/bin',
  };
}

interface PendingEntry {
  readonly kind: HostRequestKind;
  readonly epoch: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  readonly timer: NodeJS.Timeout;
}

export interface HostRequestOptions {
  readonly timeoutMs?: number;
}

export class HostExitError extends Error {
  constructor(
    readonly transport: 'HOST_EXIT_UNPROVEN' | 'HOST_SHUTDOWN_TIMEOUT',
    message: string,
  ) {
    super(message);
    this.name = 'HostExitError';
  }
}

export class HostSupervisor {
  private child: UtilityProcess | null = null;
  private currentEpoch: string | null = null;
  private identity: HostIdentityReport | null = null;
  private readonly pending = new Map<string, PendingEntry>();
  private senderBinding: HostSenderBinding = { source: HOST_SENDER_MAIN, windowId: -1, webContentsId: -1 };
  private _phase: HostPhase = 'STARTING';
  private writesFrozen = false;
  private unknownWriteCount = 0;
  private droppedResponseCount = 0;
  private childHasExited = false;
  private exitWaiters: Array<(code: number) => void> = [];

  constructor(
    private readonly hostEntryPath: string,
    private readonly dataRoot: string,
    private readonly contentRoot: string,
    private readonly log: LifecycleLog,
    private readonly onStartFailure: (message: string) => void,
  ) {}

  get phase(): HostPhase {
    return this._phase;
  }

  get hostEpoch(): string | null {
    return this.currentEpoch;
  }

  get hostIdentity(): HostIdentityReport | null {
    return this.identity;
  }

  get pendingUnknownWriteCount(): number {
    return this.unknownWriteCount;
  }

  setSenderBinding(binding: HostSenderBinding): void {
    this.senderBinding = binding;
  }

  /** Forks the fixed Host entry and resolves with the ready identity. */
  async start(readyTimeoutMs = 30000): Promise<HostIdentityReport> {
    if (this.child) throw new Error('HOST_ALREADY_STARTED');
    this.log.write('host-fork', { entry: this.hostEntryPath, contentRoot: this.contentRoot });
    const child = utilityProcess.fork(this.hostEntryPath, [], {
      serviceName: 'rondo-host',
      stdio: 'pipe',
      env: buildHostEnv(this.dataRoot, this.contentRoot),
    });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(`[rondo-host] ${chunk.toString('utf8')}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[rondo-host] ${chunk.toString('utf8')}`);
    });
    child.on('message', (message: unknown) => this.handleInbound(message));
    child.on('exit', (code: number) => this.handleExit(code));

    return await new Promise<HostIdentityReport>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.log.write('host-boot-failed', { reason: 'HOST_START_TIMEOUT' });
        this.onStartFailure('Host 启动超时');
        reject(new Error('HOST_START_TIMEOUT'));
      }, readyTimeoutMs);
      const onReady = (identity: HostIdentityReport): void => {
        clearTimeout(timer);
        resolve(identity);
      };
      const onFail = (message: string): void => {
        clearTimeout(timer);
        reject(new Error(message));
      };
      this.readyWaiter = { onReady, onFail };
    });
  }

  private readyWaiter: { onReady: (identity: HostIdentityReport) => void; onFail: (message: string) => void } | null =
    null;

  private handleInbound(message: unknown): void {
    if (isHostReadyMessage(message)) {
      this.currentEpoch = message.hostEpoch;
      this.identity = message.identity;
      this._phase = 'READY';
      this.log.write('host-ready', { hostEpoch: message.hostEpoch, identity: message.identity });
      this.readyWaiter?.onReady(message.identity);
      this.readyWaiter = null;
      return;
    }
    if (isHostWireEvent(message)) {
      if (this.currentEpoch !== null && message.hostEpoch !== this.currentEpoch) return;
      this.onEvent?.(message.kind, message.notice);
      return;
    }
    if (!isHostWireResponse(message)) return;
    // Late-response guard: epoch must match the live Host and the request
    // must still be pending with the same kind.
    if (this.currentEpoch === null || message.hostEpoch !== this.currentEpoch) {
      this.droppedResponseCount += 1;
      this.log.write('host-response-dropped', { reason: 'epoch', requestId: message.requestId });
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      this.droppedResponseCount += 1;
      this.log.write('host-response-dropped', { reason: 'unknown-request', requestId: message.requestId });
      return;
    }
    if (pending.kind !== message.kind) {
      this.droppedResponseCount += 1;
      this.log.write('host-response-dropped', { reason: 'kind-mismatch', requestId: message.requestId });
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      const error = message.error ?? { code: 'INVALID_OPERATION', message: 'Host 返回未知错误' };
      pending.reject(
        Object.assign(new Error(`${error.code}: ${error.message}`), {
          hostError: error,
        }),
      );
    }
  }

  private handleExit(code: number): void {
    this.childHasExited = true;
    this.lastExitCode = code;
    this._phase = 'STOPPED';
    this.log.write('host-exit', { code, pendingCount: this.pending.size });
    for (const [requestId, pending] of [...this.pending.entries()]) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      if (pending.kind === 'command') this.unknownWriteCount += 1;
      const transport = transportCodeForLostRequest(pending.kind, false);
      pending.reject(
        Object.assign(new Error(`Host 已断开（${transport}）`), { transport, hostError: { code: 'HOST_RECOVERING', message: 'Host 进程已退出。' } }),
      );
    }
    this.readyWaiter?.onFail('Host 进程在就绪前退出');
    this.readyWaiter = null;
    for (const waiter of this.exitWaiters.splice(0)) waiter(code);
  }

  /** Fired for Host -> renderer events (invalidation in later batches). */
  onEvent: ((kind: string, notice: unknown) => void) | null = null;

  /** True when new write commands must be refused (quit flow freeze). */
  freezeWrites(reason: string): void {
    this.writesFrozen = true;
    this.frozenReason = reason;
    this._phase = 'QUIESCING';
  }

  private frozenReason: string | null = null;

  get frozenWriteReason(): string | null {
    return this.frozenReason;
  }

  canAcceptCommands(): boolean {
    return this._phase === 'READY' && !this.writesFrozen;
  }

  /** Sends one epoch-bound request. Rejects with Error carrying .transport and .hostError. */
  request(kind: HostRequestKind, payload: unknown, options: HostRequestOptions = {}): Promise<unknown> {
    if (kind === 'command' && this.writesFrozen) {
      return Promise.reject(
        Object.assign(new Error('HOST_QUIESCING: 新命令已冻结'), {
          transport: 'HOST_QUIESCING',
          hostError: { code: 'INVALID_OPERATION', message: '退出流程中，新命令已被冻结。' },
        }),
      );
    }
    if (kind !== 'status' && !this.canAcceptCommands() && !this.writesFrozen) {
      return Promise.reject(
        Object.assign(new Error('HOST_DISCONNECTED: Host 未就绪'), {
          transport: 'HOST_DISCONNECTED',
          hostError: { code: 'HOST_RECOVERING', message: 'Host 尚未就绪或已退出。' },
        }),
      );
    }
    if (!this.child || this.childHasExited) {
      const transport = transportCodeForLostRequest(kind, false);
      return Promise.reject(
        Object.assign(new Error(`HOST_DISCONNECTED: ${transport}`), {
          transport,
          hostError: { code: 'HOST_RECOVERING', message: 'Host 进程不在运行。' },
        }),
      );
    }
    const timeoutMs = options.timeoutMs ?? 15000;
    const requestId = randomUUID();
    const epoch = this.currentEpoch ?? '';
    const request: HostWireRequest = {
      direction: 'request',
      wireVersion: HOST_WIRE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      hostEpoch: epoch,
      kind,
      sender: this.senderBinding,
      payload,
    };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        if (kind === 'command') this.unknownWriteCount += 1;
        const transport = transportCodeForLostRequest(kind, true);
        reject(
          Object.assign(new Error(`HOST_RESPONSE_UNKNOWN: ${transport}`), {
            transport,
            hostError: { code: 'HOST_RECOVERING', message: 'Host 响应超时，送达状态未知。' },
          }),
        );
      }, timeoutMs);
      this.pending.set(requestId, {
        kind,
        epoch,
        resolve,
        reject,
        timer,
      });
      this.child?.postMessage(request);
    });
  }

  /** Shutdown handshake: send DRAIN/CANCEL, await real exit, escalate if needed. */
  async shutdownAndAwaitExit(mode: 'DRAIN' | 'CANCEL', timeoutMs = 30000): Promise<{ code: number; escalated: boolean }> {
    if (!this.child) return { code: -1, escalated: false };
    const child = this.child;
    if (!this.childHasExited) {
      try {
        await this.request('shutdown', { mode }, { timeoutMs: Math.min(timeoutMs, 10000) });
      } catch {
        // The ack is best-effort; the exit event below is the proof.
      }
    }
    let escalated = false;
    if (!this.childHasExited) {
      child.kill(); // SIGTERM via Electron
      escalated = true;
      const termOk = await this.waitForExit(5000);
      if (!termOk && child.pid != null) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
    const exited = await this.waitForExit(Math.max(timeoutMs - 5000, 5000));
    if (!exited) {
      throw new HostExitError('HOST_EXIT_UNPROVEN', 'Host 进程未在超时内退出，退出未被证实。');
    }
    return { code: this.lastExitCode ?? -1, escalated };
  }

  private lastExitCode: number | null = null;

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.childHasExited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
      this.exitWaiters.push((code) => {
        clearTimeout(timer);
        this.lastExitCode = code;
        resolve(true);
      });
    });
  }

  stats(): { droppedResponses: number; unknownWrites: number; pending: number } {
    return { droppedResponses: this.droppedResponseCount, unknownWrites: this.unknownWriteCount, pending: this.pending.size };
  }
}
