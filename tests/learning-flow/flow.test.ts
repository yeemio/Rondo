/**
 * Learning-flow tests: a synthetic learner drives the two lessons, the
 * stranger task and the delayed transfer through the REAL command/query
 * surface (frozen envelopes, mock Host), covering:
 *  - happy path L1 (5 tasks) + L2 (7 tasks) with correct answers,
 *  - REVISE loop + hint levels + answer-assistance marking,
 *  - idempotency (same key same payload → one effect; different payload → conflict),
 *  - receipt-unknown resolution by the ORIGINAL key (no resend under a new key),
 *  - delayed-transfer state machine on a real injected clock (PLANNED →
 *    AVAILABLE at +7d → STARTED → OBSERVED with actual interval),
 *  - WebGL context loss mid-task continuing the same attempt with no
 *    resubmission; SVG-only path producing identical evaluations,
 *  - public spec leak scans per phase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope } from '../../modules/contracts/public/envelope';
import type { PublicCommandEnvelope } from '../../modules/contracts/public/envelope';
import { createMockRondo } from '../../modules/mock-client';
import type { MockPorts } from '../../modules/mock-client';
import { SceneController, type SceneRenderer } from '../../modules/scenes/cylinder/controller';
import { lateralAreaRationalCm2, rationalToDecimal } from '../../modules/scenes/cylinder/geometry';

const RELEASE_L1 = 'rondo.cyl.l1-r1';
const RELEASE_L2 = 'rondo.cyl.l2-r1';
type FlowScene = { radiusMm: number; heightMm: number; unrollPermille: number; section: string; layerCount?: number; visibleLayerCount?: number } | { rows: number; cols: number; filled: number } | { program: unknown[]; inputs: Record<string, number>; cursorStep: number };
function cyl(state: { sceneState: FlowScene }): { radiusMm: number; heightMm: number; unrollPermille: number; section: string; layerCount?: number; visibleLayerCount?: number } {
  return state.sceneState as { radiusMm: number; heightMm: number; unrollPermille: number; section: string; layerCount?: number; visibleLayerCount?: number };
}
function layer(state: { sceneState: FlowScene }): { layerCount: number; visibleLayerCount: number } {
  return state.sceneState as { layerCount: number; visibleLayerCount: number };
}
const RELEASE_L3 = 'rondo.cyl.l3-r1';
const RELEASE_L4 = 'rondo.cyl.l4-r1';
const DAY = 86_400_000;

/** envelope binding rendererContractVersion — L3 stays @1, L4 needs @2 (L34-1) */
let bindingVersion = '1';
function setBindingVersion(v: '1' | '2') {
  bindingVersion = v;
}

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
    commandId: `cmd-${String(idSeq).padStart(5, '0')}`,
    idempotencyKey: `idem-${String(idSeq).padStart(5, '0')}`,
    kind,
    target: { scope: 'LEARNER', learnerId, ...(attemptId ? { attemptId } : {}), ...(cycleId ? { cycleId } : {}) },
    ...(opts.binding ? { binding: { ...opts.binding, rendererContractVersion: bindingVersion } } : {}),
    ...(opts.version !== undefined ? { expectedAttemptVersion: opts.version } : {}),
    payload,
  });
}

interface CycleView {
  version: number;
  cycleId: string;
  phase: string;
  taskId: string;
  sceneState: { radiusMm: number; heightMm: number; unrollPermille: number; section: string; layerCount?: number; visibleLayerCount?: number } | { rows: number; cols: number; filled: number } | { program: unknown[]; inputs: Record<string, number>; cursorStep: number };
  rendererContractVersion: string;
  questionInstanceId: string;
  releaseId: string;
}

async function viewCycle(client: MockPorts, learnerId: string, attemptId: string): Promise<CycleView> {
  const av = await client.query({ kind: 'learning.attemptView', attemptId });
  assert.equal(av.kind, 'learning.attemptView');
  if (!av.currentCycle) throw new Error('no current cycle');
  const qv = await client.query({ kind: 'learning.questionView', attemptId, cycleId: av.currentCycle.cycleId });
  assert.equal(qv.kind, 'learning.questionView');
  if ('activity' in qv.spec.scene.state) throw new Error('legacy fixture expected a legacy scene');
  return {
    version: av.version,
    cycleId: av.currentCycle.cycleId,
    phase: av.currentCycle.phase,
    taskId: qv.spec.taskId,
    sceneState: qv.spec.scene.state,
    rendererContractVersion: qv.spec.scene.rendererContractVersion,
    questionInstanceId: qv.spec.questionInstanceId,
    releaseId: qv.spec.releaseId,
  };
}

const claims = (items: Array<[string, string]>) => ({
  kind: 'propertyJudgments' as const,
  claims: items.map(([propertyId, direction]) => ({ propertyId, direction })),
});
const mapping = (pairs: Array<[string, string]>) => ({
  kind: 'objectMapping' as const,
  pairs: pairs.map(([leftId, rightId]) => ({ leftId, rightId })),
});
const numberItem = (quantityId: string, value: number, unitId: string) => ({
  kind: 'numberWithUnit' as const,
  quantityId,
  value,
  unitId,
});

const PAIRING: Array<[string, string]> = [
  ['net-edge-1', 'cyl-part-height-line'],
  ['net-edge-2', 'cyl-part-upper-circle'],
  ['net-edge-3', 'cyl-part-height-line'],
  ['net-edge-4', 'cyl-part-lower-circle'],
];
const DIRECTION: Array<[string, string]> = [
  ['net-edge-1', 'cyl-part-height-line'],
  ['net-edge-2', 'cyl-part-base-circle'],
  ['net-edge-3', 'cyl-part-height-line'],
  ['net-edge-4', 'cyl-part-base-circle'],
];

async function startAttemptFor(client: MockPorts, learnerId: string, releaseId: string, salt = '1'): Promise<string> {
  const receipt = await client.command(
    parseEnvelope({
      protocolVersion: 'rondo.v1',
      commandId: `cmd-start-${releaseId}-${learnerId}-${salt}`,
      idempotencyKey: `idem-start-${releaseId}-${learnerId}-${salt}`,
      kind: 'learning.startAttempt',
      target: { scope: 'LEARNER', learnerId },
      payload: { releaseId },
    }),
  );
  assert.equal(receipt.status, 'APPLIED');
  const attemptId = receipt.effectRefs.find((r) => r.startsWith('attempt:'))!.slice('attempt:'.length);
  return attemptId;
}

interface TaskScript {
  taskId: string;
  prediction?: { claims?: Array<{ propertyId: string; direction: string }>; uncertain?: boolean; explanation?: string };
  ops?: Array<{ type: string } & Record<string, unknown>>;
  response: unknown[];
  revise?: { response: unknown[] };
  explanation?: string;
}

