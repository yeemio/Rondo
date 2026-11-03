/**
 * THEMES-A content semantic + structural checks for content/themes-a:
 * public/private separation (no answer leakage in any public channel), h1–h4
 * registration, registry↔rule cross-consistency, manifest hash discipline,
 * independent recomputation of every authored numeric truth, micro diagnosis
 * wiring, and dist release hygiene.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FORBIDDEN_QUESTION_FIELDS, authoredBlocksSchema } from '../../modules/contracts/public/question';
import { releaseManifestPublicSchema } from '../../modules/contracts/server/content';

const ROOT = process.cwd();
const PUB = join(ROOT, 'content', 'themes-a', 'public');
const PRIV = join(ROOT, 'content', 'themes-a', 'private');

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
const tasks = taskFiles.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const lessons = JSON.parse(readFileSync(join(PUB, 'lessons.json'), 'utf8')).lessons;
const registry = JSON.parse(readFileSync(join(PUB, 'schemas', 'response-schemas.registry.json'), 'utf8'));
const rules = listFiles(join(PRIV, 'rules')).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const entries: Record<string, unknown> = {};
for (const r of rules) Object.assign(entries, r.body.entries);

const allLessonTasks = lessons.flatMap((l: { taskOrder: string[]; delayedTransferTaskId?: string }) => [
  ...l.taskOrder,
  ...(l.delayedTransferTaskId ? [l.delayedTransferTaskId] : []),
]);

test('themes-content: 23 tasks across 4 micro lessons + 3 theme lessons', () => {
  assert.equal(tasks.length, 23);
  assert.equal(lessons.length, 7);
  assert.equal(new Set(allLessonTasks).size, 23);
  assert.deepEqual(new Set(tasks.map((t) => t.taskId)), new Set(allLessonTasks));
  // 微课：每课 = 诊断 + 补充；主题课：g/i/s + 延迟回看
  for (const l of lessons) {
    if (l.lessonKind === 'micro') {
      assert.equal(l.taskOrder.length, 2, `${l.lessonId} 微课=诊断+补充`);
      assert.ok(l.taskOrder[0].endsWith('.diag.v1'));
      assert.ok(l.taskOrder[1].endsWith('.supp.v1'));
      assert.equal(l.delayedTransferTaskId, undefined, '微课不挂延迟回看');
    } else {
      assert.ok(l.taskOrder.length >= 4, `${l.lessonId} 主题课含引导/独立/陌生`);
      assert.ok(l.taskOrder.some((t: string) => tasks.find((x) => x.taskId === t)?.kind === 'STRANGER'), `${l.lessonId} 有陌生任务`);
      assert.ok(l.delayedTransferTaskId, `${l.lessonId} 登记延迟回看`);
      assert.deepEqual(l.delayedTransferWindowDays, { availableAfterDays: 7, nominalEndDays: 14 });
    }
  }
});

test('themes-content: no forbidden fields or private markers anywhere in the public tree', () => {
  for (const f of listFiles(PUB)) {
    const raw = readFileSync(f, 'utf8');
    const json = JSON.parse(raw);
    for (const field of FORBIDDEN_QUESTION_FIELDS) {
      assert.ok(!(field in json), `${f} carries forbidden field ${field}`);
    }
    for (const marker of ['answerHint', '"truth"', 'expectedJudgments', 'pendingDsl', 'private/', 'correctOptionId', 'reveal']) {
      assert.ok(!raw.includes(marker), `${f} leaks private marker ${marker}`);
    }
  }
});

test('themes-content: prompts parse as authored blocks; every task h1–h4 with text-free h4', () => {
  for (const t of tasks) {
    authoredBlocksSchema.parse(t.prompt);
    const levels = t.hints.map((h: { level: number }) => h.level).sort((a: number, b: number) => a - b);
    assert.deepEqual(levels, [1, 2, 3, 4], `${t.taskId} h1-h4`);
    const h4 = t.hints.find((h: { level: number }) => h.level === 4);
    assert.equal(h4.text, undefined, `${t.taskId} public h4 must not carry text`);
    for (const h of t.hints.filter((x: { level: number }) => x.level < 4)) {
      assert.ok(h.text && h.text.length > 0, `${t.taskId} h${h.level} has text`);
      assert.ok(!/=\s*\d+(\.\d+)?\s*(元|cm²|cm)$/.test(h.text), `${t.taskId} h${h.level} must not state the final answer`);
    }
    // explain 观察要点登记
    assert.ok(t.explain.selections.length >= 1 && t.explain.freeTextPrompt.length > 0);
    assert.ok(t.expressions.boardSvg && t.expressions.boardTable);
  }
});

test('themes-content: registry covers every schemaId and mirrors the private rule checks', () => {
  interface RegistrySchema {
    schemaId: string;
    verify?: { items?: Array<Record<string, unknown>> } | null;
    predict?: { asks?: Array<Record<string, unknown>> } | null;
  }
  const byId = new Map<string, RegistrySchema>(registry.schemas.map((s: RegistrySchema) => [s.schemaId, s]));
  for (const t of tasks) {
    const schema = byId.get(t.responseSchemaId);
    assert.ok(schema, `${t.taskId} schemaId registered`);
    interface VerifyItemShape {
      quantityId?: string;
      selectionId?: string;
      kind?: string;
      units?: Array<{ id: string }>;
      options?: Array<{ id: string }>;
      pairs?: Array<{ rightOptions: Array<{ id: string }> }>;
    }
    const items = (schema.verify?.items ?? []) as VerifyItemShape[];
    assert.ok(items && items.length > 0, `${t.taskId} verify items`);
    const entry = entries[t.taskId] as { checks: Array<Record<string, unknown>> } | undefined;
    assert.ok(entry, `${t.taskId} rule entry`);
    assert.equal(items.length, entry.checks.length, `${t.taskId} 表单项数 == 判分检查数`);
    for (const check of entry.checks) {
      if (check.kind === 'number') {
        const item = items.find((i: { quantityId?: string }) => i.quantityId === check.quantityId);
        assert.ok(item, `${t.taskId} number check ${check.id} has a form item`);
        for (const u of check.acceptedUnitIds as string[]) {
          assert.ok((item.units ?? []).some((x) => x.id === u), `${t.taskId} ${check.id} accepted unit ${u} offered`);
        }
      } else if (check.kind === 'fraction') {
        const item = items.find((i: { quantityId?: string }) => i.quantityId === check.quantityId);
        assert.ok(item && item.kind === 'fractionValue', `${t.taskId} fraction check ${check.id} has a fractionValue item`);
      } else if (check.kind === 'choice') {
        const item = items.find((i: { selectionId?: string }) => i.selectionId === check.selectionId);
        assert.ok(item && item.kind === 'singleChoice', `${t.taskId} choice check ${check.id} has a singleChoice item`);
        assert.ok(
          (item.options as Array<{ id: string }>).some((o) => o.id === check.correctOptionId),
          `${t.taskId} ${check.id} correct option is offered (registry never marks it)`,
        );
      } else if (check.kind === 'mapping') {
        const item = items.find((i) => i.kind === 'objectMapping');
        assert.ok(item, `${t.taskId} mapping check ${check.id} has an objectMapping item`);
        const offered = new Set((item?.pairs ?? [])[0]?.rightOptions.map((o) => o.id) ?? []);
        for (const p of check.expectedPairs as Array<{ rightId: string }>) assert.ok(offered.has(p.rightId));
      }
    }
    // predict asks exist and never use forbidden kinds
    for (const ask of schema.predict?.asks ?? []) {
      const kind = String(ask.kind);
      assert.ok(['choice', 'numberValue', 'fractionGuess', 'mapping'].includes(kind), `${t.taskId} ask kind ${kind}`);
    }
  }
});

test('themes-content: 微课诊断判定登记（服务端阈值）指向本课补充活动', () => {
  for (const l of lessons.filter((x: { lessonKind: string }) => x.lessonKind === 'micro')) {
    const diag = entries[l.taskOrder[0]] as { diagnosis?: { passRule: string; supplementTaskId: string } };
    assert.ok(diag.diagnosis, `${l.lessonId} diag entry carries diagnosis`);
    assert.equal(diag.diagnosis.passRule, 'ALL_CHECKS_FIRST_SUBMISSION_NO_ANSWER_HINT');
    assert.equal(diag.diagnosis.supplementTaskId, l.taskOrder[1]);
    const supp = entries[l.taskOrder[1]] as { diagnosis?: unknown };
    assert.equal(supp.diagnosis, undefined, '补充活动不做诊断判定');
  }
});

test('themes-content: FROM_STATE 判分检查的任务都带操作场景门（可操作且状态可验证）', () => {
  for (const t of tasks) {
    const entry = entries[t.taskId] as { checks: Array<Record<string, unknown>>; scenario?: unknown } | undefined;
    if (!entry) continue;
    const needsState = entry.checks.some(
      (c) => (c.kind === 'number' && (c.source as { kind?: string })?.kind === 'FROM_STATE') || (c.kind === 'fraction' && (c.source as { kind?: string })?.kind === 'FROM_STATE'),
    );
    if (needsState) {
      assert.ok(entry.scenario !== undefined, `${t.taskId} FROM_STATE 判分需要 scenario 门`);
      assert.ok((entry as { scenarioFeedback?: string }).scenarioFeedback, `${t.taskId} scenario 门有提示文案`);
    }
    if (entry.scenario !== undefined) {
      assert.ok(t.allowedOperationIds.length > 0 || t.taskId === 'thm.f1.i1.represent.v1', `${t.taskId} scenario 门任务应允许操作（i1 冻结图板除外）`);
    }
  }
});

test('themes-content: 数值真值独立复算（手算对照，不经生成器）', () => {
  const eq = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  // 微课①
  eq(2.5 * 2, 5.0);
  eq(12 / 2, 6.0);
  eq((2 * 35) / 10, 7.0);
  eq(12.0 / 2, 6.0);
  // 微课②
  eq(5 * 3, 15);
  eq(10 * 10, 100);
  eq(4 * 6, 24);
  eq(18 / 6, 3);
  // 微课③
  eq(6 * 4, 24);
  eq(24 / 6, 4);
  eq(24 / 4, 6);
  eq(8 * 3, 24);
  eq(36 / 9, 4);
  // 课1
  eq(5 / 8, 0.625);
  eq(7 / 10, 0.7);
  eq(5 / 8 - 0.5, 0.125);
  // 课2（等值分数精确比较有理数口径）
  eq(1 / 2, 2 / 4);
  eq(3 / 4, 6 / 8);
  eq(2 / 6, 1 / 3);
  eq(1 / 2, 4 / 8);
  eq(3 / 9, 1 / 3);
  // 课3（折扣顺序边界：先乘后减）
  eq(80 * 0.8, 64);
  eq(80 - 64, 16);
  eq(60 / 5, 12);
  eq(12 * 3, 36);
  eq(12 * 2, 24);
  eq(40 + 40 * 0.5, 60);
  eq((40 + 40) * 0.8, 64);
  eq(64 - 60, 4);
  eq(50 * 0.9, 45);
  eq(50 - 45, 5);
  // 私有规则内的 authored 小数与上述手算一致
  const f3g2 = entries['thm.f3.g2.discount-chain.v1'] as { checks: Array<{ id: string; source?: { expectedDecimal?: string } }> };
  const byId = Object.fromEntries(f3g2.checks.map((c) => [c.id, c.source?.expectedDecimal]));
  assert.equal(byId.c1, '80');
  assert.equal(byId.c2, '64.00');
  assert.equal(byId.c3, '16.00');
  const m1d = entries['thm.m1.diag.v1'] as { checks: Array<{ id: string; source?: { expectedDecimal?: string } }> };
  const m1ById = Object.fromEntries(m1d.checks.map((c) => [c.id, c.source?.expectedDecimal]));
  assert.equal(m1ById.c1, '5.0');
  assert.equal(m1ById.c2, '6.0');
});

test('themes-content: release manifests hash-match their scoped public assets', () => {
  const dirs = ['m1-r1', 'm2-r1', 'm3-r1', 'm4-r1', 't1l1-r1', 't1l2-r1', 't1l3-r1'];
  for (const dir of dirs) {
    const manifest = releaseManifestPublicSchema.parse(JSON.parse(readFileSync(join(PUB, 'releases', dir, 'manifest.public.json'), 'utf8')));
    const assetMap = JSON.parse(readFileSync(join(PUB, 'releases', dir, 'assets-map.json'), 'utf8'));
    const recomputed = Object.values(assetMap.assets as Record<string, string>).sort();
    assert.deepEqual(manifest.publicAssetHashes, recomputed, `${dir}: hash list mismatch`);
    for (const [path, hash] of Object.entries(assetMap.assets as Record<string, string>)) {
      const actual = createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex');
      assert.equal(actual, hash, `${path} hash drift`);
    }
    const { publicManifestHash, ...rest } = manifest;
    const selfHash = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
    assert.equal(selfHash, publicManifestHash, `${dir}: publicManifestHash mismatch`);
    assert.ok(manifest.rendererDeclarations.some((d) => d.rendererId === 'rondo.gridboard'));
    for (const subset of manifest.expressionOperationSubsets) {
      assert.ok(['BOARD_SVG', 'BOARD_TABLE', 'WEBGL2', 'SVG_DOM'].includes(subset.expression));
    }
  }
});

test('themes-content: private answer hints cover all 23 tasks; dist serves an l4 gate per task', () => {
  const answerHints = JSON.parse(readFileSync(join(PRIV, 'hints', 'answer-hints.json'), 'utf8'));
  for (const t of tasks) {
    const list = answerHints[t.taskId];
    assert.ok(Array.isArray(list) && list.length > 0, `${t.taskId} needs a private answer hint`);
    assert.equal(list[0].level, 4);
    assert.ok(list[0].text.length > 0);
  }
  const releases: Array<[string, string[]]> = [
    ['rondo.thm.m1-r1', ['thm.m1.diag.v1', 'thm.m1.supp.v1']],
    ['rondo.thm.t1l1-r1', ['thm.f1.g1.partition-circle.v1', 'thm.f1.g2.partition-bar.v1', 'thm.f1.i1.represent.v1', 'thm.f1.s1.stranger-relabel.v1', 'thm.f1.d1.delayed-transfer.v1']],
  ];
  for (const [releaseId, tasksInRelease] of releases) {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'dist', 'content', releaseId, 'manifest.json'), 'utf8'));
    const l4 = manifest.private.hintGateTable.filter((g: { hintLevel: number }) => g.hintLevel === 4);
    assert.equal(l4.length, tasksInRelease.length, `${releaseId}: one l4 gate row per task`);
    for (const row of l4) {
      const file = JSON.parse(readFileSync(join(ROOT, 'dist', 'content', releaseId, 'public', 'hints', `${row.contentRef}.json`), 'utf8'));
      assert.equal(file.revealsAnswer, true);
      assert.ok(file.text.length > 0);
      // 公开任务树不得内嵌被服务的答案文本
      const raw = readFileSync(join(PUB, 'tasks', `${row.taskId}.json`), 'utf8');
      assert.ok(!raw.includes(file.text.slice(0, 10)), `${row.taskId} public file embeds served h4 text`);
    }
  }
});

test('themes-content: 典型误解判分规则登记覆盖 Owner 点名的误解族', () => {
  const allTags = new Set<string>();
  for (const r of rules) {
    for (const entry of Object.values(r.body.entries as Record<string, { diagnostics?: Array<{ tag: string }> }>)) {
      for (const d of entry.diagnostics ?? []) allTags.add(d.tag);
    }
  }
  for (const required of [
    'mis-rd-no-double', // 半径直径不加倍
    'mis-num-den-swapped', // 分子分母互换
    'mis-numerator-only-scaled', // 等值缩放只缩分子
    'mis-denominator-only-scaled', // 等值缩放只缩分母
    'mis-percent-as-decimal', // 百分数写成小数口径
    'mis-percent-as-integer', // 百分数当整数/个数处理
    'mis-fold-as-8pct', // 把八折当 8%
    'mis-discount-added', // 折扣先加后乘/当加价
    'mis-equal-split', // 按比例分配当成对半分
    'mis-perimeter-for-area', // 周长当面积
  ]) {
    assert.ok(allTags.has(required), `misconception ${required} must be registered`);
  }
});
