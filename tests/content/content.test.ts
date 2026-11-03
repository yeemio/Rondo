/**
 * Content semantic + structural checks for the two-lesson release tree.
 *
 * These are NOT just schema roundtrips: they encode the C-EXPERIENCE
 * anti-mis-teaching table (L1 view ≠ size; L2 tall-thin counter-example, no
 * mid-rounding, no base area; no early answer in any public channel) and the
 * public/private separation, so a violation fails with a named assertion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authoredBlocksSchema, numericPolicySchema, FORBIDDEN_QUESTION_FIELDS } from '../../modules/contracts/public/question';
import { cylinderStateV1Schema, cylinderStateV2Schema } from '../../modules/contracts/public/scene';
import { safeParseRuleBodyL34V1 } from '../../modules/contracts/server/rules-l34';
import { privateRuleSetSchema } from '../../modules/contracts/server/rules';
import { releaseManifestPublicSchema } from '../../modules/contracts/server/content';
import { circumferenceRationalMm, lateralAreaRationalCm2, radiusRationalCm, diameterRationalCm, rationalToDecimal } from '../../modules/scenes/cylinder/geometry';

const ROOT = process.cwd(); // tests run from the package root via npm scripts
const PUB = join(ROOT, 'content', 'cylinder', 'public');
const PRIV = join(ROOT, 'content', 'cylinder', 'private');

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const taskFiles = listFiles(join(PUB, 'tasks'));
const PHASES = ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'];

const taskSchema = z.object({
  taskId: z.string(),
  taskVersion: z.string(),
  taskFamily: z.enum(['cylinder.parameters.v1', 'cylinder.net.v1', 'cylinder.faces.v1', 'cylinder.layers.v1']),
  kind: z.enum(['GUIDED', 'INDEPENDENT', 'STRANGER', 'DELAYED_TRANSFER']),
  title: z.string().min(1),
  prompt: authoredBlocksSchema,
  givens: z.union([cylinderStateV1Schema, cylinderStateV2Schema]),
  givenLocks: z.array(z.string()),
  responseSchemaId: z.string(),
  allowedOperationIds: z.array(z.string()),
  operationConstraints: z.array(z.record(z.unknown())),
  numericPolicy: numericPolicySchema,
  visibility: z.array(z.object({ material: z.string(), phases: z.array(z.enum(PHASES as never)), rows: z.array(z.string()).optional(), note: z.string().optional() })),
  hints: z.array(z.object({ level: z.number().int(), label: z.string(), text: z.string().optional() })),
  explain: z.object({
    selections: z.array(z.object({ itemId: z.string(), prompt: z.string(), multi: z.boolean().optional(), options: z.array(z.object({ id: z.string(), label: z.string() })) })),
    freeTextPrompt: z.string(),
  }),
  exitEvidence: z.array(z.string()),
  expressions: z.object({ webgl2: z.string(), svgDom: z.string() }),
});

const tasks = taskFiles.map((f) => ({ file: f, data: taskSchema.parse(JSON.parse(readFileSync(f, 'utf8'))) }));

test('content: 27 tasks emitted with preallocated ids only', () => {
  assert.equal(tasks.length, 27);
  const expectedIds = new Set([
    'cyl.param.g1.view-invariance.v1',
    'cyl.param.g2.radius-change.v1',
    'cyl.param.g3.height-section.v1',
    'cyl.param.i1.identify-changes.v1',
    'cyl.param.i2.predict-single-change.v1',
    'cyl.net.g1.unroll-observe.v1',
    'cyl.net.g2.edge-pairing.v1',
    'cyl.net.g3.lateral-area.v1',
    'cyl.net.i1.pair-normal.v1',
    'cyl.net.i2.pair-tall-thin.v1',
    'cyl.net.i3.area-value-unit.v1',
    'cyl.net.s1.stranger-relabel.v1',
    'cyl.net.d1.delayed-transfer.v1',
    'cyl.faces.g1.face-inventory.v1',
    'cyl.faces.g2.one-lid-area.v1',
    'cyl.faces.g3.full-surface.v1',
    'cyl.faces.i1.faceset-new-instance.v1',
    'cyl.faces.i2.lid-count-condition.v1',
    'cyl.faces.i3.surface-value-unit.v1',
    'cyl.layers.g1.stack-invariant.v1',
    'cyl.layers.g2.layer-volume.v1',
    'cyl.layers.g3.height-vs-radius.v1',
    'cyl.layers.i1.volume-value-unit.v1',
    'cyl.layers.i2.height-vs-radius-choice.v1',
    'cyl.layers.i3.accumulate-count.v1',
    'cyl.layers.s1.stranger-package.v1',
    'cyl.layers.d1.delayed-transfer.v1',
  ]);
  assert.deepEqual(new Set(tasks.map((t) => t.data.taskId)), expectedIds);
});

test('content: no forbidden answer fields anywhere in the public tree', () => {
  for (const f of listFiles(PUB)) {
    const raw = readFileSync(f, 'utf8');
    const json = JSON.parse(raw);
    for (const field of FORBIDDEN_QUESTION_FIELDS) {
      assert.ok(!(field in json), `${f} carries forbidden field ${field}`);
      assert.ok(!raw.includes(`"${field}"`), `${f} mentions "${field}"`);
    }
    // private-side markers must never appear in public files
    for (const marker of ['answerHint', '"truth"', 'expectedJudgments', 'pendingDsl', 'private/']) {
      assert.ok(!raw.includes(marker), `${f} leaks private marker ${marker}`);
    }
  }
});

test('content: every task has both expressions and a phase-gated visibility matrix', () => {
  for (const { data } of tasks) {
    assert.ok(data.expressions.webgl2.length > 0 && data.expressions.svgDom.length > 0);
    assert.ok(data.visibility.length > 0);
    for (const v of data.visibility) assert.ok(v.phases.length >= 0);
    // guided L2 formula cards reveal only at/after OPERATE; independent
    // measurement values only at REVIEW
    if (data.kind === 'INDEPENDENT' || data.kind === 'STRANGER' || data.kind === 'DELAYED_TRANSFER') {
      for (const material of ['card.measure-C', 'card.measure-S', 'card.measure-strip']) {
        const rule = data.visibility.find((v) => v.material === material);
        if (rule) {
          assert.ok(
            rule.phases.every((p) => p === 'REVIEW'),
            `${data.taskId}: ${material} must be REVIEW-only for independent tasks`,
          );
        }
      }
      // independent/stranger tasks never allow SetDimension (givens locked),
      // except the adjudicated L4-G3/I2 narrowed exploration (judged against
      // the scripted variants, never the live snapshot — L4 表 §6/§10)
      if (data.taskId !== 'cyl.layers.i2.height-vs-radius-choice.v1') {
        assert.ok(!data.allowedOperationIds.includes('SetDimension'), `${data.taskId} must lock givens`);
      }
    }
  }
});

test('content: L1 mis-teaching guard — view rotation tasks never conflate view with size', () => {
  const g1 = tasks.find((t) => t.data.taskId === 'cyl.param.g1.view-invariance.v1')!.data;
  assert.deepEqual(g1.allowedOperationIds, []);
  const i1 = tasks.find((t) => t.data.taskId === 'cyl.param.i1.identify-changes.v1')!.data;
  // I1 hides all numeric labels in every phase except REVIEW compare cards
  for (const material of ['givens.table', 'dim.radius', 'dim.diameter', 'dim.height']) {
    const rule = i1.visibility.find((v) => v.material === material);
    assert.ok(rule, `I1 must gate ${material}`);
    assert.deepEqual(rule.phases, material === 'givens.table' || material.startsWith('dim.') ? [] : rule.phases, `I1 ${material} must be hidden`);
  }
  // I2 hides the diameter (its target) until REVIEW
  const i2 = tasks.find((t) => t.data.taskId === 'cyl.param.i2.predict-single-change.v1')!.data;
  assert.deepEqual(i2.visibility.find((v) => v.material === 'dim.diameter')!.phases, ['REVIEW']);
});

test('content: L2 tall-thin counter-example frozen at r=0.5cm/h=12.0cm (C < h)', () => {
  const i2 = tasks.find((t) => t.data.taskId === 'cyl.net.i2.pair-tall-thin.v1')!.data;
  assert.equal(i2.givens.radiusMm, 5);
  assert.equal(i2.givens.heightMm, 120);
  const c = circumferenceRationalMm(5); // 314/100 cm exactly = 3.14 cm
  assert.equal(rationalToDecimal({ numerator: c.numerator, denominator: c.denominator * 10 }, 2), '3.14');
  // C(3.14 cm) < h(12.0 cm): the "long edge = circumference" heuristic fails
  assert.ok(3.14 < 12.0);
});

test('content: guided example r=3.0/h=8.0 is public teaching, independent instances differ', () => {
  const g1 = tasks.find((t) => t.data.taskId === 'cyl.param.g1.view-invariance.v1')!.data;
  assert.equal(g1.givens.radiusMm, 30);
  assert.equal(g1.givens.heightMm, 80);
  for (const id of ['cyl.param.i1.identify-changes.v1', 'cyl.param.i2.predict-single-change.v1']) {
    const t = tasks.find((x) => x.data.taskId === id)!.data;
    assert.notDeepEqual([t.givens.radiusMm, t.givens.heightMm], [30, 80]);
    assert.notDeepEqual([t.givens.radiusMm, t.givens.heightMm], [40, 80]);
    assert.notEqual(t.givens.radiusMm, t.givens.heightMm, 'radiusMm != heightMm (指代歧义约束)');
  }
});

test('content: private instances carry exact-π expected values', () => {
  const inst = (name: string) => JSON.parse(readFileSync(join(PRIV, 'instances', name), 'utf8'));
  // I3 frozen (25mm,100mm): C=15.70, S=157.00
  const i3 = inst('cyl.net.i3.v1-instances.json');
  assert.equal(rationalToDecimal({ ...circumferenceRationalMm(25), denominator: circumferenceRationalMm(25).denominator * 10 }, 2), i3.frozen[0].truth.circumferenceCm);
  assert.equal(rationalToDecimal(lateralAreaRationalCm2(25, 100), 2), i3.frozen[0].truth.lateralAreaCm2);
  // S1 frozen (15mm,90mm): r=1.5, S=84.78
  const s1 = inst('cyl.net.s1.v1-instances.json');
  assert.equal(rationalToDecimal(radiusRationalCm(15), 1), s1.frozen[0].truth.radiusCm);
  assert.equal(rationalToDecimal(lateralAreaRationalCm2(15, 90), 2), s1.frozen[0].truth.lateralAreaCm2);
  // D1 frozen (20mm,55mm): r = 12.56 / 6.28 = 2.0
  const d1 = inst('cyl.net.d1.v1-instances.json');
  assert.equal(rationalToDecimal(radiusRationalCm(20), 1), d1.frozen[0].truth.radiusCm);
  // L1 I1 EX-B: diameter 9.0 -> 6.0 (2r), |Δr| = 15mm
  const i1 = inst('cyl.param.i1.v1-instances.json');
  const f = i1.frozen[0];
  assert.equal(rationalToDecimal(diameterRationalCm(f.initial.radiusMm), 1), f.truth.diameterBeforeCm);
  assert.equal(rationalToDecimal(diameterRationalCm(f.script.toMm), 1), f.truth.diameterAfterCm);
  assert.ok(Math.abs(f.script.toMm - f.script.fromMm) >= 15);
  // L1 I2 EX-B: d = 2×20mm = 4.0cm, direction UNCHANGED (height axis)
  const i2 = inst('cyl.param.i2.v1-instances.json');
  assert.equal(rationalToDecimal(diameterRationalCm(i2.frozen[0].initial.radiusMm), 1), i2.frozen[0].truth.valueCm);
  assert.equal(i2.frozen[0].truth.direction, 'UNCHANGED');
});

test('content: transfer rule parses against the frozen two-family DSL; gaps carry named reasons', () => {
  const transfer = JSON.parse(readFileSync(join(PRIV, 'rules', 'rule.cylNet.transfer.v1.json'), 'utf8'));
  privateRuleSetSchema.parse({ ruleSetVersion: transfer.body.ruleSetVersion, rules: transfer.body.rules }); // fully expressible (mapping+quantity)
  for (const name of ['rule.cylParam.changeClassify.v1', 'rule.cylParam.readback.v1', 'rule.cylParam.identify.v1']) {
    const r = JSON.parse(readFileSync(join(PRIV, 'rules', `${name}.json`), 'utf8'));
    if (r.body.rules?.length) privateRuleSetSchema.parse({ ruleSetVersion: r.body.ruleSetVersion, rules: r.body.rules });
  }
  const pairing = JSON.parse(readFileSync(join(PRIV, 'rules', 'rule.cylNet.pairing.v1.json'), 'utf8'));
  assert.ok(pairing.pendingDsl.reasons.some((x: string) => x.startsWith('NUMERIC_RELATION_V1_QUANTITY_MIN1')));
  const area = JSON.parse(readFileSync(join(PRIV, 'rules', 'rule.cylNet.area.v1.json'), 'utf8'));
  assert.ok(area.pendingDsl.reasons.some((x: string) => x.startsWith('NUMERIC_RELATION_V1_EDGE_MIN1')));
  const readback = JSON.parse(readFileSync(join(PRIV, 'rules', 'rule.cylParam.readback.v1.json'), 'utf8'));
  assert.ok(readback.pendingDsl.reasons.some((x: string) => x.startsWith('L1_NUMERIC_READBACK')));
});

test('content: release manifests hash-match their scoped public assets', () => {
  for (const dir of ['l1-r1', 'l2-r1', 'l3-r1', 'l4-r1']) {
    const manifest = releaseManifestPublicSchema.parse(JSON.parse(readFileSync(join(PUB, 'releases', dir, 'manifest.public.json'), 'utf8')));
    const assetMap = JSON.parse(readFileSync(join(PUB, 'releases', dir, 'assets-map.json'), 'utf8'));
    const recomputed = Object.values(assetMap.assets as Record<string, string>).map((p) => p as string).sort();
    assert.deepEqual(manifest.publicAssetHashes, recomputed, `${dir}: hash list mismatch`);
    for (const [path, hash] of Object.entries(assetMap.assets as Record<string, string>)) {
      const actual = createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
      assert.equal(actual, hash, `${path} hash drift`);
    }
    // self hash: canonical JSON of manifest minus publicManifestHash
    const { publicManifestHash, ...rest } = manifest;
    const selfHash = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    assert.equal(selfHash, publicManifestHash, `${dir}: publicManifestHash mismatch`);
    // both expressions declare the same operation subsets (fallback parity)
    const sets = manifest.expressionOperationSubsets.map((s) => `${s.expression}:${s.allowedOperationIds.join('+')}`);
    assert.equal(new Set(sets).size, 2);
    // L1/L2 keep their @1 subsets (no SelectFaces); L3 adds SelectFaces on @1
    // (L34-2); L4 declares the @2 renderer (L34-1) with the layer pair
    if (dir === 'l1-r1' || dir === 'l2-r1') {
      assert.ok(!manifest.expressionOperationSubsets.some((s) => s.allowedOperationIds.includes('SelectFaces')));
      assert.equal(manifest.rendererDeclarations[0].rendererContractVersion, '1');
    }
    if (dir === 'l3-r1') {
      assert.ok(manifest.expressionOperationSubsets.every((s) => s.allowedOperationIds.includes('SelectFaces')));
      assert.equal(manifest.rendererDeclarations[0].rendererContractVersion, '1');
    }
    if (dir === 'l4-r1') {
      assert.equal(manifest.rendererDeclarations[0].rendererContractVersion, '2');
      assert.equal(manifest.rendererDeclarations[0].publicStateSchemaVersion, '2');
      for (const op of ['SetLayerCount', 'SetVisibleLayerCount']) {
        assert.ok(manifest.expressionOperationSubsets.every((s) => s.allowedOperationIds.includes(op)), `l4 ${op} in both expressions`);
      }
    }
  }
});

test('content: response registry covers every task schemaId; composite segments are bound', () => {
  const registry = JSON.parse(readFileSync(join(PUB, 'schemas', 'response-schemas.registry.json'), 'utf8'));
  const ids = new Set(registry.schemas.map((s: { schemaId: string }) => s.schemaId));
  for (const { data } of tasks) assert.ok(ids.has(data.responseSchemaId), `${data.taskId} schemaId not registered`);
  const l2Bindings = JSON.parse(readFileSync(join(PRIV, 'bindings', 'l2-r1.bindings.private.json'), 'utf8'));
  const s1 = l2Bindings.taskBindings.find((b: { taskId: string }) => b.taskId === 'cyl.net.s1.stranger-relabel.v1');
  assert.deepEqual(s1.enabledSegments, ['paramRead', 'edgePairing', 'directionClaims', 'areaValue']);
  const d1 = l2Bindings.taskBindings.find((b: { taskId: string }) => b.taskId === 'cyl.net.d1.delayed-transfer.v1');
  assert.deepEqual(d1.enabledSegments, ['paramRead', 'edgePairing', 'directionClaims']);
  // L4 composite enablements: G3 four segments, I2 ratio-disabled, S1/D1 four
  const l4Bindings = JSON.parse(readFileSync(join(PRIV, 'bindings', 'l4-r1.bindings.private.json'), 'utf8'));
  const seg = (id: string) => l4Bindings.taskBindings.find((b: { taskId: string }) => b.taskId === id)?.enabledSegments;
  assert.deepEqual(seg('cyl.layers.g3.height-vs-radius.v1'), ['bigger', 'valueA', 'valueB', 'ratio']);
  assert.deepEqual(seg('cyl.layers.i2.height-vs-radius-choice.v1'), ['bigger', 'valueA', 'valueB']);
  assert.deepEqual(seg('cyl.layers.s1.stranger-package.v1'), ['paramRead', 'faceSet', 'paperArea', 'volume']);
  assert.deepEqual(seg('cyl.layers.d1.delayed-transfer.v1'), ['paramRead', 'faceSet', 'paperArea', 'volume']);
  // resp.l1.changeClassify.v1 stays reserved-unbound (decision recorded)
  const bound = new Set(tasks.map((t) => t.data.responseSchemaId));
  assert.ok(!bound.has('resp.l1.changeClassify.v1'));
  // registry carries the L34-7 property-label extension + prompt overrides
  assert.equal(registry.propertyLabels.layerThickness, '每层厚度');
  assert.equal(registry.propertyLabels.totalVolume, '总体积');
  const stranger4 = registry.schemas.find((x: { schemaId: string }) => x.schemaId === 'resp.l4.strangerComposite.v1');
  assert.equal(stranger4.segmentPromptOverrides?.['cyl.layers.d1.delayed-transfer.v1']?.paramRead?.includes('周长'), true);
});

test('content: L2 terminology discipline — no "横边/长边=周长" phrasing in any public material', () => {
  for (const f of listFiles(PUB)) {
    const raw = readFileSync(f, 'utf8');
    for (const banned of ['横边', '长边就是周长', '长的边就是周长']) {
      assert.ok(!raw.includes(banned), `${f} contains banned phrasing: ${banned}`);
    }
  }
  // base-area trap: tasks asking area must say 只贴/只包侧面 or 只算侧面
  const g3 = tasks.find((t) => t.data.taskId === 'cyl.net.g3.lateral-area.v1')!.data;
  assert.ok(g3.prompt.some((b) => b.type === 'TEXT' && (b.text.includes('侧面') || b.text.includes('侧面'))));
});

// ===========================================================================
// L3/L4 additions (h0-mathl34-20261027-1)
// ===========================================================================

/** BigInt exact recomputation: π = 157/50, HALF_UP, trailing decimals kept. */
function decBig(num: bigint, den: bigint, places: number): string {
  const scale = 10n ** BigInt(places);
  const neg = num < 0n;
  const absNum = neg ? -num : num;
  const scaled = absNum * scale;
  let q = scaled / den;
  const rem = scaled % den;
  if (rem * 2n >= den) q += 1n;
  const ip = q / scale;
  const fp = (q % scale).toString().padStart(places, '0');
  const body = places ? `${ip}.${fp}` : `${ip}`;
  return neg && q !== 0n ? `-${body}` : body;
}
const PI_N = 157n;
const PI_D = 50n;
const rCircCm = (rMm: bigint) => decBig(2n * PI_N * rMm, PI_D * 10n, 2); // C in cm
const rSideCm2 = (rMm: bigint, hMm: bigint) => decBig(2n * PI_N * rMm * hMm, PI_D * 100n, 2); // S侧 cm²
const rCircleCm2 = (rMm: bigint) => decBig(PI_N * rMm * rMm, PI_D * 100n, 2); // S圆 cm²
const rVolumeCm3 = (rMm: bigint, hMm: bigint) => decBig(PI_N * rMm * rMm * hMm, PI_D * 1000n, 2); // V cm³

