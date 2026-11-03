/**
 * StepsPanel: the learner-facing dual expression for rondo.steps@1
 * (cpp.steps.v1) — STEP_TABLE (step-card table, program view) +
 * STATE_TRACE (variable timeline + output pane, state view). Both are pure
 * DOM (no WebGL dependency); the two cursors stay synchronized; keyboard and
 * mouse produce identical typed intents (SCENE-CONTRACTS §1/§6, A-5).
 *
 * The preview is computed with the SAME shared interpreter the server-side
 * judging uses (modules/scenes/steps/engine.ts) — the preview is
 * deterministic but never the answer authority.
 *
 * Fixed labelling per UNIT-SPEC §2.5: every demo surface says 「步骤演示
 * （教学模型）」and the teaching-model differences from real C++ are spelled
 * out (loop var read-only, bound evaluated once, no while editing, 200-step
 * budget, |v| <= 1e9). `code.requestRun` stays CAPABILITY_UNAVAILABLE — this
 * panel is never presented as compiled-run output.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { StepOperationV1, StepProgramStateV1, StepSpecV1 } from '../../../../modules/contracts/public/scene-steps';
import {
  runStepProgram,
  validateStepEdit,
  type StepRunResult,
  type StepTraceEntry,
} from '../../../../modules/scenes/steps/engine';
import type { UiTask } from '../content/bundled';
import { materialVisible, stepsConstraintsOf } from '../content/bundled';

export interface StepsPanelProps {
  task: UiTask;
  phase: string;
  confirmedState: StepProgramStateV1;
  onConfirmOperation: (op: StepOperationV1) => void;
  busy: boolean;
}

interface DraftInsert {
  kind: 'ASSIGN' | 'OUTPUT';
  path: string; // e.g. "root" | "step[1].body"
  index: number;
  varName: string;
  expr: string;
}

export function StepsPanel({ task, phase, confirmedState, onConfirmOperation, busy }: StepsPanelProps) {
  const constraints = stepsConstraintsOf(task);
  const run: StepRunResult = useMemo(
    () => runStepProgram(confirmedState.program, confirmedState.inputs),
    [confirmedState.program, confirmedState.inputs],
  );
  const traceLen = run.trace.length;
  const cursor = Math.max(0, Math.min(confirmedState.cursorStep, traceLen));

  const editingAllowed =
    (phase === 'OPERATE' || phase === 'VERIFY') && constraints !== null && task.allowedOperationIds.includes('EditStepProgram');
  const traceVisible = materialVisible(task, 'view.trace-controls', phase) || materialVisible(task, 'view.output-pane', phase);

  // draft program mirrors the confirmed card; resets when the card changes
  const [draft, setDraft] = useState<StepSpecV1[]>(() => clone(confirmedState.program));
  const [draftError, setDraftError] = useState<string | null>(null);
  const [insert, setInsert] = useState<DraftInsert | null>(null);
  useEffect(() => {
    setDraft(clone(confirmedState.program));
    setDraftError(null);
    setInsert(null);
  }, [confirmedState.program]);

  const draftVerdict = useMemo(() => {
    if (!constraints) return null;
    if (JSON.stringify(draft) === JSON.stringify(confirmedState.program)) return null;
    return validateStepEdit(confirmedState.program, draft, confirmedState.inputs, constraints);
  }, [draft, confirmedState.program, confirmedState.inputs, constraints]);

  const setCursor = (index: number) => {
    onConfirmOperation({ type: 'SetTraceCursor', mode: 'AT', index: Math.max(0, Math.min(index, traceLen)) });
  };

  const confirmEdit = () => {
    if (!constraints) return;
    onConfirmOperation({ type: 'EditStepProgram', steps: draft });
  };

  const traceRef = useRef<HTMLDivElement>(null);
  const onTraceKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    switch (e.key) {
      case 'ArrowRight':
        setCursor(cursor + 1);
        e.preventDefault();
        break;
      case 'ArrowLeft':
        setCursor(cursor - 1);
        e.preventDefault();
        break;
      case 'Home':
      case '0':
        setCursor(0);
        e.preventDefault();
        break;
      case 'End':
        setCursor(traceLen);
        e.preventDefault();
        break;
      case 'ArrowUp':
        (e.currentTarget.previousElementSibling?.querySelector<HTMLButtonElement>('[data-focus-step]') ?? null)?.focus();
        e.preventDefault();
        break;
      case 'ArrowDown':
        (e.currentTarget.nextElementSibling?.querySelector<HTMLButtonElement>('[data-focus-out]') ?? null)?.focus();
        e.preventDefault();
        break;
      default:
        break;
    }
  };

  const timeline = useMemo(() => timelineUpTo(run.trace, confirmedState.inputs, cursor), [run.trace, confirmedState.inputs, cursor]);
  const outputLines = useMemo(
    () => run.trace.slice(0, cursor).filter((t) => t.kind === 'OUTPUT').map((t) => t.outputLine ?? ''),
    [run.trace, cursor],
  );

  return (
    <div className="scene-panel steps-panel">
      <div className="scene-mode" aria-live="polite">
        步骤演示（教学模型） · 双表达：步骤卡（程序视角） + 变量时间线（状态视角） · 无 WebGL 依赖
      </div>
      <details className="model-note">
        <summary>教学模型约定（与真实 C++ 的差异）</summary>
        <ul>
          <li>循环变量（如 i）在循环体内只读；界限在进循环前只求值一次。</li>
          <li>编辑面不启用 while / do-while / break / continue / 嵌套循环 / 复合赋值 / 自增自减。</li>
          <li>步数上限 200（按执行的赋值/输出语句计数）；到达上限会停下，不会演示成无限循环或崩溃。</li>
          <li>整数域：绝对值不超过 1,000,000,000，越界会停下（不回绕）。除法向 0 取整，余数符号跟被除数（C++ 规则）。</li>
          <li>这不是编译运行结果；真实 C++ 编译执行不在本单元范围。</li>
        </ul>
      </details>

      <h3 className="expr-title" data-focus-step-title>表达一 · 步骤卡（STEP_TABLE）</h3>
      <div className="step-table" role="table" aria-label="步骤卡：每步一行，可编辑槽位高亮">
        {constraints ? (
          <StepBlockEditor
            steps={draft}
            confirmedSteps={confirmedState.program}
            pathPrefix="step"
            constraints={constraints}
            editingAllowed={editingAllowed}
            onDraft={(next) => setDraft(next)}
            onRequestInsert={(path, index, kind) =>
              setInsert({ kind, path, index, varName: kind === 'ASSIGN' ? '' : '', expr: '' })
            }
            onDelete={(topIndex) => {
              if (!constraints.deletableSteps.includes(topIndex)) return;
              setDraft(draft.filter((_, i) => i !== topIndex));
            }}
          />
        ) : (
          <p className="hint">本题未登记步骤卡约束。</p>
        )}
        {insert ? (
          <InsertComposer
            insert={insert}
            onChange={setInsert}
            onCommit={() => {
              const next = applyInsert(clone(draft), insert);
              if (next) setDraft(next);
              setInsert(null);
            }}
            onCancel={() => setInsert(null)}
          />
        ) : null}
        {editingAllowed ? (
          <div className="btnrow">
            <button
              type="button"
              className="primary"
              disabled={busy || draftVerdict === null || !draftVerdict.ok}
              data-focus-step
              onClick={confirmEdit}
            >
              确认卡片改动（EditStepProgram）
            </button>
            <button type="button" disabled={busy} onClick={() => setDraft(clone(confirmedState.program))}>
              撤回草稿
            </button>
            {draftVerdict && !draftVerdict.ok ? (
              <span className="error" role="alert">
                {draftVerdict.rejection.message}
              </span>
            ) : null}
            {draftError ? <span className="error" role="alert">{draftError}</span> : null}
          </div>
        ) : (
          <p className="hint">编辑控件在「操作」阶段开放（预测阶段先看程序再猜）。</p>
        )}
      </div>

      <h3 className="expr-title">表达二 · 变量时间线（STATE_TRACE）</h3>
      {traceVisible ? (
        <div
          ref={traceRef}
          className="trace-region"
          tabIndex={0}
          role="application"
          aria-label="变量时间线：聚焦后用左右方向键单步，Home/0 复位，End 跳到结尾，上下方向键在步骤卡与输出窗之间移动"
          onKeyDown={onTraceKeyDown}
        >
          <div className="btnrow">
            <button type="button" onClick={() => setCursor(0)}>
              复位（0）
            </button>
            <button type="button" onClick={() => setCursor(cursor - 1)} disabled={cursor <= 0}>
              ← 上一状态
            </button>
            <button type="button" onClick={() => setCursor(cursor + 1)} disabled={cursor >= traceLen}>
              下一状态（→）
            </button>
            <button type="button" onClick={() => setCursor(traceLen)}>
              跳至结尾（End）
            </button>
            <span className="hint">
              第 {cursor} / {traceLen} 步
            </span>
          </div>
          <table className="measure-table trace-table" aria-label="变量时间线">
            <thead>
              <tr>
                <th>步</th>
                <th>语句位置</th>
                <th>发生了什么</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((row) => (
                <tr key={row.seq} className={row.seq === cursor ? 'current-step' : undefined}>
                  <td>{row.seq}</td>
                  <td>{row.where}</td>
                  <td>{row.what}</td>
                </tr>
              ))}
              {timeline.length === 0 ? (
                <tr>
                  <td colSpan={3}>（还没有执行；点「下一状态」开始单步）</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <VarsAtCursor trace={run.trace} inputs={confirmedState.inputs} cursor={cursor} />
        </div>
      ) : (
        <p className="hint">时间线与输出窗在「操作」阶段开放——预测阶段先不运行。</p>
      )}
      {materialVisible(task, 'view.output-pane', phase) ? (
        <div className="output-pane" data-focus-out>
          <h4>输出窗（每行一个数，来自输出语句的执行）</h4>
          <pre aria-live="polite">{outputLines.length ? outputLines.join('\n') : '（还没有输出）'}</pre>
          {run.status === 'HALTED' && run.haltReason ? (
            <p className="error">
              {run.haltReason === 'STEP_BUDGET_EXHAUSTED'
                ? '步数用尽（教学模型上限 200 步）——程序在这里停下，这是教学模型的边界，不是程序崩溃。'
                : run.haltReason === 'VALUE_OUT_OF_RANGE'
                  ? '值超出教学模型范围（|v| ≤ 1,000,000,000），教学模型停下了。'
                  : run.haltReason === 'DIVISION_BY_ZERO'
                    ? '除以 0：教学模型在这里停下。'
                    : '用到了还没有值的变量，教学模型停下了。'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// STEP_TABLE editor (slot-level, constraint-gated)
// ---------------------------------------------------------------------------

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function StepBlockEditor(props: {
  steps: StepSpecV1[];
  confirmedSteps: StepSpecV1[];
  pathPrefix: string;
  constraints: NonNullable<ReturnType<typeof stepsConstraintsOf>>;
  editingAllowed: boolean;
  onDraft: (next: StepSpecV1[]) => void;
  onRequestInsert: (path: string, index: number, kind: 'ASSIGN' | 'OUTPUT') => void;
  onDelete: (topIndex: number) => void;
}): JSX.Element {
  const { steps, confirmedSteps, pathPrefix, constraints, editingAllowed, onDraft, onRequestInsert, onDelete } = props;
  const insertableHere = (path: string): Array<'ASSIGN' | 'OUTPUT'> => {
    const out: Array<'ASSIGN' | 'OUTPUT'> = [];
    if (!editingAllowed) return out;
    // top-level inserts allowed anywhere; nested inserts only into FOR bodies
    // and IF branches as addressed by this unit's constraints
    if (path === 'root' || path.endsWith('.body') || path.endsWith('.then') || path.endsWith('.else')) {
      for (const k of ['ASSIGN', 'OUTPUT'] as const) {
        if ((constraints.insertableKinds as readonly string[]).includes(k)) out.push(k);
      }
    }
    return out;
  };

  return (
    <div className="step-block">
      {steps.map((step, i) => {
        const path = `${pathPrefix === 'step' ? `step[${i}]` : `${pathPrefix}[${i}]`}`;
        return (
          <StepRow
            key={i}
            step={step}
            confirmedStep={confirmedSteps[i]}
            path={path}
            topIndex={pathPrefix === 'step' ? i : undefined}
            constraints={constraints}
            editingAllowed={editingAllowed}
            onDraft={onDraft}
            draft={steps}
            onRequestInsert={onRequestInsert}
            onDelete={onDelete}
            insertableHere={insertableHere}
            blockPath={pathPrefix === 'step' ? 'root' : pathPrefix}
            indexInBlock={i}
          />
        );
      })}
      {insertableHere(pathPrefix === 'step' ? 'root' : pathPrefix).map((kind) => (
        <button
          key={kind}
          type="button"
          className="insert-btn"
          onClick={() => onRequestInsert(pathPrefix === 'step' ? 'root' : pathPrefix, steps.length, kind)}
        >
          + 在末尾插入 {kind === 'ASSIGN' ? '赋值' : '输出'}语句
        </button>
      ))}
    </div>
  );
}

function StepRow(props: {
  step: StepSpecV1;
  confirmedStep: StepSpecV1 | undefined;
  path: string;
  topIndex: number | undefined;
  constraints: NonNullable<ReturnType<typeof stepsConstraintsOf>>;
  editingAllowed: boolean;
  draft: StepSpecV1[];
  onDraft: (next: StepSpecV1[]) => void;
  onRequestInsert: (path: string, index: number, kind: 'ASSIGN' | 'OUTPUT') => void;
  onDelete: (topIndex: number) => void;
  insertableHere: (path: string) => Array<'ASSIGN' | 'OUTPUT'>;
  blockPath: string;
  indexInBlock: number;
}): JSX.Element {
  const { step, confirmedStep, path, topIndex, constraints, editingAllowed, onDraft, draft, onRequestInsert, onDelete, insertableHere, blockPath, indexInBlock } = props;

  const slotEditable = (member: string) => editingAllowed && constraints.editableSlots.includes(`${path}.${member}`);
  const domain = (member: string) => constraints.slotDomains?.[`${path}.${member}`];
  const changed = (member: string) => {
    if (!confirmedStep) return true;
    const a = (step as Record<string, unknown>)[member];
    const b = (confirmedStep as Record<string, unknown>)[member];
    return a !== b;
  };

  const editField = (member: string, label: string, value: string) => {
    const dom = domain(member);
    if (dom) {
      return (
        <select
          value={dom.includes(Number(value)) ? value : ''}
          onChange={(e) => {
            const next = clone(draft);
            patchSlot(next, path, member, e.target.value);
            onDraft(next);
          }}
          aria-label={`${label}（允许的数值）`}
        >
          <option value="">（选一个数）</option>
          {dom.map((v) => (
            <option key={v} value={String(v)}>
              {v}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        type="text"
        className={changed(member) ? 'slot-input dirty' : 'slot-input'}
        value={value}
        size={Math.max(4, value.length + 2)}
        aria-label={label}
        onChange={(e) => {
          const next = clone(draft);
          patchSlot(next, path, member, e.target.value);
          onDraft(next);
        }}
      />
    );
  };

  if (step.kind === 'ASSIGN') {
    return (
      <div className="step-row">
        <code>
          {step.var} :={' '}
          {slotEditable('expr') ? editField('expr', `${step.var} 的表达式`, step.expr) : <span className="slot">{step.expr}</span>}
        </code>
        {topIndex !== undefined && editingAllowed && constraints.deletableSteps.includes(topIndex) ? (
          <button type="button" className="insert-btn" onClick={() => onDelete(topIndex)}>
            删除此行
          </button>
        ) : null}
        {insertableHere(blockPath).map((kind) => (
          <button key={kind} type="button" className="insert-btn" onClick={() => onRequestInsert(blockPath, indexInBlock + 1, kind)}>
            + {kind === 'ASSIGN' ? '赋值' : '输出'}
          </button>
        ))}
      </div>
    );
  }
  if (step.kind === 'OUTPUT') {
    return (
      <div className="step-row">
        <code>
          输出{' '}
          {slotEditable('expr') ? editField('expr', '输出表达式', step.expr) : <span className="slot">{step.expr}</span>}
        </code>
        {topIndex !== undefined && editingAllowed && constraints.deletableSteps.includes(topIndex) ? (
          <button type="button" className="insert-btn" onClick={() => onDelete(topIndex)}>
            删除此行
          </button>
        ) : null}
        {insertableHere(blockPath).map((kind) => (
          <button key={kind} type="button" className="insert-btn" onClick={() => onRequestInsert(blockPath, indexInBlock + 1, kind)}>
            + {kind === 'ASSIGN' ? '赋值' : '输出'}
          </button>
        ))}
      </div>
    );
  }
  if (step.kind === 'IF') {
    return (
      <div className="step-row struct">
        <code>
          如果 ({slotEditable('cond') ? editField('cond', '判断条件', step.cond) : <span className="slot">{step.cond}</span>}) {'{'}
        </code>
        <div className="step-block nested">
          <StepBlockEditor
            steps={step.then}
            confirmedSteps={(confirmedStep as Extract<StepSpecV1, { kind: 'IF' }> | undefined)?.then ?? []}
            pathPrefix={`${path}.then`}
            constraints={constraints}
            editingAllowed={editingAllowed}
            onDraft={(thenNext) => {
              const next = clone(draft);
              patchBlock(next, `${path}.then`, thenNext);
              onDraft(next);
            }}
            onRequestInsert={onRequestInsert}
            onDelete={onDelete}
          />
        </div>
        <code>{'} 否则 {'}</code>
        <div className="step-block nested">
          <StepBlockEditor
            steps={step.else}
            confirmedSteps={(confirmedStep as Extract<StepSpecV1, { kind: 'IF' }> | undefined)?.else ?? []}
            pathPrefix={`${path}.else`}
            constraints={constraints}
            editingAllowed={editingAllowed}
            onDraft={(elseNext) => {
              const next = clone(draft);
              patchBlock(next, `${path}.else`, elseNext);
              onDraft(next);
            }}
            onRequestInsert={onRequestInsert}
            onDelete={onDelete}
          />
        </div>
        <code>{'}'}</code>
      </div>
    );
  }
  // FOR
  return (
    <div className="step-row struct">
      <code>
        循环 {step.var} ={' '}
        {slotEditable('from') ? editField('from', '起点', step.from) : <span className="slot">{step.from}</span>}
        ；{' '}
        <span className="slot-var">{step.var}</span>{' '}
        {slotEditable('cmp') ? (
          <select
            value={step.cmp}
            onChange={(e) => {
              const next = clone(draft);
              patchSlot(next, path, 'cmp', e.target.value);
              onDraft(next);
            }}
            aria-label="界限比较符"
          >
            <option value="<">&lt;</option>
            <option value="<=">&lt;=</option>
          </select>
        ) : (
          <span className="slot">{step.cmp === '<' ? '<' : '<='}</span>
        )}{' '}
        {slotEditable('bound') ? editField('bound', '上界', step.bound) : <span className="slot">{step.bound}</span>}
        ；{step.var} = {step.var} + 1（步长固定，只读） {'{'}
      </code>
      <div className="step-block nested">
        <StepBlockEditor
          steps={step.body}
          confirmedSteps={(confirmedStep as Extract<StepSpecV1, { kind: 'FOR' }> | undefined)?.body ?? []}
          pathPrefix={`${path}.body`}
          constraints={constraints}
          editingAllowed={editingAllowed}
          onDraft={(bodyNext) => {
            const next = clone(draft);
            patchBlock(next, `${path}.body`, bodyNext);
            onDraft(next);
          }}
          onRequestInsert={onRequestInsert}
          onDelete={onDelete}
        />
      </div>
      <code>{'}'}</code>
    </div>
  );
}

/** Patches a scalar member at a slot path inside a draft program tree. */
function patchSlot(steps: StepSpecV1[], slotPath: string, member: string, value: string): void {
  const target = resolveSlot(steps, slotPath);
  if (target) (target as unknown as Record<string, unknown>)[member] = value;
}

