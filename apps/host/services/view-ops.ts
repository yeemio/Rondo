/**
 * Host-side VIEW_OPS implementation (A lane, R2 wiring).
 *
 * Each op projects B's persisted learning facts into the exact shapes C's UI
 * consumes (LearnerViewPort — baseline: modules/mock-client/store.ts). The
 * projections are field-aligned with the mock so the same UI runs unchanged
 * against mock and real backends; where B's persisted facts cannot express a
 * mock field the gap is honest (null / reduced entries), never fabricated —
 * see the CONTRACT_CHANGE_REQUIRED items in the wiring report:
 *  - reveal/diagnostics granularity is rule-derived (B feedback never leaks
 *    expected values, so REVIEW reveal is recomputed from the frozen rule
 *    data at view time);
 *  - migration scheduling (getMigration) returns null until B's server
 *    writes transferPlan rows (B shipped the repository, no planner yet);
 *  - registerExplanationRevision resolves the LATEST existing revision of
 *    the cycle (the write itself is learning.saveExplanation's job).
 *
 * Server-only module: no renderer import (boundary-checked).
 */
import { rondoError, type RondoError } from '../../../modules/contracts/public/errors';
import type { ServerContext } from '../../../modules/contracts/server/context';
import type {
  Repositories,
  RepoScope,
  StoragePort,
  LearningAttemptRecord,
  LearningCycleRecord,
  SubmissionRecord,
} from '../../../modules/contracts/server/storage';
import type { ContentServiceInternal } from '../../../modules/content';
import type { TaskRule, QuantityExpression, NumericRelationRule, ParameterIdentificationRule } from '../../../modules/contracts/server/rules';
import type { CylinderStateV1 } from '../../../modules/contracts/public/scene';
import type { RuleBodyV2 } from '../../../modules/contracts/server/rules';
import { makeBigRational, multiplyRational, fromExactRational, formatRoundedDecimal } from '../../../modules/learning/exact';
import { diameterRationalCm, rationalToDecimal } from '../../../modules/scenes/cylinder/geometry';

// ---------------------------------------------------------------------------
// Projection types (mirror adapters/desktop-client/view-port.ts — the C UI
// consumes the same field set through LearnerViewPort)
// ---------------------------------------------------------------------------

export interface EvaluationItemView {
  key: string;
  label: string;
  verdict: string;
  feedback?: string;
}
export interface EvaluationView {
  submissionId: string;
  seq: number;
  atMs: number;
  verdict: 'CORRECT' | 'REVISE';
  itemResults: EvaluationItemView[];
  diagnostics: string[];
  answerAssistanceActive: boolean;
}
export interface HintView {
  level: number;
  text: string;
  marksAnswerAssistance: boolean;
  atMs: number;
}
export interface ReviewCardView {
  taskId: string;
  taskTitle: string;
  phase: string;
  prediction: { claims: Array<{ propertyId: string; direction: string }>; uncertain: boolean; explanation?: string; atMs: number } | null;
  submissions: Array<{ submissionId: string; seq: number; verdict: string; atMs: number }>;
  evaluation: { verdict: string; itemResults: EvaluationItemView[] } | null;
  reveal: Record<string, string> | null;
  hints: Array<{ level: number; marksAnswerAssistance: boolean }>;
  assistance: Array<{ category: string; note: string; atMs: number }>;
  /** Family-aware confirmed state (cylinder V1/V2, gridboard, steps — mirrors view-port.ts). */
  snapshot: CylinderStateV1 | { radiusMm: number; heightMm: number; unrollPermille: number; section: string; selectedFaceIds: string[]; layerCount: number; visibleLayerCount: number } | { rows: number; cols: number; filled: number } | { program: unknown[]; inputs: Record<string, number>; cursorStep: number };
  initialState: { radiusMm: number; heightMm: number } | { rows: number; cols: number; filled: number } | { program: unknown[]; inputs: Record<string, number>; cursorStep: number };
}
export interface MigrationCardView {
  state: string;
  taskId: string;
  taskTitle: string;
  plannedAtMs: number;
  availableAtMs: number;
  nominalEndDays: number;
  remainingDays: number;
  startedAtMs?: number;
  observedAtMs?: number;
  actualIntervalDays?: number;
}
export interface TimelineDetailView {
  attemptId: string;
  status: string;
  events: Array<{
    eventId: string;
    seq: number;
    eventType: string;
    commandKind: string;
    occurredAtMs: number;
    payload?: Record<string, unknown>;
  }>;
}
export interface AttemptListItemView {
  attemptId: string;
  learnerId: string;
  releaseId: string;
  status: string;
  version: number;
  startedAtMs: number;
  finishedAtMs?: number;
}