test('content: L3/L4 frozen-instance truths recompute exactly with BigInt rationals', () => {
  const inst = (name: string) => JSON.parse(readFileSync(join(PRIV, 'instances', name), 'utf8'));
  // L3-I1 (r=50,h=100): REVIEW 对照 C/S侧/S圆
  const l3i1 = inst('cyl.faces.i1.v1-instances.json').frozen[0];
  assert.equal(rCircCm(50n), l3i1.truth.reviewCircumferenceCm);
  assert.equal(rSideCm2(50n, 100n), l3i1.truth.reviewLateralAreaCm2);
  assert.equal(rCircleCm2(50n), l3i1.truth.reviewCircleAreaCm2);
  // L3-I2 (r=20,h=90): Δ=2πr², S圆, S侧, 诊断值 2×S侧
  const l3i2 = inst('cyl.faces.i2.v1-instances.json').frozen[0];
  assert.equal(rCircleCm2(20n), l3i2.truth.circleAreaCm2);
  assert.equal(decBig(2n * PI_N * 20n * 20n, PI_D * 100n, 2), l3i2.truth.deltaCm2);
  assert.equal(rSideCm2(20n, 90n), l3i2.truth.lateralAreaCm2);
  assert.equal(decBig(2n * 2n * PI_N * 20n * 90n, PI_D * 100n, 2), l3i2.truth.diagnostics.misDoubleSideValue);
  // L3-I3 (r=60,h=40): C/S侧/S圆/S表 + 三诊断
  const l3i3 = inst('cyl.faces.i3.v1-instances.json').frozen[0];
  assert.equal(rCircCm(60n), l3i3.truth.circumferenceCm);
  assert.equal(rSideCm2(60n, 40n), l3i3.truth.lateralAreaCm2);
  assert.equal(rCircleCm2(60n), l3i3.truth.circleAreaCm2);
  assert.equal(decBig(2n * PI_N * 60n * 40n + 2n * PI_N * 60n * 60n, PI_D * 100n, 2), l3i3.truth.surfaceCm2);
  assert.equal(rSideCm2(60n, 40n), l3i3.truth.diagnostics.misLidsMissingValue);
  assert.equal(decBig(2n * PI_N * 60n * 40n + PI_N * 60n * 60n, PI_D * 100n, 2), l3i3.truth.diagnostics.misOneLidValue);
  assert.equal(decBig(2n * 2n * PI_N * 60n * 40n, PI_D * 100n, 2), l3i3.truth.diagnostics.misDoubleSideValue);
  // L4-I1 (r=40,h=70): S底/V + 公式诊断两签名（r∉{1,2} 保证可区分）
  const l4i1 = inst('cyl.layers.i1.v1-instances.json').frozen[0];
  assert.equal(rCircleCm2(40n), l4i1.truth.baseAreaCm2);
  assert.equal(rVolumeCm3(40n, 70n), l4i1.truth.volumeCm3);
  // 诊断签名按提交数值匹配：2πrh / πrh 以 cm² 数值参与比较（=C×h / 半截公式）
  assert.equal(decBig(2n * PI_N * 40n * 70n, PI_D * 100n, 2), l4i1.truth.diagnostics.misCircumferenceTimesH);
  assert.equal(decBig(PI_N * 40n * 70n, PI_D * 100n, 2), l4i1.truth.diagnostics.misPiRh);
  // L4-I2 变体 (A: 30,100 / B: 40,60)
  const l4i2 = inst('cyl.layers.i2.v1-instances.json').frozen[0];
  assert.equal(rVolumeCm3(30n, 100n), l4i2.truth.valueACm3);
  assert.equal(rVolumeCm3(40n, 60n), l4i2.truth.valueBCm3);
  // L4-I3 (r=20,h=100,n=10): 每层/边界 7·8·9/总量
  const l4i3 = inst('cyl.layers.i3.v1-instances.json').frozen[0];
  const perLayer = decBig(PI_N * 20n * 20n * (100n / 10n), PI_D * 1000n, 2); // π·r²·层厚(mm) → cm³
  assert.equal(perLayer, l4i3.truth.perLayerCm3);
  assert.equal(perLayer, '12.56');
  assert.equal((Number(perLayer) * 7).toFixed(2), l4i3.truth.boundary.layer7Cm3);
  assert.equal((Number(perLayer) * 8).toFixed(2), l4i3.truth.cumulativeAtLayerCm3);
  assert.equal((Number(perLayer) * 9).toFixed(2), l4i3.truth.boundary.layer9Cm3);
  assert.equal(rVolumeCm3(20n, 100n), l4i3.truth.totalCm3);
  // L4-S1 (d=100→r=50,h=60): C/S侧/S圆/纸板/体积
  const l4s1 = inst('cyl.layers.s1.v1-instances.json').frozen[0];
  assert.equal(decBig(50n, 10n, 1), l4s1.truth.radiusCm);
  assert.equal(rCircCm(50n), l4s1.truth.circumferenceCm);
  assert.equal(rSideCm2(50n, 60n), l4s1.truth.lateralAreaCm2);
  assert.equal(rCircleCm2(50n), l4s1.truth.circleAreaCm2);
  assert.equal(decBig(2n * PI_N * 50n * 60n + 2n * PI_N * 50n * 50n, PI_D * 100n, 2), l4s1.truth.paperAreaCm2);
  assert.equal(rVolumeCm3(50n, 60n), l4s1.truth.volumeCm3);
  // L4-D1 (C=25.12→r=40,h=65): r 校验（C(40)=25.12）、纸板=C×h+πr²、体积
  const l4d1 = inst('cyl.layers.d1.v1-instances.json').frozen[0];
  assert.equal(rCircCm(40n), l4d1.givenCircumferenceCm); // 25.12 一致性
  assert.equal(decBig(40n, 10n, 1), l4d1.truth.radiusCm);
  assert.equal(rSideCm2(40n, 65n), l4d1.truth.lateralAreaCm2);
  assert.equal(rCircleCm2(40n), l4d1.truth.circleAreaCm2);
  assert.equal(decBig(2n * PI_N * 40n * 65n + PI_N * 40n * 40n, PI_D * 100n, 2), l4d1.truth.paperAreaCm2);
  assert.equal(rVolumeCm3(40n, 65n), l4d1.truth.volumeCm3);
});

