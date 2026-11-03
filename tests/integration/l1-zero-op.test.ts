/**
 * Integration: the REAL first-batch L1 release registers through B's frozen
 * content schemas (GAP-1 ruling, 2026-10-27: L1 pure-observation tasks —
 * cyl.param.g1/i1/i2 — legally carry an empty allowedOperationIds set;
 * SCENE-CONTRACTS §3 L1 row 1, orbiting the object only changes ViewState),
 * and a zero-operation task runs the real full flow
 * predict -> (OPERATE with zero ops) -> submit -> judge to a CORRECT verdict.
 *
 * The test rebuilds dist/content first (deterministic builder) so it never
 * judges against a stale build product.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createReadyHarness } from '../fixtures/harness';
import { applyReleaseStatusChange } from '../../modules/learning/maintenance';
import type { ReleaseStatus } from '../../modules/contracts/server/content';

const ROOT = process.cwd();
const DIST_CONTENT = join(ROOT, 'dist', 'content');
const L1_RELEASE = 'rondo.cyl.l1-r1';
const L1_FIRST_TASK = 'cyl.param.g1.view-invariance.v1';

test('real L1 release registers; zero-op task full flow predict->submit->judge is CORRECT', async () => {
  // Deterministic rebuild of the B release layout the Host loads.
  const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-content.mjs')], { encoding: 'utf8' });
  assert.equal(build.status, 0, `build-content failed:\n${build.stderr}`);
  assert.ok(existsSync(join(DIST_CONTENT, L1_RELEASE, 'manifest.json')), 'dist/content L1 manifest missing');

  const h = await createReadyHarness();
  try {
    // Registration itself: the frozen task-file schema must ACCEPT the L1
    // tasks whose allowedOperationIds is [] (this is the GAP-1 refusal site).
    const record = await h.harness.content.loadRelease(DIST_CONTENT, L1_RELEASE);
    assert.equal(record.manifest.public.taskIds[0], L1_FIRST_TASK);
    const spec = h.harness.content.getTaskSpec(L1_RELEASE, L1_FIRST_TASK);
    assert.ok(spec !== null, 'L1 first task spec not loaded');
    assert.deepEqual(spec.file.allowedOperationIds, [], 'g1 must be a zero-operation task');

    // Advance the status machine to AVAILABLE (host-startup reconcile path).
    for (const step of [['DRAFT', 'REVIEWED'], ['REVIEWED', 'AVAILABLE']] as const) {
      const current = await h.harness.storage.read(
        async (repos) => await repos.contentRelease.findById({ familyId: '', actorId: '' }, L1_RELEASE),
      );
      if (current !== null && current.status === (step[0] as ReleaseStatus)) {
        await applyReleaseStatusChange(h.harness.storage, () => h.harness.clock.now(), {
          releaseId: L1_RELEASE,
          to: step[1] as ReleaseStatus,
          reason: 'test-l1-registration',
        });
      }
    }

    // Full flow on the real zero-op task through the real command surface.
    const started = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.startAttempt',
      idempotencyKey: 'l1-zero-op-start',
      payload: { releaseId: L1_RELEASE },
      target: { scope: 'LEARNER', learnerId: h.learnerId },
    });
    assert.equal(started.status, 'APPLIED');
    const attemptId = started.effectRefs.find((r) => r.startsWith('attempt:'))!.slice('attempt:'.length);
    const view = await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId });
    assert.ok(view.kind === 'learning.attemptView');
    const cycleId = view.currentCycle!.cycleId;
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId, cycleId };

    const pred = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'l1-zero-op-pred',
      payload: { prediction: { claims: [{ propertyId: 'radius', direction: 'UNCHANGED' }] }, uncertain: false },
      target,
    });
    assert.equal(pred.status, 'APPLIED');

    // OPERATE is zero-op: ANY operation is refused for this task (REJECTED
    // receipt, INVALID_OPERATION), and the refusal must not consume the
    // attempt version.
    const refused = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'l1-zero-op-op-refused',
      payload: { operation: { type: 'SetUnroll', valuePermille: 500 } },
      target,
      expectedAttemptVersion: pred.attemptVersion!,
    });
    assert.equal(refused.status, 'REJECTED', 'zero-op task must refuse commitOperation');
    assert.equal(refused.errorCode, 'INVALID_OPERATION');

    // Submit the structured judgment directly from OPERATE (no operation
    // ever committed): view rotation changes nothing, so all UNCHANGED.
    const sub = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'l1-zero-op-sub',
      payload: {
        response: [
          {
            kind: 'propertyJudgments',
            claims: [
              { propertyId: 'radius', direction: 'UNCHANGED' },
              { propertyId: 'diameter', direction: 'UNCHANGED' },
              { propertyId: 'height', direction: 'UNCHANGED' },
            ],
          },
        ],
      },
      target,
      expectedAttemptVersion: pred.attemptVersion!,
    });
    assert.equal(sub.status, 'APPLIED');

    // Real judging through the v2 rule body (rule.cylParam.changeClassify.v1,
    // all-UNCHANGED branch) — verdict CORRECT, cycle now VERIFY.
    const evalRow = h.harness.storage
      .rawDatabase()
      .prepare('SELECT outcome FROM evaluation ORDER BY rowid DESC LIMIT 1')
      .get() as { outcome: string };
    assert.equal(evalRow.outcome, 'CORRECT');
    const after = await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId });
    assert.ok(after.kind === 'learning.attemptView');
    assert.equal(after.currentCycle?.phase, 'VERIFY');
  } finally {
    await h.harness.closeAll();
  }
});
