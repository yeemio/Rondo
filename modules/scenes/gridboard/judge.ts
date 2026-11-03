/**
 * GRID_TASK_TRUTH server-side recomputation (THEMES-A contract delta,
 * 2026-10-27). Pure judge over one submission: the mock evaluator (dev-side
 * Host stand-in) and later the product Host both feed it the private rule
 * entry + the confirmed scene snapshot + the typed response items, and get
 * the same verdict. Exact rational arithmetic only — no float tolerance;
 * fraction equivalence compares reduced numerators/denominators (BigInt gcd),
 * decimal answers compare after the declared HALF_UP rounding.
 *
 * Misconception diagnostics never reveal an expected value (v2 diagnostics
 * style); the scenario gate demands the operable object reach the authored
 * confirmed state before CORRECT is reachable at all.
 */
import type {
  GridTaskTruthEntryV1,
  ThemesCheck,
  ThemesDiagnosticRule,
} from '../../contracts/server/rules-themes';
import type { CylinderStateV1 } from '../../contracts/public/scene';
import type { GridBoardStateV1 } from '../../contracts/public/scene-gridboard';
import type { StructuredResponseItem } from '../../contracts/public/envelope';

export interface JudgeItemResult {
  key: string;
  label: string;
  verdict: 'CORRECT' | 'REVISE';
  feedback?: string;
}

export interface JudgeOutcome {
  verdict: 'CORRECT' | 'REVISE';
  itemResults: JudgeItemResult[];
  diagnostics: string[];
  reveal: Record<string, string>;
  scenarioMet: boolean;
}

// ---------------------------------------------------------------------------
// exact rationals (bounded teaching domain; BigInt gcd keeps reduction exact)
// ---------------------------------------------------------------------------

type Rational = { num: bigint; den: bigint };

function makeRat(num: bigint | number, den: bigint | number): Rational {
  return { num: BigInt(num), den: BigInt(den) };
}

function mulRat(a: Rational, b: Rational): Rational {
  return { num: a.num * b.num, den: a.den * b.den };
}

function gcdBig(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1n;
}

function reduceRat(r: Rational): Rational {
  const g = gcdBig(r.num, r.den);
  const num = r.num / g;
  const den = r.den / g;
  return den < 0n ? { num: -num, den: -den } : { num, den };
}

function eqRat(a: Rational, b: Rational): boolean {
  const x = reduceRat(a);
  const y = reduceRat(b);
  return x.num === y.num && x.den === y.den;
}

/** decimal string from a JSON number preserving typed precision ("64", "64.5") */
function numberToRat(v: number): Rational {
  let s = Number.isFinite(v) ? String(v) : 'NaN';
  if (s.includes('e') || s.includes('E')) {
    // exponent spellings (e.g. 1e21 from a stray UI input): normalize through
    // a fixed-precision decimal; teaching values are far below this scale
    s = v.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  }
  if (s === 'NaN' || s === 'Infinity' || s === '-Infinity') return makeRat(0, 1);
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [int, frac = ''] = body.split('.');
  const digits = int + frac;
  const num = BigInt(digits || '0');
  const den = 10n ** BigInt(frac.length);
  return neg ? { num: -num, den } : { num, den };
}

function decimalStringToRat(s: string): Rational {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [int, frac = ''] = body.split('.');
  const num = BigInt(int + frac);
  const den = 10n ** BigInt(frac.length);
  return neg ? { num: -num, den } : { num, den };
}

/** HALF_UP rounding of p/q to dp decimals, as a canonical decimal string. */
function roundToDecimalString(r: Rational, dp: number): string {
  const reduced = reduceRat(r);
  const scale = 10n ** BigInt(dp);
  const scaledNum = reduced.num * scale;
  const q = reduced.den;
  let quot = scaledNum / q;
  let rem = scaledNum % q;
  if (rem < 0n) {
    // HALF_UP away from zero for negatives matches decimal intuition here;
    // teaching answers are non-negative, this branch is defensive only.
    quot -= 1n;
    rem = -rem;
  }
  const twice = rem * 2n;
  if (twice >= q) quot += 1n;
  const neg = quot < 0n;
  const abs = neg ? -quot : quot;
  const s = abs.toString().padStart(dp + 1, '0');
  const intPart = s.slice(0, s.length - dp);
  const fracPart = dp > 0 ? '.' + s.slice(s.length - dp) : '';
  return (neg ? '-' : '') + intPart + fracPart;
}

// ---------------------------------------------------------------------------
// unit conversion table (factor to the check's canonical unit)
// ---------------------------------------------------------------------------