async function runTask(client: MockPorts, learnerId: string, attemptId: string, script: TaskScript, expectVerdict: 'CORRECT' | 'REVISE' = 'CORRECT') {
  let v = await viewCycle(client, learnerId, attemptId);
  assert.equal(v.taskId, script.taskId, `expected task ${script.taskId}, at ${v.taskId}`);

  // PREDICT — first prediction persists before anything observable happens
  assert.equal(v.phase, 'PREDICT');
  await client.command(
    envelope(learnerId, attemptId, v.cycleId, 'learning.recordPrediction', {
      prediction: { claims: script.prediction?.claims ?? [] },
      uncertain: script.prediction?.uncertain ?? (script.prediction?.claims ?? []).length === 0,
      ...(script.prediction?.explanation ? { explanation: script.prediction.explanation } : {}),
    }),
  );
  v = await viewCycle(client, learnerId, attemptId);
  assert.equal(v.phase, 'OPERATE', `${script.taskId}: prediction must unlock OPERATE`);

  // OPERATE — one confirmed typed op at a time
  for (const op of script.ops ?? []) {
    await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.commitOperation', { operation: op }, { version: v.version, binding: { releaseId: v.releaseId, questionInstanceId: v.questionInstanceId } }));
    v = await viewCycle(client, learnerId, attemptId);
  }

  // VERIFY — submit; REVISE loop optional
  await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.submitResponse', { response: script.response }, { version: v.version, binding: { releaseId: v.releaseId, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, attemptId);
  assert.equal(v.phase, 'VERIFY');
  let evaluation = client.mock.getEvaluation(v.cycleId)!;
  assert.equal(evaluation.verdict, expectVerdict, `${script.taskId} verdict`);
  if (script.revise) {
    await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.reviseResponse', {}, { version: v.version }));
    v = await viewCycle(client, learnerId, attemptId);
    assert.equal(v.phase, 'OPERATE', 'revise returns to OPERATE');
    await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.submitResponse', { response: script.revise.response }, { version: v.version, binding: { releaseId: v.releaseId, questionInstanceId: v.questionInstanceId } }));
    v = await viewCycle(client, learnerId, attemptId);
    evaluation = client.mock.getEvaluation(v.cycleId)!;
    assert.equal(evaluation.verdict, 'CORRECT', `${script.taskId} after revise`);
  }

  // EXPLAIN — structured selections + free text + no proxy marking
  await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.beginExplanation', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, attemptId);
  assert.equal(v.phase, 'EXPLAIN');
  await client.command(
    envelope(learnerId, attemptId, v.cycleId, 'learning.saveExplanation', {
      selections: [{ itemId: 'explain.test', selectedOptionIds: ['opt-test'] }],
      freeText: script.explanation ?? '我把两件事分开了：看的角度和物体自己的大小。',
      transcribedByGuardian: false,
    }, { version: v.version }),
  );
  v = await viewCycle(client, learnerId, attemptId);
  assert.equal(v.phase, 'REVIEW', `${script.taskId} reaches REVIEW`);
  return v;
}

async function beginNext(client: MockPorts, learnerId: string, attemptId: string, taskId: string): Promise<void> {
  const v = await viewCycle(client, learnerId, attemptId);
  await client.command(envelope(learnerId, attemptId, v.cycleId, 'learning.beginCycle', { taskId }, { version: v.version }));
}

function fakeRenderer(): { renderer: SceneRenderer; renders: number } {
  const bag = { renders: 0 };
  return {
    renderer: {
      render() {
        bag.renders += 1;
      },
    },
    renders: 0,
    get renders2() {
      return bag.renders;
    },
  } as never;
}

async function enterLearnerSession(client: MockPorts): Promise<string> {
  await client.setupGuardian({
    idempotencyKey: 'setup-flow-1',
    familyDisplayName: '测试家庭',
    guardianDisplayName: '妈妈',
    passphrase: 'passphrase-8chars',
  });
  const createReceipt = await client.command(
    parseEnvelope({
      protocolVersion: 'rondo.v1',
      commandId: 'cmd-flow-learner',
      idempotencyKey: 'idem-flow-learner',
      kind: 'family.createLearner',
      target: { scope: 'FAMILY' },
      payload: { alias: '小回' },
    }),
  );
  assert.equal(createReceipt.status, 'APPLIED');
  const learnerId = createReceipt.effectRefs.find((r) => r.startsWith('learner:'))!.slice('learner:'.length);
  await client.enterLearner({ learnerId });
  return learnerId;
}

test('flow: full L1 + L2 + stranger journey with correct answers', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);

  // ---------------- L1 ----------------
  const l1 = await startAttemptFor(client, learnerId, RELEASE_L1);
  await runTask(client, learnerId, l1, {
    taskId: 'cyl.param.g1.view-invariance.v1',
    prediction: { claims: [{ propertyId: 'radius', direction: 'UNCHANGED' }] },
    response: [claims([['radius', 'UNCHANGED'], ['diameter', 'UNCHANGED'], ['height', 'UNCHANGED']])],
    explanation: '转动只是换一个角度看，尺寸数字没动。',
  });
  await beginNext(client, learnerId, l1, 'cyl.param.g2.radius-change.v1');
  await runTask(client, learnerId, l1, {
    taskId: 'cyl.param.g2.radius-change.v1',
    prediction: { claims: [{ propertyId: 'diameter', direction: 'INCREASE' }], explanation: '[预测] 新的直径大约是 8.0 cm' },
    ops: [{ type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 }],
    response: [claims([['diameter', 'INCREASE']]), numberItem('diameter', 8, 'cm')],
    explanation: '直径=半径×2，高度没动。',
  });
  await beginNext(client, learnerId, l1, 'cyl.param.g3.height-section.v1');
  await runTask(client, learnerId, l1, {
    taskId: 'cyl.param.g3.height-section.v1',
    prediction: { claims: [{ propertyId: 'height', direction: 'INCREASE' }] },
    ops: [
      { type: 'SetDimension', dimension: 'HEIGHT', valueMm: 100 },
      { type: 'SetSection', section: 'AXIAL' },
    ],
    response: [
      claims([['height', 'INCREASE']]),
      numberItem('height', 10, 'cm'),
      mapping([['cyl-part-height-line', 'section-view-axial']]),
    ],
    explanation: '轴截面里有和高一样长的边。',
  });
  // I1: script applies silently at prediction time; labels never shown
  const beforeI1 = await viewCycle(client, learnerId, l1);
  await beginNext(client, learnerId, l1, 'cyl.param.i1.identify-changes.v1');
  const i1Start = await viewCycle(client, learnerId, l1);
  assert.equal((i1Start.sceneState as { radiusMm: number }).radiusMm, 45, 'I1 initial state from frozen instance');
  const specJson1 = JSON.stringify(
    (await client.query({ kind: 'learning.questionView', attemptId: l1, cycleId: i1Start.cycleId })).kind === 'learning.questionView',
  );
  assert.ok(!specJson1.includes('script'), 'spec must not carry script metadata');
  await runTask(client, learnerId, l1, {
    taskId: 'cyl.param.i1.identify-changes.v1',
    prediction: { claims: [{ propertyId: 'radius', direction: 'DECREASE' }], explanation: '[预测] 若改变的是半径→直径变大；若改变的是高度→直径不变' },
    response: [claims([['radius', 'DECREASE'], ['diameter', 'DECREASE'], ['height', 'UNCHANGED']])],
    explanation: '固定视角对比前后轮廓：宽度变窄了，高度没变。',
  });
  const afterI1 = await viewCycle(client, learnerId, l1);
  assert.equal((afterI1.sceneState as { radiusMm: number }).radiusMm, 30, 'content-script change applied at prediction transaction');
  assert.equal((afterI1.sceneState as { heightMm: number }).heightMm, 120);
  void beforeI1;
  await beginNext(client, learnerId, l1, 'cyl.param.i2.predict-single-change.v1');
  await runTask(client, learnerId, l1, {
    taskId: 'cyl.param.i2.predict-single-change.v1',
    prediction: { claims: [{ propertyId: 'diameter', direction: 'UNCHANGED' }], explanation: '[预测] 新的直径大约是 4.0 cm' },
    response: [claims([['diameter', 'UNCHANGED']]), numberItem('diameter', 40, 'mm')], // mm equivalence accepted
    explanation: '改高度不影响直径。',
  });
  // finishAttempt requires the current expected version; query it explicitly
  const v1 = await viewCycle(client, learnerId, l1);
  const finish1 = await client.command(envelope(learnerId, l1, v1.cycleId, 'learning.finishAttempt', {}, { version: v1.version }));
  assert.equal(finish1.status, 'APPLIED');

  // ---------------- L2 ----------------
  const l2 = await startAttemptFor(client, learnerId, RELEASE_L2);
  await runTask(client, learnerId, l2, {
    taskId: 'cyl.net.g1.unroll-observe.v1',
    prediction: { uncertain: true, explanation: '[预测] 我猜边 2 和边 4 是圆周的边' },
    ops: [
      { type: 'SetUnroll', valuePermille: 1000 },
      { type: 'SetUnroll', valuePermille: 0 },
    ],
    response: [mapping(DIRECTION)],
    explanation: '摊开没有拉伸纸，长度都保留。',
  });
  await beginNext(client, learnerId, l2, 'cyl.net.g2.edge-pairing.v1');
  await runTask(client, learnerId, l2, { taskId: 'cyl.net.g2.edge-pairing.v1', ops: [{ type: 'SetUnroll', valuePermille: 1000 }], response: [mapping(PAIRING)] });
  await beginNext(client, learnerId, l2, 'cyl.net.g3.lateral-area.v1');
  // G3 explores dimensions; the area answer is judged against the CONFIRMED snapshot
  const g3Explore = { type: 'SetDimension', dimension: 'RADIUS', valueMm: 35 } as const;
  const areaAtSnapshot = rationalToDecimal(lateralAreaRationalCm2(35, 80), 2); // 2×3.14×3.5×8.0
  assert.equal(areaAtSnapshot, '175.84');
  await runTask(client, learnerId, l2, {
    taskId: 'cyl.net.g3.lateral-area.v1',
    prediction: { uncertain: true, explanation: '[预测] 面积大约 150 平方厘米' },
    ops: [g3Explore, { type: 'SetUnroll', valuePermille: 1000 }],
    response: [numberItem('lateral-area', 175.84, 'cm2')],
    explanation: '先算周长再乘高；两个底面不算进去。',
  });
  await beginNext(client, learnerId, l2, 'cyl.net.i1.pair-normal.v1');
  await runTask(client, learnerId, l2, { taskId: 'cyl.net.i1.pair-normal.v1', ops: [{ type: 'SetUnroll', valuePermille: 1000 }], response: [mapping(PAIRING)] });
  await beginNext(client, learnerId, l2, 'cyl.net.i2.pair-tall-thin.v1');
  await runTask(client, learnerId, l2, { taskId: 'cyl.net.i2.pair-tall-thin.v1', ops: [{ type: 'SetUnroll', valuePermille: 1000 }], response: [mapping(PAIRING)] });
  await beginNext(client, learnerId, l2, 'cyl.net.i3.area-value-unit.v1');
  await runTask(client, learnerId, l2, { taskId: 'cyl.net.i3.area-value-unit.v1', response: [numberItem('lateral-area', 157.0, 'cm2')] });
  await beginNext(client, learnerId, l2, 'cyl.net.s1.stranger-relabel.v1');
  const s1End = await runTask(client, learnerId, l2, {
    taskId: 'cyl.net.s1.stranger-relabel.v1',
    ops: [{ type: 'SetUnroll', valuePermille: 1000 }, { type: 'SetUnroll', valuePermille: 0 }],
    response: [
      numberItem('radius', 1.5, 'cm'),
      mapping(PAIRING),
      mapping(DIRECTION),
      numberItem('lateral-area', 84.78, 'cm2'),
    ],
    explanation: '贴纸只包侧面；r=d÷2=1.5；C=9.42；S=9.42×9.0。',
  });
  assert.equal(s1End.phase, 'REVIEW');
  const v2 = await viewCycle(client, learnerId, l2);
  const finish2 = await client.command(envelope(learnerId, l2, v2.cycleId, 'learning.finishAttempt', {}, { version: v2.version }));
  assert.equal(finish2.status, 'APPLIED');

  // guardian read-back
  await client.lock();
  await client.unlockGuardian({ passphrase: 'passphrase-8chars' });
  const summary = await client.query({ kind: 'guardian.evidenceSummary', learnerId });
  assert.equal(summary.kind, 'guardian.evidenceSummary');
  assert.ok(summary.items.length >= 24, `timeline evidence items recorded, got ${summary.items.length}`);
  const timeline = await client.query({ kind: 'learning.timeline', attemptId: l2 });
  assert.equal(timeline.kind, 'learning.timeline');
  assert.ok(timeline.events.length > 0);
});

