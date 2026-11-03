/**
 * Quit-flow controller: wires the pure quit-flow machine (quit-flow.ts) to
 * the Host supervisor, the unsaved-draft prompt dialog and app.quit().
 *
 * The renderer observes the frozen QuitFlowPhase values only. Cancelling is
 * possible while PROMPTING; after writes freeze (SAVING) the flow is
 * irreversible and finishes with a verified Host exit before quitting.
 */
import { app, dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import type { HostStatusProjection, QuitFlowPhase } from '../../modules/contracts/public/desktop';
import type { HostInternalStatus } from '../host/envelope';
import {
  QUIT_FLOW_IDLE,
  transition,
  type QuitFlowEvent,
  type QuitFlowMachineState,
} from './quit-flow';
import type { HostSupervisor } from './host-supervisor';
import type { LifecycleLog } from './lifecycle-log';

export interface QuitFlowControllerDeps {
  supervisor: HostSupervisor;
  getWindow(): BrowserWindow | null;
  log: LifecycleLog;
}

export class QuitFlowController {
  private state: QuitFlowMachineState = QUIT_FLOW_IDLE;
  /** Resolve the pending requestQuit invoke once the flow reaches a terminal phase. */
  private waiter: ((phase: QuitFlowPhase) => void) | null = null;
  private quitAllowed = false;

  constructor(private readonly deps: QuitFlowControllerDeps) {}

  get phase(): QuitFlowPhase {
    return this.state.phase;
  }

  get isQuitAllowed(): boolean {
    return this.quitAllowed;
  }

  hostStatusProjection(): HostStatusProjection {
    return {
      hostPhase: this.deps.supervisor.phase,
      canAcceptCommands: this.deps.supervisor.canAcceptCommands(),
      pendingUnknownCommands: this.deps.supervisor.pendingUnknownWriteCount > 0,
    };
  }

  async requestQuit(): Promise<QuitFlowPhase> {
    if (this.state.phase !== 'IDLE') {
      // Already running: settle with the flow's terminal/observable phase.
      if (this.state.phase === 'CANCELLED' || this.state.phase === 'COMPLETED') return this.state.phase;
      return await new Promise<QuitFlowPhase>((resolve) => {
        const prev = this.waiter;
        this.waiter = (phase) => {
          prev?.(phase);
          resolve(phase);
        };
      });
    }
    return await new Promise<QuitFlowPhase>((resolve) => {
      this.waiter = resolve;
      this.dispatch({ type: 'BEGIN' });
    });
  }

  async cancelQuit(): Promise<QuitFlowPhase> {
    const phase = await this.dispatchCancelable();
    return phase;
  }

  private async dispatchCancelable(): Promise<QuitFlowPhase> {
    this.dispatch({ type: 'CANCEL_REQUESTED' });
    return this.state.phase;
  }

  private dispatch(event: QuitFlowEvent): void {
    const before = this.state.phase;
    const result = transition(this.state, event);
    this.state = result.state;
    if (before !== this.state.phase) {
      this.deps.log.write('quit-flow', { from: before, to: this.state.phase });
    }
    for (const action of result.actions) void this.runAction(action);
  }

  private async runAction(action: ReturnType<typeof transition>['actions'][number]): Promise<void> {
    switch (action.type) {
      case 'QUERY_HOST_STATUS': {
        let needsPrompt = false;
        try {
          const status = (await this.deps.supervisor.request('status', null, { timeoutMs: 5000 })) as
            | HostInternalStatus
            | undefined;
          needsPrompt =
            !!status &&
            (status.pendingUnknownCommands || status.unsavedDraftCount > 0 || this.deps.supervisor.pendingUnknownWriteCount > 0);
        } catch {
          // Host unreachable: treat unknown delivery state as prompt-worthy.
          needsPrompt = this.deps.supervisor.pendingUnknownWriteCount > 0;
        }
        this.dispatch({ type: 'HOST_STATUS', needsPrompt });
        return;
      }
      case 'SHOW_PROMPT': {
        const window = this.deps.getWindow();
        const options = {
          type: 'warning' as const,
          buttons: ['放弃更改并退出', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          message: '有未保存的草稿或送达状态未知的命令',
          detail: '取消可继续当前工作；选择退出将丢弃未保存更改，已确认的记录不会丢失。',
        };
        const choice = window
          ? await dialog.showMessageBox(window, options)
          : await dialog.showMessageBox(options);
        this.dispatch({ type: choice.response === 1 ? 'PROMPT_CANCELLED' : 'PROMPT_DISCARDED' });
        return;
      }
      case 'FREEZE_WRITES': {
        this.deps.supervisor.freezeWrites('quit-flow');
        return;
      }
      case 'SEND_SHUTDOWN':
      case 'WAIT_HOST_EXIT': {
        // Handled together: shutdown handshake awaits the real exit.
        try {
          const outcome = await this.deps.supervisor.shutdownAndAwaitExit('DRAIN', 30000);
          this.deps.log.write('quit-flow', { step: 'host-exit-verified', code: outcome.code, escalated: outcome.escalated });
          this.dispatch({ type: 'HOST_EXITED' });
        } catch (err) {
          this.deps.log.write('quit-flow', {
            step: 'host-exit-unproven',
            detail: err instanceof Error ? err.message : String(err),
          });
          this.dispatch({ type: 'HOST_EXIT_FAILED' });
        }
        // COMPLETING is an observable transient; the flow finishes by design
        // right after the Host exit was proven (or escalated).
        this.dispatch({ type: 'QUIT_PERFORMED' });
        return;
      }
      case 'ESCALATE_KILL': {
        this.deps.log.write('quit-flow', { step: 'escalate-kill' });
        this.dispatch({ type: 'HOST_EXITED' });
        return;
      }
      case 'QUIT_APP': {
        this.quitAllowed = true;
        this.settleWaiter('COMPLETED');
        this.deps.log.write('app-exit', { reason: 'quit-flow-completed' });
        app.quit();
        return;
      }
      case 'RESET_TO_IDLE': {
        this.settleWaiter('CANCELLED');
        this.state = { ...QUIT_FLOW_IDLE };
        return;
      }
      case 'REJECT_CANCEL':
      default:
        return;
    }
  }

  private settleWaiter(phase: QuitFlowPhase): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(phase);
  }
}
