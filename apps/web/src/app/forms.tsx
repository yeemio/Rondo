/**
 * Response forms driven by the public response-schema registries.
 *
 * VERIFY responses are assembled strictly from the frozen structured carriers
 * (contracts/public/envelope.ts): propertyJudgments / objectMapping /
 * numberWithUnit — plus, per the family contract deltas (integration W1),
 * fractionValue / singleChoice (themes) and outputLines / variableValues /
 * branchTrace (cpp.steps.v1). Predict-phase non-claim answers serialize into
 * recordPrediction.explanation (decision PREDICTION_CARRIER).
 */
import { useState } from 'react';
import type { StructuredResponseItem } from '../../../../modules/contracts/public/envelope';
import { RESPONSE_REGISTRY, CPP_RESPONSE_REGISTRY, getSchema } from '../content/bundled';
import { extractClaims, serializePredictionExplanation, type PredictAskState } from './prediction';

const DIRECTION_OPTIONS = [
  { id: 'INCREASE', label: '变大' },
  { id: 'DECREASE', label: '变小' },
  { id: 'UNCHANGED', label: '不变' },
];
const UNSURE = { id: 'opt-unsure', label: '不确定' };

const INCLUDE_OPT = 'opt-include';
const EXCLUDE_OPT = 'opt-exclude';

/** L34-4：面集合行 = include/exclude/unsure 三选 → checkbox 呈现 + 序列化。
 * 勾选=算入、未勾=不算入；「不确定」勾选覆盖为 opt-unsure。 */
/** Predict-side mapping row label: L2 net edges keep their legacy wording;
 * L3 face rows use the face labels (registry predict asks carry raw ids). */
function predictMappingLabel(leftId: string): string {
  if (leftId.startsWith('cyl-face-')) {
    const map: Record<string, string> = {
      'cyl-face-side': '侧面：',
      'cyl-face-upper': '上盖面：',
      'cyl-face-lower': '下盖面：',
    };
    return map[leftId] ?? `${leftId}：`;
  }
  // No space after the id: the L1/L2 accessible-name contract is
  // "net-edge-N卷回去属于：" verbatim (E2E anchors on it).
  return `${leftId}卷回去属于：`;
}

function isFaceOptionSet(options: Array<{ id: string }> | undefined): boolean {
  return !!options && !!options.find((o) => o.id === INCLUDE_OPT) && !!options.find((o) => o.id === EXCLUDE_OPT) && !!options.find((o) => o.id === UNSURE.id);
}

function FaceCheckboxRow({
  leftLabel,
  checked,
  unsure,
  onChange,
}: {
  leftLabel: string;
  checked: boolean;
  unsure: boolean;
  onChange: (next: { checked: boolean; unsure: boolean }) => void;
}) {
  return (
    <div className="face-row">
      <label className="radio-line">
        <input
          type="checkbox"
          checked={checked && !unsure}
          onChange={(e) => onChange({ checked: e.target.checked, unsure: false })}
          aria-label={`${leftLabel}：算入纸样`}
        />
        {leftLabel}：算入
      </label>
      <label className="radio-line unsure-line">
        <input type="checkbox" checked={unsure} onChange={(e) => onChange({ checked, unsure: e.target.checked })} />
        不确定
      </label>
      <span className="hint">{unsure ? '该项按「不确定」提交' : checked && !unsure ? '算入' : '不算入'}</span>
    </div>
  );
}

interface Ask {
  id: string;
  kind: string;
  prompt: string;
  properties?: string[];
  optionalUncertain?: boolean;
  options?: Array<{ id: string; label: string }>;
  units?: Array<{ id: string; label: string }>;
  quantityLabel?: string;
  leftIds?: string[];
  rightOptions?: Array<{ id: string; label: string }>;
  directionOptions?: Array<{ id: string; label: string }>;
  selectionId?: string;
  /** cpp.steps.v1: per-task predict ask filter + per-line cap */
  tasks?: string[];
  maxLines?: number;
}

