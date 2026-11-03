/**
 * STEP_TASK_TRUTH judging — the Host-side (server-private) recomputation for
 * cpp.steps.v1 tasks (GESP2 unit 1). The dev-side mock stand-in and the
 * future B learning server both call THIS module; the renderer never does.
 *
 * Semantics (UNIT-SPEC §6 + contract delta §5/§6):
 *  - typed output lines: exact per-line string comparison under A-3
 *    normalization; keyed by entry.judging.outputSource — 'AUTHORED'
 *    (construction tasks + g2) vs 'SNAPSHOT_RERUN' (trace tasks g1/g3/g4);
 *  - typed variable finals: ALWAYS the submitted snapshot's recomputation
 *    (§6.2) — judging whether the learner can read their own program;
 *  - program truth: the submitted program is rerun on the visible case AND
 *    every hidden case; all expected lines must match (跑过样例 ≠ 证明);
 *  - branch/number/concept/structural checks are exact data comparisons;
 *  - feedback never carries expected values (diagnostics are prompt-only).
 *
 * Import boundary: modules/contracts/server/rules-steps is Host-side. Only
 * the mock client (dev whitelist) and the learning server reach this file;
 * renderer code imports the engine, never the judge.
 */
import type { StructuredResponseItem } from '../../contracts/public/envelope';
import type { StepProgramStateV1, StepSpecV1 } from '../../contracts/public/scene-steps';
import type { StepTaskTruthEntryV1, StepTaskTruthRule } from '../../contracts/server/rules-steps';
import { runStepProgram, validateStepProgram, outputLinesEqual, countStatements, countOutputs, type StepRunResult } from './engine';

export type StepVerdict = 'CORRECT' | 'REVISE' | 'UNSCORABLE';

export interface StepJudgeItemResult {
  readonly key: string;
  readonly label: string;
  readonly verdict: 'CORRECT' | 'REVISE';
  /** restricted feedback — never reveals the expected value */
  readonly feedback?: string;
}

export interface StepJudgeResult {
  readonly verdict: StepVerdict;
  readonly itemResults: readonly StepJudgeItemResult[];
  readonly diagnostics: readonly string[];
  /** answer reveal — surfaced ONLY after the cycle reaches REVIEW */
  readonly reveal: Readonly<Record<string, string>>;
}

const FB_DEFAULT_REVISE = '再走一遍这张卡：对照变量时间线检查每一个数。';
const FB_OUTPUT_REVISE = '逐行核对：每行一个数，行数也要对上（每行来自一条 OUTPUT 语句的执行）。';
const FB_FINALS_REVISE = '对照变量时间线最后一步：每个变量结束时是多少。';
const FB_BRANCH_REVISE = '回到单步：走进的是哪个大括号，就在时间线里看判断那一行。';
const FB_CONCEPT_REVISE = '这个概念再想一下；可以回到卡片单步验证。';
const FB_NUMBER_REVISE = '再数一遍：执行次数和退出值都能从时间线数出来。';
const FB_STRUCTURAL_REVISE = '这题要求保留指定的语句结构（比如循环），不能绕开它。';
const FB_HIDDEN_REVISE = '可见这问之外，程序还会用另一组输入复跑——先保证程序本身正确。';
const FB_BUDGET = '步数用尽（教学模型上限 200 步）：程序没有走完，调整后再提交。';

function findItems<K extends StructuredResponseItem['kind']>(
  items: readonly StructuredResponseItem[],
  kind: K,
): Array<Extract<StructuredResponseItem, { kind: K }>> {
  return items.filter((i) => i.kind === kind) as Array<Extract<StructuredResponseItem, { kind: K }>>;
}

function hasConstruct(program: readonly StepSpecV1[], kind: 'IF' | 'FOR'): boolean {
  for (const s of program) {
    if (s.kind === kind) return true;
    if (s.kind === 'IF') {
      if (hasConstruct(s.then, kind) || hasConstruct(s.else, kind)) return true;
    } else if (s.kind === 'FOR' && hasConstruct(s.body, kind)) return true;
  }
  return false;
}