test('flow: REVISE loop, hints, answer-assistance marking, restricted feedback', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  const l1 = await startAttemptFor(client, learnerId, RELEASE_L1);

  // wrong G1 answer (the classic misconception: rotation changes size)
  await runTask(client, learnerId, l1, {
    taskId: 'cyl.param.g1.view-invariance.v1',
    prediction: { claims: [{ propertyId: 'radius', direction: 'INCREASE' }] },
    ops: [],
    response: [claims([['radius', 'INCREASE'], ['diameter', 'INCREASE'], ['height', 'UNCHANGED']])],
    revise: { response: [claims([['radius', 'UNCHANGED'], ['diameter', 'UNCHANGED'], ['height', 'UNCHANGED']])] },
    explanation: '我一开始以为放大了就是变大了。',
  }, 'REVISE');

  // hint ladder on G2
  await beginNext(client, learnerId, l1, 'cyl.param.g2.radius-change.v1');
  let v = await viewCycle(client, learnerId, l1);
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.recordPrediction', {
    prediction: { claims: [{ propertyId: 'diameter', direction: 'INCREASE' }] },
    uncertain: false,
  }));
  v = await viewCycle(client, learnerId, l1);
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.requestHint', { hintLevel: 2 }));
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.requestHint', { hintLevel: 4 })); // answer level
  const hints = client.mock.getHints(v.cycleId);
  assert.equal(hints.length, 2);
  assert.ok(hints[1].marksAnswerAssistance);
  assert.ok(hints[1].text.includes('8.0'), 'answer-level hint text comes from private instance data');
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.commitOperation', { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } }, { version: v.version }));
  v = await viewCycle(client, learnerId, l1);
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.submitResponse', {
    response: [claims([['diameter', 'INCREASE']]), numberItem('diameter', 8, 'cm')],
  }, { version: v.version }));
  v = await viewCycle(client, learnerId, l1);
  const evaluation = client.mock.getEvaluation(v.cycleId)!;
  assert.equal(evaluation.verdict, 'CORRECT');
  assert.equal(evaluation.answerAssistanceActive, true, 'correct-after-answer-hint is not unassisted');
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.beginExplanation', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, l1);
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.saveExplanation', { selections: [], freeText: '直径跟着半径走。', transcribedByGuardian: false }, { version: v.version }));
  // restricted feedback on a REVISE result carries no expected value
  await beginNext(client, learnerId, l1, 'cyl.param.g3.height-section.v1');
  v = await viewCycle(client, learnerId, l1);
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
  v = await viewCycle(client, learnerId, l1);
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.commitOperation', { operation: { type: 'SetDimension', dimension: 'HEIGHT', valueMm: 100 } }, { version: v.version }));
  v = await viewCycle(client, learnerId, l1);
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.submitResponse', {
    response: [claims([['height', 'INCREASE']]), numberItem('height', 99, 'cm'), mapping([['cyl-part-height-line', 'section-view-transverse']])],
  }, { version: v.version }));
  const ev3 = client.mock.getEvaluation(v.cycleId)!;
  assert.equal(ev3.verdict, 'REVISE');
  const feedbackText = JSON.stringify(ev3.itemResults);
  assert.ok(!feedbackText.includes('10.0'), 'REVISE feedback must not reveal the expected value');
  assert.ok(!feedbackText.includes('轴截面（沿轴切开）'), 'REVISE feedback must not state the expected section');
  assert.ok(!feedbackText.includes('10.0 cm'), 'no expected height leak');
});

test('flow: idempotency — same key one effect; different payload conflict', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  const l1 = await startAttemptFor(client, learnerId, RELEASE_L1);
  const v = await viewCycle(client, learnerId, l1);
  const env = envelope(learnerId, l1, v.cycleId, 'learning.recordPrediction', {
    prediction: { claims: [{ propertyId: 'radius', direction: 'UNCHANGED' }] },
    uncertain: false,
  });
  const r1 = await client.command(env);
  const r2 = await client.command(env); // identical replay
  assert.deepEqual(r1, r2, 'same key + same payload returns the original receipt');
  const fresh = await client.command(envelope(learnerId, l1, v.cycleId, 'learning.requestHint', { hintLevel: 1 }));
  assert.equal(fresh.status, 'APPLIED', 'fresh keys still work');
  // same KEY different payload → IDEMPOTENCY_CONFLICT
  await assert.rejects(
    async () => {
      const cloned = JSON.parse(JSON.stringify(env)) as PublicCommandEnvelope;
      cloned.payload = { prediction: { claims: [{ propertyId: 'height', direction: 'INCREASE' }] }, uncertain: false } as never;
      await client.command(cloned);
    },
    (err: unknown) => (err as { code?: string }).code === 'IDEMPOTENCY_CONFLICT',
    'same key with a different payload must conflict',
  );
  // exactly one prediction event
  const detail = client.mock.getTimelineDetail(l1) as { events: Array<{ eventType: string }> };
  assert.equal(detail.events.filter((e) => e.eventType === 'PREDICTION_RECORDED').length, 1);
});