const LENGTH_TO_CM: Record<string, Rational | null> = {
  cm: makeRat(1, 1),
  mm: makeRat(1, 10),
};
const AREA_TO_CM2: Record<string, Rational | null> = {
  cm2: makeRat(1, 1),
  mm2: makeRat(1, 100), // 1 cm² = 100 mm² → a value in mm² reaches cm² via /100
  dm2: makeRat(100, 1), // 1 dm² = 100 cm² → a value in dm² reaches cm² via ×100
};
/** dimensionless/plain units: percent typed as-is, 个/yuan scale 1 */
const PLAIN: Record<string, Rational | null> = {
  percent: makeRat(1, 1),
  ge: makeRat(1, 1),
  yuan: makeRat(1, 1),
};

function conversionToCanonical(canonicalUnit: string, unitId: string): Rational | null {
  if (canonicalUnit === 'cm') return LENGTH_TO_CM[unitId] ?? null;
  if (canonicalUnit === 'cm2') return AREA_TO_CM2[unitId] ?? null;
  if (canonicalUnit in PLAIN) return unitId === canonicalUnit ? makeRat(1, 1) : PLAIN[unitId] ?? null;
  return null;
}

// ---------------------------------------------------------------------------
// snapshot derivations
// ---------------------------------------------------------------------------

type AnySnapshot = GridBoardStateV1 | CylinderStateV1;

function derivedTruth(
  derive: 'GRID_CELLS' | 'GRID_AREA_CM2' | 'FILLED_PERCENT' | 'DIAMETER_CM' | 'RADIUS_CM',
  snapshot: AnySnapshot,
): { canonical: Rational; unitId: string } | null {
  switch (derive) {
    case 'GRID_CELLS':
      if (!('cols' in snapshot)) return null;
      return { canonical: makeRat(snapshot.rows * snapshot.cols, 1), unitId: 'ge' };
    case 'GRID_AREA_CM2':
      if (!('cols' in snapshot)) return null;
      return { canonical: makeRat(snapshot.rows * snapshot.cols, 1), unitId: 'cm2' };
    case 'FILLED_PERCENT':
      if (!('cols' in snapshot)) return null;
      return { canonical: makeRat(snapshot.filled, 1), unitId: 'percent' };
    case 'DIAMETER_CM':
      if (!('radiusMm' in snapshot)) return null;
      return { canonical: mulRat(makeRat(snapshot.radiusMm, 1), makeRat(2, 10)), unitId: 'cm' };
    case 'RADIUS_CM':
      if (!('radiusMm' in snapshot)) return null;
      return { canonical: makeRat(snapshot.radiusMm, 1), unitId: 'cm' };
  }
}

function stateFraction(snapshot: AnySnapshot): { num: number; den: number } | null {
  if (!('cols' in snapshot) || snapshot.cols < 1) return null;
  return { num: snapshot.filled, den: snapshot.cols };
}

function scenarioSatisfied(
  scenario: GridTaskTruthEntryV1['scenario'],
  snapshot: AnySnapshot,
): boolean {
  if (scenario === undefined) return true;
  switch (scenario.kind) {
    case 'GRID_AT': {
      if (!('cols' in snapshot)) return false;
      if (scenario.rows !== undefined && snapshot.rows !== scenario.rows) return false;
      if (scenario.cols !== undefined && snapshot.cols !== scenario.cols) return false;
      if (scenario.filled !== undefined && snapshot.filled !== scenario.filled) return false;
      return true;
    }
    case 'FRACTION_REDUCED_EQUALS': {
      const f = stateFraction(snapshot);
      if (!f) return false;
      const a = reduceRat(makeRat(f.num, f.den));
      const b = reduceRat(makeRat(scenario.numerator, scenario.denominator));
      return a.num === b.num && a.den === b.den;
    }
    case 'CYLINDER_RADIUS': {
      return 'radiusMm' in snapshot && snapshot.radiusMm === scenario.radiusMm;
    }
  }
}

// ---------------------------------------------------------------------------
// response item lookup helpers
// ---------------------------------------------------------------------------

interface NumberItem { quantityId: string; value: number; unitId: string }
interface FractionItem { quantityId: string; numerator: number; denominator: number }
interface ChoiceItem { selectionId: string; optionId: string }
interface MappingItem { pairs: Array<{ leftId: string; rightId: string }> }

function collect(responseItems: readonly StructuredResponseItem[]): {
  numbers: NumberItem[];
  fractions: FractionItem[];
  choices: ChoiceItem[];
  mappings: MappingItem[];
} {
  const numbers: NumberItem[] = [];
  const fractions: FractionItem[] = [];
  const choices: ChoiceItem[] = [];
  const mappings: MappingItem[] = [];
  for (const item of responseItems) {
    if (item.kind === 'numberWithUnit') numbers.push(item);
    else if (item.kind === 'fractionValue') fractions.push(item);
    else if (item.kind === 'singleChoice') choices.push(item);
    else if (item.kind === 'objectMapping') mappings.push(item);
  }
  return { numbers, fractions, choices, mappings };
}

