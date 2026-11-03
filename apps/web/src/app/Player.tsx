/**
 * The single task player: PREDICT → OPERATE → VERIFY → EXPLAIN → REVIEW for
 * every task of both lessons, the stranger task and the delayed transfer.
 *
 * Book layout ("一课一跨页"): the LEFT page carries the lesson title, the task
 * question, the formula box, readings and the dashed activity box (the
 * current-phase form lives inside it); the RIGHT page is the 3D experiment
 * (full-bleed canvas + Fig. caption bar). Navigation is a bookmark ribbon;
 * focus order / accessible names / save-state semantics are unchanged
 * (SCENE-CONTRACTS §6). Save states are explicit
 * (未保存/发送中/已保存/结果未知·查回中); unknown outcomes resolve by the
 * ORIGINAL idempotency key, never a new one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicCommandEnvelope } from '../../../../modules/contracts/public/envelope';
import type { CommandReceipt } from '../../../../modules/contracts/public/receipts';
import type { CylinderOperationV1, CylinderStateV1, CylinderStateV2 } from '../../../../modules/contracts/public/scene';
import type { CylinderSceneState } from '../../../../modules/scenes/cylinder/controller';
import type { GridBoardStateV1, GridOperationV1 } from '../../../../modules/contracts/public/scene-gridboard';
import type { StepOperationV1, StepProgramStateV1 } from '../../../../modules/contracts/public/scene-steps';
import type { AppPorts, EvaluationView, HintView, ReviewCardView } from '../client/ports';
import { getUiTask, materialVisible, LESSONS, RESPONSE_REGISTRY, isThemesTask, isStepsTask, CPP_ENABLED_SEGMENTS } from '../content/bundled';
import { circumferenceRationalMm, lateralAreaRationalCm2, mmToCmDisplay, rationalToDecimal, sectionLabel, circleAreaRationalCm2, volumeRationalCm3, layerThicknessCmDisplay, FACE_LABELS } from '../../../../modules/scenes/cylinder/geometry';
import { newId } from './prediction';
import { useCommand } from './useCommand';
import { PredictionForm, VerifyForm, ExplainForm } from './forms';
import { ScenePanel } from './ScenePanel';
import { BoardPanel } from './BoardPanel';
import { StepsPanel } from './StepsPanel';
import { phaseText } from '../App';

interface PlayerState {
  attemptVersion: number;
  attemptStatus: string;
  cycleId: string;
  questionInstanceId: string;
  taskId: string;
  phase: string;
  sceneState: CylinderSceneState | GridBoardStateV1 | StepProgramStateV1;
  rendererContractVersion: string;
}

export function Player({
  ports,
  learnerId,
  attemptId,
  releaseId,
  onExit,
  onFinished,
}: {
  ports: AppPorts;
  learnerId: string;
  attemptId: string;
  releaseId: string;
  onExit: () => void;
  onFinished: () => void;
}) {
  const [state, setState] = useState<PlayerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationView | null>(null);
  const [hints, setHints] = useState<HintView[]>([]);
  const [reviewCard, setReviewCard] = useState<ReviewCardView | null>(null);
  const cmd = useCommand(ports.client, `${learnerId}`);
  const [tick, setTick] = useState(0);
  // Highest attemptVersion ever applied to state (from refresh results or
  // receipts). A refresh that raced an in-flight command observes the
  // pre-commit snapshot; applying such a result after a newer one would
  // regress attemptVersion by one beat and poison the next command's CAS
  // expectation (2026-10-27 browser defect: recordPrediction followed by
  // commitOperation rejected with VERSION_CONFLICT).
  const lastAppliedVersion = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const attemptView = await ports.client.query({ kind: 'learning.attemptView', attemptId });
      if (attemptView.kind !== 'learning.attemptView') throw new Error('投影类型不符');
      if (attemptView.version < lastAppliedVersion.current) return; // stale racing refresh — never regress
      lastAppliedVersion.current = attemptView.version;
      if (!attemptView.currentCycle) {
        setError('该尝试没有进行中的任务。');
        return;
      }
      const qv = await ports.client.query({
        kind: 'learning.questionView',
        attemptId,
        cycleId: attemptView.currentCycle.cycleId,
      });
      if (qv.kind !== 'learning.questionView') throw new Error('投影类型不符');
      setState({
        attemptVersion: attemptView.version,
        attemptStatus: attemptView.attemptStatus,
        cycleId: attemptView.currentCycle.cycleId,
        questionInstanceId: attemptView.currentCycle.questionInstanceId,
        taskId: qv.spec.taskId,
        phase: attemptView.currentCycle.phase,
        sceneState: qv.spec.scene.state as CylinderSceneState | GridBoardStateV1 | StepProgramStateV1,
        rendererContractVersion: qv.spec.scene.rendererContractVersion,
      });
      if (ports.view) {
        const cycleId = attemptView.currentCycle.cycleId;
        setEvaluation(await ports.view.getEvaluation(cycleId));
        setHints(await ports.view.getHints(cycleId));
        setReviewCard(await ports.view.getReviewCard(cycleId));
      }
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [ports, attemptId]);

  useEffect(() => {
    void refresh();
    const unsub = ports.client.subscribeInvalidation(() => void refresh());
    return unsub;
  }, [refresh, ports, tick]);

  const task = useMemo(() => (state ? getUiTask(state.taskId) : null), [state]);

  const envelope = useCallback(
    (kind: PublicCommandEnvelope['kind'], payload: unknown, withVersion: boolean): Record<string, unknown> => {
      if (!state) throw new Error('state 未加载');
      return {
        protocolVersion: 'rondo.v1',
        commandId: newId('cmd'),
        idempotencyKey: newId('idem'),
        kind,
        target: { scope: 'LEARNER', learnerId, attemptId, cycleId: state.cycleId },
        binding: { releaseId, questionInstanceId: state.questionInstanceId, rendererContractVersion: state.rendererContractVersion },
        ...(withVersion ? { expectedAttemptVersion: state.attemptVersion } : {}),
        payload: payload as never,
      };
    },
    [state, learnerId, attemptId, releaseId],
  );

  // Hooks must all run before the loading early-return below (React #310):
  // nextTaskId is null-safe when state is still loading.
  const nextTaskId = useMemo(() => {
    const lesson = LESSONS.find((l) => l.releaseId === releaseId);
    if (!lesson || !state) return null;
    const idx = lesson.taskOrder.indexOf(state.taskId);
    return idx >= 0 && idx + 1 < lesson.taskOrder.length ? lesson.taskOrder[idx + 1] : null;
  }, [releaseId, state]);

  if (!state || !task) {
    return (
      <section className="card">
        <p>{error ?? '正在载入任务…'}</p>
        <button onClick={onExit}>返回</button>
      </section>
    );
  }

  const lesson = LESSONS.find((l) => l.releaseId === releaseId);
  // book header: "第 1 课 · 参数与视角" → lesson number + course title
  const splitTitle = (lesson?.title ?? releaseId).split(' · ');
  const lessonNum = splitTitle.length > 1 ? splitTitle[0] : '';
  const lessonTitle = splitTitle.length > 1 ? splitTitle.slice(1).join(' · ') : splitTitle[0];

  const runCommand = async (
    kind: PublicCommandEnvelope['kind'],
    payload: unknown,
    withVersion: boolean,
  ): Promise<CommandReceipt | null> => {
    const receipt = await cmd.send(({ commandId, idempotencyKey }) => ({
      ...envelope(kind, payload, withVersion),
      commandId,
      idempotencyKey,
    }));
    // The APPLIED/ADMITTED receipt carries the authoritative post-command
    // attemptVersion — adopt it immediately so the next command never carries
    // an expected version older than one the server already confirmed to us.
    const receiptVersion = receipt?.attemptVersion;
    if (receipt && (receipt.status === 'APPLIED' || receipt.status === 'ADMITTED') && typeof receiptVersion === 'number') {
      if (receiptVersion > lastAppliedVersion.current) lastAppliedVersion.current = receiptVersion;
      setState((s) => (s && receiptVersion > s.attemptVersion ? { ...s, attemptVersion: receiptVersion } : s));
    }
    await refresh();
    setTick((t) => t + 1);
    return receipt;
  };

  return (
    <section className="player">
      <div className="book-spread">
        <div className="page page-left">
          {/* 书眉条（书签+课签+阶段）收进左页顶部：跨页上方不再有横栏压住书页 */}
          <div className="player-header">
            <button className="bookmark-btn" onClick={onExit}>
              ← 课程页
            </button>
            <span className="badge badge-lesson">{lesson?.title ?? releaseId}</span>
            <span className="badge badge-task">{task.title}</span>
            <PhaseStepper phase={state.phase} />
          </div>
          <DeliveryStatus
            status={cmd.status}
            onResolve={(key) => cmd.status.lastKind && cmd.resolveUnknown(key, cmd.status.lastKind)}
          />
          <header className="lesson-head">
            {lessonNum ? <p className="lesson-num">{lessonNum}</p> : null}
            <h2 className="lesson-title">{lessonTitle}</h2>
            <p className="lesson-task hand">{task.title}</p>
          </header>
          <div className="prose">
            <TaskPrompt task={task} />
          </div>
          <MaterialsPanel task={task} phase={state.phase} state={state.sceneState} />
          <div className="activity-box">
            {state.phase === 'PREDICT' ? (
              <>
                <h3>① 先预测</h3>
                <PredictionForm
                  schemaId={task.responseSchemaId}
                  taskId={task.taskId}
                  busy={cmd.status.state === 'SENDING'}
                  onSubmit={(payload) =>
                    void runCommand(
                      'learning.recordPrediction',
                      { prediction: { claims: payload.claims }, uncertain: payload.uncertain, explanation: payload.explanation },
                      false,
                    )
                  }
                />
              </>
            ) : null}
            {state.phase === 'OPERATE' ? (
              <>
                <h3>② 动手观察与确认</h3>
                <p className="hint">
                  场景里改动后会标「未确认」；点「确认」按钮才会保存为一条操作记录。视角转动只是观察，不会保存。
                </p>
                {evaluation ? <FeedbackPanel evaluation={evaluation} ports={ports} /> : null}
                <VerifyForm
                  schemaId={task.responseSchemaId}
                  taskId={task.taskId}
                  enabledSegments={enabledSegmentsOf(task.taskId)}
                  busy={cmd.status.state === 'SENDING'}
                  onSubmit={(response) => void runCommand('learning.submitResponse', { response }, true)}
                />
              </>
            ) : null}
            {state.phase === 'VERIFY' ? (
              <>
                <h3>③ 核对</h3>
                <FeedbackPanel evaluation={evaluation} ports={ports} />
                {evaluation?.verdict === 'REVISE' ? (
                  <>
                    <button onClick={() => void runCommand('learning.reviseResponse', {}, true)}>修改答案（回到操作）</button>
                    <p className="hint">修改后重新提交会生成新的提交记录；首次作答与预测都保留。</p>
                  </>
                ) : null}
                <button className="primary" onClick={() => void runCommand('learning.beginExplanation', {}, true)}>
                  写下你的解释
                </button>
                <p className="hint">答错也可以解释；解释只保存给家人看，不影响判分。</p>
              </>
            ) : null}
            {state.phase === 'EXPLAIN' ? (
              <>
                <h3>④ 解释</h3>
                <FeedbackPanel evaluation={evaluation} ports={ports} />
                <ExplainForm
                  selections={task.explain.selections}
                  freeTextPrompt={task.explain.freeTextPrompt}
                  busy={cmd.status.state === 'SENDING'}
                  onSubmit={(payload) => void runCommand('learning.saveExplanation', payload, true)}
                />
              </>
            ) : null}
            {state.phase === 'REVIEW' ? (
              <>
                <h3>⑤ 回看</h3>
                <ReviewPanel
                  reviewCard={reviewCard}
                  ports={ports}
                  task={task}
                  state={state}
                  nextTaskId={nextTaskId}
                  busy={cmd.status.state === 'SENDING'}
                  runCommand={runCommand}
                  onFinished={onFinished}
                />
              </>
            ) : null}
          </div>
          {state.phase !== 'REVIEW' ? <HintPanel task={task} hints={hints} onHint={(level) => void runCommand('learning.requestHint', { hintLevel: level }, false)} /> : null}
          {state.phase === 'REVIEW' && hints.length ? (
            <p className="hint">本题已用提示 {hints.length} 次{hints.some((h) => h.marksAnswerAssistance) ? '（含答案级：本题不再计为无提示独立完成）' : ''}。</p>
          ) : null}
        </div>
        {/* 中缝书脊：跨页空间关系的中轴（纯呈现，无交互） */}
        <div className="spine" aria-hidden="true" />
        <div className="page page-right">
          {isThemesTask(state.taskId) ? (
            <BoardPanel
              task={task}
              phase={state.phase}
              confirmedState={state.sceneState as GridBoardStateV1}
              onConfirmOperation={(op: GridOperationV1 | CylinderOperationV1) => void runCommand('learning.commitOperation', { operation: op }, true)}
            />
          ) : isStepsTask(task) ? (
            <StepsPanel
              task={task}
              phase={state.phase}
              confirmedState={state.sceneState as StepProgramStateV1}
              onConfirmOperation={(op: StepOperationV1) => void runCommand('learning.commitOperation', { operation: op }, true)}
              busy={cmd.status.state === 'SENDING'}
            />
          ) : (
            <ScenePanel
              task={task}
              phase={state.phase}
              confirmedState={state.sceneState as Parameters<typeof ScenePanel>[0]['confirmedState']}
              onConfirmOperation={(op) => void runCommand('learning.commitOperation', { operation: op }, true)}
            />
          )}
        </div>
      </div>
    </section>
  );
}