interface BEvaluationFeedback {
  ruleKind?: 'PARAMETER_IDENTIFICATION_V1' | 'NUMERIC_RELATION_V1' | 'FAMILY_TRUTH_V1';
  scenarioMet?: boolean;
  wrongProperties?: string[];
  missingProperties?: string[];
  extraClaims?: string[];
  mappingMatched?: number;
  mappingTotal?: number;
  wrongPairIds?: string[];
  quantities?: Array<{ quantityId: string; submitted: boolean; valueOk: boolean; unitOk: boolean }>;
  /** FAMILY_TRUTH_V1 (integration W1): per-item results, diagnostic tags, REVIEW reveal. */
  itemResults?: Array<{ key: string; label: string; verdict: string; feedback?: string }>;
  diagnostics?: string[];
  reveal?: Record<string, string>;
  responseTypeOk?: boolean;
  detail?: string;
}

const QUANTITY_LABELS: Record<string, string> = {
  diameter: '直径数值（含单位）',
  height: '高度读数（含单位）',
  radius: '半径',
  'lateral-area': '侧面积数值+单位',
  circumference: '周长',
  section: '哪个切面能看到高',
};
const PROPERTY_ORDER = ['radius', 'diameter', 'height'] as const;
const PROPERTY_LABELS: Record<string, string> = { radius: '半径', diameter: '直径', height: '高度' };
const OBJECT_LABELS: Record<string, string> = {
  'cyl-part-upper-circle': '上底圆',
  'cyl-part-lower-circle': '下底圆',
  'cyl-part-height-line': '高',
  'cyl-part-base-circle': '底面圆周',
};
const UNIT_LABELS: Record<string, string> = { mm: 'mm', cm: 'cm', mm2: 'mm²', cm2: 'cm²' };
/** mm-base conversion factors (numerator/denominator of the multiply-by-ten powers). */
const UNIT_TO_BASE_MM: Record<string, readonly [number, number]> = {
  mm: [1, 1],
  cm: [10, 1],
  mm2: [1, 1],
  cm2: [100, 1],
};
/** reveal key by quantityId (C mock reveal key conventions). */
const REVEAL_QUANTITY_KEYS: Record<string, string> = {
  radius: 'radius',
  diameter: 'value',
  height: 'value',
  'lateral-area': 'area',
  circumference: 'circumference',
};

function edgeNumber(netEdgeId: string): number {
  const match = /(\d+)$/.exec(netEdgeId);
  return match ? Number(match[1]) : 0;
}

/** B-internal seam (B-INTEGRATION §内部缝): every submission of a cycle. */
function allSubmissions(repos: Repositories, scope: RepoScope, cycleId: string): Promise<SubmissionRecord[]> {
  const lister = repos.submission as Repositories['submission'] & {
    listAllByCycle?: (scope: RepoScope, cycleId: string) => Promise<SubmissionRecord[]>;
  };
  if (typeof lister.listAllByCycle !== 'function') {
    throw rondoError('PERSISTENCE_FAILED', 'storage lacks submission listing capability');
  }
  return lister.listAllByCycle(scope, cycleId);
}

function unauthenticated(): RondoError {
  return rondoError('UNAUTHENTICATED', '没有活动会话。');
}

function isRondoErrorLike(err: unknown): err is RondoError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'message' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    typeof (err as { message: unknown }).message === 'string' &&
    !('rondo' in err)
  );
}

/** Wraps a view call so B's plain-object RondoError throwables keep their code. */
export async function callView<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isRondoErrorLike(err)) {
      const wrapped = new Error(`${err.code}: ${err.message}`) as Error & { rondo: RondoError };
      wrapped.rondo = err;
      throw wrapped;
    }
    throw err;
  }
}

export interface ViewOpsDeps {
  readonly storage: StoragePort;
  readonly content: ContentServiceInternal;
  readonly now: () => number;
}

export class ViewOps {
  constructor(private readonly deps: ViewOpsDeps) {}

  // -- authorization helpers ---------------------------------------------------

