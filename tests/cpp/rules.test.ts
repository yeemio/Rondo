/**
 * STEP_TASK_TRUTH judging tests: for every cpp.u1 task one CORRECT case
 * (canonical repair/edition + canonical response) and at least one REVISE
 * case, plus the named diagnostics (offByOneBound, samplePassedHiddenFailed,
 * divRounding). Judging runs through the SAME module the dev-side Host
 * stand-in uses (modules/scenes/steps/judge.ts over the shared engine).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StructuredResponseItem } from '../../modules/contracts/public/envelope';
import type { StepProgramStateV1, StepSpecV1 } from '../../modules/contracts/public/scene-steps';
import type { StepTaskTruthRule } from '../../modules/contracts/server/rules-steps';
import { judgeStepTask } from '../../modules/scenes/steps/judge';

const ROOT = process.cwd();
const PRIV = join(ROOT, 'content', 'cpp', 'private');

const A = (v: string, expr: string): StepSpecV1 => ({ kind: 'ASSIGN', var: v, expr });
const O = (expr: string): StepSpecV1 => ({ kind: 'OUTPUT', expr });
const IF = (cond: string, then: StepSpecV1[], els: StepSpecV1[] = [], checkpointId?: string): StepSpecV1 =>
  checkpointId ? { kind: 'IF', checkpointId, cond, then, else: els } : { kind: 'IF', cond, then, else: els };
const FOR = (v: string, from: string, bound: string, cmp: '<' | '<=', body: StepSpecV1[]): StepSpecV1 => ({
  kind: 'FOR',
  var: v,
  from,
  bound,
  cmp,
  body,
});

const state = (program: StepSpecV1[], inputs: Record<string, number>): StepProgramStateV1 => ({ program, inputs, cursorStep: 0 });

const outLines = (lines: string[]): StructuredResponseItem => ({ kind: 'outputLines', quantityId: 'output', lines });
const finals = (values: Array<[string, number]>): StructuredResponseItem => ({
  kind: 'variableValues',
  values: values.map(([varId, value]) => ({ varId, value })),
});
const branch = (checkpointId: string, outcome: 'TAKEN' | 'SKIPPED'): StructuredResponseItem => ({
  kind: 'branchTrace',
  marks: [{ checkpointId, outcome }],
});
const choice = (selectionId: string, optionId: string): StructuredResponseItem => ({ kind: 'singleChoice', selectionId, optionId });
const num = (quantityId: string, value: number): StructuredResponseItem => ({ kind: 'numberWithUnit', quantityId, value, unitId: 'count' });

function ruleFor(taskId: string): StepTaskTruthRule {
  for (const f of ['rule.cppU1.trace.v1.json', 'rule.cppU1.branch.v1.json', 'rule.cppU1.program.v1.json']) {
    const rule = JSON.parse(readFileSync(join(PRIV, 'rules', f), 'utf8'));
    if (rule.body?.entries?.[taskId]) return rule.body as StepTaskTruthRule;
  }
  throw new Error(`no rule entry for ${taskId}`);
}

const judge = (taskId: string, snapshot: StepProgramStateV1, response: StructuredResponseItem[]) =>
  judgeStepTask({ taskId, rule: ruleFor(taskId), snapshot, responseItems: response });

const failKeys = (r: ReturnType<typeof judge>): string[] => r.itemResults.filter((i) => i.verdict === 'REVISE').map((i) => i.key);

// ---------------------------------------------------------------------------
// g1 顺序与变量重赋值（SNAPSHOT_RERUN）
// ---------------------------------------------------------------------------

test('judge g1: canonical edited card + matching response is CORRECT', () => {
  const edited = [A('a', '12'), A('b', '7'), A('total', 'a + b'), A('total', 'total + 6'), O('a'), O('total')];
  const r = judge('cpp.u1.g1.receipt-trace.v1', state(edited, {}), [
    outLines(['12', '25']),
    finals([['a', 12], ['b', 7], ['total', 25]]),
    choice('sel.g1.total-old-new', 'opt-old'),
  ]);
  assert.equal(r.verdict, 'CORRECT', JSON.stringify(r.itemResults));
});

test('judge g1: unedited card judged against its own snapshot (typed mismatch revises)', () => {
  const original = [A('a', '12'), A('b', '7'), A('total', 'a + b'), A('total', 'total + 4'), O('total')];
  // typed what the ORIGINAL card outputs — output/finals keyed to the
  // snapshot are CORRECT, but the concept choice is judged statically
  const ok = judge('cpp.u1.g1.receipt-trace.v1', state(original, {}), [
    outLines(['23']),
    finals([['a', 12], ['b', 7], ['total', 23]]),
    choice('sel.g1.total-old-new', 'opt-old'),
  ]);
  assert.equal(ok.verdict, 'CORRECT', 'snapshot-rerun accepts reading the current card');
  // concept miss revises even when the reading is right
  const bad = judge('cpp.u1.g1.receipt-trace.v1', state(original, {}), [
    outLines(['23']),
    finals([['a', 12], ['b', 7], ['total', 23]]),
    choice('sel.g1.total-old-new', 'opt-new'),
  ]);
  assert.equal(bad.verdict, 'REVISE');
  assert.deepEqual(failKeys(bad), ['concept:sel.g1.total-old-new']);
});

// ---------------------------------------------------------------------------
// g2 整数除法与取余（AUTHORED：第二问 100/12）
// ---------------------------------------------------------------------------

test('judge g2: completed second question is CORRECT; stopped-at-first-question revises', () => {
  const done = [A('n', '100'), A('k', '12'), A('bags', 'n / k'), A('left', 'n % k'), O('bags'), O('left')];
  const r = judge('cpp.u1.g2.pack-sweets.v1', state(done, {}), [
    outLines(['8', '4']),
    finals([['n', 100], ['k', 12], ['bags', 8], ['left', 4]]),
    choice('sel.g2.neg-div', 'opt-neg-div-a'),
    choice('sel.g2.neg-rem', 'opt-neg-rem-sign'),
  ]);
  assert.equal(r.verdict, 'CORRECT', JSON.stringify(r.itemResults));
  // stopped after the first question (n=100, k=8) — authored key demands 8/4
  const first = [A('n', '100'), A('k', '8'), A('bags', 'n / k'), A('left', 'n % k'), O('bags'), O('left')];
  const stop = judge('cpp.u1.g2.pack-sweets.v1', state(first, {}), [
    outLines(['12', '4']),
    finals([['n', 100], ['k', 8], ['bags', 12], ['left', 4]]),
    choice('sel.g2.neg-div', 'opt-neg-div-a'),
    choice('sel.g2.neg-rem', 'opt-neg-rem-sign'),
  ]);
  assert.equal(stop.verdict, 'REVISE');
  assert.ok(failKeys(stop).includes('output'), 'authored output key must catch the unfinished edit');
});

test('judge g2: choosing the floor answer fires the divRounding diagnostic (no values leaked)', () => {
  const done = [A('n', '100'), A('k', '12'), A('bags', 'n / k'), A('left', 'n % k'), O('bags'), O('left')];
  const r = judge('cpp.u1.g2.pack-sweets.v1', state(done, {}), [
    outLines(['8', '4']),
    finals([['n', 100], ['k', 12], ['bags', 8], ['left', 4]]),
    choice('sel.g2.neg-div', 'opt-neg-div-floor'),
    choice('sel.g2.neg-rem', 'opt-neg-rem-sign'),
  ]);
  assert.equal(r.verdict, 'REVISE');
  assert.ok(r.diagnostics.includes('divRounding'));
  const fb = r.itemResults.find((i) => i.key === 'concept:sel.g2.neg-div')?.feedback ?? '';
  assert.ok(fb.includes('整数除法不是四舍五入'), 'diagnostic text is the authored prompt');
  assert.ok(!/\d/.test(fb.replace(/1,000,000,000/g, '').replace(/[0-9]+/g, '')), 'feedback carries no expected numbers');
});

// ---------------------------------------------------------------------------
// g3 结构化 if（SNAPSHOT_RERUN + branchTrace）
// ---------------------------------------------------------------------------

test('judge g3: branch trace + finals keyed to the snapshot; counterfactual concept static', () => {
  const card = [A('total', '47'), IF('total >= 30', [A('pay', 'total - 5')], [A('pay', 'total')], 'if-1'), O('pay')];
  const r = judge('cpp.u1.g3.member-discount.v1', state(card, {}), [
    branch('if-1', 'TAKEN'),
    outLines(['42']),
    finals([['total', 47], ['pay', 42]]),
    choice('sel.g3.ge-vs-gt', 'opt-original'),
  ]);
  assert.equal(r.verdict, 'CORRECT', JSON.stringify(r.itemResults));
  // moved total to 30: snapshot keys 25/TAKEN; wrong branch mark revises
  const card30 = [A('total', '30'), IF('total >= 30', [A('pay', 'total - 5')], [A('pay', 'total')], 'if-1'), O('pay')];
  const bad = judge('cpp.u1.g3.member-discount.v1', state(card30, {}), [
    branch('if-1', 'SKIPPED'),
    outLines(['25']),
    finals([['total', 30], ['pay', 25]]),
    choice('sel.g3.ge-vs-gt', 'opt-original'),
  ]);
  assert.equal(bad.verdict, 'REVISE');
  assert.ok(failKeys(bad).includes('branch'));
});

// ---------------------------------------------------------------------------
// g4 有界 for（SNAPSHOT_RERUN + trip-count derived from the trace）
// ---------------------------------------------------------------------------

test('judge g4: canonical card CORRECT; explored bound-100 card judges on its own snapshot', () => {
  const card = [A('sum', '0'), FOR('i', '1', '5', '<=', [A('sum', 'sum + i')]), O('sum')];
  const r = judge('cpp.u1.g4.sales-sum.v1', state(card, {}), [
    outLines(['15']),
    finals([['sum', 15], ['i', 6]]),
    num('g4.trip-count', 5),
    choice('sel.g4.while-equiv', 'opt-same'),
  ]);
  assert.equal(r.verdict, 'CORRECT', JSON.stringify(r.itemResults));

  const explored = [A('sum', '0'), FOR('i', '1', '100', '<=', [A('sum', 'sum + i')]), O('sum')];
  const r100 = judge('cpp.u1.g4.sales-sum.v1', state(explored, {}), [
    outLines(['5050']),
    finals([['sum', 5050], ['i', 101]]),
    num('g4.trip-count', 100),
    choice('sel.g4.while-equiv', 'opt-same'),
  ]);
  assert.equal(r100.verdict, 'CORRECT', 'legitimate exploration is judged on what the card does');

  const wrongTrips = judge('cpp.u1.g4.sales-sum.v1', state(card, {}), [
    outLines(['15']),
    finals([['sum', 15], ['i', 6]]),
    num('g4.trip-count', 4),
    choice('sel.g4.while-equiv', 'opt-same'),
  ]);
  assert.equal(wrongTrips.verdict, 'REVISE');
  assert.ok(failKeys(wrongTrips).includes('number:g4.trip-count'));
});

// ---------------------------------------------------------------------------
// i1 修边界（AUTHORED + hidden EX-B + diagnostics）
// ---------------------------------------------------------------------------

test('judge i1: repaired program + response CORRECT; unfixed bug revises with offByOneBound', () => {
  const fixed = [A('sum', '0'), FOR('i', '1', 'n', '<=', [A('sum', 'sum + i')]), O('sum')];
  const r = judge('cpp.u1.i1.fix-boundary.v1', state(fixed, { n: 10 }), [
    outLines(['55']),
    finals([['sum', 55], ['i', 11]]),
    choice('sel.i1.missed-loop', 'opt-loop10'),
  ]);
  assert.equal(r.verdict, 'CORRECT', JSON.stringify(r.itemResults));

  const bug = [A('sum', '0'), FOR('i', '1', 'n', '<', [A('sum', 'sum + i')]), O('sum')];
  const rb = judge('cpp.u1.i1.fix-boundary.v1', state(bug, { n: 10 }), [
    outLines(['45']),
    finals([['sum', 45], ['i', 10]]),
    choice('sel.i1.missed-loop', 'opt-loop10'),
  ]);
  assert.equal(rb.verdict, 'REVISE');
  assert.ok(failKeys(rb).some((k) => k.startsWith('program') || k === 'output'));
  assert.ok(rb.diagnostics.includes('offByOneBound'), 'flip-to-<= repairs exactly -> diagnostic');
});

test('judge i1: hardcoded bound passes visible but fails hidden (samplePassedHiddenFailed)', () => {
  // patched for the visible n only: bound as literal 10
  const hack = [A('sum', '0'), FOR('i', '1', '10', '<=', [A('sum', 'sum + i')]), O('sum')];
  const r = judge('cpp.u1.i1.fix-boundary.v1', state(hack, { n: 10 }), [
    outLines(['55']),
    finals([['sum', 55], ['i', 11]]),
    choice('sel.i1.missed-loop', 'opt-loop10'),
  ]);
  assert.equal(r.verdict, 'REVISE');
  assert.ok(failKeys(r).includes('program'), 'hidden EX-B (n=20 -> 210) must fail the hack');
  assert.ok(r.diagnostics.includes('samplePassedHiddenFailed'));
});

// ---------------------------------------------------------------------------
// i2 / i3 / s1 / d1（AUTHORED + hidden + structural）
// ---------------------------------------------------------------------------

test('judge i2: fixed condition CORRECT; n=0/n=4 hidden cases catch partial fixes', () => {
  const fixed = [A('count', '0'), FOR('i', '1', 'n', '<=', [IF('i % 4 == 0', [A('count', 'count + 1')])]), O('count')];
  const r = judge('cpp.u1.i2.enum-count.v1', state(fixed, { n: 40 }), [
    outLines(['10']),
    finals([['count', 10], ['i', 41], ['n', 40]]),
    choice('sel.i2.range-check', 'opt-exact'),
  ]);
  assert.equal(r.verdict, 'CORRECT', JSON.stringify(r.itemResults));

  // leaves the shipped bug (i % 4 == 4): output 0 vs 10
  const bug = [A('count', '0'), FOR('i', '1', 'n', '<=', [IF('i % 4 == 4', [A('count', 'count + 1')])]), O('count')];
  const rb = judge('cpp.u1.i2.enum-count.v1', state(bug, { n: 40 }), [
    outLines(['0']),
    finals([['count', 0], ['i', 41], ['n', 40]]),
    choice('sel.i2.range-check', 'opt-exact'),
  ]);
  assert.equal(rb.verdict, 'REVISE');
});

test('judge i3: repaired order CORRECT; scrambled skeleton revises', () => {
  const repaired = [
    A('ones', 'n % 10'),
    A('n', 'n / 10'),
    A('tens', 'n % 10'),
    A('n', 'n / 10'),
    A('hundreds', 'n % 10'),
    O('ones'),
    O('tens'),
    O('hundreds'),
  ];
  const r = judge('cpp.u1.i3.build-digits.v1', state(repaired, { n: 358 }), [
    outLines(['8', '5', '3']),
    finals([['n', 3], ['ones', 8], ['tens', 5], ['hundreds', 3]]),
    choice('sel.i3.order-first', 'opt-shrink-after'),
  ]);
  assert.equal(r.verdict, 'CORRECT', JSON.stringify(r.itemResults));

  const scrambled = [
    A('n', 'n / 10'),
    A('ones', 'n % 10'),
    A('tens', 'n % 10'),
    A('hundreds', 'n % 10'),
    O('ones'),
    O('tens'),
    O('hundreds'),
  ];
  const rb = judge('cpp.u1.i3.build-digits.v1', state(scrambled, { n: 358 }), [
    outLines(['5', '5', '5']),
    finals([['n', 35], ['ones', 5], ['tens', 5], ['hundreds', 5]]),
    choice('sel.i3.order-first', 'opt-shrink-after'),
  ]);
  assert.equal(rb.verdict, 'REVISE');
});

test('judge s1: complete fix CORRECT; missing lastClap record fails hidden', () => {
  const fixed = [
    A('clapCount', '0'),
    A('lastClap', '0'),
    FOR('i', '1', 'n', '<=', [IF('i % 3 == 0', [A('clapCount', 'clapCount + 1'), A('lastClap', 'i')])]),
    O('clapCount'),
    O('lastClap'),
  ];
  const r = judge('cpp.u1.s1.stranger-transfer.v1', state(fixed, { n: 60 }), [
    outLines(['20', '60']),
    finals([['clapCount', 20], ['lastClap', 60], ['i', 61], ['n', 60]]),
    choice('sel.s1.count-last-diff', 'opt-roles-split'),
  ]);
  assert.equal(r.verdict, 'CORRECT', JSON.stringify(r.itemResults));

  // cond fixed but lastClap never recorded: both lines wrong (20, 0)
  const half = [
    A('clapCount', '0'),
    A('lastClap', '0'),
    FOR('i', '1', 'n', '<=', [IF('i % 3 == 0', [A('clapCount', 'clapCount + 1')])]),
    O('clapCount'),
    O('lastClap'),
  ];
  const rb = judge('cpp.u1.s1.stranger-transfer.v1', state(half, { n: 60 }), [
    outLines(['20', '0']),
    finals([['clapCount', 20], ['lastClap', 0], ['i', 61], ['n', 60]]),
    choice('sel.s1.count-last-diff', 'opt-roles-split'),
  ]);
  assert.equal(rb.verdict, 'REVISE');
});

test('judge d1: || condition CORRECT; tens-only condition revises (overlap counted once)', () => {
  const fixed = [
    A('count', '0'),
    FOR('i', 'lo', 'hi', '<=', [IF('i / 10 % 10 == 7 || i % 10 == 7', [A('count', 'count + 1')])]),
    O('count'),
  ];
  const r = judge('cpp.u1.d1.delayed-transfer.v1', state(fixed, { lo: 260, hi: 299 }), [
    outLines(['13']),
    finals([['count', 13], ['lo', 260], ['hi', 299]]),
    choice('sel.d1.or-both', 'opt-add-once'),
  ]);
  assert.equal(r.verdict, 'CORRECT', JSON.stringify(r.itemResults));

  const tensOnly = [
    A('count', '0'),
    FOR('i', 'lo', 'hi', '<=', [IF('i / 10 % 10 == 7', [A('count', 'count + 1')])]),
    O('count'),
  ];
  const rb = judge('cpp.u1.d1.delayed-transfer.v1', state(tensOnly, { lo: 260, hi: 299 }), [
    outLines(['10']),
    finals([['count', 10], ['lo', 260], ['hi', 299]]),
    choice('sel.d1.or-both', 'opt-add-once'),
  ]);
  assert.equal(rb.verdict, 'REVISE');
});

test('judge: structural constraints catch construct removal (i2 without IF)', () => {
  const noIf = [A('count', '0'), FOR('i', '1', 'n', '<=', [A('count', 'count + 1')]), O('count')];
  const r = judge('cpp.u1.i2.enum-count.v1', state(noIf, { n: 40 }), [
    outLines(['40']),
    finals([['count', 40], ['i', 41], ['n', 40]]),
    choice('sel.i2.range-check', 'opt-exact'),
  ]);
  assert.equal(r.verdict, 'REVISE');
  assert.ok(failKeys(r).includes('structural'), 'requiredConstructs [FOR, IF] must be enforced');
});

test('judge: unknown task is UNSCORABLE (technical, never wrong)', () => {
  const r = judgeStepTask({
    taskId: 'cpp.u1.nope.v1',
    rule: ruleFor('cpp.u1.i1.fix-boundary.v1'),
    snapshot: state([O('1')], {}),
    responseItems: [outLines(['1'])],
  });
  assert.equal(r.verdict, 'UNSCORABLE');
});
