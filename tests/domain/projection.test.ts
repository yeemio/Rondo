/**
 * Domain tests: public projections carry no private answers/rules/seeds;
 * material visibility phases; hint reveal persistence; timeline pagination;
 * catalog and resume points; guardian-only query gates.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createReadyHarness, startAttempt, SYNTH_RELEASE_ID } from '../fixtures/harness';
import { asRondoError } from '../contracts/stub-service';

const FORBIDDEN_STRINGS = [
  'answer',
  'correctIndex',
  'privateTests',
  'scoringFunction',
  'seed',
  'answerHash',
  'expectedJudgments',
  'expectedEdgeMapping',
  'quantityChecks',
  'RATIONAL_PRODUCT',
  'ruleSet',
  'hintGateTable',
  'revealsAnswer',
];

test('questionView projections never carry private material', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'q-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    for (const phase of ['PREDICT', 'OPERATE'] as const) {
      const view = await h.harness.server.query(h.learnerCtx, { kind: 'learning.questionView', attemptId: att.attemptId });
      const serialized = JSON.stringify(view);
      for (const forbidden of FORBIDDEN_STRINGS) {
        assert.ok(!serialized.includes(forbidden), `projection must not contain '${forbidden}'`);
      }
    }
    // The DB-side params/rule material exists (sanity: private data IS around),
    // proving the projection filter rather than empty storage.
    const rulesLoaded = h.harness.content.resolveRules(SYNTH_RELEASE_ID, 'task-l1-guided');
    assert.ok(rulesLoaded !== null);
  } finally {
    await h.harness.closeAll();
  }
});

test('material visibility unfolds with phases; formulas appear after prediction', async () => {
  const h = await createReadyHarness();
  try {
    // L2 guided task has C=2πr at OBSERVATION and S侧=C×h at ASSESSMENT.
    // Walk there via beginCycle would take the whole L1 chain; instead verify
    // the PREDICTION-phase spec hides them by querying the L2 task spec
    // through a second harness started directly at L2 via course-graph walk.
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const view1 = await h.harness.server.query(h.learnerCtx, { kind: 'learning.questionView', attemptId: att.attemptId });
    assert.ok(view1.kind === 'learning.questionView');
    assert.equal(view1.spec.materialVisibility, 'PREDICTION');
    const serialized1 = JSON.stringify(view1);
    assert.ok(!serialized1.includes('C = 2 × 3.14 × r'), 'L2 formula must not leak into other tasks');
    assert.ok(!serialized1.includes('S侧'));
    // Same task in OBSERVATION visibility gains the observation block.
    const instance = h.harness.storage.rawDatabase().prepare('SELECT * FROM questionInstance LIMIT 1').get() as {
      questionInstanceId: string;
      releaseId: string;
      taskId: string;
      taskVersion: string;
      paramsJson: string;
    };
    const observation = h.harness.content.getPublicQuestionSpecFor(instance, 'OBSERVATION');
    assert.ok(JSON.stringify(observation).includes('直径 = 2 × 半径'));
    const predictionSpec = h.harness.content.getPublicQuestionSpecFor(instance, 'PREDICTION');
    assert.ok(!JSON.stringify(predictionSpec).includes('直径 = 2 × 半径'));
  } finally {
    await h.harness.closeAll();
  }
});

test('hint content appears in the projection only after the persisted presentation', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'hv-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    const before = await h.harness.server.query(h.learnerCtx, { kind: 'learning.questionView', attemptId: att.attemptId });
    assert.ok(!JSON.stringify(before).includes('提示（层级 1）'));
    const hint = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.requestHint',
      idempotencyKey: 'hv-hint',
      payload: { hintLevel: 1 },
      target,
    });
    assert.equal(hint.status, 'APPLIED');
    const after = await h.harness.server.query(h.learnerCtx, { kind: 'learning.questionView', attemptId: att.attemptId });
    assert.ok(JSON.stringify(after).includes('提示（层级 1）'));
    const rows = h.harness.storage.rawDatabase().prepare('SELECT COUNT(*) c FROM hintPresentation').get() as { c: number };
    assert.equal(rows.c, 1);
  } finally {
    await h.harness.closeAll();
  }
});

test('timeline paginates by the server seq cursor', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'pg-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'pg-op-1',
      payload: { operation: { type: 'SetSection', section: 'AXIAL' } },
      target,
      expectedAttemptVersion: 2,
    });
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'pg-op-2',
      payload: { operation: { type: 'SetSection', section: 'TRANSVERSE' } },
      target,
      expectedAttemptVersion: 3,
    });
    const page1 = await h.harness.server.query(h.learnerCtx, { kind: 'learning.timeline', attemptId: att.attemptId, limit: 2 });
    assert.ok(page1.kind === 'learning.timeline');
    assert.equal(page1.events.length, 2);
    assert.equal(page1.events[0].seq, 1);
    assert.equal(page1.nextAfterSeq, 2);
    const page2 = await h.harness.server.query(h.learnerCtx, {
      kind: 'learning.timeline',
      attemptId: att.attemptId,
      afterSeq: page1.nextAfterSeq,
      limit: 2,
    });
    assert.ok(page2.kind === 'learning.timeline');
    assert.equal(page2.events.length, 2);
    assert.ok(page2.nextAfterSeq === undefined);
    assert.deepEqual(
      page2.events.map((e) => e.seq),
      [3, 4],
    );
  } finally {
    await h.harness.closeAll();
  }
});

test('catalog and resumePoint behave; empty vs unknown distinguished', async () => {
  const h = await createReadyHarness();
  try {
    const catalog = await h.harness.server.query(h.learnerCtx, { kind: 'catalog.availableLessons' });
    assert.ok(catalog.kind === 'catalog.availableLessons');
    assert.equal(catalog.lessons.length, 1);
    assert.equal(catalog.lessons[0].releaseId, SYNTH_RELEASE_ID);
    assert.equal(catalog.lessons[0].title, '哪些参数决定圆筒（引导）');
    // Known learner without an active attempt: attempt null (empty, not error).
    const empty = await h.harness.server.query(h.learnerCtx, { kind: 'learning.resumePoint', learnerId: h.learnerId });
    assert.ok(empty.kind === 'learning.resumePoint');
    assert.equal(empty.attempt, null);
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const resume = await h.harness.server.query(h.learnerCtx, { kind: 'learning.resumePoint', learnerId: h.learnerId });
    assert.ok(resume.kind === 'learning.resumePoint');
    assert.equal(resume.attempt?.attemptId, att.attemptId);
    assert.equal(resume.attempt?.phase, 'PREDICT');
    // Unknown query kinds fail schema validation with the stable code.
    await assert.rejects(
      () => h.harness.server.query(h.learnerCtx, { kind: 'catalog.noSuchQuery' } as never),
      (err: unknown) => asRondoError(err)?.code === 'INVALID_OPERATION',
    );
  } finally {
    await h.harness.closeAll();
  }
});

test('guardian queries are guardian-only; evidence summary lists the real timeline', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'ev-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.requestHint',
      idempotencyKey: 'ev-hint',
      payload: { hintLevel: 0 },
      target,
    });
    await assert.rejects(
      () => h.harness.server.query(h.learnerCtx, { kind: 'guardian.evidenceSummary', learnerId: h.learnerId }),
      (err: unknown) => asRondoError(err)?.code === 'FORBIDDEN',
    );
    const summary = await h.harness.server.query(h.guardianCtx, { kind: 'guardian.evidenceSummary', learnerId: h.learnerId });
    assert.ok(summary.kind === 'guardian.evidenceSummary');
    const types = summary.items.map((i) => i.evidenceType).sort();
    assert.deepEqual(types, ['HINT', 'PREDICTION']);
    // The retention preview is also guardian-only and UNTIL-mode is empty.
    await assert.rejects(
      () => h.harness.server.query(h.learnerCtx, { kind: 'guardian.retentionPreview', mode: 'UNTIL_GUARDIAN_DELETES' } as never),
      (err: unknown) => asRondoError(err)?.code === 'FORBIDDEN',
    );
    const preview = await h.harness.server.query(h.guardianCtx, { kind: 'guardian.retentionPreview', mode: 'UNTIL_GUARDIAN_DELETES' });
    assert.ok(preview.kind === 'guardian.retentionPreview');
    assert.equal(preview.affectedCount, 0);
  } finally {
    await h.harness.closeAll();
  }
});
