/**
 * Pure cylinder scene geometry — shared by both expressions (WEBGL2/SVG_DOM).
 *
 * Frozen sources:
 * - SCENE-CONTRACTS §2: integer mm domain; graphics draw the true
 *   parametric circle (Math.PI for rendering only — DOMAIN arithmetic uses
 *   pi = 157/50 and lives in the private rules/mock evaluator, never here);
 *   unrollPermille 0..1000 integer, intermediate frames are ViewState.
 * - SCENE-CONTRACTS §4 / conventions §4: net edges anchored by unroll
 *   parameterization, never by screen orientation:
 *     net-edge-1 = start seam vertical edge (y from 0..h at unroll origin)
 *     net-edge-2 = top parametric edge (y = h, from top circle)
 *     net-edge-3 = end seam vertical edge (same seam, wound once)
 *     net-edge-4 = bottom parametric edge (y = 0, from bottom circle)
 *
 * No DOM, no three.js, no Node imports: testable headless.
 */
import type { CylinderStateV1, CylinderSection } from '../../contracts/public/scene';

/** pi = 157/50 = 3.14 exact — the domain numeric contract (rules.ts). */
export const PI_NUMERATOR = 157;
export const PI_DENOMINATOR = 50;

/** Circumference in mm as an exact rational (numerator/denominator), pi = 157/50. */
export function circumferenceRationalMm(radiusMm: number): { numerator: number; denominator: number } {
  return { numerator: 2 * PI_NUMERATOR * radiusMm, denominator: PI_DENOMINATOR };
}

/** Exact decimal string of a rational with the given decimal places, HALF_UP. */
export function rationalToDecimal(
  r: { numerator: number; denominator: number },
  decimalPlaces: number,
): string {
  const sign = r.numerator < 0 ? -1 : 1;
  const num = Math.abs(r.numerator);
  const pow = 10 ** decimalPlaces;
  const scaled = num * pow;
  const q = Math.floor(scaled / r.denominator);
  const rem = scaled % r.denominator;
  let quotient = q;
  if (rem * 2 >= r.denominator) quotient += 1; // HALF_UP on the exact rational
  const intPart = Math.trunc(quotient / pow) * sign;
  const fracPart = quotient % pow;
  const fracStr = decimalPlaces === 0 ? '' : '.' + String(fracPart).padStart(decimalPlaces, '0');
  const out = `${intPart}${fracStr}`;
  return out.startsWith('-') && Number(out) === 0 ? out.slice(1) : out;
}

/** Lateral area in cm² as exact rational: 2·(157/50)·r_mm·h_mm / 100. */
export function lateralAreaRationalCm2(
  radiusMm: number,
  heightMm: number,
): { numerator: number; denominator: number } {
  return {
    numerator: 2 * PI_NUMERATOR * radiusMm * heightMm,
    denominator: PI_DENOMINATOR * 100,
  };
}

/** Circle/base-face area in cm² as exact rational: (157/50)·r_mm² / 100 (L3/L4, πr²). */
export function circleAreaRationalCm2(radiusMm: number): { numerator: number; denominator: number } {
  return {
    numerator: PI_NUMERATOR * radiusMm * radiusMm,
    denominator: PI_DENOMINATOR * 100,
  };
}

/** Volume in cm³ as exact rational: (157/50)·r_mm²·h_mm / 1000 (L4, V = πr²h). */
export function volumeRationalCm3(
  radiusMm: number,
  heightMm: number,
): { numerator: number; denominator: number } {
  return {
    numerator: PI_NUMERATOR * radiusMm * radiusMm * heightMm,
    denominator: PI_DENOMINATOR * 1000,
  };
}

/**
 * Layer thickness = heightMm ÷ layerCount, exact rational in mm — the DERIVED
 * value, never stored in state (L34-5). Display uses cm with one decimal; a
 * non-integer-mm thickness cannot be shown exactly at one decimal and is
 * marked 约 (approximate); judging never reads the display value.
 */
export function layerThicknessRationalMm(
  heightMm: number,
  layerCount: number,
): { numerator: number; denominator: number } {
  return { numerator: heightMm, denominator: layerCount };
}