  private async visibleAttempt(scope: RepoScope, repos: Repositories, ctx: ServerContext, attemptId: string): Promise<LearningAttemptRecord> {
    const attempt = await repos.learningAttempt.findById(scope, attemptId);
    if (attempt === null) throw rondoError('INVALID_OPERATION', `尝试不存在。`);
    if (attempt.familyId !== ctx.familyId) throw rondoError('FORBIDDEN', '对象不可见。');
    if (ctx.role === 'LEARNER' && attempt.learnerId !== ctx.learnerId) throw rondoError('FORBIDDEN', '对象不可见。');
    return attempt;
  }

  private async visibleCycle(scope: RepoScope, repos: Repositories, ctx: ServerContext, cycleId: string): Promise<{ cycle: LearningCycleRecord; attempt: LearningAttemptRecord }> {
    const cycle = await repos.learningCycle.findById(scope, cycleId);
    if (cycle === null) throw rondoError('INVALID_OPERATION', 'cycle 不存在');
    const attempt = await this.visibleAttempt(scope, repos, ctx, cycle.attemptId);
    return { cycle, attempt };
  }

  private async instanceOf(scope: RepoScope, repos: Repositories, cycle: LearningCycleRecord) {
    const instance = await repos.questionInstance.findById(scope, cycle.questionInstanceId);
    if (instance === null) throw rondoError('PERSISTENCE_FAILED', 'questionInstance 不可读。');
    return instance;
  }

  // -- evaluation core ----------------------------------------------------------

  private itemRowsFromFeedback(outcome: string, feedback: BEvaluationFeedback): { itemResults: EvaluationItemView[]; diagnostics: string[] } {
    const itemResults: EvaluationItemView[] = [];
    const diagnostics: string[] = [];
    const verdictFor = (ok: boolean): 'CORRECT' | 'REVISE' => (ok ? 'CORRECT' : 'REVISE');
    if (outcome === 'UNSCORABLE') {
      diagnostics.push('判分暂不可用');
      itemResults.push({
        key: 'evaluation',
        label: '判定',
        verdict: 'REVISE',
        feedback: feedback.detail ?? '判分暂时不可用，本次提交未被判定为错误。',
      });
      return { itemResults, diagnostics };
    }
    if (feedback.ruleKind === 'PARAMETER_IDENTIFICATION_V1') {
      const wrong = feedback.wrongProperties ?? [];
      const missing = feedback.missingProperties ?? [];
      const ok = wrong.length === 0 && missing.length === 0 && feedback.scenarioMet !== false;
      itemResults.push({
        key: 'claims',
        label: '方向判断',
        verdict: verdictFor(ok),
        ...(ok ? {} : { feedback: feedback.detail ?? '再看确认后的尺寸表，把变化了和没变化的量分开。' }),
      });
    } else if (feedback.ruleKind === 'NUMERIC_RELATION_V1') {
      const total = feedback.mappingTotal ?? 0;
      if (total > 0) {
        const matched = feedback.mappingMatched ?? 0;
        itemResults.push({
          key: 'pairing',
          label: '配对',
          verdict: verdictFor(matched === total && (feedback.wrongPairIds ?? []).length === 0),
          ...(matched === total ? {} : { feedback: feedback.detail ?? '有一条边再回卷确认一下' }),
        });
      }
      for (const quantity of feedback.quantities ?? []) {
        const ok = quantity.valueOk && quantity.unitOk;
        itemResults.push({
          key: quantity.quantityId,
          label: QUANTITY_LABELS[quantity.quantityId] ?? quantity.quantityId,
          verdict: verdictFor(ok),
          ...(ok ? {} : { feedback: quantity.submitted && quantity.valueOk && !quantity.unitOk ? '数值对了，再看看单位。' : '再算一遍，注意单位与数值。' }),
        });
        if (quantity.submitted && quantity.valueOk && !quantity.unitOk) diagnostics.push('unit-mismatch');
      }
    } else if (feedback.ruleKind === 'FAMILY_TRUTH_V1') {
      for (const item of feedback.itemResults ?? []) {
        itemResults.push({
          key: item.key,
          label: item.label,
          verdict: item.verdict,
          ...(item.feedback === undefined ? {} : { feedback: item.feedback }),
        });
      }
      diagnostics.push(...(feedback.diagnostics ?? []));
      if (itemResults.length === 0) {
        itemResults.push({ key: 'evaluation', label: '判定', verdict: 'REVISE', feedback: feedback.detail ?? '判定信息不可读。' });
      }
    } else {
      itemResults.push({ key: 'evaluation', label: '判定', verdict: 'REVISE', feedback: feedback.detail ?? '判定信息不可读。' });
    }
    return { itemResults, diagnostics };
  }

