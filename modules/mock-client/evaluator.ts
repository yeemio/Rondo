/**
 * MOCK_ONLY deterministic evaluator — the dev-side stand-in for B's learning
 * server judging. Reads ONLY private rule/instance data + the frozen public
 * task; computes with exact rationals (pi = 157/50), never floats-as-tolerance
 * (SCENE-CONTRACTS §2; contracts/server/rules.ts).
 *
 * Where the frozen two-family rule DSL cannot express a judgment the private
 * rule file carries it in `pendingDsl` (named reasons — see the C report's
 * CONTRACT_CHANGE_REQUIRED items). This evaluator consumes both blocks; it is
 * data-driven, no executed content strings.
 */
import type { StructuredResponseItem } from '../contracts/public/envelope';
import type { CylinderStateV1, CylinderStateV2 } from '../contracts/public/scene';
import type { GridBoardStateV1 } from '../contracts/public/scene-gridboard';
import type { StepProgramStateV1 } from '../contracts/public/scene-steps';
import { judgeGridTask } from '../scenes/gridboard/judge';
import { judgeStepTask } from '../scenes/steps/judge';
import {
  circleAreaRationalCm2,
  diameterRationalCm,
  lateralAreaRationalCm2,
  layerThicknessRationalMm,
  radiusRationalCm,
  rationalToDecimal,
  volumeRationalCm3,
} from '../scenes/cylinder/geometry';
import {
  getBindingRuleId,
  getFrozenInstance,
  getRule,
  getTask,
  TASK_ENABLED_SEGMENTS,
  type FrozenInstance,
  type PublicTask,
} from './contentLoader';
import { getThemesRuleEntry, hasThemesTask } from './contentLoaderThemes';
import { getCppRuleBody, hasCppTask } from './contentLoaderCpp';

export type Verdict = 'CORRECT' | 'REVISE';

export interface ItemResult {
  key: string;
  label: string;
  verdict: Verdict;
  /** restricted feedback — never reveals the expected value */
  feedback?: string;
}

export interface EvaluationResult {
  verdict: Verdict;
  itemResults: ItemResult[];
  diagnostics: string[];
  /** answer reveal — surfaced ONLY after the cycle reaches REVIEW */
  reveal: Record<string, string>;
  answerAssistanceActive: boolean;
}

type Rational = { numerator: number; denominator: number };

function mul(a: Rational, b: Rational): Rational {
  return { numerator: a.numerator * b.numerator, denominator: a.denominator * b.denominator };
}
function add(a: Rational, b: Rational): Rational {
  return {
    numerator: a.numerator * b.denominator + b.numerator * a.denominator,
    denominator: a.denominator * b.denominator,
  };
}
function eqRational(a: Rational, b: Rational): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

/** decimal string from a JSON number, trailing zeros kept as typed */
function numberToRational(v: number): Rational {
  const s = Number.isFinite(v) ? String(v) : 'NaN';
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [intPart, fracPart = ''] = body.split('.');
  const digits = intPart + fracPart;
  const r = { numerator: Number(digits), denominator: 10 ** fracPart.length };
  return neg ? { numerator: -r.numerator, denominator: r.denominator } : r;
}

/** normalize a numeric answer to cm (length) or cm² (area) */
function normalizeToCm(value: number, unitId: string): Rational | null {
  if (unitId === 'cm') return numberToRational(value);
  if (unitId === 'mm') {
    const r = numberToRational(value);
    return { numerator: r.numerator, denominator: r.denominator * 10 };
  }
  return null; // unknown/area mismatch handled by caller
}
function normalizeToCm2(value: number, unitId: string): Rational | null {
  if (unitId === 'cm2') return numberToRational(value);
  if (unitId === 'mm2') {
    const r = numberToRational(value);
    return { numerator: r.numerator, denominator: r.denominator * 100 };
  }
  return null;
}
function normalizeToCm3(value: number, unitId: string): Rational | null {
  if (unitId === 'cm3') return numberToRational(value);
  return null;
}
function dec(r: Rational): string {
  return rationalToDecimal({ numerator: Math.trunc(r.numerator), denominator: Math.trunc(r.denominator) }, 2);
}

const FACE_IDS = ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'] as const;
const L3_FB = {
  faceSetRevise: '再读一遍条件：这个包装上面开口吗？底下要不要纸？',
  missingLower: '无盖说的是上面开口——再看看底下要不要纸。',
  snapshotMismatch: '先把场景里的选面改成你答案里的样子，再提交。',
  numericRevise: '先分面，再把每个面的面积加起来。',
  unitRevise: '数值对了，再看看单位。',
  oneLidMissing: '封口罐有几个圆面？再数一遍',
  lidsMissing: '封口罐有几个圆面？再数一遍',
  doubleSide: '多用的是圆面还是侧面翻倍？',
  adviceRejected: '再数一数封口罐有几个圆面',
  invariantRevise: '层数只是把同样的东西切得更薄——累计表最后一行变了没有？',
  activityRevise: '先把两种层数都装一遍看看。',
  activityReviseG3: '两个方案都要在罐子上试一遍',
  boundaryRevise: '超过 100 的那一层和还没超过的上一层，各再看一眼。',
  cumulativeRevise: '累计要数到你自己选的那一层。',
  misCircumferenceTimesH: '先想底面：罐子靠哪个面站着？那一面是圆的什么量',
  misPiRh: '底面积里半径用了几次？',
  misLinearChoice: '两个方案各算一遍底面积再比——别只看加的厘米数',
  volumeRevise: '先算底面积，再乘高',
  ratioRevise: '半径加倍时底面积怎么变？再乘同一个高看看',
  paramReadRevise: '半径和直径/周长的关系再倒过来用一次。',
};

/** Confirmed-operation activity during the cycle (for L4 activity checks). */
export interface CycleActivity {
  layerCountValues: number[];
  visibleLayerCountValues: number[];
  visibleLayerCountApplies: number;
  setDimensionAxes: string[];
  selectFacesApplies: number;
}
export const EMPTY_ACTIVITY: CycleActivity = {
  layerCountValues: [],
  visibleLayerCountValues: [],
  visibleLayerCountApplies: 0,
  setDimensionAxes: [],
  selectFacesApplies: 0,
};