interface VerifyItem {
  kind: string;
  prompt: string;
  properties?: string[];
  quantityId?: string;
  quantityLabel?: string;
  units?: Array<{ id: string; label: string }>;
  decimals?: number;
  pairs?: Array<{ leftId: string; leftLabel: string; rightOptions: Array<{ id: string; label: string }> }>;
  // themes verify carriers (fractionValue / singleChoice)
  options?: Array<{ id: string; label: string }>;
  selectionId?: string;
  // cpp.steps.v1 verify carriers
  maxLines?: number;
  variables?: Array<{ id: string; label: string }>;
  checkpoints?: Array<{ checkpointId: string; label: string }>;
}

/** Per-line structured integer boxes (每行一个数，非自由文本；A-3/§6.6 防录入挫败). */
export function OutputLinesEditor(props: {
  lineKeyPrefix: string;
  maxLines: number;
  values: Record<string, string>;
  onSet: (key: string, value: string | undefined) => void;
}): JSX.Element {
  const { lineKeyPrefix, maxLines, values, onSet } = props;
  const rows: string[] = [];
  for (let i = 0; i < maxLines; i += 1) {
    const v = values[`${lineKeyPrefix}[${i}]`] ?? '';
    rows.push(v);
    if (v === '' && values[`${lineKeyPrefix}[${i + 1}]`] === undefined) break;
  }
  return (
    <div className="lines-editor">
      {rows.map((v, i) => (
        <label key={i} className="radio-line">
          第 {i + 1} 行：
          <input
            type="text"
            inputMode="numeric"
            pattern="-?[0-9]*"
            value={v}
            aria-label={`第 ${i + 1} 行输出（整数）`}
            onChange={(e) => {
              const cleaned = e.target.value.replace(/[^0-9-]/g, '');
              onSet(`${lineKeyPrefix}[${i}]`, cleaned === '' ? undefined : cleaned);
            }}
          />
          {i === rows.length - 1 && v !== '' && i + 1 < maxLines ? (
            <button type="button" className="insert-btn" onClick={() => onSet(`${lineKeyPrefix}[${i + 1}]`, '')}>
              加一行
            </button>
          ) : null}
        </label>
      ))}
      {rows.length === 0 && maxLines > 0 ? (
        <label className="radio-line">
          第 1 行：
          <input
            type="text"
            inputMode="numeric"
            pattern="-?[0-9]*"
            aria-label="第 1 行输出（整数）"
            value=""
            onChange={(e) => onSet(`${lineKeyPrefix}[0]`, e.target.value.replace(/[^0-9-]/g, '') === '' ? undefined : e.target.value.replace(/[^0-9-]/g, ''))}
          />
        </label>
      ) : null}
    </div>
  );
}