  // -- REVIEW reveal (recomputed from frozen rule data; only at REVIEW) ---------

  private quantityValueText(expression: QuantityExpression, snapshot: CylinderStateV1, decimals: number, unitId: string): string {
    let acc = makeBigRational(1n, 1n);
    for (const factor of expression.factors) {
      if ('factor' in factor) {
        acc = multiplyRational(acc, makeBigRational(BigInt(factor.factor === 'radiusMm' ? snapshot.radiusMm : snapshot.heightMm), 1n));
      } else {
        acc = multiplyRational(acc, fromExactRational(factor));
      }
    }
    // The expression evaluates in the mm base; convert into the display unit.
    const toBase = UNIT_TO_BASE_MM[unitId];
    if (toBase !== undefined) {
      acc = multiplyRational(acc, makeBigRational(BigInt(toBase[1]), BigInt(toBase[0])));
    }
    const unitLabel = UNIT_LABELS[unitId] ?? unitId;
    return `${formatRoundedDecimal(acc, { mode: 'HALF_UP', decimalPlaces: decimals })} ${unitLabel}`;
  }

  private buildReveal(rule: TaskRule, responseSchemaId: string, snapshot: CylinderStateV1): Record<string, string> {
    const reveal: Record<string, string> = {};
    if (rule.ruleKind === 'PARAMETER_IDENTIFICATION_V1') {
      const ordered = PROPERTY_ORDER.flatMap((p) =>
        (rule as ParameterIdentificationRule).expectedJudgments.filter((j) => j.propertyId === p),
      );
      reveal.claims = ordered.map((j) => `${j.propertyId}: ${j.direction}`).join('; ');
      if (responseSchemaId === 'resp.l1.predictDimension.v1') {
        const diameterClaim = ordered.find((j) => j.propertyId === 'diameter');
        if (diameterClaim) reveal.direction = diameterClaim.direction;
        reveal.value = `${rationalToDecimal(diameterRationalCm(snapshot.radiusMm), 1)} cm`;
      } else if (responseSchemaId === 'resp.l1.dimensionRead.v1') {
        const heightClaim = ordered.find((j) => j.propertyId === 'height');
        if (heightClaim) reveal.direction = heightClaim.direction;
        reveal.value = `${rationalToDecimal({ numerator: snapshot.heightMm, denominator: 10 }, 1)} cm`;
        reveal.section = '轴截面（沿轴切开）';
      }
      return reveal;
    }
    const numeric = rule as NumericRelationRule;
    return this.revealFromEdgeMappingAndQuantities(numeric.expectedEdgeMapping, numeric.quantityChecks, snapshot);
  }

  /** v1/v2 shared: mapping-style reveal (pairing or direction) + quantity values. */
  private revealFromEdgeMappingAndQuantities(
    expectedEdgeMapping: ReadonlyArray<{ cylinderObjectId: string; netEdgeId: string }>,
    quantityChecks: ReadonlyArray<{
      quantityId: string;
      expected: QuantityExpression;
      acceptedUnitIds: readonly string[];
      rounding: { mode: 'HALF_UP' | 'HALF_EVEN' | 'TRUNCATE'; decimalPlaces: number };
    }>,
    snapshot: CylinderStateV1,
  ): Record<string, string> {
    const reveal: Record<string, string> = {};
    const directionStyle = expectedEdgeMapping.some((p) => p.cylinderObjectId.includes('base-circle'));
    if (directionStyle) {
      const circleEdges = expectedEdgeMapping
        .filter((p) => p.cylinderObjectId.includes('circle'))
        .map((p) => p.netEdgeId)
        .sort((a, b) => edgeNumber(a) - edgeNumber(b));
      const heightEdges = expectedEdgeMapping
        .filter((p) => p.cylinderObjectId.includes('height'))
        .map((p) => p.netEdgeId)
        .sort((a, b) => edgeNumber(a) - edgeNumber(b));
      reveal.circleEdges = circleEdges.join('、');
      reveal.heightEdges = heightEdges.join('、');
    } else if (expectedEdgeMapping.length > 0) {
      const pairs = [...expectedEdgeMapping].sort((a, b) => edgeNumber(a.netEdgeId) - edgeNumber(b.netEdgeId));
      reveal.pairing = pairs
        .map((p) => `边${edgeNumber(p.netEdgeId)}→${OBJECT_LABELS[p.cylinderObjectId] ?? p.cylinderObjectId}`)
        .join('；');
    }
    for (const check of quantityChecks) {
      const key = REVEAL_QUANTITY_KEYS[check.quantityId] ?? check.quantityId;
      reveal[key] = this.quantityValueText(check.expected, snapshot, check.rounding.decimalPlaces, check.acceptedUnitIds[0] ?? 'cm');
    }
    return reveal;
  }