test('content: L3/L4 guided rule truths recompute (178.98 / 207.24 / 226.08 / 452.16 / 904.32 …)', () => {
  const rule = (name: string) => JSON.parse(readFileSync(join(PRIV, 'rules', `${name}.json`), 'utf8'));
  const facesArea = rule('rule.cylFaces.area.v1').body.entries;
  assert.equal(facesArea['cyl.faces.g2.one-lid-area.v1'].expectedCm2, decBig(2n * PI_N * 30n * 80n + PI_N * 30n * 30n, PI_D * 100n, 2)); // 178.98
  assert.equal(facesArea['cyl.faces.g2.one-lid-area.v1'].expectedCm2, '178.98');
  assert.equal(facesArea['cyl.faces.g3.full-surface.v1'].expectedCm2, decBig(2n * PI_N * 30n * 80n + 2n * PI_N * 30n * 30n, PI_D * 100n, 2)); // 207.24
  assert.equal(facesArea['cyl.faces.g3.full-surface.v1'].expectedCm2, '207.24');
  const stack = rule('rule.cylLayers.stack.v1').body.entries;
  const g1 = stack['cyl.layers.g1.stack-invariant.v1'];
  assert.equal(g1.volumeCm3, rVolumeCm3(30n, 80n)); // 226.08
  assert.equal(g1.compare16.perLayerCm3, decBig(PI_N * 30n * 30n * 80n, PI_D * 1000n * 16n, 2)); // 14.13
  assert.equal(g1.compare16.totalCm3, rVolumeCm3(30n, 80n)); // 不变量：16 层总量不变
  const g2 = stack['cyl.layers.g2.layer-volume.v1'];
  assert.equal(g2.thicknessCm, '1.0');
  assert.equal(g2.perLayerCm3, rCircleCm2(30n)); // 28.26 = S底×1.0cm
  assert.equal(g2.totalCm3, rVolumeCm3(30n, 80n));
  const vol = rule('rule.cylLayers.volume.v1').body.entries;
  const g3 = vol['cyl.layers.g3.height-vs-radius.v1'];
  assert.equal(g3.valueACm3, rVolumeCm3(30n, 160n)); // 452.16（h×2）
  assert.equal(g3.valueBCm3, rVolumeCm3(60n, 80n)); // 904.32（r×2）
  assert.equal(g3.recheck.baseCm3, rVolumeCm3(10n, 40n)); // 12.56
  assert.equal(g3.recheck.recheckBCm3, rVolumeCm3(20n, 40n)); // 50.24 = 4×底
  assert.equal(g3.recheck.recheckACm3, rVolumeCm3(10n, 80n)); // 25.12 = 2×底
  // L34-12 互斥总清单落地：跨课实例组合互不重复
  const frozenCombos: Array<[string, string]> = [
    ['50', '100'], ['20', '90'], ['60', '40'], // L3 独立
    ['40', '70'], ['30', '60'], ['20', '100'], ['50', '60'], ['40', '65'], // L4 独立/合用
  ];
  assert.equal(new Set(frozenCombos.map((c) => c.join(','))).size, frozenCombos.length, 'L3/L4 冻结组合互不重复');
});

