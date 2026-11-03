/**
 * Exact rational / decimal arithmetic for private-rule evaluation (B-D6).
 *
 * Frozen sources:
 * - SCENE-CONTRACTS.md §2 (pi = 3.14 = 157/50 exact decimal contract; integer
 *   mm inputs; explicit decimal rounding; NO float/pixel epsilon anywhere)
 * - rules.ts (ExactRational bounds; RoundingSpec HALF_UP/HALF_EVEN/TRUNCATE,
 *   0..6 decimal places; EXACT_AFTER_ROUNDING comparison)
 *
 * Everything runs on BigInt. Student inputs arrive as JSON numbers; their
 * shortest round-trip decimal string (JS Number.prototype.toString) is the
 * student's decimal literal, so 8 / 8.00 / 8.0 are one value and 37.68 is
 * the exact decimal 3768/100 -- never a binary float comparison.
 */
import type { ExactRational, RoundingSpec } from '../contracts/server/rules';

export interface BigRational {
  readonly num: bigint; // sign carried here
  readonly den: bigint; // always positive
}

export function makeBigRational(num: bigint, den: bigint): BigRational {
  if (den === 0n) throw new Error('EXACT_ARITH: zero denominator');
  if (den < 0n) {
    return { num: -num, den: -den };
  }
  return { num, den };
}

function bigAbs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = bigAbs(a);
  let y = bigAbs(b);
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function reduceRational(r: BigRational): BigRational {
  const g = gcd(r.num, r.den) || 1n;
  return { num: r.num / g, den: r.den / g };
}

export function multiplyRational(a: BigRational, b: BigRational): BigRational {
  return reduceRational({ num: a.num * b.num, den: a.den * b.den });
}

export function fromExactRational(r: ExactRational): BigRational {
  return makeBigRational(BigInt(r.numerator), BigInt(r.denominator));
}

/**
 * Converts a JSON number to its exact decimal rational using the shortest
 * round-trip decimal representation. Exponent forms are expanded; the value
 * "8.00" arrives as the number 8 and becomes 8/1, which is exactly the
 * intended equivalence discipline (equivalent spellings, exact decimals).
 */
export function bigRationalFromNumber(value: number): BigRational {
  if (!Number.isFinite(value)) {
    throw new Error('EXACT_ARITH: non-finite student value');
  }
  const s = decimalStringFromNumber(value);
  return bigRationalFromDecimalString(s);
}

/** Expands JS toString() output (possibly exponential) to a plain decimal string. */
export function decimalStringFromNumber(value: number): string {
  if (Object.is(value, -0)) return '0';
  const s = value.toString();
  if (!s.includes('e') && !s.includes('E')) return s;
  // Expand exponent notation: mantissa × 10^exponent.
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!match) throw new Error(`EXACT_ARITH: unparsable number string ${s}`);
  const [, sign, intPart, fracPart = '', expPart] = match;
  const digits = intPart + fracPart;
  const exp = Number.parseInt(expPart, 10);
  const pointPos = intPart.length + exp;
  let out: string;
  if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${digits}`;
  } else if (pointPos >= digits.length) {
    out = `${digits}${'0'.repeat(pointPos - digits.length)}`;
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }
  return sign === '-' ? `-${out}` : out;
}

/** Parses an exact decimal literal string ("-12.340") into a rational. */
export function bigRationalFromDecimalString(s: string): BigRational {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(s);
  if (!match) throw new Error(`EXACT_ARITH: not an exact decimal literal: ${s}`);
  const [, sign, intPart, fracPart = ''] = match;
  const numDigits = BigInt(intPart + fracPart);
  const den = 10n ** BigInt(fracPart.length);
  return sign === '-' ? { num: -numDigits, den } : { num: numDigits, den };
}

/** Rounds num/den to `decimalPlaces` with the declared mode; returns the scaled integer. */
function roundScaledInteger(r: BigRational, decimalPlaces: number, mode: RoundingSpec['mode']): bigint {
  const scaledNum = r.num * 10n ** BigInt(decimalPlaces);
  const den = r.den;
  const negative = scaledNum < 0n;
  const absNum = bigAbs(scaledNum);
  const quotient = absNum / den;
  const remainder = absNum % den;
  let rounded = quotient;
  const twice = remainder * 2n;
  if (mode === 'TRUNCATE') {
    rounded = quotient;
  } else if (mode === 'HALF_UP') {
    if (twice >= den) rounded = quotient + 1n;
  } else {
    // HALF_EVEN
    if (twice > den) {
      rounded = quotient + 1n;
    } else if (twice === den) {
      if (quotient % 2n === 1n) rounded = quotient + 1n;
    }
  }
  return negative ? -rounded : rounded;
}

/** Canonical decimal string with exactly `decimalPlaces` fraction digits. */
export function formatRoundedDecimal(r: BigRational, spec: RoundingSpec): string {
  const scale = 10n ** BigInt(spec.decimalPlaces);
  const scaled = roundScaledInteger(r, spec.decimalPlaces, spec.mode);
  const negative = scaled < 0n;
  const abs = bigAbs(scaled);
  const intPart = abs / scale;
  const frac = abs % scale;
  const fracText = frac.toString().padStart(spec.decimalPlaces, '0');
  const body = spec.decimalPlaces === 0 ? intPart.toString() : `${intPart}.${fracText}`;
  return negative && scaled !== 0n ? `-${body}` : body;
}

export function rationalsEqualAfterRounding(a: BigRational, b: BigRational, spec: RoundingSpec): boolean {
  return formatRoundedDecimal(a, spec) === formatRoundedDecimal(b, spec);
}