const PROPERTY_ORDER = ['radius', 'diameter', 'height'] as const;
const STANDARD_PAIRING: Record<string, string> = {
  'net-edge-1': 'cyl-part-height-line',
  'net-edge-2': 'cyl-part-upper-circle',
  'net-edge-3': 'cyl-part-height-line',
  'net-edge-4': 'cyl-part-lower-circle',
};
const STANDARD_DIRECTION: Record<string, string> = {
  'net-edge-1': 'cyl-part-height-line',
  'net-edge-2': 'cyl-part-base-circle',
  'net-edge-3': 'cyl-part-height-line',
  'net-edge-4': 'cyl-part-base-circle',
};

const FB = {
  genericRevise: '再看一遍：对照场景和题目条件检查你的作答。',
  numericRevise: '再算一遍，注意先算周长再乘高。',
  unitRevise: '数值对了，再看看单位。',
  baseAreaAdded: '再检查：这道题只要侧面的面积，底面要算进去吗？',
  pairingRevise: '再看与底面圆相接的边',
  pairingReviseAlt: '有一条边再回卷确认一下',
  directionRevise: '回卷一小段，盯住一条编号边看它贴着谁。',
  propertyRevise: '再看确认后的尺寸表，把变化了和没变化的量分开。',
  sectionRevise: '再分别切一次两种切面，找一找哪个切面里有和高一样长的边。',
};

function claimsByProperty(items: StructuredResponseItem[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    if (item.kind === 'propertyJudgments') {
      for (const c of item.claims) map.set(c.propertyId, c.direction);
    }
  }
  return map;
}

function mappingPairs(items: StructuredResponseItem[]): Array<{ leftId: string; rightId: string }> {
  const out: Array<{ leftId: string; rightId: string }> = [];
  for (const item of items) {
    if (item.kind === 'objectMapping') out.push(...item.pairs);
  }
  return out;
}

function mappingItems(items: StructuredResponseItem[]): Array<{ pairs: Array<{ leftId: string; rightId: string }> }> {
  const out: Array<{ pairs: Array<{ leftId: string; rightId: string }> }> = [];
  for (const item of items) {
    if (item.kind === 'objectMapping') out.push({ pairs: item.pairs });
  }
  return out;
}

function numericItems(items: StructuredResponseItem[]): Array<{ quantityId: string; value: number; unitId: string }> {
  const out: Array<{ quantityId: string; value: number; unitId: string }> = [];
  for (const item of items) {
    if (item.kind === 'numberWithUnit') out.push({ quantityId: item.quantityId, value: item.value, unitId: item.unitId });
  }
  return out;
}

/**
 * Main entry. `snapshot` is the confirmed scene state frozen at submission.
 * `activity` carries confirmed-operation counts for L4 activity checks
 * (rule.cylLayers.* pendingDsl activity blocks; defaults to none).
 */