test('flow: receipt-unknown resolves by ORIGINAL key; replay adds no second effect', async () => {
  const client = createMockRondo({ dropReceiptKindsOnce: ['learning.recordPrediction'] });
  const learnerId = await enterLearnerSession(client);
  const l1 = await startAttemptFor(client, learnerId, RELEASE_L1);
  const v = await viewCycle(client, learnerId, l1);
  const env = envelope(learnerId, l1, v.cycleId, 'learning.recordPrediction', {
    prediction: { claims: [{ propertyId: 'radius', direction: 'UNCHANGED' }] },
    uncertain: false,
  });
  await assert.rejects(() => client.command(env), /delivery of command/, 'receipt dropped after commit');
  const lookup = await client.receipt({ idempotencyKey: env.idempotencyKey, commandKind: env.kind });
  assert.equal(lookup.status, 'CONFIRMED', 'original key finds the committed receipt');
  const replay = await client.command(env);
  assert.equal(replay.status, 'APPLIED');
  const detail = client.mock.getTimelineDetail(l1) as { events: Array<{ eventType: string }> };
  assert.equal(detail.events.filter((e) => e.eventType === 'PREDICTION_RECORDED').length, 1, 'no double effect');
});

test('flow: delayed transfer on a real injected clock (PLANNED → AVAILABLE → STARTED → OBSERVED)', async () => {
  let now = 1_700_000_000_000;
  const client = createMockRondo({ now: () => now });
  const learnerId = await enterLearnerSession(client);
  const l2 = await startAttemptFor(client, learnerId, RELEASE_L2);
  const l2Tasks = ['cyl.net.g1.unroll-observe.v1', 'cyl.net.g2.edge-pairing.v1', 'cyl.net.g3.lateral-area.v1', 'cyl.net.i1.pair-normal.v1', 'cyl.net.i2.pair-tall-thin.v1', 'cyl.net.i3.area-value-unit.v1', 'cyl.net.s1.stranger-relabel.v1'];
  let v = await viewCycle(client, learnerId, l2);
  for (let i = 0; i < l2Tasks.length; i++) {
    const response =
      l2Tasks[i] === 'cyl.net.g1.unroll-observe.v1'
        ? [mapping(DIRECTION)]
        : l2Tasks[i] === 'cyl.net.s1.stranger-relabel.v1'
          ? [numberItem('radius', 1.5, 'cm'), mapping(PAIRING), mapping(DIRECTION), numberItem('lateral-area', 84.78, 'cm2')]
        : l2Tasks[i] === 'cyl.net.g3.lateral-area.v1'
          ? [numberItem('lateral-area', 150.72, 'cm2')]
          : l2Tasks[i] === 'cyl.net.i3.area-value-unit.v1'
            ? [numberItem('lateral-area', 157.0, 'cm2')]
            : [mapping(PAIRING)];
    await runTask(client, learnerId, l2, { taskId: l2Tasks[i], prediction: { uncertain: true }, ops: [{ type: 'SetUnroll', valuePermille: 1000 }], response });
    if (i + 1 < l2Tasks.length) await beginNext(client, learnerId, l2, l2Tasks[i + 1]);
  }
  v = await viewCycle(client, learnerId, l2);
  await client.command(envelope(learnerId, l2, v.cycleId, 'learning.finishAttempt', {}, { version: v.version }));

  const card = client.mock.getMigration(learnerId) as { state: string; remainingDays: number; availableAtMs: number };
  assert.equal(card.state, 'PLANNED');
  assert.equal(card.remainingDays, 7);

  // before the window: beginCycle for D1 is refused
  const l2b = await startAttemptFor(client, learnerId, RELEASE_L2, 'after-finish'); // new intent -> new idempotency key
  await assert.rejects(
    () => beginNext(client, learnerId, l2b, 'cyl.net.d1.delayed-transfer.v1'),
    (err: unknown) => (err as { code?: string }).code === 'INVALID_OPERATION',
    'D1 cannot start before the window',
  );

  now += 8 * DAY; // real time passes (injected clock, no timers)
  const card2 = client.mock.getMigration(learnerId) as { state: string };
  assert.equal(card2.state, 'AVAILABLE');
  // a NEW attempt for the same release opens directly at the delayed task
  // (course-graph: the migration target is the resume entry point)
  const l2d = await startAttemptFor(client, learnerId, RELEASE_L2, 'delayed');
  const d1 = await viewCycle(client, learnerId, l2d);
  assert.equal(d1.taskId, 'cyl.net.d1.delayed-transfer.v1');
  assert.equal((d1.sceneState as { radiusMm: number }).radiusMm, 20, 'D1 frozen instance r=2.0cm');
  await runTask(client, learnerId, l2d, {
    taskId: 'cyl.net.d1.delayed-transfer.v1',
    prediction: { uncertain: true },
    ops: [{ type: 'SetUnroll', valuePermille: 1000 }],
    response: [numberItem('radius', 2.0, 'cm'), mapping(PAIRING), mapping(DIRECTION)],
    explanation: '周长倒过来求半径：12.56÷6.28=2.0。',
  });
  const observed = client.mock.getMigration(learnerId) as { state: string; actualIntervalDays?: number };
  assert.equal(observed.state, 'OBSERVED');
  assert.equal(observed.actualIntervalDays, 8, 'actual interval recorded as-is');
});