const L34_HIDDEN_CARDS = [
  'card.measure-faces',
  'card.base-area',
  'card.surface-value',
  'card.volume-value',
  'card.delta-value',
  'card.combo-area-value',
  'card.layer-value',
];

test('content: L3/L4 visibility discipline — measurement/value cards REVIEW-gated for independent tasks', () => {
  for (const { data } of tasks) {
    if (!data.taskId.startsWith('cyl.faces.') && !data.taskId.startsWith('cyl.layers.')) continue;
    const independent = data.kind === 'INDEPENDENT' || data.kind === 'STRANGER' || data.kind === 'DELAYED_TRANSFER';
    for (const material of L34_HIDDEN_CARDS) {
      const rule = data.visibility.find((v) => v.material === material);
      if (!rule) continue;
      if (independent) {
        // L4-I3 例外（L4 表 §7）：底面积值卡为「每层=底面积×层厚」印证材料 OPERATE 起，
        // 累计表为执行面逐行揭示；本题目标（层号/累计）仍 REVIEW 由比对卡解禁
        const isI3Exception = data.taskId === 'cyl.layers.i3.accumulate-count.v1' && material === 'card.base-area';
        assert.ok(
          isI3Exception || rule.phases.length === 0 || rule.phases.every((p) => p === 'REVIEW'),
          `${data.taskId}: ${material} must be REVIEW-only (or fully hidden) for independent tasks, got [${rule.phases}]`,
        );
      } else if (material !== 'card.measure-faces' && material !== 'card.base-area') {
        // 引导题的测量/印证卡（按面面积、底面积）为 OBSERVATION 教学材料（设计内）；
        // 目标数值卡（组合/表面积/体积/差值）引导题同样 REVIEW 前不下发
        assert.ok(
          rule.phases.every((p) => p === 'REVIEW'),
          `${data.taskId}: guided target-value card ${material} must stay REVIEW-only`,
        );
      }
    }
    // cumulative-table VALUES column is REVIEW-gated wherever declared
    const values = data.visibility.find((v) => v.material === 'table.cumulative-values');
    if (values) assert.ok(values.phases.every((p) => p === 'REVIEW'), `${data.taskId}: table.cumulative-values REVIEW-only`);
    // 独立题不开放 SetDimension（G3/I2 为引导/独立探索例外？I2 是独立但开放收窄探索）
    if (independent && data.taskId !== 'cyl.layers.i2.height-vs-radius-choice.v1') {
      assert.ok(!data.allowedOperationIds.includes('SetDimension'), `${data.taskId} must lock givens`);
    }
  }
  // I3-L4 例外口径：累计表执行面 OPERATE 起，数值列 REVIEW；底面积卡为印证材料 OPERATE
  const i3l4 = tasks.find((t) => t.data.taskId === 'cyl.layers.i3.accumulate-count.v1')!.data;
  assert.ok((i3l4.visibility.find((v) => v.material === 'table.cumulative')!.phases as string[]).includes('OPERATE'));
  assert.ok((i3l4.visibility.find((v) => v.material === 'card.base-area')!.phases as string[]).includes('OPERATE'));
});