/** Flips every '<' loop comparison to '<=' (off-by-one detector; A-2/A-9 evidence). */
function withInclusiveCmp(program: readonly StepSpecV1[]): StepSpecV1[] {
  return program.map((s): StepSpecV1 => {
    if (s.kind === 'FOR') {
      return { ...s, cmp: '<=' as const, body: withInclusiveCmp(s.body) };
    }
    if (s.kind === 'IF') {
      return { ...s, then: withInclusiveCmp(s.then), else: withInclusiveCmp(s.else) };
    }
    return s;
  });
}

interface RerunOutcome {
  readonly caseId: string;
  readonly ok: boolean;
  readonly run: StepRunResult;
}

function rerunAll(
  program: readonly StepSpecV1[],
  cases: ReadonlyArray<{ caseId: string; inputs: Record<string, number>; expectedLines: string[] }>,
): RerunOutcome[] {
  return cases.map((c) => {
    const run = runStepProgram(program, c.inputs);
    return { caseId: c.caseId, ok: run.status === 'COMPLETED' && outputLinesEqual(run.lines, c.expectedLines), run };
  });
}

/**
 * Judges one submission. `snapshot` is the scene state frozen at submission
 * (the confirmed EditStepProgram card + frozen inputs + trace cursor).
 */
export function judgeStepTask(input: {
  readonly taskId: string;
  readonly rule: StepTaskTruthRule;
  readonly snapshot: StepProgramStateV1;
  readonly responseItems: readonly StructuredResponseItem[];
}): StepJudgeResult {
  const { taskId, rule, snapshot, responseItems } = input;
  const entry: StepTaskTruthEntryV1 | undefined = rule.entries[taskId];
  if (entry === undefined) {
    return unscorable(`任务 ${taskId} 没有登记判分真值。`);
  }

  const validation = validateStepProgram(snapshot.program);
  if (!validation.ok) {
    return unscorable(`提交的程序未通过教学模型校验：${validation.issues[0]?.message ?? ''}`);
  }

  const items: StepJudgeItemResult[] = [];
  const diagnostics: string[] = [];
  const reveal: Record<string, string> = {};
  const revise = entry.feedback?.reviseGeneric ?? FB_DEFAULT_REVISE;

  // --- program truth ---
  // AUTHORED tasks (construction i1/i2/i3/s1/d1 + g2): the submitted program
  // is rerun on the visible case AND every hidden case; all expected lines
  // must match — 跑过样例 ≠ 证明 becomes a judging fact.
  // SNAPSHOT_RERUN tasks (trace g1/g3/g4): the authored expectation anchors
  // the REVIEW reveal; judging keys the typed answer to the learner's own
  // card, so a legitimate exploration (e.g. g4 upper bound 100) is judged on
  // what the card actually does — the guided mission itself is exit evidence.
  const outputSource = entry.judging?.outputSource ?? 'AUTHORED';
  const visibleRun = runStepProgram(snapshot.program, entry.visibleCase.inputs);
  if (visibleRun.status !== 'COMPLETED') {
    items.push({
      key: 'program',
      label: '程序运行（教学模型）',
      verdict: 'REVISE',
      feedback: visibleRun.haltReason === 'STEP_BUDGET_EXHAUSTED' ? FB_BUDGET : revise,
    });
    reveal.program = '程序没有走完（教学模型停下了）。';
    return finish('REVISE', items, diagnostics, reveal);
  }
  const hiddenRuns = outputSource === 'AUTHORED' ? rerunAll(snapshot.program, entry.hiddenCases) : [];
  const visibleProgramOk = outputSource === 'SNAPSHOT_RERUN' || outputLinesEqual(visibleRun.lines, entry.visibleCase.expectedLines);
  const hiddenAllOk = hiddenRuns.every((r) => r.ok);
  const programOk = visibleProgramOk && hiddenAllOk;
  if (outputSource === 'AUTHORED') {
    items.push({
      key: 'program',
      label: '程序正确性（含换输入复跑）',
      verdict: programOk ? 'CORRECT' : 'REVISE',
      feedback: programOk
        ? undefined
        : !visibleProgramOk
          ? revise
          : entry.diagnostics?.samplePassedHiddenFailed ?? FB_HIDDEN_REVISE,
    });
    if (visibleProgramOk && !hiddenAllOk && entry.diagnostics?.samplePassedHiddenFailed) {
      diagnostics.push('samplePassedHiddenFailed');
    }
    if (!visibleProgramOk && entry.diagnostics?.offByOneBound) {
      // off-by-one detector: flipping '<' to '<=' repairs the program exactly
      const repaired = runStepProgram(withInclusiveCmp(snapshot.program), entry.visibleCase.inputs);
      if (repaired.status === 'COMPLETED' && outputLinesEqual(repaired.lines, entry.visibleCase.expectedLines)) {
        diagnostics.push('offByOneBound');
      }
    }
  }

  // --- typed output lines ---
  const outputItems = findItems(responseItems, 'outputLines');
  const typedOutput = outputItems[0]?.lines;
  const expectedTypedLines = outputSource === 'SNAPSHOT_RERUN' ? visibleRun.lines : entry.visibleCase.expectedLines;
  let outputOk = false;
  if (typedOutput !== undefined) {
    outputOk = outputLinesEqual(typedOutput, expectedTypedLines);
    items.push({
      key: 'output',
      label: '输出作答（逐行）',
      verdict: outputOk ? 'CORRECT' : 'REVISE',
      feedback: outputOk ? undefined : entry.feedback?.reviseGeneric ?? FB_OUTPUT_REVISE,
    });
    // divRounding heuristic: a division-misconception option was chosen on a
    // concept check (authored option ids carry 'floor'/'round'/'decimal')
    if (!outputOk && entry.diagnostics?.divRounding) {
      const conceptPicks = findItems(responseItems, 'singleChoice');
      if (conceptPicks.some((c) => /floor|round|decimal/.test(c.optionId))) diagnostics.push('divRounding');
    }
  } else if (entry.visibleCase.expectedLines.length > 0) {
    items.push({ key: 'output', label: '输出作答（逐行）', verdict: 'REVISE', feedback: FB_OUTPUT_REVISE });
  }

  // --- typed variable finals: ALWAYS snapshot-rerun keyed (§6.2) ---
  const finalsItem = findItems(responseItems, 'variableValues')[0];
  if (finalsItem !== undefined) {
    const finalsOk =
      finalsItem.values.length > 0 &&
      finalsItem.values.every((v) => {
        const actual = visibleRun.finalVariables[v.varId];
        return actual !== undefined && actual === v.value;
      });
    items.push({
      key: 'finals',
      label: '变量终值',
      verdict: finalsOk ? 'CORRECT' : 'REVISE',
      feedback: finalsOk ? undefined : FB_FINALS_REVISE,
    });
  }

  // --- branch trace (g3): typed vs recomputed checkpoint outcomes ---
  const branchItem = findItems(responseItems, 'branchTrace')[0];
  if (branchItem !== undefined) {
    const branchOk = branchItem.marks.every((m) => {
      const outcomes = visibleRun.branchOutcomes[m.checkpointId];
      return outcomes !== undefined && outcomes.length > 0 && outcomes.every((o) => o === m.outcome);
    });
    items.push({
      key: 'branch',
      label: '判断走向',
      verdict: branchOk ? 'CORRECT' : 'REVISE',
      feedback: branchOk ? undefined : FB_BRANCH_REVISE,
    });
  }

  // --- number checks ---
  // Card-shape-dependent checks (loop trip count) are SNAPSHOT-derived from
  // the run trace (true loop checks of the outermost FOR); authored expecteds
  // stay the REVIEW-reveal anchor for the canonical card.
  const derivedTrips = visibleRun.trace.filter((t) => t.kind === 'FOR_CHECK' && t.condResult === true).length;
  for (const check of entry.numberChecks ?? []) {
    const num = findItems(responseItems, 'numberWithUnit').find((n) => n.quantityId === check.itemId);
    const expected = check.itemId.endsWith('.trip-count') ? derivedTrips : check.expected;
    const ok = num !== undefined && num.value === expected;
    items.push({
      key: `number:${check.itemId}`,
      label: `数值判断（${check.itemId}）`,
      verdict: ok ? 'CORRECT' : 'REVISE',
      feedback: ok ? undefined : FB_NUMBER_REVISE,
    });
  }

  // --- concept checks ---
  for (const check of entry.conceptChecks ?? []) {
    const pick = findItems(responseItems, 'singleChoice').find((c) => c.selectionId === check.selectionId);
    const ok = pick !== undefined && pick.optionId === check.correctOptionId;
    const roundingMiss = !ok && pick !== undefined && entry.diagnostics?.divRounding !== undefined && /floor|round|decimal/.test(pick.optionId);
    if (roundingMiss && !diagnostics.includes('divRounding')) diagnostics.push('divRounding');
    items.push({
      key: `concept:${check.selectionId}`,
      label: '概念选择',
      verdict: ok ? 'CORRECT' : 'REVISE',
      feedback: ok ? undefined : roundingMiss ? entry.diagnostics!.divRounding : FB_CONCEPT_REVISE,
    });
  }

  // --- structural constraints ---
  if (entry.structural !== undefined) {
    const missing = entry.structural.requiredConstructs.filter((c) => !hasConstruct(snapshot.program, c));
    const tooLong = countStatements(snapshot.program) > entry.structural.maxProgramSteps;
    const tooManyOutputs = countOutputs(snapshot.program) > entry.structural.maxOutputLines;
    const structuralOk = missing.length === 0 && !tooLong && !tooManyOutputs;
    items.push({
      key: 'structural',
      label: '结构要求',
      verdict: structuralOk ? 'CORRECT' : 'REVISE',
      feedback: structuralOk ? undefined : FB_STRUCTURAL_REVISE,
    });
  }

  // --- REVIEW reveal (post-judging only; own-card values + hidden truths) ---
  reveal.output = visibleRun.lines.length ? visibleRun.lines.join('；') : '（无输出）';
  reveal.finals = Object.entries(visibleRun.finalVariables)
    .map(([k, v]) => `${k}=${v}`)
    .join('；');
  if (hiddenRuns.length > 0) {
    reveal.hidden = entry.hiddenCases.map((c) => `${c.caseId}：${c.expectedLines.join('，')}`).join('；');
  }
  if (entry.numberChecks?.some((c) => c.itemId.endsWith('.trip-count')) === true) {
    reveal.trips = String(derivedTrips);
  }

  const verdict: StepVerdict = items.every((i) => i.verdict === 'CORRECT') ? 'CORRECT' : 'REVISE';
  return finish(verdict, items, diagnostics, reveal);
}

function finish(
  verdict: StepVerdict,
  items: readonly StepJudgeItemResult[],
  diagnostics: readonly string[],
  reveal: Readonly<Record<string, string>>,
): StepJudgeResult {
  return { verdict, itemResults: items, diagnostics: [...diagnostics], reveal: { ...reveal } };
}

function unscorable(detail: string): StepJudgeResult {
  // Technical failure is UNSCORABLE, never "wrong" (LIFECYCLE §4).
  void detail;
  return {
    verdict: 'UNSCORABLE',
    itemResults: [{ key: 'program', label: '程序运行（教学模型）', verdict: 'REVISE', feedback: '判分暂时不可用，本次提交未被判定为错误。' }],
    diagnostics: [],
    reveal: {},
  };
}