test('flow: context loss mid-task continues the same attempt; SVG-only path identical', async () => {
  const bag = fakeRenderer();
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  const l2 = await startAttemptFor(client, learnerId, RELEASE_L2);

  const ops: Array<Record<string, unknown>> = [];
  const controller = new SceneController({
    renderer: bag.renderer,
    initialState: { radiusMm: 30, heightMm: 80, unrollPermille: 0, section: 'NONE', selectedFaceIds: [] },
    initialMode: 'WEBGL2',
    onOperation: (op) => ops.push(op as never),
    onModeChange: () => {},
  });
  // PREDICT
  let v = await viewCycle(client, learnerId, l2);
  await client.command(envelope(learnerId, l2, v.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
  v = await viewCycle(client, learnerId, l2);
  // OPERATE: dragging the slider is a preview; context hits mid-drag
  controller.previewOperation({ type: 'SetUnroll', valuePermille: 600 });
  controller.handleContextLost();
  assert.equal(controller.getMode(), 'SVG_DOM');
  controller.previewOperation({ type: 'SetUnroll', valuePermille: 1000 });
  controller.confirmDraft(); // exactly one canonical op out of the whole drag
  assert.deepEqual(ops, [{ type: 'SetUnroll', valuePermille: 1000 }]);
  await client.command(envelope(learnerId, l2, v.cycleId, 'learning.commitOperation', { operation: ops[0] }, { version: v.version, binding: { releaseId: v.releaseId, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l2);
  await client.command(envelope(learnerId, l2, v.cycleId, 'learning.submitResponse', { response: [mapping(DIRECTION)] }, { version: v.version, binding: { releaseId: v.releaseId, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l2);
  const evaluation = client.mock.getEvaluation(v.cycleId)!;
  assert.equal(evaluation.verdict, 'CORRECT', 'task completed in SVG mode after loss');
  const detail = client.mock.getTimelineDetail(l2) as { events: Array<{ eventType: string }> };
  assert.equal(detail.events.filter((e) => e.eventType === 'SUBMISSION_EVALUATED').length, 1, 'no resubmission after loss');
  await client.command(envelope(learnerId, l2, v.cycleId, 'learning.beginExplanation', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, l2);
  await client.command(envelope(learnerId, l2, v.cycleId, 'learning.saveExplanation', { selections: [], freeText: '边 2 和边 4 卷回去贴着底面圆。', transcribedByGuardian: false }, { version: v.version }));

  // SVG-only learner produces the same evaluation for the same typed ops (G2)
  await beginNext(client, learnerId, l2, 'cyl.net.g2.edge-pairing.v1');
  const svgOnly = new SceneController({
    renderer: bag.renderer,
    initialState: { radiusMm: 30, heightMm: 80, unrollPermille: 0, section: 'NONE', selectedFaceIds: [] },
    initialMode: 'SVG_DOM',
    onOperation: () => {},
    onModeChange: () => {},
  });
  assert.equal(svgOnly.getMode(), 'SVG_DOM');
  void evaluation;
});

test('flow: questionView per-phase spec never carries answers', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  const l1 = await startAttemptFor(client, learnerId, RELEASE_L1);
  // I2: diameter is the target; spec before/at every phase must not contain it
  const order = ['cyl.param.g1.view-invariance.v1', 'cyl.param.g2.radius-change.v1', 'cyl.param.g3.height-section.v1', 'cyl.param.i1.identify-changes.v1'];
  for (let i = 0; i < order.length; i++) {
    await runTask(client, learnerId, l1, {
      taskId: order[i],
      prediction: { uncertain: true },
      ops:
        order[i] === 'cyl.param.g2.radius-change.v1'
          ? [{ type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 }]
          : order[i] === 'cyl.param.g3.height-section.v1'
            ? [{ type: 'SetDimension', dimension: 'HEIGHT', valueMm: 100 }, { type: 'SetSection', section: 'AXIAL' }]
            : [],
      response:
        order[i] === 'cyl.param.g1.view-invariance.v1'
          ? [claims([['radius', 'UNCHANGED'], ['diameter', 'UNCHANGED'], ['height', 'UNCHANGED']])]
          : order[i] === 'cyl.param.g2.radius-change.v1'
            ? [claims([['diameter', 'INCREASE']]), numberItem('diameter', 8, 'cm')]
            : order[i] === 'cyl.param.g3.height-section.v1'
              ? [claims([['height', 'INCREASE']]), numberItem('height', 10, 'cm'), mapping([['cyl-part-height-line', 'section-view-axial']])]
              : [claims([['radius', 'DECREASE'], ['diameter', 'DECREASE'], ['height', 'UNCHANGED']])],
    });
    if (i + 1 < order.length) await beginNext(client, learnerId, l1, order[i + 1]);
  }
  await beginNext(client, learnerId, l1, 'cyl.param.i2.predict-single-change.v1');
  let v = await viewCycle(client, learnerId, l1);
  for (const step of ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN'] as const) {
    const qv = await client.query({ kind: 'learning.questionView', attemptId: l1, cycleId: v.cycleId });
    assert.equal(qv.kind, 'learning.questionView');
    const raw = JSON.stringify(qv.spec);
    assert.ok(!raw.includes('"4.0"') && !raw.includes('"answer"') && !raw.includes('correctIndex'), `I2 ${step} spec must not leak the diameter answer`);
    if (step === 'PREDICT') {
      await client.command(envelope(learnerId, l1, v.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
    } else if (step === 'OPERATE') {
      await client.command(envelope(learnerId, l1, v.cycleId, 'learning.submitResponse', { response: [claims([['diameter', 'UNCHANGED']]), numberItem('diameter', 4, 'cm')] }, { version: v.version }));
    } else if (step === 'VERIFY') {
      await client.command(envelope(learnerId, l1, v.cycleId, 'learning.beginExplanation', {}, { version: v.version }));
    } else {
      await client.command(envelope(learnerId, l1, v.cycleId, 'learning.saveExplanation', { selections: [], freeText: '高度不影响直径。', transcribedByGuardian: false }, { version: v.version }));
    }
    v = await viewCycle(client, learnerId, l1);
  }
  assert.equal(v.phase, 'REVIEW');
  // REVIEW: the reveal is available AFTER judging (contract-allowed)
  const review = client.mock.getReviewCard(v.cycleId) as { reveal: Record<string, string> | null };
  assert.ok(review.reveal && review.reveal.value === '4.0 cm');
});

test('flow: guardian assistance + annotation + data governance loop', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  const l1 = await startAttemptFor(client, learnerId, RELEASE_L1);
  let v = await viewCycle(client, learnerId, l1);
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
  // guardian enters mid-attempt to record assistance (four categories)
  await client.lock();
  await client.unlockGuardian({ passphrase: 'passphrase-8chars' });
  await client.command(
    parseEnvelope({
      protocolVersion: 'rondo.v1',
      commandId: 'cmd-assist-1',
      idempotencyKey: 'idem-assist-1',
      kind: 'guardian.recordAssistance',
      target: { scope: 'FAMILY' },
      payload: { attemptId: l1, category: 'CONCEPT', note: '孩子问「变粗是什么意思」，我重述了半径的含义' },
    }),
  );
  const summary = await client.query({ kind: 'guardian.evidenceSummary', learnerId });
  assert.equal(summary.kind, 'guardian.evidenceSummary');
  assert.ok(summary.items.some((i) => i.evidenceType === 'ASSISTANCE'));
  // back to the learner session; independence semantics live server-side
  await client.enterLearner({ learnerId });
  v = await viewCycle(client, learnerId, l1);
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.submitResponse', { response: [claims([['radius', 'UNCHANGED'], ['diameter', 'UNCHANGED'], ['height', 'UNCHANGED']])] }, { version: v.version }));
  v = await viewCycle(client, learnerId, l1);
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.beginExplanation', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, l1);
  await client.command(envelope(learnerId, l1, v.cycleId, 'learning.saveExplanation', { selections: [], freeText: '转来转去数字都没动。', transcribedByGuardian: false }, { version: v.version }));
  // guardian annotates the explanation with the rubric triple
  await client.lock();
  await client.unlockGuardian({ passphrase: 'passphrase-8chars' });
  const cycleAfter = await viewCycle(client, learnerId, l1);
  const revisionRef = client.mock.registerExplanationRevision(cycleAfter.cycleId);
  await client.command(
    parseEnvelope({
      protocolVersion: 'rondo.v1',
      commandId: 'cmd-annot-1',
      idempotencyKey: 'idem-annot-1',
      kind: 'guardian.annotateExplanation',
      target: { scope: 'FAMILY' },
      payload: { explanationRevisionRef: revisionRef, rubric: { condition: 'ESTABLISHED', relation: 'EMERGING', basis: 'NOT_OBSERVED' } },
    }),
  );
  // retention preview + export + deletion preview/confirm (family data wiped)
  const rp = await client.query({ kind: 'guardian.retentionPreview', mode: 'UNTIL_GUARDIAN_DELETES' });
  assert.equal(rp.kind, 'guardian.retentionPreview');
  assert.equal(rp.affectedCount, 0);
  const exportReceipt = await client.command(
    parseEnvelope({
      protocolVersion: 'rondo.v1',
      commandId: 'cmd-export-1',
      idempotencyKey: 'idem-export-1',
      kind: 'guardian.prepareExport',
      target: { scope: 'FAMILY' },
      payload: { scope: { categories: ['PROCESS', 'SUBMISSIONS', 'EXPLANATIONS'] } },
    }),
  );
  assert.equal(exportReceipt.status, 'APPLIED');
  const exportId = exportReceipt.effectRefs.find((r) => r.startsWith('export:'))!.slice('export:'.length);
  const saved = await client.saveExport({ preparedExportRef: exportId });
  assert.ok(saved.saved);
  assert.ok((saved.savedToLabel ?? '').includes('MOCK_ONLY'), 'desktop port result is MOCK_ONLY-labelled');
  const delPrep = await client.command(
    parseEnvelope({
      protocolVersion: 'rondo.v1',
      commandId: 'cmd-del-1',
      idempotencyKey: 'idem-del-1',
      kind: 'guardian.prepareDeletion',
      target: { scope: 'FAMILY' },
      payload: { target: 'ALL_FAMILY_DATA' },
    }),
  );
  assert.equal(delPrep.status, 'APPLIED');
  await assert.rejects(
    () =>
      client.command(
        parseEnvelope({
          protocolVersion: 'rondo.v1',
          commandId: 'cmd-del-2',
          idempotencyKey: 'idem-del-2',
          kind: 'guardian.confirmDeletion',
          target: { scope: 'FAMILY' },
          payload: { scopeListHash: 'b'.repeat(64) }, // well-formed hex but stale scope
        }),
      ),
    (err: unknown) => (err as { code?: string }).code === 'VERSION_CONFLICT',
    'confirming a stale scope must be refused',
  );
  const detail = client.mock.getTimelineDetail(l1) as { events: unknown[] };
  assert.ok(detail.events.length > 0, 'data existed before deletion');
});

// ===========================================================================
// L3/L4（h0-mathl34-20261027-1）
// ===========================================================================

const INC = 'opt-include';
const EXC = 'opt-exclude';
const faceSetItem = (side: string, upper: string, lower: string) => ({
  kind: 'objectMapping' as const,
  pairs: [
    { leftId: 'cyl-face-side', rightId: side },
    { leftId: 'cyl-face-upper', rightId: upper },
    { leftId: 'cyl-face-lower', rightId: lower },
  ],
});
const choiceItem = (leftId: string, rightId: string) => ({
  kind: 'objectMapping' as const,
  pairs: [{ leftId, rightId }],
});
const claims34 = (items: Array<[string, string]>) => ({
  kind: 'propertyJudgments' as const,
  claims: items.map(([propertyId, direction]) => ({ propertyId, direction })),
});

test('flow: full L3 journey with correct answers (SelectFaces snapshot discipline, @1 throughout)', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  setBindingVersion('1');
  const l3 = await startAttemptFor(client, learnerId, RELEASE_L3);
  let v = await viewCycle(client, learnerId, l3);
  assert.equal(v.rendererContractVersion, '1', 'L3 spec stays @1 even with @2 in the same environment');
  await runTask(client, learnerId, l3, {
    taskId: 'cyl.faces.g1.face-inventory.v1',
    prediction: { uncertain: true },
    ops: [
      { type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-lower'] },
      { type: 'SetUnroll', valuePermille: 1000 },
    ],
    response: [faceSetItem(INC, EXC, INC), choiceItem('lid-count', 'opt-1')],
    explanation: '无盖说的是上面开口，底下还要一张圆纸。',
  });
  await beginNext(client, learnerId, l3, 'cyl.faces.g2.one-lid-area.v1');
  await runTask(client, learnerId, l3, {
    taskId: 'cyl.faces.g2.one-lid-area.v1',
    prediction: { uncertain: true },
    ops: [{ type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-lower'] }],
    response: [faceSetItem(INC, EXC, INC), numberItem('paper-area', 178.98, 'cm2')],
  });
  await beginNext(client, learnerId, l3, 'cyl.faces.g3.full-surface.v1');
  const g3v = await runTask(client, learnerId, l3, {
    taskId: 'cyl.faces.g3.full-surface.v1',
    prediction: { uncertain: true, explanation: '[预测] 建议单不能用，问题在盖面；表面积约 210' },
    ops: [{ type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'] }],
    response: [faceSetItem(INC, INC, INC), numberItem('paper-area', 207.24, 'cm2')],
  });
  assert.equal(g3v.rendererContractVersion, '1');
  await beginNext(client, learnerId, l3, 'cyl.faces.i1.faceset-new-instance.v1');
  await runTask(client, learnerId, l3, {
    taskId: 'cyl.faces.i1.faceset-new-instance.v1',
    prediction: { uncertain: true },
    ops: [{ type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-lower'] }],
    response: [faceSetItem(INC, EXC, INC), choiceItem('lid-count', 'opt-1')],
  });
  await beginNext(client, learnerId, l3, 'cyl.faces.i2.lid-count-condition.v1');
  await runTask(client, learnerId, l3, {
    taskId: 'cyl.faces.i2.lid-count-condition.v1',
    prediction: { uncertain: true },
    ops: [{ type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'] }],
    response: [numberItem('paper-area-delta', 25.12, 'cm2'), choiceItem('delta-attribution', 'opt-two-lid')],
  });
  await beginNext(client, learnerId, l3, 'cyl.faces.i3.surface-value-unit.v1');
  await runTask(client, learnerId, l3, {
    taskId: 'cyl.faces.i3.surface-value-unit.v1',
    prediction: { uncertain: true },
    ops: [{ type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'] }],
    response: [faceSetItem(INC, INC, INC), numberItem('paper-area', 376.8, 'cm2')], // 376.8 ≡ 376.80 等价书写
  });
  v = await viewCycle(client, learnerId, l3);
  const finish = await client.command(envelope(learnerId, l3, v.cycleId, 'learning.finishAttempt', {}, { version: v.version }));
  assert.equal(finish.status, 'APPLIED');
  // L3 无 delayedTransfer：不建迁移卡
  assert.equal(client.mock.getMigration(learnerId), null);
});

test('flow: full L4 journey (@2 states/ops) + delayed D1 at +8d with OBSERVED evidence', async () => {
  let now = 1_700_100_000_000;
  const client = createMockRondo({ now: () => now });
  const learnerId = await enterLearnerSession(client);
  setBindingVersion('2');
  const l4 = await startAttemptFor(client, learnerId, RELEASE_L4);
  let v = await viewCycle(client, learnerId, l4);
  assert.equal(v.rendererContractVersion, '2', 'L4 spec is @2');
  assert.equal(layer(v).layerCount, 8, 'givens carry the layer pair');
  assert.equal(layer(v).visibleLayerCount, 0);
  // G1：两种层数都装过 + 逐层推进（活动校验）
  await runTask(client, learnerId, l4, {
    taskId: 'cyl.layers.g1.stack-invariant.v1',
    prediction: { uncertain: true },
    ops: [
      { type: 'SetLayerCount', value: 16 },
      { type: 'SetVisibleLayerCount', value: 16 },
      { type: 'SetLayerCount', value: 8 },
      { type: 'SetVisibleLayerCount', value: 8 },
    ],
    response: [claims34([['layerThickness', 'DECREASE'], ['totalVolume', 'UNCHANGED']]), numberItem('volume', 226.08, 'cm3')],
  });
  await beginNext(client, learnerId, l4, 'cyl.layers.g2.layer-volume.v1');
  await runTask(client, learnerId, l4, {
    taskId: 'cyl.layers.g2.layer-volume.v1',
    prediction: { uncertain: true },
    ops: [{ type: 'SetVisibleLayerCount', value: 8 }],
    response: [
      { kind: 'numberWithUnit', quantityId: 'layer-thickness', value: 1, unitId: 'cm' },
      { kind: 'numberWithUnit', quantityId: 'layer-volume', value: 28.26, unitId: 'cm3' },
      { kind: 'numberWithUnit', quantityId: 'volume', value: 226.08, unitId: 'cm3' },
    ],
  });
  await beginNext(client, learnerId, l4, 'cyl.layers.g3.height-vs-radius.v1');
  await runTask(client, learnerId, l4, {
    taskId: 'cyl.layers.g3.height-vs-radius.v1',
    prediction: { uncertain: true },
    ops: [
      { type: 'SetDimension', dimension: 'HEIGHT', valueMm: 160 },
      { type: 'SetDimension', dimension: 'RADIUS', valueMm: 60 },
      { type: 'SetLayerCount', value: 16 },
      { type: 'SetVisibleLayerCount', value: 16 },
    ],
    response: [
      choiceItem('bigger-plan', 'opt-plan-b'),
      { kind: 'numberWithUnit', quantityId: 'volume-a', value: 452.16, unitId: 'cm3' },
      { kind: 'numberWithUnit', quantityId: 'volume-b', value: 904.32, unitId: 'cm3' },
      choiceItem('radius-double-ratio', 'opt-ratio-4'),
    ],
  });
  await beginNext(client, learnerId, l4, 'cyl.layers.i1.volume-value-unit.v1');
  await runTask(client, learnerId, l4, {
    taskId: 'cyl.layers.i1.volume-value-unit.v1',
    prediction: { uncertain: true },
    ops: [{ type: 'SetVisibleLayerCount', value: 7 }],
    response: [numberItem('volume', 351.68, 'cm3')],
  });
  await beginNext(client, learnerId, l4, 'cyl.layers.i2.height-vs-radius-choice.v1');
  await runTask(client, learnerId, l4, {
    taskId: 'cyl.layers.i2.height-vs-radius-choice.v1',
    prediction: { uncertain: true },
    ops: [{ type: 'SetDimension', dimension: 'HEIGHT', valueMm: 100 }],
    response: [
      choiceItem('bigger-plan', 'opt-plan-b'),
      { kind: 'numberWithUnit', quantityId: 'volume-a', value: 282.6, unitId: 'cm3' },
      { kind: 'numberWithUnit', quantityId: 'volume-b', value: 301.44, unitId: 'cm3' },
    ],
  });
  await beginNext(client, learnerId, l4, 'cyl.layers.i3.accumulate-count.v1');
  await runTask(client, learnerId, l4, {
    taskId: 'cyl.layers.i3.accumulate-count.v1',
    prediction: { uncertain: true },
    ops: [{ type: 'SetVisibleLayerCount', value: 8 }],
    response: [
      { kind: 'numberWithUnit', quantityId: 'layer-index', value: 8, unitId: 'layer' },
      { kind: 'numberWithUnit', quantityId: 'cumulative-volume', value: 100.48, unitId: 'cm3' },
    ],
  });
  await beginNext(client, learnerId, l4, 'cyl.layers.s1.stranger-package.v1');
  await runTask(client, learnerId, l4, {
    taskId: 'cyl.layers.s1.stranger-package.v1',
    prediction: { uncertain: true },
    ops: [
      { type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'] },
      { type: 'SetVisibleLayerCount', value: 6 },
    ],
    response: [
      { kind: 'numberWithUnit', quantityId: 'radius', value: 5, unitId: 'cm' },
      faceSetItem(INC, INC, INC),
      { kind: 'numberWithUnit', quantityId: 'paper-area', value: 345.4, unitId: 'cm2' },
      { kind: 'numberWithUnit', quantityId: 'volume', value: 471, unitId: 'cm3' },
    ],
    explanation: 'r=d÷2=5.0；纸板=侧面+两个圆；衬垫=78.50×6.0。',
  });
  v = await viewCycle(client, learnerId, l4);
  const finish = await client.command(envelope(learnerId, l4, v.cycleId, 'learning.finishAttempt', {}, { version: v.version }));
  assert.equal(finish.status, 'APPLIED');
  const planned = client.mock.getMigration(learnerId) as { state: string; taskId: string };
  assert.equal(planned.state, 'PLANNED');
  assert.equal(planned.taskId, 'cyl.layers.d1.delayed-transfer.v1');

  now += 8 * DAY;
  const l4d = await startAttemptFor(client, learnerId, RELEASE_L4, 'delayed');
  const d1 = await viewCycle(client, learnerId, l4d);
  assert.equal(d1.taskId, 'cyl.layers.d1.delayed-transfer.v1');
  assert.equal(layer(d1).layerCount, 13, 'D1 frozen layer n=13（65mm ÷ 5mm）');
  await runTask(client, learnerId, l4d, {
    taskId: 'cyl.layers.d1.delayed-transfer.v1',
    prediction: { uncertain: true },
    ops: [
      { type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-lower'] },
      { type: 'SetVisibleLayerCount', value: 13 },
    ],
    response: [
      { kind: 'numberWithUnit', quantityId: 'radius', value: 4, unitId: 'cm' },
      faceSetItem(INC, EXC, INC),
      { kind: 'numberWithUnit', quantityId: 'paper-area', value: 213.52, unitId: 'cm2' },
      { kind: 'numberWithUnit', quantityId: 'volume', value: 326.56, unitId: 'cm3' },
    ],
    explanation: '周长倒推半径：25.12÷6.28=4.0；无盖=侧面+下盖面。',
  });
  const observed = client.mock.getMigration(learnerId) as { state: string; actualIntervalDays?: number };
  assert.equal(observed.state, 'OBSERVED');
  assert.equal(observed.actualIntervalDays, 8, 'actual interval recorded as-is');
  setBindingVersion('1');
});

test('flow: L3/L4 diagnostics — REVISE feedback and diagnostics never carry expected values', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  setBindingVersion('1');
  const l3 = await startAttemptFor(client, learnerId, RELEASE_L3);

  // G1：快照≠声明 → 构造未完成（不进判分结论）；修正场景后同一作答通过
  let v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.commitOperation', { operation: { type: 'SelectFaces', faceIds: ['cyl-face-side'] } }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } })); // 场景只选了侧面（漏下盖）
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.submitResponse', { response: [faceSetItem(INC, EXC, INC), choiceItem('lid-count', 'opt-1')] }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l3);
  {
    const ev = client.mock.getEvaluation(v.cycleId)!;
    assert.equal(ev.verdict, 'REVISE');
    assert.equal(ev.itemResults[0].key, 'snapshot');
    assert.ok(ev.itemResults[0].feedback?.includes('先把场景里的选面'), 'snapshot-mismatch feedback variant');
    const text = JSON.stringify(ev.itemResults);
    assert.ok(!text.includes('178.98') && !text.includes('207.24'));
  }
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.reviseResponse', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.commitOperation', { operation: { type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-lower'] } }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.submitResponse', { response: [faceSetItem(INC, EXC, INC), choiceItem('lid-count', 'opt-1')] }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l3);
  assert.equal(client.mock.getEvaluation(v.cycleId)!.verdict, 'CORRECT', 'after fixing the scene the same answer passes');
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.beginExplanation', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.saveExplanation', { selections: [], freeText: '改成和答案一样的选面。', transcribedByGuardian: false }, { version: v.version }));

  // G2：数值错（漏加圆）→ 泛化反馈不带 178.98
  await beginNext(client, learnerId, l3, 'cyl.faces.g2.one-lid-area.v1');
  await runTask(client, learnerId, l3, {
    taskId: 'cyl.faces.g2.one-lid-area.v1',
    prediction: { uncertain: true },
    ops: [{ type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-lower'] }],
    response: [faceSetItem(INC, EXC, INC), numberItem('paper-area', 150.72, 'cm2')],
    revise: { response: [faceSetItem(INC, EXC, INC), numberItem('paper-area', 178.98, 'cm2')] },
  }, 'REVISE');
  v = await viewCycle(client, learnerId, l3);
  {
    const ev = client.mock.getEvaluation(v.cycleId)!;
    const text = JSON.stringify(ev.itemResults);
    assert.ok(!text.includes('178.98'), 'REVISE feedback must not reveal 178.98');
  }

  // G3：提交 178.98（建议单口径）→ 受限变体不揭示 207.24；修正后通过
  await beginNext(client, learnerId, l3, 'cyl.faces.g3.full-surface.v1');
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.commitOperation', { operation: { type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'] } }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.submitResponse', { response: [faceSetItem(INC, INC, INC), numberItem('paper-area', 178.98, 'cm2')] }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l3);
  {
    const ev = client.mock.getEvaluation(v.cycleId)!;
    assert.equal(ev.verdict, 'REVISE');
    assert.ok(ev.itemResults.some((r) => r.feedback?.includes('再数一数封口罐有几个圆面')), 'advice-rejected variant');
    assert.ok(!JSON.stringify(ev.itemResults).includes('207.24'));
  }
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.reviseResponse', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.submitResponse', { response: [faceSetItem(INC, INC, INC), numberItem('paper-area', 207.24, 'cm2')] }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l3);
  assert.equal(client.mock.getEvaluation(v.cycleId)!.verdict, 'CORRECT');
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.beginExplanation', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.saveExplanation', { selections: [], freeText: '建议单漏了一个盖面。', transcribedByGuardian: false }, { version: v.version }));

  // I1 通过后，I2：提交 12.56 → 诊断签名 mis-one-lid-missing；修正 25.12 通过
  await beginNext(client, learnerId, l3, 'cyl.faces.i1.faceset-new-instance.v1');
  await runTask(client, learnerId, l3, { taskId: 'cyl.faces.i1.faceset-new-instance.v1', prediction: { uncertain: true }, ops: [{ type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-lower'] }], response: [faceSetItem(INC, EXC, INC), choiceItem('lid-count', 'opt-1')] });
  await beginNext(client, learnerId, l3, 'cyl.faces.i2.lid-count-condition.v1');
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.commitOperation', { operation: { type: 'SelectFaces', faceIds: ['cyl-face-side'] } }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.submitResponse', { response: [numberItem('paper-area-delta', 12.56, 'cm2'), choiceItem('delta-attribution', 'opt-two-lid')] }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l3);
  {
    const ev = client.mock.getEvaluation(v.cycleId)!;
    assert.equal(ev.verdict, 'REVISE');
    assert.ok(ev.diagnostics.includes('mis-one-lid-missing'), 'diagnostic signature recorded');
    assert.ok(!JSON.stringify(ev.itemResults).includes('25.12'), 'no expected value in feedback');
  }
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.reviseResponse', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.submitResponse', { response: [numberItem('paper-area-delta', 25.12, 'cm2'), choiceItem('delta-attribution', 'opt-two-lid')] }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l3);
  assert.equal(client.mock.getEvaluation(v.cycleId)!.verdict, 'CORRECT');
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.beginExplanation', {}, { version: v.version }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.saveExplanation', { selections: [], freeText: '封口罐有两个圆面。', transcribedByGuardian: false }, { version: v.version }));

  setBindingVersion('2');
  // L4-G1：只试了一种层数 → 活动校验先于判分；补齐两种层数后同一作答通过
  const l4 = await startAttemptFor(client, learnerId, RELEASE_L4, 'diag');
  let w = await viewCycle(client, learnerId, l4);
  await client.command(envelope(learnerId, l4, w.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
  w = await viewCycle(client, learnerId, l4);
  await client.command(envelope(learnerId, l4, w.cycleId, 'learning.commitOperation', { operation: { type: 'SetVisibleLayerCount', value: 4 } }, { version: w.version, binding: { releaseId: RELEASE_L4, questionInstanceId: w.questionInstanceId } }));
  w = await viewCycle(client, learnerId, l4);
  await client.command(envelope(learnerId, l4, w.cycleId, 'learning.submitResponse', { response: [claims34([['layerThickness', 'DECREASE'], ['totalVolume', 'UNCHANGED']]), numberItem('volume', 226.08, 'cm3')] }, { version: w.version, binding: { releaseId: RELEASE_L4, questionInstanceId: w.questionInstanceId } }));
  w = await viewCycle(client, learnerId, l4);
  {
    const ev = client.mock.getEvaluation(w.cycleId)!;
    assert.equal(ev.verdict, 'REVISE');
    assert.ok(ev.itemResults.some((r) => r.key === 'activity'), 'activity gate fires before judging');
    assert.ok(!JSON.stringify(ev.itemResults).includes('226.08'), 'activity feedback carries no value');
  }
  await client.command(envelope(learnerId, l4, w.cycleId, 'learning.reviseResponse', {}, { version: w.version }));
  w = await viewCycle(client, learnerId, l4);
  for (const op of [
    { type: 'SetLayerCount', value: 16 },
    { type: 'SetVisibleLayerCount', value: 16 },
    { type: 'SetLayerCount', value: 8 },
    { type: 'SetVisibleLayerCount', value: 8 },
  ]) {
    await client.command(envelope(learnerId, l4, w.cycleId, 'learning.commitOperation', { operation: op }, { version: w.version, binding: { releaseId: RELEASE_L4, questionInstanceId: w.questionInstanceId } }));
    w = await viewCycle(client, learnerId, l4);
  }
  await client.command(envelope(learnerId, l4, w.cycleId, 'learning.submitResponse', { response: [claims34([['layerThickness', 'DECREASE'], ['totalVolume', 'UNCHANGED']]), numberItem('volume', 226.08, 'cm3')] }, { version: w.version, binding: { releaseId: RELEASE_L4, questionInstanceId: w.questionInstanceId } }));
  w = await viewCycle(client, learnerId, l4);
  assert.equal(client.mock.getEvaluation(w.cycleId)!.verdict, 'CORRECT', 'same answer passes after the activity is completed');
  await client.command(envelope(learnerId, l4, w.cycleId, 'learning.beginExplanation', {}, { version: w.version }));
  w = await viewCycle(client, learnerId, l4);
  await client.command(envelope(learnerId, l4, w.cycleId, 'learning.saveExplanation', { selections: [], freeText: '层数乘层厚始终等于高。', transcribedByGuardian: false }, { version: w.version }));
  setBindingVersion('1');
});

test('flow: dual-version rejection matrix (B-line mandatory case, L34-1)', async () => {
  const client = createMockRondo();
  const learnerId = await enterLearnerSession(client);
  setBindingVersion('1');

  // —— @1 任务拒绝 V2 操作（store 层） ——
  const l3 = await startAttemptFor(client, learnerId, RELEASE_L3);
  let v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
  v = await viewCycle(client, learnerId, l3);
  await assert.rejects(
    () => client.command(envelope(learnerId, l3, v.cycleId, 'learning.commitOperation', { operation: { type: 'SetLayerCount', value: 16 } }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } })),
    (err: unknown) => (err as { code?: string }).code === 'INVALID_OPERATION',
    'an @1 task must refuse SetLayerCount outright',
  );
  await assert.rejects(
    () => client.command(envelope(learnerId, l3, v.cycleId, 'learning.commitOperation', { operation: { type: 'SelectFaces', faceIds: ['cyl-face-side', 'net-edge-1'] } }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } })),
    (err: unknown) => (err as { code?: string }).code === 'INVALID_OPERATION',
    'SelectFaces outside the task face whitelist is refused',
  );

  // —— @1 环境共存：@2 发布同时注册时 @1 任务照常完成 ——
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.commitOperation', { operation: { type: 'SelectFaces', faceIds: ['cyl-face-side', 'cyl-face-lower'] } }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l3);
  await client.command(envelope(learnerId, l3, v.cycleId, 'learning.submitResponse', { response: [faceSetItem(INC, EXC, INC), choiceItem('lid-count', 'opt-1')] }, { version: v.version, binding: { releaseId: RELEASE_L3, questionInstanceId: v.questionInstanceId } }));
  v = await viewCycle(client, learnerId, l3);
  assert.equal(v.phase, 'VERIFY');
  assert.equal(client.mock.getEvaluation(v.cycleId)!.verdict, 'CORRECT', '@1 task completes normally with @2 registered');
  assert.equal(v.rendererContractVersion, '1');
  assert.equal(layer(v).layerCount, undefined, '@1 spec state never carries layer fields');

  // —— @2 任务：visibleLayerCount > layerCount 拒绝；spec 全程 @2 ——
  setBindingVersion('2');
  const l4 = await startAttemptFor(client, learnerId, RELEASE_L4);
  let w = await viewCycle(client, learnerId, l4);
  assert.equal(w.rendererContractVersion, '2');
  await client.command(envelope(learnerId, l4, w.cycleId, 'learning.recordPrediction', { prediction: { claims: [] }, uncertain: true }));
  w = await viewCycle(client, learnerId, l4);
  await assert.rejects(
    () => client.command(envelope(learnerId, l4, w.cycleId, 'learning.commitOperation', { operation: { type: 'SetVisibleLayerCount', value: 9 } }, { version: w.version, binding: { releaseId: RELEASE_L4, questionInstanceId: w.questionInstanceId } })),
    (err: unknown) => (err as { code?: string }).code === 'INVALID_OPERATION',
    'visibleLayerCount above layerCount is refused',
  );
  await client.command(envelope(learnerId, l4, w.cycleId, 'learning.commitOperation', { operation: { type: 'SetLayerCount', value: 16 } }, { version: w.version, binding: { releaseId: RELEASE_L4, questionInstanceId: w.questionInstanceId } }));
  // —— 在途绑定不漂移：L3 在途尝试保持 @1 spec，L4 在途尝试保持 @2 spec ——
  const l3Again = await viewCycle(client, learnerId, l3);
  assert.equal(l3Again.rendererContractVersion, '1');
  const l4Again = await viewCycle(client, learnerId, l4);
  assert.equal(l4Again.rendererContractVersion, '2');
  assert.equal(layer(l4Again).layerCount, 16, 'confirmed layer op landed on the @2 state');
  setBindingVersion('1');
});