export function enabledSegmentsOf(taskId: string): string[] | undefined {
  void RESPONSE_REGISTRY;
  const l = LESSONS.find((x) => x.taskOrder.includes(taskId) || x.delayedTransferTaskId === taskId);
  void l;
  // segments enabled per task are authored in the private bindings; the public
  // prompt text tells the learner which sub-questions exist, so we mirror the
  // authored prompt structure here (D1: three sub-questions, no area)
  if (taskId === 'cyl.net.d1.delayed-transfer.v1') return ['paramRead', 'edgePairing', 'directionClaims'];
  if (taskId === 'cyl.net.s1.stranger-relabel.v1') return ['paramRead', 'edgePairing', 'directionClaims', 'areaValue'];
  // L4 composites (integration W1; mirrors the private bindings authored in
  // build-content.mjs COMPOSITE_SEGMENTS)
  if (taskId === 'cyl.layers.g3.height-vs-radius.v1') return ['bigger', 'valueA', 'valueB', 'ratio'];
  if (taskId === 'cyl.layers.i2.height-vs-radius-choice.v1') return ['bigger', 'valueA', 'valueB'];
  if (taskId === 'cyl.layers.s1.stranger-package.v1') return ['paramRead', 'faceSet', 'paperArea', 'volume'];
  if (taskId === 'cyl.layers.d1.delayed-transfer.v1') return ['paramRead', 'faceSet', 'paperArea', 'volume'];
  // cpp program tasks (GESP2 unit-1; mirrors CPP_ENABLED_SEGMENTS)
  if (CPP_ENABLED_SEGMENTS[taskId]) return CPP_ENABLED_SEGMENTS[taskId];
  return undefined;
}

