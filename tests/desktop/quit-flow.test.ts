/**
 * Unit tests for the pure quit-flow machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUIT_FLOW_IDLE, transition } from '../../apps/desktop/quit-flow';

test('no-prompt path: IDLE -> PROMPTING -> SAVING -> COMPLETING -> COMPLETED with freeze first', () => {
  let state = QUIT_FLOW_IDLE;
  state = transition(state, { type: 'BEGIN' }).state;
  assert.equal(state.phase, 'PROMPTING');

  const saving = transition(state, { type: 'HOST_STATUS', needsPrompt: false });
  assert.equal(saving.state.phase, 'SAVING');
  assert.equal(saving.state.writesFrozen, true);
  assert.deepEqual(
    saving.actions.map((action) => action.type),
    ['FREEZE_WRITES', 'SEND_SHUTDOWN', 'WAIT_HOST_EXIT'],
    'writes freeze before the shutdown handshake starts',
  );

  const completing = transition(saving.state, { type: 'HOST_EXITED' }).state;
  assert.equal(completing.phase, 'COMPLETING');

  const done = transition(completing, { type: 'QUIT_PERFORMED' });
  assert.equal(done.state.phase, 'COMPLETED');
  assert.deepEqual(done.actions.map((action) => action.type), ['QUIT_APP']);
});

test('prompt path: cancelling returns CANCELLED and resets to IDLE', () => {
  let state = QUIT_FLOW_IDLE;
  state = transition(state, { type: 'BEGIN' }).state;
  const prompted = transition(state, { type: 'HOST_STATUS', needsPrompt: true });
  assert.equal(prompted.state.phase, 'PROMPTING');
  assert.deepEqual(prompted.actions.map((action) => action.type), ['SHOW_PROMPT']);

  const cancelled = transition(prompted.state, { type: 'PROMPT_CANCELLED' });
  assert.equal(cancelled.state.phase, 'CANCELLED');
  assert.deepEqual(cancelled.actions.map((action) => action.type), ['RESET_TO_IDLE']);

  const reset = transition(cancelled.state, { type: 'PROMPT_DISCARDED' });
  // After CANCELLED terminal observation the machine ignores stale events.
  assert.equal(reset.state.phase, 'CANCELLED');
});

test('discarding drafts proceeds to SAVING', () => {
  let state = QUIT_FLOW_IDLE;
  state = transition(state, { type: 'BEGIN' }).state;
  state = transition(state, { type: 'HOST_STATUS', needsPrompt: true }).state;
  const discarded = transition(state, { type: 'PROMPT_DISCARDED' });
  assert.equal(discarded.state.phase, 'SAVING');
  assert.equal(discarded.state.writesFrozen, true);
});

test('cancel is rejected once saving (irreversible)', () => {
  let state = QUIT_FLOW_IDLE;
  state = transition(state, { type: 'BEGIN' }).state;
  state = transition(state, { type: 'HOST_STATUS', needsPrompt: false }).state;
  const result = transition(state, { type: 'CANCEL_REQUESTED' });
  assert.equal(result.state.phase, 'SAVING');
  assert.deepEqual(result.actions.map((action) => action.type), ['REJECT_CANCEL']);
});

test('cancelQuit during PROMPTING (before any dialog choice) aborts to CANCELLED', () => {
  let state = QUIT_FLOW_IDLE;
  state = transition(state, { type: 'BEGIN' }).state;
  const cancelled = transition(state, { type: 'CANCEL_REQUESTED' });
  assert.equal(cancelled.state.phase, 'CANCELLED');
});

test('BEGIN from a non-idle state does nothing', () => {
  const state = { phase: 'SAVING' as const, writesFrozen: true, terminalObserved: false };
  const result = transition(state, { type: 'BEGIN' });
  assert.equal(result.state.phase, 'SAVING');
  assert.deepEqual(result.actions, []);
});
