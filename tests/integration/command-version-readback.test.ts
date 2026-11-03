/**
 * Integration: the 2026-10-27 browser defect — a recordPrediction immediately
 * followed by commitOperation on the same page is intermittently rejected
 * with VERSION_CONFLICT ("版本冲突：操作所基于的版本已过期。"), while a full
 * page reload reads the new version and the very same operation succeeds.
 *
 * Root cause split, pinned here against the REAL server + SqliteStorage +
 * real L1 release (same wiring as learning-wiring.ts):
 *
 * 1. The server is innocent (fix option (a) already holds): after every
 *    APPLIED version-bumping command, the receipt's attemptVersion equals
 *    what an immediate learning.attemptView read returns, and the strictly
 *    sequential command -> query -> command model NEVER conflicts — the exact
 *    browser sequence beginCycle(expected=5)->6, recordPrediction->7,
 *    commitOperation(expected=7) goes through APPLIED.
 *
 * 2. The defect mechanism (deterministic repro): a refresh whose storage read
 *    is enqueued while the command is still in flight legitimately observes
 *    the PRE-commit snapshot (the single serialized connection answers it
 *    before the write transaction). The pre-fix Player applied refresh
 *    results in ARRIVAL order with no monotonic guard, and it discarded the
 *    receipt's attemptVersion entirely — so a stale refresh response landing
 *    after the post-command one regressed state.attemptVersion by one beat,
 *    and the next command built from that state carried the stale version.
 *    The server then correctly answered VERSION_CONFLICT.
 *
 * 3. The fix rule (Player.runCommand/refresh, function-level): adopt the
 *    APPLIED receipt's attemptVersion immediately, and ignore refresh results
 *    older than the last applied version — nextExpected = max(receipt,
 *    refresh). Modeled here, the same raced sequence goes through APPLIED.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createReadyHarness } from '../fixtures/harness';
import { applyReleaseStatusChange } from '../../modules/learning/maintenance';
import type { ReleaseStatus } from '../../modules/contracts/server/content';
import type { LearningPolicySet } from '../../modules/contracts/server/learning';
import type { PublicProjection } from '../../modules/contracts/public/queries';
import type { RondoError } from '../../modules/contracts/public/errors';
import type { CommandKind } from '../../modules/contracts/public/envelope';

const ROOT = process.cwd();
const DIST_CONTENT = join(ROOT, 'dist', 'content');
const L1_RELEASE = 'rondo.cyl.l1-r1';
const G1 = 'cyl.param.g1.view-invariance.v1';
const G2 = 'cyl.param.g2.radius-change.v1';
const G3 = 'cyl.param.g3.height-section.v1';
const L1_TASK_ORDER = [G1, G2, G3, 'cyl.param.i1.identify-changes.v1', 'cyl.param.i2.predict-single-change.v1'];

function l1Policy(): LearningPolicySet {
  return {
    courseGraph: L1_TASK_ORDER.map((taskId, i) => ({ taskId, nextTaskIds: i + 1 < L1_TASK_ORDER.length ? [L1_TASK_ORDER[i + 1]] : [] })),
    hintPolicy: L1_TASK_ORDER.map((taskId) => ({ taskId, maxLevel: 4 })),
    defaultRetention: { mode: 'UNTIL_GUARDIAN_DELETES' },
  };
}

interface AttemptSnapshot {
  readonly version: number;
  readonly phase: string;
}

test('server: sequential command->query->command after recordPrediction never conflicts; receipts carry the post-command version', async () => {
  const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-content.mjs')], { encoding: 'utf8' });
  assert.equal(build.status, 0, `build-content failed:\n${build.stderr}`);
  assert.ok(existsSync(join(DIST_CONTENT, L1_RELEASE, 'manifest.json')), 'dist/content L1 manifest missing');

  const h = await createReadyHarness({ contentRoot: DIST_CONTENT, policy: l1Policy() });
  try {
    await h.harness.content.loadRelease(DIST_CONTENT, L1_RELEASE);
    for (const step of [['DRAFT', 'REVIEWED'], ['REVIEWED', 'AVAILABLE']] as const) {
      const current = await h.harness.storage.read(
        async (repos) => await repos.contentRelease.findById({ familyId: '', actorId: '' }, L1_RELEASE),
      );
      if (current !== null && current.status === (step[0] as ReleaseStatus)) {
        await applyReleaseStatusChange(h.harness.storage, () => h.harness.clock.now(), {
          releaseId: L1_RELEASE,
          to: step[1] as ReleaseStatus,
          reason: 'test-version-readback',
        });
      }
    }

    const view = async (): Promise<AttemptSnapshot> => {
      const p = (await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId })) as PublicProjection;
      if (p.kind !== 'learning.attemptView') throw new Error('bad projection kind');
      return { version: p.version, phase: p.currentCycle?.phase ?? 'NONE' };
    };
    /** Receipt-vs-projection integrity: the receipt IS the new version. */
    const assertReceiptMatchesRead = async (label: string, receiptVersion: number | undefined): Promise<void> => {
      assert.ok(typeof receiptVersion === 'number', `${label}: receipt must carry attemptVersion`);
      const read = await view();
      assert.equal(read.version, receiptVersion, `${label}: immediate attemptView must equal receipt.attemptVersion`);
    };

    const started = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.startAttempt',
      idempotencyKey: 'vr-start',
      payload: { releaseId: L1_RELEASE },
      target: { scope: 'LEARNER', learnerId: h.learnerId },
    });
    assert.equal(started.status, 'APPLIED');
    const attemptId = started.effectRefs.find((r) => r.startsWith('attempt:'))!.slice('attempt:'.length);
    const cycleIdOf = async (): Promise<string> => {
      const p = (await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId })) as Extract<PublicProjection, { kind: 'learning.attemptView' }>;
      if (p.currentCycle === null) throw new Error('no current cycle');
      return p.currentCycle.cycleId;
    };
    const target = () => ({ scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId });
    const withCycle = () => ({ ...target(), cycleId: currentCycleId });
    let currentCycleId = await cycleIdOf();

    // --- walk g1 (zero-op, all-UNCHANGED) to REVIEW ---------------------------
    const unchanged = ['radius', 'diameter', 'height'].map((propertyId) => ({ propertyId, direction: 'UNCHANGED' }));
    const g1pred = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'vr-g1-pred',
      payload: { prediction: { claims: unchanged }, uncertain: false },
      target: withCycle(),
    });
    assert.equal(g1pred.status, 'APPLIED');
    await assertReceiptMatchesRead('g1 recordPrediction', g1pred.attemptVersion);
    const g1sub = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'vr-g1-sub',
      payload: { response: [{ kind: 'propertyJudgments', claims: unchanged }] },
      target: withCycle(),
      expectedAttemptVersion: g1pred.attemptVersion,
    });
    assert.equal(g1sub.status, 'APPLIED');
    await assertReceiptMatchesRead('g1 submitResponse', g1sub.attemptVersion);
    const g1ex = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.beginExplanation',
      idempotencyKey: 'vr-g1-bex',
      payload: {},
      target: withCycle(),
      expectedAttemptVersion: g1sub.attemptVersion,
    });
    assert.equal(g1ex.status, 'APPLIED');
    const g1save = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.saveExplanation',
      idempotencyKey: 'vr-g1-ex',
      payload: { selections: [], freeText: '因为只是转动观察。', transcribedByGuardian: false },
      target: withCycle(),
      expectedAttemptVersion: g1ex.attemptVersion,
    });
    assert.equal(g1save.status, 'APPLIED');
    assert.equal((await view()).phase, 'REVIEW', 'g1 must reach REVIEW');

    // === the browser sequence (fixed evidence): beginCycle(expected=5) ========
    const before = await view();
    assert.equal(before.version, 5, 'version arithmetic must match the browser evidence (beginCycle expected=5)');
    const begin = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.beginCycle',
      idempotencyKey: 'vr-g2-begin',
      payload: { taskId: G2 },
      target: target(),
      expectedAttemptVersion: before.version,
    });
    assert.equal(begin.status, 'APPLIED');
    assert.equal(begin.attemptVersion, 6, 'beginCycle(expected=5) must land on version 6 (browser evidence)');
    await assertReceiptMatchesRead('beginCycle', begin.attemptVersion);
    currentCycleId = await cycleIdOf();

    const pred = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'vr-g2-pred',
      payload: { prediction: { claims: [{ propertyId: 'diameter', direction: 'INCREASE' }] }, uncertain: false },
      target: withCycle(),
    });
    assert.equal(pred.status, 'APPLIED');
    assert.equal(pred.attemptVersion, 7, 'recordPrediction must land on version 7 (browser evidence)');
    await assertReceiptMatchesRead('recordPrediction', pred.attemptVersion);

    // Sequential model: the client refreshes after the receipt, then commits.
    const afterPred = await view();
    assert.deepEqual(afterPred, { version: 7, phase: 'OPERATE' }, 'post-command refresh must read the committed state');
    const commit = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'vr-g2-commit',
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
      target: withCycle(),
      expectedAttemptVersion: afterPred.version,
    });
    assert.equal(commit.status, 'APPLIED', 'sequential command->query->command must never conflict');
    assert.equal(commit.attemptVersion, 8);
  } finally {
    await h.harness.closeAll();
  }
});