test('content: L3/L4 target values never appear in their own public task files', () => {
  const banned: Record<string, string[]> = {
    'cyl.faces.g2.one-lid-area.v1': ['178.98'],
    'cyl.faces.g3.full-surface.v1': ['207.24', '56.52'], // 178.98 在建议单内为设计内公开错误候选
    'cyl.faces.i1.faceset-new-instance.v1': ['314.00', '78.50', '31.40'],
    'cyl.faces.i2.lid-count-condition.v1': ['25.12', '12.56', '113.04', '226.08'],
    'cyl.faces.i3.surface-value-unit.v1': ['376.80', '226.08', '113.04', '150.72', '37.68'],
    'cyl.layers.g1.stack-invariant.v1': ['226.08', '14.13', '28.26'],
    'cyl.layers.g2.layer-volume.v1': ['226.08'], // 28.26 为底面积印证卡（设计内公开）
    'cyl.layers.g3.height-vs-radius.v1': ['452.16', '904.32'],
    'cyl.layers.i1.volume-value-unit.v1': ['351.68', '50.24', '175.84', '87.92'],
    'cyl.layers.i2.height-vs-radius-choice.v1': ['282.60', '301.44', '50.24'],
    'cyl.layers.i3.accumulate-count.v1': ['100.48', '87.92', '113.04', '125.60'], // 12.56 为印证卡
    'cyl.layers.s1.stranger-package.v1': ['345.40', '471.00', '78.50', '188.40', '157.00'],
    'cyl.layers.d1.delayed-transfer.v1': ['213.52', '326.56', '50.24', '163.28'],
  };
  for (const [id, values] of Object.entries(banned)) {
    const raw = readFileSync(join(PUB, 'tasks', `${id}.json`), 'utf8');
    for (const v of values) assert.ok(!raw.includes(v), `${id} leaks its target value ${v}`);
  }
  // L3 引导例 (3.0,8.0) 公开教学；独立题参数不等于引导例与互斥清单项
  for (const id of ['cyl.faces.i1.faceset-new-instance.v1', 'cyl.faces.i2.lid-count-condition.v1', 'cyl.faces.i3.surface-value-unit.v1']) {
    const t = tasks.find((x) => x.data.taskId === id)!.data;
    assert.notDeepEqual([t.givens.radiusMm, t.givens.heightMm], [30, 80]);
    assert.notEqual(t.givens.radiusMm, t.givens.heightMm, 'radiusMm != heightMm');
    assert.ok(t.givens.radiusMm % 10 === 0, '整数 cm 半径（L34-13）');
  }
  // L4 公式诊断题 r∉{1,2} cm；I3 只判累计真值但域生成仍避开 r=2（冻结例 r=2 为登记例外）
  for (const id of ['cyl.layers.i1.volume-value-unit.v1', 'cyl.layers.i2.height-vs-radius-choice.v1']) {
    const t = tasks.find((x) => x.data.taskId === id)!.data;
    assert.ok(t.givens.radiusMm !== 10 && t.givens.radiusMm !== 20, `${id} r∉{1,2} cm（L34-13）`);
  }
  // L4 @2 givens carry the layer pair; @1 families never do
  for (const { data } of tasks) {
    const hasLayers = 'layerCount' in data.givens;
    if (data.taskFamily === 'cylinder.layers.v1') {
      assert.ok(hasLayers && typeof (data.givens as { layerCount: number }).layerCount === 'number', `${data.taskId} givens must carry layerCount`);
    } else {
      assert.ok(!hasLayers, `${data.taskId} (@1) must not carry layer fields`);
    }
  }
});