  /** v2 (RULE_DSL_VERSION '2') reveal from the C-line rule truth body. */
  private buildRevealV2(
    rule: RuleBodyV2,
    taskId: string,
    givens: { radiusMm: number; heightMm: number },
    snapshot: CylinderStateV1,
    responseItems: readonly unknown[],
  ): Record<string, string> {
    const directionOf = (from: number, to: number): string => (to > from ? 'INCREASE' : to < from ? 'DECREASE' : 'UNCHANGED');
    const actual: Record<string, string> = {
      radius: directionOf(givens.radiusMm, snapshot.radiusMm),
      diameter: directionOf(givens.radiusMm, snapshot.radiusMm),
      height: directionOf(givens.heightMm, snapshot.heightMm),
    };
    switch (rule.kind) {
      case 'PARAM_CHANGE_CLASSIFY':
      case 'NUMERIC_READBACK':
      case 'PARAM_IDENTIFY': {
        const branches = rule.rules;
        const match = branches.find((b) => b.expectedJudgments.every((j) => actual[j.propertyId] === j.direction)) ?? branches[0];
        const ordered = PROPERTY_ORDER.flatMap((p) => match.expectedJudgments.filter((j) => j.propertyId === p));
        const reveal: Record<string, string> = {
          claims: ordered.map((j) => `${j.propertyId}: ${j.direction}`).join('; '),
        };
        const entry = rule.kind === 'PARAM_CHANGE_CLASSIFY' ? undefined : rule.numericReadback[taskId];
        if (entry !== undefined) {
          const propertyForQuantity: Record<string, string> = { diameter: 'diameter', height: 'height', radius: 'radius' };
          const claim = ordered.find((j) => j.propertyId === (propertyForQuantity[entry.quantityId] ?? 'diameter'));
          if (claim) reveal.direction = claim.direction;
          reveal.value = `${entry.expectedCm} cm`;
          if (entry.sectionPair !== undefined) {
            reveal.section = entry.sectionPair.rightId === 'section-view-axial' ? '轴截面（沿轴切开）' : entry.sectionPair.rightId;
          }
        }
        return reveal;
      }
      case 'EDGE_DIRECTION':
      case 'EDGE_PAIRING':
        return this.revealFromEdgeMappingAndQuantities(rule.expectedEdgeMapping, [], snapshot);
      case 'LATERAL_AREA':
        return this.revealFromEdgeMappingAndQuantities([], rule.quantityChecks, snapshot);
      case 'TRANSFER_CHECK': {
        // Branch chosen the same way the evaluator does: best mapping overlap
        // with the submitted response.
        let best = rule.rules[0];
        let bestScore = -1;
        for (const branch of rule.rules) {
          const expected = new Set(branch.expectedEdgeMapping.map((p) => `${p.cylinderObjectId}->${p.netEdgeId}`));
          let score = 0;
          for (const item of responseItems) {
            const pairs = (item as { pairs?: Array<{ leftId: string; rightId: string }> }).pairs;
            if (!Array.isArray(pairs)) continue;
            for (const pair of pairs) {
              if (expected.has(`${pair.leftId}->${pair.rightId}`)) score += 1;
            }
          }
          if (score > bestScore) {
            bestScore = score;
            best = branch;
          }
        }
        return this.revealFromEdgeMappingAndQuantities(best.expectedEdgeMapping, best.quantityChecks, snapshot);
      }
    }
  }

  // -- ops ------------------------------------------------------------------------

