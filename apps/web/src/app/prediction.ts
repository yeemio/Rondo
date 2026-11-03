/**
 * Prediction carrier helpers (documented decision PREDICTION_CARRIER):
 * the frozen recordPrediction payload carries property-direction claims plus
 * an `uncertain` flag; value/mapping/enum predictions that the claims shape
 * cannot hold are deterministically serialized into `explanation` so the
 * first prediction stays verbatim on the record for REVIEW comparison.
 * (Named delta candidate for B: structured non-claim prediction fields.)
 */
export type PredictAskState = Record<string, string | number | undefined>;

const DIRECTION_LABEL: Record<string, string> = {
  INCREASE: '变大',
  DECREASE: '变小',
  UNCHANGED: '不变',
};

export function serializePredictionExplanation(
  asks: Array<{ id: string; kind: string; prompt: string }>,
  state: PredictAskState,
): string {
  const parts: string[] = [];
  for (const ask of asks) {
    if (ask.kind === 'fractionGuess') {
      const num = state[`${ask.id}.num`];
      const den = state[`${ask.id}.den`];
      if (num !== undefined && den !== undefined && num !== '' && den !== '') {
        parts.push(`${ask.prompt} → ${num}/${den}`);
      }
      continue;
    }
    if (ask.kind === 'outputLines') {
      const lines = collectOutputLines(ask.id, state, 8);
      if (lines.length > 0) parts.push(`${ask.prompt} → 每行一个数：${lines.join('，')}`);
      continue;
    }
    const v = state[ask.id];
    if (v === undefined || v === '') continue;
    parts.push(`${ask.prompt} → ${formatAskValue(ask.kind, v)}`);
  }
  return parts.length ? `[预测] ${parts.join('；')}` : '[预测] 未逐项作答';
}

/** Per-line structured integer boxes (cpp.steps.v1 outputLines ask). */
export function collectOutputLines(askId: string, state: PredictAskState, maxLines: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < maxLines; i += 1) {
    const v = state[`${askId}.line[${i}]`];
    if (v === undefined || v === '') break;
    out.push(String(v));
  }
  return out;
}

function formatAskValue(kind: string, v: string | number): string {
  if (typeof v === 'number') return String(v);
  if (kind === 'propertyDirections' || kind === 'propertyBet') {
    return DIRECTION_LABEL[v] ?? v;
  }
  return v;
}

/** Claims extracted from claim-shaped asks (property directions / bet). */
export function extractClaims(
  asks: Array<{ id: string; kind: string; properties?: string[] }>,
  state: PredictAskState,
): Array<{ propertyId: 'radius' | 'diameter' | 'height'; direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED' }> {
  const claims: Array<{ propertyId: 'radius' | 'diameter' | 'height'; direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED' }> = [];
  for (const ask of asks) {
    if (ask.kind === 'propertyDirections' && ask.properties) {
      for (const p of ask.properties) {
        const v = state[`${ask.id}.${p}`];
        if (v === 'INCREASE' || v === 'DECREASE' || v === 'UNCHANGED') {
          claims.push({ propertyId: p as 'radius' | 'diameter' | 'height', direction: v });
        }
      }
    }
    if (ask.kind === 'propertyBet') {
      const prop = state[`${ask.id}.property`];
      const dir = state[`${ask.id}.direction`];
      if ((prop === 'radius' || prop === 'height') && (dir === 'INCREASE' || dir === 'DECREASE')) {
        claims.push({ propertyId: prop, direction: dir });
      }
    }
  }
  return claims;
}

export function newId(prefix: string): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : String(Math.random()).slice(2, 14);
  return `${prefix}-${rnd}`;
}
