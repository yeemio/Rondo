/**
 * ViewState: camera, focus, zoom and animation interpolation. NEVER part of
 * domain commands, never persisted as learning facts, never scored
 * (SCENE-CONTRACTS §1; contracts/public/scene.ts viewStateSchema).
 *
 * Pure math, no DOM: rotation/zoom produce identical projections for the SVG
 * expression; the WEBGL2 expression uses the same numbers to drive three.js.
 */
import type { Point3 } from './geometry';

export interface CameraState {
  azimuthDeg: number;
  elevationDeg: number;
  /** scene units (mm) */
  distanceMm: number;
}

export const VIEW_PRESETS = {
  FRONT: { azimuthDeg: 0, elevationDeg: 0, label: '前视' },
  SIDE: { azimuthDeg: 90, elevationDeg: 0, label: '侧视' },
  TOP: { azimuthDeg: 0, elevationDeg: 90, label: '俯视' },
} as const;
export type ViewPresetId = keyof typeof VIEW_PRESETS;

export const DEFAULT_CAMERA: CameraState = { azimuthDeg: 30, elevationDeg: 15, distanceMm: 420 };

export const AZIMUTH_STEP_DEG = 15;
export const ELEVATION_STEP_DEG = 10;
export const ELEVATION_MIN_DEG = -80;
export const ELEVATION_MAX_DEG = 90;
export const ZOOM_FACTOR = 1.15;
export const DISTANCE_MIN_MM = 120;
export const DISTANCE_MAX_MM = 1400;

export function normalizeCamera(c: CameraState): CameraState {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    azimuthDeg: ((c.azimuthDeg % 360) + 360) % 360,
    elevationDeg: clamp(c.elevationDeg, ELEVATION_MIN_DEG, ELEVATION_MAX_DEG),
    distanceMm: clamp(c.distanceMm, DISTANCE_MIN_MM, DISTANCE_MAX_MM),
  };
}

export function rotate(c: CameraState, dAzimuthDeg: number, dElevationDeg: number): CameraState {
  return normalizeCamera({
    azimuthDeg: c.azimuthDeg + dAzimuthDeg,
    elevationDeg: c.elevationDeg + dElevationDeg,
    distanceMm: c.distanceMm,
  });
}

export function zoom(c: CameraState, factor: number): CameraState {
  return normalizeCamera({ ...c, distanceMm: c.distanceMm / factor });
}

export function applyPreset(c: CameraState, preset: ViewPresetId): CameraState {
  return normalizeCamera({ ...VIEW_PRESETS[preset], distanceMm: c.distanceMm });
}

export function resetView(): CameraState {
  return { ...DEFAULT_CAMERA };
}

/**
 * Orthographic-ish projection of a model-space point (mm, Y-up, seam at +X)
 * to a 2D view plane, using azimuth (around Y) and elevation (tilt).
 * Screen x right, screen y up. Used by the SVG expression; the WebGL2
 * expression renders the same model points through three.js with a matching
 * orbit camera, so both expressions show the same orientation strategy.
 */
export function projectPoint(p: Point3, cam: CameraState, scale = 1): { x: number; y: number } {
  const az = (cam.azimuthDeg * Math.PI) / 180;
  const el = (cam.elevationDeg * Math.PI) / 180;
  // rotate around Y by -azimuth
  const x1 = p.x * Math.cos(az) + p.z * Math.sin(az);
  const z1 = -p.x * Math.sin(az) + p.z * Math.cos(az);
  // tilt by elevation: screen-y = y·cos(el) - z·sin(el); depth uses the rest
  const y2 = p.y * Math.cos(el) - z1 * Math.sin(el);
  return { x: x1 * scale, y: y2 * scale };
}

/** Perspective-free "looks the same as" helper for tests: same camera => same projection. */
export function cameraEquals(a: CameraState, b: CameraState): boolean {
  return (
    Math.abs(a.azimuthDeg - b.azimuthDeg) < 1e-9 &&
    Math.abs(a.elevationDeg - b.elevationDeg) < 1e-9 &&
    Math.abs(a.distanceMm - b.distanceMm) < 1e-9
  );
}