  async getEvaluation(ctx: ServerContext, cycleId: string): Promise<EvaluationView | null> {
    const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
    return this.deps.storage.read(async (repos) => {
      await this.visibleCycle(scope, repos, ctx, cycleId);
      const subs = await allSubmissions(repos, scope, cycleId);
      const last = subs[subs.length - 1];
      if (last === undefined) return null;
      const evaluation = await repos.evaluation.findOriginalBySubmission(scope, last.submissionId);
      if (evaluation === null) return null;
      const feedback = JSON.parse(evaluation.feedbackJson) as BEvaluationFeedback;
      const assistance = JSON.parse(last.assistanceSnapshotJson) as { answerHintPresented?: boolean };
      const { itemResults, diagnostics } = this.itemRowsFromFeedback(evaluation.outcome, feedback);
      return {
        submissionId: last.submissionId,
        seq: subs.length,
        atMs: last.at,
        verdict: evaluation.outcome === 'CORRECT' ? 'CORRECT' : 'REVISE',
        itemResults,
        diagnostics,
        answerAssistanceActive: assistance.answerHintPresented === true,
      };
    });
  }

  async getHints(ctx: ServerContext, cycleId: string): Promise<HintView[]> {
    const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
    return this.deps.storage.read(async (repos) => {
      const { cycle } = await this.visibleCycle(scope, repos, ctx, cycleId);
      const instance = await this.instanceOf(scope, repos, cycle);
      const taskSpec = this.deps.content.getTaskSpec(instance.releaseId, instance.taskId);
      const presented = await repos.hintPresentation.listByCycle(scope, cycleId);
      const views: HintView[] = [];
      for (const hint of presented) {
        const gate = taskSpec?.manifest.private.hintGateTable.find((g) => g.taskId === instance.taskId && g.hintLevel === hint.level);
        const hintContent = gate ? this.deps.content.getHintContent(instance.releaseId, gate.contentRef) : null;
        views.push({
          level: hint.level,
          text: hintContent?.text ?? '（提示内容不可用）',
          marksAnswerAssistance: hintContent?.revealsAnswer === true,
          atMs: hint.at,
        });
      }
      return views;
    });
  }

