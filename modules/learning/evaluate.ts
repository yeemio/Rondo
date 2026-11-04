/**
 * Private-rule evaluator for the two first-batch rule families (B-D10).
 *
 * Frozen sources:
 * - modules/contracts/server/rules.ts (PARAMETER_IDENTIFICATION_V1,
 *   NUMERIC_RELATION_V1; pi = 157/50; EXACT_AFTER_ROUNDING; rules are data)
 * - SCENE-CONTRACTS.md §2/§4 (integer mm geometry; exact decimal rounding;
 *   equivalent spellings and unit conversion per accepted set; feedback must
 *   not leak the expected answer or correct mapping)
 * - PRODUCT-CONTRACT.md §7 (deterministic rules judge only numbers/units/
 *   construction conditions; technical failure is UNSCORABLE, never "wrong")
 *
 * The evaluator never executes content strings and never touches floats for
 * the comparison itself. Unit registry: mm-family lengths and area units
 * with exact integer conversion factors to the mm base.
 */
import type {
  NumericRelationRule,
  ParameterIdentificationRule,
  QuantityExpression,
  TaskRule,
} from '../contracts/server/rules';
import type { StructuredResponseItem } from '../contracts/public/envelope';
import type { CylinderStateV1 } from '../contracts/public/scene';
import {
  bigRationalFromDecimalString,
  bigRationalFromNumber,
  formatRoundedDecimal,
  fromExactRational,
  makeBigRational,
  multiplyRational,
  reduceRational,
  type BigRational,
} from './exact';

// ---------------------------------------------------------------------------
// Unit registry (exact integer factors to the mm base; dimension = exponent)
// ---------------------------------------------------------------------------

export interface UnitDef {
  readonly dimension: 1 | 2;
  /** multiply by this rational to reach the base unit (mm or mm^2) */
  readonly toBase: BigRational;
}

const UNIT_REGISTRY: Readonly<Record<string, UnitDef>> = {
  mm: { dimension: 1, toBase: makeBigRational(1n, 1n) },
  cm: { dimension: 1, toBase: makeBigRational(10n, 1n) },
  dm: { dimension: 1, toBase: makeBigRational(100n, 1n) },
  m: { dimension: 1, toBase: makeBigRational(1000n, 1n) },
  mm2: { dimension: 2, toBase: makeBigRational(1n, 1n) },
  cm2: { dimension: 2, toBase: makeBigRational(100n, 1n) },
  dm2: { dimension: 2, toBase: makeBigRational(10000n, 1n) },
  m2: { dimension: 2, toBase: makeBigRational(1000000n, 1n) },
};

export function lookupUnit(unitId: string): UnitDef | null {
  return UNIT_REGISTRY[unitId] ?? null;
}

// ---------------------------------------------------------------------------
// Evaluation shapes (feedback never contains expected values)
// ---------------------------------------------------------------------------

export interface QuantityCheckFeedback {
  readonly quantityId: string;
  readonly submitted: boolean;
  readonly valueOk: boolean;
  readonly unitOk: boolean;
}

export interface FamilyItemFeedback {
  readonly key: string;
  readonly label: string;
  readonly verdict: 'CORRECT' | 'REVISE';
  readonly feedback?: string;
}

export interface EvaluationFeedback {
  readonly assessmentMode?: {version:'math.assessment.v1';mode:'OBSERVATION_RECORDED'|'RULE_CHECKED'}|{version:'gesp.assessment.v1';mode:'ISSUE_RECORDED'|'CHOICE_CHECKED'}|{version:'daily.assessment.v1';mode:'SHORT_CHECKED'};
  readonly ruleKind: 'PARAMETER_IDENTIFICATION_V1' | 'NUMERIC_RELATION_V1' | 'FAMILY_TRUTH_V1';
  readonly scenarioMet: boolean;
  readonly wrongProperties?: readonly string[];
  readonly missingProperties?: readonly string[];
  readonly extraClaims?: readonly string[];
  readonly mappingMatched?: number;
  readonly mappingTotal?: number;
  readonly wrongPairIds?: readonly string[];
  readonly quantities?: readonly QuantityCheckFeedback[];
  /** FAMILY_TRUTH_V1 (integration W1): per-item restricted results, stable diagnostic tags, REVIEW reveal. */
  readonly itemResults?: readonly FamilyItemFeedback[];
  readonly diagnostics?: readonly string[];
  readonly reveal?: Readonly<Record<string, string>>;
  readonly responseTypeOk: boolean;
  detail?: string;
}

export type EvaluationOutcome = 'CORRECT' | 'REVISE' | 'UNSCORABLE';

export interface EvaluationResult {
  readonly outcome: EvaluationOutcome;
  readonly feedback: EvaluationFeedback;
}

// ---------------------------------------------------------------------------
// Quantity expressions
// ---------------------------------------------------------------------------

function evaluateQuantityExpression(
  expression: QuantityExpression,
  snapshot: CylinderStateV1,
): { value: BigRational; dimension: number } {
  let acc = makeBigRational(1n, 1n);
  let dimension = 0;
  for (const factor of expression.factors) {
    if ('factor' in factor) {
      dimension += 1;
      const stateValue = factor.factor === 'radiusMm' ? snapshot.radiusMm : snapshot.heightMm;
      acc = multiplyRational(acc, makeBigRational(BigInt(stateValue), 1n));
    } else {
      acc = multiplyRational(acc, fromExactRational(factor));
    }
  }
  return { value: acc, dimension };
}

// ---------------------------------------------------------------------------
// L1: parameter identification
// ---------------------------------------------------------------------------

function actualDirection(from: number, to: number): 'INCREASE' | 'DECREASE' | 'UNCHANGED' {
  if (to > from) return 'INCREASE';
  if (to < from) return 'DECREASE';
  return 'UNCHANGED';
}

function evaluateParameterIdentification(
  rule: ParameterIdentificationRule,
  givens: CylinderStateV1,
  snapshot: CylinderStateV1,
  responseItems: StructuredResponseItem[],
): EvaluationResult {
  const claims = responseItems.filter((i): i is Extract<StructuredResponseItem, { kind: 'propertyJudgments' }> => i.kind === 'propertyJudgments');
  const responseTypeOk = claims.length >= 1;
  // Authored key vs actual delta: if the learner did not run the intended
  // scenario, the private key cannot judge the claims; report scenario-not-met
  // as REVISE with a non-leaking prompt instead of scoring against stale keys.
  const radiusDelta = actualDirection(givens.radiusMm, snapshot.radiusMm);
  const heightDelta = actualDirection(givens.heightMm, snapshot.heightMm);
  const diameterDelta = radiusDelta;
  const actual: Record<string, string> = { radius: radiusDelta, diameter: diameterDelta, height: heightDelta };
  const keyConsistent = rule.expectedJudgments.every((j) => actual[j.propertyId] === j.direction);
  const expectedByKey = new Map<string, string>(rule.expectedJudgments.map((j) => [j.propertyId, j.direction] as const));
  const wrongProperties: string[] = [];
  const extraClaims: string[] = [];
  const claimedProperties = new Set<string>();
  for (const claimGroup of claims) {
    for (const claim of claimGroup.claims) {
      claimedProperties.add(claim.propertyId);
      const expectedDirection = expectedByKey.get(claim.propertyId);
      if (expectedDirection === undefined) {
        if (!extraClaims.includes(claim.propertyId)) extraClaims.push(claim.propertyId);
      } else if (expectedDirection !== claim.direction) {
        if (!wrongProperties.includes(claim.propertyId)) wrongProperties.push(claim.propertyId);
      }
    }
  }
  const missingProperties = [...expectedByKey.keys()].filter((p) => !claimedProperties.has(p));
  const correct =
    keyConsistent &&
    responseTypeOk &&
    wrongProperties.length === 0 &&
    missingProperties.length === 0 &&
    claims.reduce((n, g) => n + g.claims.length, 0) === rule.expectedJudgments.length;
  const feedback: EvaluationFeedback = {
    ruleKind: 'PARAMETER_IDENTIFICATION_V1',
    scenarioMet: keyConsistent,
    responseTypeOk,
    wrongProperties,
    missingProperties,
    extraClaims,
  };
  if (!keyConsistent) feedback.detail = '请先完成题目要求的变化，再提交判断。';
  return { outcome: correct ? 'CORRECT' : 'REVISE', feedback };
}

