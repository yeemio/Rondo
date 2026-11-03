/**
 * BoardPanel: the learner-facing scene surface for rondo.gridboard@1 tasks
 * (themes.micro.v1 / themes.frac.v1) and the 微课① circle projection
 * (rondo.cylinder@1 base circle, SetDimension RADIUS only).
 *
 * Every domain operation is CONFIRM-gated: steppers/scale buttons edit a
 * local draft; the 确认 button emits exactly one canonical typed operation
 * (same intent from keyboard and pointer — steppers are native number
 * inputs, arrows work). The figure and readout always render the CONFIRMED
 * state; drafts are labelled 未确认. No WebGL dependency (SVG/DOM only).
 */
import { useEffect, useState } from 'react';
import type { CylinderOperationV1, CylinderStateV1 } from '../../../../modules/contracts/public/scene';
import type { GridBoardStateV1, GridOperationV1 } from '../../../../modules/contracts/public/scene-gridboard';
import type { UiTask } from '../content/bundled';
import { materialVisible } from '../content/bundled';

interface GridConstraint {
  type: 'SetGridSize' | 'SetFilled' | 'ScaleBoth' | 'SetDimension';
  rowsValues?: number[];
  colsValues?: number[];
  maxCount?: number;
  multipliers?: number[];
  dimension?: 'RADIUS' | 'HEIGHT';
  minMm?: number;
  maxMm?: number;
}

const STEPPABLE = new Set(['SetGridSize', 'SetFilled', 'ScaleBoth', 'SetDimension']);

