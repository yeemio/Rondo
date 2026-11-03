/**
 * SceneController: expression-independent brain of rondo.cylinder@1.
 *
 * Owns the boundary that matters for the contract:
 *  - confirmed PublicSceneState (from the Host — the only authority)
 *  - a local unconfirmed operation draft ("未确认", cancellable, never sent)
 *  - ViewState (camera/focus/animation — never a command, never a fact)
 *  - expression mode WEBGL2/SVG_DOM with loss/restore that preserves the
 *    confirmed state, the draft and the focus and continues the same question
 *
 * It never validates domain correctness: judging lives server-side
 * (mock evaluator / B learning server). Headless-testable: renderers are
 * injected as interfaces, node tests pass fakes.
 */
import type {
  CylinderOperationV1,
  CylinderOperationV2,
  CylinderStateV1,
  CylinderStateV2,
} from '../../contracts/public/scene';
import type { CameraState } from './view';
import { DEFAULT_CAMERA, applyPreset, normalizeCamera, resetView, rotate, zoom, type ViewPresetId } from './view';

export type ExpressionMode = 'WEBGL2' | 'SVG_DOM';

/** The renderer family serves @1 and @2 states/ops (L34-1); @1 flows are unchanged. */
export type CylinderSceneState = CylinderStateV1 | CylinderStateV2;
export type CylinderSceneOperation = CylinderOperationV1 | CylinderOperationV2;

export interface SceneRenderer {
  /** apply the confirmed state (or the state overlaid with a draft preview) */
  render(state: CylinderSceneState, view: CameraState, mode: ExpressionMode): void;
}

export interface SceneControllerOptions {
  renderer: SceneRenderer;
  initialState: CylinderSceneState;
  initialMode: ExpressionMode;
  /** sends a confirmed typed operation upward (commitOperation envelope) */
  onOperation(op: CylinderSceneOperation): void;
  onModeChange(mode: ExpressionMode, reason: 'initial' | 'context-loss' | 'context-restored' | 'manual'): void;
}

export class SceneController {
  private confirmed: CylinderSceneState;
  private draft: CylinderSceneOperation | null = null;
  private view: CameraState = { ...DEFAULT_CAMERA };
  private mode: ExpressionMode;
  private webglEverLost = false;

  constructor(private opts: SceneControllerOptions) {
    this.confirmed = { ...opts.initialState };
    this.mode = opts.initialMode;
    this.opts.renderer.render(this.confirmed, this.view, this.mode);
  }

  // ---- confirmed state (authority: Host) ----
  applyConfirmedState(next: CylinderSceneState): void {
    this.confirmed = { ...next };
    if (this.draft) this.draft = null; // server state wins; draft cancelled
    this.rerender();
  }

  getConfirmedState(): CylinderSceneState {
    return { ...this.confirmed };
  }

  // ---- draft (preview, cancellable; one canonical op on confirm) ----
  /** Current preview state = confirmed state overlaid with the draft, if any. */
  getPreviewState(): CylinderSceneState {
    if (!this.draft) return { ...this.confirmed };
    return overlayOperation(this.confirmed, this.draft);
  }

  hasDraft(): boolean {
    return this.draft !== null;
  }

  getDraft(): CylinderSceneOperation | null {
    return this.draft ? { ...this.draft } : null;
  }

  /** Continuous local preview (slider drag, typing) — no command sent. */
  previewOperation(op: CylinderSceneOperation): void {
    this.draft = { ...op };
    this.rerender();
  }

  /** Cancel drag/typing: revert to the last confirmed state (SCENE-CONTRACTS §6). */
  cancelDraft(): void {
    this.draft = null;
    this.rerender();
  }

  /** Confirm: emit exactly one typed operation upward. */
  confirmDraft(): void {
    if (!this.draft) return;
    const op = { ...this.draft };
    this.draft = null;
    this.opts.onOperation(op);
    // optimistic local overlay until the Host projection returns; the badge
    // stays "未确认" until applyConfirmedState lands with the same value
    this.rerender();
  }

  // ---- ViewState: camera/zoom/focus only, never domain facts ----
  rotateView(dAz: number, dEl: number): void {
    this.view = rotate(this.view, dAz, dEl);
    this.rerender();
  }

  zoomView(factor: number): void {
    this.view = zoom(this.view, factor);
    this.rerender();
  }

  resetView(): void {
    this.view = resetView();
    this.rerender();
  }

  applyViewPreset(preset: ViewPresetId): void {
    this.view = applyPreset(this.view, preset);
    this.rerender();
  }

  /**
   * Narrative camera pose (presentation-only): merge a partial camera — e.g.
   * a phase-driven push-in / side view / section close-up — and re-render.
   * Like every ViewState path this NEVER emits a domain operation.
   */
  applyCamera(partial: Partial<CameraState>): void {
    this.view = normalizeCamera({ ...this.view, ...partial });
    this.rerender();
  }

  getView(): CameraState {
    return { ...this.view };
  }

  // ---- expression mode & context loss ----
  getMode(): ExpressionMode {
    return this.mode;
  }

  /** WebGL init failure or runtime context loss: keep state/draft/focus, switch. */
  handleContextLost(): void {
    this.webglEverLost = true;
    if (this.mode === 'WEBGL2') {
      this.mode = 'SVG_DOM';
      this.opts.onModeChange('SVG_DOM', 'context-loss');
    }
    this.rerender();
  }

  /** WebGL regained: rebuild from the SAME confirmed state, keep draft. */
  handleContextRestored(renderer: SceneRenderer): void {
    this.opts.renderer = renderer;
    this.mode = 'WEBGL2';
    this.opts.onModeChange('WEBGL2', 'context-restored');
    this.rerender();
  }

  switchMode(mode: ExpressionMode): void {
    this.mode = mode;
    this.opts.onModeChange(mode, 'manual');
    this.rerender();
  }

  get everLostWebgl(): boolean {
    return this.webglEverLost;
  }

  /** Scene unload / lesson switch: drop everything (callers dispose GPU). */
  dispose(): void {
    this.draft = null;
  }

  private rerender(): void {
    this.opts.renderer.render(this.getPreviewState(), this.view, this.mode);
  }
}

/** Overlay a typed operation onto a state — pure, shared by both expressions.
 * V2 layer ops apply only to V2 states (task whitelists guarantee this at the
 * command boundary; SetVisibleLayerCount clamps to the target layerCount). */
export function overlayOperation(state: CylinderSceneState, op: CylinderSceneOperation): CylinderSceneState {
  switch (op.type) {
    case 'SetDimension':
      return op.dimension === 'RADIUS'
        ? { ...state, radiusMm: op.valueMm }
        : { ...state, heightMm: op.valueMm };
    case 'SetUnroll':
      return { ...state, unrollPermille: op.valuePermille };
    case 'SetSection':
      return { ...state, section: op.section };
    case 'SelectFaces':
      return { ...state, selectedFaceIds: op.faceIds };
    case 'SetLayerCount': {
      const s = state as CylinderStateV2;
      return { ...s, layerCount: op.value, visibleLayerCount: Math.min(s.visibleLayerCount, op.value) };
    }
    case 'SetVisibleLayerCount': {
      const s = state as CylinderStateV2;
      return { ...s, visibleLayerCount: Math.min(op.value, s.layerCount) };
    }
  }
}