// ---------------------------------------------------------------------------
// per-check judging
// ---------------------------------------------------------------------------

interface CheckOutcome {
  ok: boolean;
  feedback?: string;
  submittedNumber?: { canonical: Rational; unitOk: boolean; raw: NumberItem };
  submittedFraction?: FractionItem;
}

function judgeNumberCheck(
  check: Extract<ThemesCheck, { kind: 'number' }>,
  snapshot: AnySnapshot,
  numbers: NumberItem[],
  reviseGeneric?: string,
): CheckOutcome {
  const truth =
    check.source.kind === 'AUTHORED'
      ? { canonical: decimalStringToRat(check.source.expectedDecimal), unitId: check.source.unitId }
      : derivedTruth(check.source.derive, snapshot);
  const submitted = numbers.find((n) => n.quantityId === check.quantityId);
  if (!truth || !submitted) return { ok: false, feedback: reviseGeneric };
  const conv = conversionToCanonical(truth.unitId, submitted.unitId);
  const unitOk = conv !== null && check.acceptedUnitIds.includes(submitted.unitId);
  const canonical = conv === null ? numberToRat(submitted.value) : mulRat(numberToRat(submitted.value), conv);
  const expectedStr = roundToDecimalString(truth.canonical, check.rounding.decimalPlaces);
  const submittedStr = roundToDecimalString(canonical, check.rounding.decimalPlaces);
  const valueOk = unitOk && expectedStr === submittedStr;
  return {
    ok: valueOk,
    feedback: valueOk ? undefined : reviseGeneric,
    submittedNumber: { canonical, unitOk, raw: submitted },
  };
}

function fractionTruth(
  check: Extract<ThemesCheck, { kind: 'fraction' }>,
  snapshot: AnySnapshot,
): { num: number; den: number } | null {
  if (check.source.kind === 'AUTHORED') {
    return { num: check.source.numerator, den: check.source.denominator };
  }
  return stateFraction(snapshot);
}

function judgeFractionCheck(
  check: Extract<ThemesCheck, { kind: 'fraction' }>,
  snapshot: AnySnapshot,
  fractions: FractionItem[],
  reviseGeneric?: string,
): CheckOutcome {
  const truth = fractionTruth(check, snapshot);
  const submitted = fractions.find((f) => f.quantityId === check.quantityId);
  if (!submitted || !truth) return { ok: false, feedback: reviseGeneric };
  let ok = false;
  if (check.comparison.kind === 'EXACT') {
    ok = submitted.numerator === truth.num && submitted.denominator === truth.den;
  } else {
    const a = reduceRat(makeRat(submitted.numerator, submitted.denominator));
    const b = reduceRat(makeRat(truth.num, truth.den));
    ok = a.num === b.num && a.den === b.den;
  }
  return { ok, feedback: ok ? undefined : reviseGeneric, submittedFraction: submitted };
}

function judgeChoiceCheck(
  check: Extract<ThemesCheck, { kind: 'choice' }>,
  choices: ChoiceItem[],
  reviseGeneric?: string,
): CheckOutcome {
  const submitted = choices.find((c) => c.selectionId === check.selectionId);
  const ok = submitted !== undefined && submitted.optionId === check.correctOptionId;
  return { ok, feedback: ok ? undefined : reviseGeneric };
}

function judgeMappingCheck(
  check: Extract<ThemesCheck, { kind: 'mapping' }>,
  mappings: MappingItem[],
  reviseGeneric?: string,
): CheckOutcome {
  const expected = new Set(check.expectedPairs.map((p) => `${p.leftId}->${p.rightId}`));
  const submitted = new Set<string>();
  for (const m of mappings) {
    for (const p of m.pairs) submitted.add(`${p.leftId}->${p.rightId}`);
  }
  const ok =
    submitted.size === expected.size && [...expected].every((k) => submitted.has(k));
  return { ok, feedback: ok ? undefined : reviseGeneric };
}

// ---------------------------------------------------------------------------
// misconception matchers
// ---------------------------------------------------------------------------