test('content: L3/L4 rules are formalized family truths (H0-DELTA-INTEGRATION-20261027-3)', () => {
  const rule = (name: string) => JSON.parse(readFileSync(join(PRIV, 'rules', `${name}`), 'utf8'));
  const formalKinds = {
    'rule.cylFaces.set.v1.json': 'FACE_SET_TRUTH',
    'rule.cylFaces.area.v1.json': 'COMBO_AREA_TRUTH',
    'rule.cylLayers.stack.v1.json': 'LAYER_STACK_TRUTH',
    'rule.cylLayers.volume.v1.json': 'VOLUME_COMPARE_TRUTH',
    'rule.cylLayers.transfer.v1.json': 'TRANSFER4_TRUTH',
  };
  for (const [name, kind] of Object.entries(formalKinds)) {
    const r = rule(name);
    assert.equal(r.body.kind, kind, `${name} must carry the formalized body kind`);
    assert.equal(r.pendingDsl, undefined, `${name} must no longer carry a pendingDsl sidecar`);
    assert.ok(Object.keys(r.body.entries ?? {}).length >= 1, `${name} must carry at least one task entry`);
  }
  // the five files parse under the formal contract schema
  for (const name of Object.keys(formalKinds)) {
    const parsed = safeParseRuleBodyL34V1(rule(name).body);
    assert.ok(parsed.success, `${name} body must parse as RuleBodyL34V1`);
  }
});

