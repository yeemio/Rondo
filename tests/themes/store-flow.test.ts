/**
 * THEMES-A store flow through the REAL command/query surface (frozen
 * envelopes, mock Host): micro diagnosis PASS/SUPPLEMENT routing (server-side
 * decision, learning-fact event, supplement skip/enter), grid/circle
 * operation gates, one full theme lesson with stranger + delayed transfer on
 * an injected clock, and answer-assistance forcing SUPPLEMENT.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope } from '../../modules/contracts/public/envelope';
import type { PublicCommandEnvelope } from '../../modules/contracts/public/envelope';
import { createMockRondo } from '../../modules/mock-client';
import type { MockPorts } from '../../modules/mock-client';

const DAY = 86_400_000;

let idSeq = 0;
function envelope(
  learnerId: string,
  attemptId: string | undefined,
  cycleId: string | undefined,
  kind: PublicCommandEnvelope['kind'],
  payload: unknown,
  opts: { version?: number; binding?: { releaseId: string; questionInstanceId: string } } = {},
): PublicCommandEnvelope {
  idSeq += 1;
  return parseEnvelope({
    protocolVersion: 'rondo.v1',
    commandId: `thm-cmd-${String(idSeq).padStart(5, '0')}`,
    idempotencyKey: `thm-idem-${String(idSeq).padStart(5, '0')}`,
    kind,
    target: { scope: 'LEARNER', learnerId, ...(attemptId ? { attemptId } : {}), ...(cycleId ? { cycleId } : {}) },
    ...(opts.binding ? { binding: { ...opts.binding, rendererContractVersion: '1' } } : {}),
    ...(opts.version !== undefined ? { expectedAttemptVersion: opts.version } : {}),
    payload,
  });
}

interface CycleView {
  version: number;
  cycleId: string;
  phase: string;
  taskId: string;
  sceneState: Record<string, number>;
  questionInstanceId: string;
  releaseId: string;
}

async function viewCycle(client: MockPorts, learnerId: string, attemptId: string): Promise<CycleView> {
  const av = await client.query({ kind: 'learning.attemptView', attemptId });
  assert.equal(av.kind, 'learning.attemptView');
  if (!av.currentCycle) throw new Error('no current cycle');
  const qv = await client.query({ kind: 'learning.questionView', attemptId, cycleId: av.currentCycle.cycleId });
  assert.equal(qv.kind, 'learning.questionView');
  assert.ok(['rondo.gridboard', 'rondo.cylinder'].includes(qv.spec.scene.rendererId), 'renderer 按任务族下发');
  return {
    version: av.version,
    cycleId: av.currentCycle.cycleId,
    phase: av.currentCycle.phase,
    taskId: qv.spec.taskId,
    sceneState: qv.spec.scene.state as unknown as Record<string, number>,
    questionInstanceId: qv.spec.questionInstanceId,
    releaseId: qv.spec.releaseId,
  };
}

const num = (quantityId: string, value: number, unitId: string) => ({ kind: 'numberWithUnit' as const, quantityId, value, unitId });
const frac = (quantityId: string, numerator: number, denominator: number) => ({ kind: 'fractionValue' as const, quantityId, numerator, denominator });
const choice = (selectionId: string, optionId: string) => ({ kind: 'singleChoice' as const, selectionId, optionId });
const mapItem = (pairs: Array<[string, string]>) => ({ kind: 'objectMapping' as const, pairs: pairs.map(([leftId, rightId]) => ({ leftId, rightId })) });

interface TaskScript {
  taskId: string;
  ops?: Array<Record<string, unknown>>;
  response: unknown[];
  revise?: { response: unknown[] };
  expectVerdict?: 'CORRECT' | 'REVISE';
  /** called with the FIRST submission evaluation (before any revise loop) */
  onFirstVerify?: (evaluation: unknown) => void;
}

