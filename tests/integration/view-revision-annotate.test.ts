/**
 * Integration test: the explanation-revision view channel end to end —
 * the real ViewOps projection, the renderer adapter's unwrap of the host
 * value, and the guardian.annotateExplanation command consuming the ref.
 *
 * Regression guard for the E2E blocker C (RUN-REPORT 2026-10-27): the host
 * op returns the bare revisionId string (mirroring the mock baseline and
 * the frozen LearnerViewPort contract `Promise<string>`), while the
 * renderer adapter once unwrapped `{ revisionRef }` — yielding undefined,
 * so the rubric form reported the channel as not connected and no
 * observation was ever written. This test binds the adapter to the REAL
 * host value (not a fabricated shape): the preload face replays whatever
 * ViewOps actually returned.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Harness, createReadyHarness, startAttempt } from '../fixtures/harness';
import { ViewOps } from '../../apps/host/services/view-ops';
import type { StoragePort } from '../../modules/contracts/server/storage';
import type { ContentServiceInternal } from '../../modules/content';
import { createLearnerViewPort } from '../../adapters/desktop-client/view-port';
import type { RondoViewPreloadApi } from '../../adapters/desktop-client/preload-api';
import type { IpcResult } from '../../adapters/desktop-client/ipc-result';

test('registerExplanationRevision: host returns the bare revision id and the renderer adapter passes it through to annotateExplanation', async () => {
  const h = await createReadyHarness();
  try {
    // Drive one task to a saved explanation (same synthetic sequence as the
    // lifecycle/governance domain tests).
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    const pred = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'vr-pred',
      payload: { prediction: { claims: [{ propertyId: 'radius', direction: 'INCREASE' }] }, uncertain: false },
      target,
    });
    const op = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'vr-op',
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
      target,
      expectedAttemptVersion: pred.attemptVersion,
    });
    const sub = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'vr-sub',
      payload: { response: [{ kind: 'propertyJudgments', claims: [
        { propertyId: 'radius', direction: 'INCREASE' },
        { propertyId: 'diameter', direction: 'INCREASE' },
        { propertyId: 'height', direction: 'UNCHANGED' },
      ] }] },
      target,
      expectedAttemptVersion: op.attemptVersion,
    });
    const bex = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.beginExplanation',
      idempotencyKey: 'vr-bex',
      payload: {},
      target,
      expectedAttemptVersion: sub.attemptVersion,
    });
    const sex = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.saveExplanation',
      idempotencyKey: 'vr-sex',
      payload: { selections: [], freeText: '半径变大直径也变大', transcribedByGuardian: false },
      target,
      expectedAttemptVersion: bex.attemptVersion,
    });
    assert.equal(sex.status, 'APPLIED');

    // Host side: the exact ViewOps learning-wiring instantiates. The frozen
    // contract is the BARE revision id string (mock baseline parity).
    const views = new ViewOps({
      storage: h.harness.storage as unknown as StoragePort,
      content: h.harness.content as unknown as ContentServiceInternal,
      now: () => h.harness.clock.now(),
    });
    const serverValue = await views.registerExplanationRevision(h.guardianCtx, att.cycleId);
    assert.equal(typeof serverValue, 'string', 'view op must resolve to the bare revision id string');
    assert.ok((serverValue as string).startsWith('rev-'), `revision id keeps the rev- prefix, got: ${String(serverValue)}`);

    // Renderer side: the preload face replays the REAL host value; the
    // adapter must surface it unchanged (this is where the shape mismatch
    // lived — unwrap { revisionRef } over a string returned undefined).
    const face = {
      registerExplanationRevision: async (): Promise<IpcResult<unknown>> => ({ ok: true, value: serverValue }),
    } as unknown as RondoViewPreloadApi;
    const port = createLearnerViewPort(face);
    const revisionRef = await port.registerExplanationRevision(att.cycleId);
    assert.equal(revisionRef, serverValue, 'adapter must pass the host value through untouched');

    // The ref the UI would hand to annotateExplanation is accepted by the
    // real command path and writes exactly one observation row.
    const annotate = await h.harness.cmd(h.guardianCtx, {
      kind: 'guardian.annotateExplanation',
      idempotencyKey: 'vr-anno',
      payload: {
        explanationRevisionRef: revisionRef,
        rubric: { condition: 'ESTABLISHED', relation: 'EMERGING', basis: 'NOT_OBSERVED' },
      },
      target: { scope: 'FAMILY' },
    });
    assert.equal(annotate.status, 'APPLIED');
    const rows = h.harness.storage.rawDatabase()
      .prepare('SELECT explanationRevisionRef, conditionObserved FROM guardianObservation')
      .all() as Array<{ explanationRevisionRef: string; conditionObserved: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].explanationRevisionRef, serverValue);
    assert.equal(rows[0].conditionObserved, 'ESTABLISHED');
  } finally {
    await h.harness.closeAll();
  }
});