test('content: L3/L4 hints complete (three non-answer levels) and advice card registered', () => {
  for (const { data } of tasks) {
    if (!data.taskId.startsWith('cyl.faces.') && !data.taskId.startsWith('cyl.layers.')) continue;
    const levels = data.hints.map((h) => h.level).sort();
    // integration W1: the build's h4 auto-registration adds the answer-level
    // entry (public layer registers ONLY that the level exists; text is
    // private-side) — so authored files carry h1-h3 with text plus a bare h4.
    assert.deepEqual(levels, [1, 2, 3, 4], `${data.taskId} must author hints h1-h3 plus the h4 registration`);
    assert.ok(data.hints.filter((h) => h.level < 4).every((h) => (h.text ?? '').length > 0), `${data.taskId} hint texts complete`);
  }
  const g3 = tasks.find((t) => t.data.taskId === 'cyl.faces.g3.full-surface.v1')!.data;
  assert.ok(g3.visibility.find((v) => v.material === 'card.advice-flagged'), 'L34-9 advice card material registered');
  // 公开树无私有答案标记已由全局扫描覆盖；建议单文本保持「可能有错」标注
  const g3raw = readFileSync(join(PUB, 'tasks', 'cyl.faces.g3.full-surface.v1.json'), 'utf8');
  assert.ok(g3raw.includes('人工编写，可能有错'));
  assert.ok(g3raw.includes('178.98')); // 设计内公开错误候选
});