// ---------------------------------------------------------------------------
// L2: numeric relation (edge mapping + quantities)
// ---------------------------------------------------------------------------

/**
 * Edge pairing is inherently undirected: the learner pairs a cylinder part
 * with a net edge, and both authored truth (expectedEdgeMapping) and the
 * submitted objectMapping may spell the same pair in either direction
 * (B-authored tasks key cylinder->net; C's UI asks from the strip side, so
 * the learner submits leftId=netEdgeId). Pairs are normalized by sorting the
 * two ids within each pair before comparison — a mismatched pair (different
 * id sets) still fails, only the spelling direction is normalized.
 */
function pairKey(leftId: string, rightId: string): string {
  return leftId <= rightId ? `${leftId}->${rightId}` : `${rightId}->${leftId}`;
}

function evaluateNumericRelation(
  rule: NumericRelationRule,
  givens: CylinderStateV1,
  snapshot: CylinderStateV1,
  responseItems: StructuredResponseItem[],
): EvaluationResult {
  const mappingItems = responseItems.filter((i): i is Extract<StructuredResponseItem, { kind: 'objectMapping' }> => i.kind === 'objectMapping');
  const numberItems = responseItems.filter((i): i is Extract<StructuredResponseItem, { kind: 'numberWithUnit' }> => i.kind === 'numberWithUnit');

  // Scenario gate: any non-zero unroll (learner-committed or authored initial
  // state) counts as the learner having engaged the unroll interaction.
  // Deliberately NOT "unroll === 1000": what L2 scores is the submitted edge
  // mapping and quantities against the authored key, not how far the net was
  // dragged -- a partially unrolled but otherwise correct answer must not be
  // forced to REVISE merely for incomplete unroll progress. The feedback below
  // nudges toward fuller unroll as guidance, not as a judging precondition.
  const scenarioMet = snapshot.unrollPermille > 0 || givens.unrollPermille > 0;

  const expectedPairs = new Set(rule.expectedEdgeMapping.map((p) => pairKey(p.cylinderObjectId, p.netEdgeId)));
  let mappingMatched = 0;
  const wrongPairIds: string[] = [];
  const submittedPairs = new Set<string>();
  for (const item of mappingItems) {
    for (const pair of item.pairs) {
      const key = pairKey(pair.leftId, pair.rightId);
      submittedPairs.add(key);
      if (expectedPairs.has(key)) mappingMatched += 1;
      else wrongPairIds.push(pair.leftId);
    }
  }
  const mappingTotal = expectedPairs.size;
  const mappingOk = mappingMatched === mappingTotal && submittedPairs.size === mappingTotal && wrongPairIds.length === 0;

  const quantities: QuantityCheckFeedback[] = [];
  let quantitiesOk = true; // vacuously true when the rule declares no quantity checks
  const submittedByQuantity = new Map<string, Extract<StructuredResponseItem, { kind: 'numberWithUnit' }>[]>();
  for (const item of numberItems) {
    const list = submittedByQuantity.get(item.quantityId) ?? [];
    list.push(item);
    submittedByQuantity.set(item.quantityId, list);
  }
  for (const check of rule.quantityChecks) {
    const submissions = submittedByQuantity.get(check.quantityId) ?? [];
    const first = submissions[0];
    if (first === undefined) {
      quantities.push({ quantityId: check.quantityId, submitted: false, valueOk: false, unitOk: false });
      quantitiesOk = false;
      continue;
    }
    const unit = lookupUnit(first.unitId);
    const unitOk = unit !== null && check.acceptedUnitIds.includes(first.unitId);
    let valueOk = false;
    if (unitOk && unit !== null) {
      const expected = evaluateQuantityExpression(check.expected, snapshot);
      if (unit.dimension === expected.dimension) {
        try {
          const studentBase = multiplyRational(bigRationalFromNumber(first.value), unit.toBase);
          valueOk = formatRoundedDecimal(expected.value, check.rounding) === formatRoundedDecimal(studentBase, check.rounding);
        } catch {
          valueOk = false;
        }
      }
    }
    quantities.push({ quantityId: check.quantityId, submitted: true, valueOk, unitOk });
    if (!valueOk || !unitOk) quantitiesOk = false;
  }

  const responseTypeOk =
    (mappingItems.length > 0 || rule.expectedEdgeMapping.length === 0) && (numberItems.length > 0 || rule.quantityChecks.length === 0);
  const outcome: EvaluationOutcome = scenarioMet && responseTypeOk && mappingOk && quantitiesOk ? 'CORRECT' : 'REVISE';
  const feedback: EvaluationFeedback = {
    ruleKind: 'NUMERIC_RELATION_V1',
    scenarioMet,
    responseTypeOk,
    mappingMatched,
    mappingTotal,
    wrongPairIds,
    quantities,
  };
  if (!scenarioMet) feedback.detail = '请先把侧面完全展开（或调整展开进度）后再提交。';
  return { outcome, feedback };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function evaluateResponse(input: {
  readonly rule: TaskRule;
  readonly givens: CylinderStateV1;
  readonly snapshot: CylinderStateV1;
  readonly responseItems: readonly StructuredResponseItem[];
}): EvaluationResult {
  const { rule, givens, snapshot, responseItems } = input;
  try {
    switch (rule.ruleKind) {
      case 'PARAMETER_IDENTIFICATION_V1':
        return evaluateParameterIdentification(rule, givens, snapshot, [...responseItems]);
      case 'NUMERIC_RELATION_V1':
        return evaluateNumericRelation(rule, givens, snapshot, [...responseItems]);
    }
  } catch (err) {
    void err;
    // Technical failure inside the evaluator is UNSCORABLE, never "wrong"
    // (LIFECYCLE §4: 技术故障不能写成答错).
    return {
      outcome: 'UNSCORABLE',
      feedback: {
        ruleKind: rule.ruleKind,
        scenarioMet: false,
        responseTypeOk: false,
        detail: '判分暂时不可用，本次提交未被判定为错误。',
      },
    };
  }
}

/** Lateral area helper for tests and result summaries: 2 × (157/50) × r × h in mm². */
export function lateralAreaMm2(radiusMm: number, heightMm: number): BigRational {
  return multiplyRational(
    multiplyRational(makeBigRational(157n, 25n), makeBigRational(BigInt(radiusMm), 1n)),
    makeBigRational(BigInt(heightMm), 1n),
  );
}

// ---------------------------------------------------------------------------
// v2 (RULE_DSL_VERSION '2'): C-line rule truth dispatch. One entry per
// RuleBodyV2 kind; the response carriers stay the frozen three-segment forms
// (propertyJudgments / objectMapping / numberWithUnit) and reuse the v1
// semantic machinery (exact rationals, unit registry, no float tolerance).
// Stored evaluation shape is unchanged (outcome + EvaluationFeedback), so
// persistence and view projections need no migration.
// ---------------------------------------------------------------------------

import type { RuleBodyV2, NumericQuantityCheck } from '../contracts/server/rules';

export interface EvaluationRequestV2 {
  readonly rule: RuleBodyV2;
  readonly taskId: string;
  readonly givens: CylinderStateV1;
  readonly snapshot: CylinderStateV1;
  readonly responseItems: readonly StructuredResponseItem[];
  /** v2 composite segment enablement from the private binding (S1 four, D1 three); gates which quantityChecks are asked. */
  readonly enabledSegments?: readonly string[];
}

function actualDeltas(givens: CylinderStateV1, snapshot: CylinderStateV1): Record<string, string> {
  const radiusDelta = actualDirection(givens.radiusMm, snapshot.radiusMm);
  return { radius: radiusDelta, diameter: radiusDelta, height: actualDirection(givens.heightMm, snapshot.heightMm) };
}

/** Picks the authored branch whose expected judgments match the confirmed deltas (C files key branches by snapshot). */
function pickIdentificationBranch(
  rules: readonly ParameterIdentificationRule[],
  givens: CylinderStateV1,
  snapshot: CylinderStateV1,
): ParameterIdentificationRule {
  const actual = actualDeltas(givens, snapshot);
  const match = rules.find((rule) => rule.expectedJudgments.every((j) => actual[j.propertyId] === j.direction));
  return match ?? rules[0];
}

function judgeQuantityChecksV2(
  checks: readonly NumericQuantityCheck[],
  responseItems: readonly StructuredResponseItem[],
  snapshot: CylinderStateV1,
): { quantities: QuantityCheckFeedback[]; ok: boolean } {
  const numberItems = responseItems.filter(
    (i): i is Extract<StructuredResponseItem, { kind: 'numberWithUnit' }> => i.kind === 'numberWithUnit',
  );
  const submittedByQuantity = new Map<string, Extract<StructuredResponseItem, { kind: 'numberWithUnit' }>[]>();
  for (const item of numberItems) {
    const list = submittedByQuantity.get(item.quantityId) ?? [];
    list.push(item);
    submittedByQuantity.set(item.quantityId, list);
  }
  const quantities: QuantityCheckFeedback[] = [];
  let ok = true;
  for (const check of checks) {
    const first = (submittedByQuantity.get(check.quantityId) ?? [])[0];
    if (first === undefined) {
      quantities.push({ quantityId: check.quantityId, submitted: false, valueOk: false, unitOk: false });
      ok = false;
      continue;
    }
    const unit = lookupUnit(first.unitId);
    const unitOk = unit !== null && check.acceptedUnitIds.includes(first.unitId);
    let valueOk = false;
    if (unitOk && unit !== null) {
      const expected = evaluateQuantityExpression(check.expected, snapshot);
      if (unit.dimension === expected.dimension) {
        try {
          const studentBase = multiplyRational(bigRationalFromNumber(first.value), unit.toBase);
          valueOk = formatRoundedDecimal(expected.value, check.rounding) === formatRoundedDecimal(studentBase, check.rounding);
        } catch {
          valueOk = false;
        }
      }
    }
    quantities.push({ quantityId: check.quantityId, submitted: true, valueOk, unitOk });
    if (!valueOk || !unitOk) ok = false;
  }
  return { quantities, ok };
}

function judgeEdgeMappingV2(
  expectedPairs: ReadonlyArray<{ cylinderObjectId: string; netEdgeId: string }>,
  responseItems: readonly StructuredResponseItem[],
): { matched: number; total: number; wrongPairIds: string[]; responseTypeOk: boolean } {
  const expected = new Set(expectedPairs.map((p) => pairKey(p.cylinderObjectId, p.netEdgeId)));
  const mappingItems = responseItems.filter(
    (i): i is Extract<StructuredResponseItem, { kind: 'objectMapping' }> => i.kind === 'objectMapping',
  );
  let matched = 0;
  const wrongPairIds: string[] = [];
  const submitted = new Set<string>();
  for (const item of mappingItems) {
    for (const pair of item.pairs) {
      const key = pairKey(pair.leftId, pair.rightId);
      submitted.add(key);
      if (expected.has(key)) matched += 1;
      else wrongPairIds.push(pair.leftId);
    }
  }
  const total = expected.size;
  return {
    matched,
    total,
    wrongPairIds,
    responseTypeOk: mappingItems.length > 0 || total === 0,
  };
}

/** Picks the transfer branch whose mapping best overlaps ONE mapping segment (rules are data; branches carry the two segment vocabularies). */
function pickTransferBranchForSegment(
  rules: readonly NumericRelationRule[],
  pairs: ReadonlyArray<{ leftId: string; rightId: string }>,
): ReadonlySet<string> {
  let best: ReadonlySet<string> = new Set(rules[0]?.expectedEdgeMapping.map((p) => pairKey(p.cylinderObjectId, p.netEdgeId)) ?? []);
  let bestScore = -1;
  for (const rule of rules) {
    const expected = new Set(rule.expectedEdgeMapping.map((p) => pairKey(p.cylinderObjectId, p.netEdgeId)));
    let score = 0;
    for (const pair of pairs) {
      if (expected.has(pairKey(pair.leftId, pair.rightId))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = expected;
    }
  }
  return best;
}

/**
 * TRANSFER_CHECK composite (S1/D1 strangerComposite; authored L2-net-tasks
 * §8/§9: 四段分别判分、分别反馈, D1 实例启用三段). One submission may carry
 * TWO objectMapping segments with disjoint right-id vocabularies
 * (edgePairing: upper/lower/height-line vs directionClaims:
 * base-circle/height-line); each segment is judged against the branch whose
 * expected mapping it best overlaps — a merged single-branch compare can
 * never accept both vocabularies (browser-found defect G 2026-10-27: a fully
 * correct composite scored mappingMatched=6 of 4 with wrongPairIds
 * [net-edge-2, net-edge-4] and could structurally never reach CORRECT).
 * Quantities are judged once per quantityId, restricted to the instance's
 * enabled segments when the binding declares them (paramRead → radius,
 * areaValue → lateral-area; D1 asks no area). The stored feedback shape is
 * unchanged (frozen EvaluationFeedback).
 */
function evaluateTransferComposite(
  rule: Extract<RuleBodyV2, { kind: 'TRANSFER_CHECK' }>,
  givens: CylinderStateV1,
  snapshot: CylinderStateV1,
  responseItems: readonly StructuredResponseItem[],
  enabledSegments: readonly string[] | undefined,
): EvaluationResult {
  const scenarioMet = snapshot.unrollPermille > 0 || givens.unrollPermille > 0;
  const mappingItems = responseItems.filter(
    (i): i is Extract<StructuredResponseItem, { kind: 'objectMapping' }> => i.kind === 'objectMapping',
  );
  const numberItems = responseItems.filter(
    (i): i is Extract<StructuredResponseItem, { kind: 'numberWithUnit' }> => i.kind === 'numberWithUnit',
  );

  let mappingMatched = 0;
  const wrongPairIds: string[] = [];
  for (const item of mappingItems) {
    const expected = pickTransferBranchForSegment(rule.rules, item.pairs);
    for (const pair of item.pairs) {
      if (expected.has(pairKey(pair.leftId, pair.rightId))) mappingMatched += 1;
      else wrongPairIds.push(pair.leftId);
    }
  }
  const mappingTotal = mappingItems.reduce((n, item) => n + item.pairs.length, 0);
  const anyMappingExpected = rule.rules.some((b) => b.expectedEdgeMapping.length > 0);
  const mappingOk = !anyMappingExpected || (mappingItems.length > 0 && mappingMatched === mappingTotal && wrongPairIds.length === 0);

  const SEGMENT_QUANTITY: Record<string, string> = { paramRead: 'radius', areaValue: 'lateral-area' };
  const checks: NumericQuantityCheck[] = [];
  for (const branch of rule.rules) {
    for (const check of branch.quantityChecks) {
      if (checks.some((c) => c.quantityId === check.quantityId)) continue;
      if (enabledSegments !== undefined && !enabledSegments.some((s) => SEGMENT_QUANTITY[s] === check.quantityId)) continue;
      checks.push(check);
    }
  }
  const judged = judgeQuantityChecksV2(checks, responseItems, snapshot);

  const responseTypeOk = (!anyMappingExpected || mappingItems.length > 0) && (checks.length === 0 || numberItems.length > 0);
  const outcome: EvaluationOutcome = scenarioMet && responseTypeOk && mappingOk && judged.ok ? 'CORRECT' : 'REVISE';
  const feedback: EvaluationFeedback = {
    ruleKind: 'NUMERIC_RELATION_V1',
    scenarioMet,
    responseTypeOk,
    mappingMatched,
    mappingTotal,
    wrongPairIds,
    quantities: judged.quantities,
  };
  if (!scenarioMet) feedback.detail = '请先把侧面完全展开（或调整展开进度）后再提交。';
  return { outcome, feedback };
}

function readbackEntryOk(
  entry: { snapshot?: { radiusMm: number; heightMm: number }; quantityId: string; acceptedUnitIds: readonly string[]; expectedCm: string },
  givens: CylinderStateV1,
  snapshot: CylinderStateV1,
  responseItems: readonly StructuredResponseItem[],
): { scenarioMet: boolean; quantity: QuantityCheckFeedback } {
  if (entry.snapshot !== undefined) {
    if (entry.snapshot.radiusMm !== snapshot.radiusMm || entry.snapshot.heightMm !== snapshot.heightMm) {
      return {
        scenarioMet: false,
        quantity: { quantityId: entry.quantityId, submitted: false, valueOk: false, unitOk: false },
      };
    }
  }
  void givens;
  const first = responseItems.find(
    (i): i is Extract<StructuredResponseItem, { kind: 'numberWithUnit' }> =>
      i.kind === 'numberWithUnit' && i.quantityId === entry.quantityId,
  );
  if (first === undefined) {
    return { scenarioMet: true, quantity: { quantityId: entry.quantityId, submitted: false, valueOk: false, unitOk: false } };
  }
  const unit = lookupUnit(first.unitId);
  const unitOk = unit !== null && entry.acceptedUnitIds.includes(first.unitId) && unit.dimension === 1;
  let valueOk = false;
  if (unitOk && unit !== null) {
    try {
      const studentCm = multiplyRational(
        multiplyRational(bigRationalFromNumber(first.value), unit.toBase),
        makeBigRational(1n, 10n),
      );
      // Equivalent spellings must compare by value, not by literal numerator/
      // denominator: expectedCm '8.0' parses as the unreduced 80/10 while the
      // student value reduces to 8/1 (authored equivalence: 8 / 8.0 / 8.00 cm
      // and 80 mm are the same answer). Both sides are reduced before compare.
      const expectedCmRational = reduceRational(bigRationalFromDecimalString(entry.expectedCm));
      const studentReduced = reduceRational(studentCm);
      valueOk = studentReduced.num === expectedCmRational.num && studentReduced.den === expectedCmRational.den;
    } catch {
      valueOk = false;
    }
  }
  return { scenarioMet: true, quantity: { quantityId: entry.quantityId, submitted: true, valueOk, unitOk } };
}

export function evaluateResponseV2(input: EvaluationRequestV2): EvaluationResult {
  const { rule, taskId, givens, snapshot, responseItems } = input;
  const items = [...responseItems];
  try {
    switch (rule.kind) {
      case 'PARAM_CHANGE_CLASSIFY':
        return evaluateParameterIdentification(pickIdentificationBranch(rule.rules, givens, snapshot), givens, snapshot, items);
      case 'NUMERIC_READBACK':
      case 'PARAM_IDENTIFY': {
        const base = evaluateParameterIdentification(pickIdentificationBranch(rule.rules, givens, snapshot), givens, snapshot, items);
        const entry = rule.numericReadback[taskId];
        if (entry === undefined) return base;
        const readback = readbackEntryOk(entry, givens, snapshot, items);
        const sectionOk = judgeSectionPairV2(entry.sectionPair, items);
        const quantities = [...(base.feedback.quantities ?? []), readback.quantity];
        if (entry.sectionPair !== undefined) {
          quantities.push({ quantityId: 'section', submitted: true, valueOk: sectionOk, unitOk: true });
        }
        const correct =
          base.outcome === 'CORRECT' && readback.scenarioMet && readback.quantity.valueOk && readback.quantity.unitOk && sectionOk;
        const feedback: EvaluationFeedback = {
          ...base.feedback,
          quantities,
        };
        if (!readback.scenarioMet) feedback.detail = '请先完成题目要求的变化，再提交判断。';
        else if (!correct && rule.feedback?.numericRevise !== undefined && (!readback.quantity.valueOk || !readback.quantity.unitOk)) {
          feedback.detail = rule.feedback.numericRevise;
        } else if (!correct && !sectionOk && rule.feedback?.sectionRevise !== undefined) {
          feedback.detail = rule.feedback.sectionRevise;
        }
        return { outcome: correct ? 'CORRECT' : 'REVISE', feedback };
      }
      case 'EDGE_DIRECTION':
      case 'EDGE_PAIRING': {
        const mapping = judgeEdgeMappingV2(rule.expectedEdgeMapping, items);
        const scenarioMet = snapshot.unrollPermille > 0 || givens.unrollPermille > 0;
        const mappingOk = mapping.matched === mapping.total && mapping.total > 0 && mapping.wrongPairIds.length === 0;
        const feedback: EvaluationFeedback = {
          ruleKind: 'NUMERIC_RELATION_V1',
          scenarioMet,
          responseTypeOk: mapping.responseTypeOk,
          mappingMatched: mapping.matched,
          mappingTotal: mapping.total,
          wrongPairIds: mapping.wrongPairIds,
        };
        if (!scenarioMet) {
          feedback.detail = '请先把侧面完全展开（或调整展开进度）后再提交。';
          return { outcome: 'REVISE', feedback };
        }
        if (!mappingOk) {
          feedback.detail =
            rule.kind === 'EDGE_PAIRING' ? rule.feedback?.reviseGeneric?.[0] : rule.feedback?.reviseGeneric;
        }
        return { outcome: mappingOk && mapping.responseTypeOk ? 'CORRECT' : 'REVISE', feedback };
      }
      case 'LATERAL_AREA': {
        const judged = judgeQuantityChecksV2(rule.quantityChecks, items, snapshot);
        const numberItems = items.filter((i): i is Extract<StructuredResponseItem, { kind: 'numberWithUnit' }> => i.kind === 'numberWithUnit');
        const responseTypeOk = numberItems.length > 0 || rule.quantityChecks.length === 0;
        const feedback: EvaluationFeedback = {
          ruleKind: 'NUMERIC_RELATION_V1',
          scenarioMet: true,
          responseTypeOk,
          mappingMatched: 0,
          mappingTotal: 0,
          quantities: judged.quantities,
        };
        if (!(judged.ok && responseTypeOk) && rule.feedback?.numericRevise !== undefined) {
          feedback.detail = rule.feedback.numericRevise;
        }
        return { outcome: judged.ok && responseTypeOk ? 'CORRECT' : 'REVISE', feedback };
      }
      case 'TRANSFER_CHECK': {
        return evaluateTransferComposite(rule, givens, snapshot, items, input.enabledSegments);
      }
    }
  } catch {
    // Technical failure inside the evaluator is UNSCORABLE, never "wrong"
    // (LIFECYCLE §4: 技术故障不能写成答错).
    return {
      outcome: 'UNSCORABLE',
      feedback: {
        ruleKind: 'NUMERIC_RELATION_V1',
        scenarioMet: false,
        responseTypeOk: false,
        detail: '判分暂时不可用，本次提交未被判定为错误。',
      },
    };
  }
}

function judgeSectionPairV2(
  sectionPair: { leftId: string; rightId: string } | undefined,
  items: readonly StructuredResponseItem[],
): boolean {
  if (sectionPair === undefined) return true;
  for (const item of items) {
    if (item.kind !== 'objectMapping') continue;
    for (const pair of item.pairs) {
      if (pair.leftId === sectionPair.leftId) {
        return pair.rightId === sectionPair.rightId;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Family evaluation (integration W1, H0-DELTA-INTEGRATION-20261027-3):
// GRID_TASK_TRUTH (THEMES-A) and STEP_TASK_TRUTH (GESP2) delegate to the SAME
// shared pure judges the UI preview uses; the five formalized L3/L4 kinds are
// judged here with BigInt rationals (π = 157/50 exact; reduced-equal compare;
// no float tolerance). Stored evaluation shape stays outcome + EvaluationFeedback
// (family variant carries itemResults/diagnostics/reveal).
// ---------------------------------------------------------------------------

import type { PublicSceneState } from '../contracts/public/scene';
import type { GridBoardStateV1 } from '../contracts/public/scene-gridboard';
import type { StepProgramStateV1 } from '../contracts/public/scene-steps';
import type { FrozenInstanceTruth, RuleBodyL34V1 } from '../contracts/server/rules-l34';
import type { RuleBodyThemesV1 } from '../contracts/server/rules-themes';
import type { RuleBodyStepsV1 } from '../contracts/server/rules-steps';
import { judgeGridTask } from '../scenes/gridboard/judge';
import { judgeStepTask } from '../scenes/steps/judge';

/** Confirmed-operation activity summary folded from OPERATION_COMMITTED events (L4 gates). */
export interface ConfirmedOperationActivity {
  layerCountValues: number[];
  visibleLayerCountValues: number[];
  visibleLayerCountApplies: number;
  setDimensionAxes: string[];
  selectFacesApplies: number;
}

export const EMPTY_ACTIVITY: ConfirmedOperationActivity = {
  layerCountValues: [],
  visibleLayerCountValues: [],
  visibleLayerCountApplies: 0,
  setDimensionAxes: [],
  selectFacesApplies: 0,
};

export type FamilyRuleTruth = RuleBodyL34V1 | RuleBodyThemesV1 | RuleBodyStepsV1;

export interface FamilyEvaluationRequest {
  readonly rule: FamilyRuleTruth;
  readonly taskId: string;
  readonly givens: PublicSceneState;
  readonly snapshot: PublicSceneState;
  readonly responseItems: readonly StructuredResponseItem[];
  /** Frozen instance truth for fromInstance entries (null when none bound). */
  readonly instanceTruth?: FrozenInstanceTruth | null;
  /** Confirmed-operation activity for L4 activity gates. */
  readonly activity?: ConfirmedOperationActivity;
}

function familyUnscorable(detail = '判分暂时不可用，本次提交未被判定为错误。'): EvaluationResult {
  return {
    outcome: 'UNSCORABLE',
    feedback: { ruleKind: 'FAMILY_TRUTH_V1', scenarioMet: false, responseTypeOk: false, detail },
  };
}

function familyFinish(
  verdict: 'CORRECT' | 'REVISE',
  items: readonly { key: string; label: string; verdict: 'CORRECT' | 'REVISE'; feedback?: string }[],
  diagnostics: readonly string[],
  reveal: Record<string, string>,
): EvaluationResult {
  // Strip explicitly-undefined fields: the shared family judges may attach
  // `feedback: undefined` on passing items, and canonicalize() rejects
  // undefined values when the evaluation row is persisted.
  const cleanItems = items.map((it) => {
    const out: { key: string; label: string; verdict: 'CORRECT' | 'REVISE'; feedback?: string } = {
      key: it.key,
      label: it.label,
      verdict: it.verdict,
    };
    if (it.feedback !== undefined) out.feedback = it.feedback;
    return out;
  });
  const cleanReveal: Record<string, string> = {};
  for (const [k, v] of Object.entries(reveal)) {
    if (v !== undefined) cleanReveal[k] = v;
  }
  return {
    outcome: verdict,
    feedback: {
      ruleKind: 'FAMILY_TRUTH_V1',
      scenarioMet: true,
      responseTypeOk: true,
      itemResults: cleanItems,
      diagnostics,
      reveal: cleanReveal,
    },
  };
}

export function evaluateResponseFamily(input: FamilyEvaluationRequest): EvaluationResult {
  try {
    switch (input.rule.kind) {
      case 'GRID_TASK_TRUTH': {
        const entry = input.rule.entries[input.taskId];
        if (entry === undefined) return familyUnscorable(`任务 ${input.taskId} 没有登记判分真值。`);
        const judged = judgeGridTask({
          taskId: input.taskId,
          entry,
          snapshot: input.snapshot as GridBoardStateV1 | Parameters<typeof judgeGridTask>[0]['snapshot'],
          responseItems: input.responseItems,
        });
        return familyFinish(judged.verdict, judged.itemResults, judged.diagnostics, judged.reveal);
      }
      case 'STEP_TASK_TRUTH': {
        if (!('program' in input.snapshot)) {
          return familyUnscorable();
        }
        const judged = judgeStepTask({
          taskId: input.taskId,
          rule: input.rule,
          snapshot: input.snapshot as StepProgramStateV1,
          responseItems: input.responseItems,
        });
        if (judged.verdict === 'UNSCORABLE') return familyUnscorable();
        return familyFinish(judged.verdict === 'CORRECT' ? 'CORRECT' : 'REVISE', judged.itemResults, judged.diagnostics, judged.reveal);
      }
      case 'EXPECTED_OUTPUT':
        // Reserved kind; the first batch binds no task (same precedent as
        // resp.l1.changeClassify.v1). Falling here is a wiring defect.
        return familyUnscorable('EXPECTED_OUTPUT 首批不绑定任务。');
      case 'FACE_SET_TRUTH':
      case 'COMBO_AREA_TRUTH':
      case 'LAYER_STACK_TRUTH':
      case 'VOLUME_COMPARE_TRUTH':
      case 'TRANSFER4_TRUTH':
        return evaluateL34(input);
    }
  } catch {
    // Technical failure inside the evaluator is UNSCORABLE, never "wrong".
    return familyUnscorable();
  }
}

// ---------------------------------------------------------------------------
// L3/L4 exact-rational geometry (π = 157/50; all values in cm / cm² / cm³)
// ---------------------------------------------------------------------------

function lateralAreaCm2(r: number, h: number): BigRational {
  return divideRational(
    multiplyRational(multiplyRational(makeBigRational(157n, 25n), makeBigRational(BigInt(r), 1n)), makeBigRational(BigInt(h), 1n)),
    makeBigRational(100n, 1n),
  );
}

function addBig(a: BigRational, b: BigRational): BigRational {
  return makeBigRational(a.num * b.den + b.num * a.den, a.den * b.den);
}

function divideRational(a: BigRational, b: BigRational): BigRational {
  return multiplyRational(a, makeBigRational(b.den, b.num));
}

function circleAreaCm2(r: number): BigRational {
  return divideRational(
    multiplyRational(makeBigRational(157n, 50n), makeBigRational(BigInt(r * r), 1n)),
    makeBigRational(100n, 1n),
  );
}

function volumeCm3(r: number, h: number): BigRational {
  return divideRational(
    multiplyRational(multiplyRational(makeBigRational(157n, 50n), makeBigRational(BigInt(r * r), 1n)), makeBigRational(BigInt(h), 1n)),
    makeBigRational(1000n, 1n),
  );
}

function layerThicknessCm(h: number, n: number): BigRational {
  return divideRational(makeBigRational(BigInt(h), 1n), makeBigRational(BigInt(n * 10), 1n));
}

function cumulativeVolumeCm3(r: number, h: number, n: number, k: number): BigRational {
  return divideRational(multiplyRational(volumeCm3(r, h), makeBigRational(BigInt(k), 1n)), makeBigRational(BigInt(n), 1n));
}

function eqDecimal(value: BigRational, expected: string): boolean {
  const expectedRational = reduceRational(bigRationalFromDecimalString(expected));
  const got = reduceRational(value);
  return got.num === expectedRational.num && got.den === expectedRational.den;
}

function decimalOf(value: BigRational): string {
  return formatRoundedDecimal(value, { mode: 'HALF_UP', decimalPlaces: 6 }).replace(/0+$/, '').replace(/\.$/, '');
}

function mappingPairsOf(items: readonly StructuredResponseItem[]): Array<{ leftId: string; rightId: string }> {
  const pairs: Array<{ leftId: string; rightId: string }> = [];
  for (const item of items) {
    if (item.kind === 'objectMapping') pairs.push(...item.pairs);
  }
  return pairs;
}

type NumberItem = Extract<StructuredResponseItem, { kind: 'numberWithUnit' }>;
function numberItemsOf(items: readonly StructuredResponseItem[]): NumberItem[] {
  return items.filter((i): i is NumberItem => i.kind === 'numberWithUnit');
}

const L34_FACES = ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'] as const;

interface ItemBuilder {
  key: string;
  label: string;
  verdict: 'CORRECT' | 'REVISE';
  feedback?: string;
}

/** Snapshot=declaration gate (双校验): declared includes must equal confirmed selectedFaceIds. */
function faceDeclarationMatchesSnapshot(pairs: Array<{ leftId: string; rightId: string }>, selectedFaceIds: readonly string[]): boolean {
  const declared = pairs
    .filter((p) => (L34_FACES as readonly string[]).includes(p.leftId) && p.rightId === 'opt-include')
    .map((p) => p.leftId)
    .sort();
  const snapshotIds = [...selectedFaceIds].sort();
  return JSON.stringify(declared) === JSON.stringify(snapshotIds);
}

function evaluateL34(input: FamilyEvaluationRequest): EvaluationResult {
  const rule = input.rule as RuleBodyL34V1;
  if (rule.entries[input.taskId] === undefined) return familyUnscorable(`任务 ${input.taskId} 没有登记判分真值。`);
  const snapshot = input.snapshot as { radiusMm: number; heightMm: number; layerCount?: number; visibleLayerCount?: number; selectedFaceIds: string[] };
  const items: ItemBuilder[] = [];
  const diagnostics: string[] = [];
  const reveal: Record<string, string> = {};
  const activity = input.activity ?? EMPTY_ACTIVITY;
  const instanceTruth = (input.instanceTruth?.truth ?? null) as Record<string, unknown> | null;

  switch (rule.kind) {
    case 'FACE_SET_TRUTH': {
      const entry = rule.entries[input.taskId]!;
      const truthFaces = ((entry.faceSet as Record<string, string> | undefined) ?? (instanceTruth?.['faceSet'] as Record<string, string> | undefined)) ?? null;
      const truthLid = entry.lidCount ?? (instanceTruth?.['lidCount'] as string | undefined);
      if (truthFaces === null || truthLid === undefined) return familyUnscorable();
      const pairs = mappingPairsOf(input.responseItems).filter((p) => (L34_FACES as readonly string[]).includes(p.leftId));
      const declaredIncludes = pairs.filter((p) => p.rightId === 'opt-include').map((p) => p.leftId).sort();
      if (entry.snapshotMustEqualDeclaration && !faceDeclarationMatchesSnapshot(pairs, snapshot.selectedFaceIds)) {
        items.push({ key: 'snapshot', label: '构造与声明一致', verdict: 'REVISE', feedback: rule.feedback.snapshotMismatch });
        reveal.faceSet = '有底无盖：侧面+下盖面（上盖面不算入）';
        return familyFinish('REVISE', items, diagnostics, reveal);
      }
      const facesOk = pairs.length === 3 && pairs.every((p) => truthFaces[p.leftId] === p.rightId);
      const lowerMissed =
        pairs.find((p) => p.leftId === 'cyl-face-lower')?.rightId === 'opt-exclude' && truthFaces['cyl-face-lower'] === 'opt-include';
      items.push({
        key: 'faceSet',
        label: '面集合三行',
        verdict: facesOk ? 'CORRECT' : 'REVISE',
        ...(facesOk ? {} : { feedback: lowerMissed ? rule.feedback.missingLowerVariant : rule.feedback.reviseGeneric }),
      });
      const lid = mappingPairsOf(input.responseItems).find((p) => p.leftId === 'lid-count')?.rightId;
      const lidOk = lid === truthLid;
      items.push({ key: 'lidCount', label: '盖面个数', verdict: lidOk ? 'CORRECT' : 'REVISE', ...(lidOk ? {} : { feedback: rule.feedback.reviseGeneric }) });
      reveal.faceSet = '有底无盖：侧面 + 下盖面（上盖面不算入）';
      reveal.lidCount = truthLid === 'opt-1' ? '1 个' : truthLid === 'opt-2' ? '2 个' : '0 个';
      return familyFinish(facesOk && lidOk ? 'CORRECT' : 'REVISE', items, diagnostics, reveal);
    }
    case 'COMBO_AREA_TRUTH': {
      const entry = rule.entries[input.taskId]!;
      const r = snapshot.radiusMm;
      const h = snapshot.heightMm;
      const lateral = lateralAreaCm2(r, h);
      const circle = circleAreaCm2(r);
      const expected = bigRationalFromDecimalString(entry.expectedCm2);
      if (entry.taskForm === 'LID_DELTA') {
        const numeric = numberItemsOf(input.responseItems).find((n) => n.quantityId === 'paper-area-delta');
        const attribution = mappingPairsOf(input.responseItems).find((p) => p.leftId === 'delta-attribution')?.rightId;
        let numericOk = false;
        if (!numeric) {
          items.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'REVISE', feedback: rule.feedback.numericRevise });
        } else if (numeric.unitId !== 'cm2') {
          diagnostics.push(rule.diagnostics.unitMismatch.tag);
          items.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'REVISE', feedback: rule.diagnostics.unitMismatch.feedback });
        } else {
          const got = bigRationalFromNumber(numeric.value);
          if (eqDecimal(got, entry.expectedCm2)) {
            numericOk = true;
            items.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'CORRECT' });
          } else if (eqDecimal(got, decimalOf(circle))) {
            diagnostics.push(rule.diagnostics.misOneLidMissing.tag);
            items.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'REVISE', feedback: rule.diagnostics.misOneLidMissing.feedback });
          } else if (eqDecimal(got, decimalOf(multiplyRational(lateral, makeBigRational(2n, 1n))))) {
            diagnostics.push(rule.diagnostics.misDoubleSide.tag);
            items.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'REVISE', feedback: rule.diagnostics.misDoubleSide.feedback });
          } else {
            items.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'REVISE', feedback: rule.feedback.numericRevise });
          }
        }
        reveal.value = `${entry.expectedCm2} cm²`;
        const attrOk = attribution === entry.attribution;
        items.push({ key: 'attribution', label: '多用纸的概念归属', verdict: attrOk ? 'CORRECT' : 'REVISE', ...(attrOk ? {} : { feedback: '再想想多出来的是哪些面' }) });
        return familyFinish(numericOk && attrOk ? 'CORRECT' : 'REVISE', items, diagnostics, reveal);
      }
      // COMBO form
      let all = true;
      const truthFaces = ((entry.faceSet as Record<string, string> | undefined) ?? (instanceTruth?.['faceSet'] as Record<string, string> | undefined)) ?? null;
      if (truthFaces !== null && !entry.snapshotSubsetOnly) {
        const pairs = mappingPairsOf(input.responseItems).filter((p) => (L34_FACES as readonly string[]).includes(p.leftId));
        if (entry.snapshotMustEqualDeclaration && !faceDeclarationMatchesSnapshot(pairs, snapshot.selectedFaceIds)) {
          items.push({ key: 'snapshot', label: '构造与声明一致', verdict: 'REVISE', feedback: '先把场景里的选面改成你答案里的样子，再提交。' });
          reveal.value = `${entry.expectedCm2} cm²`;
          return familyFinish('REVISE', items, diagnostics, reveal);
        }
        const facesOk = pairs.length === 3 && pairs.every((p) => truthFaces[p.leftId] === p.rightId);
        items.push({ key: 'faceSet', label: '面集合三行', verdict: facesOk ? 'CORRECT' : 'REVISE', ...(facesOk ? {} : { feedback: rule.feedback.numericRevise }) });
        if (!facesOk) all = false;
      }
      const numeric = numberItemsOf(input.responseItems).find((n) => n.quantityId === 'paper-area');
      reveal.value = `${entry.expectedCm2} cm²`;
      if (!numeric) {
        items.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: rule.feedback.numericRevise });
        return familyFinish('REVISE', items, diagnostics, reveal);
      }
      if (numeric.unitId !== 'cm2') {
        diagnostics.push(rule.diagnostics.unitMismatch.tag);
        items.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: rule.diagnostics.unitMismatch.feedback });
        return familyFinish('REVISE', items, diagnostics, reveal);
      }
      const got = bigRationalFromNumber(numeric.value);
      if (eqDecimal(got, entry.expectedCm2)) {
        items.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'CORRECT' });
        return familyFinish(all ? 'CORRECT' : 'REVISE', items, diagnostics, reveal);
      }
      if (eqDecimal(got, decimalOf(lateral))) {
        diagnostics.push(rule.diagnostics.misLidsMissing.tag);
        items.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: rule.diagnostics.misLidsMissing.feedback });
        return familyFinish('REVISE', items, diagnostics, reveal);
      }
      const oneLid = addBig(lateral, circle);
      if (eqDecimal(got, decimalOf(oneLid))) {
        // lateral + circle (one lid)
        if (input.taskId === 'cyl.faces.g3.full-surface.v1') {
          items.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: '再数一数封口罐有几个圆面' });
        } else {
          diagnostics.push(rule.diagnostics.misOneLidMissing.tag);
          items.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: rule.diagnostics.misOneLidMissing.feedback });
        }
        return familyFinish('REVISE', items, diagnostics, reveal);
      }
      if (eqDecimal(got, decimalOf(multiplyRational(lateral, makeBigRational(2n, 1n))))) {
        diagnostics.push(rule.diagnostics.misDoubleSide.tag);
        items.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: rule.diagnostics.misDoubleSide.feedback });
        return familyFinish('REVISE', items, diagnostics, reveal);
      }
      items.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: rule.feedback.numericRevise });
      return familyFinish('REVISE', items, diagnostics, reveal);
    }
    case 'LAYER_STACK_TRUTH': {
      const entry = rule.entries[input.taskId]!;
      const r = snapshot.radiusMm;
      const h = snapshot.heightMm;
      if (entry.taskForm === 'STACK_INVARIANT') {
        if (
          !entry.activity?.setLayerCountValues?.every((v) => activity.layerCountValues.includes(v)) ||
          activity.visibleLayerCountApplies < (entry.activity?.setVisibleLayerCountAppliesMin ?? 0)
        ) {
          items.push({ key: 'activity', label: '层叠活动（8 层与 16 层都装过、逐层推进过）', verdict: 'REVISE', feedback: rule.feedback.activityRevise });
          reveal.directions = '每层厚度：变小；总体积：不变';
          reveal.volume = `${entry.volumeCm3} cm³（8 层与 16 层都是）`;
          return familyFinish('REVISE', items, diagnostics, reveal);
        }
        const claims = new Map<string, string>();
        for (const item of input.responseItems) {
          if (item.kind === 'propertyJudgments') for (const c of item.claims) claims.set(c.propertyId, c.direction);
        }
        const thicknessOk = claims.get('layerThickness') === entry.directions?.layerThickness;
        const volumeDirOk = claims.get('totalVolume') === entry.directions?.totalVolume;
        items.push({
          key: 'directions',
          label: '两属性方向（层厚/总体积）',
          verdict: thicknessOk && volumeDirOk ? 'CORRECT' : 'REVISE',
          ...(thicknessOk && volumeDirOk ? {} : { feedback: rule.feedback.invariantRevise }),
        });
        reveal.directions = '每层厚度：变小；总体积：不变';
        reveal.volume = `${entry.volumeCm3} cm³（8 层与 16 层都是）`;
        const numeric = numberItemsOf(input.responseItems).find((n) => n.quantityId === 'volume');
        let valueOk = false;
        if (!numeric) {
          items.push({ key: 'volume', label: '总体积（数值+单位）', verdict: 'REVISE', feedback: '先算底面积，再乘高' });
        } else if (numeric.unitId !== 'cm3') {
          diagnostics.push('unit-mismatch');
          items.push({ key: 'volume', label: '总体积（数值+单位）', verdict: 'REVISE', feedback: '数值对了，再看看单位' });
        } else {
          valueOk = eqDecimal(bigRationalFromNumber(numeric.value), entry.volumeCm3 ?? decimalOf(volumeCm3(r, h)));
          items.push({ key: 'volume', label: '总体积（数值+单位）', verdict: valueOk ? 'CORRECT' : 'REVISE', ...(valueOk ? {} : { feedback: '先算底面积，再乘高' }) });
        }
        return familyFinish(thicknessOk && volumeDirOk && valueOk ? 'CORRECT' : 'REVISE', items, diagnostics, reveal);
      }
      if (entry.taskForm === 'LAYER_VOLUME') {
        const n = ((entry.snapshot as { layerCount?: number } | undefined)?.layerCount ?? snapshot.layerCount) as number;
        if (!(activity.visibleLayerCountValues.includes(entry.activity?.visibleLayerCountReached ?? n) || (snapshot.visibleLayerCount ?? 0) >= (entry.activity?.visibleLayerCountReached ?? n))) {
          items.push({ key: 'activity', label: '累计表走满（推进到第 8 层）', verdict: 'REVISE', feedback: '把累计表一层层推满到第 8 层再提交。' });
          reveal.thickness = `${entry.thicknessCm} cm`;
          reveal.perLayer = `${entry.perLayerCm3} cm³`;
          reveal.total = `${entry.totalCm3} cm³`;
          return familyFinish('REVISE', items, diagnostics, reveal);
        }
        const thickness = layerThicknessCm(h, n);
        let all = true;
        const t = numberItemsOf(input.responseItems).find((x) => x.quantityId === 'layer-thickness');
        const tOk = !!t && t.unitId === 'cm' && eqDecimal(bigRationalFromNumber(t.value), decimalOf(thickness));
        items.push({ key: 'thickness', label: '层厚（cm，一位小数）', verdict: tOk ? 'CORRECT' : 'REVISE', ...(tOk ? {} : { feedback: '层厚 = 高 ÷ 层数，再算一遍。' }) });
        if (!tOk) all = false;
        const p = numberItemsOf(input.responseItems).find((x) => x.quantityId === 'layer-volume');
        const perLayerTruth = multiplyRational(circleAreaCm2(r), thickness);
        const pOk = !!p && p.unitId === 'cm3' && eqDecimal(bigRationalFromNumber(p.value), entry.perLayerCm3 ?? decimalOf(perLayerTruth));
        items.push({ key: 'perLayer', label: '每层体积（数值+单位）', verdict: pOk ? 'CORRECT' : 'REVISE', ...(pOk ? {} : { feedback: p?.unitId !== 'cm3' ? '数值对了，再看看单位' : '先算底面积，再乘层厚' }) });
        if (!pOk) all = false;
        const v = numberItemsOf(input.responseItems).find((x) => x.quantityId === 'volume');
        const vOk = !!v && v.unitId === 'cm3' && eqDecimal(bigRationalFromNumber(v.value), entry.totalCm3 ?? decimalOf(volumeCm3(r, h)));
        items.push({ key: 'total', label: '总体积（数值+单位）', verdict: vOk ? 'CORRECT' : 'REVISE', ...(vOk ? {} : { feedback: v?.unitId !== 'cm3' ? '数值对了，再看看单位' : '先算底面积，再乘高' }) });
        if (!vOk) all = false;
        reveal.thickness = `${entry.thicknessCm} cm`;
        reveal.perLayer = `${entry.perLayerCm3} cm³`;
        reveal.total = `${entry.totalCm3} cm³`;
        return familyFinish(all ? 'CORRECT' : 'REVISE', items, diagnostics, reveal);
      }
      // ACCUMULATE
      if (activity.visibleLayerCountApplies < (entry.activity?.setVisibleLayerCountAppliesMin ?? 0)) {
        items.push({ key: 'activity', label: '逐层执行（至少一次层推进确认）', verdict: 'REVISE', feedback: '先一层层推进，把累计表走到超过 100 的那一层。' });
        return familyFinish('REVISE', items, diagnostics, reveal);
      }
      const truth = instanceTruth ?? null;
      if (truth === null) return familyUnscorable();
      const firstExceedLayer = truth['firstExceedLayer'] as number;
      const cumulative = truth['cumulativeAtLayerCm3'] as string;
      const boundary = truth['boundary'] as { layer7Cm3: string; layer9Cm3: string };
      reveal.layer = `第 ${firstExceedLayer} 层`;
      reveal.cumulative = `${cumulative} cm³`;
      const layerN = numberItemsOf(input.responseItems).find((n) => n.quantityId === 'layer-index');
      const cumN = numberItemsOf(input.responseItems).find((n) => n.quantityId === 'cumulative-volume');
      const layerVal = layerN ? layerN.value : NaN;
      const cumOk = !!cumN && cumN.unitId === 'cm3' && eqDecimal(bigRationalFromNumber(cumN.value), cumulative);
      const layerOk = layerN?.unitId === 'layer' && layerVal === firstExceedLayer;
      const cumVal = cumN && cumN.unitId === 'cm3' ? bigRationalFromNumber(cumN.value) : null;
      const boundaryHit =
        (layerVal === 7 && cumVal !== null && eqDecimal(cumVal, boundary.layer7Cm3)) ||
        (layerVal === 9 && cumVal !== null && eqDecimal(cumVal, boundary.layer9Cm3));
      if (boundaryHit) {
        diagnostics.push('off-by-one-boundary');
        items.push({ key: 'layer', label: '首次超限层号', verdict: 'REVISE', feedback: rule.feedback.boundaryRevise });
        items.push({ key: 'cumulative', label: '该层累计体积', verdict: cumOk ? 'CORRECT' : 'REVISE', ...(cumOk ? {} : { feedback: rule.feedback.cumulativeRevise }) });
        return familyFinish('REVISE', items, diagnostics, reveal);
      }
      items.push({ key: 'layer', label: '首次超限层号', verdict: layerOk ? 'CORRECT' : 'REVISE', ...(layerOk ? {} : { feedback: '没过 100 的最后一层也要看清楚。' }) });
      items.push({ key: 'cumulative', label: '该层累计体积', verdict: cumOk ? 'CORRECT' : 'REVISE', ...(cumOk ? {} : { feedback: cumN?.unitId !== 'cm3' ? '数值对了，再看看单位' : rule.feedback.cumulativeRevise }) });
      return familyFinish(layerOk && cumOk ? 'CORRECT' : 'REVISE', items, diagnostics, reveal);
    }
    case 'VOLUME_COMPARE_TRUTH': {
      const entry = rule.entries[input.taskId]!;
      if (entry.taskForm === 'VOLUME_VALUE') {
        const truth = instanceTruth ?? null;
        if (truth === null) return familyUnscorable();
        const expected = truth['volumeCm3'] as string;
        reveal.value = `${expected} cm³`;
        const numeric = numberItemsOf(input.responseItems).find((n) => n.quantityId === 'volume');
        if (!numeric) {
          items.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'REVISE', feedback: rule.feedback.numericRevise });
          return familyFinish('REVISE', items, diagnostics, reveal);
        }
        if (numeric.unitId !== 'cm3') {
          diagnostics.push('unit-mismatch');
          items.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'REVISE', feedback: rule.feedback.unitMismatch ?? '数值对了，再看看单位' });
          return familyFinish('REVISE', items, diagnostics, reveal);
        }
        const got = bigRationalFromNumber(numeric.value);
        if (eqDecimal(got, expected)) {
          items.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'CORRECT' });
          return familyFinish('CORRECT', items, diagnostics, reveal);
        }
        if (entry.diagnostics?.misCircumferenceTimesH !== undefined && eqDecimal(got, entry.diagnostics.misCircumferenceTimesH)) {
          diagnostics.push('mis-circumference-times-h');
          items.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'REVISE', feedback: rule.feedback.misCircumferenceTimesH });
          return familyFinish('REVISE', items, diagnostics, reveal);
        }
        if (entry.diagnostics?.misPiRh !== undefined && eqDecimal(got, entry.diagnostics.misPiRh)) {
          diagnostics.push('mis-pi-r-h');
          items.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'REVISE', feedback: rule.feedback.misPiRh });
          return familyFinish('REVISE', items, diagnostics, reveal);
        }
        items.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'REVISE', feedback: rule.feedback.numericRevise });
        return familyFinish('REVISE', items, diagnostics, reveal);
      }
      // VAR_COMPARE
      const isG3 = entry.variants !== undefined;
      const truth = isG3
        ? { bigger: entry.bigger!, valueA: entry.valueACm3!, valueB: entry.valueBCm3!, ratio: entry.ratio ?? '' }
        : { bigger: instanceTruth?.['bigger'] as string, valueA: instanceTruth?.['valueACm3'] as string, valueB: instanceTruth?.['valueBCm3'] as string, ratio: '' };
      if (isG3) {
        reveal.bigger = '加宽的方案';
        reveal.valueA = `${truth.valueA} cm³`;
        reveal.valueB = `${truth.valueB} cm³`;
        reveal.ratio = '4 倍';
        if (
          !entry.activity?.setDimensionAxes?.every((axis) => activity.setDimensionAxes.includes(axis))
        ) {
          items.push({ key: 'activity', label: '两方案都在罐子上试过（RADIUS 与 HEIGHT 各至少一次确认）', verdict: 'REVISE', feedback: rule.feedback.activityRevise });
          return familyFinish('REVISE', items, diagnostics, reveal);
        }
      } else {
        reveal.bigger = '加宽的方案';
        reveal.valueA = `${truth.valueA} cm³`;
        reveal.valueB = `${truth.valueB} cm³`;
      }
      let all = true;
      const bigger = mappingPairsOf(input.responseItems).find((p) => p.leftId === 'bigger-plan')?.rightId;
      const biggerOk = bigger === truth.bigger;
      items.push({ key: 'bigger', label: '哪个方案装得多', verdict: biggerOk ? 'CORRECT' : 'REVISE', ...(biggerOk ? {} : { feedback: '两个方案各算一遍再比。' }) });
      if (!biggerOk) all = false;
      const va = numberItemsOf(input.responseItems).find((x) => x.quantityId === 'volume-a');
      const vaOk = !!va && va.unitId === 'cm3' && eqDecimal(bigRationalFromNumber(va.value), truth.valueA);
      items.push({ key: 'valueA', label: '加高方案体积', verdict: vaOk ? 'CORRECT' : 'REVISE', ...(vaOk ? {} : { feedback: va?.unitId !== 'cm3' ? '数值对了，再看看单位' : rule.feedback.numericRevise }) });
      if (!vaOk) all = false;
      const vb = numberItemsOf(input.responseItems).find((x) => x.quantityId === 'volume-b');
      const vbOk = !!vb && vb.unitId === 'cm3' && eqDecimal(bigRationalFromNumber(vb.value), truth.valueB);
      items.push({ key: 'valueB', label: '加宽方案体积', verdict: vbOk ? 'CORRECT' : 'REVISE', ...(vbOk ? {} : { feedback: vb?.unitId !== 'cm3' ? '数值对了，再看看单位' : rule.feedback.numericRevise }) });
      if (!vbOk) all = false;
      if (isG3 && entry.ratio !== undefined) {
        const ratio = mappingPairsOf(input.responseItems).find((p) => p.leftId === 'radius-double-ratio')?.rightId;
        const ratioOk = ratio === truth.ratio;
        items.push({ key: 'ratio', label: '半径加倍的体积倍数', verdict: ratioOk ? 'CORRECT' : 'REVISE', ...(ratioOk ? {} : { feedback: rule.feedback.ratioRevise }) });
        if (!ratioOk) all = false;
      }
      if (!isG3 && bigger === 'opt-plan-a' && vaOk && vbOk) diagnostics.push('mis-linear-choice');
      return familyFinish(all ? 'CORRECT' : 'REVISE', items, diagnostics, reveal);
    }
    case 'TRANSFER4_TRUTH': {
      const entry = rule.entries[input.taskId]!;
      const truth = instanceTruth ?? null;
      if (truth === null) return familyUnscorable();
      let all = true;
      // paramRead
      const expectedRadius = truth['radiusCm'] as string;
      reveal.radius = `${expectedRadius} cm`;
      const n = numberItemsOf(input.responseItems).find((x) => x.quantityId === 'radius');
      const okR = !!n && n.unitId === 'cm' && eqDecimal(bigRationalFromNumber(n.value), expectedRadius);
      items.push({ key: 'paramRead', label: '半径', verdict: okR ? 'CORRECT' : 'REVISE', ...(okR ? {} : { feedback: rule.feedback.paramReadRevise }) });
      if (!okR) all = false;
      // faceSet
      const truthFaces = truth['faceSet'] as Record<string, string>;
      const pairs = mappingPairsOf(input.responseItems).filter((p) => (L34_FACES as readonly string[]).includes(p.leftId));
      if (entry.snapshotMustEqualDeclaration && !faceDeclarationMatchesSnapshot(pairs, snapshot.selectedFaceIds)) {
        items.push({ key: 'faceSet', label: '面集合三行', verdict: 'REVISE', feedback: '先把场景里的选面改成你答案里的样子，再提交。' });
        all = false;
      } else {
        const okF = pairs.length === 3 && pairs.every((p) => truthFaces[p.leftId] === p.rightId);
        items.push({ key: 'faceSet', label: '面集合三行', verdict: okF ? 'CORRECT' : 'REVISE', ...(okF ? {} : { feedback: rule.feedback.faceSetRevise }) });
        if (!okF) all = false;
      }
      reveal.faceSet = '有底有盖：侧面+上盖+下盖；有底无盖：侧面+下盖面';
      // paperArea
      const expectedPaper = truth['paperAreaCm2'] as string;
      reveal.paperArea = `${expectedPaper} cm²`;
      const pA = numberItemsOf(input.responseItems).find((x) => x.quantityId === 'paper-area');
      const okP = !!pA && pA.unitId === 'cm2' && eqDecimal(bigRationalFromNumber(pA.value), expectedPaper);
      items.push({ key: 'paperArea', label: '纸板面积（数值+单位）', verdict: okP ? 'CORRECT' : 'REVISE', ...(okP ? {} : { feedback: pA?.unitId !== 'cm2' ? '数值对了，再看看单位' : rule.feedback.paperRevise }) });
      if (!okP) all = false;
      // volume
      const expectedVolume = truth['volumeCm3'] as string;
      reveal.volume = `${expectedVolume} cm³`;
      const v = numberItemsOf(input.responseItems).find((x) => x.quantityId === 'volume');
      const okV = !!v && v.unitId === 'cm3' && eqDecimal(bigRationalFromNumber(v.value), expectedVolume);
      items.push({ key: 'volume', label: '体积（数值+单位）', verdict: okV ? 'CORRECT' : 'REVISE', ...(okV ? {} : { feedback: v?.unitId !== 'cm3' ? '数值对了，再看看单位' : rule.feedback.volumeRevise }) });
      if (!okV) all = false;
      return familyFinish(all ? 'CORRECT' : 'REVISE', items, diagnostics, reveal);
    }
  }
}
