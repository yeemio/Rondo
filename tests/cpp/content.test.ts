/**
 * cpp.u1 content tree structural + semantic checks: public/private separation,
 * schema validity, hint completeness, bindings/instances/rules coherence,
 * manifest hashing, and the GESP discipline (no syllabus text, no coverage
 * claims, no level promises; K1-K8 stay 待官方考纲原文核对 as structure only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FORBIDDEN_QUESTION_FIELDS } from '../../modules/contracts/public/question';
import { stepProgramStateV1Schema } from '../../modules/contracts/public/scene-steps';
import { releaseManifestPublicSchema } from '../../modules/contracts/server/content';
import { safeParseRuleBodyStepsV1 } from '../../modules/contracts/server/rules-steps';
import { runStepProgram, validateStepProgram } from '../../modules/scenes/steps/engine';

const ROOT = process.cwd();
const PUB = join(ROOT, 'content', 'cpp', 'public');
const PRIV = join(ROOT, 'content', 'cpp', 'private');
const DIST = join(ROOT, 'dist', 'content', 'rondo.cpp.u1-r1');

const TASK_IDS = [
  'cpp.u1.g1.receipt-trace.v1',
  'cpp.u1.g2.pack-sweets.v1',
  'cpp.u1.g3.member-discount.v1',
  'cpp.u1.g4.sales-sum.v1',
  'cpp.u1.i1.fix-boundary.v1',
  'cpp.u1.i2.enum-count.v1',
  'cpp.u1.i3.build-digits.v1',
  'cpp.u1.s1.stranger-transfer.v1',
  'cpp.u1.d1.delayed-transfer.v1',
];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const tasks = TASK_IDS.map((id) => ({ id, data: readJson(join(PUB, 'tasks', `${id}.json`)) }));
const registry = readJson(join(PUB, 'schemas', 'response-schemas.registry.json'));
const lessons = readJson(join(PUB, 'lessons.json'));

test('cpp-content: 9 tasks emitted with preallocated ids only', () => {
  assert.equal(tasks.length, 9);
  for (const t of tasks) {
    assert.equal(t.data.taskId, t.id);
    assert.equal(t.data.taskFamily, 'cpp.steps.v1');
    assert.deepEqual(t.data.allowedOperationIds, ['EditStepProgram', 'SetTraceCursor']);
    assert.deepEqual(t.data.exitEvidence, ['firstPrediction', 'confirmedOperation', 'submission', 'explanation']);
  }
  assert.deepEqual(
    lessons.lessons[0].taskOrder,
    TASK_IDS.slice(0, 8),
  );
  assert.equal(lessons.lessons[0].delayedTransferTaskId, 'cpp.u1.d1.delayed-transfer.v1');
  assert.deepEqual(lessons.lessons[0].delayedTransferWindowDays, { availableAfterDays: 7, nominalEndDays: 14 });
});

test('cpp-content: no forbidden/private material anywhere in the public tree', () => {
  for (const f of listFiles(PUB)) {
    const raw = readFileSync(f, 'utf8');
    for (const field of [...FORBIDDEN_QUESTION_FIELDS, 'answerHint', 'hiddenCases', 'expectedLines', 'correctOptionId', 'samplePassedHiddenFailed']) {
      assert.ok(!raw.includes(`"${field}"`), `${f} leaks private marker "${field}"`);
    }
    assert.ok(!raw.includes('private/'), `${f} references the private tree`);
    assert.ok(!raw.includes('"truth"'), `${f} carries truth block`);
  }
});

test('cpp-content: givens parse against StepProgramStateV1 and run under the teaching model', () => {
  for (const t of tasks) {
    stepProgramStateV1Schema.parse(t.data.givens);
    const v = validateStepProgram(t.data.givens.program);
    assert.ok(v.ok, `${t.id} program invalid: ${JSON.stringify(v.issues)}`);
    const run = runStepProgram(t.data.givens.program, t.data.givens.inputs);
    assert.equal(run.status, 'COMPLETED', `${t.id} skeleton must complete within budget`);
    assert.ok(run.lines.length <= 8, `${t.id} skeleton output within cap`);
  }
});

test('cpp-content: hints h1-h4 complete; level 4 marked revealsAnswer with no text in the public file', () => {
  for (const t of tasks) {
    const levels = t.data.hints.map((h: { level: number }) => h.level);
    assert.deepEqual(levels, [1, 2, 3, 4], `${t.id} must ship hints 1-4`);
    const h4 = t.data.hints[3];
    assert.equal(h4.revealsAnswer, true, `${t.id} h4 must reveal the answer`);
    assert.equal(h4.text, undefined, `${t.id} h4 text must stay private`);
    for (const h of t.data.hints.slice(0, 3)) {
      assert.ok(typeof h.text === 'string' && h.text.length > 0, `${t.id} h${h.level} needs text`);
    }
  }
  // the private answer-hints file covers every task
  const answerHints = readJson(join(PRIV, 'hints', 'answer-hints.json'));
  for (const id of TASK_IDS) {
    assert.ok(answerHints[id]?.length > 0, `answer hint missing for ${id}`);
  }
});

test('cpp-content: registry covers every schemaId; per-task concept selections exist for program.v1', () => {
  const ids = new Set(registry.schemas.map((s: { schemaId: string }) => s.schemaId));
  for (const t of tasks) assert.ok(ids.has(t.data.responseSchemaId), `${t.id} schemaId not registered`);
  const program = registry.schemas.find((s: { schemaId: string }) => s.schemaId === 'resp.cpp.u1.program.v1');
  for (const id of TASK_IDS.slice(4)) {
    assert.ok(program.perTaskConcept[id], `perTaskConcept missing for ${id}`);
  }
  // predict asks with tasks filters only reference shipped tasks
  for (const schema of registry.schemas) {
    for (const ask of schema.predict?.asks ?? []) {
      for (const tid of ask.tasks ?? []) assert.ok(TASK_IDS.includes(tid), `unknown ask.tasks entry ${tid}`);
    }
  }
});

test('cpp-content: private rules parse against the STEP_TASK_TRUTH DSL and cover all tasks', () => {
  const ruleFiles = ['rule.cppU1.trace.v1.json', 'rule.cppU1.branch.v1.json', 'rule.cppU1.program.v1.json'];
  const covered = new Set<string>();
  for (const f of ruleFiles) {
    const rule = readJson(join(PRIV, 'rules', f));
    const parsed = safeParseRuleBodyStepsV1(rule.body);
    assert.ok(parsed.success, `${f} must parse: ${JSON.stringify(parsed.error?.issues?.slice(0, 3))}`);
    assert.equal(parsed.data!.kind, 'STEP_TASK_TRUTH');
    assert.equal(parsed.data!.stepBudget, 200);
    for (const taskId of Object.keys(parsed.data!.entries)) covered.add(taskId);
  }
  assert.deepEqual([...covered].sort(), [...TASK_IDS].sort());
});

test('cpp-content: bindings + frozen instances coherent (visibleCase inputs match instance F1)', () => {
  const bindings = readJson(join(PRIV, 'bindings', 'u1-r1.bindings.private.json'));
  assert.equal(bindings.releaseId, 'rondo.cpp.u1-r1');
  assert.equal(bindings.taskBindings.length, 9);
  const covered = new Set(bindings.taskBindings.map((b: { taskId: string }) => b.taskId));
  assert.deepEqual([...covered].sort(), [...TASK_IDS].sort());
  const ruleById: Record<string, any> = {};
  for (const f of ['rule.cppU1.trace.v1.json', 'rule.cppU1.branch.v1.json', 'rule.cppU1.program.v1.json']) {
    const r = readJson(join(PRIV, 'rules', f));
    ruleById[r.ruleId] = r;
  }
  for (const b of bindings.taskBindings) {
    assert.ok(ruleById[b.ruleRef.ruleId], `binding rule ${b.ruleRef.ruleId} exists`);
    assert.ok(b.ruleRef.path.endsWith(`${b.ruleRef.ruleId}.json`));
    const entry = ruleById[b.ruleRef.ruleId].body.entries[b.taskId];
    assert.ok(entry, `entry for ${b.taskId}`);
    if (b.instanceGeneratorRef) {
      const inst = readJson(join(PRIV, b.instanceGeneratorRef.path));
      assert.deepEqual(
        inst.frozen[0].inputs,
        entry.visibleCase.inputs,
        `${b.taskId} frozen F1 inputs must equal visibleCase inputs`,
      );
      assert.deepEqual(
        b.enabledSegments,
        ['outputAnswer', 'finalVariables', 'conceptCheck'],
      );
    } else {
      assert.equal(b.taskId.startsWith('cpp.u1.g'), true);
    }
  }
  // instance files exist exactly for i/s/d
  const instanceFiles = readdirSync(join(PRIV, 'instances')).sort();
  assert.deepEqual(instanceFiles, [
    'cpp.u1.d1.v1-instances.json',
    'cpp.u1.i1.v1-instances.json',
    'cpp.u1.i2.v1-instances.json',
    'cpp.u1.i3.v1-instances.json',
    'cpp.u1.s1.v1-instances.json',
  ]);
});

test('cpp-content: judging modes are per spec (g1/g3/g4 SNAPSHOT_RERUN; g2 + i/s/d AUTHORED)', () => {
  const expect: Record<string, string> = {
    'cpp.u1.g1.receipt-trace.v1': 'SNAPSHOT_RERUN',
    'cpp.u1.g3.member-discount.v1': 'SNAPSHOT_RERUN',
    'cpp.u1.g4.sales-sum.v1': 'SNAPSHOT_RERUN',
  };
  for (const f of ['rule.cppU1.trace.v1.json', 'rule.cppU1.branch.v1.json', 'rule.cppU1.program.v1.json']) {
    const rule = readJson(join(PRIV, 'rules', f));
    for (const [taskId, entry] of Object.entries<any>(rule.body.entries)) {
      const mode = entry.judging?.outputSource ?? 'AUTHORED';
      assert.equal(mode, expect[taskId] ?? 'AUTHORED', `${taskId} judging mode`);
    }
  }
});

test('cpp-content: GESP discipline — no coverage claims, no level/exam promises, no syllabus text', () => {
  const banned = ['覆盖 GESP', '覆盖该等级', '通过 GESP', '晋级', '保过', '等级证书', '考试通过'];
  for (const f of listFiles(PUB)) {
    const raw = readFileSync(f, 'utf8');
    for (const phrase of banned) {
      assert.ok(!raw.includes(phrase), `${f} contains banned promise "${phrase}"`);
    }
  }
  // the lesson carries the partial-association note instead
  assert.ok(lessons.lessons[0].note.includes('部分能力关联'));
  assert.ok(lessons.lessons[0].note.includes('不构成任何等级达成'));
});

test('cpp-content: public manifest self-hashes and assets-map matches the files', () => {
  const manifest = readJson(join(PUB, 'releases', 'rondo.cpp.u1-r1', 'manifest.public.json'));
  releaseManifestPublicSchema.parse(manifest);
  const { publicManifestHash, ...rest } = manifest;
  const self = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  assert.equal(self, publicManifestHash, 'publicManifestHash mismatch');
  const assetMap = readJson(join(PUB, 'releases', 'rondo.cpp.u1-r1', 'assets-map.json'));
  const recomputed = Object.values(assetMap.assets).sort();
  assert.deepEqual(manifest.publicAssetHashes, recomputed);
  for (const [path, hash] of Object.entries<string>(assetMap.assets)) {
    assert.equal(createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex'), hash, `${path} hash drift`);
  }
  const sets = manifest.expressionOperationSubsets.map((s: { expression: string; allowedOperationIds: string[] }) => `${s.expression}:${s.allowedOperationIds.join('+')}`);
  assert.equal(new Set(sets).size, 2);
  assert.ok(manifest.expressionOperationSubsets.every((s: { allowedOperationIds: string[] }) => s.allowedOperationIds.join('+') === 'EditStepProgram+SetTraceCursor'));
});

test('cpp-content: dist B release layout complete (manifest/tasks/hints/private, canonical publicManifestHash)', () => {
  const distManifest = readJson(join(DIST, 'manifest.json'));
  releaseManifestPublicSchema.parse(distManifest.public);
  assert.equal(distManifest.public.rendererDeclarations[0].rendererId, 'rondo.steps');
  for (const id of TASK_IDS) {
    readFileSync(join(DIST, 'public', 'tasks', `${id}.json`));
  }
  // hint gates: 4 levels per task, level-4 gates exist with reveal text
  const gates = distManifest.private.hintGateTable;
  assert.equal(gates.length, 36);
  for (const id of TASK_IDS) {
    const levels = gates.filter((g: { taskId: string }) => g.taskId === id).map((g: { hintLevel: number }) => g.hintLevel).sort();
    assert.deepEqual(levels, [1, 2, 3, 4], `hint gates for ${id}`);
    const l4 = readJson(join(DIST, 'public', 'hints', `hint.${id}.l4.json`));
    assert.equal(l4.revealsAnswer, true);
    assert.ok(l4.text.length > 0);
  }
  // private side
  readJson(join(DIST, 'private', 'bindings.json'));
  readJson(join(DIST, 'private', 'rules', 'rule.cppU1.program.v1.json'));
  readJson(join(DIST, 'private', 'instances', 'cpp.u1.i1.v1-instances.json'));
  // canonical publicManifestHash over {publicHeader, tasks, hints, assets:{}}
  const canonicalize = (value: unknown): string => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    if (typeof value === 'object') {
      const keys = Object.keys(value as Record<string, unknown>).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  const { publicManifestHash, ...publicHeader } = distManifest.public;
  const taskObjs: Record<string, unknown> = {};
  const hintObjs: Record<string, unknown> = {};
  for (const id of TASK_IDS) taskObjs[id] = readJson(join(DIST, 'public', 'tasks', `${id}.json`));
  for (const g of gates) hintObjs[g.contentRef] = readJson(join(DIST, 'public', 'hints', `${g.contentRef}.json`));
  const hash = createHash('sha256').update(canonicalize({ publicHeader, tasks: taskObjs, hints: hintObjs, assets: {} })).digest('hex');
  assert.equal(hash, publicManifestHash, 'dist publicManifestHash (canonical) mismatch');
  // ruleRefs cover every task
  assert.equal(distManifest.private.ruleRefs.length, 9);
});