function PhaseStepper({ phase }: { phase: string }) {
  const order = ['PREDICT', 'OPERATE', 'VERIFY', 'EXPLAIN', 'REVIEW'];
  const idx = order.indexOf(phase);
  return (
    <ol className="phase-stepper" aria-label="学习阶段">
      {order.map((p, i) => (
        <li key={p} className={i < idx ? 'done' : i === idx ? 'current' : 'todo'}>
          {phaseText(p)}
          {i < idx ? '（已完成）' : i === idx ? '（当前）' : ''}
        </li>
      ))}
    </ol>
  );
}

function TaskPrompt({ task }: { task: ReturnType<typeof getUiTask> }) {
  return (
    <div className="task-prompt">
      {task.prompt.map((block, i) => {
        if (block.type === 'TEXT') return <p key={i}>{block.text}</p>;
        if (block.type === 'FORMULA') return <p key={i} className="formula-box">{block.expression}</p>;
        if (block.type === 'MEASUREMENT_TABLE') {
          return (
            <table key={i} className="measure-table">
              <thead>
                <tr>
                  {block.columns.map((c, j) => (
                    <th key={j}>
                      {c.label}
                      {c.unitId ? `（${c.unitId}）` : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, j) => (
                  <tr key={j}>
                    {row.map((cell, k) => (
                      <td key={k}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        if (block.type === 'IMAGE_REF') return <p key={i}>[插图 {block.assetId}]</p>;
        return null;
      })}
    </div>
  );
}

/** Public material cards projected by the task's visibility matrix. */
function MaterialsPanel({
  task,
  phase,
  state,
}: {
  task: ReturnType<typeof getUiTask>;
  phase: string;
  state: CylinderSceneState | GridBoardStateV1 | StepProgramStateV1;
}) {
  // themes families render their materials inside BoardPanel / prompt blocks;
  // this panel is the cylinder material surface.
  if (!('radiusMm' in state)) {
    const termNotes: Array<{ material: string; text: string }> = [
      { material: 'card.term-radius-diameter', text: '半径：圆心到圆上的线段；直径：穿过圆心、两端在圆上的线段。直径 = 半径 × 2。' },
      { material: 'card.term-area', text: '面积：铺满图形需要多少个单位小正方形（长度 × 长度，单位带"平方"）。' },
      { material: 'card.term-quantity', text: '数量关系：总数 = 每份数 × 份数；反过来用除法求每份数或份数。' },
      { material: 'card.term-units', text: '单位三类：长度量线（cm、m）；面积量面（cm²、m²）；体积量体（cm³、dm³）。' },
      { material: 'card.term-fraction', text: '分数：把整体平均分成若干份，分母写总份数，分子写取的份数；前提是平均分。' },
      { material: 'card.term-equivalence', text: '等值分数：分子和分母同乘（或同除）一个不为 0 的数，分数大小不变。' },
      { material: 'card.term-percent', text: '百分数：表示一个数是一百份整体的百分之几；1% 就是 1/100。' },
      { material: 'card.term-discount', text: '折扣：打几折就是现价是原价的十分之几、百分之几十（八折 = 80%）。' },
    ];
    const visible = termNotes.filter((t) => materialVisible(task, t.material, phase));
    if (visible.length === 0) return null;
    return (
      <div className="materials">
        {visible.map((t) => (
          <p key={t.material} className="material-card">
            {t.text}
          </p>
        ))}
      </div>
    );
  }
  const cyl = state as CylinderStateV1;
  const rows = (task.visibility.find((v) => v.material === 'givens.table')?.rows ?? []);
  const circumCm = rationalToDecimal({ ...circumferenceRationalMm(cyl.radiusMm), denominator: circumferenceRationalMm(cyl.radiusMm).denominator * 10 }, 2);
  const areaCm2 = rationalToDecimal(lateralAreaRationalCm2(cyl.radiusMm, cyl.heightMm), 2);
  const circleCm2 = rationalToDecimal(circleAreaRationalCm2(cyl.radiusMm), 2);
  const volumeCm3 = rationalToDecimal(volumeRationalCm3(cyl.radiusMm, cyl.heightMm), 2);
  const layered = state as CylinderStateV2;
  const hasLayers = layered.layerCount !== undefined;
  const thickness = hasLayers ? layerThicknessCmDisplay(cyl.heightMm, layered.layerCount) : null;
  return (
    <div className="materials">
      {materialVisible(task, 'givens.table', phase) && rows.length ? (
        <table className="measure-table">
          <tbody>
            {rows.includes('radius') ? (
              <tr>
                <td>半径 r</td>
                <td>{mmToCmDisplay(cyl.radiusMm)} cm</td>
              </tr>
            ) : null}
            {rows.includes('diameter') ? (
              <tr>
                <td>直径 d</td>
                <td>{mmToCmDisplay(2 * cyl.radiusMm)} cm</td>
              </tr>
            ) : null}
            {rows.includes('height') ? (
              <tr>
                <td>高度 h</td>
                <td>{mmToCmDisplay(cyl.heightMm)} cm</td>
              </tr>
            ) : null}
            {rows.includes('layerCount') && hasLayers ? (
              <tr>
                <td>层数 n</td>
                <td>{layered.layerCount} 层（层厚 {thickness!.text} cm）</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      ) : (
        <p className="hint">（本题在当前阶段不显示尺寸数字。）</p>
      )}
      {materialVisible(task, 'card.size-unchanged', phase) ? (
        <p className="material-card">尺寸未变：转动观察后，尺寸表里的数字没有动。</p>
      ) : null}
      {materialVisible(task, 'card.formula-C', phase) ? <p className="material-card formula">C = 2πr（π 取 3.14）</p> : null}
      {materialVisible(task, 'card.formula-S', phase) ? <p className="material-card formula">S侧 = C × h</p> : null}
      {materialVisible(task, 'card.measure-C', phase) ? (
        <p className="material-card">底面周长 C = 2×3.14×{mmToCmDisplay(cyl.radiusMm)} = {circumCm} cm</p>
      ) : null}
      {materialVisible(task, 'card.measure-strip', phase) ? (
        <p className="material-card">
          条带边长：周长方向 {circumCm} cm（完全展开时）；高方向 {mmToCmDisplay(cyl.heightMm)} cm
        </p>
      ) : null}
      {materialVisible(task, 'card.measure-S', phase) ? (
        <p className="material-card">
          侧面面积（当前确认尺寸）：S侧 = {circumCm} × {mmToCmDisplay(cyl.heightMm)} = {areaCm2} cm²
        </p>
      ) : null}
      {materialVisible(task, 'card.measure-faces', phase) ? (
        <div className="material-card">
          <p>按面面积测量卡（π 取 3.14，两位小数）：</p>
          <ul>
            {cyl.selectedFaceIds.length === 0 ? <li>（先在场景里选面，选中的面会逐面显示）</li> : null}
            {(cyl.selectedFaceIds as string[]).map((id) => (
              <li key={id}>
                {FACE_LABELS[id as keyof typeof FACE_LABELS] ?? id}：
                {id === 'cyl-face-side' ? `${areaCm2} cm²（S侧 = C×h）` : `${circleCm2} cm²（S圆 = πr²）`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {materialVisible(task, 'card.advice-flagged', phase) ? (
        <div className="advice-card" tabIndex={0} role="note" aria-label="人工建议单（可能有错，供检查）">
          <p className="advice-flag">人工编写，可能有错，供检查</p>
          <p className="advice-body">
            建议单原文：「罐身纸按侧面下料 150.72 cm²；上下两个圆一样大，圆纸样照一份剪就行，面积 28.26 cm²。合计 178.98 cm²。」
          </p>
          <p className="hint">这是仓库小张写的草稿，不是权威读数——请检查后再用。</p>
        </div>
      ) : null}
      {materialVisible(task, 'card.volume-value', phase) ? (
        <p className="material-card">体积（当前确认尺寸）：V = {circleCm2} × {mmToCmDisplay(cyl.heightMm)} = {volumeCm3} cm³</p>
      ) : null}
      {materialVisible(task, 'card.section', phase) ? <p className="material-card">{sectionLabel(cyl.section as 'NONE' | 'TRANSVERSE' | 'AXIAL')}</p> : null}
      {materialVisible(task, 'card.before-after', phase) ? (
        <p className="material-card">
          改动前 r = {mmToCmDisplay((task.givens as CylinderStateV1).radiusMm)} cm / h = {mmToCmDisplay((task.givens as CylinderStateV1).heightMm)} cm → 现在 r ={' '}
          {mmToCmDisplay(cyl.radiusMm)} cm / h = {mmToCmDisplay(cyl.heightMm)} cm
        </p>
      ) : null}
    </div>
  );
}

function FeedbackPanel({ evaluation, ports }: { evaluation: EvaluationView | null; ports: AppPorts }) {
  if (!ports.view) {
    return <p className="hint">（判分反馈通道在真实桌面接入后显示；已提交的作答不受影响。）</p>;
  }
  if (!evaluation) return <p className="hint">还没有提交记录。</p>;
  return (
    <div className="feedback" aria-live="polite">
      <p className={evaluation.verdict === 'CORRECT' ? 'verdict correct' : 'verdict revise'}>
        核对结果：{evaluation.verdict === 'CORRECT' ? '全部正确' : '有需要再试的地方'}
      </p>
      <ul>
        {evaluation.itemResults.map((r) => (
          <li key={r.key}>
            {r.label}：{r.verdict === 'CORRECT' ? '通过' : '再试一次'}
            {r.feedback ? ` —— ${r.feedback}` : ''}
          </li>
        ))}
      </ul>
      {evaluation.answerAssistanceActive ? (
        <p className="hint">本题已记录答案级帮助：即使答对也不计为无提示独立完成。</p>
      ) : null}
    </div>
  );
}

function HintPanel({
  task,
  hints,
  onHint,
}: {
  task: ReturnType<typeof getUiTask>;
  hints: HintView[];
  onHint: (level: number) => void;
}) {
  const [confirmAnswer, setConfirmAnswer] = useState(false);
  return (
    <div className="hint-panel">
      <h4>需要提示？</h4>
      {task.hints.map((h) =>
        h.level < 4 ? (
          <button key={h.level} onClick={() => onHint(h.level)}>
            {h.label}（h{h.level}）
          </button>
        ) : (
          <span key={h.level}>
            <button
              onClick={() => {
                if (!confirmAnswer) {
                  setConfirmAnswer(true);
                  return;
                }
                setConfirmAnswer(false);
                onHint(4);
              }}
            >
              {confirmAnswer ? '确认要答案级提示吗？这会记录答案帮助' : '答案级提示（会记录答案帮助）'}
            </button>
          </span>
        ),
      )}
      {hints.length ? (
        <div className="shown-hints">
          <p>已显示的提示：</p>
          {hints.map((h, i) => (
            <p key={i} className="hint-text">
              h{h.level}：{h.text}
              {h.marksAnswerAssistance ? '（答案级）' : ''}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReviewPanel({
  reviewCard,
  ports,
  task,
  state,
  nextTaskId,
  busy,
  runCommand,
  onFinished,
}: {
  reviewCard: ReviewCardView | null;
  ports: AppPorts;
  task: ReturnType<typeof getUiTask>;
  state: PlayerState;
  nextTaskId: string | null;
  busy: boolean;
  runCommand: (kind: PublicCommandEnvelope['kind'], payload: unknown, withVersion: boolean) => Promise<CommandReceipt | null>;
  onFinished: () => void;
}) {
  const [finished, setFinished] = useState(false);
  const isLast = nextTaskId === null;
  const themes = isThemesTask(task.taskId);
  const diagnosis = (reviewCard as { diagnosis?: { outcome: 'PASS' | 'SUPPLEMENT'; supplementTaskId: string } | null } | null)?.diagnosis ?? null;
  return (
    <div className="review-panel">
      {reviewCard ? (
        <>
          {themes && diagnosis ? (
            <div className={diagnosis.outcome === 'PASS' ? 'diagnosis-card pass' : 'diagnosis-card supplement'}>
              <h4>先修诊断结果（服务端判定）</h4>
              {diagnosis.outcome === 'PASS' ? (
                <p>已具备这个先修：补充活动可以跳过，直接「完成本次学习」即可；想练一练也可以继续进入补充活动。</p>
              ) : (
                <p>还差一点：建议进入补充活动（{getUiTask(diagnosis.supplementTaskId).title}）补一补，然后完成本次学习。</p>
              )}
            </div>
          ) : null}
          <p>首次预测：{reviewCard.prediction?.uncertain ? '（不确定）' : ''} {reviewCard.prediction?.explanation ?? '（结构化方向断言已保存）'}</p>
          <p>
            提交与判定：{reviewCard.submissions.length} 次提交，最近一次
            {reviewCard.evaluation?.verdict === 'CORRECT' ? '全部正确' : reviewCard.evaluation?.verdict === 'REVISE' ? '有再试项' : '（无）'}
          </p>
          {reviewCard.reveal ? (
            <div className="reveal-card">
              <h4>本题答案（判分已完成，现在可以看到）</h4>
              <ul>
                {Object.entries(reviewCard.reveal).map(([k, v]) => (
                  <li key={k}>
                    {themes ? '' : `${revealLabel(k)}：`}
                    {v}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="hint">（答案比对在判分后显示。）</p>
          )}
        </>
      ) : (
        <p className="hint">{ports.view ? '载入回看…' : '回看数据通道在真实桌面接入后显示。'}</p>
      )}
      <div className="btnrow">
        {!finished && !isLast ? (
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              await runCommand('learning.beginCycle', { taskId: nextTaskId }, true);
            }}
          >
            下一题
          </button>
        ) : null}
        {!finished && !isLast && themes && diagnosis?.outcome === 'PASS' && nextTaskId === diagnosis.supplementTaskId ? (
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              const r = await runCommand('learning.finishAttempt', {}, true);
              if (r && r.status === 'APPLIED') {
                setFinished(true);
                onFinished();
              }
            }}
          >
            已通过诊断，直接完成本次学习
          </button>
        ) : null}
        {!finished && isLast ? (
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              const r = await runCommand('learning.finishAttempt', {}, true);
              if (r && r.status === 'APPLIED') {
                setFinished(true);
                onFinished();
              }
            }}
          >
            完成本次学习
          </button>
        ) : null}
        <button disabled={busy} onClick={() => void runCommand('learning.pauseAttempt', {}, true)}>
          暂停（下次继续）
        </button>
      </div>
      {finished ? <p>本次学习已完成。完成流程与达到课的退出标准分别显示。</p> : null}
      <p className="hint">
        任务：{task.title} · 当前确认状态{' '}
        {'radiusMm' in state.sceneState
          ? `r=${mmToCmDisplay(state.sceneState.radiusMm)} cm / h=${mmToCmDisplay(state.sceneState.heightMm)} cm${'layerCount' in state.sceneState ? ` / ${state.sceneState.layerCount} 层（已装 ${state.sceneState.visibleLayerCount}）` : ''}`
          : 'cols' in state.sceneState
            ? `${state.sceneState.rows} 行 × ${state.sceneState.cols} 列，涂色 ${state.sceneState.filled}`
            : `步骤卡（第 ${state.sceneState.cursorStep} 步）`}
      </p>
    </div>
  );
}

function revealLabel(k: string): string {
  const map: Record<string, string> = {
    claims: '变化方向',
    direction: '方向',
    value: '数值',
    section: '切面',
    pairing: '配对',
    circleEdges: '形成圆周的边',
    heightEdges: '成为高的边',
    radius: '半径',
    area: '面积',
    circumference: '周长',
  };
  return map[k] ?? k;
}

function DeliveryStatus({
  status,
  onResolve,
}: {
  status: ReturnType<typeof useCommand>['status'];
  onResolve: (key: string) => void;
}) {
  if (status.state === 'IDLE' && !status.error) return null;
  const text =
    status.state === 'DRAFT'
      ? '尚未保存'
      : status.state === 'SENDING'
        ? '发送中（未保存）'
        : status.state === 'CONFIRMED'
          ? '已保存（收到服务端回执）'
          : status.state === 'RECEIPT_UNKNOWN'
            ? '结果未知 · 正在按原键查回（不重发新命令）'
            : '未保存';
  return (
    <div className={status.state === 'CONFIRMED' ? 'delivery ok' : 'delivery warn'} role="status">
      <span>{text}</span>
      {status.state === 'RECEIPT_UNKNOWN' && status.lastKey ? (
        <button onClick={() => onResolve(status.lastKey!)}>查回执</button>
      ) : null}
      {status.error && status.state !== 'CONFIRMED' ? <span className="error">{status.error}</span> : null}
    </div>
  );
}

function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: string }).message);
  return String(err);
}