test('defect mechanism: a refresh racing the in-flight command reads the pre-commit snapshot; refresh-only client then hits VERSION_CONFLICT, receipt-adopting client does not', async () => {
  const h = await createReadyHarness({ contentRoot: DIST_CONTENT, policy: l1Policy() });
  try {
    await h.harness.content.loadRelease(DIST_CONTENT, L1_RELEASE);
    for (const step of [['DRAFT', 'REVIEWED'], ['REVIEWED', 'AVAILABLE']] as const) {
      const current = await h.harness.storage.read(
        async (repos) => await repos.contentRelease.findById({ familyId: '', actorId: '' }, L1_RELEASE),
      );
      if (current !== null && current.status === (step[0] as ReleaseStatus)) {
        await applyReleaseStatusChange(h.harness.storage, () => h.harness.clock.now(), {
          releaseId: L1_RELEASE,
          to: step[1] as ReleaseStatus,
          reason: 'test-version-readback-race',
        });
      }
    }

    const view = async (): Promise<AttemptSnapshot> => {
      const p = (await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId })) as PublicProjection;
      if (p.kind !== 'learning.attemptView') throw new Error('bad projection kind');
      return { version: p.version, phase: p.currentCycle?.phase ?? 'NONE' };
    };

    const started = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.startAttempt',
      idempotencyKey: 'vr2-start',
      payload: { releaseId: L1_RELEASE },
      target: { scope: 'LEARNER', learnerId: h.learnerId },
    });
    assert.equal(started.status, 'APPLIED');
    const attemptId = started.effectRefs.find((r) => r.startsWith('attempt:'))!.slice('attempt:'.length);
    const cycleIdOf = async (): Promise<string> => {
      const p = (await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId })) as Extract<PublicProjection, { kind: 'learning.attemptView' }>;
      if (p.currentCycle === null) throw new Error('no current cycle');
      return p.currentCycle.cycleId;
    };
    let currentCycleId = await cycleIdOf();
    const target = () => ({ scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId });
    const withCycle = () => ({ ...target(), cycleId: currentCycleId });

    // g1 to REVIEW (all-UNCHANGED, zero-op).
    const unchanged = ['radius', 'diameter', 'height'].map((propertyId) => ({ propertyId, direction: 'UNCHANGED' }));
    let lastVersion = started.attemptVersion!;
    const step = async (kind: CommandKind, key: string, payload: unknown, withVersion: boolean) => {
      const r = await h.harness.cmd(h.learnerCtx, {
        kind,
        idempotencyKey: key,
        payload,
        target: withCycle(),
        ...(withVersion ? { expectedAttemptVersion: lastVersion } : {}),
      });
      assert.equal(r.status, 'APPLIED', `${kind} must be APPLIED`);
      lastVersion = r.attemptVersion ?? lastVersion;
      return r;
    };
    await step('learning.recordPrediction', 'vr2-g1-pred', { prediction: { claims: unchanged }, uncertain: false }, false);
    await step('learning.submitResponse', 'vr2-g1-sub', { response: [{ kind: 'propertyJudgments', claims: unchanged }] }, true);
    await step('learning.beginExplanation', 'vr2-g1-bex', {}, true);
    await step('learning.saveExplanation', 'vr2-g1-ex', { selections: [], freeText: '因为只是转动观察。', transcribedByGuardian: false }, true);
    assert.equal((await view()).phase, 'REVIEW');

    // g2 cycle; commit RADIUS 40 and judge CORRECT (also exercises the G2 rule
    // parity fix end-to-end), then walk to REVIEW and begin g3.
    await step('learning.beginCycle', 'vr2-g2-begin', { taskId: G2 }, true);
    currentCycleId = await cycleIdOf();
    await step('learning.recordPrediction', 'vr2-g2-pred', { prediction: { claims: [{ propertyId: 'diameter', direction: 'INCREASE' }] }, uncertain: false }, false);
    await step('learning.commitOperation', 'vr2-g2-commit', { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } }, true);
    await step('learning.submitResponse', 'vr2-g2-sub', {
      response: [
        { kind: 'propertyJudgments', claims: [{ propertyId: 'diameter', direction: 'INCREASE' }] },
        { kind: 'numberWithUnit', quantityId: 'diameter', unitId: 'cm', value: 8 },
      ],
    }, true);
    await step('learning.beginExplanation', 'vr2-g2-bex', {}, true);
    await step('learning.saveExplanation', 'vr2-g2-ex', { selections: [], freeText: '直径是半径的两倍。', transcribedByGuardian: false }, true);
    assert.equal((await view()).phase, 'REVIEW');
    await step('learning.beginCycle', 'vr2-g3-begin', { taskId: G3 }, true);
    currentCycleId = await cycleIdOf();
    const preCommit = await view();
    assert.equal(preCommit.phase, 'PREDICT');

    // === THE RACE, deterministic in-process =====================================
    // Player's unawaited/tick refreshes can be in flight while the next command
    // is still on the wire; when the refresh's storage read enqueues BEFORE the
    // command's write transaction (routine once the command handler's parse +
    // hash + context work interleaves), the read answers the PRE-commit state.
    const racingRead = view(); // enqueued first -> deterministically pre-commit
    const predReceipt = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'vr2-g3-pred',
      payload: { prediction: { claims: [{ propertyId: 'height', direction: 'INCREASE' }] }, uncertain: false },
      target: withCycle(),
    });
    assert.equal(predReceipt.status, 'APPLIED');
    const postRead = await view();
    const staleRead = await racingRead; // late delivery: applied AFTER the fresh read
    assert.equal(staleRead.version, preCommit.version, 'racing read must observe the pre-commit snapshot (stale by one beat)');
    assert.equal(staleRead.phase, 'PREDICT');
    assert.equal(predReceipt.attemptVersion, preCommit.version + 1, 'receipt carries the committed version');
    assert.deepEqual(postRead, { version: predReceipt.attemptVersion!, phase: 'OPERATE' }, 'post-command read is committed state');

    // Pre-fix client rule (refresh-only, last write wins): the stale refresh
    // result regresses state.attemptVersion -> next command conflicts.
    const preFixStateVersion = staleRead.version;
    await assert.rejects(
      h.harness.cmd(h.learnerCtx, {
        kind: 'learning.commitOperation',
        idempotencyKey: 'vr2-g3-commit-prefix',
        payload: { operation: { type: 'SetDimension', dimension: 'HEIGHT', valueMm: 100 } },
        target: withCycle(),
        expectedAttemptVersion: preFixStateVersion,
      }),
      (err: unknown) => {
        const e = err as RondoError;
        assert.equal(e.code, 'VERSION_CONFLICT', 'the browser failure: stale expected version must be rejected');
        return true;
      },
      'stale expected version must be rejected as VERSION_CONFLICT (the observed defect)',
    );

    // Fixed client rule (Player.runCommand adopts the receipt's attemptVersion;
    // refresh ignores results older than the last applied version):
    // nextExpected = max(receipt.attemptVersion, latest refresh) — the same
    // raced sequence goes through APPLIED (the reload-then-retry outcome,
    // without needing the reload).
    const fixedStateVersion = Math.max(predReceipt.attemptVersion ?? 0, postRead.version, staleRead.version);
    assert.equal(fixedStateVersion, predReceipt.attemptVersion);
    const commitFixed = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'vr2-g3-commit-fixed',
      payload: { operation: { type: 'SetDimension', dimension: 'HEIGHT', valueMm: 100 } },
      target: withCycle(),
      expectedAttemptVersion: fixedStateVersion,
    });
    assert.equal(commitFixed.status, 'APPLIED', 'receipt-adopting client must not conflict after the raced refresh');
    assert.equal(commitFixed.attemptVersion, fixedStateVersion + 1);
  } finally {
    await h.harness.closeAll();
  }
});
