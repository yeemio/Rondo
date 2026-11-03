/**
 * Domain tests: numeric judging (exact decimals, units, rounding, equivalent
 * spellings, range boundaries, the high-fine counterexample), L1/L2 rules,
 * assistance/hints vs independence, open explanations never auto-scored.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createReadyHarness, startAttempt, SYNTH_RELEASE_ID } from '../fixtures/harness';
import { asRondoError } from '../contracts/stub-service';
import { evaluateResponse, evaluateResponseV2 } from '../../modules/learning/evaluate';
import type { NumericRelationRule, ParameterIdentificationRule } from '../../modules/contracts/server/rules';
import type { CylinderStateV1 } from '../../modules/contracts/public/scene';

const LATERAL = (factors: unknown[]) => ({ kind: 'RATIONAL_PRODUCT_V1', factors }) as never;

function l2Rule(): NumericRelationRule {
  return {
    ruleKind: 'NUMERIC_RELATION_V1',
    expectedEdgeMapping: [
      { cylinderObjectId: 'cyl.rim.top', netEdgeId: 'net.edge.a1' },
      { cylinderObjectId: 'cyl.rim.bottom', netEdgeId: 'net.edge.a2' },
      { cylinderObjectId: 'cyl.seam.vertical', netEdgeId: 'net.edge.b1' },
    ],
    quantityChecks: [
      {
        quantityId: 'circumference',
        expected: LATERAL([{ numerator: 157, denominator: 25 }, { factor: 'radiusMm' }]),
        acceptedUnitIds: ['mm', 'cm'],
        rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
        comparison: 'EXACT_AFTER_ROUNDING',
      },
      {
        quantityId: 'lateralArea',
        expected: LATERAL([{ numerator: 157, denominator: 25 }, { factor: 'radiusMm' }, { factor: 'heightMm' }]),
        acceptedUnitIds: ['mm2', 'cm2'],
        rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
        comparison: 'EXACT_AFTER_ROUNDING',
      },
    ],
  };
}

const STATE = (radiusMm: number, heightMm: number): CylinderStateV1 => ({
  radiusMm,
  heightMm,
  unrollPermille: 1000,
  section: 'NONE',
  selectedFaceIds: [],
});

const MAPPING_OK = [
  { kind: 'objectMapping', pairs: [
    { leftId: 'cyl.rim.top', rightId: 'net.edge.a1' },
    { leftId: 'cyl.rim.bottom', rightId: 'net.edge.a2' },
    { leftId: 'cyl.seam.vertical', rightId: 'net.edge.b1' },
  ] },
] as never[];

const NUMBER = (quantityId: string, value: number, unitId: string) => ({ kind: 'numberWithUnit', quantityId, value, unitId }) as never;

// -- evaluator-level exactness (no DB) ----------------------------------------

test('lateral area: exact decimals, equivalent spellings, unit conversion', () => {
  const rule = l2Rule();
  const givens = STATE(30, 80);
  const snapshot = STATE(30, 80);
  // 2 x 3.14 x 30 x 80 = 15072 mm² exactly; C = 188.4 mm.
  const cases: [value: number, unit: string, ok: boolean][] = [
    [15072, 'mm2', true],
    [15072.0, 'mm2', true], // equivalent spelling
    [150.72, 'cm2', true], // unit conversion
    [150.7200, 'cm2', true], // trailing zeros equivalent after rounding
    [150.73, 'cm2', false],
    [15072, 'cm2', false],
    [15072, 'mm', false], // length unit for an area quantity
  ];
  for (const [value, unit, ok] of cases) {
    const result = evaluateResponse({
      rule,
      givens,
      snapshot,
      responseItems: [...MAPPING_OK, NUMBER('lateralArea', value, unit), NUMBER('circumference', 188.4, 'mm')],
    });
    const area = result.feedback.quantities?.find((q) => q.quantityId === 'lateralArea');
    assert.ok(area !== undefined, `area feedback missing for ${value}${unit}`);
    assert.equal(area.valueOk, ok, `value ${value} ${unit} expected ok=${ok}`);
    assert.equal(area.unitOk, unit === 'mm' ? false : true);
  }
});

test('range boundaries judge exactly (r=5/100, h=10/200)', () => {
  const rule = l2Rule();
  for (const [r, hh] of [[5, 10], [100, 200], [5, 120], [100, 10]] as const) {
    const snapshot = STATE(r, hh);
    const expectedAreaMm2 = 2 * 3.14 * r * hh; // exact in integers with pi=3.14
    const result = evaluateResponse({
      rule,
      givens: snapshot,
      snapshot,
      responseItems: [...MAPPING_OK, NUMBER('lateralArea', expectedAreaMm2, 'mm2'), NUMBER('circumference', 2 * 3.14 * r, 'mm')],
    });
    assert.equal(result.outcome, 'CORRECT', `boundary r=${r} h=${hh}`);
  }
});

test('half-up rounding discipline is explicit, not float epsilon', () => {
  const rule = l2Rule();
  // r=5: C = 31.4 mm exactly. A student answering 3.14 cm is exact; 3.1 cm
  // fails EXACT_AFTER_ROUNDING at 2 decimals (no tolerance absorbs it).
  const result31 = evaluateResponse({
    rule: l2Rule(),
    givens: STATE(5, 120),
    snapshot: STATE(5, 120),
    responseItems: [...MAPPING_OK, NUMBER('lateralArea', 3768, 'mm2'), NUMBER('circumference', 3.1, 'cm')],
  });
  assert.equal(result31.outcome, 'REVISE');
  void rule;
  const resultExact = evaluateResponse({
    rule: l2Rule(),
    givens: STATE(5, 120),
    snapshot: STATE(5, 120),
    responseItems: [...MAPPING_OK, NUMBER('lateralArea', 37.68, 'cm2'), NUMBER('circumference', 3.14, 'cm')],
  });
  assert.equal(resultExact.outcome, 'CORRECT');
});

test('high-fine counterexample r=5mm h=120mm: swapped edge mapping fails', () => {
  const rule = l2Rule();
  const swapped = [
    {
      kind: 'objectMapping',
      pairs: [
        { leftId: 'cyl.rim.top', rightId: 'net.edge.b1' }, // rims wrongly on the height edge
        { leftId: 'cyl.rim.bottom', rightId: 'net.edge.a2' },
        { leftId: 'cyl.seam.vertical', rightId: 'net.edge.a1' },
      ],
    },
  ] as never[];
  const result = evaluateResponse({
    rule,
    givens: STATE(5, 120),
    snapshot: STATE(5, 120),
    responseItems: [...swapped, NUMBER('lateralArea', 3768, 'mm2'), NUMBER('circumference', 31.4, 'mm')],
  });
  assert.equal(result.outcome, 'REVISE');
  assert.ok(result.feedback.mappingMatched !== undefined && result.feedback.mappingMatched < (result.feedback.mappingTotal ?? 0));
  // The correct topological mapping (short circumference edge) passes with S=37.68 cm².
  const correct = evaluateResponse({
    rule,
    givens: STATE(5, 120),
    snapshot: STATE(5, 120),
    responseItems: [...MAPPING_OK, NUMBER('lateralArea', 37.68, 'cm2'), NUMBER('circumference', 31.4, 'mm')],
  });
  assert.equal(correct.outcome, 'CORRECT');
});

test('L1 parameter identification: wrong/missing/extra judgments', () => {
  const rule: ParameterIdentificationRule = {
    ruleKind: 'PARAMETER_IDENTIFICATION_V1',
    expectedJudgments: [
      { propertyId: 'radius', direction: 'INCREASE' },
      { propertyId: 'diameter', direction: 'INCREASE' },
      { propertyId: 'height', direction: 'UNCHANGED' },
    ],
  };
  const givens = STATE(30, 80);
  const snapshot = STATE(40, 80);
  const correct = evaluateResponse({
    rule,
    givens,
    snapshot,
    responseItems: [{ kind: 'propertyJudgments', claims: [
      { propertyId: 'radius', direction: 'INCREASE' },
      { propertyId: 'diameter', direction: 'INCREASE' },
      { propertyId: 'height', direction: 'UNCHANGED' },
    ] }],
  });
  assert.equal(correct.outcome, 'CORRECT');
  const wrong = evaluateResponse({
    rule,
    givens,
    snapshot,
    responseItems: [{ kind: 'propertyJudgments', claims: [
      { propertyId: 'radius', direction: 'INCREASE' },
      { propertyId: 'diameter', direction: 'UNCHANGED' }, // wrong
      { propertyId: 'height', direction: 'UNCHANGED' },
    ] }],
  });
  assert.equal(wrong.outcome, 'REVISE');
  assert.deepEqual(wrong.feedback.wrongProperties, ['diameter']);
  // Missing height entirely.
  const missing = evaluateResponse({
    rule,
    givens,
    snapshot,
    responseItems: [{ kind: 'propertyJudgments', claims: [
      { propertyId: 'radius', direction: 'INCREASE' },
      { propertyId: 'diameter', direction: 'INCREASE' },
    ] }],
  });
  assert.equal(missing.outcome, 'REVISE');
  assert.deepEqual(missing.feedback.missingProperties, ['height']);
  // Scenario not run (radius unchanged) -> scenario-not-met, not scored wrong.
  const notRun = evaluateResponse({
    rule,
    givens,
    snapshot: STATE(30, 80),
    responseItems: [{ kind: 'propertyJudgments', claims: [
      { propertyId: 'radius', direction: 'INCREASE' },
      { propertyId: 'diameter', direction: 'INCREASE' },
      { propertyId: 'height', direction: 'UNCHANGED' },
    ] }],
  });
  assert.equal(notRun.outcome, 'REVISE');
  assert.equal(notRun.feedback.scenarioMet, false);
});

// -- integrated judging through the command surface ---------------------------

test('integrated flow: correct answer judged CORRECT via private rules only', async () => {
  const h = await createReadyHarness();
  try {
    // Walk the course graph to the L2 guided task using beginCycle? Simpler:
    // finish the L1 cycle then beginCycle to l1-independent... the graph is
    // linear, so drive straight through by using the graph's order.
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    const pred = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'l2-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    const op = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'l2-op',
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
      target,
      expectedAttemptVersion: pred.attemptVersion!,
    });
    const sub = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'l2-sub',
      payload: { response: [{ kind: 'propertyJudgments', claims: [
        { propertyId: 'radius', direction: 'INCREASE' },
        { propertyId: 'diameter', direction: 'INCREASE' },
        { propertyId: 'height', direction: 'UNCHANGED' },
      ] }] },
      target,
      expectedAttemptVersion: op.attemptVersion!,
    });
    assert.equal(sub.status, 'APPLIED');
    const evalRow = h.harness.storage.rawDatabase().prepare('SELECT outcome FROM evaluation').get() as { outcome: string };
    assert.equal(evalRow.outcome, 'CORRECT');
  } finally {
    await h.harness.closeAll();
  }
});

test('answer-revealing hint marks the cycle answer-assisted; assistance never rewrites evaluations', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'h-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    // Level 2 hints in the fixture reveal the answer.
    const hint = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.requestHint',
      idempotencyKey: 'h-hint',
      payload: { hintLevel: 2 },
      target,
    });
    assert.equal(hint.status, 'APPLIED');
    const op = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'h-op',
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
      target,
      expectedAttemptVersion: hint.attemptVersion!,
    });
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'h-sub',
      payload: { response: [{ kind: 'propertyJudgments', claims: [
        { propertyId: 'radius', direction: 'INCREASE' },
        { propertyId: 'diameter', direction: 'INCREASE' },
        { propertyId: 'height', direction: 'UNCHANGED' },
      ] }] },
      target,
      expectedAttemptVersion: op.attemptVersion!,
    });
    const submission = h.harness.storage.rawDatabase().prepare('SELECT assistanceSnapshotJson FROM submission').get() as {
      assistanceSnapshotJson: string;
    };
    const snapshot = JSON.parse(submission.assistanceSnapshotJson) as { answerHintPresented: boolean; hintCount: number };
    assert.equal(snapshot.answerHintPresented, true);
    assert.equal(snapshot.hintCount, 1);

    // Guardian records ANSWER-category assistance afterwards: the original
    // evaluation row is untouched; only the independence label derives later.
    const evalBefore = h.harness.storage.rawDatabase().prepare('SELECT * FROM evaluation').get();
    const assistance = await h.harness.cmd(h.guardianCtx, {
      kind: 'guardian.recordAssistance',
      idempotencyKey: 'h-assist',
      payload: { attemptId: att.attemptId, category: 'ANSWER', note: '直接告诉了答案' },
      target: { scope: 'FAMILY' },
    });
    assert.equal(assistance.status, 'APPLIED');
    const evalAfter = h.harness.storage.rawDatabase().prepare('SELECT * FROM evaluation').get();
    assert.deepEqual(evalAfter, evalBefore);

    // Hint level above the policy max is rejected.
    const overHint = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.requestHint',
      idempotencyKey: 'h-hint-9',
      payload: { hintLevel: 3 },
      target,
    });
    assert.equal(overHint.status, 'REJECTED');
    assert.equal(overHint.errorCode, 'INVALID_OPERATION');
  } finally {
    await h.harness.closeAll();
  }
});

test('rule unavailability is UNSCORABLE, never a wrong answer', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'u-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    // Simulate a technical content fault: clear the loaded release cache.
    await h.harness.content.close();
    const sub = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'u-sub',
      payload: { response: [{ kind: 'propertyJudgments', claims: [{ propertyId: 'radius', direction: 'INCREASE' }] }] },
      target,
      expectedAttemptVersion: 2,
    });
    assert.equal(sub.status, 'APPLIED');
    const evalRow = h.harness.storage.rawDatabase().prepare('SELECT outcome FROM evaluation').get() as { outcome: string };
    assert.equal(evalRow.outcome, 'UNSCORABLE');
  } finally {
    await h.harness.closeAll();
  }
});

test('open explanations are never keyword-scored; annotations are separate facts', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId);
    const target = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: att.cycleId };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'x-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target,
    });
    const op = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'x-op',
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 } },
      target,
      expectedAttemptVersion: 2,
    });
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'x-sub',
      payload: { response: [{ kind: 'propertyJudgments', claims: [
        { propertyId: 'radius', direction: 'DECREASE' }, // WRONG on purpose
      ] }] },
      target,
      expectedAttemptVersion: op.attemptVersion!,
    });
    const bex = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.beginExplanation',
      idempotencyKey: 'x-bex',
      payload: {},
      target,
      expectedAttemptVersion: op.attemptVersion! + 1,
    });
    // The child writes the "correct keywords" in the free text.
    const sex = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.saveExplanation',
      idempotencyKey: 'x-sex',
      payload: { selections: [], freeText: '半径增大直径增大高度不变', transcribedByGuardian: false },
      target,
      expectedAttemptVersion: bex.attemptVersion!,
    });
    assert.equal(sex.status, 'APPLIED');
    // The evaluation stays REVISE: no keyword pass, no auto upgrade.
    const evalRow = h.harness.storage.rawDatabase().prepare('SELECT outcome FROM evaluation').get() as { outcome: string };
    assert.equal(evalRow.outcome, 'REVISE');
    const evaluations = h.harness.storage.rawDatabase().prepare('SELECT COUNT(*) c FROM evaluation').get() as { c: number };
    assert.equal(evaluations.c, 1);

    // Guardian rubric annotation lands in its own table.
    const revisionId = h.harness.storage.rawDatabase().prepare('SELECT revisionId FROM explanationRevision').get() as { revisionId: string };
    const annotate = await h.harness.cmd(h.guardianCtx, {
      kind: 'guardian.annotateExplanation',
      idempotencyKey: 'x-annot',
      payload: { explanationRevisionRef: revisionId.revisionId, rubric: { condition: 'ESTABLISHED', relation: 'EMERGING', basis: 'NOT_OBSERVED' } },
      target: { scope: 'FAMILY' },
    });
    assert.equal(annotate.status, 'APPLIED');
    const obs = h.harness.storage.rawDatabase().prepare('SELECT conditionObserved, relationObserved, basisObserved FROM guardianObservation').get() as {
      conditionObserved: string;
      relationObserved: string;
      basisObserved: string;
    };
    assert.equal(obs.conditionObserved, 'ESTABLISHED');
    assert.equal(obs.relationObserved, 'EMERGING');
    assert.equal(obs.basisObserved, 'NOT_OBSERVED');
    // ...and the child's evaluation is STILL unchanged.
    const evalRow2 = h.harness.storage.rawDatabase().prepare('SELECT outcome FROM evaluation').get() as { outcome: string };
    assert.equal(evalRow2.outcome, 'REVISE');
    void SYNTH_RELEASE_ID;
  } finally {
    await h.harness.closeAll();
  }
});

// -- full course-graph walk: L1 chain into L2 guided and the high-fine task ----

async function completeCycle(
  h: Awaited<ReturnType<typeof createReadyHarness>>,
  ctx: Parameters<Harness2['cmd']>[0],
  learnerId: string,
  attemptId: string,
  key: string,
  steps: {
    operation?: { type: string; [k: string]: unknown };
    response: unknown[];
  },
): Promise<number> {
  const view = await h.harness.server.query(ctx, { kind: 'learning.attemptView', attemptId });
  if (view.kind !== 'learning.attemptView') throw new Error('no view');
  const cycleId = view.currentCycle?.cycleId ?? '';
  const target = { scope: 'LEARNER' as const, learnerId, attemptId, cycleId };
  let version = view.version;
  const pred = await h.harness.cmd(ctx, {
    kind: 'learning.recordPrediction',
    idempotencyKey: `${key}-pred`,
    payload: { prediction: { claims: [] }, uncertain: true },
    target,
  });
  version = pred.attemptVersion ?? version;
  if (steps.operation !== undefined) {
    const op = await h.harness.cmd(ctx, {
      kind: 'learning.commitOperation',
      idempotencyKey: `${key}-op`,
      payload: { operation: steps.operation },
      target,
      expectedAttemptVersion: version,
    });
    if (op.status !== 'APPLIED') throw new Error(`op failed: ${JSON.stringify(op)}`);
    version = op.attemptVersion!;
  }
  const sub = await h.harness.cmd(ctx, {
    kind: 'learning.submitResponse',
    idempotencyKey: `${key}-sub`,
    payload: { response: steps.response },
    target,
    expectedAttemptVersion: version,
  });
  if (sub.status !== 'APPLIED') throw new Error(`sub failed: ${JSON.stringify(sub)}`);
  version = sub.attemptVersion!;
  const bex = await h.harness.cmd(ctx, {
    kind: 'learning.beginExplanation',
    idempotencyKey: `${key}-bex`,
    payload: {},
    target,
    expectedAttemptVersion: version,
  });
  const sex = await h.harness.cmd(ctx, {
    kind: 'learning.saveExplanation',
    idempotencyKey: `${key}-sex`,
    payload: { selections: [], freeText: '我解释了', transcribedByGuardian: false },
    target,
    expectedAttemptVersion: bex.attemptVersion!,
  });
  return sex.attemptVersion!;
}

type Harness2 = import('../fixtures/harness').Harness;

test('course-graph walk judges L2 guided AND the high-fine counterexample end to end', async () => {
  const h = await createReadyHarness();
  try {
    const att = await startAttempt(h.harness, h.learnerCtx, h.learnerId, 'walk-start');
    // Cycle 1: L1 guided (r30->40).
    let version = await completeCycle(h, h.learnerCtx, h.learnerId, att.attemptId, 'w1', {
      operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 },
      response: [{ kind: 'propertyJudgments', claims: [
        { propertyId: 'radius', direction: 'INCREASE' },
        { propertyId: 'diameter', direction: 'INCREASE' },
        { propertyId: 'height', direction: 'UNCHANGED' },
      ] }],
    });
    const evalOutcomes = () =>
      (h.harness.storage.rawDatabase().prepare('SELECT outcome FROM evaluation ORDER BY at').all() as { outcome: string }[]).map((r) => r.outcome);
    assert.deepEqual(evalOutcomes(), ['CORRECT']);

    // Cycle 2: L1 independent (r25->15, DECREASE scenario).
    const c2 = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.beginCycle',
      idempotencyKey: 'w2-begin',
      payload: { taskId: 'task-l1-independent' },
      target: { scope: 'LEARNER', learnerId: h.learnerId, attemptId: att.attemptId },
      expectedAttemptVersion: version,
    });
    assert.equal(c2.status, 'APPLIED');
    version = await completeCycle(h, h.learnerCtx, h.learnerId, att.attemptId, 'w2', {
      operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 15 },
      response: [{ kind: 'propertyJudgments', claims: [
        { propertyId: 'radius', direction: 'DECREASE' },
        { propertyId: 'diameter', direction: 'DECREASE' },
        { propertyId: 'height', direction: 'UNCHANGED' },
      ] }],
    });
    assert.deepEqual(evalOutcomes(), ['CORRECT', 'CORRECT']);

    // Cycle 3: L2 guided -- unroll, mapping, C=188.4mm, S=15072mm².
    const c3 = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.beginCycle',
      idempotencyKey: 'w3-begin',
      payload: { taskId: 'task-l2-guided' },
      target: { scope: 'LEARNER', learnerId: h.learnerId, attemptId: att.attemptId },
      expectedAttemptVersion: version,
    });
    assert.equal(c3.status, 'APPLIED');
    version = await completeCycle(h, h.learnerCtx, h.learnerId, att.attemptId, 'w3', {
      operation: { type: 'SetUnroll', valuePermille: 1000 },
      response: [
        { kind: 'objectMapping', pairs: [
          { leftId: 'cyl.rim.top', rightId: 'net.edge.a1' },
          { leftId: 'cyl.rim.bottom', rightId: 'net.edge.a2' },
          { leftId: 'cyl.seam.vertical', rightId: 'net.edge.b1' },
        ] },
        { kind: 'numberWithUnit', quantityId: 'circumference', value: 18.84, unitId: 'cm' },
        { kind: 'numberWithUnit', quantityId: 'lateralArea', value: 150.72, unitId: 'cm2' },
      ],
    });
    assert.deepEqual(evalOutcomes(), ['CORRECT', 'CORRECT', 'CORRECT']);

    // Cycle 4: high-fine r=5 h=120. First a WRONG swapped mapping -> REVISE,
    // then reviseResponse -> corrected submission with S=37.68 cm².
    const c4 = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.beginCycle',
      idempotencyKey: 'w4-begin',
      payload: { taskId: 'task-l2-highfine' },
      target: { scope: 'LEARNER', learnerId: h.learnerId, attemptId: att.attemptId },
      expectedAttemptVersion: version,
    });
    assert.equal(c4.status, 'APPLIED');
    // Locked dimensions: SetDimension is rejected on this assessment task.
    const locked = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'w4-locked',
      payload: { operation: { type: 'SetDimension', dimension: 'RADIUS', valueMm: 20 } },
      target: { scope: 'LEARNER', learnerId: h.learnerId, attemptId: att.attemptId },
      expectedAttemptVersion: c4.attemptVersion!,
    });
    assert.equal(locked.status, 'REJECTED');
    assert.equal(locked.errorCode, 'INVALID_OPERATION');

    const view4 = await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId: att.attemptId });
    const cycleId4 = (view4 as { currentCycle?: { cycleId: string } }).currentCycle?.cycleId ?? '';
    const target4 = { scope: 'LEARNER' as const, learnerId: h.learnerId, attemptId: att.attemptId, cycleId: cycleId4 };
    await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.recordPrediction',
      idempotencyKey: 'w4-pred',
      payload: { prediction: { claims: [] }, uncertain: true },
      target: target4,
    });
    // Use the view's real version for CAS correctness.
    const fresh = await h.harness.server.query(h.learnerCtx, { kind: 'learning.attemptView', attemptId: att.attemptId });
    const versionNow = (fresh as { version: number }).version;
    const unrollOk = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.commitOperation',
      idempotencyKey: 'w4-op-2',
      payload: { operation: { type: 'SetUnroll', valuePermille: 1000 } },
      target: target4,
      expectedAttemptVersion: versionNow,
    });
    assert.equal(unrollOk.status, 'APPLIED');
    const wrongSub = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'w4-sub-wrong',
      payload: { response: [
        { kind: 'objectMapping', pairs: [
          { leftId: 'cyl.rim.top', rightId: 'net.edge.b1' },
          { leftId: 'cyl.rim.bottom', rightId: 'net.edge.a2' },
          { leftId: 'cyl.seam.vertical', rightId: 'net.edge.a1' },
        ] },
        { kind: 'numberWithUnit', quantityId: 'lateralArea', value: 3768, unitId: 'mm2' },
      ] },
      target: target4,
      expectedAttemptVersion: unrollOk.attemptVersion!,
    });
    assert.equal(wrongSub.status, 'APPLIED');
    assert.equal(evalOutcomes()[3], 'REVISE');
    const revise = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.reviseResponse',
      idempotencyKey: 'w4-revise',
      payload: {},
      target: target4,
      expectedAttemptVersion: wrongSub.attemptVersion!,
    });
    assert.equal(revise.status, 'APPLIED');
    const corrected = await h.harness.cmd(h.learnerCtx, {
      kind: 'learning.submitResponse',
      idempotencyKey: 'w4-sub-right',
      payload: { response: [
        { kind: 'objectMapping', pairs: [
          { leftId: 'cyl.rim.top', rightId: 'net.edge.a1' },
          { leftId: 'cyl.rim.bottom', rightId: 'net.edge.a2' },
          { leftId: 'cyl.seam.vertical', rightId: 'net.edge.b1' },
        ] },
        { kind: 'numberWithUnit', quantityId: 'lateralArea', value: 37.68, unitId: 'cm2' },
      ] },
      target: target4,
      expectedAttemptVersion: revise.attemptVersion!,
    });
    assert.equal(corrected.status, 'APPLIED');
    assert.deepEqual(evalOutcomes(), ['CORRECT', 'CORRECT', 'CORRECT', 'REVISE', 'CORRECT']);
  } finally {
    await h.harness.closeAll();
  }
});

test('sampled independent task stays inside its construction domains', async () => {
  const h = await createReadyHarness();
  try {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const givens = h.harness.content.sampleGivens(SYNTH_RELEASE_ID, 'task-l2-independent', `entropy-${i}`);
      assert.ok(givens.radiusMm >= 10 && givens.radiusMm <= 100, `radius out of domain: ${givens.radiusMm}`);
      assert.ok(givens.heightMm >= 10 && givens.heightMm <= 200, `height out of domain: ${givens.heightMm}`);
      seen.add(`${givens.radiusMm}x${givens.heightMm}`);
      // Determinism: same entropy, same sample.
      const again = h.harness.content.sampleGivens(SYNTH_RELEASE_ID, 'task-l2-independent', `entropy-${i}`);
      assert.deepEqual(again, givens);
    }
    assert.ok(seen.size > 1, 'sampling should vary with entropy');
  } finally {
    await h.harness.closeAll();
  }
});

// GAP-2 ruling (2026-10-27): edge pairing is undirected. B-authored truth
// spells pairs cylinder->net; C's UI asks from the strip side, so the learner
// submits leftId=netEdgeId. Both spellings of the SAME pair must match.
test('edge pairing direction is normalized: C-direction submission (leftId=netEdgeId) is also CORRECT', () => {
  const givens = STATE(30, 80);
  const snapshot = STATE(30, 80);

  // v1 family (NUMERIC_RELATION_V1 / TRANSFER branches): same pairs, reversed
  // spelling, plus the quantity answers the rule also checks.
  const v1 = evaluateResponse({
    rule: l2Rule(),
    givens,
    snapshot,
    responseItems: [
      { kind: 'objectMapping', pairs: [
        { leftId: 'net.edge.a1', rightId: 'cyl.rim.top' },
        { leftId: 'net.edge.a2', rightId: 'cyl.rim.bottom' },
        { leftId: 'net.edge.b1', rightId: 'cyl.seam.vertical' },
      ] },
      NUMBER('lateralArea', 15072, 'mm2'),
      NUMBER('circumference', 188.4, 'mm'),
    ] as never[],
  });
  assert.equal(v1.outcome, 'CORRECT', 'v1 expectedEdgeMapping must accept the reversed spelling');

  // v2 EDGE_PAIRING body (the C pairing tasks' rule truth).
  const v2 = evaluateResponseV2({
    rule: {
      kind: 'EDGE_PAIRING',
      expectedEdgeMapping: [
        { cylinderObjectId: 'cyl-part-height-line', netEdgeId: 'net-edge-1' },
        { cylinderObjectId: 'cyl-part-upper-circle', netEdgeId: 'net-edge-2' },
        { cylinderObjectId: 'cyl-part-height-line', netEdgeId: 'net-edge-3' },
        { cylinderObjectId: 'cyl-part-lower-circle', netEdgeId: 'net-edge-4' },
      ],
    } as never,
    taskId: 'cyl.net.g2.edge-pairing.v1',
    givens,
    snapshot,
    responseItems: [
      { kind: 'objectMapping', pairs: [
        { leftId: 'net-edge-1', rightId: 'cyl-part-height-line' },
        { leftId: 'net-edge-2', rightId: 'cyl-part-upper-circle' },
        { leftId: 'net-edge-3', rightId: 'cyl-part-height-line' },
        { leftId: 'net-edge-4', rightId: 'cyl-part-lower-circle' },
      ] },
    ] as never[],
  });
  assert.equal(v2.outcome, 'CORRECT', 'v2 EDGE_PAIRING must accept the C-direction spelling');
  assert.equal(v2.feedback.mappingTotal, 4);

  // A genuinely wrong pair (different id set) still fails after normalization.
  const wrong = evaluateResponseV2({
    rule: {
      kind: 'EDGE_PAIRING',
      expectedEdgeMapping: [
        { cylinderObjectId: 'cyl-part-height-line', netEdgeId: 'net-edge-1' },
        { cylinderObjectId: 'cyl-part-upper-circle', netEdgeId: 'net-edge-2' },
      ],
    } as never,
    taskId: 'cyl.net.g2.edge-pairing.v1',
    givens,
    snapshot,
    responseItems: [
      { kind: 'objectMapping', pairs: [
        { leftId: 'net-edge-1', rightId: 'cyl-part-upper-circle' },
        { leftId: 'net-edge-2', rightId: 'cyl-part-upper-circle' },
      ] },
    ] as never[],
  });
  assert.equal(wrong.outcome, 'REVISE', 'normalized comparison must still reject mismatched pairs');
});