async function runTask(client: MockPorts, learnerId: string, attemptId: string, script: TaskScript) {
  let v = await viewCycle(client, learnerId, attemptId);
  assert.equal(v.taskId, script.taskId);
  assert.equal(v.phase, 'PREDICT');
  await client.command(
    envelope(learnerId, attemptId, v.cycleId, 'learning.recordPrediction', {
      prediction: { claims: [] },
      uncertain: true,
      explanation: '[预测] 先快猜一下',
    }),
  );
  v = await viewCycle(client, learnerId, attemptId);
  assert.equal(v.phase, 'OPERATE');
  for (const op of script.ops ?? []) {
    await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.commitOperation', { operation: op }, { version: v.version, binding: { releaseId: v.releaseId, questionInstanceId: v.questionInstanceId } }));
    v = await viewCycle(client, learnerId, attemptId);
  }
  await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.submitResponse', { response: script.response }, { version: v.version, binding: { releaseId: v.releaseId, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, attemptId);
  assert.equal(v.phase, 'VERIFY');
  const firstEvaluation = client.mock.getEvaluation(v.cycleId)!;
  assert.equal(firstEvaluation.verdict, script.expectVerdict ?? 'CORRECT', `${script.taskId} verdict`);
  script.onFirstVerify?.(firstEvaluation);
  if (script.revise) {
    await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.reviseResponse', {}, { version: v.version }));
    v = await viewCycle(client, learnerId, attemptId);
    await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.submitResponse', { response: script.revise.response }, { version: v.version, binding: { releaseId: v.releaseId, questionInstanceId: v.questionInstanceId } }));
    v = await viewCycle(client, learnerId, attemptId);
    assert.equal(client.mock.getEvaluation(v.cycleId)!.verdict, 'CORRECT', `${script.taskId} after revise`);
  }
  await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.beginExplanation', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, attemptId);
  await client.command(
    envelope(learnerId, attemptId, v.cycleId, 'learning.saveExplanation', {
      selections: [{ itemId: 'explain.test', selectedOptionIds: ['opt-test'] }],
      freeText: '直径是半径的两倍。',
      transcribedByGuardian: false,
    }, { version: v.version }),
  );
  v = await viewCycle(client, learnerId, attemptId);
  assert.equal(v.phase, 'REVIEW', `${script.taskId} reaches REVIEW`);
  return v;
}

async function beginNext(client: MockPorts, learnerId: string, attemptId: string, taskId: string) {
  const v = await viewCycle(client, learnerId, attemptId);
  await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.beginCycle', { taskId }, { version: v.version }));
}

async function startAttemptFor(client: MockPorts, learnerId: string, releaseId: string, salt = '1'): Promise<string> {
  const receipt = await client.command(
    parseEnvelope({
      protocolVersion: 'rondo.v1',
      commandId: `thm-start-${releaseId}-${learnerId}-${salt}`,
      idempotencyKey: `thm-idem-start-${releaseId}-${learnerId}-${salt}`,
      kind: 'learning.startAttempt',
      target: { scope: 'LEARNER', learnerId },
      payload: { releaseId },
    }),
  );
  assert.equal(receipt.status, 'APPLIED');
  return receipt.effectRefs.find((r) => r.startsWith('attempt:'))!.slice('attempt:'.length);
}

async function enterLearnerSession(client: MockPorts): Promise<string> {
  await client.setupGuardian({
    idempotencyKey: 'setup-thm-1',
    familyDisplayName: '主题一测试家庭',
    guardianDisplayName: '妈妈',
    passphrase: 'passphrase-8chars',
  });
  const createReceipt = await client.command(
    parseEnvelope({
      protocolVersion: 'rondo.v1',
      commandId: 'thm-cmd-learner',
      idempotencyKey: 'thm-idem-learner',
      kind: 'family.createLearner',
      target: { scope: 'FAMILY' },
      payload: { alias: '小回' },
    }),
  );
  const learnerId = createReceipt.effectRefs.find((r) => r.startsWith('learner:'))!.slice('learner:'.length);
  await client.enterLearner({ learnerId });
  return learnerId;
}