function matchDiagnostic(
  diag: ThemesDiagnosticRule,
  check: ThemesCheck,
  outcome: CheckOutcome,
  snapshot: AnySnapshot,
): boolean {
  if (outcome.ok) return false;
  switch (diag.when.kind) {
    case 'VALUE_EQUALS': {
      if (check.kind !== 'number' || !outcome.submittedNumber) return false;
      const truth = check.source.kind === 'AUTHORED'
        ? { canonical: decimalStringToRat(check.source.expectedDecimal), unitId: check.source.unitId }
        : derivedTruth(check.source.derive, snapshot);
      if (!truth) return false;
      const conv = conversionToCanonical(diag.when.unitId, outcome.submittedNumber.raw.unitId);
      if (conv === null) return false;
      return eqRat(mulRat(numberToRat(outcome.submittedNumber.raw.value), conv), decimalStringToRat(diag.when.value));
    }
    case 'UNIT_MISMATCH': {
      if (check.kind !== 'number' || !outcome.submittedNumber || outcome.submittedNumber.unitOk) return false;
      const truth = check.source.kind === 'AUTHORED'
        ? { canonical: decimalStringToRat(check.source.expectedDecimal), unitId: check.source.unitId }
        : derivedTruth(check.source.derive, snapshot);
      if (!truth) return false;
      // 数值对、单位错：converted value still equals the truth
      return eqRat(outcome.submittedNumber.canonical, truth.canonical);
    }
    case 'OFF_BY_FACTOR': {
      if (check.kind !== 'number' || !outcome.submittedNumber) return false;
      const truth = check.source.kind === 'AUTHORED'
        ? { canonical: decimalStringToRat(check.source.expectedDecimal), unitId: check.source.unitId }
        : derivedTruth(check.source.derive, snapshot);
      if (!truth) return false;
      const conv = conversionToCanonical(truth.unitId, outcome.submittedNumber.raw.unitId);
      if (conv === null || !outcome.submittedNumber.unitOk) return false;
      const factor = diag.when.factor === 2 ? makeRat(2, 1) : makeRat(1, 2);
      return eqRat(outcome.submittedNumber.canonical, mulRat(truth.canonical, factor));
    }
    case 'FRACTION_SWAPPED': {
      if (check.kind !== 'fraction' || !outcome.submittedFraction) return false;
      const target = fractionTruth(check, snapshot);
      return (
        target !== null &&
        outcome.submittedFraction.numerator === target.den &&
        outcome.submittedFraction.denominator === target.num
      );
    }
    case 'FRACTION_NUMERATOR_ONLY_SCALED': {
      if (check.kind !== 'fraction' || !outcome.submittedFraction) return false;
      const s = outcome.submittedFraction;
      return (
        s.numerator === diag.when.preNumerator * diag.when.multiplier &&
        s.denominator === diag.when.preDenominator
      );
    }
    case 'FRACTION_DENOMINATOR_ONLY_SCALED': {
      if (check.kind !== 'fraction' || !outcome.submittedFraction) return false;
      const s = outcome.submittedFraction;
      return (
        s.denominator === diag.when.preDenominator * diag.when.multiplier &&
        s.numerator === diag.when.preNumerator
      );
    }
  }
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export function judgeGridTask(input: {
  taskId: string;
  entry: GridTaskTruthEntryV1;
  snapshot: AnySnapshot;
  responseItems: readonly StructuredResponseItem[];
}): JudgeOutcome {
  const { entry, snapshot } = input;
  const bag = collect(input.responseItems);
  const itemResults: JudgeItemResult[] = [];
  const diagnostics: string[] = [];

  const scenarioMet = scenarioSatisfied(entry.scenario, snapshot);

  let allOk = true;
  const outcomes = new Map<string, CheckOutcome>();
  for (const check of entry.checks) {
    let outcome: CheckOutcome;
    switch (check.kind) {
      case 'number':
        outcome = judgeNumberCheck(check, snapshot, bag.numbers, entry.feedback?.reviseGeneric);
        break;
      case 'fraction':
        outcome = judgeFractionCheck(check, snapshot, bag.fractions, entry.feedback?.reviseGeneric);
        break;
      case 'choice':
        outcome = judgeChoiceCheck(check, bag.choices, entry.feedback?.reviseGeneric);
        break;
      case 'mapping':
        outcome = judgeMappingCheck(check, bag.mappings, entry.feedback?.reviseGeneric);
        break;
    }
    outcomes.set(check.id, outcome);
    if (!outcome.ok) allOk = false;
    let feedback = outcome.feedback;
    for (const diag of entry.diagnostics ?? []) {
      if (diag.checkId !== check.id) continue;
      if (!diagnostics.includes(diag.tag) && matchDiagnostic(diag, check, outcome, snapshot)) {
        diagnostics.push(diag.tag);
        feedback = diag.feedback;
      }
    }
    itemResults.push({
      key: check.id,
      label: check.label,
      verdict: outcome.ok ? 'CORRECT' : 'REVISE',
      feedback: outcome.ok ? undefined : feedback,
    });
  }

  if (!scenarioMet) {
    itemResults.unshift({
      key: 'scenario',
      label: '操作状态',
      verdict: 'REVISE',
      feedback: entry.scenarioFeedback ?? '请先把图板调整到题目要求的样子，再提交。',
    });
    allOk = false;
  }

  const reveal: Record<string, string> = {};
  for (const note of entry.reveal) reveal[note.checkId] = note.text;

  return {
    verdict: allOk ? 'CORRECT' : 'REVISE',
    itemResults,
    diagnostics,
    reveal,
    scenarioMet,
  };
}