export function layerThicknessCmDisplay(
  heightMm: number,
  layerCount: number,
): { text: string; approximate: boolean } {
  const r = layerThicknessRationalMm(heightMm, layerCount);
  const exactIntegerMm = r.numerator % r.denominator === 0;
  const cm = rationalToDecimal({ numerator: r.numerator, denominator: r.denominator * 10 }, 1);
  return { text: exactIntegerMm ? cm : `约 ${cm}`, approximate: !exactIntegerMm };
}

/**
 * Cumulative-table row k (1-based), exact rationals in cm / cm³:
 * per-layer volume = πr²·(h/n), cumulative through layer k = πr²·h·k/n.
 * Rows exist only up to the CONFIRMED visibleLayerCount (player projection).
 */
export function cumulativeLayerRow(
  radiusMm: number,
  heightMm: number,
  layerCount: number,
  k: number,
): {
  layerIndex: number;
  thicknessCm: { numerator: number; denominator: number };
  layerVolumeCm3: { numerator: number; denominator: number };
  cumulativeCm3: { numerator: number; denominator: number };
} {
  const piR2 = PI_NUMERATOR * radiusMm * radiusMm; // over PI_DENOMINATOR
  const thicknessCm = { numerator: heightMm * 10, denominator: layerCount }; // mm→cm
  const layerVolumeCm3 = { numerator: piR2 * heightMm, denominator: PI_DENOMINATOR * 1000 * layerCount };
  const cumulativeCm3 = { numerator: piR2 * heightMm * k, denominator: PI_DENOMINATOR * 1000 * layerCount };
  return { layerIndex: k, thicknessCm, layerVolumeCm3, cumulativeCm3 };
}

/** Cumulative volume through layer k, exact rational cm³. */
export function cumulativeVolumeRationalCm3(
  radiusMm: number,
  heightMm: number,
  layerCount: number,
  k: number,
): { numerator: number; denominator: number } {
  return cumulativeLayerRow(radiusMm, heightMm, layerCount, k).cumulativeCm3;
}

/** Diameter in cm as exact rational: 2·r_mm/10. */
export function diameterRationalCm(radiusMm: number): { numerator: number; denominator: number } {
  return { numerator: 2 * radiusMm, denominator: 10 };
}

/** Radius in cm as exact rational. */
export function radiusRationalCm(radiusMm: number): { numerator: number; denominator: number } {
  return { numerator: radiusMm, denominator: 10 };
}

/** Display formatting: cm with one decimal (SCENE-CONTRACTS §2). */
export function mmToCmDisplay(mm: number): string {
  return (mm / 10).toFixed(1);
}

export type Point2 = { x: number; y: number };
export type Point3 = { x: number; y: number; z: number };

/**
 * Unroll decomposition of the side surface, in mm, in a canonical model space:
 * cylinder axis = Y (0..heightMm), bottom circle center at origin.
 * The seam sits at model angle 0 (pointing +X). The surface unrolls from the
 * seam outward in +X direction as a flat strip in the XZ plane at y∈[0,h].
 *
 * rolledEndAngleRad: total circle angle still rolled (graphics use true pi).
 */
export interface UnrollGeometry {
  radiusMm: number;
  heightMm: number;
  /** 0..1 fraction unrolled (unrollPermille / 1000). */
  unrollFraction: number;
  /** Angle of the moving seam edge, radians (0..2π·(1-fraction)). */
  rolledEndAngleRad: number;
  /** Flat strip length in mm (graphics-true: fraction · 2π·r). */
  flatStripLengthMm: number;
  /** Flat strip corners in model space (mm): start bottom, start top, end top, end bottom. */
  strip: { startBottom: Point3; startTop: Point3; endTop: Point3; endBottom: Point3 };
}