test('themes-flow: 微课① PASS —— 首答全对 → 服务端判 PASS，可直接完成（补充活动跳过）', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  const att = await startAttemptFor(client, learnerId, 'rondo.thm.m1-r1');
  let v = await viewCycle(client, learnerId, att);
  assert.equal(v.sceneState.radiusMm, 25, '诊断题冻结 givens（俯视圆 r=2.5cm）');

  v = await runTask(client, learnerId, att, {
    taskId: 'thm.m1.diag.v1',
    response: [
      num('diameter-from-r', 5.0, 'cm'),
      num('radius-from-d', 6.0, 'cm'),
      choice('sel.relation', 'opt-d-eq-2r'),
      choice('sel.direction', 'INCREASE'),
    ],
  });
  const card = client.mock.getReviewCard(v.cycleId) as { diagnosis: { outcome: string; supplementTaskId: string } | null };
  assert.equal(card.diagnosis?.outcome, 'PASS', '服务端判定 PASS');
  assert.equal(card.diagnosis?.supplementTaskId, 'thm.m1.supp.v1');
  const detail = client.mock.getTimelineDetail(att) as { events: Array<{ eventType: string; payload?: Record<string, unknown> }> };
  const decided = detail.events.find((e) => e.eventType === 'MICRO_DIAGNOSIS_DECIDED');
  assert.ok(decided, '诊断判定进入学习事实（事件）');
  assert.equal(decided!.payload!.outcome, 'PASS');

  // PASS → 不打开补充活动也可完成本次学习
  const finish = await client.command(envelope(learnerId, att, v.cycleId, 'learning.finishAttempt', {}, { version: v.version }));
  assert.equal(finish.status, 'APPLIED', 'PASS 后补充活动可跳过直接完成');
});

test('themes-flow: 微课① SUPPLEMENT —— 首答有误 → 判 SUPPLEMENT，按序进入补充活动并完成', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  const att = await startAttemptFor(client, learnerId, 'rondo.thm.m1-r1');

  let v = await runTask(client, learnerId, att, {
    taskId: 'thm.m1.diag.v1',
    response: [
      num('diameter-from-r', 2.5, 'cm'), // mis-rd-no-double
      num('radius-from-d', 6.0, 'cm'),
      choice('sel.relation', 'opt-d-eq-2r'),
      choice('sel.direction', 'INCREASE'),
    ],
    revise: {
      response: [
        num('diameter-from-r', 5.0, 'cm'),
        num('radius-from-d', 6.0, 'cm'),
        choice('sel.relation', 'opt-d-eq-2r'),
        choice('sel.direction', 'INCREASE'),
      ],
    },
    expectVerdict: 'REVISE',
    onFirstVerify: (ev) => {
      assert.ok((ev as { diagnostics: string[] }).diagnostics.includes('mis-rd-no-double'), '误解诊断随首次判分返回');
    },
  });
  const card = client.mock.getReviewCard(v.cycleId) as { diagnosis: { outcome: string } | null };
  assert.equal(card.diagnosis?.outcome, 'SUPPLEMENT', '非首答全对 → SUPPLEMENT');

  await beginNext(client, learnerId, att, 'thm.m1.supp.v1');
  v = await runTask(client, learnerId, att, {
    taskId: 'thm.m1.supp.v1',
    ops: [{ type: 'SetDimension', dimension: 'RADIUS', valueMm: 35 }],
    response: [num('diameter-now', 7.0, 'cm'), num('radius-target', 6.0, 'cm')],
  });
  assert.equal(v.sceneState.radiusMm, 35, '确认后的领域状态可验证');
  const finish = await client.command(envelope(learnerId, att, v.cycleId, 'learning.finishAttempt', {}, { version: v.version }));
  assert.equal(finish.status, 'APPLIED');
});

