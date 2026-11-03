/**
 * THEMES-A rule truth schema coverage: every GRID_TASK_TRUTH rule file parses
 * loss-free against rules-themes.ts; unknown/malformed shapes are rejected;
 * every public task has exactly one binding and one rule entry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeParseRuleBodyThemesV1, type GridTaskTruthRuleV1 } from '../../modules/contracts/server/rules-themes';
import { privateReleaseBindingsV2Schema } from '../../modules/contracts/server/content';

const ROOT = process.cwd();
const PRIV = join(ROOT, 'content', 'themes-a', 'private');
const PUB = join(ROOT, 'content', 'themes-a', 'public');

const ruleFiles = readdirSync(join(PRIV, 'rules')).sort();
assert.equal(ruleFiles.length, 7);

function loadRule(name: string): { ruleId: string; boundTasks: string[]; body: GridTaskTruthRuleV1 } {
  const raw = JSON.parse(readFileSync(join(PRIV, 'rules', name), 'utf8'));
  const parsed = safeParseRuleBodyThemesV1(raw.body);
  assert.ok(parsed.success, `${name} must parse: ${JSON.stringify(parsed.error?.issues?.[0])}`);
  return { ruleId: raw.ruleId, boundTasks: raw.boundTasks, body: parsed.data as GridTaskTruthRuleV1 };
}

test('themes-rules: all 7 GRID_TASK_TRUTH rule files parse loss-free', () => {
  for (const name of ruleFiles) {
    const rule = loadRule(name);
    assert.equal(rule.body.kind, 'GRID_TASK_TRUTH');
    assert.ok(Object.keys(rule.body.entries).length >= 1);
  }
});

test('themes-rules: every task has exactly one binding covering exactly its rule entry', () => {
  const lessons = JSON.parse(readFileSync(join(PUB, 'lessons.json'), 'utf8')).lessons;
  const allTasks = lessons.flatMap((l: { taskOrder: string[]; delayedTransferTaskId?: string }) => [
    ...l.taskOrder,
    ...(l.delayedTransferTaskId ? [l.delayedTransferTaskId] : []),
  ]);
  assert.equal(allTasks.length, 23);
  assert.equal(new Set(allTasks).size, 23, 'task ids unique');

  const bound = new Map<string, string>();
  for (const file of readdirSync(join(PRIV, 'bindings')).sort()) {
    const raw = JSON.parse(readFileSync(join(PRIV, 'bindings', file), 'utf8'));
    const parsed = privateReleaseBindingsV2Schema.safeParse(raw);
    assert.ok(parsed.success, `${file} bindings must parse: ${JSON.stringify(parsed.error?.issues?.[0])}`);
    for (const b of parsed.data!.taskBindings) {
      assert.ok(!bound.has(b.taskId), `task ${b.taskId} bound twice`);
      bound.set(b.taskId, b.ruleRef.ruleId);
    }
  }
  assert.equal(bound.size, 23);

  const entryTasks = new Set<string>();
  for (const name of ruleFiles) {
    const rule = loadRule(name);
    assert.deepEqual([...rule.boundTasks].sort(), Object.keys(rule.body.entries).sort(), `${name} boundTasks == entries`);
    for (const t of rule.boundTasks) entryTasks.add(t);
  }
  for (const taskId of allTasks) {
    assert.ok(bound.has(taskId), `${taskId} has a binding`);
    assert.ok(entryTasks.has(taskId), `${taskId} has a rule entry`);
  }
});

test('themes-rules: malformed shapes rejected (unknown kind, bad check, bad diagnosis)', () => {
  assert.ok(!safeParseRuleBodyThemesV1({ kind: 'STEP_TASK_TRUTH', entries: {} }).success);
  assert.ok(!safeParseRuleBodyThemesV1({ kind: 'GRID_TASK_TRUTH', entries: {} }).success);
  assert.ok(
    !safeParseRuleBodyThemesV1({
      kind: 'GRID_TASK_TRUTH',
      entries: { t: { checks: [{ id: 'c1', kind: 'number', quantityId: 'q', label: 'x', source: { kind: 'AUTHORED', unitId: 'cm', expectedDecimal: '1.0e2' }, acceptedUnitIds: ['cm'], rounding: { mode: 'HALF_UP', decimalPlaces: 1 } }], reveal: [{ checkId: 'c1', text: 'r' }] } },
    }).success,
    'exponent-form decimals rejected',
  );
  assert.ok(
    !safeParseRuleBodyThemesV1({
      kind: 'GRID_TASK_TRUTH',
      entries: { t: { checks: [], reveal: [] } },
    }).success,
    'empty checks rejected',
  );
  assert.ok(
    !safeParseRuleBodyThemesV1({
      kind: 'GRID_TASK_TRUTH',
      entries: { t: { checks: [{ id: 'c1', kind: 'choice', label: 'x', selectionId: 's', correctOptionId: 'o' }], reveal: [{ checkId: 'c1', text: 'r' }], diagnosis: { passRule: 'SOMETIMES', supplementTaskId: 'x' } } },
    }).success,
    'unknown passRule rejected',
  );
});

test('themes-rules: diagnostics never carry expected values in feedback text', () => {
  for (const name of ruleFiles) {
    const rule = loadRule(name);
    for (const [taskId, entry] of Object.entries(rule.body.entries)) {
      for (const diag of entry.diagnostics ?? []) {
        assert.equal(typeof diag.feedback, 'string');
        assert.ok(diag.feedback.length > 0, `${taskId}/${diag.tag} needs feedback text`);
        // answers are hex-free strings; ensure no bare final-value reveal like "= 64.00 元"
        assert.ok(!/=\s*\d+(\.\d+)?\s*(元|cm)/.test(diag.feedback), `${taskId}/${diag.tag} feedback must not state the expected value`);
      }
    }
  }
});