export function BoardPanel({
  task,
  phase,
  confirmedState,
  onConfirmOperation,
}: {
  task: UiTask;
  phase: string;
  confirmedState: CylinderStateV1 | GridBoardStateV1;
  onConfirmOperation: (op: CylinderOperationV1 | GridOperationV1) => void;
}) {
  const isCylinder = 'radiusMm' in confirmedState;
  const constraints = (task.operationConstraints ?? []) as unknown as GridConstraint[];
  const opsAllowed = phase === 'OPERATE' || phase === 'VERIFY' || phase === 'EXPLAIN';
  const canOperate = opsAllowed && task.allowedOperationIds.some((op) => STEPPABLE.has(op));

  // draft mirrors the confirmed state; a change marks 未确认 until 确认
  const [draft, setDraft] = useState<CylinderStateV1 | GridBoardStateV1>(confirmedState);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDraft(confirmedState);
    setDirty(false);
  }, [confirmedState]);

  const update = (next: CylinderStateV1 | GridBoardStateV1) => {
    setDraft(next);
    setDirty(true);
  };

  const confirmOp = () => {
    if (!dirty) return;
    if (isCylinder) {
      const c = draft as CylinderStateV1;
      const b = confirmedState as CylinderStateV1;
      if (c.radiusMm !== b.radiusMm) onConfirmOperation({ type: 'SetDimension', dimension: 'RADIUS', valueMm: c.radiusMm });
      else if (c.heightMm !== b.heightMm) onConfirmOperation({ type: 'SetDimension', dimension: 'HEIGHT', valueMm: c.heightMm });
      setDirty(false);
      return;
    }
    const g = draft as GridBoardStateV1;
    const b = confirmedState as GridBoardStateV1;
    if (g.rows !== b.rows) {
      onConfirmOperation({ type: 'SetGridSize', rows: g.rows });
    } else if (g.cols !== b.cols) {
      onConfirmOperation({ type: 'SetGridSize', cols: g.cols });
    } else if (g.filled !== b.filled) {
      onConfirmOperation({ type: 'SetFilled', count: g.filled });
    }
    setDirty(false);
  };

  const scale = (m: 2 | 3 | 4) => {
    if (!('cols' in confirmedState)) return;
    onConfirmOperation({ type: 'ScaleBoth', multiplier: m });
  };

  const sizeC = constraints.find((c) => c.type === 'SetGridSize');
  const fillC = constraints.find((c) => c.type === 'SetFilled');
  const scaleC = constraints.find((c) => c.type === 'ScaleBoth');
  const dimC = constraints.find((c) => c.type === 'SetDimension' && c.dimension === 'RADIUS');

  const view = task.boardView ?? 'PIE';
  const showReadout = materialVisible(task, 'card.state-readout', phase);

  return (
    <div className="board-panel">
      <figure className="board-figure" aria-label={`图板（${view}）`}>
        {isCylinder ? <CircleFlat state={draft as CylinderStateV1} /> : <GridView view={view} state={draft as GridBoardStateV1} />}
        <figcaption className="board-caption">
          图板（SVG/表格双表达同状态；下方读数随确认更新）{dirty ? ' · 有未确认改动' : ''}
        </figcaption>
      </figure>

      {showReadout ? (
        <table className="measure-table board-readout" aria-label="当前读数">
          <tbody>{isCylinder ? <CircleReadout state={draft as CylinderStateV1} /> : <GridReadout view={view} state={draft as GridBoardStateV1} />}</tbody>
        </table>
      ) : null}

      {canOperate ? (
        <div className="board-controls" role="group" aria-label="图板操作（需确认）">
          {!isCylinder && sizeC ? (
            <>
              {sizeC.rowsValues && sizeC.rowsValues.length > 1 ? (
                <Stepper
                  label={view === 'DOTARRAY' || view === 'RECT' ? '行数' : '行数'}
                  value={(draft as GridBoardStateV1).rows}
                  values={sizeC.rowsValues}
                  onChange={(rows) => update({ ...(draft as GridBoardStateV1), rows })}
                />
              ) : null}
              {sizeC.colsValues && sizeC.colsValues.length > 1 ? (
                <Stepper
                  label={view === 'PIE' || view === 'BAR' || view === 'BAR_NUMBERLINE' || view === 'NUMBERLINE' ? '平均份数' : '列数'}
                  value={(draft as GridBoardStateV1).cols}
                  values={sizeC.colsValues}
                  onChange={(cols) => update({ ...(draft as GridBoardStateV1), cols })}
                />
              ) : null}
            </>
          ) : null}
          {!isCylinder && fillC ? (
            <Stepper
              label="涂色份数"
              value={(draft as GridBoardStateV1).filled}
              min={0}
              max={fillC.maxCount ?? (draft as GridBoardStateV1).rows * (draft as GridBoardStateV1).cols}
              onChange={(filled) => update({ ...(draft as GridBoardStateV1), filled })}
            />
          ) : null}
          {isCylinder && dimC ? (
            <Stepper
              label="半径（mm）"
              value={(draft as CylinderStateV1).radiusMm}
              min={dimC.minMm ?? 10}
              max={dimC.maxMm ?? 100}
              step={5}
              onChange={(radiusMm) => update({ ...(draft as CylinderStateV1), radiusMm })}
            />
          ) : null}
          <div className="btnrow">
            <button className="primary" onClick={confirmOp} disabled={!dirty}>
              确认改动{dirty ? '（未确认）' : ''}
            </button>
            {scaleC
              ? scaleC.multipliers?.map((m) => (
                  <button key={m} onClick={() => scale(m as 2 | 3 | 4)}>
                    份数和涂色同乘 {m}（×{m}）
                  </button>
                ))
              : null}
          </div>
          <p className="hint">步进框可用方向键微调；只有点「确认」才会保存为一条操作记录。</p>
        </div>
      ) : null}
    </div>
  );
}

function Stepper({
  label,
  value,
  onChange,
  values,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  values?: number[];
  min?: number;
  max?: number;
  step?: number;
}) {
  const clamp = (v: number) => {
    if (values) {
      const sorted = [...values].sort((a, b) => a - b);
      const idx = sorted.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(sorted[best] - v) ? i : best), 0);
      return sorted[idx];
    }
    const lo = min ?? 0;
    const hi = max ?? 100;
    return Math.max(lo, Math.min(hi, v));
  };
  const move = (dir: 1 | -1) => {
    if (values) {
      const sorted = [...values].sort((a, b) => a - b);
      const idx = sorted.indexOf(value);
      const next = sorted[Math.max(0, Math.min(sorted.length - 1, (idx === -1 ? 0 : idx) + dir))];
      onChange(next);
      return;
    }
    onChange(clamp(value + dir * step));
  };
  return (
    <label className="board-stepper">
      {label}：
      <button type="button" onClick={() => move(-1)} aria-label={`${label}减少`}>
        −
      </button>
      <input
        type="number"
        value={value}
        min={values ? Math.min(...values) : min}
        max={values ? Math.max(...values) : max}
        step={values ? 1 : step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!Number.isNaN(v)) onChange(clamp(v));
        }}
        aria-label={label}
      />
      <button type="button" onClick={() => move(1)} aria-label={`${label}增加`}>
        ＋
      </button>
    </label>
  );
}

