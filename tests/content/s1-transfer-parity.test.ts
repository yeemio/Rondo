/**
 * Content/rule/evaluator parity regression for the L2 stranger composite
 * (browser-found defect 2026-10-27 run report 疑点 G: cyl.net.s1 judged
 * REVISE with scenarioMet=true, mappingMatched=6/4-total, wrongPairIds
 * [net-edge-2, net-edge-4] and radius valueOk=false at the correct 1.5 cm
 * while the same snapshot accepted the area 84.78).
 *
 * Authored key (preparation/C/tasks/L2-net-tasks.md §8 + §10.1/§10.3, frozen
 * instance cyl.net.s1.F1 d=3.0/r=1.5/h=9.0): paramRead radius 1.5 cm;
 * pairing 1→height / 2→upper / 3→height / 4→lower; directionClaims
 * circle={2,4} height={1,3}; area 84.78 cm². The browser submitted exactly
 * that key — so the E2E answers are correct and the divergence is in the
 * served rule/evaluator pair, not the spec.
 *
 * Two defects this test pins (both fixed alongside):
 *  1. content: the transfer rule's radius quantityCheck expressed the
 *     expected value in cm ((1/10)×radiusMm) while the frozen evaluator
 *     convention compares expected in the mm base (view-ops
 *     quantityValueText documents "the expression evaluates in the mm
 *     base"; the area check in the same file is mm²-caled and passed);
 *  2. evaluator: TRANSFER_CHECK merged BOTH objectMapping segments (the
 *     pairing vocabulary and the direction vocabulary co-exist in one
 *     composite submission) into a single-branch compare — authored §8
 *     requires 四段分别判分.
 *
 * Like g2-rule-parity, this rebuilds dist/content first so it never asserts
 * against a stale build product, then drives the REAL rule body loaded
 * through RondoContentService.loadRelease through the REAL evaluator
 * (evaluateResponseV2).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RondoContentService } from '../../modules/content';
import { SqliteStorage } from '../../adapters/sqlite/storage';
import { evaluateResponseV2 } from '../../modules/learning/evaluate';
import type { StructuredResponseItem } from '../../modules/contracts/public/envelope';
import type { CylinderStateV1 } from '../../modules/contracts/public/scene';

const ROOT = process.cwd();
const DIST_CONTENT = join(ROOT, 'dist', 'content');
const L2_RELEASE = 'rondo.cyl.l2-r1';
const S1 = 'cyl.net.s1.stranger-relabel.v1';
const D1 = 'cyl.net.d1.delayed-transfer.v1';

// Deterministic rebuild: judge the current builder output, never a stale dist.
const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-content.mjs')], { encoding: 'utf8' });
assert.equal(build.status, 0, `build-content failed:\n${build.stderr}`);

function mkState(radiusMm: number, heightMm: number, unrollPermille = 0): CylinderStateV1 {
  return { radiusMm, heightMm, unrollPermille, section: 'NONE', selectedFaceIds: [] };
}

/** Frozen instance givens (cyl.net.s1.F1: d=3.0 → r=1.5 cm, h=9.0 cm). */
const S1_GIVENS = mkState(15, 90);
/** Fully unrolled confirmed snapshot at submit time (E2E: SetUnroll 1000). */
const S1_SNAPSHOT = mkState(15, 90, 1000);

/** The exact response the browser submitted for S1 (DB evidence sub-18de60f5). */
const S1_BROWSER_RESPONSE: StructuredResponseItem[] = [
  { kind: 'numberWithUnit', quantityId: 'radius', unitId: 'cm', value: 1.5 },
  {
    kind: 'objectMapping',
    pairs: [
      { leftId: 'net-edge-1', rightId: 'cyl-part-height-line' },
      { leftId: 'net-edge-2', rightId: 'cyl-part-upper-circle' },
      { leftId: 'net-edge-3', rightId: 'cyl-part-height-line' },
      { leftId: 'net-edge-4', rightId: 'cyl-part-lower-circle' },
    ],
  },
  {
    kind: 'objectMapping',
    pairs: [
      { leftId: 'net-edge-1', rightId: 'cyl-part-height-line' },
      { leftId: 'net-edge-2', rightId: 'cyl-part-base-circle' },
      { leftId: 'net-edge-3', rightId: 'cyl-part-height-line' },
      { leftId: 'net-edge-4', rightId: 'cyl-part-base-circle' },
    ],
  },
  { kind: 'numberWithUnit', quantityId: 'lateral-area', unitId: 'cm2', value: 84.78 },
];