export function PredictionForm({
  schemaId,
  taskId,
  onSubmit,
  busy,
}: {
  schemaId: string;
  taskId?: string;
  onSubmit: (payload: { claims: Array<{ propertyId: 'radius' | 'diameter' | 'height' | 'layerThickness' | 'totalVolume'; direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED' }>; uncertain: boolean; explanation?: string }) => void;
  busy: boolean;
}) {
  const schema = getSchema(schemaId);
  const allAsks = (schema.predict?.asks ?? []) as Ask[];
  const asks = allAsks.filter((a) => !a.tasks || !taskId || a.tasks.includes(taskId));
  const [state, setState] = useState<PredictAskState>({});
  const [uncertain, setUncertain] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);

  const set = (k: string, v: string | number | undefined) => setState((s) => ({ ...s, [k]: v }));

  return (
    <form
      className="predict-form"
      onSubmit={(e) => {
        e.preventDefault();
        const claims = extractClaims(asks, state);
        const anyAnswered = Object.values(state).some((v) => v !== undefined && v !== '');
        if (!uncertain && claims.length === 0 && !anyAnswered) {
          setValidation('请先作答，或勾选「不确定」。');
          return;
        }
        setValidation(null);
        onSubmit({
          claims,
          uncertain: uncertain || claims.length === 0,
          explanation: serializePredictionExplanation(asks, state),
        });
      }}
    >
      <p className="hint">预测不要求正确，也不会被覆盖——先记下你现在的想法。</p>
      {asks.map((ask) => (
        <fieldset key={ask.id} className="ask">
          <legend>{ask.prompt}</legend>
          {ask.kind === 'propertyDirections' ? (
            (ask.properties ?? []).map((p) => (
              <label key={p} className="radio-line">
                {RESPONSE_REGISTRY.propertyLabels[p] ?? p}会：
                <select
                  value={state[`${ask.id}.${p}`] ?? ''}
                  onChange={(e) => set(`${ask.id}.${p}`, e.target.value || undefined)}
                >
                  <option value="">（未选）</option>
                  {DIRECTION_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ))
          ) : null}
          {ask.kind === 'choice' ? (
            <div role="radiogroup" aria-label={ask.prompt}>
              {(ask.options ?? []).map((o) => (
                <label key={o.id} className="radio-line">
                  <input
                    type="radio"
                    name={ask.id}
                    value={o.id}
                    checked={state[ask.id] === o.id}
                    onChange={() => set(ask.id, o.id)}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          ) : null}
          {ask.kind === 'numberValue' ? (
            <label className="radio-line">
              {ask.quantityLabel}大约是：
              <input
                type="number"
                step="any"
                value={state[ask.id] !== undefined ? String(state[ask.id]) : ''}
                onChange={(e) => set(ask.id, e.target.value === '' ? undefined : Number(e.target.value))}
              />
              <select value={state[`${ask.id}.unit`] ?? ask.units?.[0]?.id ?? ''} onChange={(e) => set(`${ask.id}.unit`, e.target.value)}>
                {(ask.units ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {ask.kind === 'fractionGuess' ? (
            <div className="fraction-input">
              <span className="hint">{ask.quantityLabel}大约是：分子</span>
              <input
                type="number"
                min={0}
                max={9999}
                aria-label={`${ask.prompt}（分子）`}
                value={state[`${ask.id}.num`] !== undefined ? String(state[`${ask.id}.num`]) : ''}
                onChange={(e) => set(`${ask.id}.num`, e.target.value === '' ? undefined : Number(e.target.value))}
              />
              <span className="hint">/ 分母</span>
              <input
                type="number"
                min={1}
                max={9999}
                aria-label={`${ask.prompt}（分母）`}
                value={state[`${ask.id}.den`] !== undefined ? String(state[`${ask.id}.den`]) : ''}
                onChange={(e) => set(`${ask.id}.den`, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            </div>
          ) : null}
          {ask.kind === 'outputLines' ? (
            <div className="lines-box" role="group" aria-label={ask.prompt}>
              <OutputLinesEditor
                lineKeyPrefix={`${ask.id}.line`}
                maxLines={ask.maxLines ?? 8}
                values={state as Record<string, string>}
                onSet={(k, v) => set(k, v)}
              />
            </div>
          ) : null}
          {ask.kind === 'mapping' ? (
            (ask.leftIds ?? []).map((left) => (
              <label key={left} className="radio-line">
                {predictMappingLabel(left)}
                <select value={state[`${ask.id}.${left}`] ?? ''} onChange={(e) => set(`${ask.id}.${left}`, e.target.value || undefined)}>
                  <option value="">（未选）</option>
                  {(ask.rightOptions ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ))
          ) : null}
          {ask.kind === 'propertyBet' ? (
            <div className="bet-row">
              <label>
                我猜改变的是：
                <select value={state[`${ask.id}.property`] ?? ''} onChange={(e) => set(`${ask.id}.property`, e.target.value || undefined)}>
                  <option value="">（未选）</option>
                  {(ask.properties ?? []).map((p) => (
                    <option key={p} value={p}>
                      {RESPONSE_REGISTRY.propertyLabels[p] ?? p}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                怎么变：
                <select value={state[`${ask.id}.direction`] ?? ''} onChange={(e) => set(`${ask.id}.direction`, e.target.value || undefined)}>
                  <option value="">（未选）</option>
                  {(ask.directionOptions ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
        </fieldset>
      ))}
      {asks.some((a) => a.optionalUncertain) ? (
        <label className="radio-line">
          <input type="checkbox" checked={uncertain} onChange={(e) => setUncertain(e.target.checked)} />
          我整体还不确定（仍会保存这条记录）
        </label>
      ) : (
        <label className="radio-line">
          <input type="checkbox" checked={uncertain} onChange={(e) => setUncertain(e.target.checked)} />
          不确定（仍会保存这条记录）
        </label>
      )}
      {validation ? (
        <p className="error" role="alert">
          {validation}
        </p>
      ) : null}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? '保存中…' : '保存预测，开始观察'}
      </button>
    </form>
  );
}

export function VerifyForm({
  schemaId,
  taskId,
  enabledSegments,
  onSubmit,
  busy,
}: {
  schemaId: string;
  taskId?: string;
  enabledSegments?: string[];
  onSubmit: (response: StructuredResponseItem[]) => void;
  busy: boolean;
}) {
  const schema = getSchema(schemaId);
  const verify = schema.verify;
  const [values, setValues] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState<string | null>(null);

  if (!verify) return <p className="hint">该题型没有作答表单。</p>;

  // L34-7 附注：复合段 prompt 实例化（仅 paramRead 段；版本化登记于注册表）
  const promptOverride = (segId: string): string | undefined => (schema as unknown as { segmentPromptOverrides?: Record<string, Record<string, string>> }).segmentPromptOverrides?.[taskId ?? '']?.[segId];

  // cpp program.v1: the conceptCheck segment's item is a placeholder replaced
  // by the registry's per-task concept selection
  const resolveSegmentItem = (seg: { id: string; label: string; item: Record<string, unknown> }): { id: string; label: string; item: Record<string, unknown> } => {
    if (seg.item.kind === 'singleChoiceRegistry') {
      const perTask = (schema as unknown as { perTaskConcept?: Record<string, Record<string, unknown>> }).perTaskConcept?.[taskId ?? ''];
      if (perTask) return { ...seg, item: perTask } as { id: string; label: string; item: Record<string, unknown> };
    }
    return seg;
  };

  const items: Array<{ segId: string; item: VerifyItem }> = verify.items
    ? verify.items.map((raw, i) => ({ segId: `item-${i}`, item: raw as unknown as VerifyItem }))
    : (verify.segments ?? [])
        .filter((sg) => !enabledSegments || enabledSegments.includes(sg.id))
        .map((sg) => ({ segId: sg.id, item: (resolveSegmentItem(sg as unknown as { id: string; label: string; item: Record<string, unknown> }) as { item: Record<string, unknown> }).item as unknown as VerifyItem }));

  const buildResponse = (): StructuredResponseItem[] | null => {
    const out: StructuredResponseItem[] = [];
    for (const { segId, item } of items) {
      if (item.kind === 'propertyJudgments') {
        const claims = (item.properties ?? []).map((p) => ({
          propertyId: p,
          direction: values[`${segId}.${p}`],
        }));
        if (claims.some((c) => !c.direction)) {
          setValidation('每个尺寸都要选一个方向。');
          return null;
        }
        out.push({
          kind: 'propertyJudgments',
          claims: claims as unknown as StructuredResponseItem extends never ? never : Array<{ propertyId: 'radius' | 'diameter' | 'height' | 'layerThickness' | 'totalVolume'; direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED' }>,
        });
      } else if (item.kind === 'objectMapping') {
        const pairs = (item.pairs ?? []).map((p) => ({
          leftId: p.leftId,
          rightId: values[`${segId}.${p.leftId}`] ?? '',
        }));
        if (pairs.some((p) => !p.rightId)) {
          setValidation('每一项都要选择（可以选「不确定」）。');
          return null;
        }
        out.push({ kind: 'objectMapping', pairs });
      } else if (item.kind === 'numberWithUnit') {
        const raw = values[`${segId}.value`];
        const unit = values[`${segId}.unit`] ?? item.units?.[0]?.id ?? '';
        if (raw === undefined || raw === '' || Number.isNaN(Number(raw))) {
          setValidation('请填写数值（数值题提交时需要给数值）。');
          return null;
        }
        out.push({ kind: 'numberWithUnit', quantityId: item.quantityId ?? 'value', value: Number(raw), unitId: unit });
      } else if (item.kind === 'fractionValue') {
        const num = values[`${segId}.num`];
        const den = values[`${segId}.den`];
        if (num === undefined || num === '' || den === undefined || den === '' || Number.isNaN(Number(num)) || Number.isNaN(Number(den))) {
          setValidation('请填写分子和分母（两个整数）。');
          return null;
        }
        out.push({
          kind: 'fractionValue',
          quantityId: item.quantityId ?? 'fraction',
          numerator: Number(num),
          denominator: Number(den),
        });
      } else if (item.kind === 'singleChoice') {
        const pick = values[`${segId}.pick`] || values[`${segId}.option`];
        if (!pick) {
          setValidation('请选择一项。');
          return null;
        }
        out.push({ kind: 'singleChoice', selectionId: item.selectionId ?? segId, optionId: pick });
      } else if (item.kind === 'numberValue') {
        // cpp bare numeric verify (loop trip count etc.) — carried as
        // numberWithUnit with the neutral unit id
        const raw = values[`${segId}.value`];
        if (raw === undefined || raw === '' || Number.isNaN(Number(raw))) {
          setValidation('请填写数值。');
          return null;
        }
        out.push({ kind: 'numberWithUnit', quantityId: item.quantityId ?? segId, value: Number(raw), unitId: 'count' });
      } else if (item.kind === 'outputString') {
        const lines: string[] = [];
        for (let i = 0; i < (item.maxLines ?? 8); i += 1) {
          const v = values[`${segId}.line[${i}]`];
          if (v === undefined || v === '') break;
          if (!/^-?\d+$/.test(v)) {
            setValidation('每行只能填一个整数（不带小数点、不带单位）。');
            return null;
          }
          lines.push(v);
        }
        if (lines.length === 0) {
          setValidation('至少填一行输出（每行一个数）。');
          return null;
        }
        out.push({ kind: 'outputLines', quantityId: item.quantityId ?? 'output', lines });
      } else if (item.kind === 'finalVariables') {
        const vars = (item.variables ?? []);
        if (vars.length === 0) {
          setValidation('本题没有登记变量。');
          return null;
        }
        const entries = vars.map((v) => ({ varId: v.id, value: Number(values[`${segId}.${v.id}`]) }));
        if (entries.some((e) => values[`${segId}.${e.varId}`] === undefined || values[`${segId}.${e.varId}`] === '' || Number.isNaN(e.value))) {
          setValidation('每个变量都要填一个整数。');
          return null;
        }
        out.push({ kind: 'variableValues', values: entries });
      } else if (item.kind === 'branchTrace') {
        const marks = (item.checkpoints ?? []).map((c) => ({
          checkpointId: c.checkpointId,
          outcome: values[`${segId}.${c.checkpointId}`],
        }));
        if (marks.some((m) => !m.outcome)) {
          setValidation('每个判断都要选走了哪边。');
          return null;
        }
        out.push({ kind: 'branchTrace', marks: marks as Array<{ checkpointId: string; outcome: 'TAKEN' | 'SKIPPED' }> });
      }
    }
    return out;
  };

  return (
    <form
      className="verify-form"
      onSubmit={(e) => {
        e.preventDefault();
        const response = buildResponse();
        if (!response) return;
        setValidation(null);
        onSubmit(response);
      }}
    >
      {items.map(({ segId, item }, idx) => (
        <fieldset key={segId} className="ask">
          <legend>
            {verify.segments ? `${idx + 1}) ` : ''}
            {promptOverride(segId) ?? item.prompt}
          </legend>
          {item.kind === 'propertyJudgments'
            ? (item.properties ?? []).map((p) => (
                <label key={p} className="radio-line">
                  {RESPONSE_REGISTRY.propertyLabels[p] ?? p}：
                  <select
                    value={values[`${segId}.${p}`] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [`${segId}.${p}`]: e.target.value }))}
                  >
                    <option value="">（未选）</option>
                    {DIRECTION_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))
            : null}
          {item.kind === 'objectMapping'
            ? isFaceOptionSet(item.pairs?.[0]?.rightOptions)
              ? (item.pairs ?? []).map((p) => {
                  const v = values[`${segId}.${p.leftId}`] ?? '';
                  return (
                    <FaceCheckboxRow
                      key={p.leftId}
                      leftLabel={p.leftLabel}
                      checked={v === INCLUDE_OPT}
                      unsure={v === UNSURE.id}
                      onChange={({ checked, unsure }) =>
                        setValues((prev) => ({
                          ...prev,
                          [`${segId}.${p.leftId}`]: unsure ? UNSURE.id : checked ? INCLUDE_OPT : EXCLUDE_OPT,
                        }))
                      }
                    />
                  );
                })
              : (item.pairs ?? []).map((p) => (
                  <label key={p.leftId} className="radio-line">
                    {p.leftLabel}：
                    <select
                      value={values[`${segId}.${p.leftId}`] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [`${segId}.${p.leftId}`]: e.target.value }))}
                    >
                      <option value="">（未选）</option>
                      {p.rightOptions.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))
            : null}
          {item.kind === 'numberWithUnit' ? (
            <label className="radio-line">
              {item.quantityLabel} =
              <input
                type="number"
                step="any"
                value={values[`${segId}.value`] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [`${segId}.value`]: e.target.value }))}
              />
              <select
                value={values[`${segId}.unit`] ?? item.units?.[0]?.id ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [`${segId}.unit`]: e.target.value }))}
              >
                {(item.units ?? [{ id: 'cm', label: 'cm' }]).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.label}
                  </option>
                ))}
              </select>
              {item.decimals === 2 ? <span className="hint">（四舍五入保留两位小数）</span> : null}
            </label>
          ) : null}
          {item.kind === 'numberValue' ? (
            <label className="radio-line">
              {item.quantityLabel ?? '数值'} =
              <input
                type="number"
                step="1"
                value={values[`${segId}.value`] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [`${segId}.value`]: e.target.value }))}
              />
              <span className="hint">（整数）</span>
            </label>
          ) : null}
          {item.kind === 'outputString' ? (
            <div className="lines-box" role="group" aria-label={item.prompt}>
              <OutputLinesEditor
                lineKeyPrefix={`${segId}.line`}
                maxLines={item.maxLines ?? 8}
                values={values}
                onSet={(k, v) => setValues((prev) => ({ ...prev, [k]: v ?? '' }))}
              />
              <p className="hint">每行一个数（每行对应一条输出语句的执行）；行数也要对上。</p>
            </div>
          ) : null}
          {item.kind === 'finalVariables'
            ? (item.variables ?? []).map((v) => (
                <label key={v.id} className="radio-line">
                  {v.label} =
                  <input
                    type="number"
                    step="1"
                    className="var-input"
                    aria-label={`变量 ${v.label} 的终值`}
                    value={values[`${segId}.${v.id}`] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [`${segId}.${v.id}`]: e.target.value }))}
                  />
                </label>
              ))
            : null}
          {item.kind === 'branchTrace'
            ? (item.checkpoints ?? []).map((c) => (
                <label key={c.checkpointId} className="radio-line">
                  {c.label}：
                  <select
                    value={values[`${segId}.${c.checkpointId}`] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [`${segId}.${c.checkpointId}`]: e.target.value }))}
                  >
                    <option value="">（未选）</option>
                    {(item.options ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))
            : null}
          {item.kind === 'fractionValue' ? (
            <div className="fraction-input" role="group" aria-label={item.prompt}>
              <span className="hint">{item.quantityLabel}：分子</span>
              <input
                type="number"
                min={0}
                max={9999}
                aria-label={`${item.prompt}（分子）`}
                value={values[`${segId}.num`] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [`${segId}.num`]: e.target.value }))}
              />
              <span className="hint">/ 分母</span>
              <input
                type="number"
                min={1}
                max={9999}
                aria-label={`${item.prompt}（分母）`}
                value={values[`${segId}.den`] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [`${segId}.den`]: e.target.value }))}
              />
            </div>
          ) : null}
          {item.kind === 'singleChoice' ? (
            <div role="radiogroup" aria-label={item.prompt}>
              {(item.options ?? []).map((o) => (
                <label key={o.id} className="radio-line">
                  <input
                    type="radio"
                    name={`${segId}.pick`}
                    value={o.id}
                    checked={values[`${segId}.pick`] === o.id}
                    onChange={() => setValues((v) => ({ ...v, [`${segId}.pick`]: o.id }))}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          ) : null}
        </fieldset>
      ))}
      {validation ? (
        <p className="error" role="alert">
          {validation}
        </p>
      ) : null}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? '提交中…' : '提交作答'}
      </button>
      <span className="hint"> 配对题每项都可以选「{UNSURE.label}」；数值题提交需要给数值；输出题逐行填写整数。</span>
    </form>
  );
}

