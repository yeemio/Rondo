/**
 * Content/rule parity regression for the L1 readback family (browser-found
 * defect 2026-10-27: cyl.param.g2 judged REVISE on a correct answer).
 *
 * The public response forms (resp.l1.predictDimension.v1 / resp.l1.
 * dimensionRead.v1, emitted by scripts/build-content.mjs into the registry
 * the player renders) collect ONE direction judgment — diameter for G2,
 * height for G3 — plus the numeric readback (and, for G3, the section
 * mapping). The private rule.cylParam.readback.v1 branches must expect
 * exactly that collected scope: authored intent (preparation/C/tasks
 * L1-parameters-tasks.md §3/§4) judges the readback value, not three
 * direction claims the form never asks for.
 *
 * This test rebuilds dist/content first (deterministic builder) so it never
 * asserts against a stale build product, then drives the REAL rule body
 * loaded through RondoContentService.loadRelease through the REAL evaluator
 * (evaluateResponseV2) with the exact response the browser submitted.
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
import type { ParameterIdentificationRule } from '../../modules/contracts/server/rules';

const ROOT = process.cwd();
const DIST_CONTENT = join(ROOT, 'dist', 'content');
const L1_RELEASE = 'rondo.cyl.l1-r1';
const G2 = 'cyl.param.g2.radius-change.v1';
const G3 = 'cyl.param.g3.height-section.v1';
const READBACK_RULE = 'rule.cylParam.readback.v1';

// Deterministic rebuild: judge the current builder output, never a stale dist.
const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-content.mjs')], { encoding: 'utf8' });
assert.equal(build.status, 0, `build-content failed:\n${build.stderr}`);

function mkState(radiusMm: number, heightMm: number): CylinderStateV1 {
  return { radiusMm, heightMm, unrollPermille: 0, section: 'NONE', selectedFaceIds: [] };
}

/** Teaching-example givens for both guided tasks (authored (30, 80)). */
const GIVENS = mkState(30, 80);

/** The exact response the browser submitted for G2 (fixed evidence). */
const G2_BROWSER_RESPONSE: StructuredResponseItem[] = [
  { kind: 'propertyJudgments', claims: [{ propertyId: 'diameter', direction: 'INCREASE' }] },
  { kind: 'numberWithUnit', quantityId: 'diameter', unitId: 'cm', value: 8 },
];

const G3_FULL_RESPONSE: StructuredResponseItem[] = [
  { kind: 'propertyJudgments', claims: [{ propertyId: 'height', direction: 'INCREASE' }] },
  { kind: 'numberWithUnit', quantityId: 'height', unitId: 'cm', value: 10 },
  { kind: 'objectMapping', pairs: [{ leftId: 'cyl-part-height-line', rightId: 'section-view-axial' }] },
];

interface LoadedRule {
  readonly kind: string;
  readonly rules: readonly ParameterIdentificationRule[];
}

test('G2: browser-evidence answer (diameter INCREASE + 8 cm at r=40/h=80) judges CORRECT; wrong direction still REVISE', async () => {
  const storage = new SqliteStorage({ file: ':memory:', now: () => 1_790_000_000_000 });
  const content = new RondoContentService({ storage, now: () => 1_790_000_000_000 });
  try {
    await content.loadRelease(DIST_CONTENT, L1_RELEASE);
    const rule = content.getRuleBodyV2(L1_RELEASE, G2);
    assert.ok(rule !== null, 'G2 v2 rule body not loaded from dist');
    assert.equal(rule.kind, 'NUMERIC_READBACK');

    // The confirmed scenario the browser reached: SetDimension(RADIUS, 40).
    const snapshot = mkState(40, 80);
    const correct = evaluateResponseV2({ rule, taskId: G2, givens: GIVENS, snapshot, responseItems: G2_BROWSER_RESPONSE });
    assert.equal(
      correct.outcome,
      'CORRECT',
      `browser evidence answer must be CORRECT, got ${correct.outcome}: ${JSON.stringify(correct.feedback)}`,
    );

    // Negative control: judging is still live — a wrong direction claim must
    // stay REVISE (this is the parity fix, not a loosened assertion).
    const wrongDirection = evaluateResponseV2({
      rule,
      taskId: G2,
      givens: GIVENS,
      snapshot,
      responseItems: [
        { kind: 'propertyJudgments', claims: [{ propertyId: 'diameter', direction: 'DECREASE' }] },
        { kind: 'numberWithUnit', quantityId: 'diameter', unitId: 'cm', value: 8 },
      ],
    });
    assert.equal(wrongDirection.outcome, 'REVISE');

    // Negative control: wrong numeric readback stays REVISE.
    const wrongValue = evaluateResponseV2({
      rule,
      taskId: G2,
      givens: GIVENS,
      snapshot,
      responseItems: [
        { kind: 'propertyJudgments', claims: [{ propertyId: 'diameter', direction: 'INCREASE' }] },
        { kind: 'numberWithUnit', quantityId: 'diameter', unitId: 'cm', value: 9 },
      ],
    });
    assert.equal(wrongValue.outcome, 'REVISE');

    // Authored equivalence (draft §3): 80 mm is the same answer as 8.0 cm —
    // the exact-rational compare must hold for equivalent spellings.
    const mmEquivalent = evaluateResponseV2({
      rule,
      taskId: G2,
      givens: GIVENS,
      snapshot,
      responseItems: [
        { kind: 'propertyJudgments', claims: [{ propertyId: 'diameter', direction: 'INCREASE' }] },
        { kind: 'numberWithUnit', quantityId: 'diameter', unitId: 'mm', value: 80 },
      ],
    });
    assert.equal(mmEquivalent.outcome, 'CORRECT');
  } finally {
    await content.close();
    await storage.close();
    storage.closeConnection();
  }
});