test('S1: browser-evidence composite answer (r=1.5, both mappings, 84.78) judges CORRECT with full mapping credit', async () => {
  const storage = new SqliteStorage({ file: ':memory:', now: () => 1_790_000_000_000 });
  const content = new RondoContentService({ storage, now: () => 1_790_000_000_000 });
  try {
    await content.loadRelease(DIST_CONTENT, L2_RELEASE);
    const rule = content.getRuleBodyV2(L2_RELEASE, S1);
    assert.ok(rule !== null, 'S1 v2 rule body not loaded from dist');
    assert.equal(rule.kind, 'TRANSFER_CHECK');

    const correct = evaluateResponseV2({ rule, taskId: S1, givens: S1_GIVENS, snapshot: S1_SNAPSHOT, responseItems: S1_BROWSER_RESPONSE });
    assert.equal(
      correct.outcome,
      'CORRECT',
      `browser evidence answer must be CORRECT, got ${correct.outcome}: ${JSON.stringify(correct.feedback)}`,
    );
    assert.equal(correct.feedback.scenarioMet, true);
    // per-segment credit: both mapping segments count (4+4), no wrong pairs
    assert.equal(correct.feedback.mappingMatched, 8);
    assert.equal(correct.feedback.mappingTotal, 8);
    assert.deepEqual(correct.feedback.wrongPairIds, []);
    for (const q of correct.feedback.quantities ?? []) {
      assert.equal(q.valueOk, true, `${q.quantityId} valueOk`);
      assert.equal(q.unitOk, true, `${q.quantityId} unitOk`);
    }
  } finally {
    await content.close();
    await storage.close();
    storage.closeConnection();
  }
});