// ---------------------------------------------------------------------------
// figure renderers (SVG; all from the state — confirmed or draft-labelled)
// ---------------------------------------------------------------------------

function CircleFlat({ state }: { state: CylinderStateV1 }) {
  const rPx = (state.radiusMm / 100) * 110 + 30;
  const cx = 160;
  const cy = 130;
  const rCm = (state.radiusMm / 10).toFixed(1);
  const dCm = ((2 * state.radiusMm) / 10).toFixed(1);
  return (
    <svg viewBox="0 0 320 260" width="100%" role="img" aria-label={`俯视圆：半径 ${rCm} cm，直径 ${dCm} cm`}>
      <circle cx={cx} cy={cy} r={rPx} fill="#eef4ff" stroke="#35507a" strokeWidth="2" />
      <line x1={cx} y1={cy} x2={cx + rPx} y2={cy} stroke="#1f6f54" strokeWidth="3" markerEnd="" />
      <line x1={cx - rPx} y1={cy} x2={cx + rPx} y2={cy} stroke="#b3541e" strokeWidth="2.5" />
      <circle cx={cx} cy={cy} r="3" fill="#22314e" />
      <text x={cx + rPx / 2} y={cy - 8} fontSize="13" fill="#1f6f54">
        半径 r = {rCm} cm
      </text>
      <text x={cx - rPx} y={cy + rPx + 18} fontSize="13" fill="#b3541e" textAnchor="start">
        直径 d = {dCm} cm
      </text>
    </svg>
  );
}

function GridView({ view, state }: { view: string; state: GridBoardStateV1 }) {
  switch (view) {
    case 'PIE':
      return <PieView cols={state.cols} filled={state.filled} />;
    case 'BAR':
      return <BarView cols={state.cols} filled={state.filled} />;
    case 'BAR_NUMBERLINE':
      return (
        <div>
          <BarView cols={state.cols} filled={state.filled} />
          <NumberlineView cols={state.cols} filled={state.filled} />
        </div>
      );
    case 'NUMBERLINE':
      return <NumberlineView cols={state.cols} filled={state.filled} tall />;
    case 'HUNDRED':
      return <HundredView filled={state.filled} />;
    case 'RECT':
      return <RectView rows={state.rows} cols={state.cols} />;
    case 'DOTARRAY':
      return <DotArrayView rows={state.rows} cols={state.cols} filled={state.filled} />;
    case 'UNIT_TRIO':
      return <UnitTrio />;
    default:
      return <PieView cols={state.cols} filled={state.filled} />;
  }
}

function PieView({ cols, filled }: { cols: number; filled: number }) {
  const cx = 160;
  const cy = 125;
  const r = 100;
  const slices = [];
  for (let i = 0; i < cols; i++) {
    const a0 = (i / cols) * 2 * Math.PI - Math.PI / 2;
    const a1 = ((i + 1) / cols) * 2 * Math.PI - Math.PI / 2;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    slices.push(
      <path
        key={i}
        d={`M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1} Z`}
        fill={i < filled ? '#f5c26b' : '#f4f7fb'}
        stroke="#35507a"
        strokeWidth="1.5"
      />,
    );
  }
  return (
    <svg viewBox="0 0 320 250" width="100%" role="img" aria-label={`圆盘：平均 ${cols} 份，涂色 ${filled} 份`}>
      {slices}
      <circle cx={cx} cy={cy} r="3" fill="#22314e" />
    </svg>
  );
}

