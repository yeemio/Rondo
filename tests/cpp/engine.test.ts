/**
 * rondo-step.v1 engine tests: grammar, frozen C++11 semantics, budgets,
 * invariants, the hand-check expectation table, and slot-level edit
 * validation. Every expected value is hand-computed (UNIT-SPEC §4; the table
 * itself ships in content/cpp/private/rules/hand-check-table.json and is
 * re-verified here against the shared interpreter).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StepSpecV1 } from '../../modules/contracts/public/scene-steps';
import {
  countStatements,
  normalizeOutputLines,
  outputLinesEqual,
  runStepProgram,
  traceLength,
  tryParseCond,
  tryParseIntExpr,
  validateStepEdit,
  validateStepProgram,
} from '../../modules/scenes/steps/engine';

const ROOT = process.cwd();
const A = (v: string, expr: string): StepSpecV1 => ({ kind: 'ASSIGN', var: v, expr });
const O = (expr: string): StepSpecV1 => ({ kind: 'OUTPUT', expr });
const IF = (cond: string, then: StepSpecV1[], els: StepSpecV1[] = []): StepSpecV1 => ({ kind: 'IF', cond, then, else: els });
const FOR = (v: string, from: string, bound: string, cmp: '<' | '<=', body: StepSpecV1[]): StepSpecV1 => ({
  kind: 'FOR',
  var: v,
  from,
  bound,
  cmp,
  body,
});

// ---------------------------------------------------------------------------
// grammar
// ---------------------------------------------------------------------------

test('engine: expression grammar accepts the frozen surface and rejects the rest', () => {
  for (const src of ['1', 'a + b', 'total + 4', '(a + b) * 2', '-7 / 2', 'n % 10', 'i / 10 % 10', '1000000000']) {
    assert.ok(tryParseIntExpr(src).ok, `should parse: ${src}`);
  }
  // A-1/A-7: the editing surface simply does not contain these
  for (const src of ['a += 1', 'i++', 'a; b', 'f(1)', '"s"', '1.5', '1e9', 'a && b']) {
    assert.ok(!tryParseIntExpr(src).ok, `should reject: ${src}`);
  }
  for (const src of ['total >= 30', 'i <= n', 'i % 4 == 0', 'i / 10 % 10 == 7 || i % 10 == 7', '!(a < b) && c != 0']) {
    assert.ok(tryParseCond(src).ok, `should parse cond: ${src}`);
  }
  for (const src of ['a +', '>= 3', 'a = 3', 'while (i < 5)']) {
    assert.ok(!tryParseCond(src).ok, `should reject cond: ${src}`);
  }
  // literal domain: |v| <= 1e9 at parse time
  assert.ok(!tryParseIntExpr('1000000001').ok, 'literal above 1e9 rejected');
  assert.ok(tryParseIntExpr('1000000000').ok, 'literal at 1e9 accepted');
});

test('engine: C++11 division truncates toward zero and % follows the dividend', () => {
  const prog = [A('q1', '-7 / 2'), A('r1', '-7 % 2'), A('q2', '7 / -2'), A('r2', '7 % -2'), O('q1'), O('r1'), O('q2'), O('r2')];
  assert.deepEqual(runStepProgram(prog, {}).lines, ['-3', '-1', '-3', '1']);
});

test('engine: step budget counts executed ASSIGN/OUTPUT only; 200 is the hard stop', () => {
  // exact boundary: 200 executed statements complete; 201 halts at 200
  const sum99 = [A('s', '0'), FOR('i', '1', '198', '<=', [A('s', 's + 1')])]; // 1 + 198 = 199
  assert.equal(runStepProgram(sum99, {}).executedSteps, 199);
  const sum200 = [A('s', '0'), FOR('i', '1', '199', '<=', [A('s', 's + 1')])]; // 200
  const r200 = runStepProgram(sum200, {});
  assert.equal(r200.status, 'COMPLETED');
  assert.equal(r200.executedSteps, 200);
  const sum201 = [A('s', '0'), FOR('i', '1', '200', '<=', [A('s', 's + 1')]), O('s')]; // 201 wants one more
  const r201 = runStepProgram(sum201, {});
  assert.equal(r201.status, 'HALTED');
  assert.equal(r201.haltReason, 'STEP_BUDGET_EXHAUSTED');
  assert.equal(r201.executedSteps, 200);
  // condition checks / loop control never consume steps: a pure-check loop
  // with an IF-only body over 1..40 costs only the true branches
  const checks = [A('c', '0'), FOR('i', '1', '40', '<=', [IF('i % 4 == 0', [A('c', 'c + 1')])]), O('c')];
  const rc = runStepProgram(checks, {});
  assert.equal(rc.status, 'COMPLETED');
  assert.equal(rc.executedSteps, 12); // 1 + 10 + 1 (A-9)
  assert.deepEqual(rc.lines, ['10']);
});

test('engine: value domain |v| <= 1e9 hard-stops without wraparound', () => {
  const over = [A('x', '1000000000'), A('y', 'x + x'), O('y')];
  const r = runStepProgram(over, {});
  assert.equal(r.status, 'HALTED');
  assert.equal(r.haltReason, 'VALUE_OUT_OF_RANGE');
  const mul = [A('x', '1000000'), A('y', 'x * x')]; // 1e12
  assert.equal(runStepProgram(mul, {}).haltReason, 'VALUE_OUT_OF_RANGE');
});

test('engine: loop variable is read-only inside the body (static invariant, A-6)', () => {
  const bad = [FOR('i', '1', '3', '<=', [A('i', 'i + 1')])];
  const v = validateStepProgram(bad);
  assert.ok(!v.ok);
  assert.equal(v.issues[0]!.code, 'LOOP_VAR_READONLY');
  // outer loop var stays read-only inside a nested structure
  const nested = [FOR('i', '1', '3', '<=', [IF('i > 1', [A('i', '0')])])];
  assert.equal(validateStepProgram(nested).issues[0]!.code, 'LOOP_VAR_READONLY');
  // writing a DIFFERENT variable is fine
  assert.ok(validateStepProgram([FOR('i', '1', '3', '<=', [A('s', 's + i')])]).ok);
});

test('engine: FOR bounds are evaluated once before the loop (A-6)', () => {
  const prog = [
    A('n', '3'),
    FOR('i', '1', 'n', '<=', [A('n', '0'), O('i')]),
  ];
  // bound frozen at 3 even though the body overwrites n every iteration
  assert.deepEqual(runStepProgram(prog, {}).lines, ['1', '2', '3']);
});

test('engine: division by zero and undefined variables hard-stop', () => {
  assert.equal(runStepProgram([A('a', '1 / 0')], {}).haltReason, 'DIVISION_BY_ZERO');
  assert.equal(runStepProgram([A('a', '1 % 0')], {}).haltReason, 'DIVISION_BY_ZERO');
  assert.equal(runStepProgram([O('nope')], {}).haltReason, 'UNDEFINED_VARIABLE');
});

test('engine: zero-trip loop when from exceeds bound (i2 n=0 boundary)', () => {
  const prog = [A('c', '0'), FOR('i', '1', 'n', '<=', [IF('i % 4 == 0', [A('c', 'c + 1')])]), O('c')];
  assert.deepEqual(runStepProgram(prog, { n: 0 }).lines, ['0']);
  assert.deepEqual(runStepProgram(prog, { n: 4 }).lines, ['1']);
});

test('engine: terminal loop value is bound + 1 with <= (g4 exit value)', () => {
  const prog = [A('s', '0'), FOR('i', '1', '5', '<=', [A('s', 's + i')]), O('s')];
  const r = runStepProgram(prog, {});
  assert.deepEqual(r.lines, ['15']);
  assert.equal(r.finalVariables.i, 6);
  assert.equal(r.trace.filter((t) => t.kind === 'FOR_CHECK' && t.condResult === true).length, 5);
});

test('engine: A-3 output normalization', () => {
  assert.deepEqual(normalizeOutputLines(['9', '3', '  ']), ['9', '3']);
  assert.deepEqual(normalizeOutputLines(['9', '3', '', '']), ['9', '3']);
  assert.ok(outputLinesEqual(['9', '3', ' '], ['9', '3', '', '']));
  assert.ok(!outputLinesEqual(['9', '3'], ['9']));
  assert.ok(!outputLinesEqual(['9', '3'], ['9', '4']));
  assert.ok(!outputLinesEqual([' 9', '3'], ['9', '3']), 'in-line leading spaces are significant');
});

// ---------------------------------------------------------------------------
// hand-check expectation table (12 组，逐行复算)
// ---------------------------------------------------------------------------

interface HandRow {
  group: number;
  note: string;
  program: StepSpecV1[] | null;
  inputs: Record<string, number>;
  expectedLines: string[];
  finals?: Record<string, number>;
  branch?: Record<string, string>;
  tripCount?: number;
  combo?: boolean;
  variants?: Array<{ cmp: '<' | '<='; inputs: Record<string, number>; expectedLines: string[] }>;
}

const table = JSON.parse(
  readFileSync(join(ROOT, 'content/cpp/private/rules/hand-check-table.json'), 'utf8'),
).table as HandRow[];

test('engine: hand-check table rows recompute exactly (groups 1-10, 12)', () => {
  for (const row of table) {
    if (row.combo) continue;
    const run = runStepProgram(row.program!, row.inputs);
    assert.equal(run.status, 'COMPLETED', `group ${row.group} must complete: ${row.note}`);
    assert.deepEqual(run.lines, row.expectedLines, `group ${row.group} lines: ${row.note}`);
    for (const [k, v] of Object.entries(row.finals ?? {})) {
      assert.equal(run.finalVariables[k], v, `group ${row.group} final ${k}: ${row.note}`);
    }
    for (const [cp, expected] of Object.entries(row.branch ?? {})) {
      assert.deepEqual(run.branchOutcomes[cp], [expected], `group ${row.group} branch ${cp}: ${row.note}`);
    }
    if (row.tripCount !== undefined) {
      assert.equal(run.trace.filter((t) => t.kind === 'FOR_CHECK' && t.condResult === true).length, row.tripCount);
    }
    for (const variant of row.variants ?? []) {
      const prog = row.program!.map((s): StepSpecV1 => (s.kind === 'FOR' ? { ...s, cmp: variant.cmp } : s));
      assert.deepEqual(runStepProgram(prog, variant.inputs).lines, variant.expectedLines, `group ${row.group} variant: ${row.note}`);
    }
  }
});

test('engine: hand-check group 11 combos (frozen instance truths)', () => {
  const count4 = [A('c', '0'), FOR('i', '1', 'n', '<=', [IF('i % 4 == 0', [A('c', 'c + 1')])]), O('c')];
  assert.deepEqual(runStepProgram(count4, { n: 40 }).lines, ['10']);
  assert.deepEqual(runStepProgram(count4, { n: 0 }).lines, ['0']);
  assert.deepEqual(runStepProgram(count4, { n: 4 }).lines, ['1']);
  const digits = (n: number) => {
    const prog = [
      A('ones', 'n % 10'),
      A('n2', 'n / 10'),
      A('tens', 'n2 % 10'),
      A('n3', 'n2 / 10'),
      A('hundreds', 'n3 % 10'),
      O('ones'),
      O('tens'),
      O('hundreds'),
    ];
    return runStepProgram(prog, { n });
  };
  const d358 = digits(358);
  assert.deepEqual(d358.lines, ['8', '5', '3']);
  assert.deepEqual(digits(207).lines, ['7', '0', '2']);
  assert.equal(d358.finalVariables.n3, 3);
  const clap = [
    A('cc', '0'),
    A('lc', '0'),
    FOR('i', '1', 'n', '<=', [IF('i % 3 == 0', [A('cc', 'cc + 1'), A('lc', 'i')])]),
    O('cc'),
    O('lc'),
  ];
  assert.deepEqual(runStepProgram(clap, { n: 60 }).lines, ['20', '60']);
  assert.deepEqual(runStepProgram(clap, { n: 25 }).lines, ['8', '24']);
  const seven = [A('c', '0'), FOR('i', 'lo', 'hi', '<=', [IF('i / 10 % 10 == 7 || i % 10 == 7', [A('c', 'c + 1')])]), O('c')];
  assert.deepEqual(runStepProgram(seven, { lo: 260, hi: 299 }).lines, ['13']);
  assert.deepEqual(runStepProgram(seven, { lo: 260, hi: 289 }).lines, ['12']);
  // || dedup: 277 counted once
  assert.deepEqual(runStepProgram([A('c', '0'), A('i', '277'), IF('i / 10 % 10 == 7 || i % 10 == 7', [A('c', 'c + 1')]), O('c')], {}).lines, ['1']);
});

test('engine: table has 12 numbered groups covering the unit', () => {
  assert.equal(table.length, 12);
  assert.deepEqual(table.map((r) => r.group), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

// ---------------------------------------------------------------------------
// edit validation (slot-level structural diff)
// ---------------------------------------------------------------------------

const g1Program = (): StepSpecV1[] => [A('a', '12'), A('b', '7'), A('total', 'a + b'), A('total', 'total + 4'), O('total')];
const g1Constraints = {
  editableSlots: ['step[3].expr'],
  insertableKinds: ['OUTPUT'] as Array<'OUTPUT'>,
  deletableSteps: [] as number[],
  maxProgramSteps: 8,
  maxOutputLines: 8,
};

test('edit: allowed slot edit + allowed insertion confirm; forbidden changes rejected', () => {
  const current = g1Program();
  const edited = [A('a', '12'), A('b', '7'), A('total', 'a + b'), A('total', 'total + 6'), O('a'), O('total')];
  const ok = validateStepEdit(current, edited, {}, g1Constraints);
  assert.ok(ok.ok, 'g1 canonical edit must be accepted');

  const forbiddenSlot = [A('a', '13'), A('b', '7'), A('total', 'a + b'), A('total', 'total + 4'), O('total')];
  const bad = validateStepEdit(current, forbiddenSlot, {}, g1Constraints);
  assert.ok(!bad.ok && bad.rejection.code === 'SLOT_NOT_EDITABLE');

  const disallowedInsert = [A('a', '12'), A('b', '7'), A('total', 'a + b'), A('total', 'total + 4'), A('x', '1'), O('total')];
  const badIns = validateStepEdit(current, disallowedInsert, {}, g1Constraints);
  assert.ok(!badIns.ok && badIns.rejection.code === 'INSERT_NOT_ALLOWED');

  const structural = [A('a', '12'), O('total')];
  const badShape = validateStepEdit(current, structural, {}, g1Constraints);
  assert.ok(!badShape.ok && badShape.rejection.code === 'DELETE_NOT_ALLOWED');
});

test('edit: numeric slot domains and card budgets are enforced', () => {
  // g4 bound domain {5,10,100} + output cap 8
  const g4 = [A('sum', '0'), FOR('i', '1', '5', '<=', [A('sum', 'sum + i')]), O('sum')];
  const c4 = {
    editableSlots: ['step[1].bound', 'step[1].cmp'],
    slotDomains: { 'step[1].bound': [5, 10, 100] },
    insertableKinds: ['OUTPUT'] as Array<'OUTPUT'>,
    deletableSteps: [] as number[],
    maxProgramSteps: 12,
    maxOutputLines: 8,
  };
  const toBound = (b: string) => [A('sum', '0'), FOR('i', '1', b, '<=', [A('sum', 'sum + i')]), O('sum')];
  assert.ok(validateStepEdit(g4, toBound('100'), {}, c4).ok, 'bound 100 allowed');
  const domainMiss = validateStepEdit(g4, toBound('55'), {}, c4);
  assert.ok(!domainMiss.ok && domainMiss.rejection.code === 'SLOT_DOMAIN');
  // OUTPUT in loop with bound 10 -> 11 lines > 8
  const withOutput = [A('sum', '0'), FOR('i', '1', '10', '<=', [A('sum', 'sum + i'), O('i')]), O('sum')];
  const tooMany = validateStepEdit(g4, withOutput, {}, c4);
  assert.ok(!tooMany.ok && tooMany.rejection.code === 'MAX_OUTPUT_LINES');
  // budget: bound 1000 exhausts the 200-step budget (no slot domain on this set)
  const c4free = { ...c4, slotDomains: undefined };
  const budget = validateStepEdit(g4, toBound('1000'), {}, c4free);
  assert.ok(!budget.ok && budget.rejection.code === 'STEP_BUDGET_EXHAUSTED');
});

test('edit: i3 delete+insert repair flow passes its constraints', () => {
  const skeleton = [
    A('n', 'n / 10'),
    A('ones', 'n % 10'),
    A('tens', 'n % 10'),
    A('hundreds', 'n % 10'),
    O('ones'),
    O('tens'),
    O('hundreds'),
  ];
  const c = {
    editableSlots: [] as string[],
    insertableKinds: ['ASSIGN'] as Array<'ASSIGN'>,
    deletableSteps: [0],
    maxProgramSteps: 12,
    maxOutputLines: 8,
  };
  // step 1: delete the misplaced line (allowed position 0)
  const afterDelete = skeleton.slice(1);
  assert.ok(validateStepEdit(skeleton, afterDelete, { n: 358 }, c).ok);
  // step 2: insert n := n / 10 between ones and tens (index 1)
  const step2 = [afterDelete[0]!, A('n', 'n / 10'), afterDelete[1]!, afterDelete[2]!, afterDelete[3]!, afterDelete[4]!, afterDelete[5]!];
  assert.ok(validateStepEdit(afterDelete, step2, { n: 358 }, c).ok);
  // step 3: insert the second n := n / 10 between tens and hundreds (index 3)
  const repaired = [step2[0]!, step2[1]!, step2[2]!, A('n', 'n / 10'), step2[3]!, step2[4]!, step2[5]!, step2[6]!];
  const ok = validateStepEdit(step2, repaired, { n: 358 }, c);
  assert.ok(ok.ok, 'repaired i3 card must be accepted');
  assert.deepEqual(ok.ok ? ok.run.lines : [], ['8', '5', '3']);
  // deletableSteps addresses CURRENT card positions: after the first delete,
  // position 0 is now the ones line — still listed, so it stays deletable;
  // position 1 is not listed and must be rejected
  const delPos0 = validateStepEdit(afterDelete, afterDelete.slice(1), { n: 358 }, c);
  // structurally authorized (position 0 is still listed) — the run gate then
  // stops it honestly: deleting the ones line leaves OUTPUT ones undefined
  assert.ok(!delPos0.ok && delPos0.rejection.code === 'RUN_HALTED', 'deletion authorized; run gate stops the broken card');
  const delPos1 = validateStepEdit(
    afterDelete,
    [afterDelete[0]!, ...afterDelete.slice(2)],
    { n: 358 },
    { ...c, deletableSteps: [0] },
  );
  assert.ok(!delPos1.ok && delPos1.rejection.code === 'DELETE_NOT_ALLOWED');
});

test('edit: nested cond slot (i2) and nested ASSIGN insertion (s1)', () => {
  const i2 = [A('count', '0'), FOR('i', '1', 'n', '<=', [IF('i % 4 == 4', [A('count', 'count + 1')])]), O('count')];
  const cI2 = {
    editableSlots: ['step[1].body[0].cond'],
    insertableKinds: [] as never[],
    deletableSteps: [] as number[],
    maxProgramSteps: 12,
    maxOutputLines: 8,
  };
  const fixed = [A('count', '0'), FOR('i', '1', 'n', '<=', [IF('i % 4 == 0', [A('count', 'count + 1')])]), O('count')];
  const ok = validateStepEdit(i2, fixed, { n: 40 }, cI2);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok ? ok.run.lines : [], ['10']);

  const s1 = [
    A('clapCount', '0'),
    A('lastClap', '0'),
    FOR('i', '1', 'n', '<=', [IF('i % 3 == 3', [A('clapCount', 'clapCount + 1')])]),
    O('clapCount'),
    O('lastClap'),
  ];
  const cS1 = {
    editableSlots: ['step[2].body[0].cond'],
    insertableKinds: ['ASSIGN'] as Array<'ASSIGN'>,
    deletableSteps: [] as number[],
    maxProgramSteps: 20,
    maxOutputLines: 8,
  };
  const fixedS1 = [
    A('clapCount', '0'),
    A('lastClap', '0'),
    FOR('i', '1', 'n', '<=', [IF('i % 3 == 0', [A('clapCount', 'clapCount + 1'), A('lastClap', 'i')])]),
    O('clapCount'),
    O('lastClap'),
  ];
  const okS1 = validateStepEdit(s1, fixedS1, { n: 60 }, cS1);
  assert.ok(okS1.ok, 'cond edit + nested ASSIGN insertion must pass');
  assert.deepEqual(okS1.ok ? okS1.run.lines : [], ['20', '60']);
});

test('engine: misc — statement counting, trace length, program too long', () => {
  const g4 = [A('sum', '0'), FOR('i', '1', '5', '<=', [A('sum', 'sum + i')]), O('sum')];
  assert.equal(countStatements(g4), 4);
  assert.ok(traceLength(g4, {}) > 0);
  const long: StepSpecV1[] = [];
  for (let i = 0; i < 65; i += 1) long.push(A(`v${i}`, '0'));
  assert.equal(validateStepProgram(long).issues[0]!.code, 'PROGRAM_TOO_LONG');
  // running an unvalidated program never crashes (total-function guard)
  const r = runStepProgram([{ kind: 'ASSIGN', var: 'x', expr: 'y ++' } as unknown as StepSpecV1], {});
  assert.equal(r.status, 'HALTED');
});