  async getReviewCard(ctx: ServerContext, cycleId: string): Promise<ReviewCardView> {
    const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
    return this.deps.storage.read(async (repos) => {
      const { cycle, attempt } = await this.visibleCycle(scope, repos, ctx, cycleId);
      const instance = await this.instanceOf(scope, repos, cycle);
      const taskSpec = this.deps.content.getTaskSpec(instance.releaseId, instance.taskId);
      if (taskSpec === null) throw rondoError('CONTENT_UNAVAILABLE', `内容任务不可用：${instance.taskId}`);
      const predictionRow = await repos.prediction.findFirst(scope, cycleId);
      const predictionContent = predictionRow
        ? (JSON.parse(predictionRow.contentJson) as { claims?: Array<{ propertyId: string; direction: string }>; statement?: string })
        : null;
      const subs = await allSubmissions(repos, scope, cycleId);
      const submissionViews: ReviewCardView['submissions'] = [];
      let latestEvaluation: { outcome: string; feedback: BEvaluationFeedback; snapshot: CylinderStateV1 } | null = null;
      for (let i = 0; i < subs.length; i += 1) {
        const sub = subs[i];
        const evaluation = await repos.evaluation.findOriginalBySubmission(scope, sub.submissionId);
        submissionViews.push({
          submissionId: sub.submissionId,
          seq: i + 1,
          verdict: evaluation?.outcome ?? 'UNJUDGED',
          atMs: sub.at,
        });
        if (evaluation !== null) {
          latestEvaluation = {
            outcome: evaluation.outcome,
            feedback: JSON.parse(evaluation.feedbackJson) as BEvaluationFeedback,
            snapshot: JSON.parse(sub.stateSnapshotJson) as CylinderStateV1,
          };
        }
      }
      const { itemResults } = latestEvaluation
        ? this.itemRowsFromFeedback(latestEvaluation.outcome, latestEvaluation.feedback)
        : { itemResults: [] as EvaluationItemView[] };
      const givens = JSON.parse(cycle.givensJson) as { radiusMm: number; heightMm: number } & Record<string, unknown>;
      let reveal: Record<string, string> | null = null;
      if (cycle.phase === 'REVIEW' && latestEvaluation !== null) {
        const ruleV2 = this.deps.content.getRuleBodyV2(instance.releaseId, instance.taskId);
        if (latestEvaluation.feedback.ruleKind === 'FAMILY_TRUTH_V1') {
          // Family truths compute their reveal at judge time from the frozen
          // rule data (grid/steps judges) or the formal truth entries (L3/L4);
          // it only ever surfaces here, at REVIEW.
          reveal = latestEvaluation.feedback.reveal ?? null;
        } else if (ruleV2 !== null) {
          const lastResponse = JSON.parse(subs[subs.length - 1].responseJson) as unknown[];
          reveal = this.buildRevealV2(ruleV2, instance.taskId, givens, latestEvaluation.snapshot, lastResponse);
        } else {
          const ruleSet = this.deps.content.resolveRules(instance.releaseId, instance.taskId);
          const rule = ruleSet !== null ? ruleSet.rules[0] : null;
          if (rule !== null) reveal = this.buildReveal(rule, taskSpec.file.responseSchemaId, latestEvaluation.snapshot);
        }
      }
      const presented = await repos.hintPresentation.listByCycle(scope, cycleId);
      const hintViews: Array<{ level: number; marksAnswerAssistance: boolean }> = [];
      for (const hint of presented) {
        const gate = taskSpec.manifest.private.hintGateTable.find((g) => g.taskId === instance.taskId && g.hintLevel === hint.level);
        const hintContent = gate ? this.deps.content.getHintContent(instance.releaseId, gate.contentRef) : null;
        hintViews.push({ level: hint.level, marksAnswerAssistance: hintContent?.revealsAnswer === true });
      }
      const assistanceRows = await repos.assistanceRecord.listByAttempt(scope, attempt.attemptId);
      return {
        taskId: instance.taskId,
        taskTitle: taskSpec.file.title,
        phase: cycle.phase,
        prediction: predictionRow
          ? {
              claims: predictionContent?.claims ?? [],
              uncertain: predictionRow.uncertain,
              ...(predictionRow.noteText !== null ? { explanation: predictionRow.noteText } : predictionContent?.statement ? {explanation:predictionContent.statement} : {}),
              atMs: predictionRow.recordedAt,
            }
          : null,
        submissions: submissionViews,
        evaluation: latestEvaluation
          ? { verdict: latestEvaluation.outcome === 'CORRECT' ? 'CORRECT' : 'REVISE', itemResults }
          : null,
        reveal,
        hints: hintViews,
        assistance: assistanceRows.map((r) => ({ category: r.category, note: r.note, atMs: r.at })),
        snapshot: JSON.parse(cycle.confirmedStateJson) as ReviewCardView['snapshot'],
        initialState:
          'radiusMm' in givens
            ? { radiusMm: givens.radiusMm, heightMm: givens.heightMm }
            : (givens as ReviewCardView['initialState']),
      };
    });
  }

  /**
   * Migration scheduling projection. B's schema ships transferPlan storage but
   * the learning server does not create plans yet; until that lands this
   * honestly returns null (the UI shows its "not scheduled yet" state).
   */
  async getMigration(_ctx: ServerContext, _learnerId: string): Promise<MigrationCardView | null> {
    void _ctx;
    void _learnerId;
    return null;
  }

  async getTimelineDetail(ctx: ServerContext, attemptId: string): Promise<TimelineDetailView> {
    const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
    return this.deps.storage.read(async (repos) => {
      const attempt = await this.visibleAttempt(scope, repos, ctx, attemptId);
      const events = await repos.learningEvent.pageBySeq(scope, { attemptId, afterSeq: 0, limit: 1_000_000 });
      const detail: TimelineDetailView = { attemptId, status: attempt.attemptStatus, events: [] };
      for (const event of events) {
        const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
        // View-layer joins (data joins only, no re-derivation): the mock's
        // timeline payload carried the prediction claims / verdict / free-text
        // length; B persists those as facts beside the event.
        if (event.eventType === 'PREDICTION_RECORDED' && typeof payload['cycleId'] === 'string') {
          const prediction = await repos.prediction.findFirst(scope, payload['cycleId']);
          if (prediction !== null) {
            const content = JSON.parse(prediction.contentJson) as { claims?: Array<{ propertyId: string; direction: string }> };
            payload['claims'] = content.claims ?? [];
            payload['uncertain'] = prediction.uncertain;
            if (prediction.noteText !== null) payload['explanation'] = prediction.noteText;
          }
        }
        if (event.eventType === 'SUBMISSION_RECORDED' && typeof payload['submissionId'] === 'string') {
          const evaluation = await repos.evaluation.findOriginalBySubmission(scope, payload['submissionId']);
          if (evaluation !== null) payload['verdict'] = evaluation.outcome;
        }
        if (event.eventType === 'EXPLANATION_SAVED' && typeof payload['revisionId'] === 'string') {
          const revisions = await repos.explanationRevision.listByCycle(scope, String(payload['cycleId'] ?? ''));
          const revision = revisions.find((r) => r.revisionId === payload['revisionId']);
          if (revision !== undefined) {
            payload['freeTextLength'] = revision.freeText.length;
            payload['transcribedByGuardian'] = revision.scribe;
          }
        }
        detail.events.push({
          eventId: event.eventId,
          seq: event.seq,
          eventType: event.eventType,
          commandKind: event.commandKind,
          occurredAtMs: event.occurredAt,
          payload,
        });
      }
      return detail;
    });
  }

