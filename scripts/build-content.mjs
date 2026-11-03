#!/usr/bin/env node
/**
 * Rondo C lane content builder for the two first-batch cylinder lessons.
 *
 * Single source of truth: emits the whole content/cylinder tree
 * (public + private) deterministically, then computes the public release
 * manifests with sha256 asset hashes.
 *
 * Sources (frozen, read-only):
 * - docs/architecture/20261026 SCENE-CONTRACTS / LIFECYCLE-DATA-API / PRODUCT-CONTRACT
 * - preparation/C/{conventions,tasks/*,data/release-draft}.md (authored drafts)
 * - modules/contracts/public/** (AuthoredBlocks, numericPolicy, scene ids)
 * - modules/contracts/server/rules.ts (two frozen rule families; where they
 *   cannot express a task, the private rule file carries a `pendingDsl` block
 *   with a named reason — see CONTRACT_CHANGE_REQUIRED items in the C report).
 *
 * Run: npm run build:content   (writes content/cylinder/** under repo root)
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'content', 'cylinder');

// ---------------------------------------------------------------------------
// shared ids & labels (conventions §3/§4 — neutral object ids only)
// ---------------------------------------------------------------------------
const PROPERTY_LABELS = { radius: '半径', diameter: '直径', height: '高度' };
const DIRECTION_LABELS = { INCREASE: '变大', DECREASE: '变小', UNCHANGED: '不变' };
const UNSURE_OPTION = { id: 'opt-unsure', label: '不确定' };
const EDGE_LABELS = {
  'net-edge-1': '边 1',
  'net-edge-2': '边 2',
  'net-edge-3': '边 3',
  'net-edge-4': '边 4',
};
const PART_OPTIONS = [
  { id: 'cyl-part-upper-circle', label: '上底圆' },
  { id: 'cyl-part-lower-circle', label: '下底圆' },
  { id: 'cyl-part-height-line', label: '高（侧面从上到下的直线）' },
  UNSURE_OPTION,
];
const DIRECTION_PART_OPTIONS = [
  { id: 'cyl-part-base-circle', label: '底面圆（绕一圈的圆周）' },
  { id: 'cyl-part-height-line', label: '高' },
  UNSURE_OPTION,
];
const RELEASE_L1 = 'rondo.cyl.l1-r1';
const RELEASE_L2 = 'rondo.cyl.l2-r1';
const RELEASE_L3 = 'rondo.cyl.l3-r1';
const RELEASE_L4 = 'rondo.cyl.l4-r1';
const RENDERER = { rendererId: 'rondo.cylinder', rendererContractVersion: '1', publicStateSchemaVersion: '1' };
const RENDERER_V2 = { rendererId: 'rondo.cylinder', rendererContractVersion: '2', publicStateSchemaVersion: '2' };

const PHASES_ALL = ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'];
const OPERATE_ON = ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'];

// L3 face options (objectMapping rows: 算入/不算入/不确定 — L34-4, zero new kinds)
const FACE_RIGHT_OPTIONS = [
  { id: 'opt-include', label: '算入' },
  { id: 'opt-exclude', label: '不算入' },
  UNSURE_OPTION,
];
const FACE_LABELS_L3 = {
  'cyl-face-side': '侧面',
  'cyl-face-upper': '上盖面',
  'cyl-face-lower': '下盖面',
};

// ---------------------------------------------------------------------------
// form item helpers (rendered by the player from the public registry)
// ---------------------------------------------------------------------------
const propDirections = (prompt, properties) => ({
  kind: 'propertyJudgments',
  prompt,
  properties,
  propertyLabels: PROPERTY_LABELS,
  directionLabels: DIRECTION_LABELS,
});
const numberWithUnit = (prompt, quantityId, quantityLabel, units, decimals) => ({
  kind: 'numberWithUnit',
  prompt,
  quantityId,
  quantityLabel,
  units,
  decimals,
});
const mapping = (prompt, leftIds, rightOptions) => ({
  kind: 'objectMapping',
  prompt,
  pairs: leftIds.map((id) => ({ leftId: id, leftLabel: EDGE_LABELS[id] ?? id, rightOptions })),
});

const UNITS_LENGTH = [
  { id: 'cm', label: '厘米（cm）' },
  { id: 'mm', label: '毫米（mm）' },
];
const UNITS_AREA = [{ id: 'cm2', label: '平方厘米（cm²）' }];
const UNITS_VOLUME = [{ id: 'cm3', label: '立方厘米（cm³）' }];
const UNITS_LAYER = [{ id: 'layer', label: '层' }];

/** objectMapping rows over the three cylinder faces (L34-4). */
const faceMapping = (prompt) => ({
  kind: 'objectMapping',
  prompt,
  pairs: Object.keys(FACE_LABELS_L3).map((id) => ({ leftId: id, leftLabel: FACE_LABELS_L3[id], rightOptions: FACE_RIGHT_OPTIONS })),
});
const askFaceMapping = (id, prompt) => ({
  id,
  kind: 'mapping',
  prompt,
  leftIds: Object.keys(FACE_LABELS_L3),
  rightOptions: FACE_RIGHT_OPTIONS,
});
/** single-row objectMapping carrying a labeled choice in VERIFY (choice is a
 * predict-ask kind only; frozen three-segment VERIFY carries it as a row). */
const choiceRow = (prompt, leftId, leftLabel, rightOptions) => ({
  kind: 'objectMapping',
  prompt,
  pairs: [{ leftId, leftLabel, rightOptions }],
});

// predict asks (prediction phase only; non-claim asks serialize into
// recordPrediction.explanation — documented decision PREDICTION_CARRIER)
const askChoice = (id, prompt, options) => ({ id, kind: 'choice', prompt, options });
const askDirections = (id, prompt, properties) => ({
  id,
  kind: 'propertyDirections',
  prompt,
  properties,
  optionalUncertain: true,
});
const askNumber = (id, prompt, quantityLabel, units) => ({
  id,
  kind: 'numberValue',
  prompt,
  quantityLabel,
  units,
});
const askMapping = (id, prompt, leftIds, rightOptions) => ({
  id,
  kind: 'mapping',
  prompt,
  leftIds,
  rightOptions,
});
const BET_OPTIONS = [DIRECTION_LABELS.INCREASE, DIRECTION_LABELS.DECREASE].map((l, i) => ({
  id: i === 0 ? 'INCREASE' : 'DECREASE',
  label: l,
}));

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------
const tasks = [];

function addTask(t) {
  const { givens: dims, ...rest } = t;
  const givens = {
    radiusMm: dims[0],
    heightMm: dims[1],
    unrollPermille: 0,
    section: 'NONE',
    selectedFaceIds: [],
    // @2 tasks (cylinder.layers.v1, L34-1) carry the layer pair in givens;
    // layerCount comes from the authored layer spec (default 0 = authoring bug).
    ...(t.taskFamily === 'cylinder.layers.v1'
      ? { layerCount: dims[2], visibleLayerCount: 0 }
      : {}),
  };
  tasks.push({ ...rest, taskVersion: '1', givens });
}

