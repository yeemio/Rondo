/**
 * GRID_TASK_TRUTH judge coverage: one positive + one negative per task family
 * plus the misconception boundaries the Owner named — 等值分数的有理数精确
 * 比较、百分数两位小数口径、折扣顺序边界、半径直径不加倍/重复加倍、
 * 百分数当整数、等值缩放只缩分子/分母、按比例分配对半分/乘总数误解。
 * All expected values are hand-recomputed independently of the content tree.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeGridTask } from '../../modules/scenes/gridboard/judge';
import { getThemesRuleEntry } from '../../modules/mock-client/contentLoaderThemes';
import type { GridBoardStateV1 } from '../../modules/contracts/public/scene-gridboard';
import type { CylinderStateV1 } from '../../modules/contracts/public/scene';
import type { StructuredResponseItem } from '../../modules/contracts/public/envelope';

const grid = (rows: number, cols: number, filled = 0): GridBoardStateV1 => ({ rows, cols, filled });
const cyl = (radiusMm: number): CylinderStateV1 => ({ radiusMm, heightMm: 10, unrollPermille: 0, section: 'NONE', selectedFaceIds: [] });

const num = (quantityId: string, value: number, unitId: string) => ({ kind: 'numberWithUnit' as const, quantityId, value, unitId });
const frac = (quantityId: string, numerator: number, denominator: number) => ({ kind: 'fractionValue' as const, quantityId, numerator, denominator });
const choice = (selectionId: string, optionId: string) => ({ kind: 'singleChoice' as const, selectionId, optionId });
const mapItem = (pairs: Array<[string, string]>) => ({ kind: 'objectMapping' as const, pairs: pairs.map(([leftId, rightId]) => ({ leftId, rightId })) });

function judge(taskId: string, snapshot: GridBoardStateV1 | CylinderStateV1, response: StructuredResponseItem[]) {
  const { entry } = getThemesRuleEntry(taskId);
  return judgeGridTask({ taskId, entry, snapshot, responseItems: response });
}

// ===== 微课① 半径与直径 =====================================================

test('judge m1.diag: positive (含 mm 等价书写) / negative + r/d 误解', () => {
  const ok = judge('thm.m1.diag.v1', cyl(25), [
    num('diameter-from-r', 5.0, 'cm'),
    num('radius-from-d', 60, 'mm'), // 60 mm = 6.0 cm 等价书写
    choice('sel.relation', 'opt-d-eq-2r'),
    choice('sel.direction', 'INCREASE'),
  ]);
  assert.equal(ok.verdict, 'CORRECT');
  assert.equal(ok.scenarioMet, true);

  const misNoDouble = judge('thm.m1.diag.v1', cyl(25), [
    num('diameter-from-r', 2.5, 'cm'), // 没乘 2
    num('radius-from-d', 6.0, 'cm'),
    choice('sel.relation', 'opt-d-eq-2r'),
    choice('sel.direction', 'INCREASE'),
  ]);
  assert.equal(misNoDouble.verdict, 'REVISE');
  assert.ok(misNoDouble.diagnostics.includes('mis-rd-no-double'));

  const misNoHalving = judge('thm.m1.diag.v1', cyl(25), [
    num('diameter-from-r', 5.0, 'cm'),
    num('radius-from-d', 12.0, 'cm'), // 没除 2
    choice('sel.relation', 'opt-d-eq-2r'),
    choice('sel.direction', 'INCREASE'),
  ]);
  assert.equal(misNoHalving.verdict, 'REVISE');
  assert.ok(misNoHalving.diagnostics.includes('mis-rd-no-halving'));
});

test('judge m1.supp: scenario gate + state-derived diameter', () => {
  // 未操作到位（半径还是 30mm）：场景不满足 → REVISE 且 scenario 行在前
  const gate = judge('thm.m1.supp.v1', cyl(30), [num('diameter-now', 7.0, 'cm'), num('radius-target', 6.0, 'cm')]);
  assert.equal(gate.verdict, 'REVISE');
  assert.equal(gate.scenarioMet, false);
  assert.equal(gate.itemResults[0].key, 'scenario');

  const ok = judge('thm.m1.supp.v1', cyl(35), [num('diameter-now', 7.0, 'cm'), num('radius-target', 6.0, 'cm')]);
  assert.equal(ok.verdict, 'CORRECT');

  const wrong = judge('thm.m1.supp.v1', cyl(35), [num('diameter-now', 3.5, 'cm'), num('radius-target', 6.0, 'cm')]);
  assert.equal(wrong.verdict, 'REVISE');
  assert.ok(wrong.diagnostics.includes('mis-rd-no-double'));
});

// ===== 微课② 面积与单位 =====================================================

test('judge m2.diag: positive（dm² 等价）/ 周长误解 / 面积换算', () => {
  const ok = judge('thm.m2.diag.v1', grid(3, 5), [
    num('rect-area', 1500, 'mm2'), // 15 cm² = 1500 mm² 等价书写
    choice('sel.square-unit', 'opt-1-cm2'),
    choice('sel.why-square', 'opt-length-times-length'),
    num('dm2-to-cm2', 100, 'cm2'),
  ]);
  assert.equal(ok.verdict, 'CORRECT');

  const misPerimeter = judge('thm.m2.diag.v1', grid(3, 5), [
    num('rect-area', 16, 'cm2'), // (5+3)×2 周长当面积
    choice('sel.square-unit', 'opt-1-cm2'),
    choice('sel.why-square', 'opt-length-times-length'),
    num('dm2-to-cm2', 100, 'cm2'),
  ]);
  assert.equal(misPerimeter.verdict, 'REVISE');
  assert.ok(misPerimeter.diagnostics.includes('mis-perimeter-for-area'));
});

test('judge m2.supp: dm²↔cm² 双向换算精确 / 状态面积派生', () => {
  const ok = judge('thm.m2.supp.v1', grid(4, 6), [num('area-now', 0.24, 'dm2'), num('length-needed', 3, 'cm')]);
  assert.equal(ok.verdict, 'CORRECT'); // 24 cm² = 0.24 dm²（1 dm² = 100 cm²）

  const misPerimeter = judge('thm.m2.supp.v1', grid(4, 6), [num('area-now', 20, 'cm2'), num('length-needed', 3, 'cm')]);
  assert.ok(misPerimeter.diagnostics.includes('mis-perimeter-for-area'));

  const misUnit = judge('thm.m2.supp.v1', grid(4, 6), [num('area-now', 24, 'cm'), num('length-needed', 3, 'cm')]);
  assert.equal(misUnit.verdict, 'REVISE');
  assert.ok(misUnit.diagnostics.includes('mis-unit-scale'), '数值对单位错（长度单位答面积）');
});

// ===== 微课③ 乘除与数量关系 ==================================================

test('judge m3.diag + m3.supp: 乘除三问与点阵总数', () => {
  const ok = judge('thm.m3.diag.v1', grid(3, 6), [
    num('total-mul', 24, 'ge'),
    num('count-div-per', 4, 'ge'),
    num('per-div-count', 6, 'ge'),
    choice('sel.relation', 'opt-total-eq-per-times-count'),
  ]);
  assert.equal(ok.verdict, 'CORRECT');

  const misAdd = judge('thm.m3.diag.v1', grid(3, 6), [
    num('total-mul', 10, 'ge'), // 6+4 用加法
    num('count-div-per', 4, 'ge'),
    num('per-div-count', 6, 'ge'),
    choice('sel.relation', 'opt-total-eq-per-times-count'),
  ]);
  assert.ok(misAdd.diagnostics.includes('mis-add-for-total'));

  const suppOk = judge('thm.m3.supp.v1', grid(4, 6), [num('total-now', 24, 'ge'), num('total-8-3', 24, 'ge'), num('rows-36-9', 4, 'ge')]);
  assert.equal(suppOk.verdict, 'CORRECT');
});

// ===== 微课④ 单位分类 ========================================================

test('judge m4: 单位分类 mapping 精确集合匹配', () => {
  const ok = judge('thm.m4.diag.v1', grid(1, 1), [
    mapItem([['unit-cm', 'dim-length'], ['unit-cm2', 'dim-area'], ['unit-cm3', 'dim-volume']]),
    choice('sel.desk', 'opt-area-unit'),
    choice('sel.m2-to-dm2', 'opt-100'),
    choice('sel.cube', 'opt-1-cm3'),
  ]);
  assert.equal(ok.verdict, 'CORRECT');

  const wrong = judge('thm.m4.diag.v1', grid(1, 1), [
    mapItem([['unit-cm', 'dim-length'], ['unit-cm2', 'dim-volume'], ['unit-cm3', 'dim-volume']]),
    choice('sel.desk', 'opt-area-unit'),
    choice('sel.m2-to-dm2', 'opt-100'),
    choice('sel.cube', 'opt-1-cm3'),
  ]);
  assert.equal(wrong.verdict, 'REVISE');

  const suppOk = judge('thm.m4.supp.v1', grid(1, 1), [
    mapItem([
      ['unit-mm', 'dim-length'],
      ['unit-cm2', 'dim-area'],
      ['unit-dm3', 'dim-volume'],
      ['unit-m', 'dim-length'],
      ['unit-m2', 'dim-area'],
      ['unit-cm3', 'dim-volume'],
    ]),
    choice('sel.dict', 'opt-cm3'),
    choice('sel.playground', 'opt-area-needs-square-unit'),
  ]);
  assert.equal(suppOk.verdict, 'CORRECT');
});

// ===== 课1 等分与表示 ========================================================

test('judge f1.g1: EXACT 分数 + 分子分母互换误解 + 未平均分反例', () => {
  const ok = judge('thm.f1.g1.partition-circle.v1', grid(1, 4, 3), [
    frac('circle-fraction', 3, 4),
    choice('sel.denom-meaning', 'opt-total-parts'),
    choice('sel.unequal-parts', 'opt-no'),
  ]);
  assert.equal(ok.verdict, 'CORRECT');

  const swapped = judge('thm.f1.g1.partition-circle.v1', grid(1, 4, 3), [
    frac('circle-fraction', 4, 3), // 写反
    choice('sel.denom-meaning', 'opt-total-parts'),
    choice('sel.unequal-parts', 'opt-no'),
  ]);
  assert.equal(swapped.verdict, 'REVISE');
  assert.ok(swapped.diagnostics.includes('mis-num-den-swapped'));

  // 未操作到位：圆盘还在 1 份
  const gate = judge('thm.f1.g1.partition-circle.v1', grid(1, 1, 0), [
    frac('circle-fraction', 3, 4),
    choice('sel.denom-meaning', 'opt-total-parts'),
    choice('sel.unequal-parts', 'opt-no'),
  ]);
  assert.equal(gate.scenarioMet, false);
  assert.equal(gate.verdict, 'REVISE');
});

test('judge f1.i1: 冻结实例图板读图', () => {
  const ok = judge('thm.f1.i1.represent.v1', grid(1, 10, 7), [frac('bar-fraction', 7, 10), choice('sel.num-meaning', 'opt-num-taken')]);
  assert.equal(ok.verdict, 'CORRECT');
  const bad = judge('thm.f1.i1.represent.v1', grid(1, 10, 7), [frac('bar-fraction', 10, 7), choice('sel.num-meaning', 'opt-num-taken')]);
  assert.ok(bad.diagnostics.includes('mis-num-den-swapped'));
});

test('judge f1.d1: 全天分数 REDUCED_EQUALS（等值书写归一）', () => {
  const ok = judge('thm.f1.d1.delayed-transfer.v1', grid(1, 8, 3), [
    frac('morning-fraction', 3, 8),
    frac('whole-day-fraction', 5, 8),
  ]);
  assert.equal(ok.verdict, 'CORRECT');
  // 等值书写 10/16 也接受（有理数精确比较归一）
  const equiv = judge('thm.f1.d1.delayed-transfer.v1', grid(1, 8, 3), [
    frac('morning-fraction', 3, 8),
    frac('whole-day-fraction', 10, 16),
  ]);
  assert.equal(equiv.verdict, 'CORRECT');
  // 不等值的错答不接受
  const bad = judge('thm.f1.d1.delayed-transfer.v1', grid(1, 8, 3), [
    frac('morning-fraction', 3, 8),
    frac('whole-day-fraction', 3, 8),
  ]);
  assert.equal(bad.verdict, 'REVISE');
});

// ===== 课2 等值与缩放 ========================================================

test('judge f2.g1/f2.g2: 只缩分子 / 只缩分母误解边界', () => {
  const ok = judge('thm.f2.g1.scale-bar.v1', grid(1, 4, 2), [
    frac('scaled-fraction', 2, 4),
    choice('sel.size-change', 'opt-same-size'),
    choice('sel.why-equal', 'opt-both-scaled'),
  ]);
  assert.equal(ok.verdict, 'CORRECT');

  const numOnly = judge('thm.f2.g1.scale-bar.v1', grid(1, 4, 2), [
    frac('scaled-fraction', 2, 2), // 只缩分子（1×2 / 2）
    choice('sel.size-change', 'opt-same-size'),
    choice('sel.why-equal', 'opt-both-scaled'),
  ]);
  assert.ok(numOnly.diagnostics.includes('mis-numerator-only-scaled'));

  const denOnly = judge('thm.f2.g1.scale-bar.v1', grid(1, 4, 2), [
    frac('scaled-fraction', 1, 4), // 只缩分母（1 / 2×2）
    choice('sel.size-change', 'opt-same-size'),
    choice('sel.why-equal', 'opt-both-scaled'),
  ]);
  assert.ok(denOnly.diagnostics.includes('mis-denominator-only-scaled'));

  const g2numOnly = judge('thm.f2.g2.equivalent-find.v1', grid(1, 8, 6), [
    frac('scaled-fraction', 6, 4), // 3×2 / 4
    choice('sel.why-eq', 'opt-num-den-same-times'),
  ]);
  assert.ok(g2numOnly.diagnostics.includes('mis-numerator-only-scaled'));
  const g2denOnly = judge('thm.f2.g2.equivalent-find.v1', grid(1, 8, 6), [
    frac('scaled-fraction', 3, 8), // 3 / 4×2
    choice('sel.why-eq', 'opt-num-den-same-times'),
  ]);
  assert.ok(g2denOnly.diagnostics.includes('mis-denominator-only-scaled'));
});

test('judge f2.i1: 数轴读点（authored EXACT）与等值选择', () => {
  const ok = judge('thm.f2.i1.numberline.v1', grid(1, 6, 2), [frac('point-fraction', 2, 6), choice('sel.eq-choice', 'opt-1-3')]);
  assert.equal(ok.verdict, 'CORRECT');
  const bad = judge('thm.f2.i1.numberline.v1', grid(1, 6, 2), [frac('point-fraction', 1, 3), choice('sel.eq-choice', 'opt-1-3')]);
  assert.equal(bad.verdict, 'REVISE', '读点题要求字面 2/6（1/3 是等值选择那问的答案）');
});

test('judge f2.s1: 折纸比较 + 分母 8 化写', () => {
  const ok = judge('thm.f2.s1.stranger.v1', grid(1, 8, 4), [choice('sel.who-more', 'opt-same'), frac('denom-8-fraction', 4, 8)]);
  assert.equal(ok.verdict, 'CORRECT');
  const numOnly = judge('thm.f2.s1.stranger.v1', grid(1, 8, 4), [choice('sel.who-more', 'opt-same'), frac('denom-8-fraction', 4, 2)]);
  assert.ok(numOnly.diagnostics.includes('mis-numerator-only-scaled'));
});

// ===== 课3 百分数 / 折扣 / 分配 ==============================================

test('judge f3.g1: 百分数状态派生 + 当整数/小数误解', () => {
  const ok = judge('thm.f3.g1.percent-board.v1', grid(10, 10, 75), [
    num('percent-value', 75, 'percent'),
    choice('sel.percent-meaning', 'opt-part-of-hundred'),
    num('percent-units', 75, 'ge'),
  ]);
  assert.equal(ok.verdict, 'CORRECT');

  const asDecimal = judge('thm.f3.g1.percent-board.v1', grid(10, 10, 75), [
    num('percent-value', 0.75, 'percent'), // 75% 写成 0.75
    choice('sel.percent-meaning', 'opt-part-of-hundred'),
    num('percent-units', 75, 'ge'),
  ]);
  assert.ok(asDecimal.diagnostics.includes('mis-percent-as-decimal'));

  const asInteger = judge('thm.f3.g1.percent-board.v1', grid(10, 10, 75), [
    num('percent-value', 75, 'ge'), // 百分数当个数
    choice('sel.percent-meaning', 'opt-part-of-hundred'),
    num('percent-units', 75, 'ge'),
  ]);
  assert.ok(asInteger.diagnostics.includes('mis-percent-as-integer'));
});

test('judge f3.g2: 折扣顺序边界（八折=80% 不是 8%；打折是乘不是加）', () => {
  const ok = judge('thm.f3.g2.discount-chain.v1', grid(10, 10, 80), [
    num('fold-percent', 80, 'percent'),
    num('pay-amount', 64.0, 'yuan'),
    num('save-amount', 16.0, 'yuan'),
  ]);
  assert.equal(ok.verdict, 'CORRECT');

  const as8pct = judge('thm.f3.g2.discount-chain.v1', grid(10, 10, 80), [
    num('fold-percent', 80, 'percent'),
    num('pay-amount', 6.4, 'yuan'), // 80×8%：把八折当 8%
    num('save-amount', 16.0, 'yuan'),
  ]);
  assert.ok(as8pct.diagnostics.includes('mis-fold-as-8pct'));

  const added = judge('thm.f3.g2.discount-chain.v1', grid(10, 10, 80), [
    num('fold-percent', 80, 'percent'),
    num('pay-amount', 96.0, 'yuan'), // 80×1.2：先加后乘/当成加价
    num('save-amount', 16.0, 'yuan'),
  ]);
  assert.ok(added.diagnostics.includes('mis-discount-added'));

  const noDiscount = judge('thm.f3.g2.discount-chain.v1', grid(10, 10, 80), [
    num('fold-percent', 80, 'percent'),
    num('pay-amount', 80.0, 'yuan'), // 没打折
    num('save-amount', 16.0, 'yuan'),
  ]);
  assert.ok(noDiscount.diagnostics.includes('mis-no-discount'));

  const saveEqPay = judge('thm.f3.g2.discount-chain.v1', grid(10, 10, 80), [
    num('fold-percent', 80, 'percent'),
    num('pay-amount', 64.0, 'yuan'),
    num('save-amount', 64.0, 'yuan'), // 便宜的钱写成了应付的钱
  ]);
  assert.ok(saveEqPay.diagnostics.includes('mis-save-eq-pay'));

  // 两位小数口径：64.004 舍入后 64.00 通过；64.05 → 64.10 不等于 64.00 拒绝
  const rounding = judge('thm.f3.g2.discount-chain.v1', grid(10, 10, 80), [
    num('fold-percent', 80, 'percent'),
    num('pay-amount', 64.004, 'yuan'),
    num('save-amount', 16.0, 'yuan'),
  ]);
  assert.equal(rounding.verdict, 'CORRECT', 'HALF_UP 两位小数口径');
});

test('judge f3.i1: 按比例分配（对半分 / 乘总数误解）', () => {
  const ok = judge('thm.f3.i1.allocate.v1', grid(3, 12), [
    num('share-per', 12, 'ge'),
    num('part-a', 36, 'ge'),
    num('part-b', 24, 'ge'),
  ]);
  assert.equal(ok.verdict, 'CORRECT');

  const equalSplit = judge('thm.f3.i1.allocate.v1', grid(3, 12), [
    num('share-per', 12, 'ge'),
    num('part-a', 30, 'ge'), // 对半分
    num('part-b', 24, 'ge'),
  ]);
  assert.ok(equalSplit.diagnostics.includes('mis-equal-split'));

  const timesTotal = judge('thm.f3.i1.allocate.v1', grid(3, 12), [
    num('share-per', 12, 'ge'),
    num('part-a', 180, 'ge'), // 60×3
    num('part-b', 24, 'ge'),
  ]);
  assert.ok(timesTotal.diagnostics.includes('mis-ratio-times-total'));
});

test('judge f3.s1 + f3.d1: 两店比价 / 九折回看（半价只作用第二件）', () => {
  const s1 = judge('thm.f3.s1.stranger.v1', grid(10, 10, 0), [
    num('store-a-pay', 60.0, 'yuan'),
    num('store-b-pay', 64.0, 'yuan'),
    choice('sel.cheaper', 'opt-store-a'),
    num('diff-amount', 4.0, 'yuan'),
  ]);
  assert.equal(s1.verdict, 'CORRECT');

  const halfOnBoth = judge('thm.f3.s1.stranger.v1', grid(10, 10, 0), [
    num('store-a-pay', 40.0, 'yuan'), // 两件都半价误解
    num('store-b-pay', 64.0, 'yuan'),
    choice('sel.cheaper', 'opt-store-a'),
    num('diff-amount', 4.0, 'yuan'),
  ]);
  assert.ok(halfOnBoth.diagnostics.includes('mis-half-on-both'));

  const d1 = judge('thm.f3.d1.delayed-transfer.v1', grid(10, 10, 90), [
    num('fold-percent', 90, 'percent'),
    num('pay-amount', 45.0, 'yuan'),
    num('save-amount', 5.0, 'yuan'),
  ]);
  assert.equal(d1.verdict, 'CORRECT');
  const d1gate = judge('thm.f3.d1.delayed-transfer.v1', grid(10, 10, 0), [
    num('fold-percent', 90, 'percent'),
    num('pay-amount', 45.0, 'yuan'),
    num('save-amount', 5.0, 'yuan'),
  ]);
  assert.equal(d1gate.scenarioMet, false, '九折回看要求先涂 90 格');
});