export function ExplainForm({
  selections,
  freeTextPrompt,
  onSubmit,
  busy,
}: {
  selections: Array<{ itemId: string; prompt: string; multi?: boolean; options: Array<{ id: string; label: string }> }>;
  freeTextPrompt: string;
  onSubmit: (payload: { selections: Array<{ itemId: string; selectedOptionIds: string[] }>; freeText: string; transcribedByGuardian: boolean }) => void;
  busy: boolean;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState('');
  const [transcribed, setTranscribed] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);

  return (
    <form
      className="explain-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!freeText.trim()) {
          setValidation('请写下你的解释（一两句也可以）。');
          return;
        }
        setValidation(null);
        onSubmit({
          selections: Object.entries(picked)
            .filter(([, ids]) => ids.length > 0)
            .map(([itemId, ids]) => ({ itemId, selectedOptionIds: ids })),
          freeText,
          transcribedByGuardian: transcribed,
        });
      }}
    >
      {selections.map((sel) => (
        <fieldset key={sel.itemId} className="ask">
          <legend>{sel.prompt}</legend>
          {sel.options.map((o) => (
            <label key={o.id} className="radio-line">
              <input
                type={sel.multi ? 'checkbox' : 'radio'}
                name={sel.itemId}
                value={o.id}
                checked={(picked[sel.itemId] ?? []).includes(o.id)}
                onChange={(e) =>
                  setPicked((p) => {
                    const cur = p[sel.itemId] ?? [];
                    if (sel.multi) {
                      return { ...p, [sel.itemId]: e.target.checked ? [...cur, o.id] : cur.filter((x) => x !== o.id) };
                    }
                    return { ...p, [sel.itemId]: e.target.checked ? [o.id] : cur };
                  })
                }
              />
              {o.label}
            </label>
          ))}
        </fieldset>
      ))}
      <fieldset className="ask">
        <label className="stack">
          {freeTextPrompt}
          <textarea
            rows={3}
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="用你自己的话写一两句（只保存给家人看，不自动打分）"
          />
        </label>
      </fieldset>
      <label className="radio-line">
        <input type="checkbox" checked={transcribed} onChange={(e) => setTranscribed(e.target.checked)} />
        由监护人逐字代录（孩子口述）
      </label>
      {validation ? (
        <p className="error" role="alert">
          {validation}
        </p>
      ) : null}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? '保存中…' : '保存解释'}
      </button>
    </form>
  );
}