/** Replaces a nested block addressed by a slot path prefix. */
function patchBlock(steps: StepSpecV1[], blockPath: string, nextBlock: StepSpecV1[]): void {
  const m = /^(.*)\.(then|else|body)$/.exec(blockPath);
  if (!m) return;
  const [, parentPath, seg] = m;
  const parent = parentPath === '' ? { kind: 'ROOT', body: steps } : resolveSlot(steps, parentPath);
  if (!parent) return;
  (parent as unknown as Record<string, unknown>)[seg] = nextBlock;
}

/** Resolves `step[i].then[j].body[k]`-style statement paths to the statement object. */
function resolveSlot(steps: StepSpecV1[], slotPath: string): StepSpecV1 | { kind: 'ROOT'; body: StepSpecV1[] } | null {
  const m = /^step\[(\d+)\]((?:\.(?:then|else|body)\[\d+\])*)$/.exec(slotPath);
  if (!m) return null;
  const indices = [Number(m[1]), ...[...m[2]!.matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]))];
  const segs = [...m[2]!.matchAll(/\.(then|else|body)/g)].map((x) => x[1]);
  let list: readonly StepSpecV1[] = steps;
  let stmt: StepSpecV1 | undefined;
  for (let k = 0; k < indices.length; k += 1) {
    stmt = list[indices[k]!];
    if (!stmt) return null;
    if (k < indices.length - 1) {
      const seg = segs[k];
      if (stmt.kind === 'IF') list = seg === 'else' ? stmt.else : stmt.then;
      else if (stmt.kind === 'FOR') list = stmt.body;
      else return null;
    }
  }
  return stmt ?? null;
}