export function evaluateResponse(
  taskId: string,
  response: StructuredResponseItem[],
  sceneState: CylinderStateV1 | CylinderStateV2 | GridBoardStateV1 | StepProgramStateV1,
  activity: CycleActivity = EMPTY_ACTIVITY,
): EvaluationResult {
  // themes.micro.v1 / themes.frac.v1: GRID_TASK_TRUTH recomputation via the
  // shared pure judge (rules are data; same function the product Host calls).
  if (hasThemesTask(taskId)) {
    const { entry } = getThemesRuleEntry(taskId);
    const judged = judgeGridTask({ taskId, entry, snapshot: sceneState as Parameters<typeof judgeGridTask>[0]['snapshot'], responseItems: response });
    return {
      verdict: judged.verdict,
      itemResults: judged.itemResults.map((r) => ({
        key: r.key,
        label: r.label,
        verdict: r.verdict,
        feedback: r.feedback,
      })),
      diagnostics: [...judged.diagnostics],
      reveal: { ...judged.reveal },
      answerAssistanceActive: false,
    };
  }
  // cpp.steps.v1: STEP_TASK_TRUTH recomputation via the SAME shared
  // interpreter the UI preview uses (rules are data; never executed strings).
  if (hasCppTask(taskId)) {
    if (!('program' in sceneState)) {
      return {
        verdict: 'REVISE',
        itemResults: [{ key: 'program', label: '程序运行（教学模型）', verdict: 'REVISE', feedback: '判分暂时不可用，本次提交未被判定为错误。' }],
        diagnostics: [],
        reveal: {},
        answerAssistanceActive: false,
      };
    }
    const judged = judgeStepTask({
      taskId,
      rule: getCppRuleBody(taskId),
      snapshot: sceneState,
      responseItems: response,
    });
    return {
      verdict: judged.verdict === 'CORRECT' ? 'CORRECT' : 'REVISE',
      itemResults: judged.itemResults.map((r) => ({
        key: r.key,
        label: r.label,
        verdict: r.verdict,
        feedback: r.feedback,
      })),
      diagnostics: [...judged.diagnostics],
      reveal: { ...judged.reveal } as Record<string, string>,
      answerAssistanceActive: false,
    };
  }
  const snapshot = sceneState as CylinderStateV1 | CylinderStateV2; // cylinder path (families handled above)
  const task = getTask(taskId);
  const ruleId = getBindingRuleId(taskId);
  const instance = getFrozenInstance(taskId);
  const results: ItemResult[] = [];
  const diagnostics: string[] = [];
  const reveal: Record<string, string> = {};

  const finish = (verdict: Verdict): EvaluationResult => ({
    verdict,
    itemResults: results,
    diagnostics,
    reveal,
    answerAssistanceActive: false,
  });

  const expectedJudgmentsFor = (idx: number): Record<string, string> => {
    // reads the frozen PARAMETER_IDENTIFICATION rules array (rule files embed
    // branch order documented in their `note`)
    const rule = getRuleData(ruleId) as {
      body?: { rules?: Array<{ expectedJudgments?: Array<{ propertyId: string; direction: string }> }> };
      rules?: Array<{ expectedJudgments?: Array<{ propertyId: string; direction: string }> }>;
    };
    const js = rule?.body?.rules?.[idx]?.expectedJudgments ?? rule?.rules?.[idx]?.expectedJudgments ?? [];
    const map: Record<string, string> = {};
    for (const j of js) map[j.propertyId] = j.direction;
    return map;
  };

  switch (task.responseSchemaId) {
    // ----- L1 -----
    case 'resp.l1.viewChange.v1': {
      const expected = expectedJudgmentsFor(0);
      const got = claimsByProperty(response);
      reveal.claims = PROPERTY_ORDER.map((p) => `${p}: ${expected[p] ?? 'UNCHANGED'}`).join('; ');
      let ok = true;
      for (const p of PROPERTY_ORDER) {
        if (got.get(p) !== expected[p]) ok = false;
      }
      results.push({
        key: 'claims',
        label: '三个尺寸的方向判断',
        verdict: ok ? 'CORRECT' : 'REVISE',
        feedback: ok ? undefined : FB.propertyRevise,
      });
      return finish(ok ? 'CORRECT' : 'REVISE');
    }
    case 'resp.l1.predictDimension.v1': {
      const numeric = numericItems(response).find((n) => n.quantityId === 'diameter');
      const claims = claimsByProperty(response);
      const expDirection = expectedPredictDimension(taskId, instance);
      const expValue = expectedPredictDimensionValue(taskId, instance, snapshot);
      reveal.direction = expDirection;
      reveal.value = `${rationalToDecimal(expValue, 1)} cm`;
      const dirOk = claims.get('diameter') === expDirection;
      results.push({
        key: 'direction',
        label: '直径方向',
        verdict: dirOk ? 'CORRECT' : 'REVISE',
        feedback: dirOk ? undefined : '直径和半径是什么关系？再判断一次方向。',
      });
      let valOk = false;
      if (numeric) {
        const norm = normalizeToCm(numeric.value, numeric.unitId);
        valOk = norm !== null && eqRational(norm, expValue);
        results.push({
          key: 'value',
          label: '直径数值（含单位）',
          verdict: valOk ? 'CORRECT' : 'REVISE',
          feedback: valOk ? undefined : numeric.unitId === 'cm' || numeric.unitId === 'mm' ? FB.genericRevise : FB.unitRevise,
        });
      } else {
        results.push({ key: 'value', label: '直径数值（含单位）', verdict: 'REVISE', feedback: FB.genericRevise });
      }
      return finish(dirOk && valOk ? 'CORRECT' : 'REVISE');
    }
    case 'resp.l1.dimensionRead.v1': {
      const claims = claimsByProperty(response);
      const numeric = numericItems(response).find((n) => n.quantityId === 'height');
      const pair = mappingPairs(response).find((p) => p.leftId === 'cyl-part-height-line');
      const dirOk = claims.get('height') === 'INCREASE';
      results.push({
        key: 'direction',
        label: '高度方向',
        verdict: dirOk ? 'CORRECT' : 'REVISE',
        feedback: dirOk ? undefined : FB.genericRevise,
      });
      const expH = { numerator: snapshot.heightMm, denominator: 10 };
      const valOk = numeric ? normalizeToCm(numeric.value, numeric.unitId) !== null && eqRational(normalizeToCm(numeric.value, numeric.unitId)!, expH) : false;
      results.push({
        key: 'value',
        label: '高度读数（含单位）',
        verdict: valOk ? 'CORRECT' : 'REVISE',
        feedback: valOk ? undefined : '再读一次确认后的尺寸表。',
      });
      const secOk = pair?.rightId === 'section-view-axial';
      results.push({
        key: 'section',
        label: '哪个切面能看到高',
        verdict: secOk ? 'CORRECT' : 'REVISE',
        feedback: secOk ? undefined : FB.sectionRevise,
      });
      reveal.direction = 'INCREASE';
      reveal.value = `${rationalToDecimal(expH, 1)} cm`;
      reveal.section = '轴截面（沿轴切开）';
      return finish(dirOk && valOk && secOk ? 'CORRECT' : 'REVISE');
    }
    case 'resp.l1.identifyParams.v1': {
      const truth = instanceTruth(instance);
      const got = claimsByProperty(response);
      const expected: Record<string, string> = {
        radius: 'UNCHANGED',
        diameter: 'UNCHANGED',
        height: 'UNCHANGED',
      };
      const changed = (truth.changedSet as string[]) ?? [];
      const direction = (truth.changedDirection as string) ?? 'UNCHANGED';
      if (changed.includes('RADIUS')) {
        expected.radius = direction;
        expected.diameter = direction;
      }
      if (changed.includes('HEIGHT')) expected.height = direction;
      reveal.claims = PROPERTY_ORDER.map((p) => `${p}: ${expected[p]}`).join('; ');
      const ok = PROPERTY_ORDER.every((p) => got.get(p) === expected[p]);
      results.push({
        key: 'identify',
        label: '变化项/不变项识别',
        verdict: ok ? 'CORRECT' : 'REVISE',
        feedback: ok ? undefined : FB.propertyRevise,
      });
      return finish(ok ? 'CORRECT' : 'REVISE');
    }

    // ----- L2 -----
    case 'resp.l2.directionRelation.v1': {
      const pairs = mappingPairs(response).filter((p) => p.leftId.startsWith('net-edge-'));
      let allCorrect = true;
      for (const p of pairs) {
        if (STANDARD_DIRECTION[p.leftId] !== p.rightId) allCorrect = false;
      }
      if (pairs.length !== 4) allCorrect = false;
      results.push({
        key: 'direction',
        label: '方向关系（圆周边/高边）',
        verdict: allCorrect ? 'CORRECT' : 'REVISE',
        feedback: allCorrect ? undefined : FB.directionRevise,
      });
      reveal.circleEdges = 'net-edge-2、net-edge-4';
      reveal.heightEdges = 'net-edge-1、net-edge-3';
      return finish(allCorrect ? 'CORRECT' : 'REVISE');
    }
    case 'resp.l2.edgePair.v1': {
      const pairs = mappingPairs(response).filter((p) => p.leftId.startsWith('net-edge-'));
      let allCorrect = true;
      let unsureAny = false;
      for (const p of pairs) {
        if (p.rightId === 'opt-unsure') unsureAny = true;
        if (STANDARD_PAIRING[p.leftId] !== p.rightId) allCorrect = false;
      }
      if (pairs.length !== 4) allCorrect = false;
      // I2 diagnostic: long-edge-matches-circle pattern
      if (taskId === 'cyl.net.i2.pair-tall-thin.v1' && !allCorrect) {
        const pattern =
          pairs.filter((p) => p.leftId === 'net-edge-1' || p.leftId === 'net-edge-3')
            .every((p) => p.rightId.includes('circle')) &&
          pairs.filter((p) => p.leftId === 'net-edge-2' || p.leftId === 'net-edge-4').every((p) => p.rightId === 'cyl-part-height-line');
        if (pattern) diagnostics.push('mis-appearance-long-edge');
      }
      results.push({
        key: 'pairing',
        label: '四条边配对',
        verdict: allCorrect && !unsureAny ? 'CORRECT' : 'REVISE',
        feedback:
          allCorrect && !unsureAny
            ? undefined
            : diagnostics.includes('mis-appearance-long-edge')
              ? FB.pairingRevise
              : FB.pairingReviseAlt,
      });
      reveal.pairing = '边1→高；边2→上底圆；边3→高；边4→下底圆';
      return finish(allCorrect && !unsureAny ? 'CORRECT' : 'REVISE');
    }
    case 'resp.l2.areaValue.v1': {
      const numeric = numericItems(response).find((n) => n.quantityId === 'lateral-area');
      const exp = lateralAreaRationalCm2(snapshot.radiusMm, snapshot.heightMm);
      reveal.value = `${rationalToDecimal(exp, 2)} cm²`;
      reveal.circumference = `${rationalToDecimal({ numerator: 2 * 157 * snapshot.radiusMm, denominator: 50 * 10 }, 2)} cm`;
      if (!numeric) {
        results.push({ key: 'area', label: '侧面积数值+单位', verdict: 'REVISE', feedback: FB.genericRevise });
        return finish('REVISE');
      }
      if (numeric.unitId !== 'cm2') {
        diagnostics.push('unit-mismatch');
        results.push({ key: 'area', label: '侧面积数值+单位', verdict: 'REVISE', feedback: FB.unitRevise });
        return finish('REVISE');
      }
      const got = normalizeToCm2(numeric.value, numeric.unitId)!;
      if (eqRational(got, exp)) {
        results.push({ key: 'area', label: '侧面积数值+单位', verdict: 'CORRECT' });
        return finish('CORRECT');
      }
      // diagnostics: base area added?
      const rCm = radiusRationalCm(snapshot.radiusMm);
      const base1 = mul({ numerator: 157, denominator: 50 }, mul(rCm, rCm)); // πr²
      if (eqRational(got, add(exp, base1)) || eqRational(got, add(exp, add(base1, base1)))) {
        diagnostics.push('mis-base-area-added');
        results.push({ key: 'area', label: '侧面积数值+单位', verdict: 'REVISE', feedback: FB.baseAreaAdded });
        return finish('REVISE');
      }
      results.push({ key: 'area', label: '侧面积数值+单位', verdict: 'REVISE', feedback: FB.numericRevise });
      return finish('REVISE');
    }
    case 'resp.l2.strangerComposite.v1': {
      const segments = getSegments(taskId);
      const truth = instanceTruth(instance);
      let all = true;
      for (const seg of segments) {
        if (seg === 'paramRead') {
          const n = numericItems(response).find((x) => x.quantityId === 'radius');
          const exp = radiusRationalCm(snapshot.radiusMm);
          reveal.radius = `${rationalToDecimal(exp, 1)} cm`;
          const ok = !!n && n.unitId === 'cm' && eqRational(normalizeToCm(n.value, n.unitId)!, exp);
          results.push({ key: 'paramRead', label: '半径', verdict: ok ? 'CORRECT' : 'REVISE', feedback: ok ? undefined : '半径和直径/周长的关系再倒过来用一次。' });
          if (!ok) all = false;
        } else if (seg === 'edgePairing') {
          // pairing item = the objectMapping whose options live in the
          // upper/lower/height namespace (no base-circle)
          const item = mappingItems(response).find(
            (it) => it.pairs.length > 0 && it.pairs.some((p) => p.rightId === 'cyl-part-upper-circle' || p.rightId === 'cyl-part-lower-circle'),
          );
          const pairs = (item?.pairs ?? []).filter((p) => p.leftId.startsWith('net-edge-'));
          const ok = pairs.length === 4 && pairs.every((p) => STANDARD_PAIRING[p.leftId] === p.rightId);
          reveal.pairing = '边1→高；边2→上底圆；边3→高；边4→下底圆';
          results.push({ key: 'edgePairing', label: '边配对', verdict: ok ? 'CORRECT' : 'REVISE', feedback: ok ? undefined : FB.pairingReviseAlt });
          if (!ok) all = false;
        } else if (seg === 'directionClaims') {
          const item = mappingItems(response).find((it) => it.pairs.some((p) => p.rightId === 'cyl-part-base-circle'));
          const pairs = (item?.pairs ?? []).filter((p) => p.leftId.startsWith('net-edge-'));
          const ok = pairs.length === 4 && pairs.every((p) => STANDARD_DIRECTION[p.leftId] === p.rightId);
          reveal.circleEdges = 'net-edge-2、net-edge-4';
          reveal.heightEdges = 'net-edge-1、net-edge-3';
          results.push({ key: 'directionClaims', label: '方向关系', verdict: ok ? 'CORRECT' : 'REVISE', feedback: ok ? undefined : FB.directionRevise });
          if (!ok) all = false;
        } else if (seg === 'areaValue') {
          const n = numericItems(response).find((x) => x.quantityId === 'lateral-area');
          const exp = lateralAreaRationalCm2(snapshot.radiusMm, snapshot.heightMm);
          reveal.area = `${rationalToDecimal(exp, 2)} cm²`;
          const ok = !!n && n.unitId === 'cm2' && eqRational(normalizeToCm2(n.value, n.unitId)!, exp);
          results.push({ key: 'areaValue', label: '面积（数值+单位）', verdict: ok ? 'CORRECT' : 'REVISE', feedback: ok ? undefined : n?.unitId !== 'cm2' ? FB.unitRevise : FB.numericRevise });
          if (!ok) all = false;
        }
      }
      void truth;
      return finish(all ? 'CORRECT' : 'REVISE');
    }
    // ----- L3（faces）-----
    case 'resp.l3.faceSet.v1': {
      // truth source: instance for I1, guided table mirroring rule.cylFaces.set.v1
      const truthFaces: Record<string, string> = instance
        ? (instance.truth.faceSet as Record<string, string>)
        : { 'cyl-face-side': 'opt-include', 'cyl-face-lower': 'opt-include', 'cyl-face-upper': 'opt-exclude' };
      const truthLid = instance ? (instance.truth.lidCount as string) : 'opt-1';
      const pairs = mappingPairs(response);
      const facePairs = pairs.filter((p) => (FACE_IDS as readonly string[]).includes(p.leftId));
      const declaredIncludes = facePairs.filter((p) => p.rightId === 'opt-include').map((p) => p.leftId).sort();
      // snapshot = declaration (§1.5 双校验; mismatch gates judging)
      const snapshotIds = [...snapshot.selectedFaceIds].sort();
      if (JSON.stringify(snapshotIds) !== JSON.stringify(declaredIncludes)) {
        results.push({ key: 'snapshot', label: '构造与声明一致', verdict: 'REVISE', feedback: L3_FB.snapshotMismatch });
        reveal.faceSet = '侧面+下盖面（1 个盖面）';
        return finish('REVISE');
      }
      const facesOk =
        facePairs.length === 3 && facePairs.every((p) => truthFaces[p.leftId] === p.rightId);
      const lowerMissed = facePairs.find((p) => p.leftId === 'cyl-face-lower')?.rightId === 'opt-exclude' && truthFaces['cyl-face-lower'] === 'opt-include';
      results.push({
        key: 'faceSet',
        label: '面集合三行',
        verdict: facesOk ? 'CORRECT' : 'REVISE',
        feedback: facesOk ? undefined : lowerMissed ? L3_FB.missingLower : L3_FB.faceSetRevise,
      });
      const lid = pairs.find((p) => p.leftId === 'lid-count')?.rightId;
      const lidOk = lid === truthLid;
      results.push({ key: 'lidCount', label: '盖面个数', verdict: lidOk ? 'CORRECT' : 'REVISE', feedback: lidOk ? undefined : L3_FB.faceSetRevise });
      reveal.faceSet = '侧面 + 下盖面（上盖面不算入）';
      reveal.lidCount = truthLid === 'opt-1' ? '1 个' : truthLid === 'opt-2' ? '2 个' : '0 个';
      return finish(facesOk && lidOk ? 'CORRECT' : 'REVISE');
    }
    case 'resp.l3.comboArea.v1': {
      const segments = getSegments(taskId);
      const r = snapshot.radiusMm;
      const h = snapshot.heightMm;
      let expected: Rational;
      let truthFaces: Record<string, string>;
      if (taskId === 'cyl.faces.g2.one-lid-area.v1') {
        expected = add(lateralAreaRationalCm2(r, h), circleAreaRationalCm2(r));
        truthFaces = { 'cyl-face-side': 'opt-include', 'cyl-face-lower': 'opt-include', 'cyl-face-upper': 'opt-exclude' };
      } else if (taskId === 'cyl.faces.g3.full-surface.v1') {
        expected = add(lateralAreaRationalCm2(r, h), add(circleAreaRationalCm2(r), circleAreaRationalCm2(r)));
        truthFaces = { 'cyl-face-side': 'opt-include', 'cyl-face-upper': 'opt-include', 'cyl-face-lower': 'opt-include' };
      } else {
        expected = numberToRational(Number(instance!.truth.surfaceCm2));
        truthFaces = instance!.truth.faceSet as Record<string, string>;
      }
      let all = true;
      if (segments.includes('faceSet') || segments.length === 0) {
        const pairs = mappingPairs(response).filter((p) => (FACE_IDS as readonly string[]).includes(p.leftId));
        const declaredIncludes = pairs.filter((p) => p.rightId === 'opt-include').map((p) => p.leftId).sort();
        const mustEqual = taskId !== 'cyl.faces.i3.surface-value-unit.v1';
        if (mustEqual) {
          const snapshotIds = [...snapshot.selectedFaceIds].sort();
          if (JSON.stringify(snapshotIds) !== JSON.stringify(declaredIncludes)) {
            results.push({ key: 'snapshot', label: '构造与声明一致', verdict: 'REVISE', feedback: L3_FB.snapshotMismatch });
            reveal.value = `${dec(expected)} cm²`;
            return finish('REVISE');
          }
        }
        const facesOk = pairs.length === 3 && pairs.every((p) => truthFaces[p.leftId] === p.rightId);
        results.push({ key: 'faceSet', label: '面集合三行', verdict: facesOk ? 'CORRECT' : 'REVISE', feedback: facesOk ? undefined : L3_FB.faceSetRevise });
        if (!facesOk) all = false;
      }
      const numeric = numericItems(response).find((n) => n.quantityId === 'paper-area');
      reveal.value = `${dec(expected)} cm²`;
      if (!numeric) {
        results.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.numericRevise });
        return finish('REVISE');
      }
      if (numeric.unitId !== 'cm2') {
        diagnostics.push('unit-mismatch');
        results.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.unitRevise });
        return finish('REVISE');
      }
      const got = numberToRational(numeric.value);
      if (eqRational(got, expected)) {
        results.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'CORRECT' });
        if (taskId === 'cyl.faces.g3.full-surface.v1') {
          reveal.adviceUsable = '不能用';
          reveal.adviceProblem = '漏了一个盖面';
        }
        return finish(all ? 'CORRECT' : 'REVISE');
      }
      // diagnostics (restricted feedback, never the expected value)
      if (taskId === 'cyl.faces.g3.full-surface.v1' && eqRational(got, add(lateralAreaRationalCm2(r, h), circleAreaRationalCm2(r)))) {
        results.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.adviceRejected });
        return finish('REVISE');
      }
      if (taskId === 'cyl.faces.i3.surface-value-unit.v1') {
        if (eqRational(got, lateralAreaRationalCm2(r, h))) {
          diagnostics.push('mis-lids-missing');
          results.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.lidsMissing });
          return finish('REVISE');
        }
        if (eqRational(got, add(lateralAreaRationalCm2(r, h), circleAreaRationalCm2(r)))) {
          diagnostics.push('mis-one-lid-missing');
          results.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.oneLidMissing });
          return finish('REVISE');
        }
        if (eqRational(got, mul(lateralAreaRationalCm2(r, h), { numerator: 2, denominator: 1 }))) {
          diagnostics.push('mis-double-side');
          results.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.doubleSide });
          return finish('REVISE');
        }
      }
      results.push({ key: 'paperArea', label: '总面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.numericRevise });
      return finish('REVISE');
    }
    case 'resp.l3.lidDelta.v1': {
      const truth = instance!.truth as { deltaCm2: string; attribution: string };
      const expected = numberToRational(Number(truth.deltaCm2));
      reveal.value = `${rationalToDecimal(expected, 2)} cm²`;
      const numeric = numericItems(response).find((n) => n.quantityId === 'paper-area-delta');
      const attribution = mappingPairs(response).find((p) => p.leftId === 'delta-attribution')?.rightId;
      let numericOk = false;
      if (!numeric) {
        results.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.numericRevise });
      } else if (numeric.unitId !== 'cm2') {
        diagnostics.push('unit-mismatch');
        results.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.unitRevise });
      } else {
        const got = numberToRational(numeric.value);
        if (eqRational(got, expected)) {
          numericOk = true;
          results.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'CORRECT' });
        } else {
          const r = snapshot.radiusMm;
          const h = snapshot.heightMm;
          if (eqRational(got, circleAreaRationalCm2(r))) {
            diagnostics.push('mis-one-lid-missing');
            results.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.oneLidMissing });
          } else if (eqRational(got, mul(lateralAreaRationalCm2(r, h), { numerator: 2, denominator: 1 }))) {
            diagnostics.push('mis-double-side');
            results.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.doubleSide });
          } else {
            results.push({ key: 'delta', label: '多用面积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.numericRevise });
          }
        }
      }
      const attrOk = attribution === truth.attribution;
      results.push({ key: 'attribution', label: '多用纸的概念归属', verdict: attrOk ? 'CORRECT' : 'REVISE', feedback: attrOk ? undefined : '再想想多出来的是哪些面' });
      return finish(numericOk && attrOk ? 'CORRECT' : 'REVISE');
    }

    // ----- L4（layers）-----
    case 'resp.l4.stackInvariant.v1': {
      // G1 activity gate: both layer counts tried + at least one layer step
      if (!activity.layerCountValues.includes(8) || !activity.layerCountValues.includes(16) || activity.visibleLayerCountApplies < 1) {
        results.push({ key: 'activity', label: '层叠活动（8 层与 16 层都装过、逐层推进过）', verdict: 'REVISE', feedback: L3_FB.activityRevise });
        reveal.directions = '每层厚度：变小；总体积：不变';
        reveal.volume = '226.08 cm³（8 层与 16 层都是）';
        return finish('REVISE');
      }
      const claims = claimsByProperty(response);
      const thicknessOk = claims.get('layerThickness') === 'DECREASE';
      const volumeDirOk = claims.get('totalVolume') === 'UNCHANGED';
      results.push({ key: 'directions', label: '两属性方向（层厚/总体积）', verdict: thicknessOk && volumeDirOk ? 'CORRECT' : 'REVISE', feedback: thicknessOk && volumeDirOk ? undefined : L3_FB.invariantRevise });
      const expected = volumeRationalCm3(snapshot.radiusMm, snapshot.heightMm);
      reveal.directions = '每层厚度：变小；总体积：不变';
      reveal.volume = `${dec(expected)} cm³（8 层与 16 层都是）`;
      const numeric = numericItems(response).find((n) => n.quantityId === 'volume');
      let valueOk = false;
      if (!numeric) {
        results.push({ key: 'volume', label: '总体积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.volumeRevise });
      } else if (numeric.unitId !== 'cm3') {
        diagnostics.push('unit-mismatch');
        results.push({ key: 'volume', label: '总体积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.unitRevise });
      } else {
        valueOk = eqRational(numberToRational(numeric.value), expected);
        results.push({ key: 'volume', label: '总体积（数值+单位）', verdict: valueOk ? 'CORRECT' : 'REVISE', feedback: valueOk ? undefined : L3_FB.volumeRevise });
      }
      return finish(thicknessOk && volumeDirOk && valueOk ? 'CORRECT' : 'REVISE');
    }
    case 'resp.l4.layerVolume.v1': {
      // G2 activity gate: cumulative table walked to the end (visible = 8)
      if (!(activity.visibleLayerCountValues.includes(8) || (snapshot as CylinderStateV2).visibleLayerCount === 8)) {
        results.push({ key: 'activity', label: '累计表走满（推进到第 8 层）', verdict: 'REVISE', feedback: '把累计表一层层推满到第 8 层再提交。' });
        reveal.thickness = '1.0 cm';
        reveal.perLayer = '28.26 cm³';
        reveal.total = '226.08 cm³';
        return finish('REVISE');
      }
      const r = snapshot.radiusMm;
      const h = snapshot.heightMm;
      const layered = snapshot as CylinderStateV2; // @2 task state (layers family)
      const n = layered.layerCount;
      const thicknessCm = mul(layerThicknessRationalMm(h, n), { numerator: 1, denominator: 10 });
      const perLayer = mul(circleAreaRationalCm2(r), thicknessCm);
      const total = volumeRationalCm3(r, h);
      reveal.thickness = `${rationalToDecimal(thicknessCm, 1)} cm`;
      reveal.perLayer = `${dec(perLayer)} cm³`;
      reveal.total = `${dec(total)} cm³`;
      let all = true;
      const t = numericItems(response).find((x) => x.quantityId === 'layer-thickness');
      const tOk = !!t && t.unitId === 'cm' && eqRational(normalizeToCm(t!.value, t!.unitId)!, thicknessCm);
      results.push({ key: 'thickness', label: '层厚（cm，一位小数）', verdict: tOk ? 'CORRECT' : 'REVISE', feedback: tOk ? undefined : '层厚 = 高 ÷ 层数，再算一遍。' });
      if (!tOk) all = false;
      const p = numericItems(response).find((x) => x.quantityId === 'layer-volume');
      const pOk = !!p && p.unitId === 'cm3' && eqRational(normalizeToCm3(p!.value, p!.unitId)!, perLayer);
      results.push({ key: 'perLayer', label: '每层体积（数值+单位）', verdict: pOk ? 'CORRECT' : 'REVISE', feedback: pOk ? undefined : p?.unitId !== 'cm3' ? L3_FB.unitRevise : L3_FB.volumeRevise });
      if (!pOk) all = false;
      const v = numericItems(response).find((x) => x.quantityId === 'volume');
      const vOk = !!v && v.unitId === 'cm3' && eqRational(normalizeToCm3(v!.value, v!.unitId)!, total);
      results.push({ key: 'total', label: '总体积（数值+单位）', verdict: vOk ? 'CORRECT' : 'REVISE', feedback: vOk ? undefined : v?.unitId !== 'cm3' ? L3_FB.unitRevise : L3_FB.volumeRevise });
      if (!vOk) all = false;
      return finish(all ? 'CORRECT' : 'REVISE');
    }
    case 'resp.l4.varCompare.v1': {
      const segments = getSegments(taskId);
      const isG3 = taskId === 'cyl.layers.g3.height-vs-radius.v1';
      if (isG3 && !(activity.setDimensionAxes.includes('RADIUS') && activity.setDimensionAxes.includes('HEIGHT'))) {
        results.push({ key: 'activity', label: '两方案都在罐子上试过（RADIUS 与 HEIGHT 各至少一次确认）', verdict: 'REVISE', feedback: L3_FB.activityReviseG3 });
        reveal.bigger = '加宽的方案';
        return finish('REVISE');
      }
      const truth = isG3
        ? { bigger: 'opt-plan-b', valueA: volumeRationalCm3(30, 160), valueB: volumeRationalCm3(60, 80), ratio: 'opt-ratio-4' }
        : {
            bigger: instance!.truth.bigger as string,
            valueA: numberToRational(Number(instance!.truth.valueACm3)),
            valueB: numberToRational(Number(instance!.truth.valueBCm3)),
            ratio: '',
          };
      reveal.bigger = '加宽的方案';
      reveal.valueA = `${dec(truth.valueA)} cm³`;
      reveal.valueB = `${dec(truth.valueB)} cm³`;
      if (isG3) reveal.ratio = '4 倍';
      let all = true;
      const bigger = mappingPairs(response).find((p) => p.leftId === 'bigger-plan')?.rightId;
      const biggerOk = bigger === truth.bigger;
      results.push({ key: 'bigger', label: '哪个方案装得多', verdict: biggerOk ? 'CORRECT' : 'REVISE', feedback: biggerOk ? undefined : '两个方案各算一遍再比。' });
      if (!biggerOk) all = false;
      const va = numericItems(response).find((x) => x.quantityId === 'volume-a');
      const vaOk = !!va && va.unitId === 'cm3' && eqRational(normalizeToCm3(va!.value, va!.unitId)!, truth.valueA);
      results.push({ key: 'valueA', label: '加高方案体积', verdict: vaOk ? 'CORRECT' : 'REVISE', feedback: vaOk ? undefined : va?.unitId !== 'cm3' ? L3_FB.unitRevise : L3_FB.volumeRevise });
      if (!vaOk) all = false;
      const vb = numericItems(response).find((x) => x.quantityId === 'volume-b');
      const vbOk = !!vb && vb.unitId === 'cm3' && eqRational(normalizeToCm3(vb!.value, vb!.unitId)!, truth.valueB);
      results.push({ key: 'valueB', label: '加宽方案体积', verdict: vbOk ? 'CORRECT' : 'REVISE', feedback: vbOk ? undefined : vb?.unitId !== 'cm3' ? L3_FB.unitRevise : L3_FB.volumeRevise });
      if (!vbOk) all = false;
      if (segments.includes('ratio')) {
        const ratio = mappingPairs(response).find((p) => p.leftId === 'radius-double-ratio')?.rightId;
        const ratioOk = ratio === truth.ratio;
        results.push({ key: 'ratio', label: '半径加倍的体积倍数', verdict: ratioOk ? 'CORRECT' : 'REVISE', feedback: ratioOk ? undefined : L3_FB.ratioRevise });
        if (!ratioOk) all = false;
      }
      // I2 decision diagnostic: linear choice with correct numbers
      if (!isG3 && bigger === 'opt-plan-a' && vaOk && vbOk) diagnostics.push('mis-linear-choice');
      return finish(all ? 'CORRECT' : 'REVISE');
    }
    case 'resp.l4.volumeValue.v1': {
      const truth = instance!.truth as { volumeCm3: string; diagnostics: { misCircumferenceTimesH: string; misPiRh: string } };
      const expected = numberToRational(Number(truth.volumeCm3));
      reveal.value = `${rationalToDecimal(expected, 2)} cm³`;
      const numeric = numericItems(response).find((n) => n.quantityId === 'volume');
      if (!numeric) {
        results.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.volumeRevise });
        return finish('REVISE');
      }
      if (numeric.unitId !== 'cm3') {
        diagnostics.push('unit-mismatch');
        results.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.unitRevise });
        return finish('REVISE');
      }
      const got = numberToRational(numeric.value);
      if (eqRational(got, expected)) {
        results.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'CORRECT' });
        return finish('CORRECT');
      }
      if (eqRational(got, numberToRational(Number(truth.diagnostics.misCircumferenceTimesH)))) {
        diagnostics.push('mis-circumference-times-h');
        results.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.misCircumferenceTimesH });
        return finish('REVISE');
      }
      if (eqRational(got, numberToRational(Number(truth.diagnostics.misPiRh)))) {
        diagnostics.push('mis-pi-r-h');
        results.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.misPiRh });
        return finish('REVISE');
      }
      results.push({ key: 'volume', label: '体积（数值+单位）', verdict: 'REVISE', feedback: L3_FB.volumeRevise });
      return finish('REVISE');
    }
    case 'resp.l4.accumulate.v1': {
      if (activity.visibleLayerCountApplies < 1) {
        results.push({ key: 'activity', label: '逐层执行（至少一次层推进确认）', verdict: 'REVISE', feedback: '先一层层推进，把累计表走到超过 100 的那一层。' });
        reveal.layer = '第 8 层';
        reveal.cumulative = '100.48 cm³';
        return finish('REVISE');
      }
      const truth = instance!.truth as {
        firstExceedLayer: number;
        cumulativeAtLayerCm3: string;
        boundary: { layer7Cm3: string; layer9Cm3: string };
      };
      const expectedCum = numberToRational(Number(truth.cumulativeAtLayerCm3));
      reveal.layer = `第 ${truth.firstExceedLayer} 层`;
      reveal.cumulative = `${rationalToDecimal(expectedCum, 2)} cm³`;
      const layerN = numericItems(response).find((n) => n.quantityId === 'layer-index');
      const cumN = numericItems(response).find((n) => n.quantityId === 'cumulative-volume');
      const layerVal = layerN ? layerN.value : NaN;
      const cumOk = !!cumN && cumN.unitId === 'cm3' && eqRational(normalizeToCm3(cumN!.value, cumN!.unitId)!, expectedCum);
      const layerOk = layerN?.unitId === 'layer' && layerVal === truth.firstExceedLayer;
      // off-by-one signature: (层号,累计) = (7, 87.92)（用了未超层）或 (9, 113.04)
      const cumVal = cumN && cumN.unitId === 'cm3' ? numberToRational(cumN.value) : null;
      const boundaryHit =
        (layerVal === 7 && cumVal !== null && eqRational(cumVal, numberToRational(Number(truth.boundary.layer7Cm3)))) ||
        (layerVal === 9 && cumVal !== null && eqRational(cumVal, numberToRational(Number(truth.boundary.layer9Cm3))));
      if (boundaryHit) {
        diagnostics.push('off-by-one-boundary');
        results.push({ key: 'layer', label: '首次超限层号', verdict: 'REVISE', feedback: L3_FB.boundaryRevise });
        results.push({ key: 'cumulative', label: '该层累计体积', verdict: cumOk ? 'CORRECT' : 'REVISE', feedback: cumOk ? undefined : L3_FB.cumulativeRevise });
        return finish('REVISE');
      }
      results.push({ key: 'layer', label: '首次超限层号', verdict: layerOk ? 'CORRECT' : 'REVISE', feedback: layerOk ? undefined : '没过 100 的最后一层也要看清楚。' });
      results.push({ key: 'cumulative', label: '该层累计体积', verdict: cumOk ? 'CORRECT' : 'REVISE', feedback: cumOk ? undefined : cumN?.unitId !== 'cm3' ? L3_FB.unitRevise : L3_FB.cumulativeRevise });
      return finish(layerOk && cumOk ? 'CORRECT' : 'REVISE');
    }
    case 'resp.l4.strangerComposite.v1': {
      const segments = getSegments(taskId);
      const truth = instance!.truth as Record<string, unknown>;
      let all = true;
      for (const seg of segments) {
        if (seg === 'paramRead') {
          const expected = numberToRational(Number(truth.radiusCm));
          reveal.radius = `${rationalToDecimal(expected, 1)} cm`;
          const n = numericItems(response).find((x) => x.quantityId === 'radius');
          const ok = !!n && n.unitId === 'cm' && eqRational(normalizeToCm(n!.value, n!.unitId)!, expected);
          results.push({ key: 'paramRead', label: '半径', verdict: ok ? 'CORRECT' : 'REVISE', feedback: ok ? undefined : L3_FB.paramReadRevise });
          if (!ok) all = false;
        } else if (seg === 'faceSet') {
          const truthFaces = truth.faceSet as Record<string, string>;
          const pairs = mappingPairs(response).filter((p) => (FACE_IDS as readonly string[]).includes(p.leftId));
          const declaredIncludes = pairs.filter((p) => p.rightId === 'opt-include').map((p) => p.leftId).sort();
          const snapshotIds = [...snapshot.selectedFaceIds].sort();
          if (JSON.stringify(snapshotIds) !== JSON.stringify(declaredIncludes)) {
            results.push({ key: 'faceSet', label: '面集合三行', verdict: 'REVISE', feedback: L3_FB.snapshotMismatch });
            all = false;
          } else {
            const ok = pairs.length === 3 && pairs.every((p) => truthFaces[p.leftId] === p.rightId);
            results.push({ key: 'faceSet', label: '面集合三行', verdict: ok ? 'CORRECT' : 'REVISE', feedback: ok ? undefined : L3_FB.faceSetRevise });
            if (!ok) all = false;
          }
          reveal.faceSet = '有底有盖：侧面+上盖+下盖；有底无盖：侧面+下盖面';
        } else if (seg === 'paperArea') {
          const expected = numberToRational(Number(truth.paperAreaCm2));
          reveal.paperArea = `${rationalToDecimal(expected, 2)} cm²`;
          const n = numericItems(response).find((x) => x.quantityId === 'paper-area');
          const ok = !!n && n.unitId === 'cm2' && eqRational(normalizeToCm2(n!.value, n!.unitId)!, expected);
          results.push({ key: 'paperArea', label: '纸板面积（数值+单位）', verdict: ok ? 'CORRECT' : 'REVISE', feedback: ok ? undefined : n?.unitId !== 'cm2' ? L3_FB.unitRevise : '先分面，再把每个面的面积加起来。' });
          if (!ok) all = false;
        } else if (seg === 'volume') {
          const expected = numberToRational(Number(truth.volumeCm3));
          reveal.volume = `${rationalToDecimal(expected, 2)} cm³`;
          const n = numericItems(response).find((x) => x.quantityId === 'volume');
          const ok = !!n && n.unitId === 'cm3' && eqRational(normalizeToCm3(n!.value, n!.unitId)!, expected);
          results.push({ key: 'volume', label: '体积（数值+单位）', verdict: ok ? 'CORRECT' : 'REVISE', feedback: ok ? undefined : n?.unitId !== 'cm3' ? L3_FB.unitRevise : L3_FB.volumeRevise });
          if (!ok) all = false;
        }
      }
      return finish(all ? 'CORRECT' : 'REVISE');
    }
    default:
      results.push({ key: 'unknown', label: task.responseSchemaId, verdict: 'REVISE', feedback: FB.genericRevise });
      return finish('REVISE');
  }
}

