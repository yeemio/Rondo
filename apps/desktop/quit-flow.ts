/**
 * Quit-flow state machine (pure, Electron-free; unit tested).
 *
 * Frozen sequence (A-PLATFORM / ARCHITECTURE §6): freeze new commands ->
 * prompt about unsaved drafts (cancellable) -> wait for the Host to really
 * exit (database closed inside that handshake) -> report completion -> quit.
 * The observable phase set is the frozen QuitFlowPhase union.
 *
 * Cancelling is only possible while the flow is still in PROMPTING; once
 * writes are frozen (SAVING) the flow is irreversible. CANCELLED is an
 * observable terminal readback; the machine then resets to IDLE.
 */
import type { QuitFlowPhase } from '../../modules/contracts/public/desktop';

export type QuitFlowEvent =
  | { type: 'BEGIN' }
  | { type: 'HOST_STATUS'; needsPrompt: boolean }
  | { type: 'PROMPT_DISCARDED' }
  | { type: 'PROMPT_CANCELLED' }
  | { type: 'CANCEL_REQUESTED' }
  | { type: 'HOST_EXITED' }
  | { type: 'HOST_EXIT_FAILED' }
  | { type: 'QUIT_PERFORMED' };

export type QuitFlowAction =
  | { type: 'QUERY_HOST_STATUS' }
  | { type: 'SHOW_PROMPT' }
  | { type: 'FREEZE_WRITES' }
  | { type: 'SEND_SHUTDOWN' }
  | { type: 'WAIT_HOST_EXIT' }
  | { type: 'ESCALATE_KILL' }
  | { type: 'QUIT_APP' }
  | { type: 'RESET_TO_IDLE' }
  | { type: 'REJECT_CANCEL' };

export interface QuitFlowMachineState {
  readonly phase: QuitFlowPhase;
  /** True once new write commands must be refused. */
  readonly writesFrozen: boolean;
  /** Terminal phase already observed by the renderer once. */
  readonly terminalObserved: boolean;
}

export const QUIT_FLOW_IDLE: QuitFlowMachineState = {
  phase: 'IDLE',
  writesFrozen: false,
  terminalObserved: false,
};

export interface QuitFlowTransition {
  readonly state: QuitFlowMachineState;
  readonly actions: readonly QuitFlowAction[];
}

export function transition(state: QuitFlowMachineState, event: QuitFlowEvent): QuitFlowTransition {
  switch (state.phase) {
    case 'IDLE': {
      if (event.type === 'BEGIN') {
        return { state: { ...state, phase: 'PROMPTING' }, actions: [{ type: 'QUERY_HOST_STATUS' }] };
      }
      return { state, actions: [] };
    }
    case 'PROMPTING': {
      if (event.type === 'HOST_STATUS' && !event.needsPrompt) {
        return {
          state: { ...state, phase: 'SAVING', writesFrozen: true },
          actions: [{ type: 'FREEZE_WRITES' }, { type: 'SEND_SHUTDOWN' }, { type: 'WAIT_HOST_EXIT' }],
        };
      }
      if (event.type === 'HOST_STATUS' && event.needsPrompt) {
        return { state, actions: [{ type: 'SHOW_PROMPT' }] };
      }
      if (event.type === 'PROMPT_DISCARDED') {
        return {
          state: { ...state, phase: 'SAVING', writesFrozen: true },
          actions: [{ type: 'FREEZE_WRITES' }, { type: 'SEND_SHUTDOWN' }, { type: 'WAIT_HOST_EXIT' }],
        };
      }
      if (event.type === 'PROMPT_CANCELLED' || event.type === 'CANCEL_REQUESTED') {
        return {
          state: { ...state, phase: 'CANCELLED', terminalObserved: true },
          actions: [{ type: 'RESET_TO_IDLE' }],
        };
      }
      return { state, actions: [] };
    }
    case 'SAVING': {
      if (event.type === 'HOST_EXITED') {
        return { state: { ...state, phase: 'COMPLETING' }, actions: [] };
      }
      if (event.type === 'HOST_EXIT_FAILED') {
        return { state: { ...state, phase: 'COMPLETING' }, actions: [{ type: 'ESCALATE_KILL' }] };
      }
      if (event.type === 'CANCEL_REQUESTED') {
        return { state, actions: [{ type: 'REJECT_CANCEL' }] };
      }
      return { state, actions: [] };
    }
    case 'COMPLETING': {
      if (event.type === 'QUIT_PERFORMED') {
        return {
          state: { ...state, phase: 'COMPLETED', terminalObserved: true },
          actions: [{ type: 'QUIT_APP' }],
        };
      }
      return { state, actions: [] };
    }
    // CANCELLED / COMPLETED / COMPLETING-terminal states: no further events.
    default:
      return { state, actions: [] };
  }
}
