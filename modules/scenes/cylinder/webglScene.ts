/**
 * WEBGL2 expression for rondo.cylinder@1 — three.js 0.186.1 (REVISION 186,
 * recorded in toolchain.json). WebGL 1 is unsupported since r163, so entry is
 * chosen by capability detection, never by browser name (SCENE-CONTRACTS §1).
 *
 * Book ("可交互立体学习书") expression language, per REFERENCE-BRIEF §2/§5.4:
 *  - ink-line flat fill: MeshBasicMaterial solid fills + LineSegments ink
 *    outlines; NO PBR lights, no post-processing, no bloom. Light/shadow is
 *    two-tone flats + hairlines only.
 *  - continuous morph: unrollPermille 0→1000 and dimension changes tween
 *    900–1400ms (interruptible — a new target restarts from the current
 *    displayed value), so slider drags feel like one continuous peeling.
 *  - narrative camera: large view changes ease 1050ms with an
 *    ease-out-quint (cubic-bezier(0.22,1,0.36,1) class); small direct steps
 *    (arrow-key rotation, zoom ticks) snap. All of it is ViewState only.
 *  - prefers-reduced-motion: every tween collapses to 150ms.
 *  - onFrame hook + projectPoints(): called after every rendered frame so a
 *    DOM overlay can track geometry edges via vector.project — the overlay
 *    re-projects each frame and never becomes a domain fact.
 *
 * Consumes only PublicSceneState + ViewState; emits nothing. Context loss is
 * surfaced via onContextLost so the controller can switch to SVG_DOM while
 * keeping the confirmed state, drafts and focus; restore re-renders from the
 * same state — no attempt rebuild, no hint reset, no resubmit.
 *
 * Browser-only: imported by apps/web, never by node tests.
 */
import * as THREE from 'three';
import type { CylinderSection, CylinderStateV1, CylinderStateV2 } from '../../contracts/public/scene';
import type { CameraState } from './view';

export type WebglAvailability = 'AVAILABLE' | 'UNAVAILABLE';

/** Detect a real WebGL2 context on a canvas without constructing the scene. */
export function detectWebgl2(canvas: HTMLCanvasElement): WebglAvailability {
  try {
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (gl) {
      // Keep the context: the same canvas returns the SAME context object to
      // the renderer later — calling loseContext() here would hand three.js a
      // dead context and crash renderer init (null precision). Do not "release".
      return 'AVAILABLE';
    }
    return 'UNAVAILABLE';
  } catch {
    return 'UNAVAILABLE';
  }
}

// Ink-and-flat-fill palette (mirrors the CSS tokens in apps/web/src/styles.css).
const PAPER = 0xf6f0e3;
const CARD_FILL = 0xfbf8f0;
const CHIP_FILL = 0xefe7d6;
const INK = 0x1c2433;
const ACCENT = 0x9a3b2a;
const SHADOW = 0xd9cfba;
// two-tone light language (REFERENCE-BRIEF §2.5/§5.4): lit face / shade face —
// two flat tones only, no gradients on the object, no PBR.
const SIDE_LIT = 0xfbf8f0;
const SIDE_SHADE = 0xe6daba;
const SIDE_LIT_COLOR = new THREE.Color(SIDE_LIT);
const SIDE_SHADE_COLOR = new THREE.Color(SIDE_SHADE);

const SEGS = 96;
/**
 * Flat strip floats a hair above the paper plane so it never z-fights.
 * Exported: the DOM annotation overlay anchors strip-edge cards on the same
 * plane (y in mm) so cards track the drawn geometry, not the target state.
 */
export const STRIP_PLANE_Y_MM = 2.4;
const STRIP_Y = STRIP_PLANE_Y_MM;