function BarView({ cols, filled }: { cols: number; filled: number }) {
  const w = 280 / cols;
  const cells = [];
  for (let i = 0; i < cols; i++) {
    cells.push(<rect key={i} x={20 + i * w} y={70} width={w} height={56} fill={i < filled ? '#f5c26b' : '#f4f7fb'} stroke="#35507a" strokeWidth="1.5" />);
  }
  return (
    <svg viewBox="0 0 320 140" width="100%" role="img" aria-label={`条带：平均 ${cols} 份，涂色 ${filled} 份`}>
      {cells}
      <text x="20" y="62" fontSize="12" fill="#22314e">
        0
      </text>
      <text x="300" y="62" fontSize="12" fill="#22314e" textAnchor="end">
        1（整条）
      </text>
    </svg>
  );
}

function NumberlineView({ cols, filled, tall }: { cols: number; filled: number; tall?: boolean }) {
  const x0 = 25;
  const x1 = 295;
  const step = (x1 - x0) / cols;
  const marks = [];
  for (let i = 0; i <= cols; i++) {
    marks.push(<line key={i} x1={x0 + i * step} y1={tall ? 120 : 140} x2={x0 + i * step} y2={(tall ? 120 : 140) - 8} stroke="#22314e" strokeWidth="1.5" />);
  }
  const px = x0 + filled * step;
  return (
    <svg viewBox="0 0 320 170" width="100%" role="img" aria-label={`数轴：0 到 1 平均分成 ${cols} 格，点在第 ${filled} 格`}>
      <line x1={x0} y1={tall ? 120 : 140} x2={x1} y2={tall ? 120 : 140} stroke="#22314e" strokeWidth="2" />
      {marks}
      <circle cx={px} cy={tall ? 120 : 140} r="7" fill="#1f6f54" stroke="#12291f" strokeWidth="1.5" />
      <text x={x0} y={tall ? 148 : 165} fontSize="12" fill="#22314e">
        0
      </text>
      <text x={x1} y={tall ? 148 : 165} fontSize="12" fill="#22314e" textAnchor="end">
        1
      </text>
      {tall ? (
        <text x={px} y={98} fontSize="12" fill="#1f6f54" textAnchor="middle">
          点在这里
        </text>
      ) : null}
    </svg>
  );
}

function HundredView({ filled }: { filled: number }) {
  const cells = [];
  const size = 26;
  for (let i = 0; i < 100; i++) {
    const row = Math.floor(i / 10);
    const col = i % 10;
    cells.push(
      <rect
        key={i}
        x={28 + col * size}
        y={18 + row * size}
        width={size - 2}
        height={size - 2}
        fill={i < filled ? '#f5c26b' : '#f4f7fb'}
        stroke="#35507a"
        strokeWidth="1"
      />,
    );
  }
  return (
    <svg viewBox="0 0 320 300" width="100%" role="img" aria-label={`百格板：100 格，涂色 ${filled} 格`}>
      {cells}
    </svg>
  );
}

function RectView({ rows, cols }: { rows: number; cols: number }) {
  const cell = Math.min(220 / Math.max(rows, 1), 260 / Math.max(cols, 1), 40);
  const w = cols * cell;
  const h = rows * cell;
  const x0 = (320 - w) / 2;
  const y0 = (240 - h) / 2;
  const lines = [];
  for (let i = 0; i <= cols; i++) lines.push(<line key={`v${i}`} x1={x0 + i * cell} y1={y0} x2={x0 + i * cell} y2={y0 + h} stroke="#9db3d2" strokeWidth="1" />);
  for (let j = 0; j <= rows; j++) lines.push(<line key={`h${j}`} x1={x0} y1={y0 + j * cell} x2={x0 + w} y2={y0 + j * cell} stroke="#9db3d2" strokeWidth="1" />);
  return (
    <svg viewBox="0 0 320 240" width="100%" role="img" aria-label={`长方形：${rows} 行 × ${cols} 列，每格 1 厘米见方`}>
      <rect x={x0} y={y0} width={w} height={h} fill="#eef4ff" stroke="#35507a" strokeWidth="2" />
      {lines}
      <text x={x0 + w / 2} y={y0 - 8} fontSize="12" fill="#22314e" textAnchor="middle">
        长 {cols} cm
      </text>
      <text x={x0 - 8} y={y0 + h / 2} fontSize="12" fill="#22314e" textAnchor="end">
        宽 {rows} cm
      </text>
    </svg>
  );
}