test('themes-flow: h4 答案级提示后即使首答全对也判 SUPPLEMENT', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  const att = await startAttemptFor(client, learnerId, 'rondo.thm.m2-r1');
  let v = await viewCycle(client, learnerId, att);
  await client.command(envelope(learnerId, att, v.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
  v = await viewCycle(client, learnerId, att);
  await client.command(envelope(learnerId, att, v.cycleId, 'learning.requestHint', { hintLevel: 4 }));
  await client.command(
    envelope(learnerId, att, v.cycleId, 'learning.submitResponse', {
      response: [
        num('rect-area', 15, 'cm2'),
        choice('sel.square-unit', 'opt-1-cm2'),
        choice('sel.why-square', 'opt-length-times-length'),
        num('dm2-to-cm2', 100, 'cm2'),
      ],
    }, { version: v.version, binding: { releaseId: v.releaseId, questionInstanceId: v.questionInstanceId } }),
  );
  v = await viewCycle(client, learnerId, att);
  const card = client.mock.getReviewCard(v.cycleId) as { diagnosis: { outcome: string } | null };
  assert.equal(card.diagnosis?.outcome, 'SUPPLEMENT', '看过答案级提示不算具备');
  await client.command(envelope(learnerId, att, v.cycleId, 'learning.beginExplanation', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, att);
  await client.command(envelope(learnerId, att, v.cycleId, 'learning.saveExplanation', { selections: [], freeText: '面积是长乘宽。', transcribedByGuardian: false }, { version: v.version }));
});

test('themes-flow: 图板操作门（越界拒绝 + 圆/板族互斥）', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  const att = await startAttemptFor(client, learnerId, 'rondo.thm.t1l1-r1');
  let v = await viewCycle(client, learnerId, att);
  assert.equal(v.taskId, 'thm.f1.g1.partition-circle.v1');
  await client.command(envelope(learnerId, att, v.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
  v = await viewCycle(client, learnerId, att);
  const binding = { releaseId: v.releaseId, questionInstanceId: v.questionInstanceId };
  const op = (operation: Record<string, unknown>) =>
    client.command(envelope(learnerId, att, v.cycleId, 'learning.commitOperation', { operation }, { version: v.version, binding }));
  const rejectsCode = async (p: Promise<unknown>, messagePart: string) => {
    await assert.rejects(
      () => p,
      (err: unknown) => {
        const e = err as { code?: string; message?: string };
        return e.code === 'INVALID_OPERATION' && (e.message ?? '').includes(messagePart);
      },
      `expected INVALID_OPERATION mentioning ${messagePart}`,
    );
  };

  await rejectsCode(op({ type: 'SetGridSize', rows: 1, cols: 13 }), '份数');
  await rejectsCode(op({ type: 'SetFilled', count: 13 }), '涂色份数过大');
  await rejectsCode(op({ type: 'ScaleBoth', multiplier: 4 }), '不允许操作');
  // 圆柱操作发到图板任务：allowedOperationIds 门先拒（同样 INVALID_OPERATION）
  await rejectsCode(op({ type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 }), '不允许操作 SetDimension');

  // 合法操作：分 4 份涂 3 份（两次确认）
  await op({ type: 'SetGridSize', cols: 4 });
  v = await viewCycle(client, learnerId, att);
  await client.command(envelope(learnerId, att, v.cycleId, 'learning.commitOperation', { operation: { type: 'SetFilled', count: 3 } }, { version: v.version, binding }));
  v = await viewCycle(client, learnerId, att);
  assert.deepEqual(v.sceneState, { rows: 1, cols: 4, filled: 3 }, '确认后的领域状态精确可验证');
});

test('themes-flow: 主题一课1 全流程（g1→g2→i1→s1）+ 陌生反例 + 延迟回看状态机', async () => {
  let now = 1_700_000_000_000;
  const client = createMockRondo({ now: () => now });
  const learnerId = await enterLearnerSession(client);
  const att = await startAttemptFor(client, learnerId, 'rondo.thm.t1l1-r1');

  await runTask(client, learnerId, att, {
    taskId: 'thm.f1.g1.partition-circle.v1',
    ops: [{ type: 'SetGridSize', cols: 4 }, { type: 'SetFilled', count: 3 }],
    response: [frac('circle-fraction', 3, 4), choice('sel.denom-meaning', 'opt-total-parts'), choice('sel.unequal-parts', 'opt-no')],
  });
  await beginNext(client, learnerId, att, 'thm.f1.g2.partition-bar.v1');
  await runTask(client, learnerId, att, {
    taskId: 'thm.f1.g2.partition-bar.v1',
    ops: [{ type: 'SetGridSize', cols: 8 }, { type: 'SetFilled', count: 5 }],
    response: [frac('bar-fraction', 5, 8), choice('sel.compare-half', 'opt-58-bigger')],
  });
  await beginNext(client, learnerId, att, 'thm.f1.i1.represent.v1');
  const i1Start = await viewCycle(client, learnerId, att);
  assert.deepEqual({ cols: i1Start.sceneState.cols, filled: i1Start.sceneState.filled }, { cols: 10, filled: 7 }, '冻结实例参数替换 givens');
  await runTask(client, learnerId, att, {
    taskId: 'thm.f1.i1.represent.v1',
    response: [frac('bar-fraction', 7, 10), choice('sel.num-meaning', 'opt-num-taken')],
  });
  await beginNext(client, learnerId, att, 'thm.f1.s1.stranger-relabel.v1');
  await runTask(client, learnerId, att, {
    taskId: 'thm.f1.s1.stranger-relabel.v1',
    ops: [{ type: 'SetGridSize', cols: 4 }, { type: 'SetFilled', count: 1 }],
    response: [choice('sel.can-say-quarter', 'opt-no-not-equal'), frac('circle-fraction', 1, 4)],
  });
  let v = await viewCycle(client, learnerId, att);
  const finish = await client.command(envelope(learnerId, att, v.cycleId, 'learning.finishAttempt', {}, { version: v.version }));
  assert.equal(finish.status, 'APPLIED');

  const mig0 = client.mock.getMigration(learnerId) as { state: string; remainingDays: number; taskId: string };
  assert.equal(mig0.state, 'PLANNED');
  assert.equal(mig0.taskId, 'thm.f1.d1.delayed-transfer.v1');
  assert.equal(mig0.remainingDays, 7);

  // 未到窗口：D1 拒绝开始
  const attEarly = await startAttemptFor(client, learnerId, 'rondo.thm.t1l1-r1', 'early');
  await assert.rejects(() => beginNext(client, learnerId, attEarly, 'thm.f1.d1.delayed-transfer.v1'), (err: unknown) => (err as { code?: string }).code === 'INVALID_OPERATION');

  now += 8 * DAY;
  const mig1 = client.mock.getMigration(learnerId) as { state: string };
  assert.equal(mig1.state, 'AVAILABLE');
  const attD1 = await startAttemptFor(client, learnerId, 'rondo.thm.t1l1-r1', 'delayed');
  const d1 = await viewCycle(client, learnerId, attD1);
  assert.equal(d1.taskId, 'thm.f1.d1.delayed-transfer.v1', '窗口内新 attempt 直接开在回看任务');
  assert.equal(d1.sceneState.cols, 8, 'D1 冻结实例：8 等分');
  await runTask(client, learnerId, attD1, {
    taskId: 'thm.f1.d1.delayed-transfer.v1',
    ops: [{ type: 'SetFilled', count: 3 }],
    response: [frac('morning-fraction', 3, 8), frac('whole-day-fraction', 5, 8)],
  });
  const observed = client.mock.getMigration(learnerId) as { state: string; actualIntervalDays?: number };
  assert.equal(observed.state, 'OBSERVED');
  assert.equal(observed.actualIntervalDays, 8, '实际间隔如实记录');
});

test('themes-flow: 课2 同乘操作与课3 折扣问题链（含 REVISE→误解反馈）', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);

  const l2 = await startAttemptFor(client, learnerId, 'rondo.thm.t1l2-r1');
  await runTask(client, learnerId, l2, {
    taskId: 'thm.f2.g1.scale-bar.v1',
    ops: [{ type: 'ScaleBoth', multiplier: 2 }],
    response: [frac('scaled-fraction', 2, 4), choice('sel.size-change', 'opt-same-size'), choice('sel.why-equal', 'opt-both-scaled')],
  });
  await beginNext(client, learnerId, l2, 'thm.f2.g2.equivalent-find.v1');
  // 先答只缩分子的 6/4 → REVISE + 误解标签 + 不泄漏答案的反馈，再改正
  let v = await runTask(client, learnerId, l2, {
    taskId: 'thm.f2.g2.equivalent-find.v1',
    ops: [{ type: 'ScaleBoth', multiplier: 2 }],
    response: [frac('scaled-fraction', 6, 4), choice('sel.why-eq', 'opt-num-den-same-times')],
    revise: { response: [frac('scaled-fraction', 6, 8), choice('sel.why-eq', 'opt-num-den-same-times')] },
    expectVerdict: 'REVISE',
    onFirstVerify: (ev) => {
      const e = ev as { itemResults: Array<{ feedback?: string }>; diagnostics: string[] };
      assert.ok(e.diagnostics.includes('mis-numerator-only-scaled'), '误解标签记录');
      assert.ok(e.itemResults.some((r) => r.feedback?.includes('分子') || r.feedback?.includes('分母')), '误解定向反馈');
      assert.ok(!JSON.stringify(e.itemResults).includes('6/8'), '反馈不泄漏期望分数');
    },
  });

  const l3 = await startAttemptFor(client, learnerId, 'rondo.thm.t1l3-r1');
  await runTask(client, learnerId, l3, {
    taskId: 'thm.f3.g1.percent-board.v1',
    ops: [{ type: 'SetFilled', count: 75 }],
    response: [num('percent-value', 75, 'percent'), choice('sel.percent-meaning', 'opt-part-of-hundred'), num('percent-units', 75, 'ge')],
  });
  await beginNext(client, learnerId, l3, 'thm.f3.g2.discount-chain.v1');
  await runTask(client, learnerId, l3, {
    taskId: 'thm.f3.g2.discount-chain.v1',
    ops: [{ type: 'SetFilled', count: 80 }],
    response: [num('fold-percent', 80, 'percent'), num('pay-amount', 64.0, 'yuan'), num('save-amount', 16.0, 'yuan')],
  });
  void v;
});

test('themes-flow: 微课④ 分类板（objectMapping 承载可操作对象）全对/全错', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  const att = await startAttemptFor(client, learnerId, 'rondo.thm.m4-r1');
  await runTask(client, learnerId, att, {
    taskId: 'thm.m4.diag.v1',
    response: [
      mapItem([['unit-cm', 'dim-length'], ['unit-cm2', 'dim-area'], ['unit-cm3', 'dim-volume']]),
      choice('sel.desk', 'opt-area-unit'),
      choice('sel.m2-to-dm2', 'opt-100'),
      choice('sel.cube', 'opt-1-cm3'),
    ],
  });
  const card0 = client.mock.getReviewCard((await viewCycle(client, learnerId, att)).cycleId) as { diagnosis: { outcome: string } | null };
  assert.equal(card0.diagnosis?.outcome, 'PASS', '微课④首答全对判 PASS');
  const v = await viewCycle(client, learnerId, att);
  const finish = await client.command(envelope(learnerId, att, v.cycleId, 'learning.finishAttempt', {}, { version: v.version }));
  assert.equal(finish.status, 'APPLIED');
});