function applyInsert(draft: StepSpecV1[], insert: DraftInsert): StepSpecV1[] | null {
  const stmt: StepSpecV1 | null =
    insert.kind === 'ASSIGN'
      ? { kind: 'ASSIGN', var: insert.varName.trim(), expr: insert.expr.trim() }
      : { kind: 'OUTPUT', expr: insert.expr.trim() };
  if (insert.kind === 'ASSIGN' && (!stmt || (stmt as { var: string }).var === '')) return null;
  if ((stmt as { expr?: string }).expr === '') return null;
  if (insert.path === 'root') {
    draft.splice(Math.min(insert.index, draft.length), 0, stmt);
    return draft;
  }
  const m = /^(.*)\.(then|else|body)$/.exec(insert.path);
  if (!m) return null;
  const parent = resolveSlot(draft, m[1]!);
  if (!parent) return null;
  const arr = (parent as unknown as Record<string, unknown>)[m[2]!] as StepSpecV1[];
  arr.splice(Math.min(insert.index, arr.length), 0, stmt);
  return draft;
}

function InsertComposer(props: {
  insert: DraftInsert;
  onChange: (v: DraftInsert) => void;
  onCommit: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { insert, onChange, onCommit, onCancel } = props;
  return (
    <div className="insert-composer">
      <span>插入{insert.kind === 'ASSIGN' ? '赋值' : '输出'}语句（位置：{insert.path === 'root' ? `第 ${insert.index} 行前` : `${insert.path} 第 ${insert.index} 项前`}）：</span>
      {insert.kind === 'ASSIGN' ? (
        <label>
          变量名
          <input type="text" value={insert.varName} onChange={(e) => onChange({ ...insert, varName: e.target.value })} aria-label="变量名（字母）" />
        </label>
      ) : null}
      <label>
        表达式
        <input
          type="text"
          value={insert.expr}
          onChange={(e) => onChange({ ...insert, expr: e.target.value })}
          aria-label="表达式（整数、变量、+ - * / % 和括号）"
          placeholder="例如 a 或 total + 6"
        />
      </label>
      <button type="button" onClick={onCommit}>
        加入草稿
      </button>
      <button type="button" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// STATE_TRACE helpers
// ---------------------------------------------------------------------------

function timelineUpTo(trace: readonly StepTraceEntry[], inputs: Record<string, number>, cursor: number): Array<{ seq: number; where: string; what: string }> {
  return trace.slice(0, cursor).map((t) => ({
    seq: t.seq,
    where: pathLabel(t.path),
    what: describeEntry(t),
  }));
  void inputs;
}

function describeEntry(t: StepTraceEntry): string {
  switch (t.kind) {
    case 'ASSIGN':
      return `${t.varName} 从 ${t.fromValue ?? '（无值）'} 变成 ${t.toValue}`;
    case 'OUTPUT':
      return `输出一行：${t.outputLine}`;
    case 'IF_CHECK':
      return `判断 ${t.condText}：${t.condResult ? '成立，走大括号这边' : '不成立，走另一边/跳过'}`;
    case 'FOR_INIT':
      return `循环开始：${t.varName} 从 ${t.fromBound?.from} 起，界限 ${t.fromBound?.bound}（只求值一次）`;
    case 'FOR_CHECK':
      return `循环检查 ${t.condText}（此刻 ${t.varName}=${t.toValue}）：${t.condResult ? '继续' : '退出循环'}`;
  }
}

function pathLabel(path: readonly number[]): string {
  return `第 ${path.map((i) => i + 1).join('.')} 句`;
}

function VarsAtCursor(props: { trace: readonly StepTraceEntry[]; inputs: Record<string, number>; cursor: number }): JSX.Element {
  const vars = useMemo(() => {
    const env = new Map<string, number>(Object.entries(props.inputs));
    for (const t of props.trace.slice(0, props.cursor)) {
      if (t.kind === 'ASSIGN' && t.varName !== undefined && t.toValue !== undefined) env.set(t.varName, t.toValue);
      if (t.kind === 'FOR_INIT' && t.varName !== undefined && t.fromBound !== undefined) env.set(t.varName, t.fromBound.from);
      if (t.kind === 'FOR_CHECK' && t.varName !== undefined && t.toValue !== undefined) env.set(t.varName, t.toValue);
    }
    return [...env.entries()];
  }, [props.trace, props.inputs, props.cursor]);
  return (
    <table className="measure-table vars-table" aria-label="当前变量值">
      <thead>
        <tr>
          <th>变量</th>
          <th>现在的值</th>
        </tr>
      </thead>
      <tbody>
        {vars.map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