export function computeUnrollGeometry(state: CylinderStateV1): UnrollGeometry {
  const r = state.radiusMm;
  const h = state.heightMm;
  const fraction = state.unrollPermille / 1000;
  const fullAngle = 2 * Math.PI;
  const rolledEndAngleRad = fullAngle * (1 - fraction);
  const flatStripLengthMm = fullAngle * r * fraction;
  // The rolled part spans angle [0, rolledEndAngleRad] measured from the seam
  // at angle 0; the flat strip starts at the seam (r, 0, 0)... but when fully
  // rolled, both seam edges coincide at angle 0.
  const strip = {
    startBottom: { x: r, y: 0, z: 0 },
    startTop: { x: r, y: h, z: 0 },
    endTop: { x: r + flatStripLengthMm, y: h, z: 0 },
    endBottom: { x: r + flatStripLengthMm, y: 0, z: 0 },
  };
  return { radiusMm: r, heightMm: h, unrollFraction: fraction, rolledEndAngleRad, flatStripLengthMm, strip };
}

/** Section shape in model space for the current section display mode. */
export type SectionShape =
  | { kind: 'none' }
  | { kind: 'circle'; radiusMm: number; centerYmM: number } // transverse section: disc at mid-height
  | { kind: 'rectangle'; widthMm: number; heightMm: number }; // axial section: 2r × h through the axis

export function computeSectionShape(state: CylinderStateV1): SectionShape {
  if (state.section === 'TRANSVERSE') {
    return { kind: 'circle', radiusMm: state.radiusMm, centerYmM: state.heightMm / 2 };
  }
  if (state.section === 'AXIAL') {
    return { kind: 'rectangle', widthMm: 2 * state.radiusMm, heightMm: state.heightMm };
  }
  return { kind: 'none' };
}

/**
 * Stable anchor points for the four net-edge markers, anchored by unroll
 * parameterization (midpoint of each edge), in model space mm. Edge 1/3 both
 * live on the seam when fully rolled (UI shows them side by side).
 */
export function netEdgeAnchors(geo: UnrollGeometry): Record<string, Point3> {
  const { strip, heightMm } = geo;
  return {
    'net-edge-1': { x: strip.startBottom.x, y: heightMm / 2, z: 0 },
    'net-edge-2': { x: (strip.startTop.x + strip.endTop.x) / 2, y: heightMm, z: 0 },
    'net-edge-3': { x: strip.endBottom.x, y: heightMm / 2, z: 0 },
    'net-edge-4': { x: (strip.startBottom.x + strip.endBottom.x) / 2, y: 0, z: 0 },
  };
}

export const NET_EDGE_IDS = ['net-edge-1', 'net-edge-2', 'net-edge-3', 'net-edge-4'] as const;

/** L3 face object ids (conventions §4, L34-2): neutral, parameter-anchored.
 * 「上/下」指圆柱参数方向（upper=y=h、lower=y=0），不是屏幕方向；哪个面是
 * 「盖」由任务包装条件决定，不由 ID 决定（私有事实，不入公开 ID/aria）。 */
export const CYLINDER_FACE_IDS = ['cyl-face-side', 'cyl-face-upper', 'cyl-face-lower'] as const;
export type CylinderFaceId = (typeof CYLINDER_FACE_IDS)[number];

export const FACE_LABELS: Record<CylinderFaceId, string> = {
  'cyl-face-side': '侧面（裹在罐身外的那圈）',
  'cyl-face-upper': '上盖面（顶上的圆）',
  'cyl-face-lower': '下盖面（底下的圆）',
};

/** Section display names (text channel, not color-only). */
export function sectionLabel(section: CylinderSection): string {
  switch (section) {
    case 'TRANSVERSE':
      return '当前切面：横截面（垂直于轴切开，是圆）';
    case 'AXIAL':
      return '当前切面：轴截面（沿轴切开，是矩形）';
    default:
      return '当前切面：不显示';
  }
}

/** Dimension labels available for display; visibility is applied by the caller. */
export interface DimensionLabels {
  radiusMm: number;
  diameterMm: number;
  heightMm: number;
}

export function dimensionLabels(state: CylinderStateV1): DimensionLabels {
  return {
    radiusMm: state.radiusMm,
    diameterMm: 2 * state.radiusMm,
    heightMm: state.heightMm,
  };
}