function DotArrayView({ rows, cols, filled }: { rows: number; cols: number; filled: number }) {
  const cell = Math.min(240 / Math.max(rows, 1), 270 / Math.max(cols, 1), 36);
  const dots = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      dots.push(<circle key={idx} cx={35 + c * cell} cy={28 + r * cell} r={Math.min(cell / 3, 8)} fill={idx < filled ? '#1f6f54' : '#c8d4e6'} />);
    }
  }
  return (
    <svg viewBox="0 0 320 250" width="100%" role="img" aria-label={`点阵：${rows} 行 × 每行 ${cols} 个，高亮 ${filled} 个`}>
      {dots}
    </svg>
  );
}

function UnitTrio() {
  return (
    <svg viewBox="0 0 320 180" width="100%" role="img" aria-label="单位图例：1 厘米线段、1 平方厘米正方形、1 立方厘米正方体">
      {/* 1 cm line */}
      <line x1="30" y1="60" x2="90" y2="60" stroke="#1f6f54" strokeWidth="3" />
      <text x="60" y="46" fontSize="12" textAnchor="middle" fill="#1f6f54">
        1 cm（长度）
      </text>
      {/* 1 cm² square */}
      <rect x="140" y="30" width="60" height="60" fill="#f5c26b" stroke="#b3541e" strokeWidth="2" />
      <text x="170" y="108" fontSize="12" textAnchor="middle" fill="#b3541e">
        1 cm²（面积）
      </text>
      {/* 1 cm³ cube (isometric) */}
      <g stroke="#35507a" strokeWidth="2" fill="#dce8f7">
        <rect x="235" y="70" width="48" height="48" />
        <polygon points="235,70 253,52 301,52 283,70" />
        <polygon points="283,70 301,52 301,100 283,118" />
      </g>
      <text x="268" y="140" fontSize="12" textAnchor="middle" fill="#35507a">
        1 cm³（体积）
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// readouts (card.state-readout projection; numbers follow the confirmed/draft state)
// ---------------------------------------------------------------------------

function CircleReadout({ state }: { state: CylinderStateV1 }) {
  return (
    <>
      <tr>
        <td>半径 r</td>
        <td>{(state.radiusMm / 10).toFixed(1)} cm</td>
      </tr>
      <tr>
        <td>直径 d</td>
        <td>{((2 * state.radiusMm) / 10).toFixed(1)} cm</td>
      </tr>
    </>
  );
}

function GridReadout({ view, state }: { view: string; state: GridBoardStateV1 }) {
  const rows: Array<[string, string]> = [];
  if (view === 'PIE' || view === 'BAR' || view === 'BAR_NUMBERLINE') {
    rows.push(['平均分成的份数（分母）', String(state.cols)]);
    rows.push(['涂色份数（分子）', String(state.filled)]);
    rows.push(['涂色部分', `${state.filled}/${state.cols}`]);
  } else if (view === 'NUMBERLINE') {
    rows.push(['平均分成的格数', String(state.cols)]);
    rows.push(['点走过的格数', String(state.filled)]);
  } else if (view === 'HUNDRED') {
    rows.push(['涂色格数', String(state.filled)]);
    rows.push(['总格数', '100']);
    rows.push(['涂色部分', `${state.filled}%`]);
  } else if (view === 'RECT') {
    rows.push(['行数（宽）', `${state.rows} cm`]);
    rows.push(['列数（长）', `${state.cols} cm`]);
    rows.push(['面积', `${state.rows * state.cols} cm²`]);
  } else if (view === 'DOTARRAY') {
    rows.push(['行数', String(state.rows)]);
    rows.push(['每行个数', String(state.cols)]);
    rows.push(['总数', String(state.rows * state.cols)]);
    if (state.filled > 0) rows.push(['高亮个数', String(state.filled)]);
  }
  return (
    <>
      {rows.map(([k, v]) => (
        <tr key={k}>
          <td>{k}</td>
          <td>{v}</td>
        </tr>
      ))}
    </>
  );
}