test('S1 negative controls: wrong pairing, wrong direction claims, and the diameter-as-radius trap all stay REVISE', async () => {
  const storage = new SqliteStorage({ file: ':memory:', now: () => 1_790_000_000_000 });
  const content = new RondoContentService({ storage, now: () => 1_790_000_000_000 });
  try {
    await content.loadRelease(DIST_CONTENT, L2_RELEASE);
    const rule = content.getRuleBodyV2(L2_RELEASE, S1)!;

    // (a) appearance-heuristic pairing (edges 1/3 to circles, 2/4 to height)
    const wrongPairing = S1_BROWSER_RESPONSE.map((item) =>
      item.kind === 'objectMapping' &&
      item.pairs.some((p) => p.rightId === 'cyl-part-upper-circle' || p.rightId === 'cyl-part-lower-circle')
        ? {
            kind: 'objectMapping' as const,
            pairs: [
              { leftId: 'net-edge-1', rightId: 'cyl-part-upper-circle' },
              { leftId: 'net-edge-2', rightId: 'cyl-part-height-line' },
              { leftId: 'net-edge-3', rightId: 'cyl-part-lower-circle' },
              { leftId: 'net-edge-4', rightId: 'cyl-part-height-line' },
            ],
          }
        : item,
    );
    const pairingResult = evaluateResponseV2({ rule, taskId: S1, givens: S1_GIVENS, snapshot: S1_SNAPSHOT, responseItems: wrongPairing });
    assert.equal(pairingResult.outcome, 'REVISE');
    assert.ok((pairingResult.feedback.mappingMatched ?? 0) < 8, 'wrong pairing must lose mapping credit');
    assert.ok((pairingResult.feedback.wrongPairIds ?? []).length > 0);

    // (b) swapped direction claims (横竖 heuristic: 1/3 circle, 2/4 height)
    const wrongDirection = S1_BROWSER_RESPONSE.map((item) =>
      item.kind === 'objectMapping' && item.pairs.some((p) => p.rightId === 'cyl-part-base-circle')
        ? {
            kind: 'objectMapping' as const,
            pairs: [
              { leftId: 'net-edge-1', rightId: 'cyl-part-base-circle' },
              { leftId: 'net-edge-2', rightId: 'cyl-part-height-line' },
              { leftId: 'net-edge-3', rightId: 'cyl-part-base-circle' },
              { leftId: 'net-edge-4', rightId: 'cyl-part-height-line' },
            ],
          }
        : item,
    );
    const directionResult = evaluateResponseV2({ rule, taskId: S1, givens: S1_GIVENS, snapshot: S1_SNAPSHOT, responseItems: wrongDirection });
    assert.equal(directionResult.outcome, 'REVISE');

    // (c) diameter-as-radius trap: 3.0 (the given diameter) must be REVISE
    const radiusTrap = S1_BROWSER_RESPONSE.map((item) =>
      item.kind === 'numberWithUnit' && item.quantityId === 'radius'
        ? { kind: 'numberWithUnit' as const, quantityId: 'radius', unitId: 'cm', value: 3.0 }
        : item,
    );
    const trapResult = evaluateResponseV2({ rule, taskId: S1, givens: S1_GIVENS, snapshot: S1_SNAPSHOT, responseItems: radiusTrap });
    assert.equal(trapResult.outcome, 'REVISE');
    const trapRadius = (trapResult.feedback.quantities ?? []).find((q) => q.quantityId === 'radius');
    assert.equal(trapRadius?.valueOk, false, 'radius 3.0 cm (diameter misread) must fail');

    // (d) area rounding boundary: 84.8 (one decimal) is NOT the exact answer
    const areaBoundary = S1_BROWSER_RESPONSE.map((item) =>
      item.kind === 'numberWithUnit' && item.quantityId === 'lateral-area'
        ? { kind: 'numberWithUnit' as const, quantityId: 'lateral-area', unitId: 'cm2', value: 84.8 }
        : item,
    );
    const areaResult = evaluateResponseV2({ rule, taskId: S1, givens: S1_GIVENS, snapshot: S1_SNAPSHOT, responseItems: areaBoundary });
    assert.equal(areaResult.outcome, 'REVISE');
    const areaQuantity = (areaResult.feedback.quantities ?? []).find((q) => q.quantityId === 'lateral-area');
    assert.equal(areaQuantity?.valueOk, false, 'area 84.8 must not match the exact 84.78');

    // (e) equivalent spelling: radius 1.50 cm is the same answer as 1.5 cm
    const equivalent = S1_BROWSER_RESPONSE.map((item) =>
      item.kind === 'numberWithUnit' && item.quantityId === 'radius'
        ? { kind: 'numberWithUnit' as const, quantityId: 'radius', unitId: 'cm', value: 1.5 }
        : item,
    );
    const equivalentResult = evaluateResponseV2({ rule, taskId: S1, givens: S1_GIVENS, snapshot: S1_SNAPSHOT, responseItems: equivalent });
    assert.equal(equivalentResult.outcome, 'CORRECT');

    // (f) unroll gate stays live: no confirmed unroll → scenarioMet=false REVISE
    const noUnroll = evaluateResponseV2({ rule, taskId: S1, givens: S1_GIVENS, snapshot: mkState(15, 90, 0), responseItems: S1_BROWSER_RESPONSE });
    assert.equal(noUnroll.outcome, 'REVISE');
    assert.equal(noUnroll.feedback.scenarioMet, false);
  } finally {
    await content.close();
    await storage.close();
    storage.closeConnection();
  }
});