test('G3: height readback 10 cm + axial section judges CORRECT; transverse section stays REVISE', async () => {
  const storage = new SqliteStorage({ file: ':memory:', now: () => 1_790_000_000_000 });
  const content = new RondoContentService({ storage, now: () => 1_790_000_000_000 });
  try {
    await content.loadRelease(DIST_CONTENT, L1_RELEASE);
    const rule = content.getRuleBodyV2(L1_RELEASE, G3);
    assert.ok(rule !== null, 'G3 v2 rule body not loaded from dist');
    assert.equal(rule.kind, 'NUMERIC_READBACK');

    // The confirmed scenario: SetDimension(HEIGHT, 100) from (30, 80).
    const snapshot = mkState(30, 100);
    const correct = evaluateResponseV2({ rule, taskId: G3, givens: GIVENS, snapshot, responseItems: G3_FULL_RESPONSE });
    assert.equal(
      correct.outcome,
      'CORRECT',
      `G3 full answer must be CORRECT, got ${correct.outcome}: ${JSON.stringify(correct.feedback)}`,
    );

    const wrongSection = evaluateResponseV2({
      rule,
      taskId: G3,
      givens: GIVENS,
      snapshot,
      responseItems: [
        { kind: 'propertyJudgments', claims: [{ propertyId: 'height', direction: 'INCREASE' }] },
        { kind: 'numberWithUnit', quantityId: 'height', unitId: 'cm', value: 10 },
        { kind: 'objectMapping', pairs: [{ leftId: 'cyl-part-height-line', rightId: 'section-view-transverse' }] },
      ],
    });
    assert.equal(wrongSection.outcome, 'REVISE');
  } finally {
    await content.close();
    await storage.close();
    storage.closeConnection();
  }
});

test('readback rule expected scope equals the public form collection scope (G2 diameter, G3 height)', async () => {
  // Rule side: read the emitted dist rule file and select each task's branch
  // the same way the evaluator does — by confirmed-delta match.
  const ruleFile = JSON.parse(
    readFileSync(join(DIST_CONTENT, L1_RELEASE, 'private', 'rules', `${READBACK_RULE}.json`), 'utf8'),
  ) as { body: LoadedRule };
  function branchFor(from: CylinderStateV1, to: CylinderStateV1): ParameterIdentificationRule {
    const actual: Record<string, string> = {
      radius: from.radiusMm === to.radiusMm ? 'UNCHANGED' : to.radiusMm > from.radiusMm ? 'INCREASE' : 'DECREASE',
      diameter: from.radiusMm === to.radiusMm ? 'UNCHANGED' : to.radiusMm > from.radiusMm ? 'INCREASE' : 'DECREASE',
      height: from.heightMm === to.heightMm ? 'UNCHANGED' : to.heightMm > from.heightMm ? 'INCREASE' : 'DECREASE',
    };
    const match = ruleFile.body.rules.find((r) => r.expectedJudgments.every((j) => actual[j.propertyId] === j.direction));
    return match ?? ruleFile.body.rules[0];
  }
  const g2Expected = branchFor(GIVENS, mkState(40, 80)).expectedJudgments.map((j) => j.propertyId).sort();
  const g3Expected = branchFor(GIVENS, mkState(30, 100)).expectedJudgments.map((j) => j.propertyId).sort();

  // Form side: the registry the player renders its verify form from.
  const registry = JSON.parse(
    readFileSync(join(ROOT, 'content', 'cylinder', 'public', 'schemas', 'response-schemas.registry.json'), 'utf8'),
  ) as {
    schemas: Array<{
      schemaId: string;
      verify?: { items: Array<{ kind: string; properties?: string[] }> };
    }>;
  };
  function collectedProperties(schemaId: string): string[] {
    const schema = registry.schemas.find((s) => s.schemaId === schemaId);
    assert.ok(schema !== undefined, `${schemaId} missing from registry`);
    return (schema.verify?.items ?? [])
      .filter((i) => i.kind === 'propertyJudgments')
      .flatMap((i) => i.properties ?? []);
  }
  const g2Collected = collectedProperties('resp.l1.predictDimension.v1').sort();
  const g3Collected = collectedProperties('resp.l1.dimensionRead.v1').sort();

  assert.deepEqual(g2Expected, g2Collected, 'G2 rule must expect exactly the properties the public form collects');
  assert.deepEqual(g3Expected, g3Collected, 'G3 rule must expect exactly the properties the public form collects');
});