/** cubic-bezier(0.22, 1, 0.36, 1)-class ease-out (REFERENCE-BRIEF §5.4). */
function easeOutQuint(t: number): number {
  return 1 - (1 - t) ** 5;
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function wrapDeg(delta: number): number {
  return ((delta + 180) % 360 + 360) % 360 - 180;
}

interface MorphState {
  radiusMm: number;
  heightMm: number;
  unrollFraction: number;
}
interface CamPose {
  az: number;
  el: number;
  dist: number;
}
interface Tween<T> {
  from: T;
  to: T;
  startMs: number;
  durationMs: number;
}

export interface WebglSceneOptions {
  onContextLost: () => void;
  onContextRestored: () => void;
  stripOrientation: 'HORIZONTAL' | 'VERTICAL';
  /** called after every rendered frame — DOM-overlay re-projection hook. */
  onFrame?: () => void;
}

export class CylinderWebglScene {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 8000);
  private pixelRatio = 1;

  // ink-line objects (geometry buffers are preallocated and updated in place)
  private sideMesh!: THREE.Mesh;
  private sidePos!: THREE.BufferAttribute;
  private sideColor!: THREE.BufferAttribute;
  private sideLines!: THREE.LineSegments;
  private sideLinePos!: THREE.BufferAttribute;
  private sideLinesEcho!: THREE.LineSegments;
  private sideLinesEcho2!: THREE.LineSegments;
  private stripMesh!: THREE.Mesh;
  private stripLines!: THREE.LineSegments;
  private stripLinePos!: THREE.BufferAttribute;
  private stripLinesEcho!: THREE.LineSegments;
  private stripLinesEcho2!: THREE.LineSegments;
  private topBase!: THREE.Mesh;
  private bottomBase!: THREE.Mesh;
  private topRim!: THREE.LineLoop;
  private bottomRim!: THREE.LineLoop;
  private topRimEcho!: THREE.LineLoop;
  private bottomRimEcho!: THREE.LineLoop;
  private topRimEcho2!: THREE.LineLoop;
  private bottomRimEcho2!: THREE.LineLoop;
  private cylShadow!: THREE.Mesh;
  private castShadow!: THREE.Mesh;
  private stripShadow!: THREE.Mesh;
  private sectionGroup = new THREE.Group();
  /** L3/L4 overlays: confirmed face selection + layer discs (both rebuilt from
   * the confirmed state; animation frames are ViewState only). */
  private overlayGroup = new THREE.Group();
  private sectionShape: CylinderSection = 'NONE';
  private sectionFill: THREE.Mesh | null = null;
  private sectionRim: THREE.Line | null = null;
  private baseMat!: THREE.MeshBasicMaterial;
  private shadowMat!: THREE.MeshBasicMaterial;
  private castShadowMat!: THREE.MeshBasicMaterial;

  // tween state (display = what is drawn; target = latest state/view input)
  private display: MorphState = { radiusMm: 30, heightMm: 80, unrollFraction: 0 };
  private targetMorph: MorphState = { radiusMm: 30, heightMm: 80, unrollFraction: 0 };
  private geomTween: Tween<MorphState> | null = null;
  private camPose: CamPose = { az: 30, el: 15, dist: 420 };
  private camTween: Tween<CamPose> | null = null;

  private firstState = true;
  private lost = false;
  private disposed = false;
  private dirty = true;
  private rafId = 0;
  private resizeObserver: ResizeObserver | null = null;
  private reducedMotion = false;
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  private readonly onFrame: (() => void) | undefined;

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: WebglSceneOptions,
  ) {
    this.onFrame = opts.onFrame;
    try {
      this.reducedMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      this.reducedMotion = false;
    }
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.pixelRatio = Math.min(typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearColor(PAPER, 1);
    this.scene.background = new THREE.Color(PAPER);
    this.buildScene();
    this.scene.add(this.sectionGroup);
    this.scene.add(this.overlayGroup);
    canvas.addEventListener('webglcontextlost', this.handleLost);
    canvas.addEventListener('webglcontextrestored', this.handleRestored);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.dirty = true;
        this.wake();
      });
      this.resizeObserver.observe(canvas);
    }
  }

  get contextLost(): boolean {
    return this.lost;
  }

  /** Currently displayed (tweened) shape — the overlay tracks THIS, never the
   * target, so annotation cards stay glued to the drawn edges mid-morph. */
  getDisplayed(): { radiusMm: number; heightMm: number; unrollPermille: number } {
    return {
      radiusMm: this.display.radiusMm,
      heightMm: this.display.heightMm,
      unrollPermille: this.display.unrollFraction * 1000,
    };
  }

  /** Project model-space points (mm) to canvas CSS pixels for this frame. */
  projectPoints(points: ReadonlyArray<{ x: number; y: number; z: number }>): Array<{ x: number; y: number } | null> {
    const dom = this.renderer?.domElement ?? null;
    if (!dom) return points.map(() => null);
    const w = dom.clientWidth || 1;
    const h = dom.clientHeight || 1;
    const v = new THREE.Vector3();
    return points.map((p) => {
      v.set(p.x, p.y, p.z);
      v.project(this.camera);
      if (v.z < -1 || v.z > 1) return null;
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
    });
  }

  /** Rebuild the draw target from the confirmed scene state (same-state rebuild). */
  setState(state: CylinderStateV1 | CylinderStateV2): void {
    if (this.disposed || this.lost || !this.renderer) return;
    this.rebuildOverlays(state);
    if (state.section !== this.sectionShape) {
      this.sectionShape = state.section;
      this.rebuildSection();
      this.dirty = true;
    }
    const next: MorphState = {
      radiusMm: state.radiusMm,
      heightMm: state.heightMm,
      unrollFraction: state.unrollPermille / 1000,
    };
    if (this.firstState) {
      this.firstState = false;
      this.display = { ...next };
      this.targetMorph = { ...next };
      this.dirty = true;
      this.wake();
      return;
    }
    const unchanged =
      Math.abs(next.radiusMm - this.targetMorph.radiusMm) < 1e-6 &&
      Math.abs(next.heightMm - this.targetMorph.heightMm) < 1e-6 &&
      Math.abs(next.unrollFraction - this.targetMorph.unrollFraction) < 1e-6;
    if (unchanged) {
      this.wake();
      return;
    }
    const unrollMoves = Math.abs(next.unrollFraction - this.targetMorph.unrollFraction) > 1e-6;
    // continuous peel 1200–1600ms (1400 chosen); pure dimension edits 900ms;
    // reduced motion collapses every animation to a 150ms fade-class step.
    const durationMs = this.reducedMotion ? 150 : unrollMoves ? 1400 : 900;
    this.geomTween = { from: { ...this.display }, to: next, startMs: performance.now(), durationMs };
    this.targetMorph = { ...next };
    this.wake();
  }

  applyViewState(cam: CameraState, radiusMm: number, heightMm: number): void {
    void radiusMm;
    void heightMm;
    if (this.disposed || this.lost) return;
    const dAz = wrapDeg(cam.azimuthDeg - this.camPose.az);
    const dEl = cam.elevationDeg - this.camPose.el;
    const relDist = Math.abs(cam.distanceMm - this.camPose.dist) / Math.max(this.camPose.dist, 1);
    // narrative move (phase push-in / preset / reset): 900–1200ms class ease;
    // direct manipulation steps (arrow keys ±15°/±10°, zoom ticks) snap.
    const narrative = Math.abs(dAz) + Math.abs(dEl) > 25 || relDist > 0.3;
    const to: CamPose = { az: this.camPose.az + dAz, el: cam.elevationDeg, dist: cam.distanceMm };
    if (narrative && !this.reducedMotion) {
      this.camTween = { from: { ...this.camPose }, to, startMs: performance.now(), durationMs: 1050 };
    } else {
      this.camTween = null;
      this.camPose = to;
    }
    this.dirty = true;
    this.wake();
  }

  /** Release GPU resources on scene unload / lesson switch (SCENE-CONTRACTS §6). */
  dispose(): void {
    this.disposed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas.removeEventListener('webglcontextlost', this.handleLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleRestored);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.sectionGroup.clear();
    this.overlayGroup.clear();
    this.renderer?.dispose();
    this.renderer = null;
  }

  // ---- internals -----------------------------------------------------------

  /**
   * L3/L4 overlays — confirmed facts only (highlight + layer discs), rebuilt
   * whenever a confirmed state arrives. Ink-line language: flat green fills
   * for selected faces; paper-tone layer discs with ink rings. Animation
   * frames are ViewState and never touch these.
   */
  private rebuildOverlays(state: CylinderStateV1 | CylinderStateV2): void {
    this.overlayGroup.clear();
    const r = state.radiusMm;
    const h = state.heightMm;
    const sel = new Set(state.selectedFaceIds);
    if (sel.size > 0) {
      const faceMat = new THREE.MeshBasicMaterial({ color: 0x2e7d54, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
      if (sel.has('cyl-face-side')) {
        const side = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 64, 1, true), faceMat);
        side.position.y = h / 2;
        this.overlayGroup.add(side);
      }
      if (sel.has('cyl-face-upper')) {
        const top = new THREE.Mesh(new THREE.CircleGeometry(r, 64), faceMat);
        top.rotation.x = -Math.PI / 2;
        top.position.y = h + 0.6;
        this.overlayGroup.add(top);
      }
      if (sel.has('cyl-face-lower')) {
        const bottom = new THREE.Mesh(new THREE.CircleGeometry(r, 64), faceMat);
        bottom.rotation.x = Math.PI / 2;
        bottom.position.y = -0.6;
        this.overlayGroup.add(bottom);
      }
    }
    const layered = state as CylinderStateV2;
    if (layered.layerCount !== undefined && layered.visibleLayerCount > 0) {
      // thin discs stacked bottom-up; count = CONFIRMED visibleLayerCount
      const n = layered.layerCount;
      const layerH = h / n;
      const discMat = new THREE.MeshBasicMaterial({ color: CHIP_FILL, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
      const discEdge = new THREE.MeshBasicMaterial({ color: INK });
      for (let k = 1; k <= Math.min(layered.visibleLayerCount, n); k += 1) {
        const y = k * layerH - layerH / 2;
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(r - 0.8, r - 0.8, Math.min(layerH, 4), 48), discMat);
        disc.position.y = y;
        this.overlayGroup.add(disc);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r - 0.8, 0.5, 8, 48), discEdge);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = y;
        this.overlayGroup.add(ring);
      }
    }
  }

  private handleLost = (e: Event): void => {
    e.preventDefault();
    this.lost = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.opts.onContextLost();
  };

  private handleRestored = (): void => {
    this.lost = false;
    this.dirty = true;
    this.wake();
    this.opts.onContextRestored();
  };

  private wake(): void {
    if (this.disposed || this.lost || !this.renderer) return;
    if (!this.rafId) this.rafId = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.rafId = 0;
    if (this.disposed || this.lost || !this.renderer) return;
    let animating = false;
    if (this.geomTween) {
      const t = clamp01((now - this.geomTween.startMs) / Math.max(1, this.geomTween.durationMs));
      const e = easeOutQuint(t);
      const { from, to } = this.geomTween;
      this.display = {
        radiusMm: from.radiusMm + (to.radiusMm - from.radiusMm) * e,
        heightMm: from.heightMm + (to.heightMm - from.heightMm) * e,
        unrollFraction: from.unrollFraction + (to.unrollFraction - from.unrollFraction) * e,
      };
      this.dirty = true;
      if (t >= 1) this.geomTween = null;
      else animating = true;
    }
    if (this.camTween) {
      const t = clamp01((now - this.camTween.startMs) / Math.max(1, this.camTween.durationMs));
      const e = easeOutQuint(t);
      const { from, to } = this.camTween;
      this.camPose = {
        az: from.az + (to.az - from.az) * e,
        el: from.el + (to.el - from.el) * e,
        dist: from.dist + (to.dist - from.dist) * e,
      };
      this.dirty = true;
      if (t >= 1) this.camTween = null;
      else animating = true;
    }
    if (this.dirty) {
      this.updateScene();
      this.renderOnce();
      this.dirty = false;
    }
    if (animating) this.rafId = requestAnimationFrame(this.tick);
  };

  private buildScene(): void {
    // materials — flat fills only, zero lights (ink drawing, not PBR)
    const sideMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const stripMat = new THREE.MeshBasicMaterial({ color: CHIP_FILL, side: THREE.DoubleSide });
    const baseMat = new THREE.MeshBasicMaterial({
      color: CARD_FILL,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
    });
    const shadowMat = new THREE.MeshBasicMaterial({
      color: SHADOW,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const castShadowMat = new THREE.MeshBasicMaterial({
      color: SHADOW,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const sectionMat = new THREE.MeshBasicMaterial({
      color: ACCENT,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const inkLineMat = new THREE.LineBasicMaterial({ color: INK });
    // "boiled ink" pen echo: the same ink geometry drawn once more, slightly
    // offset and lighter — a double stroke that gives thin GL lines the weight
    // of a pen line (still MeshBasicMaterial+Line, no PBR/post-processing)
    const echoLineMat = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.5 });
    const echo2LineMat = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.26 });
    const accentLineMat = new THREE.LineBasicMaterial({ color: ACCENT });
    this.baseMat = baseMat;
    this.shadowMat = shadowMat;
    this.castShadowMat = castShadowMat;
    this.disposables.push(sideMat, stripMat, baseMat, shadowMat, castShadowMat, sectionMat, inkLineMat, echoLineMat, echo2LineMat, accentLineMat);

    // rolled side: partial cylinder, positions + two-tone vertex colors updated
    // in place every frame (lit face / shade face — view-locked light, so the
    // tone boundary never claims to be an object property when rotating)
    const sideGeo = new THREE.BufferGeometry();
    const sidePosArr = new Float32Array((SEGS + 1) * 2 * 3);
    this.sidePos = new THREE.BufferAttribute(sidePosArr, 3);
    sideGeo.setAttribute('position', this.sidePos);
    this.sideColor = new THREE.BufferAttribute(new Float32Array((SEGS + 1) * 2 * 3), 3);
    sideGeo.setAttribute('color', this.sideColor);
    const sideIdx: number[] = [];
    for (let i = 0; i < SEGS; i++) {
      const b = i * 2;
      sideIdx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    sideGeo.setIndex(sideIdx);
    this.sideMesh = new THREE.Mesh(sideGeo, sideMat);
    this.sideMesh.frustumCulled = false;
    this.scene.add(this.sideMesh);

    // ink outline of the rolled part: bottom rim + top rim + both seam edges
    const sideLineGeo = new THREE.BufferGeometry();
    const sideLineArr = new Float32Array((SEGS * 2 + 2) * 2 * 3);
    this.sideLinePos = new THREE.BufferAttribute(sideLineArr, 3);
    sideLineGeo.setAttribute('position', this.sideLinePos);
    this.sideLines = new THREE.LineSegments(sideLineGeo, inkLineMat);
    this.sideLines.frustumCulled = false;
    this.scene.add(this.sideLines);
    // pen echoes of the side outline (share the same geometry buffer): a
    // strong stroke on the upper-right and a lighter counter stroke on the
    // lower-left — together they read as one 1.5-2px pen line
    this.sideLinesEcho = new THREE.LineSegments(sideLineGeo, echoLineMat);
    this.sideLinesEcho.frustumCulled = false;
    this.sideLinesEcho.position.set(0.8, 1.1, 0.8);
    this.scene.add(this.sideLinesEcho);
    this.sideLinesEcho2 = new THREE.LineSegments(sideLineGeo, echo2LineMat);
    this.sideLinesEcho2.frustumCulled = false;
    this.sideLinesEcho2.position.set(-0.6, 0.9, -0.6);
    this.scene.add(this.sideLinesEcho2);

    // flat strip: unit plane scaled/positioned every frame
    const stripGeo = new THREE.PlaneGeometry(1, 1);
    this.stripMesh = new THREE.Mesh(stripGeo, stripMat);
    this.stripMesh.frustumCulled = false;
    this.scene.add(this.stripMesh);
    const stripLineGeo = new THREE.BufferGeometry();
    const stripLineArr = new Float32Array(8 * 3);
    this.stripLinePos = new THREE.BufferAttribute(stripLineArr, 3);
    stripLineGeo.setAttribute('position', this.stripLinePos);
    this.stripLines = new THREE.LineSegments(stripLineGeo, inkLineMat);
    this.stripLines.frustumCulled = false;
    this.scene.add(this.stripLines);
    this.stripLinesEcho = new THREE.LineSegments(stripLineGeo, echoLineMat);
    this.stripLinesEcho.frustumCulled = false;
    this.stripLinesEcho.position.set(0.8, 1.1, 0.8);
    this.scene.add(this.stripLinesEcho);
    this.stripLinesEcho2 = new THREE.LineSegments(stripLineGeo, echo2LineMat);
    this.stripLinesEcho2.frustumCulled = false;
    this.stripLinesEcho2.position.set(-0.6, 0.9, -0.6);
    this.scene.add(this.stripLinesEcho2);

    // bases: unit circles scaled by r (fade while unrolled)
    const baseGeo = new THREE.CircleGeometry(1, 64);
    this.topBase = new THREE.Mesh(baseGeo, baseMat);
    this.topBase.rotation.x = -Math.PI / 2;
    this.bottomBase = new THREE.Mesh(baseGeo, baseMat);
    this.bottomBase.rotation.x = Math.PI / 2;
    this.scene.add(this.topBase, this.bottomBase);
    const rimGeo = new THREE.BufferGeometry();
    const rimPts = new Float32Array(64 * 3);
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      rimPts[i * 3] = Math.cos(a);
      rimPts[i * 3 + 2] = Math.sin(a);
    }
    rimGeo.setAttribute('position', new THREE.BufferAttribute(rimPts, 3));
    this.topRim = new THREE.LineLoop(rimGeo, inkLineMat);
    this.bottomRim = new THREE.LineLoop(rimGeo, inkLineMat);
    this.scene.add(this.topRim, this.bottomRim);
    this.topRimEcho = new THREE.LineLoop(rimGeo, echoLineMat);
    this.bottomRimEcho = new THREE.LineLoop(rimGeo, echoLineMat);
    this.topRimEcho2 = new THREE.LineLoop(rimGeo, echo2LineMat);
    this.bottomRimEcho2 = new THREE.LineLoop(rimGeo, echo2LineMat);
    this.scene.add(this.topRimEcho, this.bottomRimEcho, this.topRimEcho2, this.bottomRimEcho2);

    // two-tone paper "shadows" (flat fills, the only light language here):
    // contact ellipse under the base + a cast ellipse offset to the shade
    // side, so the model SITS on the page with weight
    const shadowGeo = new THREE.CircleGeometry(1, 48);
    this.cylShadow = new THREE.Mesh(shadowGeo, shadowMat);
    this.cylShadow.rotation.x = -Math.PI / 2;
    this.cylShadow.position.y = 0.25;
    this.cylShadow.renderOrder = -2;
    this.scene.add(this.cylShadow);
    const castGeo = new THREE.CircleGeometry(1, 48);
    this.castShadow = new THREE.Mesh(castGeo, castShadowMat);
    this.castShadow.rotation.x = -Math.PI / 2;
    this.castShadow.position.y = 0.14;
    this.castShadow.renderOrder = -3;
    this.scene.add(this.castShadow);
    const stripShadowGeo = new THREE.PlaneGeometry(1, 1);
    this.stripShadow = new THREE.Mesh(stripShadowGeo, shadowMat);
    this.stripShadow.rotation.x = -Math.PI / 2;
    this.stripShadow.position.y = 0.4;
    this.stripShadow.renderOrder = -2;
    this.scene.add(this.stripShadow);

    this.disposables.push(
      sideGeo,
      sideLineGeo,
      stripGeo,
      stripLineGeo,
      baseGeo,
      rimGeo,
      shadowGeo,
      castGeo,
      stripShadowGeo,
    );
  }

  private rebuildSection(): void {
    if (this.sectionFill) {
      this.sectionFill.geometry.dispose();
      this.sectionGroup.remove(this.sectionFill);
      this.sectionFill = null;
    }
    if (this.sectionRim) {
      this.sectionRim.geometry.dispose();
      this.sectionGroup.remove(this.sectionRim);
      this.sectionRim = null;
    }
    if (this.sectionShape === 'NONE') return;
    if (this.sectionShape === 'TRANSVERSE') {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48), this.sectionFillMaterial());
      disc.rotation.x = -Math.PI / 2;
      this.sectionFill = disc;
      const rimGeo = new THREE.BufferGeometry();
      const pts = new Float32Array(48 * 3);
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        pts[i * 3] = Math.cos(a);
        pts[i * 3 + 2] = Math.sin(a);
      }
      rimGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      this.sectionRim = new THREE.LineLoop(rimGeo, this.accentLineMaterial());
      this.sectionGroup.add(disc, this.sectionRim);
    } else {
      const rect = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.sectionFillMaterial());
      rect.rotation.y = Math.PI / 2;
      this.sectionFill = rect;
      const sq = new THREE.BufferGeometry();
      sq.setAttribute(
        'position',
        new THREE.BufferAttribute(
          new Float32Array([
            -0.5, -0.5, 0, 0.5, -0.5, 0,
            0.5, -0.5, 0, 0.5, 0.5, 0,
            0.5, 0.5, 0, -0.5, 0.5, 0,
            -0.5, 0.5, 0, -0.5, -0.5, 0,
          ]),
          3,
        ),
      );
      const rim = new THREE.LineSegments(sq, this.accentLineMaterial());
      rim.rotation.y = Math.PI / 2;
      this.sectionRim = rim;
      this.sectionGroup.add(rect, rim);
    }
  }

  private sectionFillMaterial(): THREE.MeshBasicMaterial {
    if (!this.sectionFillMat) {
      this.sectionFillMat = new THREE.MeshBasicMaterial({
        color: ACCENT,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.disposables.push(this.sectionFillMat);
    }
    return this.sectionFillMat;
  }
  private accentLineMaterial(): THREE.LineBasicMaterial {
    if (!this.accentLineMat) {
      this.accentLineMat = new THREE.LineBasicMaterial({ color: ACCENT });
      this.disposables.push(this.accentLineMat);
    }
    return this.accentLineMat;
  }
  private sectionFillMat: THREE.MeshBasicMaterial | null = null;
  private accentLineMat: THREE.LineBasicMaterial | null = null;

  private setStripOutline(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ): void {
    const arr = this.stripLinePos.array as Float32Array;
    const pts = [a, b, b, c, c, d, d, a];
    for (let i = 0; i < 8; i++) {
      arr[i * 3] = pts[i][0];
      arr[i * 3 + 1] = pts[i][1];
      arr[i * 3 + 2] = pts[i][2];
    }
    this.stripLinePos.needsUpdate = true;
  }

  private updateScene(): void {
    const r = this.display.radiusMm;
    const h = this.display.heightMm;
    const f = this.display.unrollFraction;
    const remain = 1 - f;
    const rolledVisible = remain > 0.001;
    this.sideMesh.visible = rolledVisible;
    this.sideLines.visible = rolledVisible;
    this.sideLinesEcho.visible = rolledVisible;
    this.sideLinesEcho2.visible = rolledVisible;
    // view-locked light (upper-left of the viewer): rotating the view keeps the
    // lit face toward the reader — the tone boundary is a drawing convention,
    // never an object property (L1: rotation changes nothing about the object)
    const azL = ((this.camPose.az + 130) * Math.PI) / 180;
    if (rolledVisible) {
      const total = remain * Math.PI * 2;
      const pos = this.sidePos.array as Float32Array;
      const col = this.sideColor.array as Float32Array;
      const lit = SIDE_LIT_COLOR;
      const shade = SIDE_SHADE_COLOR;
      for (let i = 0; i <= SEGS; i++) {
        const a = (total * i) / SEGS;
        const x = r * Math.cos(a);
        const z = r * Math.sin(a);
        const b = i * 6;
        pos[b] = x;
        pos[b + 1] = 0;
        pos[b + 2] = z;
        pos[b + 3] = x;
        pos[b + 4] = h;
        pos[b + 5] = z;
        // normal at angle a = (cos a, 0, sin a); light horizontal dir (cosAzL, sinAzL)
        const litFace = Math.cos(a - azL) > -0.08;
        const tone = litFace ? lit : shade;
        const c = i * 6;
        col[c] = tone.r;
        col[c + 1] = tone.g;
        col[c + 2] = tone.b;
        col[c + 3] = tone.r;
        col[c + 4] = tone.g;
        col[c + 5] = tone.b;
      }
      this.sidePos.needsUpdate = true;
      this.sideColor.needsUpdate = true;
      const lp = this.sideLinePos.array as Float32Array;
      let k = 0;
      const put = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): void => {
        lp[k++] = x1;
        lp[k++] = y1;
        lp[k++] = z1;
        lp[k++] = x2;
        lp[k++] = y2;
        lp[k++] = z2;
      };
      for (let i = 0; i < SEGS; i++) {
        const a1 = (total * i) / SEGS;
        const a2 = (total * (i + 1)) / SEGS;
        put(r * Math.cos(a1), 0, r * Math.sin(a1), r * Math.cos(a2), 0, r * Math.sin(a2));
        put(r * Math.cos(a1), h, r * Math.sin(a1), r * Math.cos(a2), h, r * Math.sin(a2));
      }
      put(r, 0, 0, r, h, 0); // fixed seam
      put(
        r * Math.cos(total), 0, r * Math.sin(total),
        r * Math.cos(total), h, r * Math.sin(total),
      ); // moving seam
      this.sideLinePos.needsUpdate = true;
    }

    // bases fade while the peel boundary stays readable
    const fade = clamp01((f - 0.45) / 0.25);
    this.baseMat.opacity = 1 - 0.65 * fade;
    this.topBase.position.y = h;
    this.topBase.scale.set(r, r, 1);
    this.bottomBase.position.y = 0.6;
    this.bottomBase.scale.set(r, r, 1);
    this.topRim.position.y = h + 0.5;
    this.topRim.scale.set(r, 1, r);
    this.bottomRim.position.y = 0.6;
    this.bottomRim.scale.set(r, 1, r);
    this.topRimEcho.position.set(0.8, h + 1.6, 0.8);
    this.topRimEcho.scale.set(r, 1, r);
    this.bottomRimEcho.position.set(0.8, 1.7, 0.8);
    this.bottomRimEcho.scale.set(r, 1, r);
    this.topRimEcho2.position.set(-0.6, h + 1.5, -0.6);
    this.topRimEcho2.scale.set(r, 1, r);
    this.bottomRimEcho2.position.set(-0.6, 1.6, -0.6);
    this.bottomRimEcho2.scale.set(r, 1, r);

    // ground shadows: contact ellipse + cast ellipse toward the shade side
    // (opposite the light), both fading as the side peels away — flat fills,
    // the only "light" in this ink drawing
    const rollTone = clamp01(remain * 3);
    const cAzL = Math.cos(azL);
    const sAzL = Math.sin(azL);
    this.cylShadow.visible = rollTone > 0.01;
    this.cylShadow.scale.set(r * 1.3, r * 1.3, 1);
    this.shadowMat.opacity = 0.5 * rollTone;
    this.castShadow.visible = rollTone > 0.01;
    this.castShadow.scale.set(r * 0.92, r * 0.92, 1);
    this.castShadow.position.set(-cAzL * r * 0.42, 0.14, -sAzL * r * 0.42);
    this.castShadowMat.opacity = 0.3 * rollTone;

    // flat strip + its ink outline (net rectangle), continuing from the seam
    const vertical = this.opts.stripOrientation === 'VERTICAL';
    const L = f * 2 * Math.PI * r;
    const stripVisible = f > 0.002;
    this.stripMesh.visible = stripVisible;
    this.stripLines.visible = stripVisible;
    this.stripLinesEcho.visible = stripVisible;
    this.stripLinesEcho2.visible = stripVisible;
    this.stripShadow.visible = stripVisible && !vertical;
    if (stripVisible) {
      if (vertical) {
        this.stripMesh.rotation.set(0, 0, Math.PI / 2);
        this.stripMesh.scale.set(L, h, 1);
        this.stripMesh.position.set(r, h + L / 2, 0);
        const x1 = r - h / 2;
        const x2 = r + h / 2;
        this.setStripOutline([x1, h, 0], [x1, h + L, 0], [x2, h + L, 0], [x2, h, 0]);
      } else {
        this.stripMesh.rotation.set(-Math.PI / 2, 0, 0);
        this.stripMesh.scale.set(L, h, 1);
        this.stripMesh.position.set(r + L / 2, STRIP_Y, 0);
        this.setStripOutline(
          [r, STRIP_Y, -h / 2], [r + L, STRIP_Y, -h / 2],
          [r + L, STRIP_Y, h / 2], [r, STRIP_Y, h / 2],
        );
        this.stripShadow.scale.set(L * 1.05, h * 1.16, 1);
        this.stripShadow.position.set(r + L / 2, 0.4, 0);
      }
    }

    // section planes follow the (possibly tweening) dimensions
    if (this.sectionShape === 'TRANSVERSE') {
      this.sectionFill?.scale.set(r, r, 1);
      if (this.sectionFill) this.sectionFill.position.y = h / 2;
      this.sectionRim?.scale.set(r, 1, r);
      if (this.sectionRim) this.sectionRim.position.y = h / 2;
    } else if (this.sectionShape === 'AXIAL') {
      this.sectionFill?.scale.set(2 * r, h, 1);
      if (this.sectionFill) this.sectionFill.position.y = h / 2;
      this.sectionRim?.scale.set(2 * r, h, 1);
      if (this.sectionRim) this.sectionRim.position.y = h / 2;
    }
  }

  private renderOnce(): void {
    if (!this.renderer || this.disposed || this.lost) return;
    const dom = this.renderer.domElement;
    const w = dom.clientWidth || 640;
    const h = dom.clientHeight || 400;
    const bw = Math.max(1, Math.round(w * this.pixelRatio));
    const bh = Math.max(1, Math.round(h * this.pixelRatio));
    if (dom.width !== bw || dom.height !== bh) this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);

    // Frame the figure as the SUBJECT of the right page. The actual silhouette
    // (cylinder rims + unrolled strip + ground shadows) is sampled, projected
    // through the CURRENT camera basis WITH perspective magnification (near
    // parts of the figure loom larger — an ortho fit underestimates them and
    // the strip end used to clip at the page edge), and the camera distance
    // solved so the figure fills the frame: vertical ~71%, horizontal ~90%.
    // The view's distanceMm acts as a zoom FACTOR around that framing
    // reference (DEFAULT_CAMERA 420mm ≡ factor 1), so phase narrative
    // distances and user zoom stay meaningful at every cylinder size.
    const r = this.display.radiusMm;
    const heightMm = this.display.heightMm;
    const f = this.display.unrollFraction;
    const vertical = this.opts.stripOrientation === 'VERTICAL';
    const L = f * 2 * Math.PI * r;
    const az = (this.camPose.az * Math.PI) / 180;
    const el = (this.camPose.el * Math.PI) / 180;
    const ca = Math.cos(az);
    const sa = Math.sin(az);
    const ce = Math.cos(el);
    const se = Math.sin(el);

    // figure sample points (model space)
    const samples: Array<[number, number, number]> = [];
    // rim circles of the (possibly fading) bases — a cylinder's silhouette is
    // 2r wide from ANY azimuth; the ghost circles stay visible after a full
    // peel, so they always belong to the figure
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const px = r * Math.cos(a);
      const pz = r * Math.sin(a);
      samples.push([px, 0, pz], [px, heightMm, pz]);
    }
    // ground shadows (contact + cast) — part of the figure's footprint
    const azL = az + (130 * Math.PI) / 180;
    const castX = -Math.cos(azL) * r * 0.42;
    const castZ = -Math.sin(azL) * r * 0.42;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      samples.push([r * 1.3 * Math.cos(a), 0.3, r * 1.3 * Math.sin(a)]);
      samples.push([castX + r * 0.92 * Math.cos(a), 0.2, castZ + r * 0.92 * Math.sin(a)]);
    }
    if (f > 0.002) {
      if (vertical) {
        samples.push(
          [r - heightMm / 2, heightMm, 0],
          [r + heightMm / 2, heightMm, 0],
          [r - heightMm / 2, heightMm + L, 0],
          [r + heightMm / 2, heightMm + L, 0],
        );
      } else {
        for (const z of [-heightMm / 2, heightMm / 2]) {
          samples.push([r, STRIP_Y, z], [r + L, STRIP_Y, z], [r + L * 0.5, 0.4, z * 1.16]);
        }
        samples.push([r + L * 0.5, 0.4, 0]);
      }
    }

    // camera basis (three.js orbit camera: pos = center + dist*(ce·ca, se, ce·sa))
    // screen-right = (sa, 0, -ca); screen-up = (-ca·se, ce, -sa·se);
    // depth from camera grows along -(fwd) where fwd = (-ce·ca, -se, -ce·sa)
    const tanY = Math.tan((this.camera.fov * Math.PI) / 360);
    const tanX = tanY * this.camera.aspect;
    const V_FILL = 0.71;
    const H_FILL = 0.84;
    // ensemble anchor around which samples are measured
    let ccx = f > 0.002 && !vertical ? (r + L) / 2 : 0;
    let ccy = heightMm / 2;
    let ccz = 0;
    let dist = Math.max(r * 4, heightMm * 3, 120); // pass-1 (≈ortho) seed
    for (let pass = 0; pass < 3; pass++) {
      let sxMin = Infinity;
      let sxMax = -Infinity;
      let syMin = Infinity;
      let syMax = -Infinity;
      for (const [x, y, z] of samples) {
        const dx = x - ccx;
        const dy = y - ccy;
        const dz = z - ccz;
        // depth along the camera's forward axis: parts of the figure toward
        // the camera (positive along fwd) are NEARER and magnified
        const depth = dist - (dx * ce * ca + dy * se + dz * ce * sa);
        if (depth < 10) continue; // degenerate; safety
        const k = dist / depth;
        const sx = (dx * sa - dz * ca) * k;
        const sy = (dy * ce - se * (dx * ca + dz * sa)) * k;
        if (sx < sxMin) sxMin = sx;
        if (sx > sxMax) sxMax = sx;
        if (sy < syMin) syMin = sy;
        if (sy > syMax) syMax = sy;
      }
      const sxHalf = Math.max((sxMax - sxMin) / 2, 1);
      const syHalf = Math.max((syMax - syMin) / 2, 1);
      // re-center the ensemble so its silhouette lands mid-frame (this also
      // compensates the perspective near/far asymmetry — no hand-tuned bias)
      const ox = (sxMin + sxMax) / 2;
      const oy = (syMin + syMax) / 2;
      ccx += sa * ox;
      ccz -= ca * ox;
      ccy += oy / Math.max(ce, 0.2);
      dist = Math.max(90, Math.max(syHalf / (V_FILL * tanY), sxHalf / (H_FILL * tanX)) * 1.02);
    }
    // final nudge: the faint cast shadow pulls the sampled silhouette's center
    // below the visual mass; lower the look-at a touch so the figure rises
    // clear of the bottom edge (lookAt down ⇒ figure up on screen)
    let sampleMaxY = heightMm;
    for (const s of samples) if (s[1] > sampleMaxY) sampleMaxY = s[1];
    ccy -= sampleMaxY * 0.035;
    dist = Math.max(90, dist * (this.camPose.dist / 420));
    this.camera.position.set(
      ccx + dist * ce * ca,
      ccy + dist * se,
      ccz + dist * ce * sa,
    );
    this.camera.lookAt(ccx, ccy, ccz);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  }
}
