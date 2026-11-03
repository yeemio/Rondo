#!/usr/bin/env node
/**
 * Rondo GESP2 unit-1 content builder (cpp.steps.v1 / rondo.steps@1).
 *
 * Single source of truth: emits the whole content/cpp tree (public + private)
 * deterministically, then the dist/content B release layout for
 * rondo.cpp.u1-r1. Mirrors scripts/build-content.mjs conventions (hashes,
 * manifests, bindings) so the two trees stay structurally parallel.
 *
 * Sources (frozen, read-only):
 * - preparation/GESP2/GESP2-UNIT-SPEC.md + GESP2-CONTRACT-DELTA.md
 *   (A-line approved 2026-10-27; K1-K8 stay 待官方考纲原文核对 — no syllabus
 *   text is copied, every task is original)
 * - modules/contracts/public/scene-steps.ts (StepSpecV1/StepProgramStateV1)
 * - modules/contracts/server/rules-steps.ts (STEP_TASK_TRUTH DSL)
 *
 * All expected values are hand-computed (see HAND_CHECK_TABLE below; the
 * engine test cross-verifies every row against the shared interpreter).
 *
 * Run: node scripts/build-content-cpp.mjs   (after build-content.mjs; also
 * chained in npm run build:content and tooling/build.mjs)
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readdirSync, statSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'content', 'cpp');
const RELEASE = 'rondo.cpp.u1-r1';
const TASK_VERSION = '1';

// ---------------------------------------------------------------------------
// shared ids
// ---------------------------------------------------------------------------
const UNSURE = { id: 'opt-unsure', label: '不确定' };
const PHASES_ALL = ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'];

const A = (v, expr) => ({ kind: 'ASSIGN', var: v, expr });
const O = (expr) => ({ kind: 'OUTPUT', expr });
const IF = (cond, then, els = [], checkpointId = undefined) => ({
  ...(checkpointId ? { checkpointId } : {}),
  kind: 'IF',
  cond,
  then,
  else: els,
});
const FOR = (v, from, bound, cmp, body) => ({ kind: 'FOR', var: v, from, bound, cmp, body });

// ---------------------------------------------------------------------------
// 12 组期望值手算复核表（UNIT-SPEC §4 各卡；tests/cpp/engine.test.ts 逐行复算）
// 每行：组号、说明、程序、输入、期望输出行、期望终值（关键变量）
// ---------------------------------------------------------------------------
export const HAND_CHECK_TABLE = [
  {
    group: 1, note: 'g1 原卡：total=12+7=19，再 +4=23',
    program: [A('a', '12'), A('b', '7'), A('total', 'a + b'), A('total', 'total + 4'), O('total')],
    inputs: {}, expectedLines: ['23'], finals: { a: 12, b: 7, total: 23 },
  },
  {
    group: 2, note: 'g1 编辑后（4→6，插入 OUTPUT a）：total=19+6=25',
    program: [A('a', '12'), A('b', '7'), A('total', 'a + b'), A('total', 'total + 6'), O('a'), O('total')],
    inputs: {}, expectedLines: ['12', '25'], finals: { a: 12, b: 7, total: 25 },
  },
  {
    group: 3, note: 'g2 原卡：75÷8 商 9 余 3（8×9=72，75−72=3）',
    program: [A('n', '75'), A('k', '8'), A('bags', 'n / k'), A('left', 'n % k'), O('bags'), O('left')],
    inputs: {}, expectedLines: ['9', '3'], finals: { n: 75, k: 8, bags: 9, left: 3 },
  },
  {
    group: 4, note: 'g2 第一问：n=100，k=8 → 100÷8=12 余 4',
    program: [A('n', '100'), A('k', '8'), A('bags', 'n / k'), A('left', 'n % k'), O('bags'), O('left')],
    inputs: {}, expectedLines: ['12', '4'], finals: { bags: 12, left: 4 },
  },
  {
    group: 5, note: 'g2 第二问：n=100，k=12 → 100÷12=8 余 4（12×8=96）',
    program: [A('n', '100'), A('k', '12'), A('bags', 'n / k'), A('left', 'n % k'), O('bags'), O('left')],
    inputs: {}, expectedLines: ['8', '4'], finals: { n: 100, k: 12, bags: 8, left: 4 },
  },
  {
    group: 6, note: 'g3 原卡：47≥30 走优惠 pay=47−5=42',
    program: [A('total', '47'), IF('total >= 30', [A('pay', 'total - 5')], [A('pay', 'total')], 'if-1'), O('pay')],
    inputs: {}, expectedLines: ['42'], finals: { total: 47, pay: 42 }, branch: { 'if-1': 'TAKEN' },
  },
  {
    group: 7, note: 'g3 边界：total=30 时 >= 仍走优惠 pay=25；若换成 > 则走原价 pay=30',
    program: [A('total', '30'), IF('total >= 30', [A('pay', 'total - 5')], [A('pay', 'total')], 'if-1'), O('pay')],
    inputs: {}, expectedLines: ['25'], finals: { total: 30, pay: 25 }, branch: { 'if-1': 'TAKEN' },
  },
  {
    group: 8, note: 'g4 原卡：1+2+3+4+5=15，退出时 i=6，循环体 5 次；插入 OUTPUT i 后输出 1..5 与 15',
    program: [A('sum', '0'), FOR('i', '1', '5', '<=', [A('sum', 'sum + i')]), O('sum')],
    inputs: {}, expectedLines: ['15'], finals: { sum: 15, i: 6 }, tripCount: 5,
  },
  {
    group: 9, note: 'g4 上界 100：1+...+100=5050（步数 101 ≤ 200）',
    program: [A('sum', '0'), FOR('i', '1', '100', '<=', [A('sum', 'sum + i')]), O('sum')],
    inputs: {}, expectedLines: ['5050'], finals: { sum: 5050, i: 101 },
  },
  {
    group: 10, note: 'i1 修好前后：n=10 时 < 漏掉第 10 圈得 45；<= 得 55（i 终值 11）；隐藏 n=20 得 210',
    program: [A('sum', '0'), FOR('i', '1', 'n', '<=', [A('sum', 'sum + i')]), O('sum')],
    inputs: { n: 10 }, expectedLines: ['55'], finals: { sum: 55, i: 11 },
    variants: [
      { cmp: '<', inputs: { n: 10 }, expectedLines: ['45'] },
      { cmp: '<', inputs: { n: 20 }, expectedLines: ['190'] },
      { cmp: '<=', inputs: { n: 20 }, expectedLines: ['210'] },
    ],
  },
  {
    group: 11, note: 'i2/i3/s1/d1 冻结实例：i2 n=40→10、n=0→0、n=4→1；i3 358→8/5/3（n 终 3）、207→7/0/2；s1 60→20/60、25→8/24；d1 260..299→13、260..289→12',
    program: null, // 组合组：由各任务条目复算（见 tasks/rules 数据）
    combo: true,
  },
  {
    group: 12, note: '负数除/余（C++11 截断与符号）：(-7)/2=-3、(-7)%2=-1、7/(-2)=-3、7%(-2)=1',
    program: [A('q1', '-7 / 2'), A('r1', '-7 % 2'), A('q2', '7 / -2'), A('r2', '7 % -2'), O('q1'), O('r1'), O('q2'), O('r2')],
    inputs: {}, expectedLines: ['-3', '-1', '-3', '1'], finals: {},
  },
];

// ---------------------------------------------------------------------------
// response schemas registry (predict asks / verify items; wire kinds are the
// frozen StructuredResponseItem members — outputLines/variableValues/
// branchTrace/singleChoice/numberWithUnit)
// ---------------------------------------------------------------------------
const registry = {
  registryVersion: 1,
  representationNote:
    'cpp.steps.v1 响应注册表。predict 阶段的作答按 PREDICTION_CARRIER 决定序列化进 recordPrediction.explanation（记录不判分）；verify 阶段逐项进入 learning.submitResponse 的结构化载体。outputString 录入面为逐行结构化数字框（每行一个整数），不是自由文本。',
  schemas: [
    {
      schemaId: 'resp.cpp.u1.trace.v1',
      summary: 'g1 顺序与变量重赋值：预测输出行 + 旧值/新值概念',
      predict: {
        asks: [
          { id: 'ask.g1.output', kind: 'outputLines', prompt: '预测：这张卡会输出什么？（每行一个数）', optionalUncertain: true, maxLines: 8 },
          {
            id: 'ask.g1.total-old-new', kind: 'choice', prompt: '第 4 步「total := total + 4」右边的 total 用的是旧值还是新值？',
            options: [
              { id: 'opt-old', label: '旧值（先算右边再覆盖）' },
              { id: 'opt-new', label: '新值' },
              UNSURE,
            ],
          },
        ],
      },
      verify: {
        items: [
          { kind: 'outputString', quantityId: 'output', prompt: '现在这张卡（完成改动后）的输出是？每行一个数。', maxLines: 8 },
          { kind: 'finalVariables', prompt: '结束时各变量的值是？', variables: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }, { id: 'total', label: 'total' }] },
          {
            kind: 'singleChoice', selectionId: 'sel.g1.total-old-new', prompt: '「total := total + 4」右边的 total 用的是？',
            options: [
              { id: 'opt-old', label: '旧值：右边先算完，再覆盖左边的变量' },
              { id: 'opt-new', label: '新值' },
              UNSURE,
            ],
          },
        ],
      },
    },
    {
      schemaId: 'resp.cpp.u1.divrem.v1',
      summary: 'g2 整数除法与取余：两行输出 + 负数除/余概念',
      predict: {
        asks: [
          { id: 'ask.g2.output', kind: 'outputLines', prompt: '预测：75 颗糖每袋 8 颗，输出两行各是多少？', optionalUncertain: true, maxLines: 8 },
          {
            id: 'ask.g2.quotient', kind: 'choice', prompt: '75 ÷ 8 等于多少（整数除法）？',
            options: [
              { id: 'opt-q9', label: '9' },
              { id: 'opt-q-decimal', label: '9.375' },
              { id: 'opt-q10', label: '10' },
              UNSURE,
            ],
          },
        ],
      },
      verify: {
        items: [
          { kind: 'outputString', quantityId: 'output', prompt: '完成第二问的改动后（每袋 12 颗、100 颗糖），输出两行是？', maxLines: 8 },
          { kind: 'finalVariables', prompt: '结束时各变量的值是？', variables: [{ id: 'n', label: 'n' }, { id: 'k', label: 'k' }, { id: 'bags', label: 'bags' }, { id: 'left', label: 'left' }] },
          {
            kind: 'singleChoice', selectionId: 'sel.g2.neg-div', prompt: '在 C++ 里 (-7) / 2 等于多少？',
            options: [
              { id: 'opt-neg-div-a', label: '-3' },
              { id: 'opt-neg-div-decimal', label: '-3.5' },
              { id: 'opt-neg-div-floor', label: '-4（向负无穷取整）' },
              UNSURE,
            ],
          },
          {
            kind: 'singleChoice', selectionId: 'sel.g2.neg-rem', prompt: '那 (-7) % 2 呢？',
            options: [
              { id: 'opt-neg-rem-sign', label: '-1' },
              { id: 'opt-neg-rem-one', label: '1' },
              UNSURE,
            ],
          },
        ],
      },
    },
    {
      schemaId: 'resp.cpp.u1.branch.v1',
      summary: 'g3 结构化 if 与边界：分支走向 + 反事实概念',
      predict: {
        asks: [
          {
            id: 'ask.g3.branch', kind: 'choice', prompt: 'total 是 47 时，哪个分支会执行？',
            options: [
              { id: 'opt-discount', label: '优惠分支（满 30 减 5）' },
              { id: 'opt-original', label: '原价分支' },
              UNSURE,
            ],
          },
          { id: 'ask.g3.output', kind: 'outputLines', prompt: '预测：这张卡会输出什么？', optionalUncertain: true, maxLines: 8 },
          {
            id: 'ask.g3.counterfactual', kind: 'choice', prompt: '不运行，先猜：如果 total 是 24，pay 会是多少？',
            options: [
              { id: 'opt-19', label: '19' },
              { id: 'opt-24', label: '24' },
              { id: 'opt-29', label: '29' },
              UNSURE,
            ],
          },
        ],
      },
      verify: {
        items: [
          {
            kind: 'branchTrace', prompt: '标记的判断各走了哪边？',
            checkpoints: [{ checkpointId: 'if-1', label: '满 30 判断' }],
            options: [
              { id: 'TAKEN', label: '走了大括号这边（优惠）' },
              { id: 'SKIPPED', label: '跳过了（原价）' },
            ],
          },
          { kind: 'outputString', quantityId: 'output', prompt: '现在这张卡的输出是？', maxLines: 8 },
          { kind: 'finalVariables', prompt: '结束时各变量的值是？', variables: [{ id: 'total', label: 'total' }, { id: 'pay', label: 'pay' }] },
          {
            kind: 'singleChoice', selectionId: 'sel.g3.ge-vs-gt', prompt: '把 >= 改成 >，total 恰好是 30 时会走哪边？',
            options: [
              { id: 'opt-discount', label: '优惠' },
              { id: 'opt-original', label: '原价' },
              UNSURE,
            ],
          },
        ],
      },
    },
    {
      schemaId: 'resp.cpp.u1.loop.v1',
      summary: 'g4 有界 for 与累加：执行次数 + 终值 + while 等价概念',
      predict: {
        asks: [
          { id: 'ask.g4.output', kind: 'outputLines', prompt: '预测：sum 是多少？', optionalUncertain: true, maxLines: 8 },
          {
            id: 'ask.g4.trips', kind: 'choice', prompt: '循环体会执行几次？',
            options: [
              { id: 'opt-4', label: '4 次' },
              { id: 'opt-5', label: '5 次' },
              { id: 'opt-6', label: '6 次' },
              UNSURE,
            ],
          },
        ],
      },
      verify: {
        items: [
          { kind: 'outputString', quantityId: 'output', prompt: '现在这张卡的输出是？（若你在循环体里加了输出，按行数全写）', maxLines: 8 },
          { kind: 'finalVariables', prompt: '结束时各变量的值是？', variables: [{ id: 'sum', label: 'sum' }, { id: 'i', label: 'i' }] },
          { kind: 'numberValue', quantityId: 'g4.trip-count', prompt: '循环体执行了几次？', quantityLabel: '次数' },
          {
            kind: 'singleChoice', selectionId: 'sel.g4.while-equiv', prompt: '冻结卡：i = 1; while (i <= 5) { sum := sum + i; i := i + 1 } 的结果和 for 版？',
            options: [
              { id: 'opt-same', label: '一样' },
              { id: 'opt-diff', label: '不一样' },
              { id: 'opt-forever', label: '不会停' },
              UNSURE,
            ],
          },
        ],
      },
    },
    {
      schemaId: 'resp.cpp.u1.program.v1',
      summary: '构造/修复/读程序复合响应（i1/i2/i3/s1/d1；enabledSegments 按任务启用）',
      predict: {
        asks: [
          { id: 'ask.cpp.output', kind: 'outputLines', prompt: '先预测：这张卡现在运行会输出什么？（每行一个数）', optionalUncertain: true, maxLines: 8, tasks: ['cpp.u1.i1.fix-boundary.v1', 'cpp.u1.i3.build-digits.v1'] },
          { id: 'ask.cpp.oral', kind: 'numberValue', prompt: '先口算猜一个数（记录下来，不判分）：', quantityLabel: '你的猜测', tasks: ['cpp.u1.i2.enum-count.v1', 'cpp.u1.d1.delayed-transfer.v1'] },
          { id: 'ask.cpp.oral2', kind: 'numberValue', prompt: '先口算猜：拍手总次数大约是？', quantityLabel: '次数', tasks: ['cpp.u1.s1.stranger-transfer.v1'] },
          { id: 'ask.cpp.oral3', kind: 'numberValue', prompt: '先口算猜：最后一次拍手的编号大约是？', quantityLabel: '编号', tasks: ['cpp.u1.s1.stranger-transfer.v1'] },
          {
            id: 'ask.i1.where', kind: 'choice', prompt: '你觉得程序错在哪类地方？',
            tasks: ['cpp.u1.i1.fix-boundary.v1'],
            options: [
              { id: 'opt-bound', label: '循环界限' },
              { id: 'opt-oporder', label: '运算符顺序' },
              { id: 'opt-varname', label: '变量名' },
              UNSURE,
            ],
          },
          {
            id: 'ask.i2.div38', kind: 'choice', prompt: '38 是 4 的倍数吗？',
            tasks: ['cpp.u1.i2.enum-count.v1'],
            options: [
              { id: 'opt-yes', label: '是' },
              { id: 'opt-no', label: '不是' },
              UNSURE,
            ],
          },
          {
            id: 'ask.s1.self60', kind: 'choice', prompt: '报数报到 60，60 自己会被拍手吗？',
            tasks: ['cpp.u1.s1.stranger-transfer.v1'],
            options: [
              { id: 'opt-yes', label: '会' },
              { id: 'opt-no', label: '不会' },
              UNSURE,
            ],
          },
          {
            id: 'ask.d1.double7', kind: 'choice', prompt: '编号 277（十位和个位都是 7）会被数几次？',
            tasks: ['cpp.u1.d1.delayed-transfer.v1'],
            options: [
              { id: 'opt-once', label: '1 次' },
              { id: 'opt-twice', label: '2 次' },
              UNSURE,
            ],
          },
        ],
      },
      verify: {
        segments: [
          { id: 'outputAnswer', label: '输出作答', item: { kind: 'outputString', quantityId: 'output', prompt: '程序（修好/补好后）的输出是？每行一个数。', maxLines: 8 } },
          {
            id: 'finalVariables', label: '变量终值', item: {
              kind: 'finalVariables', prompt: '结束时各变量的值是？',
              variables: [{ id: 'sum', label: 'sum' }, { id: 'i', label: 'i' }, { id: 'count', label: 'count' }, { id: 'n', label: 'n' }, { id: 'clapCount', label: 'clapCount' }, { id: 'lastClap', label: 'lastClap' }, { id: 'ones', label: 'ones' }, { id: 'tens', label: 'tens' }, { id: 'hundreds', label: 'hundreds' }],
            },
          },
          { id: 'conceptCheck', label: '概念检查', item: { kind: 'singleChoiceRegistry', prompt: '（按任务登记的选择题，见 bindings 概念段）' } },
        ],
      },
      /** 概念检查的具体选择题按任务登记（verify 段渲染时替换）。 */
      perTaskConcept: {
        'cpp.u1.i1.fix-boundary.v1': {
          kind: 'singleChoice', selectionId: 'sel.i1.missed-loop', prompt: '原来哪一圈被漏掉了？',
          options: [
            { id: 'opt-loop10', label: '第 10 圈（i = 10）' },
            { id: 'opt-loop1', label: '第 1 圈' },
            { id: 'opt-none', label: '没有漏' },
            UNSURE,
          ],
        },
        'cpp.u1.i2.enum-count.v1': {
          kind: 'singleChoice', selectionId: 'sel.i2.range-check', prompt: '枚举 1..40 时，编号范围会漏或多吗？',
          options: [
            { id: 'opt-exact', label: '不重不漏：从 1 到 40 每个都查一次' },
            { id: 'opt-miss40', label: '会漏掉 40' },
            { id: 'opt-extra', label: '会把 41 也查进去' },
            UNSURE,
          ],
        },
        'cpp.u1.i3.build-digits.v1': {
          kind: 'singleChoice', selectionId: 'sel.i3.order-first', prompt: '为什么要先取个位、再除以 10？',
          options: [
            { id: 'opt-shrink-after', label: '先取走个位，除以 10 才轮到十位变成新的个位' },
            { id: 'opt-order-free', label: '顺序无所谓，结果一样' },
            UNSURE,
          ],
        },
        'cpp.u1.s1.stranger-transfer.v1': {
          kind: 'singleChoice', selectionId: 'sel.s1.count-last-diff', prompt: 'clapCount 和 lastClap 两个变量的作用差在哪？',
          options: [
            { id: 'opt-roles-split', label: 'clapCount 记次数，lastClap 记最后一次的编号' },
            { id: 'opt-roles-same', label: '两个记的是同一件事' },
            UNSURE,
          ],
        },
        'cpp.u1.d1.delayed-transfer.v1': {
          kind: 'singleChoice', selectionId: 'sel.d1.or-both', prompt: '「||」两边都成立时（比如 277），计数加几次？',
          options: [
            { id: 'opt-add-once', label: '只加 1 次' },
            { id: 'opt-add-twice', label: '加 2 次' },
            UNSURE,
          ],
        },
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// tasks (public)
// ---------------------------------------------------------------------------
const COMMON_ALLOWED = ['EditStepProgram', 'SetTraceCursor'];
const EXIT_EVIDENCE = ['firstPrediction', 'confirmedOperation', 'submission', 'explanation'];

const stepTableExpr =
  '步骤卡表格：每步一行（赋值/输出/判断/循环），可编辑槽位高亮、键盘可达（Tab 在槽位间移动，Enter 确认编辑）；结构与圆柱场景同一判分接口。';
const stateTraceExpr =
  '变量时间线：每执行步一行（变量→值变化/判断结果/输出行），当前步高亮，输出窗逐行追加；与步骤卡表格光标同步（方向键在两个表达之间移动）。';

const VIS = (over = {}) => ({
  givensProgram: { material: 'givens.program', phases: PHASES_ALL },
  varTable: { material: 'card.var-table', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
  traceControls: { material: 'view.trace-controls', phases: ['OPERATE', 'VERIFY'] },
  outputPane: { material: 'view.output-pane', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'], note: '预测阶段隐藏运行结果' },
  mission: { material: 'card.mission', phases: ['OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'] },
  predictionCompare: { material: 'card.prediction-compare', phases: ['REVIEW'] },
  ...over,
});

const tasks = [
  // ----- g1 -----
  {
    taskId: 'cpp.u1.g1.receipt-trace.v1',
    taskFamily: 'cpp.steps.v1',
    kind: 'GUIDED',
    title: '收银台的三个数',
    prompt: [
      { type: 'TEXT', text: '小店收银台今天记了三笔数：第一件商品 a 是 12 元，第二件 b 是 7 元，先把它们加进 total，再补一笔运费。' },
      { type: 'TEXT', text: '下面的步骤卡（教学模型）会一步一步算账；每一步执行后，右边「变量时间线」会显示变量怎么变。' },
      { type: 'TEXT', text: '先预测：这张卡会输出什么？每行一个数。预测不求正确，也不会被覆盖。' },
    ],
    givens: {
      inputs: {},
      program: [A('a', '12'), A('b', '7'), A('total', 'a + b'), A('total', 'total + 4'), O('total')],
      cursorStep: 0,
    },
    givenLocks: [],
    responseSchemaId: 'resp.cpp.u1.trace.v1',
    allowedOperationIds: COMMON_ALLOWED,
    operationConstraints: [
      {
        type: 'StepProgram',
        editableSlots: ['step[3].expr'],
        insertableKinds: ['OUTPUT'],
        deletableSteps: [],
        maxProgramSteps: 8,
        maxOutputLines: 8,
      },
    ],
    visibility: Object.values(VIS()),
    mission: '动手任务：① 把第 4 步里的 4 改成 6；② 在最后一条输出前面插入一行「输出 a」。每改一处先单步观察变量时间线，再继续。',
    hints: [
      { level: 1, label: '重述题意', text: '两件商品 12 元和 7 元，先加起来，再补运费；一步一步看变量表。' },
      { level: 2, label: '概念提示', text: '赋值是右边先算完，再覆盖左边的变量。' },
      { level: 3, label: '策略提示', text: '单步到第 4 步，看 total 变化前后两行分别是多少。' },
      { level: 4, label: '答案级提示（会记录答案帮助）', revealsAnswer: true },
    ],
    explain: {
      selections: [
        {
          itemId: 'explain.g1.assign-order',
          prompt: '为什么「total := total + 4」不会自相矛盾？',
          options: [
            { id: 'opt-right-first', label: '右边先用旧的 total 算出得数，再覆盖左边' },
            { id: 'opt-right-new', label: '右边直接用新值' },
            { id: 'opt-loop', label: '会无限循环' },
            UNSURE,
          ],
        },
      ],
      freeTextPrompt: '用自己的话说一说：第 4 步执行时到底发生了什么？',
    },
    exitEvidence: EXIT_EVIDENCE,
    expressions: { stepTable: stepTableExpr, stateTrace: stateTraceExpr },
  },
  // ----- g2 -----
  {
    taskId: 'cpp.u1.g2.pack-sweets.v1',
    taskFamily: 'cpp.steps.v1',
    kind: 'GUIDED',
    title: '分装糖果',
    prompt: [
      { type: 'TEXT', text: '店里进了 75 颗糖，每袋装 8 颗。bags 是装满的袋数，left 是剩下的颗数。' },
      { type: 'FORMULA', expression: 'bags := n / k （整数除法：只取装满的整数袋）' },
      { type: 'FORMULA', expression: 'left := n % k （取余：装不完剩下的颗数）' },
      { type: 'TEXT', text: '先预测两行输出；再把 n 改成 100（每袋仍是 8 颗）看一看；最后完成第二问：每袋装 12 颗、100 颗糖，输出两行各是多少？' },
    ],
    givens: {
      inputs: {},
      program: [A('n', '75'), A('k', '8'), A('bags', 'n / k'), A('left', 'n % k'), O('bags'), O('left')],
      cursorStep: 0,
    },
    givenLocks: [],
    responseSchemaId: 'resp.cpp.u1.divrem.v1',
    allowedOperationIds: COMMON_ALLOWED,
    operationConstraints: [
      {
        type: 'StepProgram',
        editableSlots: ['step[0].expr', 'step[1].expr'],
        slotDomains: { 'step[0].expr': [75, 100], 'step[1].expr': [8, 12] },
        insertableKinds: [],
        deletableSteps: [],
        maxProgramSteps: 8,
        maxOutputLines: 8,
      },
    ],
    visibility: Object.values(VIS()),
    mission: '动手任务：① 把 n 从 75 改成 100（每袋仍是 8），单步看两行输出；② 再把 k 改成 12，完成第二问。',
    hints: [
      { level: 1, label: '重述题意', text: '75 颗糖每袋装 8 颗：装满几袋、剩几颗。' },
      { level: 2, label: '概念提示', text: '/ 只取装满的整数袋，剩下的用 %。' },
      { level: 3, label: '策略提示', text: '用乘法回头验：8×9=72，75−72=3。' },
      { level: 4, label: '答案级提示（会记录答案帮助）', revealsAnswer: true },
    ],
    explain: {
      selections: [
        {
          itemId: 'explain.g2.why-not-10',
          prompt: '75 颗为什么不是装 10 袋？',
          options: [
            { id: 'opt-notenough', label: '装满 9 袋后余 3 颗，不够再装满一袋' },
            { id: 'opt-used72', label: '9 袋只用 72 颗（这是验证，不是原因）' },
            { id: 'opt-round', label: '四舍五入应该是 9 或 10' },
            UNSURE,
          ],
        },
      ],
      freeTextPrompt: '写出一个 bags 和 left 都满足的等式（用 n 和 k 表示）。',
    },
    exitEvidence: EXIT_EVIDENCE,
    expressions: { stepTable: stepTableExpr, stateTrace: stateTraceExpr },
  },
  // ----- g3 -----
  {
    taskId: 'cpp.u1.g3.member-discount.v1',
    taskFamily: 'cpp.steps.v1',
    kind: 'GUIDED',
    title: '会员价的边界',
    prompt: [
      { type: 'TEXT', text: '小店满 30 元减 5 元。收银台程序用一条判断决定走哪边：满足条件走大括号里的优惠价，否则走另一边按原价。' },
      { type: 'FORMULA', expression: 'total >= 30 满足时：pay := total - 5；否则 pay := total' },
      { type: 'TEXT', text: '先预测输出；再动手验证边界：把 total 改成 30，看看「>=」把恰好 30 归到了哪边。' },
    ],
    givens: {
      inputs: {},
      program: [A('total', '47'), IF('total >= 30', [A('pay', 'total - 5')], [A('pay', 'total')], 'if-1'), O('pay')],
      cursorStep: 0,
    },
    givenLocks: [],
    responseSchemaId: 'resp.cpp.u1.branch.v1',
    allowedOperationIds: COMMON_ALLOWED,
    operationConstraints: [
      {
        type: 'StepProgram',
        editableSlots: ['step[0].expr', 'step[1].cond'],
        slotDomains: { 'step[0].expr': [24, 30, 47] },
        insertableKinds: [],
        deletableSteps: [],
        maxProgramSteps: 8,
        maxOutputLines: 8,
      },
    ],
    visibility: Object.values(VIS()),
    mission: '动手任务：① 把 total 改成 30，单步看走进哪个大括号；② 再把条件里的 >= 改成 > 对照：恰好 30 时走哪边？',
    hints: [
      { level: 1, label: '重述题意', text: '满 30 减 5；现在买了 47 元的东西。' },
      { level: 2, label: '概念提示', text: 'total >= 30 包含「恰好 30」这个点；total > 30 不包含。' },
      { level: 3, label: '策略提示', text: '把 total 改成 30，单步看走进哪个大括号。' },
      { level: 4, label: '答案级提示（会记录答案帮助）', revealsAnswer: true },
    ],
    explain: {
      selections: [
        {
          itemId: 'explain.g3.ge-gt-diff',
          prompt: '「>=」和「>」差在哪？',
          options: [
            { id: 'opt-boundary-in', label: '差在恰好等于的那个点：>= 把它归进优惠，> 把它排除' },
            { id: 'opt-same-thing', label: '没有差别' },
            UNSURE,
          ],
        },
      ],
      freeTextPrompt: '举一个让两种写法结果不同的 total 值，并说说那时的输出。',
    },
    exitEvidence: EXIT_EVIDENCE,
    expressions: { stepTable: stepTableExpr, stateTrace: stateTraceExpr },
  },
  // ----- g4 -----
  {
    taskId: 'cpp.u1.g4.sales-sum.v1',
    taskFamily: 'cpp.steps.v1',
    kind: 'GUIDED',
    title: '五天销售额',
    prompt: [
      { type: 'TEXT', text: '小店连续 5 天记账：每天存进收银台的钱正好是第几天（第 1 天存 1 元，第 2 天存 2 元……）。程序用一条有界循环把它们累加。' },
      { type: 'FORMULA', expression: 'for (i = 1; i <= 5; i = i + 1) { sum := sum + i } （步长固定 +1，只读展示）' },
      { type: 'TEXT', text: '先预测：sum 是多少？循环体会执行几次？退出循环时 i 是几？' },
    ],
    givens: {
      inputs: {},
      program: [A('sum', '0'), FOR('i', '1', '5', '<=', [A('sum', 'sum + i')]), O('sum')],
      cursorStep: 0,
    },
    givenLocks: [],
    responseSchemaId: 'resp.cpp.u1.loop.v1',
    allowedOperationIds: COMMON_ALLOWED,
    operationConstraints: [
      {
        type: 'StepProgram',
        editableSlots: ['step[1].bound', 'step[1].cmp'],
        slotDomains: { 'step[1].bound': [5, 10, 100] },
        insertableKinds: ['OUTPUT'],
        deletableSteps: [],
        maxProgramSteps: 12,
        maxOutputLines: 8,
      },
    ],
    visibility: Object.values(VIS()),
    mission: '动手任务：① 单步走完一圈，数一数循环体执行几次、退出时 i 是几；② 把上界改成 100，体会手算和循环的差别（输出窗最多 8 行，别在循环体里加输出时把上界改太大）；③ 在循环体里插入一行「输出 i」，看输出怎么变，再撤回或保留由你。',
    hints: [
      { level: 1, label: '重述题意', text: '连续 5 天，每天存的钱正好是第几天，最后 total 是多少。' },
      { level: 2, label: '概念提示', text: 'sum 从 0 开始，每圈加一次 i。' },
      { level: 3, label: '策略提示', text: '单步看 i=5 那一圈走完后，判定再失败才退出——这时 i 是几？' },
      { level: 4, label: '答案级提示（会记录答案帮助）', revealsAnswer: true },
    ],
    explain: {
      selections: [
        {
          itemId: 'explain.g4.exit-i',
          prompt: '循环退出后 i 是多少？为什么？',
          options: [
            { id: 'opt-i6', label: '6：i=5 那圈走完后 i 变成 6，判定 6<=5 不成立才退出' },
            { id: 'opt-i5', label: '5：最后一圈用的就是它' },
            { id: 'opt-i4', label: '4' },
            UNSURE,
          ],
        },
      ],
      freeTextPrompt: '如果 while 版忘了写「i := i + 1」会发生什么？（教学模型里会怎么表现？）',
    },
    exitEvidence: EXIT_EVIDENCE,
    expressions: { stepTable: stepTableExpr, stateTrace: stateTraceExpr },
  },
  // ----- i1 -----
  {
    taskId: 'cpp.u1.i1.fix-boundary.v1',
    taskFamily: 'cpp.steps.v1',
    kind: 'INDEPENDENT',
    title: '货架编号之和（修边界）',
    prompt: [
      { type: 'TEXT', text: '店长要 1 到 10 号货架的编号数字之和。收银台的程序算出了 45，店长说应该是 55。' },
      { type: 'TEXT', text: '先预测：现在这张卡会输出多少？再找出程序错在哪里，修好它。' },
      { type: 'TEXT', text: '注意：提交后服务端还会用另一组货架编号复跑你的程序——可见这一问对了不算完成。' },
    ],
    givens: {
      inputs: { n: 10 },
      program: [A('sum', '0'), FOR('i', '1', 'n', '<', [A('sum', 'sum + i')]), O('sum')],
      cursorStep: 0,
    },
    givenLocks: [],
    responseSchemaId: 'resp.cpp.u1.program.v1',
    allowedOperationIds: COMMON_ALLOWED,
    operationConstraints: [
      {
        type: 'StepProgram',
        editableSlots: ['step[1].cmp', 'step[1].bound'],
        insertableKinds: [],
        deletableSteps: [],
        maxProgramSteps: 12,
        maxOutputLines: 8,
      },
    ],
    visibility: Object.values(VIS()),
    mission: '独立任务：只允许改循环头（中间的比较条件、右边的界限）。修好后提交；想想怎么向店长证明真的修好了。',
    hints: [
      { level: 1, label: '重述题意', text: '目标是 1 加到 10；程序从 1 开始，最后一圈加到了几？' },
      { level: 2, label: '概念提示', text: 'i < 10 在 i=10 时还进循环吗？' },
      { level: 3, label: '策略提示', text: '单步数一共加了几次，最后一次加的是几。' },
      { level: 4, label: '答案级提示（会记录答案帮助）', revealsAnswer: true },
    ],
    explain: {
      selections: [
        {
          itemId: 'explain.i1.lt-lte',
          prompt: '在这道题里，「<」和「<=」的差别是什么？',
          options: [
            { id: 'opt-last-in', label: '<= 把最后一圈 i=n 也放进来，< 在 i=n 时提前退出' },
            { id: 'opt-no-diff', label: '没有差别' },
            UNSURE,
          ],
        },
      ],
      freeTextPrompt: '怎么向店长证明程序修好了？（提示：只跑一个 n 够吗？）',
    },
    exitEvidence: EXIT_EVIDENCE,
    expressions: { stepTable: stepTableExpr, stateTrace: stateTraceExpr },
  },
  // ----- i2 -----
  {
    taskId: 'cpp.u1.i2.enum-count.v1',
    taskFamily: 'cpp.steps.v1',
    kind: 'INDEPENDENT',
    title: '清点 4 的倍数',
    prompt: [
      { type: 'TEXT', text: '清点 1 到 40 号商品里，编号是 4 的倍数的有几件。程序已经搭好了循环和计数，但判断条件写错了。' },
      { type: 'TEXT', text: '先口算猜一个数（记录不判分），再把条件修对，让程序逐个编号检查。' },
      { type: 'TEXT', text: '注意：提交后服务端还会换编号范围复跑（比如数 1..4，甚至 1..0）。' },
    ],
    givens: {
      inputs: { n: 40 },
      program: [
        A('count', '0'),
        FOR('i', '1', 'n', '<=', [IF('i % 4 == 4', [A('count', 'count + 1')], [])]),
        O('count'),
      ],
      cursorStep: 0,
    },
    givenLocks: [],
    responseSchemaId: 'resp.cpp.u1.program.v1',
    allowedOperationIds: COMMON_ALLOWED,
    operationConstraints: [
      {
        type: 'StepProgram',
        editableSlots: ['step[1].body[0].cond'],
        insertableKinds: [],
        deletableSteps: [],
        maxProgramSteps: 12,
        maxOutputLines: 8,
      },
    ],
    visibility: Object.values(VIS()),
    mission: '独立任务：只允许改循环体里那个判断条件。想想：一个数除以 4，余数是多少才算 4 的倍数？',
    hints: [
      { level: 1, label: '重述题意', text: '挨个编号问一句：除以 4 余 0 吗？是就数进去。' },
      { level: 2, label: '概念提示', text: '倍数判断用 %；数到了就让 count 加 1。注意 == 是比较，= 是赋值。' },
      { level: 3, label: '策略提示', text: '先手数 1..12 里 4 的倍数有几个，对照程序输出。' },
      { level: 4, label: '答案级提示（会记录答案帮助）', revealsAnswer: true },
    ],
    explain: {
      selections: [
        {
          itemId: 'explain.i2.where-count',
          prompt: '「count := count + 1」要放在哪里才能只数倍数？',
          options: [
            { id: 'opt-in-if', label: '放在判断「是 4 的倍数」的大括号里，每圈只在满足时执行' },
            { id: 'opt-in-loop', label: '直接放在循环体里，每圈都数' },
            UNSURE,
          ],
        },
      ],
      freeTextPrompt: '「40 ÷ 4 直接算」和「从 1 到 40 逐个枚举」各有什么好处？',
    },
    exitEvidence: EXIT_EVIDENCE,
    expressions: { stepTable: stepTableExpr, stateTrace: stateTraceExpr },
  },
  // ----- i3 -----
  {
    taskId: 'cpp.u1.i3.build-digits.v1',
    taskFamily: 'cpp.steps.v1',
    kind: 'INDEPENDENT',
    title: '价签的三位数',
    prompt: [
      { type: 'TEXT', text: '三位数价签 358：程序要把个位、十位、百位分三行输出。这张卡被打乱过，还缺了一步。' },
      { type: 'FORMULA', expression: '%10 取最末位；/10 砍掉最末位' },
      { type: 'TEXT', text: '先预测：现在这张（乱序缺步的）卡会输出什么？再把顺序整理对、补上缺的那一步。' },
    ],
    givens: {
      inputs: { n: 358 },
      program: [
        A('n', 'n / 10'),
        A('ones', 'n % 10'),
        A('tens', 'n % 10'),
        A('hundreds', 'n % 10'),
        O('ones'),
        O('tens'),
        O('hundreds'),
      ],
      cursorStep: 0,
    },
    givenLocks: [],
    responseSchemaId: 'resp.cpp.u1.program.v1',
    allowedOperationIds: COMMON_ALLOWED,
    operationConstraints: [
      {
        type: 'StepProgram',
        editableSlots: [],
        insertableKinds: ['ASSIGN'],
        deletableSteps: [0],
        maxProgramSteps: 12,
        maxOutputLines: 8,
      },
    ],
    visibility: Object.values(VIS()),
    mission: '独立任务：可以删除第 1 行（它放错了位置），也可以插入一条赋值语句。目标：输出 8、5、3 三行，且结束时 n 是 3。',
    hints: [
      { level: 1, label: '重述题意', text: '358 里个位是 8；程序里怎么把 8 单独拿出来？' },
      { level: 2, label: '概念提示', text: '%10 取最末位，/10 砍掉最末位。' },
      { level: 3, label: '策略提示', text: '先在纸上写：358 → 35 → 3，每一步用哪个运算、取到的是哪一位。' },
      { level: 4, label: '答案级提示（会记录答案帮助）', revealsAnswer: true },
    ],
    explain: {
      selections: [
        {
          itemId: 'explain.i3.shrink-first',
          prompt: '如果先「n := n / 10」再取个位，358 会输出什么？',
          options: [
            { id: 'opt-lose-ones', label: '个位 8 先被砍掉，取到的是 5（顺序错了就丢位）' },
            { id: 'opt-same', label: '还是 8、5、3，顺序没关系' },
            UNSURE,
          ],
        },
      ],
      freeTextPrompt: '三位数中间是 0 时（比如 207），你的程序还工作吗？为什么？',
    },
    exitEvidence: EXIT_EVIDENCE,
    expressions: { stepTable: stepTableExpr, stateTrace: stateTraceExpr },
  },
  // ----- s1 -----
  {
    taskId: 'cpp.u1.s1.stranger-transfer.v1',
    taskFamily: 'cpp.steps.v1',
    kind: 'STRANGER',
    title: '体育课报数（综合）',
    prompt: [
      { type: 'TEXT', text: '换到体育课：全班从 1 到 60 报数，逢 3 的倍数就拍手一次。程序要输出两行：拍手总次数、最后一次拍手的编号。' },
      { type: 'TEXT', text: '卡里已经有循环、判断和两个记录变量，但条件不对，而且「记下最后一次编号」那一步还没有写。' },
      { type: 'TEXT', text: '先口算猜两个数（记录不判分），再把程序补对。' },
    ],
    givens: {
      inputs: { n: 60 },
      program: [
        A('clapCount', '0'),
        A('lastClap', '0'),
        FOR('i', '1', 'n', '<=', [IF('i % 3 == 3', [A('clapCount', 'clapCount + 1')], [])]),
        O('clapCount'),
        O('lastClap'),
      ],
      cursorStep: 0,
    },
    givenLocks: [],
    responseSchemaId: 'resp.cpp.u1.program.v1',
    allowedOperationIds: COMMON_ALLOWED,
    operationConstraints: [
      {
        type: 'StepProgram',
        editableSlots: ['step[2].body[0].cond'],
        insertableKinds: ['ASSIGN'],
        deletableSteps: [],
        maxProgramSteps: 20,
        maxOutputLines: 8,
      },
    ],
    visibility: Object.values(VIS()),
    mission: '陌生任务：修对判断条件，并在拍手的大括号里补一条赋值，把当前编号记进 lastClap。机制和清点商品一样——数数 + 记录。',
    hints: [
      { level: 1, label: '重述题意', text: '报数从 1 到 60，凡是 3 的倍数就拍手。' },
      { level: 2, label: '概念提示', text: '拍手时同时做两件事：次数加一、记下当前编号。' },
      { level: 3, label: '策略提示', text: '先手数 1..12 的拍手次数，对照程序。' },
      { level: 4, label: '答案级提示（会记录答案帮助）', revealsAnswer: true },
    ],
    explain: {
      selections: [
        {
          itemId: 'explain.s1.no-miss',
          prompt: '怎么确认一个都没漏数？',
          options: [
            { id: 'opt-step-check', label: '单步看每一圈：判断满足时两件事都做了；退出前最后一圈也查过' },
            { id: 'opt-guess', label: '凭感觉差不多就行' },
            UNSURE,
          ],
        },
      ],
      freeTextPrompt: '把范围改成 1 到 25：你的程序哪些地方不用改？哪一处要改？',
    },
    exitEvidence: EXIT_EVIDENCE,
    expressions: { stepTable: stepTableExpr, stateTrace: stateTraceExpr },
  },
  // ----- d1 -----
  {
    taskId: 'cpp.u1.d1.delayed-transfer.v1',
    taskFamily: 'cpp.steps.v1',
    kind: 'DELAYED_TRANSFER',
    title: '储物室里藏 7 的柜子（延迟迁移）',
    prompt: [
      { type: 'TEXT', text: '储物室的柜子编号从 lo 到 hi（现在是 260 到 299）。要数编号里含有数字 7 的柜子：十位是 7，或者个位是 7。' },
      { type: 'FORMULA', expression: '十位：i / 10 % 10；个位：i % 10；满足任意一个就算：||' },
      { type: 'TEXT', text: '卡里的条件只查了十位。把它补成「十位是 7 或个位是 7」。先口算猜一个数（记录不判分），再改对提交。' },
    ],
    givens: {
      inputs: { lo: 260, hi: 299 },
      program: [
        A('count', '0'),
        FOR('i', 'lo', 'hi', '<=', [IF('i / 10 % 10 == 7', [A('count', 'count + 1')], [])]),
        O('count'),
      ],
      cursorStep: 0,
    },
    givenLocks: [],
    responseSchemaId: 'resp.cpp.u1.program.v1',
    allowedOperationIds: COMMON_ALLOWED,
    operationConstraints: [
      {
        type: 'StepProgram',
        editableSlots: ['step[1].body[0].cond'],
        insertableKinds: [],
        deletableSteps: [],
        maxProgramSteps: 20,
        maxOutputLines: 8,
      },
    ],
    visibility: Object.values(VIS()),
    mission: '回看练习：只允许改判断条件。注意 277 十位和个位都是 7——它只能被数一次。',
    hints: [
      { level: 1, label: '重述题意', text: '编号 260 到 299，看十位和个位有没有 7。' },
      { level: 2, label: '概念提示', text: '十位用 i/10%10，个位用 i%10；满足任意一个就算，用 || 连起来。' },
      { level: 3, label: '策略提示', text: '先手数 270–279 有几个，再看个位是 7 的，最后想想重叠的。' },
      { level: 4, label: '答案级提示（会记录答案帮助）', revealsAnswer: true },
    ],
    explain: {
      selections: [
        {
          itemId: 'explain.d1.or-to-and',
          prompt: '把「||」换成「&&」，答案会变吗？',
          options: [
            { id: 'opt-and-shrink', label: '会变：&& 要求十位和个位同时是 7，只剩 277 一个' },
            { id: 'opt-and-same', label: '不会变' },
            UNSURE,
          ],
        },
      ],
      freeTextPrompt: '为什么 277 只被数一次？',
    },
    exitEvidence: EXIT_EVIDENCE,
    expressions: { stepTable: stepTableExpr, stateTrace: stateTraceExpr },
  },
];

// ---------------------------------------------------------------------------
// lessons
// ---------------------------------------------------------------------------
const lessons = {
  lessonsVersion: '1',
  lessons: [
    {
      lessonId: 'cpp.u1.basics',
      releaseId: RELEASE,
      title: 'GESP 2 · 第 1 单元：顺序、分支与有界循环',
      taskFamily: 'cpp.steps.v1',
      taskOrder: [
        'cpp.u1.g1.receipt-trace.v1',
        'cpp.u1.g2.pack-sweets.v1',
        'cpp.u1.g3.member-discount.v1',
        'cpp.u1.g4.sales-sum.v1',
        'cpp.u1.i1.fix-boundary.v1',
        'cpp.u1.i2.enum-count.v1',
        'cpp.u1.i3.build-digits.v1',
        'cpp.u1.s1.stranger-transfer.v1',
      ],
      delayedTransferTaskId: 'cpp.u1.d1.delayed-transfer.v1',
      delayedTransferWindowDays: { availableAfterDays: 7, nominalEndDays: 14 },
      note: '对 GESP 2 仅作部分能力关联（分支、循环、整数运算、枚举模拟的结构练习）；本单元不构成任何等级达成或资格表述，考级报名与衔接按当年官方规则另行核对。',
    },
  ],
};

// ---------------------------------------------------------------------------
// private rules (STEP_TASK_TRUTH) — expected values from HAND_CHECK_TABLE
// ---------------------------------------------------------------------------
const TRACE_RULE_ID = 'rule.cppU1.trace.v1';
const BRANCH_RULE_ID = 'rule.cppU1.branch.v1';
const PROGRAM_RULE_ID = 'rule.cppU1.program.v1';

const traceRule = {
  ruleId: TRACE_RULE_ID,
  ruleVersion: '1',
  body: {
    kind: 'STEP_TASK_TRUTH',
    stepBudget: 200,
    entries: {
    'cpp.u1.g1.receipt-trace.v1': {
      visibleCase: { caseId: 'g1-canonical', inputs: {}, expectedLines: ['25', '12'] },
      hiddenCases: [],
      conceptChecks: [{ selectionId: 'sel.g1.total-old-new', correctOptionId: 'opt-old' }],
      judging: { outputSource: 'SNAPSHOT_RERUN' },
      feedback: { reviseGeneric: '逐行核对：每行来自一条输出语句；再单步看一遍变量时间线。' },
    },
    'cpp.u1.g2.pack-sweets.v1': {
      visibleCase: { caseId: 'g2-second-question', inputs: {}, expectedLines: ['8', '4'] },
      hiddenCases: [],
      conceptChecks: [
        { selectionId: 'sel.g2.neg-div', correctOptionId: 'opt-neg-div-a' },
        { selectionId: 'sel.g2.neg-rem', correctOptionId: 'opt-neg-rem-sign' },
      ],
      judging: { outputSource: 'AUTHORED' },
      diagnostics: {
        divRounding: '整数除法不是四舍五入，也不出小数：/ 只取装满的整数份，余数用 %。负数的除和余按 C++ 规则：商向 0 取整，余数符号跟被除数。',
      },
      feedback: { reviseGeneric: '先检查改动是否完成（n=100、k=12），再逐行核对输出。' },
    },
    'cpp.u1.g4.sales-sum.v1': {
      visibleCase: { caseId: 'g4-canonical', inputs: {}, expectedLines: ['15'] },
      hiddenCases: [],
      numberChecks: [{ itemId: 'g4.trip-count', expected: 5 }],
      conceptChecks: [{ selectionId: 'sel.g4.while-equiv', correctOptionId: 'opt-same' }],
      judging: { outputSource: 'SNAPSHOT_RERUN' },
      feedback: { reviseGeneric: '按当前卡片逐行核对输出；执行次数和退出值都能从时间线里数出来。' },
    },
  },
  },
};

const branchRule = {
  ruleId: BRANCH_RULE_ID,
  ruleVersion: '1',
  body: {
    kind: 'STEP_TASK_TRUTH',
    stepBudget: 200,
    entries: {
    'cpp.u1.g3.member-discount.v1': {
      visibleCase: { caseId: 'g3-canonical', inputs: {}, expectedLines: ['42'] },
      hiddenCases: [],
      branchCheckpoints: [{ checkpointId: 'if-1', expected: 'TAKEN' }],
      conceptChecks: [{ selectionId: 'sel.g3.ge-vs-gt', correctOptionId: 'opt-original' }],
      judging: { outputSource: 'SNAPSHOT_RERUN' },
      feedback: { reviseGeneric: '回到单步：判断那一行走进的是哪个大括号，输出和变量终值跟当前卡片对。' },
    },
  },
  },
};

const programRule = {
  ruleId: PROGRAM_RULE_ID,
  ruleVersion: '1',
  body: {
    kind: 'STEP_TASK_TRUTH',
    stepBudget: 200,
    entries: {
    'cpp.u1.i1.fix-boundary.v1': {
      visibleCase: { caseId: 'i1-F1', inputs: { n: 10 }, expectedLines: ['55'] },
      hiddenCases: [{ caseId: 'i1-EXB', inputs: { n: 20 }, expectedLines: ['210'] }],
      conceptChecks: [{ selectionId: 'sel.i1.missed-loop', correctOptionId: 'opt-loop10' }],
      structural: { requiredConstructs: ['FOR'], maxProgramSteps: 12, maxOutputLines: 8 },
      judging: { outputSource: 'AUTHORED' },
      diagnostics: {
        offByOneBound: '再看一眼循环的界限：最后该进循环的那一圈，进去了吗？',
        samplePassedHiddenFailed: '可见这一问对了，换一组编号复跑就不对——再检查循环到不到 n、从几开始。',
      },
    },
    'cpp.u1.i2.enum-count.v1': {
      visibleCase: { caseId: 'i2-F1', inputs: { n: 40 }, expectedLines: ['10'] },
      hiddenCases: [
        { caseId: 'i2-H0', inputs: { n: 0 }, expectedLines: ['0'] },
        { caseId: 'i2-H4', inputs: { n: 4 }, expectedLines: ['1'] },
      ],
      conceptChecks: [{ selectionId: 'sel.i2.range-check', correctOptionId: 'opt-exact' }],
      structural: { requiredConstructs: ['FOR', 'IF'], maxProgramSteps: 12, maxOutputLines: 8 },
      judging: { outputSource: 'AUTHORED' },
      diagnostics: {
        samplePassedHiddenFailed: '可见这问对了，换个编号范围就不对——再检查循环到不到 n、从几开始（n=0 时一次都不该数）。',
      },
    },
    'cpp.u1.i3.build-digits.v1': {
      visibleCase: { caseId: 'i3-F1', inputs: { n: 358 }, expectedLines: ['8', '5', '3'] },
      hiddenCases: [{ caseId: 'i3-H0', inputs: { n: 207 }, expectedLines: ['7', '0', '2'] }],
      conceptChecks: [{ selectionId: 'sel.i3.order-first', correctOptionId: 'opt-shrink-after' }],
      structural: { requiredConstructs: [], maxProgramSteps: 12, maxOutputLines: 8 },
      judging: { outputSource: 'AUTHORED' },
      feedback: { reviseGeneric: '按 358→35→3 的顺序检查：每一步先取位再缩小，结束时 n 应该是 3。' },
    },
    'cpp.u1.s1.stranger-transfer.v1': {
      visibleCase: { caseId: 's1-F1', inputs: { n: 60 }, expectedLines: ['20', '60'] },
      hiddenCases: [{ caseId: 's1-H25', inputs: { n: 25 }, expectedLines: ['8', '24'] }],
      conceptChecks: [{ selectionId: 'sel.s1.count-last-diff', correctOptionId: 'opt-roles-split' }],
      structural: { requiredConstructs: ['FOR', 'IF'], maxProgramSteps: 20, maxOutputLines: 8 },
      judging: { outputSource: 'AUTHORED' },
      diagnostics: {
        samplePassedHiddenFailed: '可见这问对了，换个报数范围就不对——检查条件两件事是否都在拍手的大括号里。',
      },
    },
    'cpp.u1.d1.delayed-transfer.v1': {
      visibleCase: { caseId: 'd1-F1', inputs: { lo: 260, hi: 299 }, expectedLines: ['13'] },
      hiddenCases: [{ caseId: 'd1-H289', inputs: { lo: 260, hi: 289 }, expectedLines: ['12'] }],
      conceptChecks: [{ selectionId: 'sel.d1.or-both', correctOptionId: 'opt-add-once' }],
      structural: { requiredConstructs: ['FOR', 'IF'], maxProgramSteps: 20, maxOutputLines: 8 },
      judging: { outputSource: 'AUTHORED' },
      feedback: { reviseGeneric: '两个位都查了吗？重叠的编号只数一次。' },
    },
  },
  },
};

const rules = [traceRule, branchRule, programRule];

// ---------------------------------------------------------------------------
// private frozen instances + answer hints
// ---------------------------------------------------------------------------
const instances = [
  {
    taskId: 'cpp.u1.i1.fix-boundary.v1',
    file: 'cpp.u1.i1.v1-instances.json',
    frozen: [
      {
        instanceId: 'i1-F1',
        inputs: { n: 10 },
        truth: { bugLines: ['45'], fixedLines: ['55'], finalSum: 55, finalI: 11, fix: 'cmp < -> <=' },
        answerHint: '把「<」改成「<=」，第 10 圈也会被加上：1 加到 10 等于 55。',
      },
      {
        instanceId: 'i1-EXB',
        inputs: { n: 20 },
        truth: { bugLines: ['190'], fixedLines: ['210'] },
        answerHint: '换 20 号货架：1 加到 20 等于 210。',
      },
    ],
  },
  {
    taskId: 'cpp.u1.i2.enum-count.v1',
    file: 'cpp.u1.i2.v1-instances.json',
    frozen: [
      { instanceId: 'i2-F1', inputs: { n: 40 }, truth: { answerLines: ['10'], cond: 'i % 4 == 0' }, answerHint: '条件改成「i % 4 == 0」，count 输出 10。' },
      { instanceId: 'i2-H0', inputs: { n: 0 }, truth: { answerLines: ['0'] }, answerHint: 'n=0 时循环一次都不执行，count 还是 0。' },
      { instanceId: 'i2-H4', inputs: { n: 4 }, truth: { answerLines: ['1'] }, answerHint: 'n=4 时只有 4 这一个编号满足。' },
    ],
  },
  {
    taskId: 'cpp.u1.i3.build-digits.v1',
    file: 'cpp.u1.i3.v1-instances.json',
    frozen: [
      { instanceId: 'i3-F1', inputs: { n: 358 }, truth: { answerLines: ['8', '5', '3'], finalN: 3 }, answerHint: '正确顺序：先取个位 8，再 358→35 取 5，再 35→3 取 3；输出 8、5、3，结束时 n=3。' },
      { instanceId: 'i3-H0', inputs: { n: 207 }, truth: { answerLines: ['7', '0', '2'], finalN: 2 }, answerHint: '中间是 0 也照取：7、0、2。' },
    ],
  },
  {
    taskId: 'cpp.u1.s1.stranger-transfer.v1',
    file: 'cpp.u1.s1.v1-instances.json',
    frozen: [
      { instanceId: 's1-F1', inputs: { n: 60 }, truth: { answerLines: ['20', '60'] }, answerHint: '60 以内 3 的倍数有 20 个，最后一个是 60。' },
      { instanceId: 's1-H25', inputs: { n: 25 }, truth: { answerLines: ['8', '24'] }, answerHint: '25 以内 3 的倍数：3,6,…,24，共 8 个，最后是 24。' },
    ],
  },
  {
    taskId: 'cpp.u1.d1.delayed-transfer.v1',
    file: 'cpp.u1.d1.v1-instances.json',
    frozen: [
      { instanceId: 'd1-F1', inputs: { lo: 260, hi: 299 }, truth: { answerLines: ['13'] }, answerHint: '十位 7 的 270–279 共 10 个；个位 7 的 267、277、287、297 共 4 个；277 重叠只数一次：13 个。' },
      { instanceId: 'd1-H289', inputs: { lo: 260, hi: 289 }, truth: { answerLines: ['12'] }, answerHint: '到 289 为止：270–279 共 10 个；个位 7 的 267、277、287 共 3 个；277 重叠：12 个。' },
    ],
  },
];

// guided tasks: static answer hints (private)
const staticAnswerHints = {
  'cpp.u1.g1.receipt-trace.v1': '运费 6 之后 total=19+6=25；再输出 a=12：两行 25、12。',
  'cpp.u1.g2.pack-sweets.v1': '第一问 100÷8：商 12 余 4；第二问 100÷12：商 8 余 4，输出 8、4。',
  'cpp.u1.g3.member-discount.v1': '47≥30 走优惠，pay=42；total=30 时「>=」仍走优惠（pay=25），换成「>」才走原价（pay=30）。',
  'cpp.u1.g4.sales-sum.v1': '1+2+3+4+5=15；循环体 5 次；退出时 i=6。上界 100 时是 5050。',
};

// ---------------------------------------------------------------------------
// emit helpers
// ---------------------------------------------------------------------------
function writeJson(path, value) {
  mkdirSync(join(OUT, path, '..'), { recursive: true });
  writeFileSync(join(OUT, path), JSON.stringify(value, null, 2) + '\n');
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

// emit content/cpp tree
writeJson('public/schemas/response-schemas.registry.json', registry);
writeJson('public/lessons.json', lessons);
for (const t of tasks) {
  const file = { ...t, taskVersion: TASK_VERSION };
  writeJson(`public/tasks/${t.taskId}.json`, file);
}
for (const inst of instances) writeJson(`private/instances/${inst.file}`, { frozen: inst.frozen });
for (const rule of rules) writeJson(`private/rules/${rule.ruleId}.json`, rule);
writeJson('private/rules/hand-check-table.json', {
  note: '12 组期望值手算复核表（UNIT-SPEC §4；tests/cpp/engine.test.ts 逐行用共享解释器复算）。私有侧文档，不进入任何公开下发物。',
  table: HAND_CHECK_TABLE,
});

// answer hints (private): instance texts for i/s/d, static texts for guided
const answerHints = {};
for (const inst of instances) {
  answerHints[inst.taskId] = inst.frozen.map((f) => ({ instanceId: f.instanceId, level: 4, text: f.answerHint }));
}
for (const [taskId, text] of Object.entries(staticAnswerHints)) {
  answerHints[taskId] = [{ instanceId: 'static', level: 4, text }];
}
writeJson('private/hints/answer-hints.json', answerHints);

// bindings (private): every task bound to its rule; i/s/d carry frozen
// instances + enabled segments; concept segment per task comes from the
// registry's perTaskConcept (rendered as singleChoice).
const ruleFor = (taskId) =>
  traceRule.body.entries[taskId] !== undefined
    ? traceRule
    : branchRule.body.entries[taskId] !== undefined
      ? branchRule
      : programRule;
const STEP_SEGMENTS = ['outputAnswer', 'finalVariables', 'conceptCheck'];
const bindings = {
  releaseId: RELEASE,
  taskBindings: tasks.map((t) => {
    const rule = ruleFor(t.taskId);
    const inst = instances.find((i) => i.taskId === t.taskId);
    return {
      taskId: t.taskId,
      ruleRef: { ruleId: rule.ruleId, ruleVersion: '1', path: `rules/${rule.ruleId}.json` },
      ...(inst ? { instanceGeneratorRef: { kind: 'frozen', path: `instances/${inst.file}` } } : {}),
      ...(inst ? { enabledSegments: STEP_SEGMENTS } : {}),
    };
  }),
};
writeJson('private/bindings/u1-r1.bindings.private.json', bindings);

// public manifest + assets map (content tree), mirroring the cylinder builder
const RENDERER_DECL = {
  rendererId: 'rondo.steps',
  rendererContractVersion: '1',
  publicStateSchemaVersion: '1',
};
{
  const publicDir = join(OUT, 'public');
  const taskIds = lessons.lessons[0].taskOrder.map((id) => id);
  const allTaskIds = [...taskIds, lessons.lessons[0].delayedTransferTaskId];
  const scoped = new Set([
    join(publicDir, 'schemas', 'response-schemas.registry.json'),
    join(publicDir, 'lessons.json'),
    ...allTaskIds.map((id) => join(publicDir, 'tasks', `${id}.json`)),
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
    releaseId: RELEASE,
    taskIds: allTaskIds,
    taskVersion: TASK_VERSION,
    rendererDeclarations: [RENDERER_DECL],
    publicAssetHashes: hashes,
    expressionOperationSubsets: [
      { expression: 'STEP_TABLE', allowedOperationIds: COMMON_ALLOWED },
      { expression: 'STATE_TRACE', allowedOperationIds: COMMON_ALLOWED },
    ],
    publicManifestHash: '',
  };
  const { publicManifestHash: _omitted, ...manifestContent } = manifest;
  manifest.publicManifestHash = sha256Canonical(manifestContent);
  writeJson(`public/releases/${RELEASE}/manifest.public.json`, manifest);
  writeJson(`public/releases/${RELEASE}/assets-map.json`, {
    releaseId: RELEASE,
    note: 'path -> sha256 of the public asset files hashed into publicAssetHashes; this map itself is not hashed',
    assets: assetMap,
  });
}

console.log(`content/cpp emitted: ${tasks.length} tasks, ${rules.length} rules, ${instances.length} instance files`);

// ---------------------------------------------------------------------------
// dist/content — B release layout for rondo.cpp.u1-r1 (parallel to the
// cylinder dist release; product-Host loader wiring for rondo.steps is a
// declared follow-up — the release files themselves are complete).
// ---------------------------------------------------------------------------
const DIST_CONTENT_ROOT = join(process.env.RONDO_DIST_DIR ?? join(ROOT,'dist'), 'content');
const DIST_CONTENT = join(DIST_CONTENT_ROOT, RELEASE);
rmSync(DIST_CONTENT, { recursive: true, force: true });

function writeDistJson(relPath, value) {
  const target = join(DIST_CONTENT, relPath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
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

// dist task files: B TaskFile shape (promptGroups projection of the public
// prompt; numericPolicy omitted — A-8 optional for non-dimensional families)
const taskObjs = {};
const hintObjs = {};
const hintGateTable = [];
for (const t of tasks) {
  const file = {
    taskId: t.taskId,
    taskFamily: t.taskFamily,
    title: t.title,
    promptGroups: [{ minVisibility: 'PREDICTION', blocks: t.prompt }],
    responseSchemaId: t.responseSchemaId,
    allowedOperationIds: t.allowedOperationIds,
    operationConstraints: t.operationConstraints,
    givens: t.givens,
    visibility: t.visibility,
    mission: t.mission,
    hints: t.hints,
    explain: t.explain,
    exitEvidence: t.exitEvidence,
    expressions: { stepTable: t.expressions.stepTable, stateTrace: t.expressions.stateTrace },
    taskVersion: TASK_VERSION,
  };
  taskObjs[t.taskId] = file;
  writeDistJson(join('public', 'tasks', `${t.taskId}.json`), file);
  // hint files: levels 1-3 + the answer-level l4 (text Host-gated by hint gates)
  for (const hint of t.hints) {
    const contentRef = `hint.${t.taskId}.l${hint.level}`;
    const hintFile = {
      contentRef,
      level: hint.level,
      revealsAnswer: hint.level === 4,
      version: '1',
      text: hint.text ?? answerHints[t.taskId][0].text,
    };
    hintObjs[contentRef] = hintFile;
    writeDistJson(join('public', 'hints', `${contentRef}.json`), hintFile);
    hintGateTable.push({ taskId: t.taskId, hintLevel: hint.level, contentRef });
  }
}

writeDistJson(join('private', 'bindings.json'), bindings);
for (const rule of rules) writeDistJson(join('private', 'rules', `${rule.ruleId}.json`), rule);
for (const inst of instances) writeDistJson(join('private', 'instances', inst.file), { frozen: inst.frozen });

const ruleRefs = tasks.map((t) => {
  const rule = ruleFor(t.taskId);
  return { taskId: t.taskId, ruleId: rule.ruleId, ruleVersion: '1' };
});

const publicHeader = {
  releaseId: RELEASE,
  taskIds: tasks.map((t) => t.taskId),
  taskVersion: TASK_VERSION,
  rendererDeclarations: [RENDERER_DECL],
  publicAssetHashes: [],
  expressionOperationSubsets: [
    { expression: 'STEP_TABLE', allowedOperationIds: COMMON_ALLOWED },
    { expression: 'STATE_TRACE', allowedOperationIds: COMMON_ALLOWED },
  ],
};
const manifest = {
  public: {
    ...publicHeader,
    publicManifestHash: createHash('sha256')
      .update(canonicalize({ publicHeader, tasks: taskObjs, hints: hintObjs, assets: {} }))
      .digest('hex'),
  },
  private: { ruleRefs, hintGateTable, constructionParamDomains: [] },
};
writeDistJson('manifest.json', manifest);

console.log(`dist/content ${RELEASE}: ${tasks.length} tasks, ${Object.keys(hintObjs).length} hints, ${rules.length} STEP_TASK_TRUTH rule files`);