test('S1 radius quantityCheck is expressed in the mm base (the [1/10×radiusMm] cm-scaled assembly bug stays fixed)', async () => {
  const transfer = JSON.parse(readFileSync(join(DIST_CONTENT, L2_RELEASE, 'private', 'rules', 'rule.cylNet.transfer.v1.json'), 'utf8'));
  const radiusChecks = transfer.body.rules.flatMap(
    (r: { quantityChecks?: Array<{ quantityId: string; expected: { factors: unknown[] } }> }) =>
      (r.quantityChecks ?? []).filter((c) => c.quantityId === 'radius'),
  );
  assert.ok(radiusChecks.length > 0, 'transfer rule must declare radius quantityChecks');
  for (const check of radiusChecks) {
    const factors = check.expected.factors as Array<Record<string, unknown>>;
    const hasScaleFactor = factors.some((f) => !('factor' in f));
    assert.equal(hasScaleFactor, false, 'radius expected must be the raw mm state factor (no cm-scaling 1/10); unit conversion belongs to the unit registry');
  }
});

test('D1: three-segment composite (no areaValue asked) judges CORRECT at r=2.0 via enabled segments', async () => {
  const storage = new SqliteStorage({ file: ':memory:', now: () => 1_790_000_000_000 });
  const content = new RondoContentService({ storage, now: () => 1_790_000_000_000 });
  try {
    await content.loadRelease(DIST_CONTENT, L2_RELEASE);
    const rule = content.getRuleBodyV2(L2_RELEASE, D1);
    assert.ok(rule !== null, 'D1 v2 rule body not loaded from dist');
    assert.equal(rule.kind, 'TRANSFER_CHECK');
    const enabledSegments = content.getEnabledSegments?.(L2_RELEASE, D1);
    assert.deepEqual([...(enabledSegments ?? [])].sort(), ['directionClaims', 'edgePairing', 'paramRead'], 'D1 binding must declare its three enabled segments');

    // frozen instance cyl.net.d1.F1: given C=12.56 → r=2.0 cm (20 mm), h=5.5
    const response: StructuredResponseItem[] = [
      { kind: 'numberWithUnit', quantityId: 'radius', unitId: 'cm', value: 2.0 },
      {
        kind: 'objectMapping',
        pairs: [
          { leftId: 'net-edge-1', rightId: 'cyl-part-height-line' },
          { leftId: 'net-edge-2', rightId: 'cyl-part-upper-circle' },
          { leftId: 'net-edge-3', rightId: 'cyl-part-height-line' },
          { leftId: 'net-edge-4', rightId: 'cyl-part-lower-circle' },
        ],
      },
      {
        kind: 'objectMapping',
        pairs: [
          { leftId: 'net-edge-1', rightId: 'cyl-part-height-line' },
          { leftId: 'net-edge-2', rightId: 'cyl-part-base-circle' },
          { leftId: 'net-edge-3', rightId: 'cyl-part-height-line' },
          { leftId: 'net-edge-4', rightId: 'cyl-part-base-circle' },
        ],
      },
    ];
    const correct = evaluateResponseV2({
      rule,
      taskId: D1,
      givens: mkState(20, 55),
      snapshot: mkState(20, 55, 1000),
      responseItems: response,
      enabledSegments: enabledSegments ?? undefined,
    });
    assert.equal(
      correct.outcome,
      'CORRECT',
      `D1 three-segment answer must be CORRECT (areaValue not asked by this instance), got ${correct.outcome}: ${JSON.stringify(correct.feedback)}`,
    );
    // only the asked quantity is judged
    const quantityIds = (correct.feedback.quantities ?? []).map((q) => q.quantityId);
    assert.deepEqual(quantityIds, ['radius'], 'D1 must judge exactly the enabled paramRead quantity');

    // wrong radius (using the circumference 12.56 as radius) stays REVISE
    const wrongRadius = evaluateResponseV2({
      rule,
      taskId: D1,
      givens: mkState(20, 55),
      snapshot: mkState(20, 55, 1000),
      responseItems: response.map((item) =>
        item.kind === 'numberWithUnit' ? { ...item, value: 12.56 } : item,
      ),
      enabledSegments: enabledSegments ?? undefined,
    });
    assert.equal(wrongRadius.outcome, 'REVISE');
  } finally {
    await content.close();
    await storage.close();
    storage.closeConnection();
  }
});
