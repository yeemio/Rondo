/**
 * ScenePanel: the learner-facing scene surface for rondo.cylinder@1 — the
 * RIGHT PAGE of the interactive lesson book ("可交互立体学习书").
 *
 * - consumes the confirmed PublicSceneState (from the server projection) and
 *   emits exactly one typed operation per confirm (draft preview in between);
 * - camera/zoom/focus/animation stay in ViewState and never become commands;
 *   phase changes narrate the camera (PREDICT 透视远观 → OPERATE 侧视可用 →
 *   VERIFY 剖面特写 when a section is active), 900–1200ms ease-out-quint,
 *   collapsing to 150ms under prefers-reduced-motion (inside webglScene);
 * - DOM overlay annotations (white rounded cards + leader lines) track the
 *   DISPLAYED morph every frame via vector.project — circumference / height /
 *   rectangle edges / r·d·h dimension cards, confirmed vs draft styled
 *   differently; overlay text is aria-hidden (materials + SVG aria carry the
 *   accessible channel) and never produces a domain fact;
 * - WebGL2 by capability detection; runtime context loss switches to the
 *   SVG/DOM expression while keeping confirmed state, draft and focus —
 *   no attempt rebuild, no hint reset, no resubmit (SCENE-CONTRACTS §1/§6);
 * - keyboard equivalents work only while the scene container is focused;
 *   inputs/sliders keep native key behavior.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CylinderOperationV1, CylinderStateV1, CylinderStateV2 } from '../../../../modules/contracts/public/scene';
import { SceneController, type CylinderSceneOperation, type CylinderSceneState, type ExpressionMode, type SceneRenderer } from '../../../../modules/scenes/cylinder/controller';
import { renderCylinderSvg, renderLayersSvg } from '../../../../modules/scenes/cylinder/svgScene';
import { CylinderWebglScene, detectWebgl2, STRIP_PLANE_Y_MM } from '../../../../modules/scenes/cylinder/webglScene';
import { AZIMUTH_STEP_DEG, ELEVATION_STEP_DEG, ZOOM_FACTOR } from '../../../../modules/scenes/cylinder/view';
import { isSceneKeyEvent } from '../../../../modules/scenes/cylinder/keyboard';
import { circumferenceRationalMm, mmToCmDisplay, rationalToDecimal, cumulativeLayerRow, layerThicknessCmDisplay } from '../../../../modules/scenes/cylinder/geometry';
import type { UiTask } from '../content/bundled';
import { LESSONS, materialVisible } from '../content/bundled';

export interface ScenePanelProps {
  task: UiTask;
  phase: string;
  confirmedState: CylinderSceneState;
  onConfirmOperation: (op: CylinderSceneOperation) => void;
}

const FACE_LIST = [
  { id: 'cyl-face-side', label: '侧面（裹在罐身外的那圈）' },
  { id: 'cyl-face-upper', label: '上盖面（顶上的圆）' },
  { id: 'cyl-face-lower', label: '下盖面（底下的圆）' },
] as const;

/** Phase narrative camera poses — ViewState only, never a command. */
const PHASE_CAMERA: Record<string, { azimuthDeg: number; elevationDeg: number; distanceMm: number }> = {
  PREDICT: { azimuthDeg: 32, elevationDeg: 26, distanceMm: 560 }, // 透视远观
  // OPERATE 抬高俯角：展开条带沿视线方向获得更大的垂直投影，展开体成为
  // 右页主体（取景门控在 webglScene，视角仍是纯 ViewState）
  OPERATE: { azimuthDeg: 62, elevationDeg: 26, distanceMm: 430 }, // 侧视可用
  VERIFY: { azimuthDeg: 45, elevationDeg: 24, distanceMm: 430 },
  EXPLAIN: { azimuthDeg: 30, elevationDeg: 32, distanceMm: 500 },
  REVIEW: { azimuthDeg: 58, elevationDeg: 26, distanceMm: 540 },
};
/** Section close-up (VERIFY, while a section is active) — ViewState only. */
const SECTION_CAMERA: Record<string, { azimuthDeg: number; elevationDeg: number; distanceMm: number }> = {
  TRANSVERSE: { azimuthDeg: 20, elevationDeg: 34, distanceMm: 310 }, // 剖面圆盘特写
  AXIAL: { azimuthDeg: 0, elevationDeg: 6, distanceMm: 330 }, // 正对轴截面矩形
};

type AnnId = 'r' | 'd' | 'h' | 'C' | 'sh' | 'e1' | 'e2' | 'e3' | 'e4';
type AnnPlace = 'up' | 'down' | 'left' | 'right' | 'center';

interface AnnCard {
  id: AnnId;
  place: AnnPlace;
  text: string;
  n?: string;
  draft: boolean;
}