// ----- L1 G1: rotation view-invariance -------------------------------------
addTask({
  taskId: 'cyl.param.g1.view-invariance.v1',
  taskFamily: 'cylinder.parameters.v1',
  kind: 'GUIDED',
  title: '旋转视角不改变尺寸',
  givens: [30, 80],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l1.viewChange.v1',
  allowedOperationIds: [],
  operationConstraints: [],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm', 'mm'] },
  prompt: [
    { type: 'TEXT', text: '一个圆筒和你的眼睛' },
    { type: 'TEXT', text: '屏幕上有一个圆筒。它现在的半径是 3.0 cm，高是 8.0 cm。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '尺寸' }, { label: '数值', unitId: 'cm' }],
      rows: [
        ['半径 r', '3.0'],
        ['高度 h', '8.0'],
      ],
    },
    {
      type: 'TEXT',
      text: '如果只用鼠标或方向键绕着它转动观察、放大缩小，不去碰任何尺寸设置，它的半径、直径或高度会改变吗？先在下面填你的预测，再动手转动观察。',
    },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.size-unchanged', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '这个圆筒半径 3.0 cm、高 8.0 cm。你只转动观察、放大缩小，不碰任何尺寸设置。问题是：它的半径或高度会不会变？' },
    { level: 2, label: '概念提示', text: '「看的角度」和「物体自己的大小」是两件不同的事。' },
    { level: 3, label: '策略提示', text: '转动时你改变的是相机位置还是圆筒的尺寸数字？转动前后各看一眼尺寸表里的数字有没有动。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.g1.what-changed',
        prompt: '转动观察时，真正改变的是什么？',
        options: [
          { id: 'opt-view-angle', label: '观察视角（相机位置）' },
          { id: 'opt-radius', label: '半径' },
          { id: 'opt-height', label: '高度' },
          { id: 'opt-nothing', label: '都没有变' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '为什么转动之后圆筒「看起来」不一样了，但它的尺寸没有变？',
  },
  exitEvidence: ['firstPrediction', 'observationSnapshot', 'submission', 'explanation'],
  expressions: {
    webgl2: 'three.js WebGL2 参数化圆柱；尺寸标注随 givens 可见；轨道旋转/缩放/复位为 ViewState，不产生领域事件。',
    svgDom: '正交视图按钮（前视/侧视/俯视）+ 同一尺寸表 + 复位/缩放；同一任务卡与响应表单，判分接口相同。',
  },
});

// ----- L1 G2: change radius only, predict diameter --------------------------
addTask({
  taskId: 'cyl.param.g2.radius-change.v1',
  taskFamily: 'cylinder.parameters.v1',
  kind: 'GUIDED',
  title: '只改半径，预测直径',
  givens: [30, 80],
  givenLocks: ['heightMm'],
  responseSchemaId: 'resp.l1.predictDimension.v1',
  allowedOperationIds: ['SetDimension'],
  operationConstraints: [{ type: 'SetDimension', dimension: 'RADIUS', valuesMm: [40] }],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm', 'mm'] },
  prompt: [
    { type: 'TEXT', text: '把圆筒变粗一点' },
    { type: 'TEXT', text: '这个圆筒半径 3.0 cm、高 8.0 cm。现在我们只改一件事：把半径改成 4.0 cm，高度不动。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '尺寸' }, { label: '现在', unitId: 'cm' }, { label: '改动后（脚本）', unitId: 'cm' }],
      rows: [
        ['半径 r', '3.0', '4.0'],
        ['高度 h', '8.0', '8.0（不变）'],
      ],
    },
    { type: 'TEXT', text: '动手改之前先预测：改完之后，直径会是多少？会变大、变小还是不变？' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'dim.diameter', phases: OPERATE_ON, note: 'OPERATE 阶段确认前显示「未确认 —」，确认后显示直径读数' },
    { material: 'card.before-after', phases: OPERATE_ON },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '只把半径从 3.0 cm 改成 4.0 cm，高度不变。你要预测：新的直径是多少？' },
    { level: 2, label: '概念提示', text: '想想直径和半径是什么关系。' },
    { level: 3, label: '策略提示', text: '直径 = 半径 × 2；用新的半径 4.0 cm 算一遍。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.g2.which-followed',
        prompt: '半径变大之后，下面哪些量跟着变了？（可多选）',
        multi: true,
        options: [
          { id: 'opt-radius', label: '半径' },
          { id: 'opt-diameter', label: '直径' },
          { id: 'opt-height', label: '高度' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '为什么高度没有变？你怎么确认的？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '带标签的数字输入、步进按钮与确认按钮；未确认预览标注「未确认」，确认后显示新尺寸并保留旧参数对照。',
    svgDom: '同一组输入控件驱动 SVG 轮廓（底圆宽度随 r 变化）与同一尺寸表；确认/未确认用文字标注。',
  },
});

// ----- L1 G3: change height + sections --------------------------------------
addTask({
  taskId: 'cyl.param.g3.height-section.v1',
  taskFamily: 'cylinder.parameters.v1',
  kind: 'GUIDED',
  title: '只改高度，再看切面',
  givens: [30, 80],
  givenLocks: ['radiusMm'],
  responseSchemaId: 'resp.l1.dimensionRead.v1',
  allowedOperationIds: ['SetDimension', 'SetSection'],
  operationConstraints: [
    { type: 'SetDimension', dimension: 'HEIGHT', valuesMm: [100] },
    { type: 'SetSection', sections: ['NONE', 'TRANSVERSE', 'AXIAL'] },
  ],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm', 'mm'] },
  prompt: [
    { type: 'TEXT', text: '把圆筒拉高，再切开看看' },
    { type: 'TEXT', text: '这个圆筒半径 3.0 cm、高 8.0 cm。这一次我们只改高度：把高改成 10.0 cm，半径不动。' },
    {
      type: 'TEXT',
      text: '切面小课堂：横截面是垂直于圆筒的轴切开后看到的切面；轴截面是沿着轴切开（切面穿过轴）看到的切面。',
    },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '尺寸' }, { label: '现在', unitId: 'cm' }, { label: '改动后（脚本）', unitId: 'cm' }],
      rows: [
        ['高度 h', '8.0', '10.0'],
        ['半径 r', '3.0', '3.0（不变）'],
      ],
    },
    { type: 'TEXT', text: '先猜一猜，再动手：① 改完之后圆筒的高是多少？② 横截面和轴截面中，哪一个切面里能看到高？' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'card.section', phases: OPERATE_ON },
    { material: 'card.before-after', phases: OPERATE_ON },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '只把高从 8.0 cm 改成 10.0 cm，半径不动。两个子问：新的高是多少；横截面和轴截面哪个切面里能看到高。' },
    { level: 2, label: '概念提示', text: '切面是「切开之后露出的那个平面图形」；高是沿着轴方向的长度。' },
    { level: 3, label: '策略提示', text: '先切横截面，在这个图形里找一找有没有和高一样长的边；再切轴截面，同样找一找。哪个图形里有这样的边，哪个切面就能显示高。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.g3.which-followed',
        prompt: '只改高度之后，下面哪些量变了？（可多选）',
        multi: true,
        options: [
          { id: 'opt-radius', label: '半径' },
          { id: 'opt-diameter', label: '直径' },
          { id: 'opt-height', label: '高度' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '横截面和轴截面分别是什么形状？为什么轴截面里能看到高、横截面里看不到？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '三项 radio 切换 NONE/TRANSVERSE/AXIAL，切面高亮显示；高度输入/步进/确认控件同 G2 模式；切面状态用文字说明。',
    svgDom: '截面 radio（带文字标签与形状示意：圆/矩形/无）；SVG 绘制当前切面形状并与同一尺寸表联动。',
  },
});

// ----- L1 I1: identify changes (labels hidden, scripted change) -------------
addTask({
  taskId: 'cyl.param.i1.identify-changes.v1',
  taskFamily: 'cylinder.parameters.v1',
  kind: 'INDEPENDENT',
  title: '圆筒悄悄变了',
  givens: [45, 120],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l1.identifyParams.v1',
  allowedOperationIds: [],
  operationConstraints: [],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm', 'mm'] },
  prompt: [
    { type: 'TEXT', text: '圆筒悄悄变了' },
    { type: 'TEXT', text: '这是一个新的圆筒，尺寸和刚才的不一样，而且现在不给你看尺寸数字。' },
    { type: 'TEXT', text: '接下来会发生两件事：画面会请你转到新的视角观察，同时其中一个尺寸——半径或者高度——会被悄悄改变。你事先不知道是哪一个。' },
    { type: 'TEXT', text: '先预测：如果变的是半径，直径会怎样？如果变的是高度，直径会怎样？预测保存后改变才会发生。' },
    { type: 'TEXT', text: '观察之后回答：这次到底变了哪些量？变大了还是变小了？' },
  ],
  visibility: [
    { material: 'givens.table', phases: [], rows: ['radius', 'height'], note: '独立题：数值读数全档隐藏，REVIEW 由比对卡解禁' },
    { material: 'dim.radius', phases: [] },
    { material: 'dim.diameter', phases: [] },
    { material: 'dim.height', phases: [] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.before-after', phases: ['REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '一个新圆筒，没有尺寸数字。画面会换视角，同时半径或高度之一会被悄悄改变。你要答：哪些量变了、变大了还是变小了。' },
    { level: 2, label: '概念提示', text: '转动视角会改变画面，但不会改变尺寸；想办法把「画面变了」和「尺寸变了」分开验证。' },
    { level: 3, label: '策略提示', text: '转到正侧面固定视角对比前后：水平方向的宽度对应直径（半径×2），竖直方向对应高。宽度变了→半径和直径都变；竖直方向变了→高度变。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.i1.how',
        prompt: '你主要靠什么分辨出来的？',
        options: [
          { id: 'opt-fixed-view-compare', label: '固定视角对比前后轮廓' },
          { id: 'opt-side-view-check', label: '转到正侧面看宽度和高度' },
          { id: 'opt-repeat-rotate', label: '反复转动排除视角因素' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '如果只看一次画面、不转动视角，你能确定是哪个变了吗？为什么？',
  },
  exitEvidence: ['firstPrediction', 'scriptedChangeSnapshot', 'submission', 'explanation'],
  expressions: {
    webgl2: '无尺寸标注的圆柱；脚本变更以一次动画呈现（权威状态已先落库）；REVIEW 前画面与标注层不含 r/d/h 数值。',
    svgDom: '前/侧/俯视按钮 + 复位；SVG 轮廓随确认状态重绘；无尺寸表控件，比对卡 REVIEW 才注入 DOM。',
  },
});

// ----- L1 I2: structured single-parameter prediction ------------------------
addTask({
  taskId: 'cyl.param.i2.predict-single-change.v1',
  taskFamily: 'cylinder.parameters.v1',
  kind: 'INDEPENDENT',
  title: '预测直径',
  givens: [20, 70],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l1.predictDimension.v1',
  allowedOperationIds: [],
  operationConstraints: [],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm', 'mm'] },
  prompt: [
    { type: 'TEXT', text: '预测直径' },
    { type: 'TEXT', text: '一个新的圆筒：半径 2.0 cm，高 7.0 cm。它的半径和高度标签可见，直径不给你看。' },
    { type: 'TEXT', text: '它即将发生一个改变：高度将从 7.0 cm 变成 13.0 cm，半径不变。预测保存后改变才会发生。' },
    { type: 'TEXT', text: '预测：① 高度变化后，直径会变大、变小还是不变？② 新的直径是多少？' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'dim.diameter', phases: ['REVIEW'], note: '直径读数 REVIEW 前在任何通道不出现' },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.before-after', phases: ['REVIEW'] },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '圆筒半径 2.0 cm、高 7.0 cm。即将发生：高度变成 13.0 cm，半径不变。你要预测直径的方向和新值。' },
    { level: 2, label: '概念提示', text: '直径是跟着半径走，还是跟着高度走？' },
    { level: 3, label: '策略提示', text: '直径 = 半径 × 2，高度不进入这个关系；用半径算一遍。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.i2.why',
        prompt: '直径为什么这样变？',
        options: [
          { id: 'opt-d-eq-2r', label: '直径 = 半径 × 2，半径变它就跟着变' },
          { id: 'opt-h-no-effect', label: '高度不影响直径' },
          { id: 'opt-unclear', label: '说不清' },
        ],
      },
    ],
    freeTextPrompt: '如果这次是半径变小，直径会怎样？如果改的是高度呢？',
  },
  exitEvidence: ['firstPrediction', 'scriptedChangeSnapshot', 'submission', 'explanation'],
  expressions: {
    webgl2: '半径/高度标注可见、直径标注不渲染；脚本变更一次动画呈现（ViewState 呈现已落库变更）。',
    svgDom: 'givens 数值表（半径/高度两行，直径行 REVIEW 前不注入 DOM）；视角按钮；同一表单与判分接口。',
  },
});

// ----- L2 G1: unroll observation, direction relation ------------------------
addTask({
  taskId: 'cyl.net.g1.unroll-observe.v1',
  taskFamily: 'cylinder.net.v1',
  kind: 'GUIDED',
  title: '把圆筒的侧面摊开',
  givens: [30, 80],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l2.directionRelation.v1',
  allowedOperationIds: ['SetUnroll'],
  operationConstraints: [{ type: 'SetUnroll', minPermille: 0, maxPermille: 1000 }],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm'] },
  prompt: [
    { type: 'TEXT', text: '把圆筒的侧面摊开' },
    { type: 'TEXT', text: '一个圆筒：底面半径 3.0 cm，高 8.0 cm。侧面（不含两个底面）可以沿接缝摊开成一张平面条带，四条边有编号 1–4。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '尺寸' }, { label: '数值', unitId: 'cm' }],
      rows: [
        ['半径 r', '3.0'],
        ['高度 h', '8.0'],
      ],
    },
    { type: 'TEXT', text: '先猜一猜：摊开后哪些长度没有变？条带里，哪条边对应原来底面的圆周？哪条边会成为高？每一项都可以选「不确定」。π 取 3.14。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'net.edge-markers', phases: PHASES_ALL },
    { material: 'card.formula-C', phases: OPERATE_ON },
    { material: 'card.measure-C', phases: OPERATE_ON },
    { material: 'card.measure-strip', phases: OPERATE_ON },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '圆筒 r=3.0 cm、h=8.0 cm。摊开的是侧面，四条边有编号。你要判断：哪条边卷回去形成底面圆周、哪条边成为高。' },
    { level: 2, label: '概念提示', text: '摊开只是换样子，纸没有被拉长也没有被剪掉——想想侧面原来是沿着什么绕了一圈、沿着什么从上走到下。' },
    { level: 3, label: '策略提示', text: '先完全摊开，再慢慢卷回去，盯着一条编号边看它回到哪里；对照测量卡上的两个长度。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.netg1.circle-edge',
        prompt: '卷回后，哪条边形成底面圆的圆周？',
        options: [
          { id: 'net-edge-1', label: '边 1' },
          { id: 'net-edge-2', label: '边 2' },
          { id: 'net-edge-3', label: '边 3' },
          { id: 'net-edge-4', label: '边 4' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.netg1.length-source',
        prompt: '条带周长方向那条边的长度，和底面圆的什么一样？',
        options: [
          { id: 'opt-len-circle', label: '绕底面圆一圈的长度（圆周长）' },
          { id: 'opt-len-radius', label: '底面圆的半径' },
          { id: 'opt-len-diameter', label: '底面圆的直径' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '为什么摊开后这条边的长度没有变？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '弧段随 permille 逐步展开为条带，编号标记锚定于四边随动画移动，测量卡挂接条带两方向边。',
    svgDom: '圆周按同参数分段、与展开条带一一点位联动，同一编号标记、同一测量卡、同一表单；slider/按钮/键盘入口与 3D 相同。',
  },
});

// ----- L2 G2: edge pairing --------------------------------------------------
addTask({
  taskId: 'cyl.net.g2.edge-pairing.v1',
  taskFamily: 'cylinder.net.v1',
  kind: 'GUIDED',
  title: '条带的边来自哪里',
  givens: [30, 80],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l2.edgePair.v1',
  allowedOperationIds: ['SetUnroll'],
  operationConstraints: [{ type: 'SetUnroll', minPermille: 0, maxPermille: 1000 }],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm'] },
  prompt: [
    { type: 'TEXT', text: '条带的边来自哪里' },
    { type: 'TEXT', text: '还是这个圆筒：r=3.0 cm，h=8.0 cm。条带四条边编号 1–4。' },
    { type: 'TEXT', text: '把条带的四条边分别和圆筒配对：每条边卷回去以后，它是上底圆、下底圆，还是高（侧面上一条从上到下的直线）？先写下配对猜测，再展开、回卷检查。每条边都可以选「不确定」。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'net.edge-markers', phases: PHASES_ALL },
    { material: 'card.formula-C', phases: OPERATE_ON, note: '本任务非必需材料，仅供对照' },
    { material: 'card.measure-C', phases: OPERATE_ON, note: '非必需，仅供对照' },
    { material: 'card.measure-strip', phases: OPERATE_ON, note: '非必需，仅供对照' },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '圆筒 r=3.0 cm、h=8.0 cm。把四条编号边分别配上：上底圆 / 下底圆 / 高。' },
    { level: 2, label: '概念提示', text: '侧面和每个底面相接的地方是一条圆周；和上底相接、和下底相接，是两条不同的边。' },
    { level: 3, label: '策略提示', text: '回卷一小段，看每条编号边正贴着圆筒的哪个部分；先配能确定的，剩下的再看。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.netg2.edge2-origin',
        prompt: '向同学解释「编号 2 的边来自哪里」，选最接近的说法：',
        options: [
          { id: 'opt-from-upper-circle', label: '它原来就是上底圆的边' },
          { id: 'opt-because-longer', label: '因为它比较长' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '你怎么判断一条边卷回去贴着谁？用两三句话说明。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '选中某条边时高亮该边并淡显其配对目标候选；两组 select/radio 呈现，不依赖拖线。',
    svgDom: '条带边与部件清单同为可点选/键盘可选对象，相同对象 ID、相同表单与判分。',
  },
});

// ----- L2 G3: lateral area exploration --------------------------------------
addTask({
  taskId: 'cyl.net.g3.lateral-area.v1',
  taskFamily: 'cylinder.net.v1',
  kind: 'GUIDED',
  title: '侧面有多大',
  givens: [30, 80],
  givenLocks: [],
  responseSchemaId: 'resp.l2.areaValue.v1',
  allowedOperationIds: ['SetUnroll', 'SetDimension'],
  operationConstraints: [
    { type: 'SetUnroll', minPermille: 0, maxPermille: 1000 },
    { type: 'SetDimension', dimension: 'RADIUS', minMm: 5, maxMm: 100 },
    { type: 'SetDimension', dimension: 'HEIGHT', minMm: 10, maxMm: 200 },
  ],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm2'] },
  prompt: [
    { type: 'TEXT', text: '侧面有多大' },
    { type: 'TEXT', text: '现在这个圆筒：r=3.0 cm，h=8.0 cm。侧面展开后是一个长方形。' },
    {
      type: 'FORMULA',
      expression: 'C = 2πr （π 取 3.14；观察阶段揭示）',
    },
    {
      type: 'FORMULA',
      expression: 'S侧 = C × h （观察阶段揭示）',
    },
    { type: 'TEXT', text: '现在确认的尺寸下，侧面的面积是多少平方厘米？你可以展开、卷起，也可以改半径或高度，看看面积和什么有关。π 取 3.14，四舍五入保留两位小数，并选择单位。预测不求正确。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'], note: '显示当前确认值，随确认操作更新' },
    { material: 'net.edge-markers', phases: PHASES_ALL },
    { material: 'card.formula-C', phases: OPERATE_ON },
    { material: 'card.formula-S', phases: OPERATE_ON },
    { material: 'card.measure-C', phases: OPERATE_ON },
    { material: 'card.measure-strip', phases: OPERATE_ON },
    { material: 'card.measure-S', phases: ['REVIEW'], note: '目标面积数值 REVIEW 前不下发' },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '当前确认尺寸下求侧面面积；π 取 3.14，四舍五入保留两位小数并选单位。' },
    { level: 2, label: '概念提示', text: '摊开的侧面是长方形；长方形的面积由两条边长决定——这两条边长分别从圆筒的哪里来？' },
    { level: 3, label: '策略提示', text: '先算底面周长 C=2πr，再乘高 h；面积单位用平方厘米。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.netg3.r-effect',
        prompt: '把 r 变大，侧面积会：',
        options: [
          { id: 'opt-bigger', label: '变大' },
          { id: 'opt-smaller', label: '变小' },
          { id: 'opt-same', label: '不变' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.netg3.h-effect',
        prompt: '把 h 变大呢？',
        options: [
          { id: 'opt-bigger', label: '变大' },
          { id: 'opt-smaller', label: '变小' },
          { id: 'opt-same', label: '不变' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.netg3.base-included',
        prompt: '算侧面积时，两个底面的面积要算进去吗：',
        options: [
          { id: 'opt-yes', label: '要' },
          { id: 'opt-no', label: '不要' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '为什么侧面面积=底面周长×高？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '展开条带随尺寸变化等比例重绘，观察档公式卡挂接条带两向边长。',
    svgDom: '等比例矩形与尺寸表/测量卡同步；参数输入+确认控件与 3D 同一 typed intent、同一表单与判分。',
  },
});

// ----- L2 I1: independent pairing, normal proportions ------------------------
addTask({
  taskId: 'cyl.net.i1.pair-normal.v1',
  taskFamily: 'cylinder.net.v1',
  kind: 'INDEPENDENT',
  title: '新的圆筒',
  givens: [40, 50],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l2.edgePair.v1',
  allowedOperationIds: ['SetUnroll'],
  operationConstraints: [{ type: 'SetUnroll', minPermille: 0, maxPermille: 1000 }],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm'] },
  prompt: [
    { type: 'TEXT', text: '新的圆筒' },
    { type: 'TEXT', text: '一个新圆筒：r=4.0 cm，h=5.0 cm。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '尺寸' }, { label: '数值', unitId: 'cm' }],
      rows: [
        ['半径 r', '4.0'],
        ['高度 h', '5.0'],
      ],
    },
    { type: 'TEXT', text: '把侧面完全展开，把条带的四条边（编号 1–4）和圆筒配对：每条边卷回去以后，它是上底圆、下底圆，还是高？每条边都可以选「不确定」。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'net.edge-markers', phases: PHASES_ALL },
    { material: 'card.formula-C', phases: PHASES_ALL, note: '公开公式卡，不含数值' },
    { material: 'card.formula-S', phases: PHASES_ALL, note: '公开公式卡，不含数值' },
    { material: 'card.measure-C', phases: ['REVIEW'] },
    { material: 'card.measure-strip', phases: ['REVIEW'] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '新圆筒 r=4.0 cm、h=5.0 cm。四条编号边各配上：上底圆 / 下底圆 / 高。' },
    { level: 2, label: '概念提示', text: '侧面和每个底面相接的地方是一条圆周；和上底相接、和下底相接，是两条不同的边。' },
    { level: 3, label: '策略提示', text: '回卷一小段，看每条编号边贴着谁。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.neti1.circle-edges',
        prompt: '卷回后哪两条边形成底面圆的圆周？（可多选）',
        multi: true,
        options: [
          { id: 'net-edge-1', label: '边 1' },
          { id: 'net-edge-2', label: '边 2' },
          { id: 'net-edge-3', label: '边 3' },
          { id: 'net-edge-4', label: '边 4' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.neti1.height-edges',
        prompt: '哪两条边成为高？（可多选）',
        multi: true,
        options: [
          { id: 'net-edge-1', label: '边 1' },
          { id: 'net-edge-2', label: '边 2' },
          { id: 'net-edge-3', label: '边 3' },
          { id: 'net-edge-4', label: '边 4' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '为什么你这样配对？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '同 G2 基线；测量读数隐藏，仅边编号与形状呈现。',
    svgDom: '同 G2 基线；SVG 尺寸表同受投影约束（测量读数 REVIEW 前不注入）。',
  },
});

// ----- L2 I2: tall-thin counter-example -------------------------------------
addTask({
  taskId: 'cyl.net.i2.pair-tall-thin.v1',
  taskFamily: 'cylinder.net.v1',
  kind: 'INDEPENDENT',
  title: '又高又细的圆筒',
  givens: [5, 120],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l2.edgePair.v1',
  allowedOperationIds: ['SetUnroll'],
  operationConstraints: [{ type: 'SetUnroll', minPermille: 0, maxPermille: 1000 }],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm'] },
  prompt: [
    { type: 'TEXT', text: '又高又细的圆筒' },
    { type: 'TEXT', text: '一个新圆筒：r=0.5 cm，h=12.0 cm。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '尺寸' }, { label: '数值', unitId: 'cm' }],
      rows: [
        ['半径 r', '0.5'],
        ['高度 h', '12.0'],
      ],
    },
    { type: 'TEXT', text: '把侧面完全展开，把条带的四条边（编号 1–4）和圆筒配对：每条边卷回去以后，它是上底圆、下底圆，还是高？每条边都可以选「不确定」。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'net.edge-markers', phases: PHASES_ALL },
    { material: 'card.formula-C', phases: PHASES_ALL, note: '公开公式卡，不含数值' },
    { material: 'card.formula-S', phases: PHASES_ALL, note: '公开公式卡，不含数值' },
    { material: 'card.measure-C', phases: ['REVIEW'] },
    { material: 'card.measure-strip', phases: ['REVIEW'] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '新圆筒 r=0.5 cm、h=12.0 cm。四条编号边各配上：上底圆 / 下底圆 / 高。' },
    { level: 2, label: '概念提示', text: '卷回去的时候，每条边会贴到圆筒的一个部分——用「贴着谁」来判断。' },
    { level: 3, label: '策略提示', text: '回卷一小段，看每条编号边贴着谁；这个圆筒很细，注意它会卷成什么样的圆。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'selfreport.strategy',
        prompt: '你刚才主要用什么方法配对？（如实选，不影响判分）',
        options: [
          { id: 'opt-strategy-by-appearance', label: '按画面里边的长短或横竖配' },
          { id: 'opt-strategy-by-rollback', label: '按卷回去贴着谁配' },
          { id: 'opt-strategy-guessed', label: '猜的' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.neti2.circle-edges',
        prompt: '卷回后哪两条边形成底面圆的圆周？（可多选）',
        multi: true,
        options: [
          { id: 'net-edge-1', label: '边 1' },
          { id: 'net-edge-2', label: '边 2' },
          { id: 'net-edge-3', label: '边 3' },
          { id: 'net-edge-4', label: '边 4' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.neti2.height-edges',
        prompt: '哪两条边成为高？（可多选）',
        multi: true,
        options: [
          { id: 'net-edge-1', label: '边 1' },
          { id: 'net-edge-2', label: '边 2' },
          { id: 'net-edge-3', label: '边 3' },
          { id: 'net-edge-4', label: '边 4' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.neti2.long-edge-myth',
        prompt: '有人说「长的边就是圆周的边」，你同意吗：',
        options: [
          { id: 'opt-agree', label: '同意' },
          { id: 'opt-disagree', label: '不同意' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '用这个又高又细的圆筒说明你的理由。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '竖长条带在两种表达中以同一参数锚定绘制，编号标记不因条带竖长而改号。',
    svgDom: '同 G2 基线；测量读数 REVIEW 前不注入。',
  },
});

// ----- L2 I3: area value + unit ---------------------------------------------
addTask({
  taskId: 'cyl.net.i3.area-value-unit.v1',
  taskFamily: 'cylinder.net.v1',
  kind: 'INDEPENDENT',
  title: '算一算侧面',
  givens: [25, 100],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l2.areaValue.v1',
  allowedOperationIds: ['SetUnroll'],
  operationConstraints: [{ type: 'SetUnroll', minPermille: 0, maxPermille: 1000 }],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm2'] },
  prompt: [
    { type: 'TEXT', text: '算一算侧面' },
    { type: 'TEXT', text: '一个圆筒，尺寸见场景标注（r、h 以 cm 显示）。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '尺寸' }, { label: '数值', unitId: 'cm' }],
      rows: [
        ['半径 r', '2.5'],
        ['高度 h', '10.0'],
      ],
    },
    { type: 'TEXT', text: '侧面展开后，侧面的面积是多少？先预测，再算并提交。π 取 3.14，四舍五入保留两位小数，并选择单位。你可以展开侧面帮助思考。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'net.edge-markers', phases: PHASES_ALL },
    { material: 'card.formula-C', phases: PHASES_ALL, note: '公开公式卡，不含数值' },
    { material: 'card.formula-S', phases: PHASES_ALL, note: '公开公式卡，不含数值' },
    { material: 'card.measure-C', phases: ['REVIEW'] },
    { material: 'card.measure-S', phases: ['REVIEW'] },
    { material: 'card.measure-strip', phases: ['REVIEW'] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: 'r=2.5 cm、h=10.0 cm。求侧面面积；π 取 3.14，四舍五入保留两位小数并选单位。' },
    { level: 2, label: '概念提示', text: '侧面摊开是长方形，面积是两条边长相乘——两条边长各从哪里来？' },
    { level: 3, label: '策略提示', text: '先算 C=2×3.14×r，再乘 h；面积单位用平方厘米。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.neti3.base-included',
        prompt: '算侧面积时两个底面要不要算进去：',
        options: [
          { id: 'opt-yes', label: '要' },
          { id: 'opt-no', label: '不要' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.neti3.unit-why',
        prompt: '面积单位为什么是平方厘米：',
        options: [
          { id: 'opt-length-times-length', label: '长度×长度' },
          { id: 'opt-task-rule', label: '题目规定' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '写给你的算式和理由。',
  },
  exitEvidence: ['firstPrediction', 'submission', 'explanation'],
  expressions: {
    webgl2: '数字/单位表单与提交按钮在两种表达为同一控件、同一服务端判分。',
    svgDom: 'SVG 尺寸表显示 givens，测量读数受同一投影约束。',
  },
});

// ----- L2 S1: stranger task (water-bottle wrap sticker) ---------------------
addTask({
  taskId: 'cyl.net.s1.stranger-relabel.v1',
  taskFamily: 'cylinder.net.v1',
  kind: 'STRANGER',
  title: '运动水壶的包裹贴纸',
  givens: [15, 90],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l2.strangerComposite.v1',
  allowedOperationIds: ['SetUnroll'],
  operationConstraints: [{ type: 'SetUnroll', minPermille: 0, maxPermille: 1000 }],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm', 'cm2'] },
  prompt: [
    { type: 'TEXT', text: '运动水壶的包裹贴纸' },
    { type: 'TEXT', text: '给一个运动水壶的瓶身贴一层包裹贴纸，只贴侧面，不贴上下底。瓶身是圆柱形：底面直径 3.0 cm，贴纸的高 9.0 cm。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '已知' }, { label: '数值', unitId: 'cm' }],
      rows: [
        ['底面直径 d', '3.0'],
        ['贴纸的高 h', '9.0'],
      ],
    },
    { type: 'TEXT', text: '(1) 瓶身的半径是多少厘米？(2) 把贴纸摊开，四条边（编号 1–4）分别卷回去贴着谁（上底圆/下底圆/高）？(3) 卷回去以后，哪条边形成底面的圆周？哪条边成为高？(4) 这张贴纸的面积是多少平方厘米？' },
    { type: 'TEXT', text: 'π 取 3.14，第 (4) 问四舍五入保留两位小数并选择单位。每项都可以选「不确定」。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['diameter', 'height'], note: '故事 given：直径与高可见' },
    { material: 'dim.radius', phases: ['REVIEW'], note: '半径是参数识别作答目标，REVIEW 前隐藏（含 aria）' },
    { material: 'net.edge-markers', phases: PHASES_ALL },
    { material: 'card.formula-C', phases: ['REVIEW'], note: '陌生任务复测方法回忆，ASSESSMENT 档不主动展示' },
    { material: 'card.formula-S', phases: ['REVIEW'] },
    { material: 'card.measure-C', phases: ['REVIEW'] },
    { material: 'card.measure-S', phases: ['REVIEW'] },
    { material: 'card.measure-strip', phases: ['REVIEW'] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '贴纸只包瓶身侧面。已知底面直径 3.0 cm、贴纸高 9.0 cm。四问：半径；四条边配对；哪条边成圆周/成高；贴纸面积（两位小数+单位）。' },
    { level: 2, label: '概念提示', text: '贴纸只包侧面；摊开后是长方形，它的边和瓶身上的线一一对应。' },
    { level: 3, label: '策略提示', text: '先用直径算半径（r=d÷2），再算 C=2πr，再乘贴纸的高；配对可以回卷一小段验证。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.nets1.circle-edges',
        prompt: '卷回后哪条边形成底面圆的圆周？（可多选）',
        multi: true,
        options: [
          { id: 'net-edge-1', label: '边 1' },
          { id: 'net-edge-2', label: '边 2' },
          { id: 'net-edge-3', label: '边 3' },
          { id: 'net-edge-4', label: '边 4' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.nets1.height-edges',
        prompt: '哪条边成为高？（可多选）',
        multi: true,
        options: [
          { id: 'net-edge-1', label: '边 1' },
          { id: 'net-edge-2', label: '边 2' },
          { id: 'net-edge-3', label: '边 3' },
          { id: 'net-edge-4', label: '边 4' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.nets1.orientation-change',
        prompt: '如果贴纸条带竖着放改成横着放，形成圆周的边会变吗：',
        options: [
          { id: 'opt-yes', label: '会' },
          { id: 'opt-no', label: '不会' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '向家人说明这张贴纸怎么卷回瓶身、面积怎么算。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '条带竖放呈现（两种表达同一朝向策略）；边编号按展开参数化锚定，不随画面朝向改号。',
    svgDom: '竖放条带、参数锚定编号、四段复合表单（分段呈现、段内可选不确定）在两种表达下同构同判分。',
  },
});

// ----- L2 D1: delayed transfer (tea-can label paper) ------------------------
addTask({
  taskId: 'cyl.net.d1.delayed-transfer.v1',
  taskFamily: 'cylinder.net.v1',
  kind: 'DELAYED_TRANSFER',
  title: '茶叶罐的商标纸',
  givens: [20, 55],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l2.strangerComposite.v1',
  allowedOperationIds: ['SetUnroll'],
  operationConstraints: [{ type: 'SetUnroll', minPermille: 0, maxPermille: 1000 }],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm'] },
  prompt: [
    { type: 'TEXT', text: '茶叶罐的商标纸' },
    { type: 'TEXT', text: '一个圆柱形茶叶罐，罐身裹一层商标纸，只包侧面。商标纸的高 5.5 cm，罐身底面圆的周长是 12.56 cm。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '已知' }, { label: '数值', unitId: 'cm' }],
      rows: [
        ['底面圆周长 C', '12.56'],
        ['商标纸的高 h', '5.5'],
      ],
    },
    { type: 'TEXT', text: '(1) 罐身的半径是多少厘米？(2) 商标纸摊开后，四条边（编号 1–4）分别卷回去贴着谁（上底圆/下底圆/高）？(3) 卷回去以后，哪条边形成底面圆的圆周？哪条边成为高？π 取 3.14。每项都可以选「不确定」。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['height'], note: '故事 given：周长以文字给出，高度可见' },
    { material: 'dim.radius', phases: ['REVIEW'], note: '半径为推导目标' },
    { material: 'dim.diameter', phases: ['REVIEW'] },
    { material: 'net.edge-markers', phases: PHASES_ALL },
    { material: 'card.formula-C', phases: ['REVIEW'], note: '迁移复测方法回忆' },
    { material: 'card.formula-S', phases: ['REVIEW'] },
    { material: 'card.measure-C', phases: ['REVIEW'] },
    { material: 'card.measure-strip', phases: ['REVIEW'] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '商标纸只包罐身侧面。已知底面圆周长 12.56 cm、商标纸高 5.5 cm。三问：半径；四条边配对；哪条边成圆周/成高。' },
    { level: 2, label: '概念提示', text: '周长、直径和半径是一家人：C=2πr 倒过来用。' },
    { level: 3, label: '策略提示', text: 'r=C÷(2×3.14)；配对与方向回卷一小段验证。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.netd1.circle-edges',
        prompt: '卷回后哪条边形成底面圆的圆周？（可多选）',
        multi: true,
        options: [
          { id: 'net-edge-1', label: '边 1' },
          { id: 'net-edge-2', label: '边 2' },
          { id: 'net-edge-3', label: '边 3' },
          { id: 'net-edge-4', label: '边 4' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.netd1.height-edges',
        prompt: '哪条边成为高？（可多选）',
        multi: true,
        options: [
          { id: 'net-edge-1', label: '边 1' },
          { id: 'net-edge-2', label: '边 2' },
          { id: 'net-edge-3', label: '边 3' },
          { id: 'net-edge-4', label: '边 4' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.netd1.same-diff',
        prompt: '这次和上次的圆筒题目哪里相同、哪里不同？（可多选）',
        multi: true,
        options: [
          { id: 'opt-same-unroll', label: '都是侧面展开对应' },
          { id: 'opt-diff-given-form', label: '参数给法不同' },
          { id: 'opt-same-find-c', label: '都要找周长对应边' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '隔了这些天，你是怎么想起来的？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '同 S1 基线；「回看练习」卡、状态与间隔显示在两种表达下一致。',
    svgDom: '同 S1 基线。',
  },
});

// ===========================================================================
// L3「面的组合」（cylinder.faces.v1，rondo.cyl.l3-r1，renderer 保持 @1）
// ===========================================================================
const FACES_WHITELIST = ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'];
const selectFacesConstraint = { type: 'SelectFaces', allowedFaceIds: FACES_WHITELIST };
const unrollConstraint = { type: 'SetUnroll', minPermille: 0, maxPermille: 1000 };
const TABLE_L3 = (r, h) => [
  { label: '尺寸' }, { label: '数值', unitId: 'cm' },
];

// ----- L3 G1: face inventory, three packagings --------------------------------
addTask({
  taskId: 'cyl.faces.g1.face-inventory.v1',
  taskFamily: 'cylinder.faces.v1',
  kind: 'GUIDED',
  title: '三种包装，三份纸样',
  givens: [30, 80],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l3.faceSet.v1',
  allowedOperationIds: ['SelectFaces', 'SetUnroll'],
  operationConstraints: [selectFacesConstraint, unrollConstraint],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm'] },
  prompt: [
    { type: 'TEXT', text: '三种包装，三份纸样' },
    { type: 'TEXT', text: '小店要给同一个罐身（半径 3.0 cm，高 8.0 cm）做三种纸包装：①标签筒——只在罐身外面裹一圈纸；②笔筒——有底、无盖；③封口罐——有底有盖，完全封住。' },
    { type: 'TEXT', text: '面的小课堂：这个罐子的纸面只有三种——侧面（裹在罐身外的那圈）、上盖面（顶上的圆）、下盖面（底下的圆）。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: TABLE_L3(),
      rows: [
        ['半径 r', '3.0'],
        ['高度 h', '8.0'],
      ],
    },
    { type: 'TEXT', text: '先猜一猜：标签筒要用到哪些面？笔筒呢？把盖子数量点一点：笔筒有几个盖面？封口罐比标签筒多用纸还是少用纸？' },
    { type: 'TEXT', text: '先写下猜测再动手选面、展开检查。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'face.checklist', phases: OPERATE_ON, note: '三面 checkbox + 确认选面按钮 + 盖面计数显示；勾选为草稿，确认发整集 SelectFaces' },
    { material: 'unroll.controls', phases: OPERATE_ON },
    { material: 'card.measure-faces', phases: OPERATE_ON, note: '按面面积测量卡：确认选面后逐面显示' },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '同一个罐身三种包装。当前答：笔筒要哪些面、几个盖面。' },
    { level: 2, label: '概念提示', text: '包装条件（有盖/无盖/有底/无底）决定要算哪些面；「无盖」只说明上面开口，不说明底下不要纸。' },
    { level: 3, label: '策略提示', text: '把三个面逐个问一遍——这个包装要不要侧面？要不要上面的圆？要不要下面的圆？再数一数圆有几个。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.facesg1.most-paper',
        prompt: '标签筒、笔筒、封口罐中用纸最多的是？',
        options: [
          { id: 'opt-sealed', label: '封口罐' },
          { id: 'opt-pen', label: '笔筒' },
          { id: 'opt-label', label: '标签筒' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '为什么无盖的笔筒还是要用一张圆纸？用「底下会漏」或自己的话说一说。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '罐身三面可点选/键盘可达（面 checkbox 清单 + Tab/空格切换），已选面高亮 + 文字标签「已选入纸样」；SetUnroll 展开时保留面摊平为矩形+圆组合；测量卡按面挂接；相机旋转为 ViewState。',
    svgDom: '可点击的展开 SVG 面片（矩形=侧面、两个圆=上下盖）+ 同一面清单 checkbox + 同一测量卡 + 同一表单；盖数 radio（0/1/2）作 DOM 便捷入口，等效展开为两个盖面勾选；同一 typed intent、同一判分。aria：面清单为带组名的 checkbox 组，状态播报「侧面，已选入」。',
  },
});

// ----- L3 G2: one-lid composite area ------------------------------------------
addTask({
  taskId: 'cyl.faces.g2.one-lid-area.v1',
  taskFamily: 'cylinder.faces.v1',
  kind: 'GUIDED',
  title: '无盖笔筒的纸样',
  givens: [30, 80],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l3.comboArea.v1',
  allowedOperationIds: ['SelectFaces', 'SetUnroll'],
  operationConstraints: [selectFacesConstraint, unrollConstraint],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm2'] },
  prompt: [
    { type: 'TEXT', text: '无盖笔筒的纸样' },
    { type: 'TEXT', text: '还是这个罐身：半径 3.0 cm，高 8.0 cm。现在做一批无盖笔筒（有底、无盖），每个笔筒的纸样要算哪些面、一共多少平方厘米？' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: TABLE_L3(),
      rows: [
        ['半径 r', '3.0'],
        ['高度 h', '8.0'],
        ['包装条件', '有底、无盖'],
      ],
    },
    { type: 'TEXT', text: '先猜一猜总共要多少平方厘米，再选面、展开、量一量、算一算。' },
    { type: 'TEXT', text: 'π 取 3.14，四舍五入保留两位小数，并选择单位。预测不求正确。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'face.checklist', phases: OPERATE_ON },
    { material: 'unroll.controls', phases: OPERATE_ON },
    { material: 'card.formula-circle', phases: OPERATE_ON, note: 'S圆=πr²，观察阶段揭示' },
    { material: 'card.formula-combo', phases: OPERATE_ON, note: '组合 = S侧 + 盖数×S圆，观察阶段揭示' },
    { material: 'card.measure-faces', phases: OPERATE_ON, note: '两行单面值（侧面/圆），不含合计' },
    { material: 'card.combo-area-value', phases: ['REVIEW'], note: '组合面积目标值 REVIEW 前不下发' },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: 'r=3.0 cm、h=8.0 cm，条件有底无盖。答总用纸面积，两位小数选单位。' },
    { level: 2, label: '概念提示', text: '纸要按面下料——先想清楚有哪些面，再想每个面的面积怎么算。' },
    { level: 3, label: '策略提示', text: '侧面面积 = 底面周长×高（上一课的 C×h）；一个圆面 = π×r×r；把两份加起来（给步骤不给数值）。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.facesg2.label-tube',
        prompt: '如果把条件改成「无底无盖的标签筒」，纸是多少平方厘米？',
        options: [
          { id: 'opt-side-only', label: '只要侧面那份' },
          { id: 'opt-plus-one', label: '还要加一个圆' },
          { id: 'opt-plus-two', label: '还要加两个圆' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '为什么算笔筒的纸要把一个圆加进去？这个圆对应罐子的哪个部分？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '选面高亮 + 展开摊平（矩形+一个圆并排），测量卡逐面挂接；πr² 公式卡 OBSERVATION 挂接圆面。',
    svgDom: '展开 SVG 面片（矩形+圆）+ 面清单 + 同一表单；键盘路径同 G1；同一判分。aria：数值输入带名称「总面积（平方厘米）」，错误后焦点回字段。',
  },
});

// ----- L3 G3: full surface + flagged human advice card ------------------------
addTask({
  taskId: 'cyl.faces.g3.full-surface.v1',
  taskFamily: 'cylinder.faces.v1',
  kind: 'GUIDED',
  title: '封口罐的表面积，和一张建议单',
  givens: [30, 80],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l3.comboArea.v1',
  allowedOperationIds: ['SelectFaces', 'SetUnroll'],
  operationConstraints: [selectFacesConstraint, unrollConstraint],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm2'] },
  prompt: [
    { type: 'TEXT', text: '封口罐的表面积，和一张建议单' },
    { type: 'TEXT', text: '商店要做一个封口罐（有底有盖）：半径 3.0 cm，高 8.0 cm。仓库的小张写了一张下单建议单，说他不太确定，请你检查。' },
    { type: 'TEXT', text: '建议单（人工编写，可能有错，供检查）：「罐身纸按侧面下料 150.72 cm²；上下两个圆一样大，圆纸样照一份剪就行，面积 28.26 cm²。合计 178.98 cm²。」' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: TABLE_L3(),
      rows: [
        ['半径 r', '3.0'],
        ['高度 h', '8.0'],
        ['包装条件', '有底有盖（封口）'],
      ],
    },
    { type: 'TEXT', text: '① 这张建议单能用吗？问题最可能出在哪？② 封口罐到底要多少平方厘米的纸？先猜再动手验证。' },
    { type: 'TEXT', text: 'π 取 3.14，四舍五入保留两位小数，并选择单位。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'card.advice-flagged', phases: PHASES_ALL, note: 'L34-9：显式标注「人工编写，可能有错」的建议卡；视觉弱于权威读数，DOM 可聚焦全文朗读' },
    { material: 'face.checklist', phases: OPERATE_ON },
    { material: 'unroll.controls', phases: OPERATE_ON },
    { material: 'card.formula-circle', phases: OPERATE_ON },
    { material: 'card.formula-full', phases: OPERATE_ON, note: 'S表 = S侧 + 2×S圆' },
    { material: 'card.measure-faces', phases: OPERATE_ON },
    { material: 'card.surface-value', phases: ['REVIEW'], note: '表面积目标值 REVIEW 前任何通道不下发' },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'], note: '含建议单数值 vs 规范值的漏算修正对照' },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '条件是封口（有底有盖）。两问：检查建议单；封口罐的表面积（两位小数+单位）。' },
    { level: 2, label: '概念提示', text: '建议是人写的，可能漏条件——检查时先问「这个包装到底有几个面」。' },
    { level: 3, label: '策略提示', text: '在场景里把三个面都选上、展开摊平，数一数有几个圆；建议单里的「照一份剪」对应几个圆？' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.facesg3.fix-advice',
        prompt: '帮小张改建议单，最需要补上的一句是？',
        options: [
          { id: 'opt-add-one-circle', label: '再加一份同样的圆纸样' },
          { id: 'opt-double-side', label: '侧面积改成两倍' },
          { id: 'opt-shrink-height', label: '把高度改小一点' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '你是怎么发现建议单漏了条件的？写出你检查时问自己的问题。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '三面全选高亮 + 展开摊平（矩形+两个圆），其余同 G2。',
    svgDom: '展开 SVG 面片（矩形+两圆）+ 面清单 + 建议单为 DOM 卡片（可聚焦朗读，aria 全文可读）；同一表单与判分。',
  },
});

// ----- L3 I1: new-instance face set -------------------------------------------
addTask({
  taskId: 'cyl.faces.i1.faceset-new-instance.v1',
  taskFamily: 'cylinder.faces.v1',
  kind: 'INDEPENDENT',
  title: '爆米花桶的纸样',
  givens: [50, 100],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l3.faceSet.v1',
  allowedOperationIds: ['SelectFaces'],
  operationConstraints: [selectFacesConstraint],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm'] },
  prompt: [
    { type: 'TEXT', text: '爆米花桶的纸样' },
    { type: 'TEXT', text: '一家小店卖桶装爆米花：桶身是圆柱形，半径 5.0 cm，高 10.0 cm。桶有底、没有盖（顶部敞开方便拿）。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: TABLE_L3(),
      rows: [
        ['半径 r', '5.0'],
        ['高度 h', '10.0'],
        ['包装条件', '有底、无盖'],
      ],
    },
    { type: 'TEXT', text: '这个桶的纸样要算哪些面？在场景里把要用的面选出来，再提交你的答案。' },
    { type: 'TEXT', text: '每个面都可以选「不确定」。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'face.checklist', phases: OPERATE_ON },
    { material: 'card.measure-faces', phases: [], note: '独立集合题：任何面积数值全档隐藏（含 aria），REVIEW 由比对卡解禁' },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '新桶 r=5.0 cm、h=10.0 cm，条件有底无盖。答面集合并在场景里选出来。' },
    { level: 2, label: '概念提示', text: '包装条件决定面集合——「无盖」说的是哪一端开口？' },
    { level: 3, label: '策略提示', text: '逐面问：侧面要不要？上面的圆要不要？下面的圆要不要？最后数圆的个数（不给结论）。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.facesi1.add-lid',
        prompt: '如果这批桶要加盖（变成封口桶），多算几个圆面？',
        options: [
          { id: 'opt-0', label: '0 个' },
          { id: 'opt-1', label: '1 个' },
          { id: 'opt-2', label: '2 个' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '向家人说明「这个桶为什么还要一张圆纸」。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '无面积标注的面选择场景（面积数值 REVIEW 前不渲染，含 aria）；checkbox+键盘同 G1。',
    svgDom: '面片 SVG + 面清单；测量卡 REVIEW 前不注入 DOM；同一表单与判分。aria 不播报任何面积数值。',
  },
});

// ----- L3 I2: lid-count condition delta ---------------------------------------
addTask({
  taskId: 'cyl.faces.i2.lid-count-condition.v1',
  taskFamily: 'cylinder.faces.v1',
  kind: 'INDEPENDENT',
  title: '换个包装，多用多少纸',
  givens: [20, 90],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l3.lidDelta.v1',
  allowedOperationIds: ['SelectFaces'],
  operationConstraints: [selectFacesConstraint],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm2'] },
  prompt: [
    { type: 'TEXT', text: '换个包装，多用多少纸' },
    { type: 'TEXT', text: '一个罐身：半径 2.0 cm，高 9.0 cm。现在它只贴一圈标签纸（无盖无底的标签筒）。老板想把它改成封口罐（有底有盖）重新卖。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: TABLE_L3(),
      rows: [
        ['半径 r', '2.0'],
        ['高度 h', '9.0'],
        ['改造方向', '标签筒 → 封口罐'],
      ],
    },
    { type: 'TEXT', text: '改造后比原来多用多少平方厘米的纸？' },
    { type: 'TEXT', text: 'π 取 3.14，四舍五入保留两位小数，并选择单位。每项都可以选「不确定」。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'face.checklist', phases: OPERATE_ON, note: '两个条件的集合可切换观察高亮差（构造辅助）' },
    { material: 'card.formula-circle', phases: PHASES_ALL, note: 'I 类任务公式卡可见（沿 L2-I3 先例）' },
    { material: 'card.measure-faces', phases: ['REVIEW'] },
    { material: 'card.delta-value', phases: ['REVIEW'], note: '多用面积目标值 REVIEW 前不下发' },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: 'r=2.0 cm、h=9.0 cm，从标签筒改成封口罐。答多用的纸（两位小数+单位）。' },
    { level: 2, label: '概念提示', text: '多用出来的纸只会落在「新加进来的面」上——哪些面是新加的？' },
    { level: 3, label: '策略提示', text: '把两种包装的面集合并排比一比，多出的面每个面积是 π×r×r（给步骤不给数值）。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.facesi2.pen-tube',
        prompt: '如果改成的不是封口罐，而是「有底无盖的笔筒」，多用多少？',
        options: [
          { id: 'opt-one-lid', label: '一个盖面的面积' },
          { id: 'opt-two-lid', label: '两个盖面的面积' },
          { id: 'opt-same', label: '不变' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '为什么改包装时侧面那份纸不用重新算？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '两条件面集合切换高亮（「标签筒视图/封口罐视图」两个已确认集合槽），其余同基线。',
    svgDom: '两视图按钮 + 面片 SVG + 同一表单；同一判分。',
  },
});

// ----- L3 I3: full-surface value + unit ---------------------------------------
addTask({
  taskId: 'cyl.faces.i3.surface-value-unit.v1',
  taskFamily: 'cylinder.faces.v1',
  kind: 'INDEPENDENT',
  title: '算一算封口罐的纸',
  givens: [60, 40],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l3.comboArea.v1',
  allowedOperationIds: ['SelectFaces'],
  operationConstraints: [selectFacesConstraint],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm2'] },
  prompt: [
    { type: 'TEXT', text: '算一算封口罐的纸' },
    { type: 'TEXT', text: '一个封口罐（有底有盖），尺寸见场景标注。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: TABLE_L3(),
      rows: [
        ['半径 r', '6.0'],
        ['高度 h', '4.0'],
        ['包装条件', '有底有盖'],
      ],
    },
    { type: 'TEXT', text: '封口罐一共要用多少平方厘米的纸？先预测，再算并提交。' },
    { type: 'TEXT', text: 'π 取 3.14，四舍五入保留两位小数，并选择单位。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height'] },
    { material: 'face.checklist', phases: OPERATE_ON, note: '构造辅助：选面观察' },
    { material: 'card.formula-circle', phases: PHASES_ALL },
    { material: 'card.formula-full', phases: PHASES_ALL },
    { material: 'card.measure-faces', phases: ['REVIEW'], note: '单面面积读数 REVIEW 前全通道隐藏' },
    { material: 'card.surface-value', phases: ['REVIEW'] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '读标注 r=6.0 cm、h=4.0 cm，条件封口。答表面积，两位小数+单位。' },
    { level: 2, label: '概念提示', text: '封口罐的面集合有哪几类？每类的面积公式是什么？' },
    { level: 3, label: '策略提示', text: '先算 C=2×3.14×r 得侧面那份，再算 πr² 得一个圆，封口罐有几个圆就加几份（给步骤不给数值）。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.facesi3.included',
        prompt: '算封口罐用纸时，下面哪些量要算进去？（可多选）',
        multi: true,
        options: [
          { id: 'opt-side', label: '侧面那份' },
          { id: 'opt-upper', label: '上盖面那份' },
          { id: 'opt-lower', label: '下盖面那份' },
          { id: 'opt-height', label: '高度本身' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '写出你的算式（顺序不限），说明每个数是哪个面的。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '同基线（数字/单位表单两表达同控件同判分；SVG 尺寸表显示 givens，测量读数受同一投影约束）。',
    svgDom: '同基线；单面面积读数 REVIEW 前不注入 DOM。',
  },
});

// ===========================================================================
// L4「层叠与体积」（cylinder.layers.v1，rondo.cyl.l4-r1，renderer @2）
// ===========================================================================
const visibleConstraint = { type: 'SetVisibleLayerCount', min: 0, max: 40 };
const CUMULATIVE_NOTE = 'L34-8：行（第 k 层：层厚/该层/累计）只在确认 visibleLayerCount ≥ k 后呈现；两表达渲染同一 DOM CumulativeTable，同步揭示';

// ----- L4 G1: layer-count invariance ------------------------------------------
addTask({
  taskId: 'cyl.layers.g1.stack-invariant.v1',
  taskFamily: 'cylinder.layers.v1',
  kind: 'GUIDED',
  title: '一层层装圆片',
  givens: [30, 80, 8],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l4.stackInvariant.v1',
  allowedOperationIds: ['SetLayerCount', 'SetVisibleLayerCount'],
  operationConstraints: [
    { type: 'SetLayerCount', values: [8, 16] },
    visibleConstraint,
  ],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm3'] },
  prompt: [
    { type: 'TEXT', text: '一层层装圆片' },
    { type: 'TEXT', text: '往罐子里装等厚的圆片：罐身半径 3.0 cm，高 8.0 cm，正好装 8 层，每层厚 1.0 cm。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: TABLE_L3(),
      rows: [
        ['半径 r', '3.0'],
        ['高度 h', '8.0'],
        ['层数 n', '8'],
        ['每层厚', '1.0'],
      ],
    },
    { type: 'TEXT', text: '先猜一猜：如果把层数改成 16 层（每层就更薄了），这个罐子装的东西总体积会变大、变小还是不变？' },
    { type: 'TEXT', text: '先写下猜测，再一层一层推进看看累计表。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height', 'layerCount'] },
    { material: 'layer.controls', phases: OPERATE_ON, note: '层数输入/切换 + 逐层/复位按钮；SetLayerCount ∈ {8,16}' },
    { material: 'table.cumulative', phases: OPERATE_ON, note: CUMULATIVE_NOTE },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'], note: '含 8 层 vs 16 层对照' },
  ],
  hints: [
    { level: 1, label: '重述题意', text: 'r=3.0 cm、h=8.0 cm、8 层每层 1.0 cm。答：改成 16 层时总体积怎么变、每层厚度怎么变，以及 8 层装满的总体积。' },
    { level: 2, label: '概念提示', text: '罐子还是那么大——切法变了，罐子装的东西总量会跟着变吗？' },
    { level: 3, label: '策略提示', text: '把 8 层一层层推满、看最后一行；再切 16 层推满、看最后一行；两次比一比。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.layersg1.why-invariant',
        prompt: '层数变多而总体积不变，是因为：',
        options: [
          { id: 'opt-n-times-t-h', label: '层数×层厚始终等于高度' },
          { id: 'opt-squashed', label: '圆片被压扁了' },
          { id: 'opt-can-grew', label: '罐子变大了' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '用「层数、每层厚度、高度」三个词说一说它们的关系。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '罐内等厚圆片逐层升起（动画帧属 ViewState，权威位为确认的 visibleLayerCount）；层数切换按确认层厚重绘；累计表为 DOM 表挂接场景。',
    svgDom: '二维层条（侧视堆叠矩形，逐层填充）+ 横截面圆（示意每层形状）+ 同一累计表与表单；层数输入、逐层/复位按钮与 3D 同一 typed intent；同一判分。aria：层推进播报「第 k 层已装，累计 X.XX 立方厘米」（适度 live region，不逐帧）。',
  },
});

// ----- L4 G2: per-layer volume --------------------------------------------------
addTask({
  taskId: 'cyl.layers.g2.layer-volume.v1',
  taskFamily: 'cylinder.layers.v1',
  kind: 'GUIDED',
  title: '每一层圆片有多大',
  givens: [30, 80, 8],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l4.layerVolume.v1',
  allowedOperationIds: ['SetLayerCount', 'SetVisibleLayerCount'],
  operationConstraints: [
    { type: 'SetLayerCount', values: [8] },
    visibleConstraint,
  ],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm', 'cm3'] },
  prompt: [
    { type: 'TEXT', text: '每一层圆片有多大' },
    { type: 'TEXT', text: '还是这个罐子：半径 3.0 cm，高 8.0 cm，装 8 层、每层厚 1.0 cm。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: TABLE_L3(),
      rows: [
        ['半径 r', '3.0'],
        ['高度 h', '8.0'],
        ['层数 n', '8'],
        ['层厚', '1.0'],
      ],
    },
    { type: 'TEXT', text: '① 每一层的体积是多少立方厘米？② 8 层装满一共多少立方厘米？先猜再算。' },
    { type: 'TEXT', text: 'π 取 3.14，四舍五入保留两位小数，并选择单位。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height', 'layerCount'] },
    { material: 'layer.controls', phases: OPERATE_ON },
    { material: 'table.cumulative', phases: OPERATE_ON, note: CUMULATIVE_NOTE },
    { material: 'card.formula-base', phases: OPERATE_ON, note: 'S底=πr²' },
    { material: 'card.formula-Vlayer', phases: OPERATE_ON, note: 'V层=S底×层厚' },
    { material: 'card.formula-V', phases: OPERATE_ON, note: 'V=S底×h' },
    { material: 'card.formula-layerthick', phases: OPERATE_ON, note: '层厚=高÷层数' },
    { material: 'card.base-area', phases: OPERATE_ON, note: '底面积值卡为公式印证材料（OBSERVATION 起）' },
    { material: 'card.layer-value', phases: ['REVIEW'], note: '每层体积目标值 REVIEW 前不下发' },
    { material: 'card.volume-value', phases: ['REVIEW'], note: '总量目标值 REVIEW 前不下发' },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: 'r=3.0 cm、h=8.0 cm、8 层。两问：每层体积、总量，两位小数选单位。' },
    { level: 2, label: '概念提示', text: '每一层就是一个很薄的圆柱——它的「底」是那个圆，「高」是层厚。' },
    { level: 3, label: '策略提示', text: '先算底面积 π×r×r，再乘层厚得每层，再乘 8（或直接乘总高 8.0 cm）得总量。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.layersg2.slice-16',
        prompt: '把同一罐子切成 16 层，每一层会：',
        options: [
          { id: 'opt-same', label: '还是 28.26 立方厘米' },
          { id: 'opt-half', label: '变成 14.13 立方厘米' },
          { id: 'opt-double', label: '变成 56.52 立方厘米' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '为什么「每层×层数」和「底面积×高」算出同一个数？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '同 G1 基线；公式卡挂接 SVG 横截面圆（S底）与层条（层厚）；同一表单与判分。',
    svgDom: '同 G1 基线。',
  },
});

// ----- L4 G3: height vs radius (+ second-input check) ---------------------------
addTask({
  taskId: 'cyl.layers.g3.height-vs-radius.v1',
  taskFamily: 'cylinder.layers.v1',
  kind: 'GUIDED',
  title: '加高，还是加宽',
  givens: [30, 80, 8],
  givenLocks: [],
  responseSchemaId: 'resp.l4.varCompare.v1',
  allowedOperationIds: ['SetDimension', 'SetLayerCount', 'SetVisibleLayerCount'],
  operationConstraints: [
    { type: 'SetDimension', dimension: 'RADIUS', valuesMm: [30, 60] },
    { type: 'SetDimension', dimension: 'HEIGHT', valuesMm: [40, 80, 160] },
    { type: 'SetLayerCount', values: [4, 8, 16] },
    visibleConstraint,
  ],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm3'] },
  prompt: [
    { type: 'TEXT', text: '加高，还是加宽' },
    { type: 'TEXT', text: '商店有两个改造方案，都只改一个尺寸：方案甲把高度从 8.0 cm 加倍到 16.0 cm；方案乙把半径从 3.0 cm 加倍到 6.0 cm。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '对象' }, { label: 'r（cm）' }, { label: 'h（cm）' }],
      rows: [
        ['底罐', '3.0', '8.0'],
        ['方案甲（加高）', '3.0', '16.0'],
        ['方案乙（加宽）', '6.0', '8.0'],
        ['复查底罐', '1.0', '4.0'],
        ['复查乙（加宽）', '2.0', '4.0'],
      ],
    },
    { type: 'TEXT', text: '① 两个方案哪个装得多？② 各能装多少立方厘米？③ 半径加倍后，体积是原来的几倍？先猜再动手验证。最后换一组小罐尺寸（复查组）再试一次，看看规律还成立吗。' },
    { type: 'TEXT', text: 'π 取 3.14，四舍五入保留两位小数，并选择单位。每层厚 1.0 cm 不变（复查组 h=4.0 cm 可切 4 层）。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height', 'layerCount'], note: '两方案+复查组数值均为任务脚本公开 givens' },
    { material: 'dim.controls', phases: OPERATE_ON },
    { material: 'layer.controls', phases: OPERATE_ON },
    { material: 'card.formula-base', phases: PHASES_ALL, note: 'G2 已教材料' },
    { material: 'card.formula-V', phases: PHASES_ALL },
    { material: 'card.base-area', phases: OPERATE_ON, note: '随确认尺寸更新' },
    { material: 'card.volume-value', phases: ['REVIEW'], note: '两方案体积目标值 REVIEW 前不下发' },
    { material: 'table.cumulative', phases: OPERATE_ON, note: CUMULATIVE_NOTE },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'], note: '含复查组对照' },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '底罐 r=3.0、h=8.0；甲只把 h 加倍到 16.0；乙只把 r 加倍到 6.0。答哪个装得多、各多少、半径加倍体积几倍；最后换小罐再试。' },
    { level: 2, label: '概念提示', text: '底面是一个圆——半径加倍，圆面积不是加倍；高只是乘法里的一个乘数。' },
    { level: 3, label: '策略提示', text: '分别算两个底面积（π×3×3 和 π×6×6），各乘自己的高，再比大小。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.layersg3.recheck-ratio',
        prompt: '小罐 (r=1.0, h=4.0) 上同样试「半径加倍」，体积变成原来的：',
        options: [
          { id: 'opt-2x', label: '2 倍' },
          { id: 'opt-4x', label: '4 倍' },
          { id: 'opt-same', label: '一样' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.layersg3.proof-boundary',
        prompt: '试了两组尺寸都看到「半径加倍体积 4 倍」，这能证明对所有尺寸都成立吗：',
        options: [
          { id: 'opt-yes', label: '能' },
          { id: 'opt-no-examples-only', label: '不能，例子只是检查' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '为什么改半径比改高度「更划算」？用底面积说一说。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '尺寸确认后罐体与层叠重绘，底面积测量卡随确认值更新；两方案可切换观察（切换为 ViewState 呈现 + 尺寸确认命令）。',
    svgDom: '二维层条 + 横截面圆随尺寸等比重绘；参数输入+确认与 3D 同一 typed intent；同一表单与判分。',
  },
});

// ----- L4 I1: volume value + unit ------------------------------------------------
addTask({
  taskId: 'cyl.layers.i1.volume-value-unit.v1',
  taskFamily: 'cylinder.layers.v1',
  kind: 'INDEPENDENT',
  title: '算一算新罐子',
  givens: [40, 70, 7],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l4.volumeValue.v1',
  allowedOperationIds: ['SetLayerCount', 'SetVisibleLayerCount'],
  operationConstraints: [
    { type: 'SetLayerCount', min: 1, max: 40 },
    visibleConstraint,
  ],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm3'] },
  prompt: [
    { type: 'TEXT', text: '算一算新罐子' },
    { type: 'TEXT', text: '一个新的圆罐，尺寸见场景标注。它最多能装多少立方厘米的东西？' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: TABLE_L3(),
      rows: [
        ['半径 r', '4.0'],
        ['高度 h', '7.0'],
      ],
    },
    { type: 'TEXT', text: '先预测，再算并提交。可以切换层数、逐层推进帮助思考。' },
    { type: 'TEXT', text: 'π 取 3.14，四舍五入保留两位小数，并选择单位。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height', 'layerCount'] },
    { material: 'layer.controls', phases: OPERATE_ON },
    { material: 'table.cumulative', phases: OPERATE_ON, note: '隐藏数值期间仅显示层号/层厚两列' },
    { material: 'table.cumulative-values', phases: ['REVIEW'], note: '累计表数值列（该层/累计）REVIEW 前隐藏' },
    { material: 'card.formula-base', phases: PHASES_ALL },
    { material: 'card.formula-V', phases: PHASES_ALL },
    { material: 'card.base-area', phases: ['REVIEW'], note: '可反推读数 REVIEW 前全通道隐藏' },
    { material: 'card.volume-value', phases: ['REVIEW'] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '读标注 r=4.0 cm、h=7.0 cm。答体积，两位小数，单位立方厘米。' },
    { level: 2, label: '概念提示', text: '体积看两件事：底面有多大、叠多高。' },
    { level: 3, label: '策略提示', text: '先算底面积 π×r×r，再乘高 h；单位是立方厘米。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.layersi1.base-is',
        prompt: '算体积时用到的「底面积」是：',
        options: [
          { id: 'opt-circle-area', label: '底面圆的面积 πr²' },
          { id: 'opt-circumference', label: '底面圆的周长 2πr' },
          { id: 'opt-lateral', label: '侧面积' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '写出算式，说明每个数是什么。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '同基线；数字/单位表单两表达同控件同判分；SVG 层条/横截面受同一投影约束（数值列隐藏）。',
    svgDom: '同基线。',
  },
});

// ----- L4 I2: budget choice height vs radius -------------------------------------
addTask({
  taskId: 'cyl.layers.i2.height-vs-radius-choice.v1',
  taskFamily: 'cylinder.layers.v1',
  kind: 'INDEPENDENT',
  title: '只够改一处',
  givens: [30, 60, 6],
  givenLocks: [],
  responseSchemaId: 'resp.l4.varCompare.v1',
  allowedOperationIds: ['SetDimension', 'SetVisibleLayerCount'],
  operationConstraints: [
    { type: 'SetDimension', dimension: 'RADIUS', valuesMm: [30, 40] },
    { type: 'SetDimension', dimension: 'HEIGHT', valuesMm: [60, 100] },
    visibleConstraint,
  ],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm3'] },
  prompt: [
    { type: 'TEXT', text: '只够改一处' },
    { type: 'TEXT', text: '一个底罐：半径 3.0 cm，高 6.0 cm。加工预算只够改一处：方案 A 把高度加 4.0 cm（变成 10.0 cm）；方案 B 把半径加 1.0 cm（变成 4.0 cm）。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '对象' }, { label: 'r（cm）' }, { label: 'h（cm）' }],
      rows: [
        ['底罐', '3.0', '6.0'],
        ['方案 A（加高）', '3.0', '10.0'],
        ['方案 B（加宽）', '4.0', '6.0'],
      ],
    },
    { type: 'TEXT', text: '哪个方案装得多？各装多少？先猜，再在罐子上试。' },
    { type: 'TEXT', text: 'π 取 3.14，四舍五入保留两位小数，并选择单位。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height', 'layerCount'] },
    { material: 'dim.controls', phases: OPERATE_ON },
    { material: 'layer.controls', phases: OPERATE_ON },
    { material: 'card.formula-base', phases: PHASES_ALL },
    { material: 'card.formula-V', phases: PHASES_ALL },
    { material: 'card.base-area', phases: ['REVIEW'], note: 'A/B 两案底面积差是本题核心推理，比 G3 更严：REVIEW 前不展示' },
    { material: 'table.cumulative', phases: OPERATE_ON },
    { material: 'table.cumulative-values', phases: ['REVIEW'] },
    { material: 'card.volume-value', phases: ['REVIEW'] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '底罐 r=3.0、h=6.0；A 只加高到 10.0；B 只加半径到 4.0。答哪个多、各多少。' },
    { level: 2, label: '概念提示', text: '高度是乘一次，半径在底面积里乘两次——加的数字小不代表涨得少。' },
    { level: 3, label: '策略提示', text: '分别算两个方案各自的底面积和体积：π×3×3×10 和 π×4×4×6，再比。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.layersi2.linear-error',
        prompt: '只看「加的厘米数」选方案（4.0 比 1.0 大所以选 A）错在：',
        options: [
          { id: 'opt-r-twice', label: '体积里半径被乘了两次' },
          { id: 'opt-h-no-effect', label: '高度不影响体积' },
          { id: 'opt-not-wrong', label: '没错' },
          UNSURE_OPTION,
        ],
      },
      {
        itemId: 'explain.layersi2.proof-boundary',
        prompt: '再换三组尺寸试，都是「加宽小数字胜过加高大数字」——这能证明永远如此吗：',
        options: [
          { id: 'opt-yes', label: '能' },
          { id: 'opt-no-depends', label: '不能，要看具体尺寸' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '给老板写一句建议：什么时候加宽更划算？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '同 G3 基线（方案视图切换 + 层条等比）；同一表单与判分。',
    svgDom: '同 G3 基线。',
  },
});

// ----- L4 I3: accumulate to a boundary -------------------------------------------
addTask({
  taskId: 'cyl.layers.i3.accumulate-count.v1',
  taskFamily: 'cylinder.layers.v1',
  kind: 'INDEPENDENT',
  title: '数到第几层装满一百',
  givens: [20, 100, 10],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l4.accumulate.v1',
  allowedOperationIds: ['SetLayerCount', 'SetVisibleLayerCount'],
  operationConstraints: [
    { type: 'SetLayerCount', values: [10] },
    { type: 'SetVisibleLayerCount', min: 0, max: 10 },
  ],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm3'] },
  prompt: [
    { type: 'TEXT', text: '数到第几层装满一百' },
    { type: 'TEXT', text: '一个罐子：半径 2.0 cm，高 10.0 cm，装 10 层、每层厚 1.0 cm。一层一层往上装，每装一层记录累计体积。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: TABLE_L3(),
      rows: [
        ['半径 r', '2.0'],
        ['高度 h', '10.0'],
        ['层数 n', '10'],
        ['层厚', '1.0'],
      ],
    },
    { type: 'TEXT', text: '累计体积第一次超过 100 cm³ 是在第几层？那时候累计是多少立方厘米？先猜，再一层层推进检查。' },
    { type: 'TEXT', text: 'π 取 3.14，四舍五入保留两位小数，并选择单位。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['radius', 'height', 'layerCount'] },
    { material: 'layer.controls', phases: OPERATE_ON },
    { material: 'table.cumulative', phases: OPERATE_ON, note: `${CUMULATIVE_NOTE}；本任务累计表为执行面：行随孩子逐层推进揭示（预测已先落库），表内无数值预填` },
    { material: 'card.formula-base', phases: PHASES_ALL },
    { material: 'card.formula-Vlayer', phases: PHASES_ALL },
    { material: 'card.base-area', phases: OPERATE_ON, note: '底面积值卡为「每层=底面积×层厚」印证材料' },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: 'r=2.0 cm、h=10.0 cm、10 层每层 1.0 cm。答：累计第一次超过 100 cm³ 的层号与当时的累计值。' },
    { level: 2, label: '概念提示', text: '每装一层，累计就加一份同样的数。' },
    { level: 3, label: '策略提示', text: '先算每层 = π×2×2×1.0，再一层层加：加到哪一层刚过 100？没过 100 的最后一层也要看清楚。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.layersi3.reach-or-exceed',
        prompt: '如果目标是「首次达到或超过 100」，答案会变吗：',
        options: [
          { id: 'opt-same-8', label: '不变，还是第 8 层' },
          { id: 'opt-become-7', label: '变成第 7 层' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '你怎么确认自己没有数错层？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '圆片逐层升起与累计表行同步；复位一键回 0 层。',
    svgDom: '二维层条逐层填充 + 同一累计表 + 复位/逐层按钮；键盘（方向键逐层、Home 复位）与 3D 同一 typed intent；同一判分。',
  },
});

// ----- L4 S1: stranger composite (jewel box, L3+L4 shared) ------------------------
addTask({
  taskId: 'cyl.layers.s1.stranger-package.v1',
  taskFamily: 'cylinder.layers.v1',
  kind: 'STRANGER',
  title: '首饰店的圆盒',
  givens: [50, 60, 6],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l4.strangerComposite.v1',
  allowedOperationIds: ['SelectFaces', 'SetVisibleLayerCount'],
  operationConstraints: [
    selectFacesConstraint,
    { type: 'SetVisibleLayerCount', min: 0, max: 6 },
  ],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm', 'cm2', 'cm3'] },
  prompt: [
    { type: 'TEXT', text: '首饰店的圆盒' },
    { type: 'TEXT', text: '首饰店订做一批圆柱形礼盒：盒底直径 10.0 cm，盒高 6.0 cm，有底有盖（封口），整盒用纸板，里面正好填满衬垫。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '已知' }, { label: '数值', unitId: 'cm' }],
      rows: [
        ['盒底直径 d', '10.0'],
        ['盒高 h', '6.0'],
      ],
    },
    { type: 'TEXT', text: '(1) 盒底的半径是多少厘米？(2) 纸板要算哪些面？在场景里选出来。(3) 整盒纸板多少平方厘米？(4) 盒内能填多少立方厘米衬垫？' },
    { type: 'TEXT', text: 'π 取 3.14，(3)(4) 四舍五入保留两位小数并选择单位。每项都可以选「不确定」。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['diameter', 'height', 'layerCount'], note: '故事 given：直径与高可见' },
    { material: 'dim.radius', phases: ['REVIEW'], note: '半径是参数识别作答目标，REVIEW 前隐藏（含 aria）' },
    { material: 'face.checklist', phases: OPERATE_ON },
    { material: 'layer.controls', phases: OPERATE_ON, note: '层推进观察辅助（SetLayerCount 锁定 givens 层数）' },
    { material: 'card.formula-circle', phases: ['REVIEW'], note: '陌生任务复测方法回忆，ASSESSMENT 档不主动展示（沿 L2-S1 先例）' },
    { material: 'card.formula-full', phases: ['REVIEW'] },
    { material: 'card.formula-V', phases: ['REVIEW'] },
    { material: 'card.measure-faces', phases: ['REVIEW'] },
    { material: 'card.base-area', phases: ['REVIEW'] },
    { material: 'table.cumulative', phases: OPERATE_ON },
    { material: 'table.cumulative-values', phases: ['REVIEW'] },
    { material: 'card.surface-value', phases: ['REVIEW'] },
    { material: 'card.volume-value', phases: ['REVIEW'] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '礼盒有底有盖。已知直径 10.0 cm、高 6.0 cm。四问：半径；面集合；纸板面积；衬垫体积（两位小数+单位）。' },
    { level: 2, label: '概念提示', text: '先从直径找到半径；纸板按面下料，衬垫看底面和高的乘法。' },
    { level: 3, label: '策略提示', text: 'r=d÷2；纸板 = 周长×高 + 两个圆；衬垫 = πr²×h（给步骤不给数值）。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.layerss1.open-box',
        prompt: '这批礼盒如果改成「无盖展示盒」，纸板会：',
        options: [
          { id: 'opt-minus-one', label: '少一个圆' },
          { id: 'opt-minus-two', label: '少两个圆' },
          { id: 'opt-same', label: '不变' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '向家人说明「纸板」和「衬垫」各要算哪些东西、为什么不一样。',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '面片 3D 选面 + 层条推进 + 四段复合表单分段呈现（段内可不确定）；两表达同构同判分。',
    svgDom: '面片 SVG 选面 + 二维层条 + 同一四段表单；同一 typed intent、同一判分。',
  },
});

// ----- L4 D1: delayed transfer (candle tin, circumference-given) ------------------
addTask({
  taskId: 'cyl.layers.d1.delayed-transfer.v1',
  taskFamily: 'cylinder.layers.v1',
  kind: 'DELAYED_TRANSFER',
  title: '蜡烛铺的无盖蜡罐',
  givens: [40, 65, 13],
  givenLocks: ['radiusMm', 'heightMm'],
  responseSchemaId: 'resp.l4.strangerComposite.v1',
  allowedOperationIds: ['SelectFaces', 'SetVisibleLayerCount'],
  operationConstraints: [
    selectFacesConstraint,
    { type: 'SetVisibleLayerCount', min: 0, max: 13 },
  ],
  numericPolicy: { pi: '3.14', displayDecimals: 1, acceptedUnitIds: ['cm', 'cm2', 'cm3'] },
  prompt: [
    { type: 'TEXT', text: '蜡烛铺的无盖蜡罐' },
    { type: 'TEXT', text: '蜡烛铺做无盖的圆柱蜡罐（有底、顶部敞开）：罐底圆的周长是 25.12 cm，罐高 6.5 cm。罐壁罐底用薄纸板，里面灌蜡。' },
    {
      type: 'MEASUREMENT_TABLE',
      columns: [{ label: '已知' }, { label: '数值', unitId: 'cm' }],
      rows: [
        ['底面圆周长 C', '25.12'],
        ['罐高 h', '6.5'],
      ],
    },
    { type: 'TEXT', text: '(1) 蜡罐的半径是多少厘米？(2) 纸板要算哪些面？在场景里选出来。(3) 纸板多少平方厘米？(4) 能灌多少立方厘米蜡？' },
    { type: 'TEXT', text: 'π 取 3.14，(3)(4) 四舍五入保留两位小数并选择单位。每项都可以选「不确定」。' },
  ],
  visibility: [
    { material: 'givens.table', phases: PHASES_ALL, rows: ['height', 'layerCount'], note: '故事 given：周长以文字给出，高度可见' },
    { material: 'dim.radius', phases: ['REVIEW'], note: '半径为推导目标' },
    { material: 'dim.diameter', phases: ['REVIEW'], note: '直径同样隐藏（给直径标签会使半径平凡化）' },
    { material: 'face.checklist', phases: OPERATE_ON },
    { material: 'layer.controls', phases: OPERATE_ON },
    { material: 'card.formula-circle', phases: ['REVIEW'], note: '迁移复测方法回忆' },
    { material: 'card.formula-full', phases: ['REVIEW'] },
    { material: 'card.formula-V', phases: ['REVIEW'] },
    { material: 'card.measure-faces', phases: ['REVIEW'] },
    { material: 'card.base-area', phases: ['REVIEW'] },
    { material: 'table.cumulative', phases: OPERATE_ON },
    { material: 'table.cumulative-values', phases: ['REVIEW'] },
    { material: 'card.surface-value', phases: ['REVIEW'] },
    { material: 'card.volume-value', phases: ['REVIEW'] },
    { material: 'view.controls', phases: OPERATE_ON },
    { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ],
  hints: [
    { level: 1, label: '重述题意', text: '蜡罐有底无盖。已知底面周长 25.12 cm、罐高 6.5 cm。四问：半径；面集合；纸板面积；灌蜡体积。' },
    { level: 2, label: '概念提示', text: '周长、半径是一家人：C=2πr 倒过来用；无盖说的是顶部敞开。' },
    { level: 3, label: '策略提示', text: 'r=C÷(2×3.14)；纸板=周长×高+一个圆；灌蜡=πr²×h（给步骤不给数值）。' },
  ],
  explain: {
    selections: [
      {
        itemId: 'explain.layersd1.vs-s1',
        prompt: '这次和首饰盒那题比，哪些地方不一样？（可多选）',
        multi: true,
        options: [
          { id: 'opt-given-c', label: '给的是周长不是直径' },
          { id: 'opt-no-lid', label: '无盖所以少一个圆面' },
          { id: 'opt-no-volume', label: '不算体积只算面积' },
          UNSURE_OPTION,
        ],
      },
    ],
    freeTextPrompt: '隔了这些天，你是怎么想起来的？',
  },
  exitEvidence: ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'],
  expressions: {
    webgl2: '同 S1 基线；「回看练习」卡、状态与间隔显示两表达一致。',
    svgDom: '同 S1 基线。',
  },
});

// ---------------------------------------------------------------------------
// response schema registry (public; drives player forms)
// ---------------------------------------------------------------------------
const registry = {
  registryVersion: '2',
  representationNote:
    '所有 VERIFY 响应由冻结三段表达承载：propertyJudgments（属性方向）/ objectMapping（稳定对象配对）/ numberWithUnit（数值+单位）。UNSURE 在 objectMapping 用 opt-unsure 选项；数值段提交需给数值（不确定只能在预测阶段表达）。registryVersion 2（h0-mathl34-20261027-1）：增 L3/L4 九个 schemaId、单位 cm3/layer、propertyLabels 增 layerThickness/totalVolume（承载 L34-7 已裁定的 resp.l4.stackInvariant.v1）；VERIFY 内的「选择」类作答以 objectMapping 单行承载（choice 为预测侧 ask，VERIFY 三段无 choice kind）。复合段 prompt 实例化限于 paramRead 段，以 segmentPromptOverrides 版本化登记（L34-7 附注）。',
  propertyLabels: { ...PROPERTY_LABELS, layerThickness: '每层厚度', totalVolume: '总体积' },
  directionLabels: DIRECTION_LABELS,
  schemas: [
    {
      schemaId: 'resp.l1.viewChange.v1',
      summary: '视角变化与尺寸判断（三属性方向）',
      predict: {
        asks: [
          askDirections(
            'ask.g1.directions',
            '预测：只转动观察、不碰尺寸设置，三个尺寸各自会怎样？（也可以整体选「不确定」）',
            ['radius', 'diameter', 'height'],
          ),
        ],
      },
      verify: {
        items: [
          propDirections('转动观察之后：三个尺寸各自怎样了？', ['radius', 'diameter', 'height']),
        ],
      },
    },
    {
      schemaId: 'resp.l1.predictDimension.v1',
      summary: '预测/作答某参数（方向 + 数值 + 单位）',
      predict: {
        asks: [
          askChoice('ask.g2.direction', '预测：改完之后，直径会变大、变小还是不变？', [
            { id: 'INCREASE', label: '变大' },
            { id: 'DECREASE', label: '变小' },
            { id: 'UNCHANGED', label: '不变' },
            UNSURE_OPTION,
          ]),
          askNumber('ask.g2.value', '预测：新的直径是多少？（记录用，不判分）', '直径', UNITS_LENGTH),
        ],
      },
      verify: {
        items: [
          propDirections('观察之后：直径的方向是？', ['diameter']),
          numberWithUnit('新的直径是多少？', 'diameter', '直径', UNITS_LENGTH, 1),
        ],
      },
    },
    {
      schemaId: 'resp.l1.dimensionRead.v1',
      summary: '读数（高度）+ 截面选择',
      predict: {
        asks: [
          askChoice('ask.g3.height-direction', '预测：改完之后高度会变大、变小还是不变？', [
            { id: 'INCREASE', label: '变大' },
            { id: 'UNCHANGED', label: '不变' },
            UNSURE_OPTION,
          ]),
          askNumber('ask.g3.height-value', '预测：新的高是多少？（记录用，不判分）', '高', UNITS_LENGTH),
          askChoice('ask.g3.section', '凭定义先猜：横截面和轴截面，哪个切面里能看到高？', [
            { id: 'section-view-axial', label: '轴截面（沿轴切开）' },
            { id: 'section-view-transverse', label: '横截面（垂直于轴切开）' },
            UNSURE_OPTION,
          ]),
        ],
      },
      verify: {
        items: [
          propDirections('观察之后：高度的方向是？', ['height']),
          numberWithUnit('圆筒现在的高是多少？', 'height', '高', UNITS_LENGTH, 1),
          {
            kind: 'objectMapping',
            prompt: '哪个切面里能看到高？',
            pairs: [
              {
                leftId: 'cyl-part-height-line',
                leftLabel: '高（这条线）',
                rightOptions: [
                  { id: 'section-view-transverse', label: '横截面（垂直于轴切开，是圆）' },
                  { id: 'section-view-axial', label: '轴截面（沿轴切开，是矩形）' },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      schemaId: 'resp.l1.identifyParams.v1',
      summary: '独立题：变化项/不变项识别（条件预测 + 识别作答）',
      predict: {
        asks: [
          askChoice('ask.i1.if-radius', '如果悄悄改变的是半径，直径会：', [
            { id: 'INCREASE', label: '变大' },
            { id: 'DECREASE', label: '变小' },
            { id: 'UNCHANGED', label: '不变' },
            UNSURE_OPTION,
          ]),
          askChoice('ask.i1.if-height', '如果悄悄改变的是高度，直径会：', [
            { id: 'INCREASE', label: '变大' },
            { id: 'DECREASE', label: '变小' },
            { id: 'UNCHANGED', label: '不变' },
            UNSURE_OPTION,
          ]),
          {
            id: 'ask.i1.bet',
            kind: 'propertyBet',
            prompt: '你猜这次实际改变的是哪个尺寸、怎么变？（选一组作为预测；不猜就选「不确定」）',
            properties: ['radius', 'height'],
            directionOptions: BET_OPTIONS,
          },
        ],
      },
      verify: {
        items: [
          propDirections('观察之后：这次到底变了哪些量、怎么变？（没变的选「不变」）', [
            'radius',
            'diameter',
            'height',
          ]),
        ],
      },
    },
    {
      schemaId: 'resp.l2.directionRelation.v1',
      summary: '方向关系：哪条边卷回后形成圆周/成为高',
      predict: {
        asks: [
          askMapping(
            'ask.netg1.mapping',
            '先猜：每条边卷回去属于哪个方向？（边 1–4 各选一项）',
            ['net-edge-1', 'net-edge-2', 'net-edge-3', 'net-edge-4'],
            DIRECTION_PART_OPTIONS,
          ),
        ],
      },
      verify: {
        items: [
          mapping(
            '每条边卷回去以后，属于哪个方向？',
            ['net-edge-1', 'net-edge-2', 'net-edge-3', 'net-edge-4'],
            DIRECTION_PART_OPTIONS,
          ),
        ],
      },
    },
    {
      schemaId: 'resp.l2.edgePair.v1',
      summary: '边配对：条带的边 ↔ 圆柱部件（上底圆/下底圆/高）',
      predict: {
        asks: [
          askMapping(
            'ask.netpair.mapping',
            '先猜：每条边卷回去贴着谁？（边 1–4 各选一项）',
            ['net-edge-1', 'net-edge-2', 'net-edge-3', 'net-edge-4'],
            PART_OPTIONS,
          ),
        ],
      },
      verify: {
        items: [
          mapping(
            '每条边卷回去以后，它贴着谁？',
            ['net-edge-1', 'net-edge-2', 'net-edge-3', 'net-edge-4'],
            PART_OPTIONS,
          ),
        ],
      },
    },
    {
      schemaId: 'resp.l2.areaValue.v1',
      summary: '侧面积数值 + 单位（cm²，两位小数）',
      predict: {
        asks: [
          askNumber('ask.area.value', '预测：侧面面积大约是多少？（记录用，不判分）', '侧面积', UNITS_AREA),
        ],
      },
      verify: {
        items: [numberWithUnit('侧面的面积是多少？（四舍五入保留两位小数）', 'lateral-area', '侧面积', UNITS_AREA, 2)],
      },
    },
    {
      schemaId: 'resp.l2.strangerComposite.v1',
      summary: '陌生/迁移复合响应（按任务启用子段）',
      predict: {
        asks: [
          askNumber('ask.stranger.radius', '预测：半径大约是多少？（记录用，不判分）', '半径', UNITS_LENGTH),
          askMapping(
            'ask.stranger.pairing',
            '先猜：每条边卷回去贴着谁？',
            ['net-edge-1', 'net-edge-2', 'net-edge-3', 'net-edge-4'],
            PART_OPTIONS,
          ),
          askNumber('ask.stranger.area', '预测：面积大约是多少？（记录用，不判分；本任务不问面积则跳过）', '面积', UNITS_AREA),
        ],
      },
      verify: {
        segments: [
          { id: 'paramRead', label: '(1) 参数识别', item: numberWithUnit('瓶身/罐身的半径是多少？', 'radius', '半径', UNITS_LENGTH, 1) },
          { id: 'edgePairing', label: '(2) 边配对', item: mapping('四条边分别卷回去贴着谁？', ['net-edge-1', 'net-edge-2', 'net-edge-3', 'net-edge-4'], PART_OPTIONS) },
          { id: 'directionClaims', label: '(3) 方向关系', item: mapping('每条边卷回去属于哪个方向？', ['net-edge-1', 'net-edge-2', 'net-edge-3', 'net-edge-4'], DIRECTION_PART_OPTIONS) },
          { id: 'areaValue', label: '(4) 面积', item: numberWithUnit('贴纸/商标纸的面积是多少？（四舍五入保留两位小数）', 'lateral-area', '面积', UNITS_AREA, 2) },
        ],
      },
    },
    {
      schemaId: 'resp.l1.changeClassify.v1',
      summary: '未绑定预留（分类语义由 resp.l1.identifyParams.v1 的 changedSet 判定承载；保留注册，首批不绑定任务）',
      predict: null,
      verify: null,
    },
    // ----- L3（h0-mathl34-20261027-1，L34-4） -----
    {
      schemaId: 'resp.l3.faceSet.v1',
      summary: '面集合三行（算入/不算入/不确定）+ 盖面数',
      predict: {
        asks: [
          askFaceMapping('ask.faces.predict', '先猜：这个包装需要哪些面？每面选「算入/不算入」，也可以选「不确定」。'),
          askChoice(
            'ask.faces.predict-compare',
            '先猜：封口罐比标签筒的纸：',
            [
              { id: 'opt-more', label: '多' },
              { id: 'opt-less', label: '少' },
              { id: 'opt-same', label: '一样' },
              UNSURE_OPTION,
            ],
          ),
        ],
      },
      verify: {
        items: [
          faceMapping('这个包装的纸样要算哪些面？（每面选：算入 / 不算入 / 不确定）'),
          choiceRow('盖面（圆面）有几个？', 'lid-count', '盖面个数', [
            { id: 'opt-0', label: '0 个' },
            { id: 'opt-1', label: '1 个' },
            { id: 'opt-2', label: '2 个' },
            UNSURE_OPTION,
          ]),
        ],
      },
    },
    {
      schemaId: 'resp.l3.comboArea.v1',
      summary: '组合面积复合段：faceSet（objectMapping 三行）+ paperArea（numberWithUnit cm² 两位小数）',
      predict: {
        asks: [
          askNumber('ask.combo.predict', '预测：总共大约多少平方厘米？（记录用，不判分）', '总面积', UNITS_AREA),
          // G3 建议单两问沿 L2-S1「本任务不问则跳过」先例挂在 schema 级 predict；
          // 作答序列化入 recordPrediction 载荷（PREDICTION_CARRIER），不进判分
          askChoice('ask.combo.advice-usable', '如果本题附有「人工建议单」：你觉得它能用吗？（没有建议单就跳过/选「不确定」）', [
            { id: 'opt-advice-usable', label: '能用' },
            { id: 'opt-advice-no', label: '不能用' },
            UNSURE_OPTION,
          ]),
          askChoice('ask.combo.advice-problem', '建议单的问题最可能出在哪？（没有建议单就跳过/选「不确定」）', [
            { id: 'opt-advice-missing-lid', label: '漏了一个盖面' },
            { id: 'opt-advice-side-wrong', label: '侧面积算错' },
            { id: 'opt-advice-none', label: '没有问题' },
            UNSURE_OPTION,
          ]),
        ],
      },
      verify: {
        segments: [
          { id: 'faceSet', label: '(1) 面集合', item: faceMapping('纸样要算哪些面？（每面选：算入 / 不算入 / 不确定）') },
          { id: 'paperArea', label: '(2) 总面积', item: numberWithUnit('一共多少平方厘米？（四舍五入保留两位小数）', 'paper-area', '总面积', UNITS_AREA, 2) },
        ],
      },
    },
    {
      schemaId: 'resp.l3.lidDelta.v1',
      summary: '盖数条件差值：Δ 面积（numberWithUnit）+ 概念归属（mapping 单行）',
      predict: {
        asks: [
          askChoice('ask.delta.direction', '预测：改造后用纸会：', [
            { id: 'opt-more', label: '多' },
            { id: 'opt-less', label: '少' },
            { id: 'opt-same', label: '一样' },
            UNSURE_OPTION,
          ]),
          askNumber('ask.delta.value', '预测：多用大约多少平方厘米？（记录用，不判分）', '多用面积', UNITS_AREA),
        ],
      },
      verify: {
        items: [
          numberWithUnit('比原来多用多少平方厘米？（四舍五入保留两位小数）', 'paper-area-delta', '多用面积', UNITS_AREA, 2),
          choiceRow('这份多用的纸最接近：', 'delta-attribution', '概念归属', [
            { id: 'opt-one-lid', label: '一个盖面的面积' },
            { id: 'opt-two-lid', label: '两个盖面的面积' },
            { id: 'opt-double-side', label: '侧面积的 2 倍' },
            UNSURE_OPTION,
          ]),
        ],
      },
    },
    // ----- L4（L34-7） -----
    {
      schemaId: 'resp.l4.stackInvariant.v1',
      summary: '层叠不变量：两属性方向（layerThickness/totalVolume）+ 总体积（numberWithUnit cm³ 两位小数）',
      predict: {
        asks: [
          askChoice('ask.stack.total', '预测：层数变多后，总体积会：', [
            { id: 'INCREASE', label: '变大' },
            { id: 'DECREASE', label: '变小' },
            { id: 'UNCHANGED', label: '不变' },
            UNSURE_OPTION,
          ]),
          askChoice('ask.stack.thickness', '预测：每层厚度会：', [
            { id: 'INCREASE', label: '变厚' },
            { id: 'DECREASE', label: '变薄' },
            { id: 'UNCHANGED', label: '不变' },
            UNSURE_OPTION,
          ]),
        ],
      },
      verify: {
        items: [
          propDirections('层数从 8 改成 16 后：两个量各自怎么变？', ['layerThickness', 'totalVolume']),
          numberWithUnit('8 层装满的总体积是多少立方厘米？（四舍五入保留两位小数）', 'volume', '总体积', UNITS_VOLUME, 2),
        ],
      },
    },
    {
      schemaId: 'resp.l4.layerVolume.v1',
      summary: '层体积三数值：层厚（cm 一位小数）/ 每层体积 / 总体积（cm³ 两位小数）',
      predict: {
        asks: [
          askNumber('ask.lv.per-layer', '预测：每一层大约多少立方厘米？（记录用，不判分）', '每层体积', UNITS_VOLUME),
          askNumber('ask.lv.total', '预测：装满一共大约多少立方厘米？（记录用，不判分）', '总体积', UNITS_VOLUME),
        ],
      },
      verify: {
        items: [
          numberWithUnit('每一层的厚度是多少厘米？（一位小数）', 'layer-thickness', '层厚', UNITS_LENGTH, 1),
          numberWithUnit('每一层的体积是多少立方厘米？（四舍五入保留两位小数）', 'layer-volume', '每层体积', UNITS_VOLUME, 2),
          numberWithUnit('8 层装满一共多少立方厘米？（四舍五入保留两位小数）', 'volume', '总体积', UNITS_VOLUME, 2),
        ],
      },
    },
    {
      schemaId: 'resp.l4.varCompare.v1',
      summary: '高/半径对比复合段：bigger + valueA + valueB + ratio（按任务启用；ratio 段 I2 禁用）',
      predict: {
        asks: [
          askChoice('ask.var.bigger', '预测：哪个方案装得多？', [
            { id: 'opt-plan-a', label: '加高的方案' },
            { id: 'opt-plan-b', label: '加宽的方案' },
            { id: 'opt-same', label: '一样多' },
            UNSURE_OPTION,
          ]),
          askNumber('ask.var.value-a', '预测：加高方案大约多少立方厘米？（记录用，不判分）', '加高方案体积', UNITS_VOLUME),
          askNumber('ask.var.value-b', '预测：加宽方案大约多少立方厘米？（记录用，不判分）', '加宽方案体积', UNITS_VOLUME),
        ],
      },
      verify: {
        segments: [
          { id: 'bigger', label: '(1) 哪个装得多', item: choiceRow('哪个方案装得多？', 'bigger-plan', '装得多的方案', [
            { id: 'opt-plan-a', label: '加高的方案' },
            { id: 'opt-plan-b', label: '加宽的方案' },
            { id: 'opt-same', label: '一样多' },
            UNSURE_OPTION,
          ]) },
          { id: 'valueA', label: '(2) 加高方案的体积', item: numberWithUnit('加高方案能装多少立方厘米？（四舍五入保留两位小数）', 'volume-a', '加高方案体积', UNITS_VOLUME, 2) },
          { id: 'valueB', label: '(3) 加宽方案的体积', item: numberWithUnit('加宽方案能装多少立方厘米？（四舍五入保留两位小数）', 'volume-b', '加宽方案体积', UNITS_VOLUME, 2) },
          { id: 'ratio', label: '(4) 半径加倍的比例', item: choiceRow('半径加倍后，体积是原来的几倍？', 'radius-double-ratio', '体积倍数', [
            { id: 'opt-ratio-2', label: '2 倍' },
            { id: 'opt-ratio-4', label: '4 倍' },
            { id: 'opt-ratio-8', label: '8 倍' },
            UNSURE_OPTION,
          ]) },
        ],
      },
    },
    {
      schemaId: 'resp.l4.volumeValue.v1',
      summary: '体积数值 + 单位（cm³，两位小数）',
      predict: {
        asks: [askNumber('ask.vol.predict', '预测：体积大约是多少？（记录用，不判分）', '体积', UNITS_VOLUME)],
      },
      verify: {
        items: [numberWithUnit('它最多能装多少立方厘米？（四舍五入保留两位小数）', 'volume', '体积', UNITS_VOLUME, 2)],
      },
    },
    {
      schemaId: 'resp.l4.accumulate.v1',
      summary: '累加边界：首次超限层号（numberWithUnit，单位「层」）+ 当时累计（cm³ 两位小数）',
      predict: {
        asks: [
          askNumber('ask.acc.layer', '预测：第一次超过 100 cm³ 大约在第几层？（记录用，不判分）', '层号', UNITS_LAYER),
          askNumber('ask.acc.cumulative', '预测：那时累计大约多少立方厘米？（记录用，不判分）', '累计体积', UNITS_VOLUME),
        ],
      },
      verify: {
        items: [
          numberWithUnit('累计体积第一次超过 100 cm³ 是在第几层？（整数层号）', 'layer-index', '层号', UNITS_LAYER, 0),
          numberWithUnit('那时候累计是多少立方厘米？（四舍五入保留两位小数）', 'cumulative-volume', '累计体积', UNITS_VOLUME, 2),
        ],
      },
    },
    {
      schemaId: 'resp.l4.strangerComposite.v1',
      summary: 'L4 陌生/迁移复合响应（四段：paramRead / faceSet / paperArea / volume，按任务启用；paramRead 段 prompt 可实例化改写）',
      predict: {
        asks: [
          askNumber('ask.stranger4.radius', '预测：半径大约是多少厘米？（记录用，不判分）', '半径', UNITS_LENGTH),
          askFaceMapping('ask.stranger4.faces', '先猜：纸板要算哪些面？'),
          askNumber('ask.stranger4.paper', '预测：纸板大约多少平方厘米？（记录用，不判分）', '纸板面积', UNITS_AREA),
          askNumber('ask.stranger4.volume', '预测：能装大约多少立方厘米？（记录用，不判分）', '体积', UNITS_VOLUME),
        ],
      },
      verify: {
        segments: [
          { id: 'paramRead', label: '(1) 参数识别', item: numberWithUnit('半径是多少厘米？（按题面给出的直径或周长换算；一位小数）', 'radius', '半径', UNITS_LENGTH, 1) },
          { id: 'faceSet', label: '(2) 面集合', item: faceMapping('纸板要算哪些面？（每面选：算入 / 不算入 / 不确定）') },
          { id: 'paperArea', label: '(3) 纸板面积', item: numberWithUnit('整盒纸板多少平方厘米？（四舍五入保留两位小数）', 'paper-area', '纸板面积', UNITS_AREA, 2) },
          { id: 'volume', label: '(4) 体积', item: numberWithUnit('能装多少立方厘米？（四舍五入保留两位小数）', 'volume', '体积', UNITS_VOLUME, 2) },
        ],
      },
      segmentPromptOverrides: {
        'cyl.layers.d1.delayed-transfer.v1': {
          paramRead: '由周长求半径：罐底圆的周长是 25.12 cm，半径是多少厘米？（一位小数）',
        },
      },
    },
  ],
};

// segment enablement per composite task
const COMPOSITE_SEGMENTS = {
  'cyl.net.s1.stranger-relabel.v1': ['paramRead', 'edgePairing', 'directionClaims', 'areaValue'],
  'cyl.net.d1.delayed-transfer.v1': ['paramRead', 'edgePairing', 'directionClaims'],
  // L4 varCompare：G3 四段全启用；I2 禁用 ratio 段（L4 表 §6）
  'cyl.layers.g3.height-vs-radius.v1': ['bigger', 'valueA', 'valueB', 'ratio'],
  'cyl.layers.i2.height-vs-radius-choice.v1': ['bigger', 'valueA', 'valueB'],
  // L4 strangerComposite：S1/D1 四段全启用（L4 表 §8/§9）
  'cyl.layers.s1.stranger-package.v1': ['paramRead', 'faceSet', 'paperArea', 'volume'],
  'cyl.layers.d1.delayed-transfer.v1': ['paramRead', 'faceSet', 'paperArea', 'volume'],
};

// ---------------------------------------------------------------------------
// lessons (public authored grouping/titles; mock builds courseGraph from this)
// ---------------------------------------------------------------------------
const lessons = {
  lessonsVersion: '1',
  lessons: [
    {
      lessonId: 'cylinder.parameters',
      releaseId: RELEASE_L1,
      title: '第 1 课 · 参数与视角',
      taskFamily: 'cylinder.parameters.v1',
      taskOrder: [
        'cyl.param.g1.view-invariance.v1',
        'cyl.param.g2.radius-change.v1',
        'cyl.param.g3.height-section.v1',
        'cyl.param.i1.identify-changes.v1',
        'cyl.param.i2.predict-single-change.v1',
      ],
    },
    {
      lessonId: 'cylinder.net',
      releaseId: RELEASE_L2,
      title: '第 2 课 · 展开关系',
      taskFamily: 'cylinder.net.v1',
      taskOrder: [
        'cyl.net.g1.unroll-observe.v1',
        'cyl.net.g2.edge-pairing.v1',
        'cyl.net.g3.lateral-area.v1',
        'cyl.net.i1.pair-normal.v1',
        'cyl.net.i2.pair-tall-thin.v1',
        'cyl.net.i3.area-value-unit.v1',
        'cyl.net.s1.stranger-relabel.v1',
      ],
      delayedTransferTaskId: 'cyl.net.d1.delayed-transfer.v1',
      delayedTransferWindowDays: { availableAfterDays: 7, nominalEndDays: 14 },
    },
    {
      lessonId: 'cylinder.faces',
      releaseId: RELEASE_L3,
      title: '第 3 课 · 面的组合',
      taskFamily: 'cylinder.faces.v1',
      taskOrder: [
        'cyl.faces.g1.face-inventory.v1',
        'cyl.faces.g2.one-lid-area.v1',
        'cyl.faces.g3.full-surface.v1',
        'cyl.faces.i1.faceset-new-instance.v1',
        'cyl.faces.i2.lid-count-condition.v1',
        'cyl.faces.i3.surface-value-unit.v1',
      ],
    },
    {
      lessonId: 'cylinder.layers',
      releaseId: RELEASE_L4,
      title: '第 4 课 · 层叠与体积',
      taskFamily: 'cylinder.layers.v1',
      taskOrder: [
        'cyl.layers.g1.stack-invariant.v1',
        'cyl.layers.g2.layer-volume.v1',
        'cyl.layers.g3.height-vs-radius.v1',
        'cyl.layers.i1.volume-value-unit.v1',
        'cyl.layers.i2.height-vs-radius-choice.v1',
        'cyl.layers.i3.accumulate-count.v1',
        'cyl.layers.s1.stranger-package.v1',
      ],
      delayedTransferTaskId: 'cyl.layers.d1.delayed-transfer.v1',
      delayedTransferWindowDays: { availableAfterDays: 7, nominalEndDays: 14 },
    },
  ],
};

// ---------------------------------------------------------------------------
// private: frozen instances, rules, answer hints
// π = 157/50 exact; all expected values below are precomputed under that
// contract (see tests/content which recomputes them with integer rationals).
// ---------------------------------------------------------------------------
const instances = [
  {
    taskId: 'cyl.param.i1.identify-changes.v1',
    file: 'cyl.param.i1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.param.i1.EX-B',
        initial: { radiusMm: 45, heightMm: 120 },
        script: { dimension: 'RADIUS', fromMm: 45, toMm: 30 },
        truth: {
          changedSet: ['RADIUS', 'DIAMETER'],
          changedDirection: 'DECREASE',
          diameterBeforeCm: '9.0',
          diameterAfterCm: '6.0',
          predictIfRadiusChanged: 'INCREASE',
          predictIfHeightChanged: 'UNCHANGED',
        },
        answerHint:
          '改变的是半径（4.5→3.0 cm）。半径和直径都变小了，直径从 9.0 cm 变成 6.0 cm；高度没变。',
      },
    ],
    spares: [
      {
        instanceId: 'cyl.param.i1.EX-A',
        initial: { radiusMm: 25, heightMm: 60 },
        script: { dimension: 'HEIGHT', fromMm: 60, toMm: 90 },
        truth: { changedSet: ['HEIGHT'], changedDirection: 'INCREASE', diameterBeforeCm: '5.0', diameterAfterCm: '5.0' },
        answerHint:
          '改变的是高度（6.0→9.0 cm）。变了的是高度；半径和直径都没变，直径仍是 5.0 cm。',
      },
    ],
    domain: {
      radiusMm: [15, 80],
      heightMm: [40, 160],
      constraints: [
        '初始与脚本后状态均不等于引导例 (30,80)/(40,80)',
        'radiusMm != heightMm',
        '脚本改变轴 in {RADIUS,HEIGHT}，|delta|>=15mm，改后仍在域内并满足前两条',
        '同一 attempt 内与 I2 实例互不相同，与 L2 冻结实例不重复',
      ],
      arithmetic: 'L1 全部判分只用 d=2r 与 mm<->cm 换算；pi 不参与 L1 判分',
    },
  },
  {
    taskId: 'cyl.param.i2.predict-single-change.v1',
    file: 'cyl.param.i2.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.param.i2.EX-B',
        initial: { radiusMm: 20, heightMm: 70 },
        script: { dimension: 'HEIGHT', fromMm: 70, toMm: 130, publicInPrompt: true },
        truth: { direction: 'UNCHANGED', valueCm: '4.0' },
        answerHint: '直径不变。直径 = 2 × 2.0 cm = 4.0 cm，高度变化不改变直径。',
      },
    ],
    spares: [
      {
        instanceId: 'cyl.param.i2.EX-A',
        initial: { radiusMm: 35, heightMm: 50 },
        script: { dimension: 'RADIUS', fromMm: 35, toMm: 55, publicInPrompt: true },
        truth: { direction: 'INCREASE', valueCm: '11.0' },
        answerHint: '直径变大。新直径 = 2 × 5.5 cm = 11.0 cm。',
      },
    ],
    domain: {
      radiusMm: [15, 80],
      heightMm: [40, 160],
      constraints: ['同 I1 域与排除规则', '脚本内容在题面公开（givens），答案（方向/新值）不下发'],
    },
  },
  {
    taskId: 'cyl.net.i3.area-value-unit.v1',
    file: 'cyl.net.i3.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.net.i3.F1',
        initial: { radiusMm: 25, heightMm: 100 },
        truth: { circumferenceCm: '15.70', lateralAreaCm2: '157.00' },
        answerHint: 'C = 2×3.14×2.5 = 15.70 cm；S侧 = 15.70×10.0 = 157.00 cm²。',
      },
    ],
    domain: {
      radiusMm: [100, 600],
      heightMm: [200, 1500],
      stepMm: 50,
      excludes: [
        '[30,80],[40,50],[5,120],[15,90],[20,55] 等全部引导/独立/陌生/迁移冻结示例',
        '该学习者已服务过的实例参数（含 L1 侧已生成实例）',
      ],
      arithmetic: 'S = 2×(157/50)×r×h 一步有理计算（mm²），除以 100 得 cm²，两位小数十进制规则',
    },
  },
  {
    taskId: 'cyl.net.s1.stranger-relabel.v1',
    file: 'cyl.net.s1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.net.s1.F1',
        initial: { radiusMm: 15, heightMm: 90 },
        givenDiameterCm: '3.0',
        truth: {
          radiusCm: '1.5',
          circumferenceCm: '9.42',
          lateralAreaCm2: '84.78',
          pairing: 'standard',
          directionCircleEdges: ['net-edge-2', 'net-edge-4'],
          directionHeightEdges: ['net-edge-1', 'net-edge-3'],
        },
        answerHint:
          '半径 = 3.0÷2 = 1.5 cm；配对：边1→高、边2→上底圆、边3→高、边4→下底圆；圆周={2,4}、高={1,3}；面积 = 9.42×9.0 = 84.78 cm²。',
      },
    ],
  },
  {
    taskId: 'cyl.net.d1.delayed-transfer.v1',
    file: 'cyl.net.d1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.net.d1.F1',
        initial: { radiusMm: 20, heightMm: 55 },
        givenCircumferenceCm: '12.56',
        truth: {
          radiusCm: '2.0',
          lateralAreaSpareCm2: '69.08',
          pairing: 'standard',
          directionCircleEdges: ['net-edge-2', 'net-edge-4'],
          directionHeightEdges: ['net-edge-1', 'net-edge-3'],
        },
        answerHint: '半径 = 12.56÷(2×3.14) = 12.56÷6.28 = 2.0 cm；配对与方向同标准真值表。',
        migration: {
          plannedAt: 'L2 attempt FinishAttempt',
          availableAfterDays: 7,
          nominalWindowEndDays: 14,
          observedRequires: ['newTaskSubmission', 'actualIntervalDays', 'assistanceData'],
        },
      },
    ],
  },
  // ----- L3 instances（冻结示例；数值 π=157/50 一步有理，见 tests/content BigInt 复算） -----
  {
    taskId: 'cyl.faces.i1.faceset-new-instance.v1',
    file: 'cyl.faces.i1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.faces.i1.F1',
        initial: { radiusMm: 50, heightMm: 100 },
        condition: 'has-bottom-no-lid',
        truth: {
          faceSet: { 'cyl-face-side': 'opt-include', 'cyl-face-lower': 'opt-include', 'cyl-face-upper': 'opt-exclude' },
          lidCount: 'opt-1',
          snapshotMustEqualDeclaration: true,
          reviewCircumferenceCm: '31.40',
          reviewLateralAreaCm2: '314.00',
          reviewCircleAreaCm2: '78.50',
        },
        answerHint: '爆米花桶纸样 = 侧面 + 下盖面（1 个盖面）；顶部敞开，上盖面不算。',
      },
    ],
    domain: {
      radiusMm: [100, 600],
      heightMm: [400, 1500],
      stepMm: 100,
      constraints: [
        '整数 cm 半径（L34-13）；radiusMm != heightMm',
        '组合不得等于互斥总清单任何项（L34-12，见 rule.cylFaces.area.v1 注记）',
        '该学习者已服务过的实例参数',
      ],
    },
  },
  {
    taskId: 'cyl.faces.i2.lid-count-condition.v1',
    file: 'cyl.faces.i2.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.faces.i2.F1',
        initial: { radiusMm: 20, heightMm: 90 },
        condition: 'label-to-sealed',
        truth: {
          deltaCm2: '25.12',
          attribution: 'opt-two-lid',
          circleAreaCm2: '12.56',
          lateralAreaCm2: '113.04',
          diagnostics: { misOneLidValue: '12.56', misDoubleSideValue: '226.08' },
        },
        answerHint: '多用的纸 = 新加的两个盖面 = 2×πr² = 2×12.56 = 25.12 cm²；侧面原来就有，不用重算。',
      },
    ],
    domain: {
      radiusMm: [100, 600],
      heightMm: [400, 1500],
      stepMm: 100,
      constraints: ['整数 cm 半径；诊断题 r∉{1,2} cm（L34-13）；互斥总清单 L34-12；已服务实例'],
    },
  },
  {
    taskId: 'cyl.faces.i3.surface-value-unit.v1',
    file: 'cyl.faces.i3.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.faces.i3.F1',
        initial: { radiusMm: 60, heightMm: 40 },
        condition: 'sealed',
        truth: {
          faceSet: { 'cyl-face-side': 'opt-include', 'cyl-face-upper': 'opt-include', 'cyl-face-lower': 'opt-include' },
          surfaceCm2: '376.80',
          circumferenceCm: '37.68',
          lateralAreaCm2: '150.72',
          circleAreaCm2: '113.04',
          diagnostics: { misLidsMissingValue: '150.72', misOneLidValue: '263.76', misDoubleSideValue: '301.44' },
        },
        answerHint: 'C=37.68，S侧=150.72；一个圆=113.04，两个圆=226.08；S表=150.72+226.08=376.80 cm²。',
      },
    ],
    domain: {
      radiusMm: [100, 600],
      heightMm: [400, 1500],
      stepMm: 100,
      constraints: ['整数 cm 半径；r∉{1,2} cm；互斥总清单 L34-12；已服务实例'],
    },
  },
  // ----- L4 instances -----
  {
    taskId: 'cyl.layers.i1.volume-value-unit.v1',
    file: 'cyl.layers.i1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.layers.i1.F1',
        initial: { radiusMm: 40, heightMm: 70 },
        truth: {
          baseAreaCm2: '50.24',
          volumeCm3: '351.68',
          diagnostics: { misCircumferenceTimesH: '175.84', misPiRh: '87.92' },
        },
        answerHint: 'S底=3.14×4×4=50.24；V=50.24×7.0=351.68 cm³。',
      },
    ],
    domain: {
      radiusMm: [100, 600],
      heightMm: [400, 1500],
      stepMm: 100,
      constraints: ['整数 cm 半径；公式诊断题 r∉{1,2} cm（L34-13）；互斥总清单 L34-12；已服务实例'],
    },
  },
  {
    taskId: 'cyl.layers.i2.height-vs-radius-choice.v1',
    file: 'cyl.layers.i2.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.layers.i2.F1',
        initial: { radiusMm: 30, heightMm: 60 },
        variants: { planA: { radiusMm: 30, heightMm: 100 }, planB: { radiusMm: 40, heightMm: 60 } },
        truth: { bigger: 'opt-plan-b', valueACm3: '282.60', valueBCm3: '301.44' },
        answerHint: 'B 装得多：A=28.26×10=282.60，B=50.24×6=301.44；半径只加 1.0 cm，但底面积从 28.26 涨到 50.24。',
      },
    ],
    domain: {
      radiusMm: [100, 600],
      heightMm: [400, 1500],
      stepMm: 100,
      constraints: ['整数 cm 半径；互斥总清单 L34-12（底罐与两变体组合同入排除）；已服务实例'],
    },
  },
  {
    taskId: 'cyl.layers.i3.accumulate-count.v1',
    file: 'cyl.layers.i3.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.layers.i3.F1',
        initial: { radiusMm: 20, heightMm: 100 },
        layer: { layerCount: 10, thicknessMm: 10 },
        targetCm3: '100.00',
        truth: {
          firstExceedLayer: 8,
          cumulativeAtLayerCm3: '100.48',
          perLayerCm3: '12.56',
          boundary: { layer7Cm3: '87.92', layer9Cm3: '113.04' },
          totalCm3: '125.60',
        },
        answerHint: '每层 12.56；第 7 层累计 87.92 还没到，第 8 层 100.48 第一次超过 100——答案：第 8 层，100.48 cm³。',
      },
    ],
    domain: {
      radiusMm: [100, 600],
      heightMm: [400, 1500],
      stepMm: 100,
      constraints: [
        '整数 cm 半径；须存在登记层数 n∈[1,40] 使 heightMm%n==0 且每层两位小数精确（L4 §11-4）',
        'r=2.0 时公式诊断签名退化，只判累计真值（L34-13）；互斥总清单；已服务实例',
      ],
    },
  },
  {
    taskId: 'cyl.layers.s1.stranger-package.v1',
    file: 'cyl.layers.s1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.layers.s1.F1',
        initial: { radiusMm: 50, heightMm: 60 },
        layer: { layerCount: 6, thicknessMm: 10 },
        givenDiameterCm: '10.0',
        condition: 'sealed',
        truth: {
          radiusCm: '5.0',
          faceSet: { 'cyl-face-side': 'opt-include', 'cyl-face-upper': 'opt-include', 'cyl-face-lower': 'opt-include' },
          circumferenceCm: '31.40',
          lateralAreaCm2: '188.40',
          circleAreaCm2: '78.50',
          paperAreaCm2: '345.40',
          volumeCm3: '471.00',
        },
        answerHint: 'r=5.0 cm；面=侧面+上盖+下盖；纸板 345.40 cm²；衬垫 471.00 cm³。',
      },
    ],
  },
  {
    taskId: 'cyl.layers.d1.delayed-transfer.v1',
    file: 'cyl.layers.d1.v1-instances.json',
    kind: 'frozen',
    frozen: [
      {
        instanceId: 'cyl.layers.d1.F1',
        initial: { radiusMm: 40, heightMm: 65 },
        layer: { layerCount: 13, thicknessMm: 5 },
        givenCircumferenceCm: '25.12',
        condition: 'has-bottom-no-lid',
        truth: {
          radiusCm: '4.0',
          faceSet: { 'cyl-face-side': 'opt-include', 'cyl-face-lower': 'opt-include', 'cyl-face-upper': 'opt-exclude' },
          lateralAreaCm2: '163.28',
          circleAreaCm2: '50.24',
          paperAreaCm2: '213.52',
          volumeCm3: '326.56',
        },
        answerHint: 'r=25.12÷6.28=4.0 cm；纸板=侧面+下盖面；213.52 cm²；灌蜡 326.56 cm³。',
        migration: {
          plannedAt: 'L4 attempt FinishAttempt',
          availableAfterDays: 7,
          nominalWindowEndDays: 14,
          observedRequires: ['newTaskSubmission', 'actualIntervalDays', 'assistanceData'],
        },
      },
    ],
  },
];

// h4 (answer-level) registration — public layer registers ONLY that the level
// exists (authored conventions §7: answer 级文案正文置于私有材料，公开层只登记
// 层级存在). The player renders its two-step-confirm button from this entry;
// the Host serves the private text through the gate table (hint.*.l4 files,
// revealsAnswer: true). Every task of every lesson carries h1–h4.
// ---------------------------------------------------------------------------
for (const t of tasks) {
  if (!t.hints.some((h) => h.level === 4)) {
    t.hints.push({ level: 4, label: '答案级提示' });
  }
}

// ---------------------------------------------------------------------------
// standard pairing truth (object-level, conventions §4 / L2 §10.1)
const STANDARD_PAIRING = [
  { cylinderObjectId: 'cyl-part-height-line', netEdgeId: 'net-edge-1' },
  { cylinderObjectId: 'cyl-part-upper-circle', netEdgeId: 'net-edge-2' },
  { cylinderObjectId: 'cyl-part-height-line', netEdgeId: 'net-edge-3' },
  { cylinderObjectId: 'cyl-part-lower-circle', netEdgeId: 'net-edge-4' },
];
const STANDARD_DIRECTION = [
  { cylinderObjectId: 'cyl-part-base-circle', netEdgeId: 'net-edge-2' },
  { cylinderObjectId: 'cyl-part-base-circle', netEdgeId: 'net-edge-4' },
  { cylinderObjectId: 'cyl-part-height-line', netEdgeId: 'net-edge-1' },
  { cylinderObjectId: 'cyl-part-height-line', netEdgeId: 'net-edge-3' },
];
const areaQuantity = (rounding = 2) => ({
  quantityId: 'lateral-area',
  expected: {
    kind: 'RATIONAL_PRODUCT_V1',
    factors: [{ numerator: 157, denominator: 50 }, { numerator: 2, denominator: 1 }, { factor: 'radiusMm' }, { factor: 'heightMm' }],
  },
  acceptedUnitIds: ['cm2'],
  rounding: { mode: 'HALF_UP', decimalPlaces: rounding },
  comparison: 'EXACT_AFTER_ROUNDING',
});
// Quantity expressions evaluate in the MM base (evaluate.ts unit registry +
// view-ops quantityValueText: student units convert via toBase factors; the
// accepted-unit list constrains which units the answer may carry). The radius
// expected is therefore the raw radiusMm factor — defect G (2026-10-27):
// an earlier (1/10 × radiusMm) spelling expressed cm-scaled values and made
// every correct cm answer (s1 1.5, d1 2.0) fail while area passed.
const radiusQuantity = () => ({
  quantityId: 'radius',
  expected: { kind: 'RATIONAL_PRODUCT_V1', factors: [{ factor: 'radiusMm' }] },
  acceptedUnitIds: ['cm'],
  rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
  comparison: 'EXACT_AFTER_ROUNDING',
});
const identificationRule = (ruleId, judgments, note) => ({
  ruleSetVersion: '1',
  rules: [{ ruleKind: 'PARAMETER_IDENTIFICATION_V1', expectedJudgments: judgments }],
  ...(note ? { note } : {}),
});

const rules = [
  {
    ruleId: 'rule.cylParam.changeClassify.v1',
    file: 'rule.cylParam.changeClassify.v1.json',
    boundTasks: ['cyl.param.g1.view-invariance.v1'],
    body: identificationRule(
      'rule.cylParam.changeClassify.v1',
      [
        { propertyId: 'radius', direction: 'UNCHANGED' },
        { propertyId: 'diameter', direction: 'UNCHANGED' },
        { propertyId: 'height', direction: 'UNCHANGED' },
      ],
      'G1：仅视角操作不改变任何尺寸；全部 UNCHANGED 才 CORRECT。reasonTag/freeText 仅入过程证据。',
    ),
    pendingDsl: null,
  },
  {
    ruleId: 'rule.cylParam.readback.v1',
    file: 'rule.cylParam.readback.v1.json',
    boundTasks: ['cyl.param.g2.radius-change.v1', 'cyl.param.g3.height-section.v1'],
    body: {
      ruleSetVersion: '1',
      rules: [
        {
          ruleKind: 'PARAMETER_IDENTIFICATION_V1',
          expectedJudgments: [
            { propertyId: 'diameter', direction: 'INCREASE' },
          ],
        },
        {
          ruleKind: 'PARAMETER_IDENTIFICATION_V1',
          expectedJudgments: [
            { propertyId: 'height', direction: 'INCREASE' },
          ],
        },
      ],
      note: 'rules[0]=G2 分支（快照 r=40/h=80）；rules[1]=G3 分支（快照 h=100/r=30，且 SetSection 至少一次 APPLIED）。expectedJudgments 与公开表单采集范围一致（authored 草案 §3/§4：G2 只判直径方向+数值，G3 只判高度方向+数值+截面；radius/height 的耦合识别属 I1，不入引导题判分）。',
    },
    pendingDsl: {
      reasons: ['L1_NUMERIC_READBACK_FAMILY: 冻结两族无法表达 L1 数值读数判定（d=2r、高读数）与 G3 截面选择判定'],
      numericReadback: {
        'cyl.param.g2.radius-change.v1': { snapshot: { radiusMm: 40, heightMm: 80 }, quantityId: 'diameter', acceptedUnitIds: ['cm', 'mm'], expectedCm: '8.0' },
        'cyl.param.g3.height-section.v1': { snapshot: { radiusMm: 30, heightMm: 100 }, quantityId: 'height', acceptedUnitIds: ['cm', 'mm'], expectedCm: '10.0', sectionPair: { leftId: 'cyl-part-height-line', rightId: 'section-view-axial' } },
      },
      feedback: {
        numericRevise: '再读一次确认后的尺寸表，注意半径和直径的关系。',
        sectionRevise: '再分别切一次横截面和轴截面，找一找哪条边和高一样长。',
      },
    },
  },
  {
    ruleId: 'rule.cylParam.identify.v1',
    file: 'rule.cylParam.identify.v1.json',
    boundTasks: ['cyl.param.i1.identify-changes.v1', 'cyl.param.i2.predict-single-change.v1'],
    body: {
      ruleSetVersion: '1',
      rules: [
        {
          ruleKind: 'PARAMETER_IDENTIFICATION_V1',
          expectedJudgments: [
            { propertyId: 'radius', direction: 'DECREASE' },
            { propertyId: 'diameter', direction: 'DECREASE' },
            { propertyId: 'height', direction: 'UNCHANGED' },
          ],
        },
        {
          ruleKind: 'PARAMETER_IDENTIFICATION_V1',
          expectedJudgments: [
            { propertyId: 'radius', direction: 'UNCHANGED' },
            { propertyId: 'diameter', direction: 'UNCHANGED' },
            { propertyId: 'height', direction: 'INCREASE' },
          ],
        },
      ],
      note: 'rules[0]=I1 冻结实例 EX-B（脚本 RADIUS 45→30）；rules[1]=I2 冻结实例 EX-B 的方向真值（脚本 HEIGHT 70→130，直径不变）。changedSet 完全一致且方向一致才 CORRECT。',
    },
    pendingDsl: {
      reasons: ['L1_NUMERIC_READBACK_FAMILY: I2 的数值新直径判定（=2×r，等价写法/单位换算归一）无法用冻结两族表达'],
      numericReadback: {
        'cyl.param.i2.predict-single-change.v1': { quantityId: 'diameter', acceptedUnitIds: ['cm', 'mm'], expectedCm: '4.0' },
      },
      feedback: { numericRevise: '直径和半径是什么关系？用现在的半径再算一遍。' },
    },
  },
  {
    ruleId: 'rule.cylNet.pairing.v1',
    file: 'rule.cylNet.pairing.v1.json',
    boundTasks: ['cyl.net.g2.edge-pairing.v1', 'cyl.net.i1.pair-normal.v1', 'cyl.net.i2.pair-tall-thin.v1'],
    body: { ruleSetVersion: '1', note: '配对真值锚定展开参数化，与屏幕朝向/条带横竖/长短无关。' },
    pendingDsl: {
      reasons: ['NUMERIC_RELATION_V1_QUANTITY_MIN1: 冻结 NUMERIC_RELATION_V1 要求 quantityChecks>=1，纯配对任务无法以该族表达'],
      numericRelationShape: { ruleKind: 'NUMERIC_RELATION_V1', expectedEdgeMapping: STANDARD_PAIRING, quantityChecks: null },
      diagnostics: {
        'cyl.net.i2.pair-tall-thin.v1': {
          misAppearanceLongEdge: '提交配对呈「长边配圆周」模式（1/3→circle、2/4→height 的任意上下底指派）时记诊断标签 mis-appearance-long-edge',
          feedbackVariant: '再看与底面圆相接的边',
        },
      },
      feedback: {
        reviseGeneric: ['有一条边再回卷确认一下', '再看与底面圆相接的边'],
        policy: 'REVISE 反馈不显示逐行对错、不显示正确行数、不点名边号、不揭示正确配对',
      },
    },
  },
  {
    ruleId: 'rule.cylNet.direction.v1',
    file: 'rule.cylNet.direction.v1.json',
    boundTasks: ['cyl.net.g1.unroll-observe.v1'],
    body: { ruleSetVersion: '1', note: '方向真值与 rule.cylNet.pairing.v1 同源（由配对推导）。' },
    pendingDsl: {
      reasons: ['NUMERIC_RELATION_V1_QUANTITY_MIN1: 纯方向映射任务（边→底面圆周/高）无法以冻结族表达'],
      numericRelationShape: { ruleKind: 'NUMERIC_RELATION_V1', expectedEdgeMapping: STANDARD_DIRECTION, quantityChecks: null },
      feedback: { reviseGeneric: '回卷一小段，盯住一条编号边看它贴着谁。' },
    },
  },
  {
    ruleId: 'rule.cylNet.area.v1',
    file: 'rule.cylNet.area.v1.json',
    boundTasks: ['cyl.net.g3.lateral-area.v1', 'cyl.net.i3.area-value-unit.v1'],
    body: { ruleSetVersion: '1', note: '规范答案 = 2×(157/50)×r×h 一步有理计算（G3 按提交时确认快照；I3 按冻结实例快照），两位小数十进制规则，等价书写归一。' },
    pendingDsl: {
      reasons: ['NUMERIC_RELATION_V1_EDGE_MIN1: 冻结 NUMERIC_RELATION_V1 要求 expectedEdgeMapping>=1，纯数值任务无法以该族表达'],
      quantityChecks: [areaQuantity()],
      diagnostics: {
        misBaseAreaAdded: '提交值精确等于 C×h+πr² 或 C×h+2πr² 时记 mis-base-area-added，反馈「再检查：这道题只要侧面的面积，底面要算进去吗？」（不带数值）',
        unitMismatch: '数值对单位错时记 unit-mismatch，反馈「数值对了，再看看单位」',
      },
      feedback: { numericRevise: '再算一遍，注意先算周长再乘高。' },
    },
  },
  {
    ruleId: 'rule.cylNet.transfer.v1',
    file: 'rule.cylNet.transfer.v1.json',
    boundTasks: ['cyl.net.s1.stranger-relabel.v1', 'cyl.net.d1.delayed-transfer.v1'],
    body: {
      ruleSetVersion: '1',
      rules: [
        {
          ruleKind: 'NUMERIC_RELATION_V1',
          expectedEdgeMapping: STANDARD_PAIRING,
          quantityChecks: [radiusQuantity(), areaQuantity()],
        },
        {
          ruleKind: 'NUMERIC_RELATION_V1',
          expectedEdgeMapping: STANDARD_DIRECTION,
          quantityChecks: [radiusQuantity()],
        },
      ],
      note: '本 rule 在冻结 DSL 内完整可表达（mapping+quantity 同时存在）。expected 表达式一律 mm 基（面积 mm²、半径 mm），学生作答单位经单位表换算后比较；两 rules 分别承载 edgePairing 与 directionClaims 两段映射词表，S1/D1 冻结实例见 instances/。',
    },
    pendingDsl: null,
  },
  // =========================================================================
  // L3/L4 rules — FORMALIZED (integration W1, H0-DELTA-INTEGRATION-20261027-3):
  // the five pendingDsl truths are now executable rule kinds
  // (modules/contracts/server/rules-l34.ts; bodies carry kind + entries).
  // =========================================================================
  {
    ruleId: 'rule.cylFaces.set.v1',
    file: 'rule.cylFaces.set.v1.json',
    boundTasks: ['cyl.faces.g1.face-inventory.v1', 'cyl.faces.i1.faceset-new-instance.v1'],
    note: '面集合真值按包装条件（有底/有盖）；分项反馈不点名行、不显示正确行数（沿 L2 配对反馈受限纪律）。原 FACE_SET_FAMILY pendingDsl 已正式化为 FACE_SET_TRUTH（H0-DELTA-INTEGRATION-20261027-3）。',
    body: {
      kind: 'FACE_SET_TRUTH',
      entries: {
        'cyl.faces.g1.face-inventory.v1': {
          condition: 'has-bottom-no-lid',
          faceSet: { 'cyl-face-side': 'opt-include', 'cyl-face-lower': 'opt-include', 'cyl-face-upper': 'opt-exclude' },
          lidCount: 'opt-1',
          snapshotMustEqualDeclaration: true,
          compareOnly: {
            labelTube: ['cyl-face-side'],
            sealedTube: ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'],
          },
        },
        'cyl.faces.i1.faceset-new-instance.v1': { fromInstance: 'cyl.faces.i1.F1', snapshotMustEqualDeclaration: true },
      },
      feedback: {
        reviseGeneric: '再读一遍条件：这个包装上面开口吗？底下要不要纸？',
        missingLowerVariant: '无盖说的是上面开口——再看看底下要不要纸。',
        snapshotMismatch: '先把场景里的选面改成你答案里的样子，再提交。',
        policy: 'REVISE 反馈不点名行、不显示正确行数、不揭示正确集合',
      },
    },
  },
  {
    ruleId: 'rule.cylFaces.area.v1',
    file: 'rule.cylFaces.area.v1.json',
    boundTasks: [
      'cyl.faces.g2.one-lid-area.v1',
      'cyl.faces.g3.full-surface.v1',
      'cyl.faces.i2.lid-count-condition.v1',
      'cyl.faces.i3.surface-value-unit.v1',
    ],
    note: '组合面积 = C×h + 盖数×πr² 一步有理（π=157/50），两位小数十进制规则，等价书写归一，容差不取浮点 epsilon。Δ=2πr² 分支同。反馈一律不带数值、不反推。原 COMBO_SUM_FAMILY pendingDsl 已正式化为 COMBO_AREA_TRUTH（H0-DELTA-INTEGRATION-20261027-3）；诊断签名由判分器按判定快照一步有理重算，诊断结构携带 tag+受限反馈。',
    body: {
      kind: 'COMBO_AREA_TRUTH',
      entries: {
        'cyl.faces.g2.one-lid-area.v1': {
          taskForm: 'COMBO',
          snapshot: { radiusMm: 30, heightMm: 80 },
          faceSet: { 'cyl-face-side': 'opt-include', 'cyl-face-lower': 'opt-include', 'cyl-face-upper': 'opt-exclude' },
          snapshotMustEqualDeclaration: true,
          expectedCm2: '178.98',
        },
        'cyl.faces.g3.full-surface.v1': {
          taskForm: 'COMBO',
          snapshot: { radiusMm: 30, heightMm: 80 },
          faceSet: { 'cyl-face-side': 'opt-include', 'cyl-face-upper': 'opt-include', 'cyl-face-lower': 'opt-include' },
          snapshotMustEqualDeclaration: true,
          expectedCm2: '207.24',
          advice: { usable: 'opt-advice-no', problem: 'opt-advice-missing-lid' },
        },
        'cyl.faces.i2.lid-count-condition.v1': {
          taskForm: 'LID_DELTA',
          snapshot: { radiusMm: 20, heightMm: 90 },
          fromInstance: 'cyl.faces.i2.F1',
          snapshotSubsetOnly: true,
          expectedCm2: '25.12',
          attribution: 'opt-two-lid',
        },
        'cyl.faces.i3.surface-value-unit.v1': {
          taskForm: 'COMBO',
          snapshot: { radiusMm: 60, heightMm: 40 },
          fromInstance: 'cyl.faces.i3.F1',
          snapshotSubsetOnly: true,
          expectedCm2: '376.80',
        },
      },
      diagnostics: {
        misOneLidMissing: { tag: 'mis-one-lid-missing', feedback: '封口罐有几个圆面？再数一遍' },
        misLidsMissing: { tag: 'mis-lids-missing', feedback: '封口罐有几个圆面？再数一遍' },
        misDoubleSide: { tag: 'mis-double-side', feedback: '多用的是圆面还是侧面翻倍？' },
        unitMismatch: { tag: 'unit-mismatch', feedback: '数值对了，再看看单位' },
      },
      feedback: { numericRevise: '先分面，再把每个面的面积加起来。' },
    },
  },
  {
    ruleId: 'rule.cylLayers.stack.v1',
    file: 'rule.cylLayers.stack.v1.json',
    boundTasks: [
      'cyl.layers.g1.stack-invariant.v1',
      'cyl.layers.g2.layer-volume.v1',
      'cyl.layers.i3.accumulate-count.v1',
    ],
    note: '层不变量（层数改变不改变总体积）；层厚/每层/总量与累计边界全部一步有理；活动校验以确认操作事件为准（动画帧/相机不计）。原 LAYER_ACCUM_FAMILY pendingDsl 已正式化为 LAYER_STACK_TRUTH（H0-DELTA-INTEGRATION-20261027-3）。',
    body: {
      kind: 'LAYER_STACK_TRUTH',
      entries: {
        'cyl.layers.g1.stack-invariant.v1': {
          taskForm: 'STACK_INVARIANT',
          snapshot: { radiusMm: 30, heightMm: 80 },
          directions: { layerThickness: 'DECREASE', totalVolume: 'UNCHANGED' },
          volumeCm3: '226.08',
          compare16: { perLayerCm3: '14.13', totalCm3: '226.08' },
          activity: { setLayerCountValues: [8, 16], setVisibleLayerCountAppliesMin: 1 },
        },
        'cyl.layers.g2.layer-volume.v1': {
          taskForm: 'LAYER_VOLUME',
          snapshot: { radiusMm: 30, heightMm: 80, layerCount: 8 },
          thicknessCm: '1.0',
          perLayerCm3: '28.26',
          totalCm3: '226.08',
          activity: { visibleLayerCountReached: 8 },
        },
        'cyl.layers.i3.accumulate-count.v1': {
          taskForm: 'ACCUMULATE',
          fromInstance: 'cyl.layers.i3.F1',
          targetCm3: '100.00',
          activity: { setVisibleLayerCountAppliesMin: 1 },
        },
      },
      feedback: {
        invariantRevise: '层数只是把同样的东西切得更薄——累计表最后一行变了没有？',
        activityRevise: '先把两种层数都装一遍看看。',
        boundaryRevise: '超过 100 的那一层和还没超过的上一层，各再看一眼。',
        cumulativeRevise: '累计要数到你自己选的那一层。',
      },
    },
  },
  {
    ruleId: 'rule.cylLayers.volume.v1',
    file: 'rule.cylLayers.volume.v1.json',
    boundTasks: [
      'cyl.layers.g3.height-vs-radius.v1',
      'cyl.layers.i1.volume-value-unit.v1',
      'cyl.layers.i2.height-vs-radius-choice.v1',
    ],
    note: 'V=πr²h 一步有理（π=157/50），两位小数；G3/I2 按任务脚本变体重算（判分不依赖当前快照，改场景不能把错答变对）；诊断签名按公式模式匹配，反馈不带数值。原 VOLUME_COMPARE_FAMILY pendingDsl 已正式化为 VOLUME_COMPARE_TRUTH（H0-DELTA-INTEGRATION-20261027-3）。',
    body: {
      kind: 'VOLUME_COMPARE_TRUTH',
      entries: {
        'cyl.layers.g3.height-vs-radius.v1': {
          taskForm: 'VAR_COMPARE',
          variants: { planA: { radiusMm: 30, heightMm: 160 }, planB: { radiusMm: 60, heightMm: 80 } },
          bigger: 'opt-plan-b',
          valueACm3: '452.16',
          valueBCm3: '904.32',
          ratio: 'opt-ratio-4',
          recheck: { baseCm3: '12.56', recheckBCm3: '50.24', recheckACm3: '25.12' },
          activity: { setDimensionAxes: ['RADIUS', 'HEIGHT'] },
        },
        'cyl.layers.i1.volume-value-unit.v1': {
          taskForm: 'VOLUME_VALUE',
          fromInstance: 'cyl.layers.i1.F1',
          diagnostics: { misCircumferenceTimesH: '175.84', misPiRh: '87.92' },
        },
        'cyl.layers.i2.height-vs-radius-choice.v1': {
          taskForm: 'VAR_COMPARE',
          fromInstance: 'cyl.layers.i2.F1',
          diagnostics: { misLinearChoice: 'bigger=A 且两数值正确时记 mis-linear-choice' },
        },
      },
      feedback: {
        misCircumferenceTimesH: '先想底面：罐子靠哪个面站着？那一面是圆的什么量',
        misPiRh: '底面积里半径用了几次？',
        misLinearChoice: '两个方案各算一遍底面积再比——别只看加的厘米数',
        unitMismatch: '数值对了，再看看单位',
        numericRevise: '先算底面积，再乘高',
        ratioRevise: '半径加倍时底面积怎么变？再乘同一个高看看',
        activityRevise: '两个方案都要在罐子上试一遍',
      },
    },
  },
  {
    ruleId: 'rule.cylLayers.transfer.v1',
    file: 'rule.cylLayers.transfer.v1.json',
    boundTasks: ['cyl.layers.s1.stranger-package.v1', 'cyl.layers.d1.delayed-transfer.v1'],
    note: '四段复合（paramRead/faceSet/paperArea/volume）分别判分、分别反馈；段间不互相提示正确值；面集合段 REVISE 反馈不点名行。原 TRANSFER4_FAMILY pendingDsl 已正式化为 TRANSFER4_TRUTH（H0-DELTA-INTEGRATION-20261027-3）；四段真值经冻结实例真值解析。',
    body: {
      kind: 'TRANSFER4_TRUTH',
      entries: {
        'cyl.layers.s1.stranger-package.v1': { fromInstance: 'cyl.layers.s1.F1', snapshotMustEqualDeclaration: true },
        'cyl.layers.d1.delayed-transfer.v1': { fromInstance: 'cyl.layers.d1.F1', snapshotMustEqualDeclaration: true },
      },
      feedback: {
        paramReadRevise: '半径和直径/周长的关系再倒过来用一次。',
        faceSetRevise: '再读一遍条件：上面开口吗？底下要不要纸？',
        paperRevise: '先分面，再把每个面的面积加起来。',
        volumeRevise: '先算底面积，再乘高。',
        policy: '任一段 REVISE 反馈不得携带其他段真值（LIFE §11 反例清单增列，delta §10-5）',
      },
    },
  },
];

// bindings (private)
function bindingsFor(releaseId, taskIds) {
  return {
    releaseId,
    taskBindings: taskIds.map((taskId) => {
      const rule = rules.find((r) => r.boundTasks.includes(taskId));
      const inst = instances.find((i) => i.taskId === taskId);
      return {
        taskId,
        ruleRef: { ruleId: rule.ruleId, ruleVersion: '1', path: `rules/${rule.file}` },
        ...(inst ? { instanceGeneratorRef: { kind: 'frozen', path: `instances/${inst.file}` } } : {}),
        ...(COMPOSITE_SEGMENTS[taskId] ? { enabledSegments: COMPOSITE_SEGMENTS[taskId] } : {}),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------
function writeJson(path, value) {
  mkdirSync(join(OUT, path, '..'), { recursive: true });
  writeFileSync(join(OUT, path), JSON.stringify(value, null, 2) + '\n');
}

writeJson('public/schemas/response-schemas.registry.json', registry);
writeJson('public/lessons.json', lessons);
for (const t of tasks) {
  const { title, ...rest } = t;
  writeJson(`public/tasks/${t.taskId}.json`, { title, ...rest });
}
for (const inst of instances) {
  writeJson(`private/instances/${inst.file}`, inst);
}
for (const rule of rules) {
  writeJson(`private/rules/${rule.file}`, rule);
}

// answer hints (private): frozen-instance texts + static texts for guided tasks
const answerHints = {};
for (const inst of instances) {
  answerHints[inst.taskId] = inst.frozen.map((f) => ({ instanceId: f.instanceId, level: 4, text: f.answerHint }));
}
const staticAnswerHints = {
  'cyl.param.g1.view-invariance.v1': '不会改变。只转动观察时，半径仍是 3.0 cm、高度仍是 8.0 cm；要改变它们必须修改尺寸设置。',
  'cyl.param.g2.radius-change.v1': '直径是 8.0 cm（80 mm），因为 2 × 4.0 cm = 8.0 cm。',
  'cyl.param.g3.height-section.v1': '轴截面（沿轴切开）能看到高——切出的矩形一条边就是 10.0 cm；横截面是圆，显示的是半径/直径，看不到高。新的高是 10.0 cm。',
  'cyl.net.g1.unroll-observe.v1': '卷回后边 2、边 4 形成底面圆周；边 1、边 3 成为高。C = 2×3.14×3.0 = 18.84 cm，与条带周长方向边长相等；高 8.0 cm 与高度方向边长相等。',
  'cyl.net.g2.edge-pairing.v1': '边 1→高；边 2→上底圆；边 3→高；边 4→下底圆。',
  'cyl.net.i1.pair-normal.v1': '边 1→高；边 2→上底圆；边 3→高；边 4→下底圆。',
  'cyl.net.i2.pair-tall-thin.v1': '边 1→高；边 2→上底圆；边 3→高；边 4→下底圆。这个圆筒很细：周长 3.14 cm 比高 12.0 cm 短——长的边是高，不是圆周。',
  'cyl.faces.g1.face-inventory.v1': '笔筒要侧面和下盖面，共 1 个盖面；封口罐要全部三个面、2 个盖面；标签筒只要侧面。',
  'cyl.faces.g2.one-lid-area.v1': '笔筒纸 = 150.72 + 28.26 = 178.98 cm²；面集合 = 侧面+下盖面。',
  'cyl.faces.g3.full-surface.v1': '建议单不能用——封口罐有上、下两个圆面，各 28.26 cm²；S表 = 150.72 + 28.26×2 = 150.72 + 56.52 = 207.24 cm²。',
  'cyl.layers.g1.stack-invariant.v1': '总体积不变，都是 226.08 cm³；每层从 1.0 cm 变 0.5 cm，层数×层厚始终等于高 8.0 cm。',
  'cyl.layers.g2.layer-volume.v1': '层厚 1.0 cm；每层 = 3.14×3.0×3.0×1.0 = 28.26 cm³；总量 = 28.26×8 = 226.08 cm³。',
  'cyl.layers.g3.height-vs-radius.v1': '乙装得多：甲=28.26×16=452.16，乙=113.04×8=904.32；半径加倍→底面积 4 倍→体积 4 倍；高度加倍只把体积变 2 倍。',
};
for (const [taskId, text] of Object.entries(staticAnswerHints)) {
  if (!answerHints[taskId]) answerHints[taskId] = [{ instanceId: 'static', level: 4, text }];
}
writeJson('private/hints/answer-hints.json', answerHints);

const l1TaskIds = lessons.lessons[0].taskOrder;
const l2TaskIds = [...lessons.lessons[1].taskOrder, lessons.lessons[1].delayedTransferTaskId];
const l3TaskIds = lessons.lessons[2].taskOrder;
const l4TaskIds = [...lessons.lessons[3].taskOrder, lessons.lessons[3].delayedTransferTaskId];
writeJson('private/bindings/l1-r1.bindings.private.json', bindingsFor(RELEASE_L1, l1TaskIds));
writeJson('private/bindings/l2-r1.bindings.private.json', bindingsFor(RELEASE_L2, l2TaskIds));
writeJson('private/bindings/l3-r1.bindings.private.json', bindingsFor(RELEASE_L3, l3TaskIds));
writeJson('private/bindings/l4-r1.bindings.private.json', bindingsFor(RELEASE_L4, l4TaskIds));

// manifests with asset hashes (public files under content/cylinder/public,
// excluding releases/**; per-release scope = its tasks + shared registry/lessons)
function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
function sha256Canonical(value) {
  const json = JSON.stringify(value);
  return createHash('sha256').update(json).digest('hex');
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

function buildManifest(releaseId, taskIds, dirName, renderer, unionOps) {
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
  const manifest = {
    releaseId,
    taskIds,
    taskVersion: '1',
    rendererDeclarations: [renderer],
    publicAssetHashes: hashes,
    // both expressions declare the same per-release operation subset
    // (fallback parity; L3/L4 add SelectFaces / layer ops per L34-2 / L34-1)
    expressionOperationSubsets: [
      { expression: 'WEBGL2', allowedOperationIds: unionOps },
      { expression: 'SVG_DOM', allowedOperationIds: unionOps },
    ],
    publicManifestHash: '',
  };
  // self-hash over the manifest content EXCLUDING the publicManifestHash field
  const { publicManifestHash: _omitted, ...manifestContent } = manifest;
  manifest.publicManifestHash = sha256Canonical(manifestContent);
  writeJson(`public/releases/${dirName}/manifest.public.json`, manifest);
  writeJson(
    `public/releases/${dirName}/assets-map.json`,
    {
      releaseId,
      note: 'path -> sha256 of the public asset files hashed into publicAssetHashes; this map itself is not hashed',
      assets: assetMap,
    },
  );
}
const unionOpsOf = (taskIds) => [...new Set(tasks.filter((t) => taskIds.includes(t.taskId)).flatMap((t) => t.allowedOperationIds))];
buildManifest(RELEASE_L1, l1TaskIds, 'l1-r1', RENDERER, unionOpsOf(l1TaskIds));
buildManifest(RELEASE_L2, l2TaskIds, 'l2-r1', RENDERER, unionOpsOf(l2TaskIds));
buildManifest(RELEASE_L3, l3TaskIds, 'l3-r1', RENDERER, unionOpsOf(l3TaskIds));
buildManifest(RELEASE_L4, l4TaskIds, 'l4-r1', RENDERER_V2, unionOpsOf(l4TaskIds));

console.log(`content emitted: ${tasks.length} tasks, ${rules.length} rules, ${instances.length} instance files`);
console.log(
  `releases: ${RELEASE_L1} (${l1TaskIds.length}), ${RELEASE_L2} (${l2TaskIds.length}), ${RELEASE_L3} (${l3TaskIds.length}), ${RELEASE_L4} (${l4TaskIds.length})`,
);

// ---------------------------------------------------------------------------
// dist/content — the B release layout the Host loads (RondoContentService.
// loadRelease(rootDir, releaseId)): <root>/<releaseId>/manifest.json,
// public/tasks/*.json, public/hints/*.json, private/rules.json.
//
// The transform is faithful to C's authored data. Where B's frozen schemas
// cannot express that data (observation-only tasks with zero allowed
// operations; rule bodies the two frozen rule families cannot represent),
// the inexpressible values are emitted AS-IS — the Host's loadRelease then
// REFUSES the release with the exact stable code (see the wiring report's
// CONTRACT_CHANGE_REQUIRED items). Nothing is fabricated to force a fit.
// ---------------------------------------------------------------------------
import { mkdirSync as distMkdir, writeFileSync as distWrite, rmSync as distRm } from 'node:fs';

const DIST_CONTENT = join(process.env.RONDO_DIST_DIR ?? join(ROOT,'dist'), 'content');
// Wipe ONLY this builder's own releases: themes-a and cpp dist trees are
// emitted by their own chained builders and must survive standalone runs of
// this script (the parity tests invoke it directly during test:content).
for (const rid of ['rondo.cyl.l1-r1', 'rondo.cyl.l2-r1', 'rondo.cyl.l3-r1', 'rondo.cyl.l4-r1']) {
  distRm(join(DIST_CONTENT, rid), { recursive: true, force: true });
}

function canonicalize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
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

function publicManifestHash(publicHeader, taskObjs, hintObjs) {
  return createHash('sha256')
    .update(canonicalize({ publicHeader, tasks: taskObjs, hints: hintObjs, assets: {} }))
    .digest('hex');
}

function writeDistJson(relPath, value) {
  const target = join(DIST_CONTENT, relPath);
  distMkdir(join(target, '..'), { recursive: true });
  distWrite(target, JSON.stringify(value, null, 2) + '\n');
}

const NET_OBJECTS = {
  cylinderObjectIds: [
    'cyl-part-upper-circle',
    'cyl-part-lower-circle',
    'cyl-part-height-line',
    'cyl-part-base-circle',
  ],
  netEdgeIds: ['net-edge-1', 'net-edge-2', 'net-edge-3', 'net-edge-4'],
};
const FACE_OBJECTS = { faceIds: ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'] };

function bTaskFile(t) {
  const file = {
    taskId: t.taskId,
    taskFamily: t.taskFamily,
    title: t.title,
    promptGroups: [{ minVisibility: 'PREDICTION', blocks: t.prompt }],
    responseSchemaId: t.responseSchemaId,
    numericPolicy: t.numericPolicy,
    allowedOperationIds: t.allowedOperationIds,
    givens: { radiusMm: t.givens.radiusMm, heightMm: t.givens.heightMm },
    initialState: {
      unrollPermille: t.givens.unrollPermille ?? 0,
      section: t.givens.section ?? 'NONE',
      selectedFaceIds: t.givens.selectedFaceIds ?? [],
      // @2 tasks carry the layer pair (L34-1); @1 files stay free of them
      ...(t.taskFamily === 'cylinder.layers.v1'
        ? { layerCount: t.givens.layerCount, visibleLayerCount: t.givens.visibleLayerCount ?? 0 }
        : {}),
    },
  };
  if (t.givenLocks && t.givenLocks.includes('radiusMm') && t.givenLocks.includes('heightMm')) {
    file.lockedDimensions = true;
  }
  if (t.taskFamily === 'cylinder.net.v1') file.sceneObjects = NET_OBJECTS;
  if (t.taskFamily === 'cylinder.faces.v1') file.sceneObjects = FACE_OBJECTS;
  return file;
}

/** Emitted hint files per task: authored levels 1-3 + the private answer hint at level 4. */
function bHintFiles(t) {
  const files = [];
  for (const hint of t.hints) {
    if (hint.level >= 4) continue; // level-4 file is emitted below from the PRIVATE answer registry (revealsAnswer: true)
    const contentRef = `hint.${t.taskId}.l${hint.level}`;
    files.push({
      contentRef,
      level: hint.level,
      revealsAnswer: false,
      version: '1',
      ...(hint.text ? { text: hint.text } : { text: `提示（层级 ${hint.level}）：内容待补。` }),
    });
  }
  const answerList = answerHints[t.taskId];
  if (answerList && answerList.length > 0) {
    files.push({
      contentRef: `hint.${t.taskId}.l4`,
      level: 4,
      revealsAnswer: true,
      version: '1',
      text: answerList[0].text,
    });
  }
  return files;
}

function bConstructionDomains(t) {
  const domains = [];
  for (const c of t.operationConstraints) {
    if (c.type !== 'SetDimension') continue;
    let min;
    let max;
    if (Array.isArray(c.valuesMm) && c.valuesMm.length > 0) {
      min = Math.min(...c.valuesMm);
      max = Math.max(...c.valuesMm);
    } else if (c.minMm !== undefined || c.maxMm !== undefined) {
      min = c.minMm ?? 5;
      max = c.maxMm ?? 100;
    } else {
      continue;
    }
    domains.push({ paramId: c.dimension === 'RADIUS' ? 'radiusMm' : 'heightMm', kind: 'INT_RANGE', min, max });
  }
  return domains.length > 0 ? [{ taskId: t.taskId, domains }] : [];
}

function emitDistRelease(releaseId, taskIds, renderer) {
  const releaseTasks = tasks.filter((t) => taskIds.includes(t.taskId));
  const taskObjs = {};
  const hintObjs = {};
  const hintGateTable = [];
  const constructionParamDomains = [];
  for (const t of releaseTasks) {
    const file = bTaskFile(t);
    taskObjs[t.taskId] = file;
    writeDistJson(join(releaseId, 'public', 'tasks', `${t.taskId}.json`), file);
    for (const hintFile of bHintFiles(t)) {
      hintObjs[hintFile.contentRef] = hintFile;
      writeDistJson(join(releaseId, 'public', 'hints', `${hintFile.contentRef}.json`), hintFile);
      hintGateTable.push({ taskId: t.taskId, hintLevel: hintFile.level, contentRef: hintFile.contentRef });
    }
    constructionParamDomains.push(...bConstructionDomains(t));
  }

  // v2 private side (RULE_DSL_VERSION '2'): the C bindings manifest verbatim
  // (privateReleaseBindingsV2Schema), the bound C rule files verbatim (the
  // Host's loader adds ONLY the `kind` discriminator via the fixed
  // file→kind table — see modules/content RULE_KIND_BY_FILE), and the
  // referenced frozen instance files.
  const bindings = bindingsFor(releaseId, taskIds);
  writeDistJson(join(releaseId, 'private', 'bindings.json'), bindings);
  const boundRules = rules.filter((r) => taskIds.some((id) => r.boundTasks.includes(id)));
  for (const r of boundRules) {
    writeDistJson(join(releaseId, 'private', 'rules', r.file), r);
  }
  for (const binding of bindings.taskBindings) {
    if (!binding.instanceGeneratorRef) continue;
    const inst = instances.find((i) => binding.instanceGeneratorRef.path.endsWith(i.file));
    if (inst) writeDistJson(join(releaseId, 'private', binding.instanceGeneratorRef.path), inst);
  }

  const ruleRefs = taskIds.map((taskId) => {
    const rule = rules.find((r) => r.boundTasks.includes(taskId));
    return { taskId, ruleId: rule.ruleId, ruleVersion: '1' };
  });

  const unionOps = [...new Set(releaseTasks.flatMap((t) => t.allowedOperationIds))];
  const publicHeader = {
    releaseId,
    taskIds,
    taskVersion: '1',
    rendererDeclarations: [renderer],
    publicAssetHashes: [],
    expressionOperationSubsets: [
      { expression: 'WEBGL2', allowedOperationIds: unionOps },
      { expression: 'SVG_DOM', allowedOperationIds: unionOps },
    ],
  };
  const manifest = {
    public: { ...publicHeader, publicManifestHash: publicManifestHash(publicHeader, taskObjs, hintObjs) },
    private: { ruleRefs, hintGateTable, constructionParamDomains },
  };
  writeDistJson(join(releaseId, 'manifest.json'), manifest);

  const emptyOpTasks = releaseTasks.filter((t) => t.allowedOperationIds.length === 0).map((t) => t.taskId);
  console.log(
    `dist/content ${releaseId}: ${taskIds.length} tasks, ${Object.keys(hintObjs).length} hints, ` +
      `${boundRules.length} v2 rule files` +
      (emptyOpTasks.length ? `；零操作任务（B TaskFile allowedOperationIds min(1) 缺口）：${emptyOpTasks.join(',')}` : ''),
  );
}

emitDistRelease(RELEASE_L1, l1TaskIds, RENDERER);
emitDistRelease(RELEASE_L2, l2TaskIds, RENDERER);
emitDistRelease(RELEASE_L3, l3TaskIds, RENDERER);
emitDistRelease(RELEASE_L4, l4TaskIds, RENDERER_V2);
console.log('dist/content emitted (B release layout; Host reads all of it, renderer protocol never maps it)');