  async listLearners(ctx: ServerContext): Promise<Array<{ learnerId: string; alias: string }>> {
    const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
    return this.deps.storage.read(async (repos) => {
      const learners = await repos.learner.listByFamily(scope, ctx.familyId);
      return learners.map((l) => ({ learnerId: l.learnerId, alias: l.alias }));
    });
  }

  async listAttempts(ctx: ServerContext, learnerId: string | undefined): Promise<AttemptListItemView[]> {
    const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
    return this.deps.storage.read(async (repos) => {
      const familyLearners = await repos.learner.listByFamily(scope, ctx.familyId);
      const target =
        learnerId !== undefined
          ? familyLearners.filter((l) => l.learnerId === learnerId)
          : ctx.role === 'LEARNER' && ctx.learnerId !== undefined
            ? familyLearners.filter((l) => l.learnerId === ctx.learnerId)
            : familyLearners;
      if (learnerId !== undefined && target.length === 0) throw rondoError('FORBIDDEN', '该学习者不属于当前家庭。');
      const attempts: LearningAttemptRecord[] = [];
      for (const learner of target) {
        attempts.push(...(await repos.learningAttempt.listByLearner(scope, learner.learnerId)));
      }
      attempts.sort((a, b) => a.startedAt - b.startedAt);
      return attempts.map((a) => ({
        attemptId: a.attemptId,
        learnerId: a.learnerId,
        releaseId: a.releaseId,
        status: a.attemptStatus,
        version: a.version,
        startedAtMs: a.startedAt,
        ...(a.endedAt !== null ? { finishedAtMs: a.endedAt } : {}),
      }));
    });
  }

  /**
   * Resolves the latest existing explanation revision of the cycle for the
   * annotate flow (the write itself is learning.saveExplanation's command;
   * this is the revision REF lookup C's RubricForm needs).
   */
  async registerExplanationRevision(ctx: ServerContext, cycleId: string): Promise<string> {
    const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
    return this.deps.storage.read(async (repos) => {
      await this.visibleCycle(scope, repos, ctx, cycleId);
      const revisions = await repos.explanationRevision.listByCycle(scope, cycleId);
      const latest = revisions[revisions.length - 1];
      if (latest === undefined) throw rondoError('INVALID_OPERATION', '解释不存在');
      return latest.revisionId;
    });
  }

  /** The scope hash of the newest PREPARED deletion (the two-phase confirm input). */
  async getLastDeletionScopeHash(ctx: ServerContext): Promise<string | null> {
    const scope = { familyId: ctx.familyId, actorId: ctx.actorId };
    return this.deps.storage.read(async (repos) => {
      const lister = repos.dataOperation as Repositories['dataOperation'] & {
        listByFamilyAndKind?: (scope: RepoScope, kind: 'EXPORT' | 'DELETION') => Promise<Array<{ phase: string; scopeHash: string }>>;
      };
      if (typeof lister.listByFamilyAndKind !== 'function') {
        throw rondoError('PERSISTENCE_FAILED', 'storage lacks data-operation listing capability');
      }
      const ops = await lister.listByFamilyAndKind(scope, 'DELETION');
      const prepared = ops.filter((o) => o.phase === 'PREPARED');
      return prepared[prepared.length - 1]?.scopeHash ?? null;
    });
  }

  nowMs(): number {
    return this.deps.now();
  }
}