function instanceTruth(instance: FrozenInstance | null): Record<string, unknown> {
  return instance?.truth ?? {};
}

function expectedPredictDimension(taskId: string, instance: FrozenInstance | null): string {
  if (taskId === 'cyl.param.g2.radius-change.v1') return 'INCREASE';
  const t = instance?.truth as { direction?: string } | undefined;
  return t?.direction ?? 'UNCHANGED';
}

function expectedPredictDimensionValue(
  taskId: string,
  instance: FrozenInstance | null,
  snapshot: CylinderStateV1,
): Rational {
  if (taskId === 'cyl.param.g2.radius-change.v1') {
    // d = 2r at the confirmed (post-change) snapshot
    return diameterRationalCm(snapshot.radiusMm);
  }
  const t = instance?.truth as { valueCm?: string } | undefined;
  if (t?.valueCm) return numberToRational(Number(t.valueCm));
  return diameterRationalCm(snapshot.radiusMm);
}

function getRuleData(ruleId: string): unknown {
  return getRule(ruleId);
}

function getSegments(taskId: string): string[] {
  return TASK_ENABLED_SEGMENTS[taskId] ?? [];
}

/** Diameter expected at the current snapshot (used by review cards). */
export function expectedDiameterCm(snapshot: CylinderStateV1): string {
  return rationalToDecimal(diameterRationalCm(snapshot.radiusMm), 1);
}