export function ScenePanel({ task, phase, confirmedState, onConfirmOperation }: ScenePanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const webglRef = useRef<CylinderWebglScene | null>(null);
  const controllerRef = useRef<SceneController | null>(null);
  const onConfirmRef = useRef(onConfirmOperation);
  onConfirmRef.current = onConfirmOperation;
  const overlayRef = useRef<HTMLDivElement>(null);
  const annEls = useRef(new Map<string, HTMLDivElement>());
  const [svgMarkup, setSvgMarkup] = useState<string>('');
  const [annCards, setAnnCards] = useState<AnnCard[]>([]);
  const [mode, setMode] = useState<ExpressionMode>('SVG_DOM');
  const [modeReason, setModeReason] = useState<string>('初始检测中');
  const [webglTried, setWebglTried] = useState(false);

  const showRadius = materialVisible(task, 'givens.table', phase) && (task.visibility.find((v) => v.material === 'givens.table')?.rows ?? []).includes('radius');
  const showHeight =
    materialVisible(task, 'givens.table', phase) && (task.visibility.find((v) => v.material === 'givens.table')?.rows ?? []).includes('height');
  const showDiameterRow =
    materialVisible(task, 'givens.table', phase) && (task.visibility.find((v) => v.material === 'givens.table')?.rows ?? []).includes('diameter');
  const showRadiusLabel = materialVisible(task, 'dim.radius', phase) || showRadius;
  const showHeightLabel = materialVisible(task, 'dim.height', phase) || showHeight;
  const showDiameterLabel = materialVisible(task, 'dim.diameter', phase) || showDiameterRow;
  const showEdgeMarkers = materialVisible(task, 'net.edge-markers', phase);
  // circumference / strip-edge VALUES stay gated by the measure materials —
  // edge-marker digits alone never leak a computable answer
  const showCircumference =
    materialVisible(task, 'card.measure-C', phase) || materialVisible(task, 'card.measure-strip', phase);
  // the strip-height card labels the UNROLLED strip's height edge — it is
  // meaningless (and duplicated with the h card) while fully rolled
  const showStripHeight = showCircumference;

  // strip orientation: stranger/delayed tasks present the strip vertically in
  // BOTH expressions (expression choice; edge numbers stay parametric)
  const stripOrientation = task.kind === 'STRANGER' || task.kind === 'DELAYED_TRANSFER' ? 'VERTICAL' : 'HORIZONTAL';
  // L3/L4 families (integration W1): faces tasks ship on @1 with SelectFaces;
  // layers tasks ship on @2 with the layer pair.
  const isLayersTask = task.taskFamily === 'cylinder.layers.v1';
  const isFacesTask = task.taskFamily === 'cylinder.faces.v1';
  const isLayerless = isLayersTask || isFacesTask;

  // The renderer closure lives for the whole task while phase/visibility
  // flags change per render — keep them in refs so the SVG expression and the
  // overlay never show stale-phase labels (visibility is phase-gated).
  const flagsRef = useRef({ showR: false, showD: false, showH: false, showEdges: false, showC: false, showSH: false, phase });
  flagsRef.current = {
    showR: showRadiusLabel,
    showD: showDiameterLabel,
    showH: showHeightLabel,
    showEdges: showEdgeMarkers,
    showC: showCircumference,
    showSH: showStripHeight,
    phase,
  };
  const stripRef = useRef<'HORIZONTAL' | 'VERTICAL'>(stripOrientation);
  stripRef.current = stripOrientation;

  // Overlay re-projection: position cards from the DISPLAYED (tweened) shape
  // every rendered frame — cards stay glued to the drawn edges mid-morph.
  const positionOverlay = useRef(() => {});
  positionOverlay.current = () => {
    const webgl = webglRef.current;
    const overlayEl = overlayRef.current;
    if (!webgl || !overlayEl || webgl.contextLost) return;
    const disp = webgl.getDisplayed();
    const r = disp.radiusMm;
    const h = disp.heightMm;
    const f = disp.unrollPermille / 1000;
    const L = f * 2 * Math.PI * r;
    const vertical = stripRef.current === 'VERTICAL';
    const rolled = f < 0.01;
    const anchors: Record<string, { x: number; y: number; z: number }> = vertical
      ? {
          r: { x: r, y: h, z: 0 },
          d: { x: 0, y: h, z: 0 },
          h: { x: r, y: h / 2, z: 0 },
          C: { x: r + h / 2, y: h + L / 2, z: 0 },
          sh: { x: r - h / 2, y: h + L / 2, z: 0 },
          e1: rolled ? { x: r, y: h / 2, z: 0 } : { x: r, y: h, z: 0 },
          e2: { x: r + h / 2, y: h + L / 2, z: 0 },
          e3: rolled ? { x: r, y: h / 2, z: 0 } : { x: r, y: h + L, z: 0 },
          e4: { x: r - h / 2, y: h + L / 2, z: 0 },
        }
      : {
          r: { x: r, y: h, z: 0 },
          d: { x: 0, y: h, z: 0 },
          h: { x: r, y: h / 2, z: 0 },
          C: { x: r + L / 2, y: STRIP_PLANE_Y_MM, z: h / 2 },
          sh: { x: r + L, y: STRIP_PLANE_Y_MM, z: 0 },
          e1: rolled ? { x: r, y: h / 2, z: 0 } : { x: r, y: STRIP_PLANE_Y_MM, z: 0 },
          e2: { x: r + L / 2, y: STRIP_PLANE_Y_MM, z: h / 2 },
          e3: rolled ? { x: r, y: h / 2, z: 0 } : { x: r + L, y: STRIP_PLANE_Y_MM, z: 0 },
          e4: { x: r + L / 2, y: STRIP_PLANE_Y_MM, z: -h / 2 },
        };
    for (const [id, el] of annEls.current) {
      const a = anchors[id];
      if (!a) {
        el.style.visibility = 'hidden';
        continue;
      }
      const p = webgl.projectPoints([a])[0];
      if (!p) {
        el.style.visibility = 'hidden';
        continue;
      }
      el.style.visibility = 'visible';
      el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
    }
  };

  useEffect(() => {
    const sectionRef = { current: confirmedState.section };
    const renderer: SceneRenderer = {
      render: (state, view, m) => {
        const flags = flagsRef.current;
        if (isLayersTask) {
          // @2 layer tasks use the layer-stack SVG expression; overlay
          // annotations are unrolled-geometry facts and never apply here.
          const result = renderLayersSvg(state as CylinderStateV2, {
            showRadius: flags.showR,
            showHeight: flags.showH,
            width: 560,
            height: 560,
          });
          setSvgMarkup(result.markup);
          setAnnCards([]);
          if (m === 'WEBGL2' && webglRef.current && !webglRef.current.contextLost) {
            webglRef.current.setState(state);
            webglRef.current.applyViewState(view, state.radiusMm, state.heightMm);
          }
          return;
        }
        const result = renderCylinderSvg(state, {
          showRadius: flags.showR,
          showDiameter: flags.showD,
          showHeight: flags.showH,
          showEdgeMarkers: flags.showEdges,
          stripOrientation: stripRef.current,
          unrollBadge: '',
          width: 560,
          height: 560,
          showFaceSelection: isFacesTask,
        });
        setSvgMarkup(result.markup);
        setAnnCards(buildAnnCards(state, controllerRef.current?.getConfirmedState() ?? state, flags));
        if (m === 'WEBGL2' && webglRef.current && !webglRef.current.contextLost) {
          webglRef.current.setState(state);
          webglRef.current.applyViewState(view, state.radiusMm, state.heightMm);
        }
        // section close-up narrative (VERIFY, section active) — ViewState only
        if (state.section !== sectionRef.current) {
          sectionRef.current = state.section;
          const cam = SECTION_CAMERA[state.section];
          if (cam && flagsRef.current.phase === 'VERIFY' && controllerRef.current) {
            controllerRef.current.applyCamera(cam);
          }
        }
      },
    };
    const controller = new SceneController({
      renderer,
      initialState: confirmedState,
      initialMode: 'SVG_DOM',
      // The controller instance lives for the whole task; without a ref it
      // would keep the mount-time onConfirmOperation closure and send
      // commitOperation with the attempt version captured at task start
      // (stale after any later command, e.g. recordPrediction -> VERSION_CONFLICT).
      onOperation: (op) => onConfirmRef.current(op),
      onModeChange: (m, reason) => {
        setMode(m);
        setModeReason(
          reason === 'context-loss'
            ? 'WebGL 上下文丢失，已切换平面图'
            : reason === 'context-restored'
              ? 'WebGL 已恢复'
              : reason === 'manual'
                ? '已启用三维表达'
                : reason,
        );
      },
    });
    controllerRef.current = controller;
    // capability detection (browser only, never by browser name)
    const canvas = canvasRef.current;
    if (canvas && detectWebgl2(canvas) === 'AVAILABLE') {
      try {
        webglRef.current = new CylinderWebglScene(canvas, {
          onContextLost: () => controller.handleContextLost(),
          onContextRestored: () => controller.handleContextRestored(renderer),
          stripOrientation,
          onFrame: () => positionOverlay.current(),
        });
        controller.switchMode('WEBGL2');
      } catch (err) {
        // WebGL init failure must degrade to the SVG expression, never crash
        // the lesson tree (a dead/lost context hands three.js a null gl).
        webglRef.current = null;
        setMode('SVG_DOM');
        setModeReason(`WebGL 初始化失败，已使用平面图表达（${err instanceof Error ? err.message.slice(0, 60) : '未知错误'}）`);
      }
    } else {
      setModeReason('未检测到可用的 WebGL2，使用平面图表达');
    }
    setWebglTried(true);
    controller.applyConfirmedState(confirmedState);
    return () => {
      controller.dispose();
      webglRef.current?.dispose();
      webglRef.current = null;
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.taskId]);

  // Phase-change camera narrative (one narrative move per phase transition).
  useEffect(() => {
    const pose = PHASE_CAMERA[phase];
    if (pose) controllerRef.current?.applyCamera(pose);
  }, [phase, task.taskId]);

  // Newly mounted/updated cards need one positioning pass even when the
  // WebGL loop is idle (projection uses the last camera, no render needed).
  useEffect(() => {
    positionOverlay.current();
  }, [annCards, mode]);

  // authoritative state updates land here (projection refresh)
  useEffect(() => {
    controllerRef.current?.applyConfirmedState(confirmedState);
  }, [confirmedState]);

  const onSceneKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (!isSceneKeyEvent({ target: e.target, defaultPrevented: e.defaultPrevented })) return;
    // L4 keyboard equivalent (SCENE §6 / keyboard map SetVisibleLayerCount):
    // arrows step the confirmed layer cursor by one op each, Home resets.
    if (isLayersTask && task.allowedOperationIds.includes('SetVisibleLayerCount')) {
      const s = controller.getConfirmedState() as CylinderStateV2;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const delta = e.key === 'ArrowUp' ? 1 : -1;
        const target = Math.max(0, Math.min(s.layerCount, s.visibleLayerCount + delta));
        controller.previewOperation({ type: 'SetVisibleLayerCount', value: target });
        controller.confirmDraft();
        e.preventDefault();
        return;
      }
      if (e.key === 'Home') {
        controller.previewOperation({ type: 'SetVisibleLayerCount', value: 0 });
        controller.confirmDraft();
        e.preventDefault();
        return;
      }
    }
    switch (e.key) {
      case 'ArrowLeft':
        controller.rotateView(-AZIMUTH_STEP_DEG, 0);
        e.preventDefault();
        break;
      case 'ArrowRight':
        controller.rotateView(AZIMUTH_STEP_DEG, 0);
        e.preventDefault();
        break;
      case 'ArrowUp':
        controller.rotateView(0, ELEVATION_STEP_DEG);
        e.preventDefault();
        break;
      case 'ArrowDown':
        controller.rotateView(0, -ELEVATION_STEP_DEG);
        e.preventDefault();
        break;
      case '+':
      case '=':
        controller.zoomView(ZOOM_FACTOR);
        e.preventDefault();
        break;
      case '-':
        controller.zoomView(1 / ZOOM_FACTOR);
        e.preventDefault();
        break;
      case '0':
        controller.resetView();
        e.preventDefault();
        break;
      case 'f':
        controller.applyViewPreset('FRONT');
        break;
      case 's':
        controller.applyViewPreset('SIDE');
        break;
      case 't':
        controller.applyViewPreset('TOP');
        break;
      default:
        break;
    }
  };

  const figNo = useMemo(() => {
    const lesson = LESSONS.find((l) => l.taskOrder.includes(task.taskId) || l.delayedTransferTaskId === task.taskId);
    if (!lesson) return 1;
    const idx = lesson.taskOrder.indexOf(task.taskId);
    return idx >= 0 ? idx + 1 : lesson.taskOrder.length + 1;
  }, [task.taskId]);

  return (
    <div className="scene-panel">
      <div className="scene-mode" aria-live="polite">
        当前显示：{mode === 'WEBGL2' ? '三维（WebGL2）' : '平面图（SVG）'} · {modeReason}
      </div>
      <div className="scene-stage">
        <div
          ref={containerRef}
          className="scene-canvas"
          tabIndex={0}
          onKeyDown={onSceneKeyDown}
          role="application"
          aria-label="圆筒场景：聚焦后用方向键旋转，+/- 缩放，0 复位；输入框内按键不会被劫持"
        >
          <canvas
            ref={canvasRef}
            className={mode === 'WEBGL2' ? 'webgl-canvas' : 'webgl-canvas hidden-canvas'}
            aria-hidden={mode !== 'WEBGL2'}
          />
          {mode === 'SVG_DOM' ? <div className="svg-holder" dangerouslySetInnerHTML={{ __html: svgMarkup }} /> : null}
          {mode === 'WEBGL2' ? (
            <div className="ann-overlay" ref={overlayRef} aria-hidden="true">
              {annCards.map((c) => (
                <div
                  key={c.id}
                  className={`ann ann-${c.place}${c.draft ? ' ann-draft' : ''}`}
                  ref={(el) => {
                    if (el) annEls.current.set(c.id, el);
                    else annEls.current.delete(c.id);
                  }}
                >
                  {c.n !== undefined ? (
                    <span className="ann-chip">{c.n}</span>
                  ) : (
                    <span className="ann-card">
                      {c.text}
                      {c.draft ? <em className="ann-draft-mark">未确认</em> : null}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="fig-caption">
          <span className="fig-no">Fig. {figNo}.</span> {task.title}：立体图与左页读数同源；未确认的改动只是预览，确认后才保存为学习记录。
          {webglTried && mode === 'SVG_DOM' ? (
            <span className="fig-alt">平面图不是截图：操作控件与三维完全相同，判分也相同。</span>
          ) : null}
        </div>
      </div>
      <div className="view-controls">
        <button type="button" onClick={() => controllerRef.current?.applyViewPreset('FRONT')}>
          前视（f）
        </button>
        <button type="button" onClick={() => controllerRef.current?.applyViewPreset('SIDE')}>
          侧视（s）
        </button>
        <button type="button" onClick={() => controllerRef.current?.applyViewPreset('TOP')}>
          俯视（t）
        </button>
        <button type="button" onClick={() => controllerRef.current?.resetView()}>
          复位视角（0）
        </button>
        <span className="sr-only">转动视角不会改变圆筒的尺寸。</span>
      </div>
      {isLayersTask ? (
        <CumulativeTable task={task} phase={phase} confirmedState={confirmedState as CylinderStateV2} />
      ) : null}
      <OperationControls task={task} phase={phase} controller={controllerRef} confirmedState={confirmedState} />
    </div>
  );
}

/**
 * Build the overlay annotation cards from the preview state (what the scene
 * shows) vs the confirmed state (what the server holds): values follow the
 * preview, the confirmed/draft distinction follows the diff. Values use the
 * domain rationals (π = 157/50) exactly like the material cards.
 */
function buildAnnCards(
  preview: CylinderStateV1,
  confirmed: CylinderStateV1,
  flags: { showR: boolean; showD: boolean; showH: boolean; showEdges: boolean; showC: boolean; showSH: boolean },
): AnnCard[] {
  const cards: AnnCard[] = [];
  const rDraft = preview.radiusMm !== confirmed.radiusMm;
  const hDraft = preview.heightMm !== confirmed.heightMm;
  if (flags.showR) {
    cards.push({ id: 'r', place: 'up', text: `r = ${mmToCmDisplay(preview.radiusMm)} cm`, draft: rDraft });
  }
  if (flags.showD) {
    cards.push({ id: 'd', place: 'up', text: `d = ${mmToCmDisplay(2 * preview.radiusMm)} cm`, draft: rDraft });
  }
  if (flags.showH) {
    cards.push({ id: 'h', place: 'left', text: `h = ${mmToCmDisplay(preview.heightMm)} cm`, draft: hDraft });
  }
  if (flags.showC) {
    const c = circumferenceRationalMm(preview.radiusMm);
    cards.push({
      id: 'C',
      place: 'down',
      text: `C = ${rationalToDecimal({ numerator: c.numerator, denominator: c.denominator * 10 }, 2)} cm`,
      draft: rDraft,
    });
  }
  if (flags.showSH && preview.unrollPermille > 40) {
    cards.push({ id: 'sh', place: 'right', text: `h = ${mmToCmDisplay(preview.heightMm)} cm`, draft: hDraft });
  }
  if (flags.showEdges) {
    cards.push({ id: 'e1', place: 'center', text: '', n: '1', draft: false });
    cards.push({ id: 'e2', place: 'center', text: '', n: '2', draft: false });
    cards.push({ id: 'e3', place: 'center', text: '', n: '3', draft: false });
    cards.push({ id: 'e4', place: 'center', text: '', n: '4', draft: false });
  }
  return cards;
}

/** Domain operation controls — visible only for whitelisted operations. */
function OperationControls({
  task,
  phase,
  controller,
  confirmedState,
}: {
  task: UiTask;
  phase: string;
  controller: React.RefObject<SceneController | null>;
  confirmedState: CylinderSceneState;
}) {
  const controlsAllowed = phase === 'OPERATE' || phase === 'VERIFY' || phase === 'EXPLAIN' || phase === 'REVIEW';
  const [draftText, setDraftText] = useState('');
  const [draftUnroll, setDraftUnroll] = useState<number | null>(null);
  const [draftSection, setDraftSection] = useState<string | null>(null);
  if (!controlsAllowed) {
    return (
      <div className="op-controls idle">
        <p className="hint">操作控件在「操作」阶段开放（视角控制随时可用）。</p>
      </div>
    );
  }
  const dimConstraint = (task.operationConstraints ?? []).find(
    (c) => c.type === 'SetDimension',
  ) as { dimension?: 'RADIUS' | 'HEIGHT'; valuesMm?: number[]; minMm?: number; maxMm?: number } | undefined;
  const unrollAllowed = task.allowedOperationIds.includes('SetUnroll');
  const dimAllowed = task.allowedOperationIds.includes('SetDimension');
  const sectionAllowed = task.allowedOperationIds.includes('SetSection');
  const facesAllowed = task.allowedOperationIds.includes('SelectFaces');
  const lockedNote = task.givenLocks.length
    ? '本题尺寸给定：半径/高度输入不开放（这是题目的设定，不是故障）。'
    : null;

  return (
    <div className="op-controls">
      {facesAllowed ? <FaceSelector task={task} controller={controller} /> : null}
      {task.taskFamily === 'cylinder.layers.v1' ? (
        <LayerStackControls task={task} controller={controller} confirmedState={confirmedState as CylinderStateV2} />
      ) : null}
      {unrollAllowed ? (
        <fieldset>
          <legend>展开程度</legend>
          <input
            type="range"
            min={0}
            max={1000}
            step={50}
            value={draftUnroll ?? (controller.current ? controller.current.getPreviewState().unrollPermille : 0)}
            aria-label="展开程度，0 表示卷起，1000 表示完全展开，方向键离散步进"
            onChange={(e) => {
              const v = Number(e.target.value);
              setDraftUnroll(v);
              controller.current?.previewOperation({ type: 'SetUnroll', valuePermille: v });
            }}
          />
          <span className="draft-badge">{draftUnroll !== null ? '未确认' : '已确认'}</span>
          <div className="btnrow">
            <button
              type="button"
              onClick={() => {
                setDraftUnroll(0);
                controller.current?.previewOperation({ type: 'SetUnroll', valuePermille: 0 });
              }}
            >
              完全卷起
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftUnroll(1000);
                controller.current?.previewOperation({ type: 'SetUnroll', valuePermille: 1000 });
              }}
            >
              完全展开
            </button>
            <button
              type="button"
              onClick={() => {
                const d = controller.current?.getDraft();
                if (d && d.type === 'SetUnroll' && controller.current) {
                  controller.current.confirmDraft();
                  setDraftUnroll(null);
                }
              }}
            >
              确认展开程度
            </button>
          </div>
        </fieldset>
      ) : null}
      {dimAllowed && dimConstraint ? (
        <fieldset>
          <legend>修改{dimConstraint.dimension === 'RADIUS' ? '半径' : '高度'}（cm）</legend>
          <label>
            {dimConstraint.dimension === 'RADIUS' ? '半径' : '高度'}（cm，一位小数）：
            <input
              type="number"
              step="0.1"
              min={(dimConstraint.minMm ?? 5) / 10}
              max={(dimConstraint.maxMm ?? 200) / 10}
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              aria-label={`输入${dimConstraint.dimension === 'RADIUS' ? '半径' : '高度'}，单位厘米`}
            />
          </label>
          <span className="draft-badge">{draftText !== '' ? '未确认' : '已确认'}</span>
          <div className="btnrow">
            {dimConstraint.valuesMm
              ? dimConstraint.valuesMm.map((mm) => (
                  <button
                    key={mm}
                    type="button"
                    onClick={() => setDraftText((mm / 10).toFixed(1))}
                  >
                    {(mm / 10).toFixed(1)} cm
                  </button>
                ))
              : null}
            <button
              type="button"
              onClick={() => {
                const cm = Number(draftText);
                if (Number.isNaN(cm)) return;
                const mm = Math.round(cm * 10);
                controller.current?.previewOperation({
                  type: 'SetDimension',
                  dimension: dimConstraint.dimension ?? 'RADIUS',
                  valueMm: mm,
                });
                if (controller.current) controller.current.confirmDraft();
                setDraftText('');
              }}
            >
              确认修改
            </button>
          </div>
        </fieldset>
      ) : null}
      {sectionAllowed ? (
        <fieldset>
          <legend>切面显示</legend>
          <div role="radiogroup" aria-label="切面选择">
            {(['NONE', 'TRANSVERSE', 'AXIAL'] as const).map((s) => (
              <label key={s} className="radio-line">
                <input
                  type="radio"
                  name="section"
                  value={s}
                  checked={(draftSection ?? controller.current?.getPreviewState().section ?? 'NONE') === s}
                  onChange={() => {
                    setDraftSection(s);
                    controller.current?.previewOperation({ type: 'SetSection', section: s });
                    if (controller.current) controller.current.confirmDraft();
                  }}
                />
                {s === 'NONE' ? '不显示切面' : s === 'TRANSVERSE' ? '横截面（垂直于轴切开）' : '轴截面（沿轴切开）'}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {lockedNote ? <p className="hint">{lockedNote}</p> : null}
    </div>
  );
}


/**
 * CumulativeTable（L34-8 合同语义）：行（第 k 层：层厚/该层/累计）只在确认
 * visibleLayerCount ≥ k 后呈现；WEBGL2 与 SVG_DOM 两种表达渲染的是同一个
 * DOM 组件（3D 表与 DOM 表由同一实现保证同步揭示），动画帧属 ViewState。
 * 数值列受 material 'table.cumulative-values' 单独投影（独立题 REVIEW 前隐藏）。
 */
function CumulativeTable({
  task,
  phase,
  confirmedState,
}: {
  task: UiTask;
  phase: string;
  confirmedState: CylinderStateV2;
}) {
  if (!materialVisible(task, 'table.cumulative', phase)) return null;
  const showValues = materialVisible(task, 'table.cumulative-values', phase);
  const { radiusMm, heightMm, layerCount, visibleLayerCount } = confirmedState;
  const thickness = layerThicknessCmDisplay(heightMm, layerCount);
  const rows = [];
  for (let k = 1; k <= visibleLayerCount; k += 1) {
    const row = cumulativeLayerRow(radiusMm, heightMm, layerCount, k);
    rows.push(
      <tr key={k} data-layer={k}>
        <td>第 {k} 层</td>
        <td>{showValues ? `${rationalToDecimal(row.thicknessCm, 1)} cm` : '—'}</td>
        <td>{showValues ? `${rationalToDecimal(row.layerVolumeCm3, 2)} cm³` : '—'}</td>
        <td>{showValues ? `${rationalToDecimal(row.cumulativeCm3, 2)} cm³` : '—'}</td>
      </tr>,
    );
  }
  return (
    <div className="cumulative-table-wrap" aria-live="polite">
      <table className="measure-table cumulative-table" aria-label="累计表：行随确认的已装层数揭示">
        <thead>
          <tr>
            <th>层号</th>
            <th>层厚</th>
            <th>该层体积</th>
            <th>累计体积</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
      <p className="hint">
        已装 {visibleLayerCount} / {layerCount} 层 · 层厚 {thickness.text} cm{thickness.approximate ? '（约）' : ''} ·
        表随你逐层确认推进逐行出现（两种显示方式同步）。
      </p>
    </div>
  );
}

/** FaceSelector（L3）：三面 checkbox 为本地草稿（ViewState），「确认选面」发送
 * 一条 canonical SelectFaces（整集替换）；盖数 radio 为 DOM 便捷入口，等效
 * 展开为两个盖面的勾选（SCENE §5 L3 行键盘列）。键盘：Tab/空格原生可用。 */
function FaceSelector({
  task,
  controller,
}: {
  task: UiTask;
  controller: React.RefObject<SceneController | null>;
}) {
  const constraint = (task.operationConstraints ?? []).find((c) => c.type === 'SelectFaces') as { allowedFaceIds?: string[] } | undefined;
  const whitelist = constraint?.allowedFaceIds ?? FACE_LIST.map((f) => f.id);
  const confirmed = (controller.current?.getConfirmedState().selectedFaceIds ?? []) as string[];
  const [draft, setDraft] = useState<string[] | null>(null);
  const current = draft ?? confirmed;
  const toggle = (id: string, on: boolean) => {
    setDraft(on ? [...current, id] : current.filter((x) => x !== id));
  };
  const lidCount = current.includes('cyl-face-upper') ? 2 : current.includes('cyl-face-lower') ? 1 : 0;
  /** confirm: exactly ONE canonical SelectFaces (whole-set replacement) —
   * the controller's onOperation channel delivers it to the Host. */
  const send = (next: string[]) => {
    const c = controller.current;
    if (!c) return;
    c.previewOperation({ type: 'SelectFaces', faceIds: next });
    c.confirmDraft();
    setDraft(null);
  };
  return (
    <fieldset className="face-selector">
      <legend>面清单（勾选为草稿，「确认选面」发送一条完整选面记录）</legend>
      <div role="group" aria-label="纸面清单">
        {FACE_LIST.filter((f) => whitelist.includes(f.id)).map((f) => (
          <label key={f.id} className="radio-line">
            <input
              type="checkbox"
              checked={current.includes(f.id)}
              onChange={(e) => toggle(f.id, e.target.checked)}
              aria-label={`${f.label}：算入纸样`}
            />
            {f.label}
            <span className="hint">{confirmed.includes(f.id) ? '（已确认选入）' : ''}</span>
          </label>
        ))}
      </div>
      <div role="radiogroup" aria-label="盖面个数（便捷入口，等效展开为盖面勾选）" className="btnrow">
        {[
          { n: 0, label: '0 个盖面' },
          { n: 1, label: '1 个盖面' },
          { n: 2, label: '2 个盖面' },
        ].map(({ n, label }) => (
          <label key={n} className="radio-line">
            <input
              type="radio"
              name="face-lid-count"
              checked={lidCount === n}
              onChange={() => {
                const ids: string[] = current.filter((id: string) => id === 'cyl-face-side');
                if (n >= 1) ids.push('cyl-face-lower');
                if (n >= 2) ids.push('cyl-face-upper');
                setDraft(ids);
              }}
            />
            {label}
          </label>
        ))}
      </div>
      <div className="btnrow">
        <button type="button" onClick={() => send(current)}>
          确认选面
        </button>
        {draft !== null ? (
          <button
            type="button"
            onClick={() => {
              setDraft(null);
              controller.current?.cancelDraft();
            }}
          >
            放弃草稿
          </button>
        ) : null}
      </div>
      {draft !== null ? <span className="draft-badge">未确认</span> : <span className="draft-badge">已确认</span>}
      <p className="hint">当前确认：{confirmed.length ? confirmed.join('、') : '（未选）'}</p>
    </fieldset>
  );
}

/** LayerStackControls（L4）：层数输入（任务收窄）+ 逐层/复位按钮；每次点击
 * 即一条确认的 SetVisibleLayerCount / SetLayerCount（与 slider 同级演示位纪律，
 * 动画帧属 ViewState）。 */
function LayerStackControls({
  task,
  controller,
  confirmedState,
}: {
  task: UiTask;
  controller: React.RefObject<SceneController | null>;
  confirmedState: CylinderStateV2;
}) {
  const layerConstraint = (task.operationConstraints ?? []).find((c) => c.type === 'SetLayerCount') as { values?: number[]; min?: number; max?: number } | undefined;
  const visibleConstraint = (task.operationConstraints ?? []).find((c) => c.type === 'SetVisibleLayerCount') as { min?: number; max?: number } | undefined;
  const [draftCount, setDraftCount] = useState('');
  const confirmedLayer = confirmedState.layerCount;
  const visible = confirmedState.visibleLayerCount;
  const applyVisible = (target: number) => {
    const c = controller.current;
    if (!c) return;
    const max = Math.min(visibleConstraint?.max ?? 40, confirmedLayer);
    const v = Math.max(0, Math.min(max, target));
    c.previewOperation({ type: 'SetVisibleLayerCount', value: v });
    c.confirmDraft();
  };
  return (
    <div className="layer-controls">
      {task.allowedOperationIds.includes('SetLayerCount') && layerConstraint ? (
        <fieldset>
          <legend>层数（n，整数）</legend>
          <div className="btnrow">
            {(layerConstraint.values ?? []).map((n) => (
              <button key={n} type="button" disabled={n === confirmedLayer} onClick={() => {
                const c = controller.current;
                if (!c) return;
                c.previewOperation({ type: 'SetLayerCount', value: n });
                c.confirmDraft();
              }}>
                {n} 层{n === confirmedLayer ? '（当前）' : ''}
              </button>
            ))}
            {!layerConstraint.values || layerConstraint.values.length === 0 ? (
              <>
                <label>
                  层数：
                  <input
                    type="number"
                    min={layerConstraint.min ?? 1}
                    max={layerConstraint.max ?? 40}
                    step={1}
                    value={draftCount}
                    onChange={(e) => setDraftCount(e.target.value)}
                    aria-label="层数（1 到 40 的整数）"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const n = Number(draftCount);
                    if (!Number.isInteger(n) || n < (layerConstraint.min ?? 1) || n > (layerConstraint.max ?? 40)) return;
                    const c = controller.current;
                    if (!c) return;
                    c.previewOperation({ type: 'SetLayerCount', value: n });
                    c.confirmDraft();
                    setDraftCount('');
                  }}
                >
                  确认层数
                </button>
              </>
            ) : null}
          </div>
        </fieldset>
      ) : null}
      {task.allowedOperationIds.includes('SetVisibleLayerCount') ? (
        <fieldset>
          <legend>逐层推进（已装 {visible} / {confirmedLayer} 层）</legend>
          <div className="btnrow">
            <button type="button" onClick={() => applyVisible(visible + 1)} aria-label="装一层（方向键上等价）">
              装一层（+1）
            </button>
            <button type="button" onClick={() => applyVisible(visible - 1)} aria-label="退一层（方向键下等价）">
              退一层（−1）
            </button>
            <button type="button" onClick={() => applyVisible(0)} aria-label="复位到 0 层（Home 键等价）">
              复位
            </button>
            <button type="button" onClick={() => applyVisible(confirmedLayer)}>
              一次装满
            </button>
          </div>
          <p className="hint">场景聚焦时方向键逐层、Home 复位；动画只是显示，判分只认确认的层数。</p>
        </fieldset>
      ) : null}
    </div>
  );
}
