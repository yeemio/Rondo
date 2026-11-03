#!/usr/bin/env node
/**
 * Rondo THEMES-A content builder: 4 prerequisite micro-lessons (先修微课) +
 * Theme 1 (分数、百分数与比例, 3 lessons), taskFamilies themes.micro.v1 /
 * themes.frac.v1, renderer rondo.gridboard@1 (+ rondo.cylinder@1 base-circle
 * projection for 微课①).
 *
 * Single source of truth: emits the whole content/themes-a tree (public +
 * private) deterministically, the public release manifests with sha256 asset
 * hashes, and the dist/content B release layouts for all 7 releases.
 *
 * Contract baseline (THEMES-A delta 2026-10-27, mirroring the approved GESP2
 * precedent): scene-gridboard.ts (GridBoardStateV1 + SetGridSize/SetFilled/
 * ScaleBoth), envelope carriers fractionValue/singleChoice, rules-themes.ts
 * GRID_TASK_TRUTH. Lifecycle commands / error codes / phases: zero changes;
 * judging is server-side recomputation from private rule data.
 *
 * All numeric truths are precomputed by hand and independently recomputed by
 * tests/themes (exact rationals). Anti-misconception diagnostics never leak
 * expected values in feedback.
 *
 * Run: npm run build:content   (chained after scripts/build-content.mjs)
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, statSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'content', 'themes-a');
const TASK_VERSION = '1';

const RENDERER_GRID = { rendererId: 'rondo.gridboard', rendererContractVersion: '1', publicStateSchemaVersion: '1' };
const RENDERER_CYL = { rendererId: 'rondo.cylinder', rendererContractVersion: '1', publicStateSchemaVersion: '1' };

const UNSURE = { id: 'opt-unsure', label: '不确定' };

// micro① rides the cylinder base circle; everything else is the grid board
const gridGivens = (rows, cols, filled = 0) => ({ rows, cols, filled });
const cylGivens = (radiusMm, heightMm = 10) => ({ radiusMm, heightMm, unrollPermille: 0, section: 'NONE', selectedFaceIds: [] });

// ---------------------------------------------------------------------------
// registry building blocks (public; drives the player forms)
// ---------------------------------------------------------------------------
const U = {
  cm: { id: 'cm', label: '厘米（cm）' },
  mm: { id: 'mm', label: '毫米（mm）' },
  cm2: { id: 'cm2', label: '平方厘米（cm²）' },
  mm2: { id: 'mm2', label: '平方毫米（mm²）' },
  dm2: { id: 'dm2', label: '平方分米（dm²）' },
  percent: { id: 'percent', label: '百分数（%）' },
  ge: { id: 'ge', label: '个' },
  yuan: { id: 'yuan', label: '元' },
};
const LENGTH_UNITS = [U.cm, U.mm];
const AREA_UNITS = [U.cm2, U.mm2, U.dm2];
const PERCENT_UNITS = [U.percent, U.ge];
const GE_UNITS = [U.ge];
const YUAN_UNITS = [U.yuan];

const askChoice = (id, prompt, options) => ({ id, kind: 'choice', prompt, options });
const askNumber = (id, prompt, quantityLabel, units) => ({ id, kind: 'numberValue', prompt, quantityLabel, units });
const askFraction = (id, prompt, quantityLabel) => ({ id, kind: 'fractionGuess', prompt, quantityLabel });
const askMapping = (id, prompt, pairs) => ({ id, kind: 'mapping', prompt, pairs });
const itemNumber = (prompt, quantityId, quantityLabel, units, decimals) => ({
  kind: 'numberWithUnit', prompt, quantityId, quantityLabel, units, decimals,
});
const itemFraction = (prompt, quantityId, quantityLabel) => ({ kind: 'fractionValue', prompt, quantityId, quantityLabel });
const itemChoice = (prompt, selectionId, options) => ({ kind: 'singleChoice', prompt, selectionId, options });
const itemMapping = (prompt, pairs) => ({ kind: 'objectMapping', prompt, pairs });

const pair = (leftId, leftLabel, rightOptions) => ({ leftId, leftLabel, rightOptions });

const DIM_OPTIONS = [
  { id: 'dim-length', label: '长度单位' },
  { id: 'dim-area', label: '面积单位' },
  { id: 'dim-volume', label: '体积单位' },
  UNSURE,
];

// ---------------------------------------------------------------------------
// tasks (public authored layer)
// ---------------------------------------------------------------------------
const tasks = [];
function addTask(t) {
  tasks.push({ taskVersion: TASK_VERSION, ...t });
}

// ===== 微课① 半径与直径 (rondo.cylinder@1 底面圆投影) =======================

addTask({
  taskId: 'thm.m1.diag.v1',
  taskFamily: 'themes.micro.v1',
  kind: 'INDEPENDENT',
  title: '先修诊断 · 半径与直径',
  boardView: 'CIRCLE_FLAT',
  givens: cylGivens(25),
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.thm.m1diag.v1',
  allowedOperationIds: [],
  operationConstraints: [],
  prompt: [
    { type: 'TEXT', text: '先修小诊断：半径与直径（共 4 小题，快判）' },
    { type: 'TEXT', text: '下面的圆（俯视）画出了半径 r 的线段。半径：从圆心到圆上任意一点的线段；直径：穿过圆心、两端都在圆上的线段。' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '题号' }, { label: '已知' }, { label: '单位' }], rows: [
      ['(1)', '一个圆的半径 r = 2.5', 'cm'],
      ['(2)', '另一个圆的直径 d = 12', 'cm'],
    ] },
    { type: 'TEXT', text: '(1) 半径 2.5 cm 的圆，直径是多少？(2) 直径 12 cm 的圆，半径是多少？(3) 直径和半径是什么关系？(4) 一个圆的半径变大，直径会怎样？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-radius-diameter', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '(1) 已知 r=2.5 cm 求 d；(2) 已知 d=12 cm 求 r；(3) 选出 d 和 r 的关系；(4) 判断 r 变大时 d 怎么变。' },
    { level: 2, label: '概念提示', text: '直径是把半径"对折再接一段同样的长"——两个半径拼成一条直径。' },
    { level: 3, label: '策略提示', text: 'd = r × 2；反过来 r = d ÷ 2。两道数值题各用一次。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.m1.how', prompt: '你主要怎么记住半径和直径的关系？', options: [
        { id: 'opt-d-is-2r', label: '直径是半径的 2 倍' },
        { id: 'opt-picture', label: '看图：一条直径由两条半径拼成' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '用一句话向家人解释半径和直径的关系。',
  },
  exitEvidence: ['firstPrediction', 'submission', 'explanation'],
  expressions: {
    boardSvg: '俯视圆盘（SVG）：圆心、半径线段与直径线段标注；静态呈现，无交互。',
    boardTable: '同状态的表格投影：r、d 两行读数；同一任务卡与判分接口。',
  },
});

addTask({
  taskId: 'thm.m1.supp.v1',
  taskFamily: 'themes.micro.v1',
  kind: 'GUIDED',
  title: '补充活动 · 转动半径看直径',
  boardView: 'CIRCLE_FLAT',
  givens: cylGivens(30),
  givenLocks: [],
  responseSchemaId: 'resp.thm.m1supp.v1',
  allowedOperationIds: ['SetDimension'],
  operationConstraints: [{ type: 'SetDimension', dimension: 'RADIUS', minMm: 10, maxMm: 100 }],
  prompt: [
    { type: 'TEXT', text: '补充活动：一个可以调半径的圆' },
    { type: 'TEXT', text: '右侧是一个俯视的圆（显示半径线和直径线）。用滑杆或方向键（↑ 变大 / ↓ 变小）调整半径，确认后圆和读数一起更新。' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '操作目标' }, { label: '要求' }], rows: [
      ['① 调整半径', '把半径调到 3.5 cm 并确认，读出直径'],
      ['② 反过来想', '要让直径变成 12.0 cm，半径应调到多少？'],
    ] },
    { type: 'TEXT', text: '先做 ① 并确认，再提交两问的答案：现在圆的直径是多少？要让直径等于 12.0 cm，半径应调到多少厘米？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '把半径调到 3.5 cm 后读直径；再算"直径 12.0 cm 对应的半径"。' },
    { level: 2, label: '概念提示', text: '直径 = 半径 × 2；半径 = 直径 ÷ 2。' },
    { level: 3, label: '策略提示', text: '第 ① 问在确认后的读数里找；第 ② 问用 12.0 ÷ 2。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.m1supp.watch', prompt: '调半径时你观察到直径读数怎样变化？', options: [
        { id: 'opt-double-always', label: '总是半径的 2 倍' },
        { id: 'opt-sometimes', label: '有时不是 2 倍' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '如果半径调到 5.5 cm，直径是多少？你是怎么算的？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '俯视圆盘（SVG）随确认的半径重绘；半径/直径线段标注与读数同步。',
    boardTable: 'r/d 读数表 + 相同滑杆与键盘入口；同一 typed intent、同一判分。',
  },
});

// ===== 微课② 长方形面积与面积单位 ==========================================

addTask({
  taskId: 'thm.m2.diag.v1',
  taskFamily: 'themes.micro.v1',
  kind: 'INDEPENDENT',
  title: '先修诊断 · 长方形面积与面积单位',
  boardView: 'RECT',
  givens: gridGivens(3, 5),
  givenLocks: ['rows', 'cols', 'filled'],
  responseSchemaId: 'resp.thm.m2diag.v1',
  allowedOperationIds: [],
  operationConstraints: [],
  prompt: [
    { type: 'TEXT', text: '先修小诊断：长方形面积与面积单位（共 4 小题）' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '题号' }, { label: '已知' }, { label: '单位' }], rows: [
      ['(1)', '长方形长 5、宽 3（每格是边长 1 cm 的小正方形）', 'cm'],
      ['(4)', '1 平方分米等于多少平方厘米', '—'],
    ] },
    { type: 'TEXT', text: '(1) 这个长方形的面积是多少？(2) 边长 1 cm 的正方形，面积是多少？(3) 面积单位为什么叫"平方"厘米？(4) 1 dm² = ? cm²' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-area', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '长 5 cm、宽 3 cm 求面积；1 cm 边长正方形的面积；面积单位名字的由来；1 dm² 换算成 cm²。' },
    { level: 2, label: '概念提示', text: '面积就是铺满图形需要多少个"单位小正方形"。' },
    { level: 3, label: '策略提示', text: '每行铺 5 个、铺 3 行；换算先想 1 dm = 10 cm，再想正方形 10×10。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.m2.why', prompt: '为什么面积单位带"平方"？', options: [
        { id: 'opt-length-times-length', label: '长度 × 长度，两个长度相乘' },
        { id: 'opt-just-name', label: '只是一种叫法' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '向家人说说你是怎么数出长方形面积的。',
  },
  exitEvidence: ['firstPrediction', 'submission', 'explanation'],
  expressions: {
    boardSvg: '5×3 格点长方形（SVG，每格 1 cm²）静态呈现。',
    boardTable: '行×列读数表；同一任务卡与判分接口。',
  },
});

addTask({
  taskId: 'thm.m2.supp.v1',
  taskFamily: 'themes.micro.v1',
  kind: 'GUIDED',
  title: '补充活动 · 拼出面积',
  boardView: 'RECT',
  givens: gridGivens(3, 5),
  givenLocks: [],
  responseSchemaId: 'resp.thm.m2supp.v1',
  allowedOperationIds: ['SetGridSize'],
  operationConstraints: [
    { type: 'SetGridSize', rowsValues: Array.from({ length: 12 }, (_, i) => i + 1), colsValues: Array.from({ length: 12 }, (_, i) => i + 1) },
  ],
  prompt: [
    { type: 'TEXT', text: '补充活动：一个可以改长宽的长方形' },
    { type: 'TEXT', text: '右侧长方形每格是 1 cm² 的小正方形。用步进按钮或方向键调整行数（宽）和列数（长），确认后重绘。' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '操作目标' }, { label: '要求' }], rows: [
      ['① 拼一个 4 行 × 6 列的长方形', '确认后读出面积'],
      ['② 反过来想', '面积要做成 18 cm²、宽 6 cm（6 列），长应该是几厘米？'],
    ] },
    { type: 'TEXT', text: '先完成 ① 并确认，再提交：现在长方形的面积是多少？② 的长是多少厘米？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '把长方形调成 4 行 6 列读面积；再算面积 18 cm²、宽 6 cm 时的长。' },
    { level: 2, label: '概念提示', text: '面积 = 每行的格数 × 行数；反过来，长 = 面积 ÷ 宽。' },
    { level: 3, label: '策略提示', text: '① 直接数/乘；② 用 18 ÷ 6。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.m2supp.relation', prompt: '长、宽、面积三者之间的关系是？', options: [
        { id: 'opt-a-eq-w-times-h', label: '面积 = 长 × 宽' },
        { id: 'opt-a-eq-w-plus-h', label: '面积 = 长 + 宽' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '如果想拼一个面积是 24 cm² 的长方形，你有哪些拼法？写出两种。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '格点长方形（SVG）随确认的行列数重绘，逐格可见。',
    boardTable: '行/列/面积读数表 + 相同步进与键盘入口；同一判分。',
  },
});

// ===== 微课③ 乘除与数量关系 =================================================

addTask({
  taskId: 'thm.m3.diag.v1',
  taskFamily: 'themes.micro.v1',
  kind: 'INDEPENDENT',
  title: '先修诊断 · 乘除与数量关系',
  boardView: 'DOTARRAY',
  givens: gridGivens(3, 6),
  givenLocks: ['rows', 'cols', 'filled'],
  responseSchemaId: 'resp.thm.m3diag.v1',
  allowedOperationIds: [],
  operationConstraints: [],
  prompt: [
    { type: 'TEXT', text: '先修小诊断：乘除与数量关系（共 4 小题）' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '题号' }, { label: '情境' }], rows: [
      ['(1)', '每盒铅笔 6 支，装了 4 盒'],
      ['(2)', '一共 24 支，每 6 支装一盒'],
      ['(3)', '一共 24 支，平均装 4 盒'],
    ] },
    { type: 'TEXT', text: '(1) 铅笔一共多少支？(2) 能装几盒？(3) 每盒几支？(4) 总数、每份数、份数之间是什么关系？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-quantity', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '三个装铅笔的情境分别求总数、盒数、每盒支数，再选出三个量的关系。' },
    { level: 2, label: '概念提示', text: '总数是"每份数 × 份数"铺出来的；反过来可以除。' },
    { level: 3, label: '策略提示', text: '求总数用乘；求份数或每份数用除。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.m3.when-divide', prompt: '什么时候用除法？', options: [
        { id: 'opt-total-known', label: '知道总数和每份数（或份数），求另一个' },
        { id: 'opt-always-multiply', label: '都再用乘法算一遍' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '用"每份数、份数、总数"说一句生活中的例子。',
  },
  exitEvidence: ['firstPrediction', 'submission', 'explanation'],
  expressions: {
    boardSvg: '3 行 × 每行 6 个的点阵（SVG）静态呈现。',
    boardTable: '行/每行个数/总数读数表；同一任务卡与判分接口。',
  },
});

addTask({
  taskId: 'thm.m3.supp.v1',
  taskFamily: 'themes.micro.v1',
  kind: 'GUIDED',
  title: '补充活动 · 点阵里的乘除',
  boardView: 'DOTARRAY',
  givens: gridGivens(3, 6),
  givenLocks: [],
  responseSchemaId: 'resp.thm.m3supp.v1',
  allowedOperationIds: ['SetGridSize'],
  operationConstraints: [
    { type: 'SetGridSize', rowsValues: Array.from({ length: 12 }, (_, i) => i + 1), colsValues: Array.from({ length: 12 }, (_, i) => i + 1) },
  ],
  prompt: [
    { type: 'TEXT', text: '补充活动：摆点阵，做乘除' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '操作目标' }, { label: '要求' }], rows: [
      ['① 摆一个 4 行、每行 6 个的点阵', '确认后读出总数'],
      ['② 想一想', '每行摆 8 个、摆 3 行，一共多少个？'],
      ['③ 反过来', '36 个点，每行摆 9 个，能摆几行？'],
    ] },
    { type: 'TEXT', text: '先完成 ① 并确认，再提交三问：① 的总数；② 的总数；③ 的行数。' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '摆 4×6 读总数；再算 8×3；再算 36÷9。' },
    { level: 2, label: '概念提示', text: '总数 = 每行个数 × 行数；行数 = 总数 ÷ 每行个数。' },
    { level: 3, label: '策略提示', text: '① 在确认后的读数里找；②③ 分别用乘和除。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.m3supp.model', prompt: '点阵帮你看到了什么？', options: [
        { id: 'opt-rows-times-cols', label: '总数就是每行个数乘行数' },
        { id: 'opt-nothing', label: '没看出帮助' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '如果只有 20 个点、每行摆 6 个，会怎么样？说说你的想法。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '点阵（SVG）随确认的行列数重绘。',
    boardTable: '行/每行个数/总数读数表 + 相同步进与键盘入口；同一判分。',
  },
});

// ===== 微课④ 长度、面积、体积的单位区别 ====================================

addTask({
  taskId: 'thm.m4.diag.v1',
  taskFamily: 'themes.micro.v1',
  kind: 'INDEPENDENT',
  title: '先修诊断 · 长度、面积、体积的单位',
  boardView: 'UNIT_TRIO',
  givens: gridGivens(1, 1),
  givenLocks: ['rows', 'cols', 'filled'],
  responseSchemaId: 'resp.thm.m4diag.v1',
  allowedOperationIds: [],
  operationConstraints: [],
  prompt: [
    { type: 'TEXT', text: '先修小诊断：三种单位（共 4 小题）' },
    { type: 'TEXT', text: '右侧图例：一条 1 cm 的线段（量长度）、一个 1 cm² 的正方形（量面积）、一个 1 cm³ 的正方体（量体积）。' },
    { type: 'TEXT', text: '(1) 把 cm、cm²、cm³ 分别归到长度、面积、体积。(2) 测量课桌面的大小，用哪类单位？(3) 1 m² = ? dm²。(4) 棱长 1 cm 的正方体，体积是多少？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-units', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '给三个 cm 家族单位分类；选出测桌面用的单位类型；换算 1 m²；说出棱长 1 cm 正方体的体积。' },
    { level: 2, label: '概念提示', text: '量线用长度单位；量面铺正方形；量体堆正方体。' },
    { level: 3, label: '策略提示', text: '单位名字里有"平方"是面积、"立方"是体积；1 m = 10 dm，所以 1 m² = 10×10 dm²。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.m4.tell', prompt: '你怎么区分这三类单位？', options: [
        { id: 'opt-name-shape', label: '看名字（平方/立方）和它量什么（线/面/体）' },
        { id: 'opt-guess', label: '靠感觉猜' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '举一个生活中分别用 cm、cm²、cm³ 的例子。',
  },
  exitEvidence: ['firstPrediction', 'submission', 'explanation'],
  expressions: {
    boardSvg: '单位图例三联（SVG）：1 cm 线段、1 cm² 正方形、1 cm³ 正方体（等距示意）。',
    boardTable: '单位—量纲对照表；同一任务卡与判分接口。',
  },
});

addTask({
  taskId: 'thm.m4.supp.v1',
  taskFamily: 'themes.micro.v1',
  kind: 'GUIDED',
  title: '补充活动 · 单位回家',
  boardView: 'UNIT_TRIO',
  givens: gridGivens(1, 1),
  givenLocks: ['rows', 'cols', 'filled'],
  responseSchemaId: 'resp.thm.m4supp.v1',
  allowedOperationIds: [],
  operationConstraints: [],
  prompt: [
    { type: 'TEXT', text: '补充活动：把六个单位送回自己的家' },
    { type: 'TEXT', text: '右侧图例保持可见。把下面六个单位分别放入"长度 / 面积 / 体积"三个家：mm、cm²、dm³、m、m²、cm³。' },
    { type: 'TEXT', text: '然后回答：一本字典占的空间大小，用哪个单位最合适？小明说"操场的面积是 300 米"，这句话哪里不对？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-units', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '六个单位分三类；选字典体积的单位；找出"操场面积 300 米"的错误。' },
    { level: 2, label: '概念提示', text: '长度量线、面积量面（带平方）、体积量体（带立方）。' },
    { level: 3, label: '策略提示', text: '先看名字里的平方/立方，再想它量的是什么；面积要带"平方"单位。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.m4supp.trap', prompt: '"面积 300 米"错在哪？', options: [
        { id: 'opt-area-needs-square-unit', label: '面积应该用面积单位（平方米），不能用长度单位' },
        { id: 'opt-number-wrong', label: '数字 300 太小了' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '把"操场面积 300 米"改成一句对的话。',
  },
  exitEvidence: ['firstPrediction', 'submission', 'explanation'],
  expressions: {
    boardSvg: '单位图例三联 + 分类选择联动高亮（SVG）；选择经表单提交，服务端判分。',
    boardTable: '单位—量纲对照表；同一判分接口。',
  },
});

// ===== 主题一 课1 等分与表示 ================================================

addTask({
  taskId: 'thm.f1.g1.partition-circle.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'GUIDED',
  title: '等分圆盘，用分数表示',
  boardView: 'PIE',
  givens: gridGivens(1, 1),
  givenLocks: ['rows'],
  responseSchemaId: 'resp.thm.f1g1.v1',
  allowedOperationIds: ['SetGridSize', 'SetFilled'],
  operationConstraints: [
    { type: 'SetGridSize', rowsValues: [1], colsValues: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    { type: 'SetFilled', maxCount: 12 },
  ],
  prompt: [
    { type: 'TEXT', text: '把圆盘平均分成 4 份' },
    { type: 'TEXT', text: '右侧是一个圆盘。术语：把整体平均分成若干份，其中的 1 份或几份就可以用分数表示——分母写总份数，分子写取的份数。"平均分"是分数的前提：每份必须一样大。' },
    { type: 'TEXT', text: '操作：用步进按钮或方向键把圆盘平均分成 4 份（左右键调份数），再把其中 3 份涂上颜色（上下键调涂色份数），每步都要确认。' },
    { type: 'TEXT', text: '然后回答：涂色部分是这个圆盘的几分之几？分数中的分母 4 表示什么？如果分成的 4 份大小不一样，还能说涂了 4 份中的 3 份就是 3/4 吗？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-fraction', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '把圆盘平均分成 4 份、涂 3 份，写出涂色部分的分数，并说明分母的意思。' },
    { level: 2, label: '概念提示', text: '分数下半部分（分母）写"一共平均分成几份"，上半部分（分子）写"取了几份"。' },
    { level: 3, label: '策略提示', text: '先数总份数，再数涂色份数；想想"每份一样大"这个前提。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f1g1.denom', prompt: '3/4 里的 4 表示什么？', options: [
        { id: 'opt-total-parts', label: '整体被平均分成的总份数' },
        { id: 'opt-taken-parts', label: '取走的份数' },
        UNSURE,
      ] },
      { itemId: 'explain.f1g1.premise', prompt: '用分数表示份数的前提是什么？', options: [
        { id: 'opt-equal-parts', label: '平均分（每份一样大）' },
        { id: 'opt-any-parts', label: '随便分成几份就行' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '向家人解释：为什么"平均分"对分数这么重要。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '等分圆盘（SVG）：扇形随确认的份数重绘，涂色份数高亮；左右/上下键与按钮同入口。',
    boardTable: '份数/涂色份数读数表；同一状态、同一表单与判分。',
  },
});

addTask({
  taskId: 'thm.f1.g2.partition-bar.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'GUIDED',
  title: '条带等分与数轴标点',
  boardView: 'BAR_NUMBERLINE',
  givens: gridGivens(1, 1),
  givenLocks: ['rows'],
  responseSchemaId: 'resp.thm.f1g2.v1',
  allowedOperationIds: ['SetGridSize', 'SetFilled'],
  operationConstraints: [
    { type: 'SetGridSize', rowsValues: [1], colsValues: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    { type: 'SetFilled', maxCount: 12 },
  ],
  prompt: [
    { type: 'TEXT', text: '在条带和数轴上表示 5/8' },
    { type: 'TEXT', text: '右侧是一条 0 到 1 的条带，下面是同一条数轴。条带平均分成几份、涂几份，数轴上的点就走到第几格。' },
    { type: 'TEXT', text: '操作：把条带平均分成 8 份，涂 5 份，确认。观察数轴上点停留的位置。' },
    { type: 'TEXT', text: '回答：涂色部分是几分之几？它和 1/2 相比，谁大？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '条带分 8 份涂 5 份，写出分数，再和 1/2 比大小。' },
    { level: 2, label: '概念提示', text: '数轴上 1/2 在正中间；点走过中点还是没到中点，直接看得出大小。' },
    { level: 3, label: '策略提示', text: '比较时看分子有没有超过分母的一半：5 超过了 8 的一半。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f1g2.half', prompt: '5/8 和 1/2 谁大？你怎么看出来的？', options: [
        { id: 'opt-58-bigger', label: '5/8 大——点已越过数轴中点' },
        { id: 'opt-half-bigger', label: '1/2 大' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '在数轴上指出 3/8 大概在哪里，说说你的想法。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '条带 + 数轴联动（SVG）：份数/涂色份数确认后重绘，点位置同步。',
    boardTable: '份数/涂色份数读数表；同一状态与判分。',
  },
});

addTask({
  taskId: 'thm.f1.i1.represent.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'INDEPENDENT',
  title: '独立练习 · 巧克力条',
  boardView: 'BAR',
  givens: gridGivens(1, 10, 7),
  givenLocks: ['rows', 'cols', 'filled'],
  responseSchemaId: 'resp.thm.f1i1.v1',
  allowedOperationIds: [],
  operationConstraints: [],
  prompt: [
    { type: 'TEXT', text: '独立练习：一条巧克力' },
    { type: 'TEXT', text: '一条巧克力被平均分成 10 格，其中 7 格涂了颜色（右侧图）。' },
    { type: 'TEXT', text: '不借助操作，直接回答：涂色部分是这条巧克力的几分之几？分数中的分子表示什么？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '10 格涂 7 格，写出分数并说明分子。' },
    { level: 2, label: '概念提示', text: '总份数写分母，涂色份数写分子。' },
    { level: 3, label: '策略提示', text: '数一数：一共几格？涂色几格？' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f1i1.num', prompt: '7/10 里的 7 表示什么？', options: [
        { id: 'opt-num-7', label: '涂色的 7 格（取的份数）' },
        { id: 'opt-num-10', label: '总份数' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '如果再吃掉 2 格，剩下的是几分之几？',
  },
  exitEvidence: ['firstPrediction', 'submission', 'explanation'],
  expressions: {
    boardSvg: '10 格条带（SVG）静态呈现 7 格涂色。',
    boardTable: '份数/涂色份数读数表；同一判分。',
  },
});

addTask({
  taskId: 'thm.f1.s1.stranger-relabel.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'STRANGER',
  title: '陌生情境 · 大小不一的披萨块',
  boardView: 'PIE',
  givens: gridGivens(1, 1),
  givenLocks: ['rows'],
  responseSchemaId: 'resp.thm.f1s1.v1',
  allowedOperationIds: ['SetGridSize', 'SetFilled'],
  operationConstraints: [
    { type: 'SetGridSize', rowsValues: [1], colsValues: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    { type: 'SetFilled', maxCount: 12 },
  ],
  prompt: [
    { type: 'TEXT', text: '陌生情境：这样切披萨，分数还算数吗？' },
    { type: 'TEXT', text: '披萨店里，店员随手把一张披萨切成了 4 块——块头有大有小。小明拿到了其中较大的一块。' },
    { type: 'TEXT', text: '(1) 小明能说他拿到了这张披萨的 1/4 吗？(2) 在右侧圆盘上把它"重新切好"：平均分成 4 份、涂 1 份，确认后写出涂色部分的分数。' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-fraction', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'], note: '陌生任务复测术语回忆' },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '先判断"大小不一的 4 块拿 1 块"能不能叫 1/4；再把圆盘改成平均 4 份涂 1 份并写分数。' },
    { level: 2, label: '概念提示', text: '分数说的是"平均分之后的份数"；不是平均分，份数一样也不能直接用。' },
    { level: 3, label: '策略提示', text: '把圆盘的份数调到 4（每份自动一样大），涂色调到 1，再读分数。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f1s1.why', prompt: '为什么随手切不能直接说 1/4？', options: [
        { id: 'opt-not-equal', label: '没有平均分，每份不一样大' },
        { id: 'opt-count-wrong', label: '因为块数不是 4' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '向家人说明：怎样切才能用 1/4 表示。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '等分圆盘（SVG）：重新切分与涂色均经确认操作。',
    boardTable: '份数/涂色份数读数表；同一判分。',
  },
});

addTask({
  taskId: 'thm.f1.d1.delayed-transfer.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'DELAYED_TRANSFER',
  title: '回看练习 · 生日蛋糕',
  boardView: 'PIE',
  givens: gridGivens(1, 8, 0),
  givenLocks: ['rows', 'cols'],
  responseSchemaId: 'resp.thm.f1d1.v1',
  allowedOperationIds: ['SetFilled'],
  operationConstraints: [{ type: 'SetFilled', maxCount: 8 }],
  prompt: [
    { type: 'TEXT', text: '回看练习：生日蛋糕（隔几天后再来）' },
    { type: 'TEXT', text: '一块圆形蛋糕被平均分成 8 块。上午家人吃了 3 块。' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '已知' }, { label: '数值' }], rows: [
      ['平均分成的块数', '8'],
      ['上午吃的块数', '3'],
      ['下午又吃的块数', '2'],
    ] },
    { type: 'TEXT', text: '在右侧圆盘上把上午吃掉的 3 份涂色并确认。回答：(1) 上午吃的是这块蛋糕的几分之几？(2) 这一天一共吃掉的是几分之几？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '蛋糕平均分 8 块，上午吃 3 块、下午吃 2 块；写出上午的分数和全天的分数。' },
    { level: 2, label: '概念提示', text: '分母还是总块数 8；全天吃的块数要先合起来。' },
    { level: 3, label: '策略提示', text: '(1) 3 块 → 3/8；(2) 3+2=5 块 → 5/8。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f1d1.recall', prompt: '隔了这些天，你是怎么想起来的？', options: [
        { id: 'opt-parts-model', label: '想起"总份数作分母、取的份数作分子"' },
        { id: 'opt-tried-again', label: '在圆盘上又试了一遍' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '写出你解题时心里想的那句话。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '8 等分圆盘（SVG），涂色经确认操作。',
    boardTable: '份数/涂色份数读数表；同一判分。',
  },
});

// ===== 主题一 课2 等值与缩放 ================================================

addTask({
  taskId: 'thm.f2.g1.scale-bar.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'GUIDED',
  title: '同乘一个数：1/2 变 2/4',
  boardView: 'BAR',
  givens: gridGivens(1, 2, 1),
  givenLocks: ['rows'],
  responseSchemaId: 'resp.thm.f2g1.v1',
  allowedOperationIds: ['ScaleBoth'],
  operationConstraints: [{ type: 'ScaleBoth', multipliers: [2, 3] }],
  prompt: [
    { type: 'TEXT', text: '把条带"整体放大"' },
    { type: 'TEXT', text: '右侧条带现在平均分成 2 份、涂 1 份（1/2）。操作"同乘"：把份数和涂色份数同时乘 2（×2 按钮），确认后观察涂色部分的大小。' },
    { type: 'TEXT', text: '回答：现在的分数是几分之几？放大前后涂色部分的大小变了吗？为什么两个分数相等？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-equivalence', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '1/2 的条带做一次"同乘 2"，写出新分数，并回答大小是否变化、为什么相等。' },
    { level: 2, label: '概念提示', text: '同乘只是把每份切得更细，涂色的区域没有变。' },
    { level: 3, label: '策略提示', text: '分子分母各乘 2：1/2 → 2/4；看图上涂色的长度。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f2g1.why', prompt: '1/2 = 2/4 的原因是？', options: [
        { id: 'opt-both-scaled', label: '分子和分母乘了同一个数，大小不变' },
        { id: 'opt-num-bigger', label: '分子变大了所以分数变大' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '如果同乘 3，分数会变成几？大小呢？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '条带（SVG）：×2/×3 按钮与键盘（+ 键 ×2）经确认后重绘份数与涂色。',
    boardTable: '份数/涂色份数读数表；同一状态与判分。',
  },
});

addTask({
  taskId: 'thm.f2.g2.equivalent-find.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'GUIDED',
  title: '找出 6/8：把 3/4 放大',
  boardView: 'BAR',
  givens: gridGivens(1, 4, 3),
  givenLocks: ['rows'],
  responseSchemaId: 'resp.thm.f2g2.v1',
  allowedOperationIds: ['ScaleBoth'],
  operationConstraints: [{ type: 'ScaleBoth', multipliers: [2] }],
  prompt: [
    { type: 'TEXT', text: '把 3/4 写成分母是 8 的等值分数' },
    { type: 'TEXT', text: '右侧条带现在是 3/4。任务：用一次"同乘 2"把它变成分子是 6 的等值分数，确认。' },
    { type: 'TEXT', text: '回答：现在的分数是几分之几？它和 3/4 相等的原因是什么？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-equivalence', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '3/4 同乘 2 得到分子是 6 的分数，写出它并说明相等的原因。' },
    { level: 2, label: '概念提示', text: '等值分数：分子分母同乘一个数，大小不变。' },
    { level: 3, label: '策略提示', text: '分母 4×2=8，分子 3×2=6；两个数要"一起"乘。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f2g2.mistake', prompt: '有同学写成了 6/4，他可能哪里错了？', options: [
        { id: 'opt-only-num', label: '只把分子乘了 2，分母没乘' },
        { id: 'opt-only-den', label: '只把分母乘了 2' },
        { id: 'opt-both', label: '两个都乘了' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '再写一个和 3/4 相等的分数，并说说你是怎么得到的。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '条带（SVG）随同乘确认重绘。',
    boardTable: '份数/涂色份数读数表；同一判分。',
  },
});

addTask({
  taskId: 'thm.f2.i1.numberline.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'INDEPENDENT',
  title: '独立练习 · 数轴上的点',
  boardView: 'NUMBERLINE',
  givens: gridGivens(1, 6, 2),
  givenLocks: ['rows', 'cols', 'filled'],
  responseSchemaId: 'resp.thm.f2i1.v1',
  allowedOperationIds: [],
  operationConstraints: [],
  prompt: [
    { type: 'TEXT', text: '独立练习：读出数轴上的点' },
    { type: 'TEXT', text: '右侧数轴上，0 到 1 被平均分成 6 格，有一个点停在第 2 格的刻度线上。' },
    { type: 'TEXT', text: '(1) 这个点表示的分数是几分之几？(2) 下面哪个分数和它相等？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '6 格走到第 2 格，写出分数，再选出与它相等的分数。' },
    { level: 2, label: '概念提示', text: '总格数作分母、走过格数作分子；等值要分子分母同除一个数。' },
    { level: 3, label: '策略提示', text: '2/6 的 2 和 6 都能除以 2。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f2i1.reduce', prompt: '把分数变简单（约分）时，分子分母要？', options: [
        { id: 'opt-divide-same', label: '除以同一个数' },
        { id: 'opt-subtract', label: '各减去 1' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '数轴上再找一个位置，写出它的两个等值分数。',
  },
  exitEvidence: ['firstPrediction', 'submission', 'explanation'],
  expressions: {
    boardSvg: '数轴（SVG）静态呈现点位置。',
    boardTable: '份数/走过格数读数表；同一判分。',
  },
});

addTask({
  taskId: 'thm.f2.s1.stranger.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'STRANGER',
  title: '陌生情境 · 折纸比赛',
  boardView: 'BAR',
  givens: gridGivens(1, 2, 1),
  givenLocks: ['rows'],
  responseSchemaId: 'resp.thm.f2s1.v1',
  allowedOperationIds: ['ScaleBoth'],
  operationConstraints: [{ type: 'ScaleBoth', multipliers: [2, 4] }],
  prompt: [
    { type: 'TEXT', text: '陌生情境：谁涂的纸大？' },
    { type: 'TEXT', text: '折纸活动：小明把一张纸对折一次，涂了 1 份（他说涂了 1/2）；小红把同样大的纸对折两次，涂了 2 份（她说涂了 2/4）。两张纸一样大。' },
    { type: 'TEXT', text: '(1) 谁涂的面积大？(2) 右侧条带现在是 1/2：用"同乘"把它变成分母是 8 的分数（分子分母一起乘），确认后写出这个分数。' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-equivalence', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'], note: '陌生任务复测等值概念' },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '判断 1/2 和 2/4 谁大；再把 1/2 用同乘变成分母是 8 的分数。' },
    { level: 2, label: '概念提示', text: '对折两次只是把每份切得更细，涂的比例没变。' },
    { level: 3, label: '策略提示', text: '1/2 分子分母同乘 4。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f2s1.same', prompt: '1/2 和 2/4 为什么一样大？', options: [
        { id: 'opt-same-proportion', label: '分子分母同乘 2，涂的比例不变' },
        { id: 'opt-lucky', label: '碰巧相等' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '向家人解释折纸比赛的结果。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '条带（SVG）同乘操作经确认重绘。',
    boardTable: '份数/涂色份数读数表；同一判分。',
  },
});

addTask({
  taskId: 'thm.f2.d1.delayed-transfer.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'DELAYED_TRANSFER',
  title: '回看练习 · 约分',
  boardView: 'BAR',
  givens: gridGivens(1, 6, 2),
  givenLocks: ['rows', 'cols', 'filled'],
  responseSchemaId: 'resp.thm.f2d1.v1',
  allowedOperationIds: ['ScaleBoth'],
  operationConstraints: [{ type: 'ScaleBoth', multipliers: [2, 3] }],
  prompt: [
    { type: 'TEXT', text: '回看练习：判断与约分（隔几天后再来）' },
    { type: 'TEXT', text: '(1) 3/9 和 1/3 相等吗？(2) 把 2/6 化成分子、分母都最小的等值分数（右侧条带可以帮助你检查，可同乘后再对照）。' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '提示信息' }, { label: '内容' }], rows: [
      ['右侧面板', '当前显示 2/6 的条带'],
      ['同乘方向提示', '约分与同乘是反方向的操作'],
    ] },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '判断 3/9 与 1/3 是否相等；把 2/6 约到最简。' },
    { level: 2, label: '概念提示', text: '分子分母同除一个数，大小不变；最简就是分子分母只剩公因数 1。' },
    { level: 3, label: '策略提示', text: '3/9 的 3 和 9 都除以 3；2/6 的 2 和 6 都除以 2。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f2d1.direction', prompt: '同乘和约分是什么关系？', options: [
        { id: 'opt-inverse', label: '互为反方向：一个放大份数，一个缩小份数' },
        { id: 'opt-unrelated', label: '没有关系' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '隔了这些天，你是怎么想起来的？',
  },
  exitEvidence: ['firstPrediction', 'submission', 'explanation'],
  expressions: {
    boardSvg: '条带（SVG）同乘检查用。',
    boardTable: '份数/涂色份数读数表；同一判分。',
  },
});

// ===== 主题一 课3 分配或折扣情境的问题链 ====================================

addTask({
  taskId: 'thm.f3.g1.percent-board.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'GUIDED',
  title: '百格板上的百分数',
  boardView: 'HUNDRED',
  givens: gridGivens(10, 10, 0),
  givenLocks: ['rows', 'cols'],
  responseSchemaId: 'resp.thm.f3g1.v1',
  allowedOperationIds: ['SetFilled'],
  operationConstraints: [{ type: 'SetFilled', maxCount: 100 }],
  prompt: [
    { type: 'TEXT', text: '涂出 75%' },
    { type: 'TEXT', text: '右侧是一块 10×10 的百格板（100 个同样大的小格）。术语：百分数表示一个数是另一个数（一百份的整体）的百分之几；1% 就是百分之一，写作 1/100。' },
    { type: 'TEXT', text: '操作：用步进按钮或上下方向键把涂色格数调到 75，确认。' },
    { type: 'TEXT', text: '回答：涂色部分是百格板的百分之几（用百分数作答）？75% 里面有几个 1%？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-percent', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '百格板涂 75 格：写出百分数，数出有几个 1%。' },
    { level: 2, label: '概念提示', text: '百分数的分母固定是 100；涂 75 格就是 75/100。' },
    { level: 3, label: '策略提示', text: '涂几格就是百分之几；1 格 = 1%。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f3g1.unit', prompt: '百分数和"个"有什么不同？', options: [
        { id: 'opt-part-of-hundred', label: '百分数表示占一百份中的几份，不是计数个数' },
        { id: 'opt-same', label: '没什么不同' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '如果涂 100 格，是百分之几？涂 50 格呢？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '百格板（SVG）随确认的涂色格数逐格填充。',
    boardTable: '涂色格数/总格数读数表；同一判分。',
  },
});

addTask({
  taskId: 'thm.f3.g2.discount-chain.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'GUIDED',
  title: '问题链 · 书包打八折',
  boardView: 'HUNDRED',
  givens: gridGivens(10, 10, 0),
  givenLocks: ['rows', 'cols'],
  responseSchemaId: 'resp.thm.f3g2.v1',
  allowedOperationIds: ['SetFilled'],
  operationConstraints: [{ type: 'SetFilled', maxCount: 100 }],
  prompt: [
    { type: 'TEXT', text: '问题链：书包打八折' },
    { type: 'TEXT', text: '术语：打八折的意思是现价是原价的 80%（百分之八十）；"几折"就是十分之几，也就是百分之几十。' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '已知' }, { label: '数值' }, { label: '单位' }], rows: [
      ['书包原价', '80.00', '元'],
      ['折扣', '八折', '—'],
    ] },
    { type: 'TEXT', text: '先在百格板上把"八折对应的百分数"涂出来（涂到 80 格）并确认。然后依次回答：(1) 八折是百分之几？(2) 买这个书包应付多少元？(3) 比原价便宜了多少元？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-discount', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '原价 80 元打八折：先写八折的百分数，再算应付的钱和便宜的钱。' },
    { level: 2, label: '概念提示', text: '八折 = 现价是原价的 80%；便宜的是原价的 20%。' },
    { level: 3, label: '策略提示', text: '应付 = 原价 × 80%；便宜 = 原价 − 应付。先乘再减，顺序不能反着想成先加。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f3g2.fold', prompt: '"八折"表示什么？', options: [
        { id: 'opt-80-of-price', label: '现价是原价的 80%' },
        { id: 'opt-8-of-price', label: '现价是原价的 8%' },
        { id: 'opt-80-off', label: '便宜 80 元' },
        UNSURE,
      ] },
      { itemId: 'explain.f3g2.order', prompt: '算应付的钱时，正确的顺序是？', options: [
        { id: 'opt-multiply-first', label: '先用原价乘 80%（打折是乘，不是加）' },
        { id: 'opt-add-first', label: '先把原价加上一成再算' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '如果打九折，应付多少元？写出你的算式。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '百格板（SVG）涂出折扣对应的百分数。',
    boardTable: '涂色格数读数表；同一判分。',
  },
});

addTask({
  taskId: 'thm.f3.i1.allocate.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'INDEPENDENT',
  title: '独立练习 · 按 3:2 分珠子',
  boardView: 'DOTARRAY',
  givens: gridGivens(3, 12, 36),
  givenLocks: [],
  responseSchemaId: 'resp.thm.f3i1.v1',
  allowedOperationIds: ['SetGridSize', 'SetFilled'],
  operationConstraints: [
    { type: 'SetGridSize', rowsValues: Array.from({ length: 12 }, (_, i) => i + 1), colsValues: Array.from({ length: 12 }, (_, i) => i + 1) },
    { type: 'SetFilled', maxCount: 144 },
  ],
  prompt: [
    { type: 'TEXT', text: '独立练习：按 3:2 分 60 颗珠子' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '已知' }, { label: '数值' }, { label: '单位' }], rows: [
      ['珠子总数', '60', '颗'],
      ['甲 : 乙', '3 : 2', '—'],
    ] },
    { type: 'TEXT', text: '右侧点阵当前摆出了甲分到的珠子（3 行、每行 12 颗），可以用它检查你的计算，也可以自己调整。依次回答：(1) 一份是多少颗？(2) 甲分到多少颗？(3) 乙分到多少颗？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '60 颗按 3:2 分给甲乙：先求一份，再求各自分到的。' },
    { level: 2, label: '概念提示', text: '3:2 说明总共分成 3+2=5 份，每份同样多。' },
    { level: 3, label: '策略提示', text: '每份 = 60 ÷ 5；甲 = 每份 × 3；乙 = 每份 × 2。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f3i1.first', prompt: '解按比例分配，第一步先求什么？', options: [
        { id: 'opt-one-share', label: '先求一份是多少（总数 ÷ 份数和）' },
        { id: 'opt-half-first', label: '先对半分' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '如果改成按 3:2 分 100 颗，甲分到多少？写出算式。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '点阵（SVG）呈现/调整甲乙的份数建模。',
    boardTable: '行/每行/总数读数表；同一判分。',
  },
});

addTask({
  taskId: 'thm.f3.s1.stranger.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'STRANGER',
  title: '陌生情境 · 第二件半价还是全店八折',
  boardView: 'HUNDRED',
  givens: gridGivens(10, 10, 0),
  givenLocks: ['rows', 'cols', 'filled'],
  responseSchemaId: 'resp.thm.f3s1.v1',
  allowedOperationIds: [],
  operationConstraints: [],
  prompt: [
    { type: 'TEXT', text: '陌生情境：两店比价' },
    { type: 'TEXT', text: '买 2 支同款钢笔，每支 40.00 元。甲店促销"第二件半价"（第二支按 50% 价钱）；乙店促销"全店八折"（每件都按 80% 价钱）。' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '已知' }, { label: '数值' }, { label: '单位' }], rows: [
      ['钢笔单价', '40.00', '元'],
      ['购买数量', '2', '支'],
      ['甲店优惠', '第二件半价（50%）', '—'],
      ['乙店优惠', '全店八折（80%）', '—'],
    ] },
    { type: 'TEXT', text: '依次回答：(1) 在甲店买 2 支共付多少元？(2) 在乙店买 2 支共付多少元？(3) 哪家店更便宜？(4) 便宜多少元？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.term-percent', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'], note: '陌生任务复测百分数概念' },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '同款 2 支、每支 40 元：分别算两店总价、比较、算差价。' },
    { level: 2, label: '概念提示', text: '半价 = 50%；八折 = 80%。两店的优惠作用在不同的支数上。' },
    { level: 3, label: '策略提示', text: '甲店：40 + 40×50%；乙店：(40+40)×80%；最后相减。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f3s1.key', prompt: '这道题的关键在哪？', options: [
        { id: 'opt-apply-to-what', label: '看清优惠作用在哪一件/哪几件上，再算百分比' },
        { id: 'opt-bigger-percent', label: '百分比大的店一定便宜' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '如果只买 1 支，哪家便宜？为什么？',
  },
  exitEvidence: ['firstPrediction', 'submission', 'explanation'],
  expressions: {
    boardSvg: '百格板（SVG）图例：50% 与 80% 的面积直观对照（静态）。',
    boardTable: '单价/数量/百分比对照表；同一判分。',
  },
});

addTask({
  taskId: 'thm.f3.d1.delayed-transfer.v1',
  taskFamily: 'themes.frac.v1',
  kind: 'DELAYED_TRANSFER',
  title: '回看练习 · 水壶打九折',
  boardView: 'HUNDRED',
  givens: gridGivens(10, 10, 0),
  givenLocks: ['rows', 'cols'],
  responseSchemaId: 'resp.thm.f3d1.v1',
  allowedOperationIds: ['SetFilled'],
  operationConstraints: [{ type: 'SetFilled', maxCount: 100 }],
  prompt: [
    { type: 'TEXT', text: '回看练习：水壶打九折（隔几天后再来）' },
    { type: 'MEASUREMENT_TABLE', columns: [{ label: '已知' }, { label: '数值' }, { label: '单位' }], rows: [
      ['水壶原价', '50.00', '元'],
      ['折扣', '九折', '—'],
    ] },
    { type: 'TEXT', text: '先在百格板上涂出九折对应的百分数（涂到 90 格）并确认。依次回答：(1) 九折是百分之几？(2) 应付多少元？(3) 比原价便宜多少元？' },
  ],
  visibility: [
    { material: 'board.figure', phases: ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'view.controls', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.state-readout', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '原价 50 元打九折：写百分数、算应付和便宜的钱。' },
    { level: 2, label: '概念提示', text: '九折 = 现价是原价的 90%。' },
    { level: 3, label: '策略提示', text: '应付 = 50 × 90%；便宜 = 50 − 应付。' },
  ],
  explain: {
    selections: [
      { itemId: 'explain.f3d1.recall', prompt: '隔了这些天，你是怎么想起来的？', options: [
        { id: 'opt-fold-ten', label: '想起"几折就是十分之几/百分之几十"' },
        { id: 'opt-retried', label: '在百格板上又涂了一遍' },
        UNSURE,
      ] },
    ],
    freeTextPrompt: '写出你解这道题的两步算式。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    boardSvg: '百格板（SVG）涂出九折对应百分数。',
    boardTable: '涂色格数读数表；同一判分。',
  },
});

// ---------------------------------------------------------------------------
// response schema registry (public; drives player forms)
// ---------------------------------------------------------------------------
const registry = {
  registryVersion: '1',
  representationNote:
    'themes 微课/主题一 VERIFY 响应载体：numberWithUnit（数值+单位）/ fractionValue（分子/分母两个整数框）/ singleChoice（单项选择）/ objectMapping（稳定对象配对）。分数不用自由文本，避免书写格式错误伪装成概念错误。',
  schemas: [],
};
function addSchema(schemaId, summary, predict, verify) {
  registry.schemas.push({ schemaId, summary, predict, verify });
}

addSchema('resp.thm.m1diag.v1', '微课①诊断：直径/半径互算 + 关系 + 方向', {
  asks: [
    askChoice('ask.m1d.guess', '先快猜：直径和半径是什么关系？', [
      { id: 'opt-d-eq-2r', label: '直径 = 半径 × 2' },
      { id: 'opt-d-eq-r-plus-2', label: '直径 = 半径 + 2' },
      UNSURE,
    ]),
  ],
}, {
  items: [
    itemNumber('(1) 半径 2.5 cm 的圆，直径是多少？', 'diameter-from-r', '直径', LENGTH_UNITS, 1),
    itemNumber('(2) 直径 12 cm 的圆，半径是多少？', 'radius-from-d', '半径', LENGTH_UNITS, 1),
    itemChoice('(3) 直径和半径的关系是：', 'sel.relation', [
      { id: 'opt-d-eq-2r', label: '直径 = 半径 × 2' },
      { id: 'opt-d-eq-r-plus-2', label: '直径 = 半径 + 2' },
      UNSURE,
    ]),
    itemChoice('(4) 半径变大时，直径会：', 'sel.direction', [
      { id: 'INCREASE', label: '变大' },
      { id: 'DECREASE', label: '变小' },
      { id: 'UNCHANGED', label: '不变' },
      UNSURE,
    ]),
  ],
});

addSchema('resp.thm.m1supp.v1', '微课①补充：直径读数 + 目标半径', {
  asks: [askNumber('ask.m1s.d', '先猜：半径 3.5 cm 时直径大约是多少？（记录用，不判分）', '直径', LENGTH_UNITS)],
}, {
  items: [
    itemNumber('① 现在（半径已调到 3.5 cm）圆的直径是多少？', 'diameter-now', '直径', LENGTH_UNITS, 1),
    itemNumber('② 要让直径等于 12.0 cm，半径应调到多少？', 'radius-target', '半径', LENGTH_UNITS, 1),
  ],
});

addSchema('resp.thm.m2diag.v1', '微课②诊断：面积 + 单位 + 换算', {
  asks: [askNumber('ask.m2d.guess', '先猜：5 cm × 3 cm 的长方形面积大约是多少？（记录用，不判分）', '面积', AREA_UNITS)],
}, {
  items: [
    itemNumber('(1) 长方形（长 5 cm、宽 3 cm）的面积是多少？', 'rect-area', '面积', AREA_UNITS, 0),
    itemChoice('(2) 边长 1 cm 的正方形，面积是多少？', 'sel.square-unit', [
      { id: 'opt-1-cm', label: '1 厘米（cm）' },
      { id: 'opt-1-cm2', label: '1 平方厘米（cm²）' },
      UNSURE,
    ]),
    itemChoice('(3) 面积单位为什么带"平方"？', 'sel.why-square', [
      { id: 'opt-length-times-length', label: '因为面积是长度 × 长度' },
      { id: 'opt-task-rule', label: '题目规定这样写' },
      UNSURE,
    ]),
    itemNumber('(4) 1 dm² 等于多少 cm²？', 'dm2-to-cm2', '面积', [U.cm2], 0),
  ],
});

addSchema('resp.thm.m2supp.v1', '微课②补充：面积读数 + 反求长', {
  asks: [askNumber('ask.m2s.guess', '先猜：4 行 × 6 列（每格 1 cm²）面积大约是多少？（记录用，不判分）', '面积', AREA_UNITS)],
}, {
  items: [
    itemNumber('① 现在（4 行 × 6 列）长方形的面积是多少？', 'area-now', '面积', AREA_UNITS, 0),
    itemNumber('② 面积要做成 18 cm²、宽 6 cm，长应是多少厘米？', 'length-needed', '长', LENGTH_UNITS, 0),
  ],
});

addSchema('resp.thm.m3diag.v1', '微课③诊断：乘除三问 + 关系', {
  asks: [askNumber('ask.m3d.guess', '先猜：每盒 6 支装 4 盒，一共大约多少支？（记录用，不判分）', '总数', GE_UNITS)],
}, {
  items: [
    itemNumber('(1) 每盒 6 支、装 4 盒，一共多少支？', 'total-mul', '总数', GE_UNITS, 0),
    itemNumber('(2) 24 支、每 6 支一盒，能装几盒？', 'count-div-per', '盒数', GE_UNITS, 0),
    itemNumber('(3) 24 支、平均装 4 盒，每盒几支？', 'per-div-count', '每盒支数', GE_UNITS, 0),
    itemChoice('(4) 总数、每份数、份数的关系是：', 'sel.relation', [
      { id: 'opt-total-eq-per-times-count', label: '总数 = 每份数 × 份数' },
      { id: 'opt-total-eq-per-plus-count', label: '总数 = 每份数 + 份数' },
      UNSURE,
    ]),
  ],
});

addSchema('resp.thm.m3supp.v1', '微课③补充：点阵总数 + 两问', {
  asks: [askNumber('ask.m3s.guess', '先猜：4 行、每行 6 个一共多少个？（记录用，不判分）', '总数', GE_UNITS)],
}, {
  items: [
    itemNumber('① 现在（4 行 × 每行 6 个）点阵一共多少个？', 'total-now', '总数', GE_UNITS, 0),
    itemNumber('② 每行 8 个、摆 3 行，一共多少个？', 'total-8-3', '总数', GE_UNITS, 0),
    itemNumber('③ 36 个、每行 9 个，能摆几行？', 'rows-36-9', '行数', GE_UNITS, 0),
  ],
});

addSchema('resp.thm.m4diag.v1', '微课④诊断：单位分类 + 换算', {
  asks: [askChoice('ask.m4d.guess', '先快猜：cm² 是哪类单位？', DIM_OPTIONS)],
}, {
  items: [
    itemMapping('(1) 把三个单位分别放入长度 / 面积 / 体积：', [
      pair('unit-cm', '厘米（cm）', DIM_OPTIONS),
      pair('unit-cm2', '平方厘米（cm²）', DIM_OPTIONS),
      pair('unit-cm3', '立方厘米（cm³）', DIM_OPTIONS),
    ]),
    itemChoice('(2) 测量课桌面的大小，用哪类单位？', 'sel.desk', [
      { id: 'opt-length-unit', label: '长度单位' },
      { id: 'opt-area-unit', label: '面积单位' },
      { id: 'opt-volume-unit', label: '体积单位' },
      UNSURE,
    ]),
    itemChoice('(3) 1 m² 等于多少 dm²？', 'sel.m2-to-dm2', [
      { id: 'opt-10', label: '10' },
      { id: 'opt-100', label: '100' },
      { id: 'opt-1000', label: '1000' },
      UNSURE,
    ]),
    itemChoice('(4) 棱长 1 cm 的正方体，体积是多少？', 'sel.cube', [
      { id: 'opt-1-cm', label: '1 厘米（cm）' },
      { id: 'opt-1-cm2', label: '1 平方厘米（cm²）' },
      { id: 'opt-1-cm3', label: '1 立方厘米（cm³）' },
      UNSURE,
    ]),
  ],
});

addSchema('resp.thm.m4supp.v1', '微课④补充：六单位分类 + 两问', {
  asks: [askChoice('ask.m4s.guess', '先快猜：dm³ 是哪类单位？', DIM_OPTIONS)],
}, {
  items: [
    itemMapping('(1) 把六个单位分别放入长度 / 面积 / 体积：', [
      pair('unit-mm', '毫米（mm）', DIM_OPTIONS),
      pair('unit-cm2', '平方厘米（cm²）', DIM_OPTIONS),
      pair('unit-dm3', '立方分米（dm³）', DIM_OPTIONS),
      pair('unit-m', '米（m）', DIM_OPTIONS),
      pair('unit-m2', '平方米（m²）', DIM_OPTIONS),
      pair('unit-cm3', '立方厘米（cm³）', DIM_OPTIONS),
    ]),
    itemChoice('(2) 一本字典占的空间大小，用哪个单位最合适？', 'sel.dict', [
      { id: 'opt-cm', label: '厘米（cm）' },
      { id: 'opt-cm2', label: '平方厘米（cm²）' },
      { id: 'opt-cm3', label: '立方厘米（cm³）' },
      UNSURE,
    ]),
    itemChoice('(3) "操场的面积是 300 米"这句话错在哪？', 'sel.playground', [
      { id: 'opt-area-needs-square-unit', label: '面积应该用面积单位（平方米），不能用长度单位' },
      { id: 'opt-number-too-small', label: '数字 300 太小了' },
      { id: 'opt-no-mistake', label: '没有错' },
      UNSURE,
    ]),
  ],
});

addSchema('resp.thm.f1g1.v1', '课1引导1：等分圆盘写分数', {
  asks: [askFraction('ask.f1g1.guess', '先猜：平均分 4 份涂 3 份，涂色部分是几分之几？（记录用，不判分）', '涂色部分')],
}, {
  items: [
    itemFraction('涂色部分是这个圆盘的几分之几？（按你确认后的图板作答）', 'circle-fraction', '涂色部分'),
    itemChoice('分数中的分母 4 表示什么？', 'sel.denom-meaning', [
      { id: 'opt-total-parts', label: '整体被平均分成的总份数' },
      { id: 'opt-taken-parts', label: '取走（涂色）的份数' },
      UNSURE,
    ]),
    itemChoice('如果分成的 4 份大小不一样，还能说涂了 3 份就是 3/4 吗？', 'sel.unequal-parts', [
      { id: 'opt-no', label: '不能（没有平均分）' },
      { id: 'opt-yes', label: '能' },
      UNSURE,
    ]),
  ],
});

addSchema('resp.thm.f1g2.v1', '课1引导2：条带 + 数轴', {
  asks: [askFraction('ask.f1g2.guess', '先猜：8 份涂 5 份是几分之几？（记录用，不判分）', '涂色部分')],
}, {
  items: [
    itemFraction('涂色部分是整条条带的几分之几？（按你确认后的图板作答）', 'bar-fraction', '涂色部分'),
    itemChoice('这个分数和 1/2 相比：', 'sel.compare-half', [
      { id: 'opt-58-bigger', label: '比 1/2 大（点已越过中点）' },
      { id: 'opt-58-smaller', label: '比 1/2 小' },
      { id: 'opt-equal', label: '和 1/2 一样大' },
      UNSURE,
    ]),
  ],
});

addSchema('resp.thm.f1i1.v1', '课1独立：读图写分数', {
  asks: [askFraction('ask.f1i1.guess', '先猜：10 格涂 7 格是几分之几？（记录用，不判分）', '涂色部分')],
}, {
  items: [
    itemFraction('涂色部分是这条巧克力的几分之几？', 'bar-fraction', '涂色部分'),
    itemChoice('分数中的分子表示什么？', 'sel.num-meaning', [
      { id: 'opt-num-taken', label: '涂色（取走）的份数' },
      { id: 'opt-num-total', label: '总份数' },
      UNSURE,
    ]),
  ],
});

addSchema('resp.thm.f1s1.v1', '课1陌生：未平均分反例 + 修正操作', {
  asks: [askChoice('ask.f1s1.guess', '先猜：大小不一的 4 块拿 1 块，能叫 1/4 吗？', [
    { id: 'opt-yes', label: '能' },
    { id: 'opt-no', label: '不能' },
    UNSURE,
  ])],
}, {
  items: [
    itemChoice('(1) 小明能说他拿到了这张披萨的 1/4 吗？', 'sel.can-say-quarter', [
      { id: 'opt-no-not-equal', label: '不能——4 份大小不一样，不是平均分' },
      { id: 'opt-yes-any-4', label: '能——反正是 4 块中的 1 块' },
      UNSURE,
    ]),
    itemFraction('(2) 按你重新切好并确认的圆盘，涂色部分是几分之几？', 'circle-fraction', '涂色部分'),
  ],
});

addSchema('resp.thm.f1d1.v1', '课1回看：蛋糕两问', {
  asks: [askFraction('ask.f1d1.guess', '先猜：8 块吃 3 块是几分之几？（记录用，不判分）', '上午吃的')],
}, {
  items: [
    itemFraction('(1) 上午吃的是这块蛋糕的几分之几？（按你确认后的涂色作答）', 'morning-fraction', '上午吃的'),
    itemFraction('(2) 这一天一共吃掉的是几分之几？', 'whole-day-fraction', '全天吃的'),
  ],
});

addSchema('resp.thm.f2g1.v1', '课2引导1：同乘 2', {
  asks: [askFraction('ask.f2g1.guess', '先猜：1/2 同乘 2 之后是几分之几？（记录用，不判分）', '新分数')],
}, {
  items: [
    itemFraction('现在的分数是几分之几？（按你确认后的图板作答）', 'scaled-fraction', '新分数'),
    itemChoice('放大前后，涂色部分的大小：', 'sel.size-change', [
      { id: 'opt-same-size', label: '没有变（还是同一部分）' },
      { id: 'opt-bigger', label: '变大了' },
      { id: 'opt-smaller', label: '变小了' },
      UNSURE,
    ]),
    itemChoice('两个分数相等的原因是：', 'sel.why-equal', [
      { id: 'opt-both-scaled', label: '分子和分母乘了同一个数' },
      { id: 'opt-num-only', label: '只是分子变大了' },
      UNSURE,
    ]),
  ],
});

addSchema('resp.thm.f2g2.v1', '课2引导2：找等值分数', {
  asks: [askFraction('ask.f2g2.guess', '先猜：3/4 同乘 2 之后是几分之几？（记录用，不判分）', '新分数')],
}, {
  items: [
    itemFraction('现在的分数是几分之几？（按你确认后的图板作答）', 'scaled-fraction', '新分数'),
    itemChoice('它和 3/4 相等的原因是：', 'sel.why-eq', [
      { id: 'opt-num-den-same-times', label: '分子分母同时乘了 2' },
      { id: 'opt-num-only', label: '只有分子乘了 2' },
      UNSURE,
    ]),
  ],
});

addSchema('resp.thm.f2i1.v1', '课2独立：读点 + 等值选择', {
  asks: [askFraction('ask.f2i1.guess', '先猜：6 格走到第 2 格是几分之几？（记录用，不判分）', '点表示的分数')],
}, {
  items: [
    itemFraction('(1) 这个点表示的分数是几分之几？', 'point-fraction', '点表示的分数'),
    itemChoice('(2) 下面哪个分数和它相等？', 'sel.eq-choice', [
      { id: 'opt-1-3', label: '1/3' },
      { id: 'opt-2-3', label: '2/3' },
      { id: 'opt-1-6', label: '1/6' },
      UNSURE,
    ]),
  ],
});

addSchema('resp.thm.f2s1.v1', '课2陌生：折纸比较 + 分母 8', {
  asks: [askChoice('ask.f2s1.guess', '先猜：1/2 和 2/4 谁涂得多？', [
    { id: 'opt-ming', label: '小明（1/2）' },
    { id: 'opt-hong', label: '小红（2/4）' },
    { id: 'opt-same', label: '一样多' },
    UNSURE,
  ])],
}, {
  items: [
    itemChoice('(1) 谁涂的面积大？', 'sel.who-more', [
      { id: 'opt-same', label: '一样大（2/4 = 1/2）' },
      { id: 'opt-ming', label: '小明大' },
      { id: 'opt-hong', label: '小红大' },
      UNSURE,
    ]),
    itemFraction('(2) 按你确认后的图板，1/2 写成分母是 8 的分数是？', 'denom-8-fraction', '新分数'),
  ],
});

addSchema('resp.thm.f2d1.v1', '课2回看：判断 + 约分', {
  asks: [askChoice('ask.f2d1.guess', '先猜：3/9 和 1/3 相等吗？', [
    { id: 'opt-equal', label: '相等' },
    { id: 'opt-not-equal', label: '不相等' },
    UNSURE,
  ])],
}, {
  items: [
    itemChoice('(1) 3/9 和 1/3 相等吗？', 'sel.eq-judge', [
      { id: 'opt-equal', label: '相等（分子分母同除 3）' },
      { id: 'opt-not-equal', label: '不相等' },
      UNSURE,
    ]),
    itemFraction('(2) 把 2/6 化成分子、分母都最小的等值分数：', 'reduced-fraction', '最简分数'),
  ],
});

addSchema('resp.thm.f3g1.v1', '课3引导1：百格板百分数', {
  asks: [askNumber('ask.f3g1.guess', '先猜：涂 75 格是百分之几？（记录用，不判分）', '百分数', PERCENT_UNITS)],
}, {
  items: [
    itemNumber('涂色部分是百格板的百分之几？（按你确认后的图板作答）', 'percent-value', '百分数', PERCENT_UNITS, 0),
    itemChoice('百分数表示的是：', 'sel.percent-meaning', [
      { id: 'opt-part-of-hundred', label: '一个数是一百份整体中的几份' },
      { id: 'opt-count-things', label: '东西的个数' },
      UNSURE,
    ]),
    itemNumber('75% 里面有几个 1%？', 'percent-units', '个数', GE_UNITS, 0),
  ],
});

addSchema('resp.thm.f3g2.v1', '课3引导2：折扣问题链', {
  asks: [askNumber('ask.f3g2.guess', '先猜：八折大约是百分之几十？（记录用，不判分）', '百分数', PERCENT_UNITS)],
}, {
  items: [
    itemNumber('(1) 八折是百分之几？', 'fold-percent', '百分数', PERCENT_UNITS, 0),
    itemNumber('(2) 买这个书包应付多少元？', 'pay-amount', '应付金额', YUAN_UNITS, 2),
    itemNumber('(3) 比原价便宜了多少元？', 'save-amount', '便宜金额', YUAN_UNITS, 2),
  ],
});

addSchema('resp.thm.f3i1.v1', '课3独立：按比例分配', {
  asks: [askNumber('ask.f3i1.guess', '先猜：一份大约多少颗？（记录用，不判分）', '每份', GE_UNITS)],
}, {
  items: [
    itemNumber('(1) 一份是多少颗？', 'share-per', '每份', GE_UNITS, 0),
    itemNumber('(2) 甲分到多少颗？', 'part-a', '甲', GE_UNITS, 0),
    itemNumber('(3) 乙分到多少颗？', 'part-b', '乙', GE_UNITS, 0),
  ],
});

addSchema('resp.thm.f3s1.v1', '课3陌生：两店比价问题链', {
  asks: [askNumber('ask.f3s1.guess', '先猜：哪家店更便宜？先估个数（记录用，不判分）', '便宜金额', YUAN_UNITS)],
}, {
  items: [
    itemNumber('(1) 甲店（第二件半价）买 2 支共付多少元？', 'store-a-pay', '甲店总价', YUAN_UNITS, 2),
    itemNumber('(2) 乙店（全店八折）买 2 支共付多少元？', 'store-b-pay', '乙店总价', YUAN_UNITS, 2),
    itemChoice('(3) 哪家店更便宜？', 'sel.cheaper', [
      { id: 'opt-store-a', label: '甲店（第二件半价）' },
      { id: 'opt-store-b', label: '乙店（全店八折）' },
      { id: 'opt-same-price', label: '一样便宜' },
      UNSURE,
    ]),
    itemNumber('(4) 便宜多少元？', 'diff-amount', '差价', YUAN_UNITS, 2),
  ],
});

addSchema('resp.thm.f3d1.v1', '课3回看：九折问题链', {
  asks: [askNumber('ask.f3d1.guess', '先猜：九折大约是百分之几十？（记录用，不判分）', '百分数', PERCENT_UNITS)],
}, {
  items: [
    itemNumber('(1) 九折是百分之几？', 'fold-percent', '百分数', PERCENT_UNITS, 0),
    itemNumber('(2) 应付多少元？', 'pay-amount', '应付金额', YUAN_UNITS, 2),
    itemNumber('(3) 比原价便宜多少元？', 'save-amount', '便宜金额', YUAN_UNITS, 2),
  ],
});

// ---------------------------------------------------------------------------
// private rules (GRID_TASK_TRUTH; server-side truth, exact values hand-checked)
// ---------------------------------------------------------------------------
const num = (id, quantityId, label, expectedDecimal, unitId, acceptedUnitIds, decimalPlaces) => ({
  id, kind: 'number', quantityId, label,
  source: { kind: 'AUTHORED', unitId, expectedDecimal },
  acceptedUnitIds, rounding: { mode: 'HALF_UP', decimalPlaces },
});
const numState = (id, quantityId, label, derive, acceptedUnitIds, decimalPlaces) => ({
  id, kind: 'number', quantityId, label,
  source: { kind: 'FROM_STATE', derive },
  acceptedUnitIds, rounding: { mode: 'HALF_UP', decimalPlaces },
});
const frac = (id, quantityId, label, source, comparison) => ({
  id, kind: 'fraction', quantityId, label, source, comparison,
});
const choice = (id, label, selectionId, correctOptionId) => ({
  id, kind: 'choice', label, selectionId, correctOptionId,
});
const mapCheck = (id, label, expectedPairs) => ({ id, kind: 'mapping', label, expectedPairs });

const rules = [
  {
    ruleId: 'rule.thm.m1.v1',
    file: 'rule.thm.m1.v1.json',
    boundTasks: ['thm.m1.diag.v1', 'thm.m1.supp.v1'],
    body: {
      kind: 'GRID_TASK_TRUTH',
      entries: {
        'thm.m1.diag.v1': {
          checks: [
            num('c1', 'diameter-from-r', '直径（由半径 2.5 cm）', '5.0', 'cm', ['cm', 'mm'], 1),
            num('c2', 'radius-from-d', '半径（由直径 12 cm）', '6.0', 'cm', ['cm', 'mm'], 1),
            choice('c3', '直径与半径的关系', 'sel.relation', 'opt-d-eq-2r'),
            choice('c4', '半径变大时直径的方向', 'sel.direction', 'INCREASE'),
          ],
          diagnostics: [
            { tag: 'mis-rd-no-double', checkId: 'c1', when: { kind: 'OFF_BY_FACTOR', factor: 0.5 }, feedback: '再看看：直径里能放几条半径？把两条半径接起来再答一次。' },
            { tag: 'mis-rd-no-halving', checkId: 'c2', when: { kind: 'OFF_BY_FACTOR', factor: 2 }, feedback: '想一想：一条直径可以分成几条半径？用除法再算一次。' },
          ],
          reveal: [
            { checkId: 'c1', text: '直径 = 2.5 × 2 = 5.0 cm。' },
            { checkId: 'c2', text: '半径 = 12 ÷ 2 = 6.0 cm。' },
            { checkId: 'c3', text: '直径 = 半径 × 2。' },
            { checkId: 'c4', text: '变大——直径始终是半径的 2 倍。' },
          ],
          feedback: { reviseGeneric: '再想一遍半径和直径的关系（一条直径 = 两条半径）。' },
          diagnosis: { passRule: 'ALL_CHECKS_FIRST_SUBMISSION_NO_ANSWER_HINT', supplementTaskId: 'thm.m1.supp.v1' },
        },
        'thm.m1.supp.v1': {
          checks: [
            numState('c1', 'diameter-now', '直径（当前圆）', 'DIAMETER_CM', ['cm', 'mm'], 1),
            num('c2', 'radius-target', '半径（目标直径 12.0 cm）', '6.0', 'cm', ['cm', 'mm'], 1),
          ],
          scenario: { kind: 'CYLINDER_RADIUS', radiusMm: 35 },
          scenarioFeedback: '请先把半径调到 3.5 cm 并确认，再提交。',
          diagnostics: [
            { tag: 'mis-rd-no-double', checkId: 'c1', when: { kind: 'OFF_BY_FACTOR', factor: 0.5 }, feedback: '读数里半径是 3.5——直径里能放两条半径，再算一次。' },
            { tag: 'mis-rd-no-halving', checkId: 'c2', when: { kind: 'OFF_BY_FACTOR', factor: 2 }, feedback: '这次是"由直径求半径"：用 12.0 除以 2 再答。' },
          ],
          reveal: [
            { checkId: 'c1', text: '半径 3.5 cm 时，直径 = 3.5 × 2 = 7.0 cm。' },
            { checkId: 'c2', text: '半径 = 12.0 ÷ 2 = 6.0 cm。' },
          ],
          feedback: { reviseGeneric: '再确认一次：直径 = 半径 × 2，半径 = 直径 ÷ 2。' },
        },
      },
    },
  },
  {
    ruleId: 'rule.thm.m2.v1',
    file: 'rule.thm.m2.v1.json',
    boundTasks: ['thm.m2.diag.v1', 'thm.m2.supp.v1'],
    body: {
      kind: 'GRID_TASK_TRUTH',
      entries: {
        'thm.m2.diag.v1': {
          checks: [
            num('c1', 'rect-area', '长方形面积（5 cm × 3 cm）', '15', 'cm2', ['cm2', 'mm2', 'dm2'], 0),
            choice('c2', '边长 1 cm 正方形的面积', 'sel.square-unit', 'opt-1-cm2'),
            choice('c3', '面积单位为何带"平方"', 'sel.why-square', 'opt-length-times-length'),
            num('c4', 'dm2-to-cm2', '1 dm² 换算', '100', 'cm2', ['cm2'], 0),
          ],
          diagnostics: [
            { tag: 'mis-perimeter-for-area', checkId: 'c1', when: { kind: 'VALUE_EQUALS', unitId: 'cm2', value: '16' }, feedback: '再检查：16 是把边都加起来（周长）了；面积要用乘法铺格子。' },
          ],
          reveal: [
            { checkId: 'c1', text: '每行 5 格、共 3 行：5 × 3 = 15 cm²。' },
            { checkId: 'c2', text: '1 平方厘米（cm²）。' },
            { checkId: 'c3', text: '面积是长度 × 长度，所以单位带"平方"。' },
            { checkId: 'c4', text: '1 dm = 10 cm，1 dm² = 10 × 10 = 100 cm²。' },
          ],
          feedback: { reviseGeneric: '再想一遍：面积要用乘法（每行个数 × 行数）。' },
          diagnosis: { passRule: 'ALL_CHECKS_FIRST_SUBMISSION_NO_ANSWER_HINT', supplementTaskId: 'thm.m2.supp.v1' },
        },
        'thm.m2.supp.v1': {
          checks: [
            numState('c1', 'area-now', '当前长方形面积', 'GRID_AREA_CM2', ['cm2', 'mm2', 'dm2'], 0),
            num('c2', 'length-needed', '长（面积 18 cm²、宽 6 cm）', '3', 'cm', ['cm', 'mm'], 0),
          ],
          scenario: { kind: 'GRID_AT', rows: 4, cols: 6 },
          scenarioFeedback: '请先把长方形调成 4 行 × 6 列并确认，再提交。',
          diagnostics: [
            { tag: 'mis-perimeter-for-area', checkId: 'c1', when: { kind: 'VALUE_EQUALS', unitId: 'cm2', value: '20' }, feedback: '再检查：20 是 (4+6)×2，那是周长；面积要用 4 × 6。' },
            { tag: 'mis-unit-scale', checkId: 'c1', when: { kind: 'UNIT_MISMATCH' }, feedback: '数值对了，再看看单位——面积要选面积单位。' },
          ],
          reveal: [
            { checkId: 'c1', text: '4 行 × 6 列（每格 1 cm²）：4 × 6 = 24 cm²。' },
            { checkId: 'c2', text: '长 = 18 ÷ 6 = 3 cm。' },
          ],
          feedback: { reviseGeneric: '再想一遍：面积 = 长 × 宽；反过来长 = 面积 ÷ 宽。' },
        },
      },
    },
  },
  {
    ruleId: 'rule.thm.m3.v1',
    file: 'rule.thm.m3.v1.json',
    boundTasks: ['thm.m3.diag.v1', 'thm.m3.supp.v1'],
    body: {
      kind: 'GRID_TASK_TRUTH',
      entries: {
        'thm.m3.diag.v1': {
          checks: [
            num('c1', 'total-mul', '总数（每盒 6 支 × 4 盒）', '24', 'ge', ['ge'], 0),
            num('c2', 'count-div-per', '盒数（24 支 ÷ 每盒 6 支）', '4', 'ge', ['ge'], 0),
            num('c3', 'per-div-count', '每盒支数（24 支 ÷ 4 盒）', '6', 'ge', ['ge'], 0),
            choice('c4', '总数/每份数/份数关系', 'sel.relation', 'opt-total-eq-per-times-count'),
          ],
          diagnostics: [
            { tag: 'mis-add-for-total', checkId: 'c1', when: { kind: 'VALUE_EQUALS', unitId: 'ge', value: '10' }, feedback: '再检查：6+10 是把两个数加起来；"每盒 6 支装 4 盒"要用乘法。' },
          ],
          reveal: [
            { checkId: 'c1', text: '6 × 4 = 24（支）。' },
            { checkId: 'c2', text: '24 ÷ 6 = 4（盒）。' },
            { checkId: 'c3', text: '24 ÷ 4 = 6（支）。' },
            { checkId: 'c4', text: '总数 = 每份数 × 份数。' },
          ],
          feedback: { reviseGeneric: '再想一遍：求总数用乘，求每份数或份数用除。' },
          diagnosis: { passRule: 'ALL_CHECKS_FIRST_SUBMISSION_NO_ANSWER_HINT', supplementTaskId: 'thm.m3.supp.v1' },
        },
        'thm.m3.supp.v1': {
          checks: [
            numState('c1', 'total-now', '当前点阵总数', 'GRID_CELLS', ['ge'], 0),
            num('c2', 'total-8-3', '总数（每行 8 个 × 3 行）', '24', 'ge', ['ge'], 0),
            num('c3', 'rows-36-9', '行数（36 个 ÷ 每行 9 个）', '4', 'ge', ['ge'], 0),
          ],
          scenario: { kind: 'GRID_AT', rows: 4, cols: 6 },
          scenarioFeedback: '请先把点阵调成 4 行、每行 6 个并确认，再提交。',
          reveal: [
            { checkId: 'c1', text: '4 × 6 = 24（个）。' },
            { checkId: 'c2', text: '8 × 3 = 24（个）。' },
            { checkId: 'c3', text: '36 ÷ 9 = 4（行）。' },
          ],
          feedback: { reviseGeneric: '再想一遍：总数 = 每行个数 × 行数；行数 = 总数 ÷ 每行个数。' },
        },
      },
    },
  },
  {
    ruleId: 'rule.thm.m4.v1',
    file: 'rule.thm.m4.v1.json',
    boundTasks: ['thm.m4.diag.v1', 'thm.m4.supp.v1'],
    body: {
      kind: 'GRID_TASK_TRUTH',
      entries: {
        'thm.m4.diag.v1': {
          checks: [
            mapCheck('c1', '单位分类（cm 家族）', [
              { leftId: 'unit-cm', rightId: 'dim-length' },
              { leftId: 'unit-cm2', rightId: 'dim-area' },
              { leftId: 'unit-cm3', rightId: 'dim-volume' },
            ]),
            choice('c2', '测量课桌面大小的单位类型', 'sel.desk', 'opt-area-unit'),
            choice('c3', '1 m² 换算 dm²', 'sel.m2-to-dm2', 'opt-100'),
            choice('c4', '棱长 1 cm 正方体的体积', 'sel.cube', 'opt-1-cm3'),
          ],
          reveal: [
            { checkId: 'c1', text: 'cm 是长度；cm² 是面积；cm³ 是体积。' },
            { checkId: 'c2', text: '面积单位（如平方分米 dm²）。' },
            { checkId: 'c3', text: '1 m = 10 dm，1 m² = 10 × 10 = 100 dm²。' },
            { checkId: 'c4', text: '1 立方厘米（cm³）。' },
          ],
          feedback: { reviseGeneric: '再看一遍图例：线—长度、正方形—面积（平方）、正方体—体积（立方）。' },
          diagnosis: { passRule: 'ALL_CHECKS_FIRST_SUBMISSION_NO_ANSWER_HINT', supplementTaskId: 'thm.m4.supp.v1' },
        },
        'thm.m4.supp.v1': {
          checks: [
            mapCheck('c1', '六个单位分类', [
              { leftId: 'unit-mm', rightId: 'dim-length' },
              { leftId: 'unit-cm2', rightId: 'dim-area' },
              { leftId: 'unit-dm3', rightId: 'dim-volume' },
              { leftId: 'unit-m', rightId: 'dim-length' },
              { leftId: 'unit-m2', rightId: 'dim-area' },
              { leftId: 'unit-cm3', rightId: 'dim-volume' },
            ]),
            choice('c2', '字典所占空间单位', 'sel.dict', 'opt-cm3'),
            choice('c3', '"操场面积 300 米"的错误', 'sel.playground', 'opt-area-needs-square-unit'),
          ],
          reveal: [
            { checkId: 'c1', text: '毫米、米 → 长度；平方厘米、平方米 → 面积；立方分米、立方厘米 → 体积。' },
            { checkId: 'c2', text: '立方厘米（cm³）——物体占的空间用体积单位。' },
            { checkId: 'c3', text: '面积要用面积单位：应说"操场的面积是 300 平方米"。' },
          ],
          feedback: { reviseGeneric: '再看一遍：带"平方"的是面积，带"立方"的是体积。' },
        },
      },
    },
  },
  {
    ruleId: 'rule.thm.f1.v1',
    file: 'rule.thm.f1.v1.json',
    boundTasks: ['thm.f1.g1.partition-circle.v1', 'thm.f1.g2.partition-bar.v1', 'thm.f1.i1.represent.v1', 'thm.f1.s1.stranger-relabel.v1', 'thm.f1.d1.delayed-transfer.v1'],
    body: {
      kind: 'GRID_TASK_TRUTH',
      entries: {
        'thm.f1.g1.partition-circle.v1': {
          checks: [
            frac('c1', 'circle-fraction', '涂色部分的分数', { kind: 'FROM_STATE' }, { kind: 'EXACT' }),
            choice('c2', '分母 4 的含义', 'sel.denom-meaning', 'opt-total-parts'),
            choice('c3', '未平均分反例判断', 'sel.unequal-parts', 'opt-no'),
          ],
          scenario: { kind: 'GRID_AT', cols: 4, filled: 3 },
          scenarioFeedback: '请先把圆盘调成平均 4 份、涂 3 份（各行/涂色都需确认），再提交。',
          diagnostics: [
            { tag: 'mis-num-den-swapped', checkId: 'c1', when: { kind: 'FRACTION_SWAPPED' }, feedback: '再检查：分母（下面的数）是总份数，分子（上面的数）是涂色份数——好像写反了。' },
          ],
          reveal: [
            { checkId: 'c1', text: '平均 4 份、涂 3 份 → 3/4。' },
            { checkId: 'c2', text: '分母 4 = 平均分成的总份数。' },
            { checkId: 'c3', text: '不能——没有平均分就不能用分数这样表示。' },
          ],
          feedback: { reviseGeneric: '再数一遍：一共平均分成几份？涂色几份？分母写总数、分子写涂色数。' },
        },
        'thm.f1.g2.partition-bar.v1': {
          checks: [
            frac('c1', 'bar-fraction', '涂色部分的分数', { kind: 'FROM_STATE' }, { kind: 'EXACT' }),
            choice('c2', '与 1/2 比大小', 'sel.compare-half', 'opt-58-bigger'),
          ],
          scenario: { kind: 'GRID_AT', cols: 8, filled: 5 },
          scenarioFeedback: '请先把条带调成平均 8 份、涂 5 份并确认，再提交。',
          reveal: [
            { checkId: 'c1', text: '8 份涂 5 份 → 5/8。' },
            { checkId: 'c2', text: '5/8 > 1/2：5 超过 8 的一半，点越过中点。' },
          ],
          feedback: { reviseGeneric: '再看看数轴：点过中点了吗？分子超过分母的一半了吗？' },
        },
        'thm.f1.i1.represent.v1': {
          checks: [
            frac('c1', 'bar-fraction', '涂色部分的分数', { kind: 'FROM_STATE' }, { kind: 'EXACT' }),
            choice('c2', '分子的含义', 'sel.num-meaning', 'opt-num-taken'),
          ],
          scenario: { kind: 'GRID_AT', cols: 10, filled: 7 },
          scenarioFeedback: '本题图板已给出：10 格涂 7 格。',
          diagnostics: [
            { tag: 'mis-num-den-swapped', checkId: 'c1', when: { kind: 'FRACTION_SWAPPED' }, feedback: '再检查：分母是总格数 10，分子是涂色格数——好像写反了。' },
          ],
          reveal: [
            { checkId: 'c1', text: '涂 7 格、共 10 格 → 7/10。' },
            { checkId: 'c2', text: '分子 7 = 涂色（取走）的份数。' },
          ],
          feedback: { reviseGeneric: '再数一遍：总格数写分母，涂色格数写分子。' },
        },
        'thm.f1.s1.stranger-relabel.v1': {
          checks: [
            choice('c1', '未平均分能否说 1/4', 'sel.can-say-quarter', 'opt-no-not-equal'),
            frac('c2', 'circle-fraction', '重新切好后的分数', { kind: 'FROM_STATE' }, { kind: 'EXACT' }),
          ],
          scenario: { kind: 'GRID_AT', cols: 4, filled: 1 },
          scenarioFeedback: '请先把圆盘重新切成平均 4 份、涂 1 份并确认，再提交。',
          reveal: [
            { checkId: 'c1', text: '不能——4 块大小不一，不是平均分。' },
            { checkId: 'c2', text: '平均 4 份涂 1 份 → 1/4。' },
          ],
          feedback: { reviseGeneric: '记住前提：分数说的是"平均分之后的份数"。' },
        },
        'thm.f1.d1.delayed-transfer.v1': {
          checks: [
            frac('c1', 'morning-fraction', '上午吃的分数', { kind: 'FROM_STATE' }, { kind: 'EXACT' }),
            frac('c2', 'whole-day-fraction', '全天吃的分数', { kind: 'AUTHORED', numerator: 5, denominator: 8 }, { kind: 'REDUCED_EQUALS' }),
          ],
          scenario: { kind: 'GRID_AT', cols: 8, filled: 3 },
          scenarioFeedback: '请先在圆盘上把上午吃的 3 份涂色并确认，再提交。',
          reveal: [
            { checkId: 'c1', text: '上午 3 块 → 3/8。' },
            { checkId: 'c2', text: '3+2 = 5 块 → 5/8。' },
          ],
          feedback: { reviseGeneric: '再想一遍：分母始终是总块数 8；全天要先把块数合起来。' },
        },
      },
    },
  },
  {
    ruleId: 'rule.thm.f2.v1',
    file: 'rule.thm.f2.v1.json',
    boundTasks: ['thm.f2.g1.scale-bar.v1', 'thm.f2.g2.equivalent-find.v1', 'thm.f2.i1.numberline.v1', 'thm.f2.s1.stranger.v1', 'thm.f2.d1.delayed-transfer.v1'],
    body: {
      kind: 'GRID_TASK_TRUTH',
      entries: {
        'thm.f2.g1.scale-bar.v1': {
          checks: [
            frac('c1', 'scaled-fraction', '同乘后的分数', { kind: 'FROM_STATE' }, { kind: 'EXACT' }),
            choice('c2', '涂色大小是否变化', 'sel.size-change', 'opt-same-size'),
            choice('c3', '相等的原因', 'sel.why-equal', 'opt-both-scaled'),
          ],
          scenario: { kind: 'GRID_AT', cols: 4, filled: 2 },
          scenarioFeedback: '请先做一次"同乘 2"并确认，再提交。',
          diagnostics: [
            { tag: 'mis-numerator-only-scaled', checkId: 'c1', when: { kind: 'FRACTION_NUMERATOR_ONLY_SCALED', preNumerator: 1, preDenominator: 2, multiplier: 2 }, feedback: '再看看：只有分子乘了 2，分母也要乘同一个数——同乘要"一起"。' },
            { tag: 'mis-denominator-only-scaled', checkId: 'c1', when: { kind: 'FRACTION_DENOMINATOR_ONLY_SCALED', preNumerator: 1, preDenominator: 2, multiplier: 2 }, feedback: '再看看：只有分母乘了 2，分子也要乘同一个数——同乘要"一起"。' },
          ],
          reveal: [
            { checkId: 'c1', text: '分子分母同乘 2：1/2 → 2/4。' },
            { checkId: 'c2', text: '大小不变——涂的还是同一半。' },
            { checkId: 'c3', text: '分子分母乘了同一个数，分数大小不变。' },
          ],
          feedback: { reviseGeneric: '再看一遍图：同乘只是把每份切细，涂色的长短没变。' },
        },
        'thm.f2.g2.equivalent-find.v1': {
          checks: [
            frac('c1', 'scaled-fraction', '分母 8 的等值分数', { kind: 'FROM_STATE' }, { kind: 'EXACT' }),
            choice('c2', '相等的原因', 'sel.why-eq', 'opt-num-den-same-times'),
          ],
          scenario: { kind: 'GRID_AT', cols: 8, filled: 6 },
          scenarioFeedback: '请先做一次"同乘 2"并确认，再提交。',
          diagnostics: [
            { tag: 'mis-numerator-only-scaled', checkId: 'c1', when: { kind: 'FRACTION_NUMERATOR_ONLY_SCALED', preNumerator: 3, preDenominator: 4, multiplier: 2 }, feedback: '再看看：6/4 只有分子乘了 2——分母 4 也要乘 2。' },
            { tag: 'mis-denominator-only-scaled', checkId: 'c1', when: { kind: 'FRACTION_DENOMINATOR_ONLY_SCALED', preNumerator: 3, preDenominator: 4, multiplier: 2 }, feedback: '再看看：3/8 只有分母乘了 2——分子 3 也要乘 2。' },
          ],
          reveal: [
            { checkId: 'c1', text: '3/4 同乘 2 → 6/8。' },
            { checkId: 'c2', text: '分子分母同时乘了 2。' },
          ],
          feedback: { reviseGeneric: '再想一遍：等值要分子分母"同时"乘同一个数。' },
        },
        'thm.f2.i1.numberline.v1': {
          checks: [
            frac('c1', 'point-fraction', '点表示的分数', { kind: 'AUTHORED', numerator: 2, denominator: 6 }, { kind: 'EXACT' }),
            choice('c2', '与 2/6 相等的分数', 'sel.eq-choice', 'opt-1-3'),
          ],
          reveal: [
            { checkId: 'c1', text: '6 格走到第 2 格 → 2/6。' },
            { checkId: 'c2', text: '2/6 分子分母同 ÷2 → 1/3。' },
          ],
          feedback: { reviseGeneric: '再想一遍：总格数作分母、走过格数作分子；等值要同除一个数。' },
        },
        'thm.f2.s1.stranger.v1': {
          checks: [
            choice('c1', '1/2 与 2/4 谁大', 'sel.who-more', 'opt-same'),
            frac('c2', 'denom-8-fraction', '1/2 写成分母 8', { kind: 'FROM_STATE' }, { kind: 'EXACT' }),
          ],
          scenario: { kind: 'GRID_AT', cols: 8, filled: 4 },
          scenarioFeedback: '请先用"同乘"把 1/2 变到分母是 8 并确认，再提交。',
          diagnostics: [
            { tag: 'mis-numerator-only-scaled', checkId: 'c2', when: { kind: 'FRACTION_NUMERATOR_ONLY_SCALED', preNumerator: 1, preDenominator: 2, multiplier: 4 }, feedback: '再看看：只有分子乘了 4——分母 2 也要乘 4。' },
          ],
          reveal: [
            { checkId: 'c1', text: '一样大：2/4 = 1/2（分子分母同乘 2）。' },
            { checkId: 'c2', text: '1/2 同乘 4 → 4/8。' },
          ],
          feedback: { reviseGeneric: '再看一遍：两张纸一样大，涂的比例也一样。' },
        },
        'thm.f2.d1.delayed-transfer.v1': {
          checks: [
            choice('c1', '3/9 与 1/3 是否相等', 'sel.eq-judge', 'opt-equal'),
            frac('c2', 'reduced-fraction', '2/6 的最简分数', { kind: 'AUTHORED', numerator: 1, denominator: 3 }, { kind: 'EXACT' }),
          ],
          reveal: [
            { checkId: 'c1', text: '相等：3/9 分子分母同 ÷3 → 1/3。' },
            { checkId: 'c2', text: '2/6 同 ÷2 → 1/3。' },
          ],
          feedback: { reviseGeneric: '再想一遍：约分是分子分母同除一个数，除到只剩公因数 1。' },
        },
      },
    },
  },
  {
    ruleId: 'rule.thm.f3.v1',
    file: 'rule.thm.f3.v1.json',
    boundTasks: ['thm.f3.g1.percent-board.v1', 'thm.f3.g2.discount-chain.v1', 'thm.f3.i1.allocate.v1', 'thm.f3.s1.stranger.v1', 'thm.f3.d1.delayed-transfer.v1'],
    body: {
      kind: 'GRID_TASK_TRUTH',
      entries: {
        'thm.f3.g1.percent-board.v1': {
          checks: [
            numState('c1', 'percent-value', '涂色百分数', 'FILLED_PERCENT', ['percent'], 0),
            choice('c2', '百分数的含义', 'sel.percent-meaning', 'opt-part-of-hundred'),
            num('c3', 'percent-units', '75% 里 1% 的个数', '75', 'ge', ['ge'], 0),
          ],
          scenario: { kind: 'GRID_AT', filled: 75 },
          scenarioFeedback: '请先把百格板涂到 75 格并确认，再提交。',
          diagnostics: [
            { tag: 'mis-percent-as-decimal', checkId: 'c1', when: { kind: 'VALUE_EQUALS', unitId: 'percent', value: '0.75' }, feedback: '再看看：涂了 75 格就是百分之七十五，写作 75%，不是 0.75%。' },
            { tag: 'mis-percent-as-integer', checkId: 'c1', when: { kind: 'UNIT_MISMATCH' }, feedback: '数值对了，但单位要选"百分数（%）"——百分数不是个数。' },
          ],
          reveal: [
            { checkId: 'c1', text: '涂 75 格 = 75/100 = 75%。' },
            { checkId: 'c2', text: '百分数表示一个数是一百份整体中的几份。' },
            { checkId: 'c3', text: '75% 里有 75 个 1%。' },
          ],
          feedback: { reviseGeneric: '再想一遍：涂几格就是百分之几；百分数要带"%"（选百分数单位）。' },
        },
        'thm.f3.g2.discount-chain.v1': {
          checks: [
            num('c1', 'fold-percent', '八折的百分数', '80', 'percent', ['percent'], 0),
            num('c2', 'pay-amount', '应付金额', '64.00', 'yuan', ['yuan'], 2),
            num('c3', 'save-amount', '便宜金额', '16.00', 'yuan', ['yuan'], 2),
          ],
          scenario: { kind: 'GRID_AT', filled: 80 },
          scenarioFeedback: '请先在百格板上涂出八折对应的格数（80 格）并确认，再提交。',
          diagnostics: [
            { tag: 'mis-fold-as-8pct', checkId: 'c2', when: { kind: 'VALUE_EQUALS', unitId: 'yuan', value: '6.40' }, feedback: '再检查：八折是 80%，不是 8%——"八折"就是十分之八。' },
            { tag: 'mis-discount-added', checkId: 'c2', when: { kind: 'VALUE_EQUALS', unitId: 'yuan', value: '96.00' }, feedback: '再检查：打折是"乘"，不是先加价——96 是把 80 上浮了两成。' },
            { tag: 'mis-no-discount', checkId: 'c2', when: { kind: 'VALUE_EQUALS', unitId: 'yuan', value: '80.00' }, feedback: '再检查：这是原价——打折后要按原价的 80% 付。' },
            { tag: 'mis-save-eq-pay', checkId: 'c3', when: { kind: 'VALUE_EQUALS', unitId: 'yuan', value: '64.00' }, feedback: '再检查：这一问答的是"便宜了多少"，是原价减去应付的差。' },
          ],
          reveal: [
            { checkId: 'c1', text: '八折 = 80%（现价是原价的 80/100）。' },
            { checkId: 'c2', text: '80 × 80% = 64.00 元。' },
            { checkId: 'c3', text: '80 − 64 = 16.00 元。' },
          ],
          feedback: { reviseGeneric: '再顺一遍链子：先写折扣的百分数，再乘原价，最后用原价减应付。' },
        },
        'thm.f3.i1.allocate.v1': {
          checks: [
            num('c1', 'share-per', '每份颗数', '12', 'ge', ['ge'], 0),
            num('c2', 'part-a', '甲的颗数', '36', 'ge', ['ge'], 0),
            num('c3', 'part-b', '乙的颗数', '24', 'ge', ['ge'], 0),
          ],
          scenario: { kind: 'GRID_AT', rows: 3, cols: 12 },
          scenarioFeedback: '请把点阵保持在甲的建模（3 行 × 每行 12 颗）再提交。',
          diagnostics: [
            { tag: 'mis-equal-split', checkId: 'c2', when: { kind: 'VALUE_EQUALS', unitId: 'ge', value: '30' }, feedback: '再检查：按 3:2 分不是对半分——先求一份是多少。' },
            { tag: 'mis-ratio-times-total', checkId: 'c2', when: { kind: 'VALUE_EQUALS', unitId: 'ge', value: '180' }, feedback: '再检查：60×3 把总数也乘进去了——应先 60÷(3+2) 求一份。' },
          ],
          reveal: [
            { checkId: 'c1', text: '60 ÷ (3+2) = 60 ÷ 5 = 12（颗/份）。' },
            { checkId: 'c2', text: '甲 = 12 × 3 = 36 颗。' },
            { checkId: 'c3', text: '乙 = 12 × 2 = 24 颗。' },
          ],
          feedback: { reviseGeneric: '再想一遍：按比例分配先求一份（总数 ÷ 份数和），再各自乘。' },
        },
        'thm.f3.s1.stranger.v1': {
          checks: [
            num('c1', 'store-a-pay', '甲店总价', '60.00', 'yuan', ['yuan'], 2),
            num('c2', 'store-b-pay', '乙店总价', '64.00', 'yuan', ['yuan'], 2),
            choice('c3', '哪家更便宜', 'sel.cheaper', 'opt-store-a'),
            num('c4', 'diff-amount', '差价', '4.00', 'yuan', ['yuan'], 2),
          ],
          diagnostics: [
            { tag: 'mis-half-on-both', checkId: 'c1', when: { kind: 'VALUE_EQUALS', unitId: 'yuan', value: '40.00' }, feedback: '再检查：半价只作用于第二支，第一支仍要付全价。' },
            { tag: 'mis-fold-as-8pct', checkId: 'c2', when: { kind: 'VALUE_EQUALS', unitId: 'yuan', value: '6.40' }, feedback: '再检查：八折是 80%，不是 8%。' },
          ],
          reveal: [
            { checkId: 'c1', text: '40 + 40×50% = 40 + 20 = 60.00 元。' },
            { checkId: 'c2', text: '(40+40) × 80% = 80 × 0.8 = 64.00 元。' },
            { checkId: 'c3', text: '甲店（第二件半价）更便宜。' },
            { checkId: 'c4', text: '64 − 60 = 4.00 元。' },
          ],
          feedback: { reviseGeneric: '再顺一遍：先各算总价（看清优惠作用在哪几件），再比大小。' },
        },
        'thm.f3.d1.delayed-transfer.v1': {
          checks: [
            num('c1', 'fold-percent', '九折的百分数', '90', 'percent', ['percent'], 0),
            num('c2', 'pay-amount', '应付金额', '45.00', 'yuan', ['yuan'], 2),
            num('c3', 'save-amount', '便宜金额', '5.00', 'yuan', ['yuan'], 2),
          ],
          scenario: { kind: 'GRID_AT', filled: 90 },
          scenarioFeedback: '请先在百格板上涂出九折对应的格数（90 格）并确认，再提交。',
          diagnostics: [
            { tag: 'mis-fold-as-9pct', checkId: 'c2', when: { kind: 'VALUE_EQUALS', unitId: 'yuan', value: '4.50' }, feedback: '再检查：九折是 90%，不是 9%。' },
            { tag: 'mis-discount-added', checkId: 'c2', when: { kind: 'VALUE_EQUALS', unitId: 'yuan', value: '55.00' }, feedback: '再检查：打折是乘 90%，不是加一成。' },
          ],
          reveal: [
            { checkId: 'c1', text: '九折 = 90%。' },
            { checkId: 'c2', text: '50 × 90% = 45.00 元。' },
            { checkId: 'c3', text: '50 − 45 = 5.00 元。' },
          ],
          feedback: { reviseGeneric: '再顺一遍：几折就是百分之几十；应付 = 原价 × 百分数。' },
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// private frozen instances (story givens + truth + answer hint)
// ---------------------------------------------------------------------------
const instances = [
  {
    taskId: 'thm.f1.i1.represent.v1',
    file: 'thm.f1.i1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'thm.f1.i1.F1',
        initial: { rows: 1, cols: 10, filled: 7 },
        truth: { fractionText: '7/10' },
        answerHint: '涂色 7 格、共 10 格：7/10；分子 7 表示涂色（取走）的份数。',
      },
    ],
    domain: { rows: [1, 1], cols: [6, 12], excludes: ['已服务实例参数'], note: '替换实例时 cols≠8 且 filled≠cols/2，避免与 g1/g2/d1 撞例' },
  },
  {
    taskId: 'thm.f1.s1.stranger-relabel.v1',
    file: 'thm.f1.s1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'thm.f1.s1.F1',
        initial: { rows: 1, cols: 1, filled: 0 },
        truth: { answerIsNoReason: 'not-equal-parts' },
        answerHint: '(1) 不能——随手切的 4 块大小不一，不是平均分；(2) 平均 4 份涂 1 份 → 1/4。',
      },
    ],
  },
  {
    taskId: 'thm.f1.d1.delayed-transfer.v1',
    file: 'thm.f1.d1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'thm.f1.d1.F1',
        initial: { rows: 1, cols: 8, filled: 0 },
        truth: { morning: '3/8', wholeDay: '5/8' },
        answerHint: '(1) 上午 3 块 → 3/8；(2) 3+2=5 块 → 5/8。',
        migration: {
          plannedAt: 'lesson FinishAttempt',
          availableAfterDays: 7,
          nominalWindowEndDays: 14,
          observedRequires: ['newTaskSubmission', 'actualIntervalDays', 'assistanceData'],
        },
      },
    ],
  },
  {
    taskId: 'thm.f2.i1.numberline.v1',
    file: 'thm.f2.i1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'thm.f2.i1.F1',
        initial: { rows: 1, cols: 6, filled: 2 },
        truth: { point: '2/6', equivalent: '1/3' },
        answerHint: '(1) 6 格走到第 2 格 → 2/6；(2) 同 ÷2 → 1/3。',
      },
    ],
    domain: { rows: [1, 1], cols: [4, 10], excludes: ['cols=4（撞 g2 例）', 'cols=8（撞 s1 例）'] },
  },
  {
    taskId: 'thm.f2.s1.stranger.v1',
    file: 'thm.f2.s1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'thm.f2.s1.F1',
        initial: { rows: 1, cols: 2, filled: 1 },
        truth: { equalReason: 'both-scaled', targetDenom8: '4/8' },
        answerHint: '(1) 一样大：2/4 = 1/2；(2) 1/2 同乘 4 → 4/8。',
      },
    ],
  },
  {
    taskId: 'thm.f2.d1.delayed-transfer.v1',
    file: 'thm.f2.d1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'thm.f2.d1.F1',
        initial: { rows: 1, cols: 6, filled: 2 },
        truth: { judge: 'equal', reduced: '1/3' },
        answerHint: '(1) 3/9 同 ÷3 = 1/3，相等；(2) 2/6 同 ÷2 → 1/3。',
        migration: { plannedAt: 'lesson FinishAttempt', availableAfterDays: 7, nominalWindowEndDays: 14 },
      },
    ],
  },
  {
    taskId: 'thm.f3.i1.allocate.v1',
    file: 'thm.f3.i1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'thm.f3.i1.F1',
        initial: { rows: 3, cols: 12, filled: 36 },
        truth: { perShare: '12', partA: '36', partB: '24', story: '60 颗按 3:2 分' },
        answerHint: '60÷(3+2)=12（每份）；甲 12×3=36；乙 12×2=24。',
      },
    ],
    domain: { total: [30, 120], ratioPairs: ['2:1', '3:2', '4:1', '5:3'], excludes: ['60 颗 3:2（本例）'] },
  },
  {
    taskId: 'thm.f3.s1.stranger.v1',
    file: 'thm.f3.s1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'thm.f3.s1.F1',
        initial: { rows: 10, cols: 10, filled: 0 },
        truth: { storeA: '60.00', storeB: '64.00', cheaper: 'store-a', diff: '4.00', story: '单价 40 元买 2 支' },
        answerHint: '甲店 40+40×50%=60.00 元；乙店 80×80%=64.00 元；甲店便宜 64−60=4.00 元。',
      },
    ],
  },
  {
    taskId: 'thm.f3.d1.delayed-transfer.v1',
    file: 'thm.f3.d1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'thm.f3.d1.F1',
        initial: { rows: 10, cols: 10, filled: 0 },
        truth: { percent: '90', pay: '45.00', save: '5.00', story: '原价 50 元打九折' },
        answerHint: '九折=90%；50×90%=45.00 元；50−45=5.00 元。',
        migration: { plannedAt: 'lesson FinishAttempt', availableAfterDays: 7, nominalWindowEndDays: 14 },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// lessons (public; micro lessons are prerequisite entries, theme lessons carry
// stranger + delayed transfer per the Owner 定位)
// ---------------------------------------------------------------------------
const M1 = ['thm.m1.diag.v1', 'thm.m1.supp.v1'];
const M2 = ['thm.m2.diag.v1', 'thm.m2.supp.v1'];
const M3 = ['thm.m3.diag.v1', 'thm.m3.supp.v1'];
const M4 = ['thm.m4.diag.v1', 'thm.m4.supp.v1'];

const lessons = {
  lessonsVersion: '1',
  lessons: [
    { lessonId: 'themes.micro.radiusDiameter', releaseId: 'rondo.thm.m1-r1', title: '先修微课 · 半径与直径', taskFamily: 'themes.micro.v1', lessonKind: 'micro', taskOrder: M1 },
    { lessonId: 'themes.micro.rectArea', releaseId: 'rondo.thm.m2-r1', title: '先修微课 · 长方形面积与面积单位', taskFamily: 'themes.micro.v1', lessonKind: 'micro', taskOrder: M2 },
    { lessonId: 'themes.micro.quantity', releaseId: 'rondo.thm.m3-r1', title: '先修微课 · 乘除与数量关系', taskFamily: 'themes.micro.v1', lessonKind: 'micro', taskOrder: M3 },
    { lessonId: 'themes.micro.units', releaseId: 'rondo.thm.m4-r1', title: '先修微课 · 长度、面积、体积的单位', taskFamily: 'themes.micro.v1', lessonKind: 'micro', taskOrder: M4 },
    {
      lessonId: 'themes.frac.lesson1', releaseId: 'rondo.thm.t1l1-r1', title: '主题一 · 第 1 课 等分与表示', taskFamily: 'themes.frac.v1', lessonKind: 'theme',
      taskOrder: ['thm.f1.g1.partition-circle.v1', 'thm.f1.g2.partition-bar.v1', 'thm.f1.i1.represent.v1', 'thm.f1.s1.stranger-relabel.v1'],
      delayedTransferTaskId: 'thm.f1.d1.delayed-transfer.v1',
      delayedTransferWindowDays: { availableAfterDays: 7, nominalEndDays: 14 },
    },
    {
      lessonId: 'themes.frac.lesson2', releaseId: 'rondo.thm.t1l2-r1', title: '主题一 · 第 2 课 等值与缩放', taskFamily: 'themes.frac.v1', lessonKind: 'theme',
      taskOrder: ['thm.f2.g1.scale-bar.v1', 'thm.f2.g2.equivalent-find.v1', 'thm.f2.i1.numberline.v1', 'thm.f2.s1.stranger.v1'],
      delayedTransferTaskId: 'thm.f2.d1.delayed-transfer.v1',
      delayedTransferWindowDays: { availableAfterDays: 7, nominalEndDays: 14 },
    },
    {
      lessonId: 'themes.frac.lesson3', releaseId: 'rondo.thm.t1l3-r1', title: '主题一 · 第 3 课 分配或折扣情境的问题链', taskFamily: 'themes.frac.v1', lessonKind: 'theme',
      taskOrder: ['thm.f3.g1.percent-board.v1', 'thm.f3.g2.discount-chain.v1', 'thm.f3.i1.allocate.v1', 'thm.f3.s1.stranger.v1'],
      delayedTransferTaskId: 'thm.f3.d1.delayed-transfer.v1',
      delayedTransferWindowDays: { availableAfterDays: 7, nominalEndDays: 14 },
    },
  ],
};

// static answer hints for tasks without frozen instances
const staticAnswerHints = {
  'thm.m1.diag.v1': '(1) 2.5×2=5.0 cm；(2) 12÷2=6.0 cm；(3) 直径=半径×2；(4) 变大（始终 2 倍）。',
  'thm.m1.supp.v1': '① 半径 3.5 cm 时直径=3.5×2=7.0 cm；② 半径=12.0÷2=6.0 cm。',
  'thm.m2.diag.v1': '(1) 5×3=15 cm²；(2) 1 cm²；(3) 长度×长度；(4) 1 dm²=100 cm²。',
  'thm.m2.supp.v1': '① 4×6=24 cm²；② 18÷6=3 cm。',
  'thm.m3.diag.v1': '(1) 6×4=24 支；(2) 24÷6=4 盒；(3) 24÷4=6 支；(4) 总数=每份数×份数。',
  'thm.m3.supp.v1': '① 4×6=24 个；② 8×3=24 个；③ 36÷9=4 行。',
  'thm.m4.diag.v1': '(1) cm→长度、cm²→面积、cm³→体积；(2) 面积单位；(3) 100；(4) 1 cm³。',
  'thm.m4.supp.v1': '(1) mm/m→长度，cm²/m²→面积，dm³/cm³→体积；(2) cm³；(3) 面积要用面积单位（平方米）。',
  'thm.f1.g1.partition-circle.v1': '平均 4 份涂 3 份 → 3/4；分母 4=总份数；不平均分不能说 3/4。',
  'thm.f1.g2.partition-bar.v1': '8 份涂 5 份 → 5/8；5/8 > 1/2（点越过中点）。',
  'thm.f1.s1.stranger-relabel.v1': '(1) 不能（大小不一，不是平均分）；(2) 平均 4 份涂 1 份 → 1/4。',
  'thm.f2.g1.scale-bar.v1': '同乘 2：1/2 → 2/4；大小不变；分子分母同乘一个数。',
  'thm.f2.g2.equivalent-find.v1': '3/4 同乘 2 → 6/8；分子分母同时乘 2。',
  'thm.f3.g1.percent-board.v1': '涂 75 格 → 75%；表示一百份中占 75 份；75 个 1%。',
  'thm.f3.g2.discount-chain.v1': '八折=80%；80×80%=64.00 元；80−64=16.00 元。',
  'thm.f3.i1.allocate.v1': '60÷5=12；甲 36；乙 24。',
};

// ---------------------------------------------------------------------------
// h4 (answer-level) registration: the public layer registers ONLY the level;
// the private text lives in private/hints/answer-hints.json.
// ---------------------------------------------------------------------------
for (const t of tasks) {
  if (!t.hints.some((h) => h.level === 4)) t.hints.push({ level: 4, label: '答案级提示' });
}

// ---------------------------------------------------------------------------
// emit content/themes-a
// ---------------------------------------------------------------------------
function writeJson(path, value) {
  mkdirSync(join(OUT, path, '..'), { recursive: true });
  writeFileSync(join(OUT, path), JSON.stringify(value, null, 2) + '\n');
}

writeJson('public/schemas/response-schemas.registry.json', registry);
writeJson('public/lessons.json', lessons);
for (const t of tasks) {
  writeJson(`public/tasks/${t.taskId}.json`, t);
}
for (const rule of rules) {
  writeJson(`private/rules/${rule.file}`, { ruleId: rule.ruleId, file: rule.file, boundTasks: rule.boundTasks, body: rule.body });
}
for (const inst of instances) {
  writeJson(`private/instances/${inst.file}`, inst);
}

const answerHints = {};
for (const inst of instances) {
  answerHints[inst.taskId] = inst.frozen.map((f) => ({ instanceId: f.instanceId, level: 4, text: f.answerHint }));
}
for (const [taskId, text] of Object.entries(staticAnswerHints)) {
  if (!answerHints[taskId]) answerHints[taskId] = [{ instanceId: 'static', level: 4, text }];
}
writeJson('private/hints/answer-hints.json', answerHints);

function ruleForTask(taskId) {
  return rules.find((r) => r.boundTasks.includes(taskId));
}
function instanceForTask(taskId) {
  return instances.find((i) => i.taskId === taskId);
}

function bindingsFor(releaseId, taskIds) {
  return {
    releaseId,
    taskBindings: taskIds.map((taskId) => {
      const rule = ruleForTask(taskId);
      const inst = instanceForTask(taskId);
      return {
        taskId,
        ruleRef: { ruleId: rule.ruleId, ruleVersion: '1', path: `rules/${rule.file}` },
        ...(inst ? { instanceGeneratorRef: { kind: 'frozen', path: `instances/${inst.file}` } } : {}),
      };
    }),
  };
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
function sha256Canonical(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

// public release manifests (content/themes-a/public/releases/...)
function buildPublicManifest(releaseId, dirName, taskIds) {
  const publicDir = join(OUT, 'public');
  const scoped = new Set([
    join(publicDir, 'schemas', 'response-schemas.registry.json'),
    join(publicDir, 'lessons.json'),
    ...taskIds.map((id) => join(publicDir, 'tasks', `${id}.json`)),
  ]);
  const hashes = [];
  const assetMap = {};
  for (const f of listFiles(publicDir)) {
    if (f.includes(join('public', 'releases'))) continue;
    if (!scoped.has(f)) continue;
    const h = sha256File(f);
    hashes.push(h);
    assetMap[relative(ROOT, f)] = h;
  }
  hashes.sort();
  const usesCylinder = tasks.find((t) => taskIds.includes(t.taskId) && t.taskFamily === 'themes.micro.v1' && t.taskId.startsWith('thm.m1.'));
  const manifest = {
    releaseId,
    taskIds,
    taskVersion: TASK_VERSION,
    rendererDeclarations: usesCylinder ? [RENDERER_CYL, RENDERER_GRID] : [RENDERER_GRID],
    publicAssetHashes: hashes,
    expressionOperationSubsets: usesCylinder
      ? [
          { expression: 'WEBGL2', allowedOperationIds: ['SetDimension'] },
          { expression: 'SVG_DOM', allowedOperationIds: ['SetDimension'] },
          { expression: 'BOARD_SVG', allowedOperationIds: ['SetDimension', ...gridOpsOf(taskIds)] }, // m1 俯视圆 board view supports SetDimension
          { expression: 'BOARD_TABLE', allowedOperationIds: ['SetDimension', ...gridOpsOf(taskIds)] },
        ]
      : [
          { expression: 'BOARD_SVG', allowedOperationIds: gridOpsOf(taskIds) },
          { expression: 'BOARD_TABLE', allowedOperationIds: gridOpsOf(taskIds) },
        ],
    publicManifestHash: '',
  };
  const { publicManifestHash: _omitted, ...manifestContent } = manifest;
  manifest.publicManifestHash = sha256Canonical(manifestContent);
  writeJson(`public/releases/${dirName}/manifest.public.json`, manifest);
  writeJson(`public/releases/${dirName}/assets-map.json`, {
    releaseId,
    note: 'path -> sha256 of the public asset files hashed into publicAssetHashes; this map itself is not hashed',
    assets: assetMap,
  });
}

function gridOpsOf(taskIds) {
  const ops = new Set();
  for (const t of tasks) {
    if (!taskIds.includes(t.taskId)) continue;
    for (const op of t.allowedOperationIds) {
      if (op === 'SetGridSize' || op === 'SetFilled' || op === 'ScaleBoth') ops.add(op);
    }
  }
  return [...ops];
}

// dist/content — B release layout per release (product-Host loader wiring for
// rondo.gridboard@1 is a declared follow-up; the release files are complete,
// faithful to the authored data — same discipline as the GESP2 precedent).
function writeDistJson(root, relPath, value) {
  const target = join(root, relPath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

function canonicalize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) throw new Error(`non-finite number: ${value}`);
      return JSON.stringify(value);
    }
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`not canonicalizable: ${typeof value}`);
  }
}

function emitRelease(releaseId, dirName, taskIds) {
  buildPublicManifest(releaseId, dirName, taskIds);
  const distRoot = join(process.env.RONDO_DIST_DIR ?? join(ROOT,'dist'), 'content', releaseId);
  rmSync(distRoot, { recursive: true, force: true });

  const releaseTasks = tasks.filter((t) => taskIds.includes(t.taskId));
  const taskObjs = {};
  const hintObjs = {};
  const hintGateTable = [];
  for (const t of releaseTasks) {
    const file = {
      taskId: t.taskId,
      taskFamily: t.taskFamily,
      title: t.title,
      boardView: t.boardView,
      promptGroups: [{ minVisibility: 'PREDICTION', blocks: t.prompt }],
      responseSchemaId: t.responseSchemaId,
      allowedOperationIds: t.allowedOperationIds,
      operationConstraints: t.operationConstraints,
      givens: t.givens,
      givenLocks: t.givenLocks,
      visibility: t.visibility,
      hints: t.hints.map((h) => ({ level: h.level, label: h.label })),
      explain: t.explain,
      exitEvidence: t.exitEvidence,
      expressions: { boardSvg: t.expressions.boardSvg, boardTable: t.expressions.boardTable },
      taskVersion: TASK_VERSION,
    };
    taskObjs[t.taskId] = file;
    writeDistJson(distRoot, join('public', 'tasks', `${t.taskId}.json`), file);
    for (const hint of t.hints) {
      const contentRef = `hint.${t.taskId}.l${hint.level}`;
      const text = hint.text ?? answerHints[t.taskId][0].text;
      const hintFile = { contentRef, level: hint.level, revealsAnswer: hint.level === 4, version: '1', text };
      hintObjs[contentRef] = hintFile;
      writeDistJson(distRoot, join('public', 'hints', `${contentRef}.json`), hintFile);
      hintGateTable.push({ taskId: t.taskId, hintLevel: hint.level, contentRef });
    }
  }

  const bindings = bindingsFor(releaseId, taskIds);
  writeDistJson(distRoot, join('private', 'bindings.json'), bindings);
  for (const rule of rules) {
    if (!taskIds.some((id) => rule.boundTasks.includes(id))) continue;
    writeDistJson(distRoot, join('private', 'rules', `${rule.ruleId}.json`), { ruleId: rule.ruleId, file: rule.file, boundTasks: rule.boundTasks, body: rule.body });
  }
  for (const binding of bindings.taskBindings) {
    if (!binding.instanceGeneratorRef) continue;
    const inst = instanceForTask(binding.taskId);
    if (inst) writeDistJson(distRoot, join('private', binding.instanceGeneratorRef.path), inst);
  }

  const ruleRefs = taskIds.map((taskId) => {
    const rule = ruleForTask(taskId);
    return { taskId, ruleId: rule.ruleId, ruleVersion: '1' };
  });
  const usesCylinder = taskIds.some((id) => id.startsWith('thm.m1.'));
  const publicHeader = {
    releaseId,
    taskIds,
    taskVersion: TASK_VERSION,
    rendererDeclarations: usesCylinder ? [RENDERER_CYL, RENDERER_GRID] : [RENDERER_GRID],
    publicAssetHashes: [],
    expressionOperationSubsets: usesCylinder
      ? [
          { expression: 'WEBGL2', allowedOperationIds: ['SetDimension'] },
          { expression: 'SVG_DOM', allowedOperationIds: ['SetDimension'] },
          // m1 俯视圆 board view supports SetDimension (dual-expression completeness)
          { expression: 'BOARD_SVG', allowedOperationIds: ['SetDimension', ...gridOpsOf(taskIds)] },
          { expression: 'BOARD_TABLE', allowedOperationIds: ['SetDimension', ...gridOpsOf(taskIds)] },
        ]
      : [
          { expression: 'BOARD_SVG', allowedOperationIds: gridOpsOf(taskIds) },
          { expression: 'BOARD_TABLE', allowedOperationIds: gridOpsOf(taskIds) },
        ],
  };
  const manifest = {
    public: {
      ...publicHeader,
      publicManifestHash: createHash('sha256').update(canonicalize({ publicHeader, tasks: taskObjs, hints: hintObjs, assets: {} })).digest('hex'),
    },
    private: { ruleRefs, hintGateTable, constructionParamDomains: [] },
  };
  writeDistJson(distRoot, 'manifest.json', manifest);
  console.log(`dist/content ${releaseId}: ${taskIds.length} tasks, ${Object.keys(hintObjs).length} hints`);
}

emitRelease('rondo.thm.m1-r1', 'm1-r1', M1);
emitRelease('rondo.thm.m2-r1', 'm2-r1', M2);
emitRelease('rondo.thm.m3-r1', 'm3-r1', M3);
emitRelease('rondo.thm.m4-r1', 'm4-r1', M4);

const L1 = lessons.lessons[4];
const L2 = lessons.lessons[5];
const L3 = lessons.lessons[6];
emitRelease('rondo.thm.t1l1-r1', 't1l1-r1', [...L1.taskOrder, L1.delayedTransferTaskId]);
emitRelease('rondo.thm.t1l2-r1', 't1l2-r1', [...L2.taskOrder, L2.delayedTransferTaskId]);
emitRelease('rondo.thm.t1l3-r1', 't1l3-r1', [...L3.taskOrder, L3.delayedTransferTaskId]);

// private bindings per release (content tree copy)
for (const [releaseId, dirName, taskIds] of [
  ['rondo.thm.m1-r1', 'm1-r1', M1],
  ['rondo.thm.m2-r1', 'm2-r1', M2],
  ['rondo.thm.m3-r1', 'm3-r1', M3],
  ['rondo.thm.m4-r1', 'm4-r1', M4],
  ['rondo.thm.t1l1-r1', 't1l1-r1', [...L1.taskOrder, L1.delayedTransferTaskId]],
  ['rondo.thm.t1l2-r1', 't1l2-r1', [...L2.taskOrder, L2.delayedTransferTaskId]],
  ['rondo.thm.t1l3-r1', 't1l3-r1', [...L3.taskOrder, L3.delayedTransferTaskId]],
]) {
  writeJson(`private/bindings/${dirName}.bindings.private.json`, bindingsFor(releaseId, taskIds));
}

console.log(`content/themes-a emitted: ${tasks.length} tasks, ${rules.length} rules, ${instances.length} instance files, 7 releases`);
