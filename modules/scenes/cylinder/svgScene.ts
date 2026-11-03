/**
 * SVG/DOM equivalent expression for rondo.cylinder@1.
 *
 * Not a screenshot: every learning-relevant control lives in the DOM around
 * this scene; the SVG draws the same PublicSceneState and the same unroll
 * parameterization as the WEBGL2 expression, with the same edge markers,
 * section display and dimension-label visibility (SCENE-CONTRACTS §1/§6).
 *
 * Book ("可交互立体学习书") visual language, per REFERENCE-BRIEF §2/§5.4 — the
 * SAME paper-token ink-line set as apps/web/src/styles.css and the WEBGL2
 * scene: warm paper ground, flat two-tone fills (card/chip), ink outlines
 * (≈1.5px), steel-pen-blue annotations, brick-red section accents, hairline
 * plate frame. No gradients, no filters, no PBR-look shading.
 *
 * Pure string builder — headless testable (leak scans assert that hidden
 * materials never appear in the markup).
 */
import {
  computeUnrollGeometry,
  computeSectionShape,
  layerThicknessCmDisplay,
  mmToCmDisplay,
  netEdgeAnchors,
  sectionLabel,
} from './geometry';
import type { CylinderStateV1, CylinderStateV2 } from '../../contracts/public/scene';

export interface SvgDisplayOptions {
  /** dimension labels visible (each individually gated by the caller) */
  showRadius: boolean;
  showDiameter: boolean;
  showHeight: boolean;
  /** net-edge number markers visible (givens per L2 visibility ruling) */
  showEdgeMarkers: boolean;
  /** strip presentation orientation (expression choice, never renumbers edges) */
  stripOrientation: 'HORIZONTAL' | 'VERTICAL';
  /** unconfirmed draft badge text, e.g. "未确认"；empty = confirmed */
  unrollBadge: string;
  /** L3: render confirmed face selection as highlight + text (not color-only) */
  showFaceSelection?: boolean;
  width: number;
  height: number;
}

export interface SvgSceneResult {
  markup: string;
  ariaLabel: string;
}

/** Paper palette — mirror of the CSS tokens (styles.css) and the 3D scene. */
const PAPER = '#f6f0e3';
const CARD_FILL = '#fbf8f0';
const CHIP_FILL = '#efe7d6';
const INK = '#1c2433';
const RULE2 = '#b8ad97';
const ACCENT = '#9a3b2a';
const PEN = '#273463';
const SHADOW = '#d9cfba';
/** two-tone light language — same pair as webglScene SIDE_LIT/SIDE_SHADE */
const SIDE_LIT_FILL = '#fbf8f0';
const SIDE_SHADE_FILL = '#e6daba';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderCylinderSvg(state: CylinderStateV1, opts: SvgDisplayOptions): SvgSceneResult {
  const geo = computeUnrollGeometry(state);
  const r = state.radiusMm;
  const h = state.heightMm;
  const stripL = geo.flatStripLengthMm;

  // layout (mm units in model space): the cylinder block on top, the unrolled
  // strip BELOW it (net presentation — the same parametric anchors, laid out
  // like a textbook net so the wide ensemble fills the portrait page instead
  // of shrinking to a thin letterboxed band); vertical presentation keeps the
  // strip above (portrait expression for stranger/delayed tasks)
  const gapMm = Math.max(12, r * 0.6);
  const horizontal = opts.stripOrientation === 'HORIZONTAL';
  const totalW = horizontal ? Math.max(2 * r, stripL) : Math.max(2 * r, stripL);
  const totalH = horizontal ? h + gapMm + h : h + gapMm + stripL;
  const pad = 36; // breathing room for labels (full-bleed page, no plate frame)
  const scale = Math.min((opts.width - 2 * pad) / Math.max(totalW, 1), (opts.height - 2 * pad) / Math.max(totalH, 1));
  const originX = pad + (opts.width - 2 * pad - totalW * scale) / 2;
  // nudge down a touch: the bottom-only label band otherwise parks the figure high
  const originY = pad + (opts.height - 2 * pad - totalH * scale) / 2 + 6;

  const X = (mm: number) => (originX + mm * scale).toFixed(1);
  const Y = (mm: number) => (originY + mm * scale).toFixed(1);
  const parts: string[] = [];

  // --- paper ground only: the right page IS the plate (full-bleed, no box
  //     frame — the page edge/spine/space live in the book layout around it) ---
  parts.push(`<rect x="0" y="0" width="${opts.width}" height="${opts.height}" fill="${PAPER}"/>`);

  // --- cylinder body (side silhouette; azimuth rotation never changes a
  // cylinder's side silhouette — that invariance is itself L1 content) ---
  const cylX = 0;
  // ground shadows first (behind the body): contact ellipse + cast ellipse
  // toward the shade side, matching the 3D scene — flat fills, the only
  // "light" in this ink drawing, so the model SITS on the page
  parts.push(
    `<ellipse cx="${(originX + (cylX + r) * scale + r * scale * 0.34).toFixed(1)}" cy="${Y(h + r * 0.1)}" rx="${(r * scale * 0.82).toFixed(1)}" ry="${Math.max(2.5, r * scale * 0.2).toFixed(1)}" fill="${SHADOW}" fill-opacity="0.42"/>`,
  );
  parts.push(
    `<ellipse cx="${X(cylX + r)}" cy="${Y(h)}" rx="${(r * scale * 1.14).toFixed(1)}" ry="${Math.max(2.5, r * scale * 0.22).toFixed(1)}" fill="${SHADOW}" fill-opacity="0.6"/>`,
  );
  // two-tone shading (lit left / shade right — the same pair as the 3D scene):
  // two flat tone blocks under one ink silhouette
  parts.push(`<rect x="${X(cylX + r)}" y="${Y(0)}" width="${(r * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}" fill="${SIDE_SHADE_FILL}"/>`);
  parts.push(`<rect x="${X(cylX)}" y="${Y(0)}" width="${(r * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}" fill="${SIDE_LIT_FILL}"/>`);
  parts.push(
    `<rect x="${X(cylX)}" y="${Y(0)}" width="${(2 * r * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}" fill="none" stroke="${INK}" stroke-width="2"/>`,
  );
  // top/bottom base outlines (same geometry as before the re-paint:
  // solid base ellipse at Y(h), hidden-edge dashed arc at Y(0))
  parts.push(
    `<ellipse cx="${X(cylX + r)}" cy="${Y(h)}" rx="${(r * scale).toFixed(1)}" ry="${Math.max(3, r * scale * 0.28).toFixed(1)}" fill="${CARD_FILL}" stroke="${INK}" stroke-width="2"/>`,
  );
  parts.push(
    `<path d="M ${X(cylX)} ${Y(0)} a ${(r * scale).toFixed(1)} ${Math.max(3, r * scale * 0.28).toFixed(1)} 0 0 0 ${(2 * r * scale).toFixed(1)} 0" fill="none" stroke="${RULE2}" stroke-width="1" stroke-dasharray="5 4"/>`,
  );
  // seam line at the right edge of the silhouette (angle 0 / seam origin)
  parts.push(
    `<line x1="${X(cylX + 2 * r)}" y1="${Y(0)}" x2="${X(cylX + 2 * r)}" y2="${Y(h)}" stroke="${PEN}" stroke-width="1" stroke-dasharray="4 3"/>`,
  );
  // rolled remainder on the bottom base: arc from seam backward by remaining angle
  const remain = 1 - geo.unrollFraction;
  if (remain > 0.001 && remain < 0.999) {
    const rx = r * scale;
    const ry = Math.max(3, r * scale * 0.28);
    const cx = originX + (cylX + r) * scale;
    const cy = originY + h * scale;
    parts.push(
      `<path d="M ${cx.toFixed(1)} ${cy.toFixed(1)} L ${(cx + rx).toFixed(1)} ${cy.toFixed(1)} A ${rx.toFixed(1)} ${ry.toFixed(1)} 0 ${remain > 0.5 ? 1 : 0} 0 ${(
        cx + rx * Math.cos(-2 * Math.PI * remain)
      ).toFixed(1)} ${(cy + ry * Math.sin(-2 * Math.PI * remain)).toFixed(1)} Z" fill="rgba(28,36,51,0.12)" stroke="${INK}" stroke-width="1"/>`,
    );
  }

  // --- flat strip ---
  const stripRect =
    horizontal ?
      { x: 0, y: h + gapMm, w: stripL, h: h } // net presentation: strip below the cylinder
    : { x: 0, y: h + gapMm, w: h, h: stripL }; // vertical presentation: swap roles
  // strip ground shadow: flat fill offset to the shade side (same language as
  // the 3D stripShadow) — drawn first so the strip sits on top of it
  if (stripL > 0.002) {
    parts.push(
      `<rect x="${(originX + stripRect.x * scale + 3).toFixed(1)}" y="${(originY + stripRect.y * scale + 3.5).toFixed(1)}" width="${(stripRect.w * scale).toFixed(1)}" height="${(stripRect.h * scale).toFixed(1)}" fill="${SHADOW}" fill-opacity="0.45"/>`,
    );
  }
  parts.push(
    `<rect x="${X(stripRect.x)}" y="${Y(stripRect.y)}" width="${(stripRect.w * scale).toFixed(1)}" height="${(stripRect.h * scale).toFixed(1)}" fill="${CHIP_FILL}" stroke="${INK}" stroke-width="2"/>`,
  );
  // strip two-tone: a hairline half (flat "fold" tone along the strip's length)
  if (stripL > 0.002) {
    if (horizontal) {
      parts.push(
        `<line x1="${X(stripRect.x)}" y1="${Y(stripRect.y + stripRect.h / 2)}" x2="${X(stripRect.x + stripRect.w)}" y2="${Y(stripRect.y + stripRect.h / 2)}" stroke="${RULE2}" stroke-width="0.75"/>`,
      );
    } else {
      parts.push(
        `<line x1="${X(stripRect.x + stripRect.w / 2)}" y1="${Y(stripRect.y)}" x2="${X(stripRect.x + stripRect.w / 2)}" y2="${Y(stripRect.y + stripRect.h)}" stroke="${RULE2}" stroke-width="0.75"/>`,
      );
    }
  }

  // --- section display (text + shape channel) ---
  const sec = computeSectionShape(state);
  if (sec.kind === 'circle') {
    parts.push(
      `<ellipse cx="${X(cylX + r)}" cy="${Y(h / 2)}" rx="${(r * scale).toFixed(1)}" ry="${Math.max(3, r * scale * 0.5).toFixed(1)}" fill="rgba(154,59,42,0.18)" stroke="${ACCENT}" stroke-width="2"/>`,
    );
  } else if (sec.kind === 'rectangle') {
    parts.push(
      `<rect x="${X(cylX + r - state.radiusMm)}" y="${Y(0)}" width="${(2 * r * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}" fill="rgba(154,59,42,0.14)" stroke="${ACCENT}" stroke-width="2" stroke-dasharray="6 3"/>`,
    );
  }

  // --- dimension labels (gated; values only from confirmed state) ---
  const labels: Array<[string, string, string, string]> = [];
  if (opts.showRadius) {
    labels.push(['r', X(cylX + r), Y(h + 14), `r = ${mmToCmDisplay(r)} cm`]);
  }
  if (opts.showDiameter) {
    labels.push(['d', X(cylX + r), Y(h + 32), `d = ${mmToCmDisplay(2 * r)} cm`]);
  }
  if (opts.showHeight) {
    labels.push(['h', X(Math.max(-30, cylX - 26)), Y(h / 2), `h = ${mmToCmDisplay(h)} cm`]);
  }
  for (const [key, x, y, text] of labels) {
    parts.push(
      `<text x="${x}" y="${y}" font-size="12.5" fill="${PEN}" data-dim="${esc(key)}">${esc(text)}</text>`,
    );
  }

  // --- L3: confirmed face selection — highlight + text (never color-only) ---
  if (opts.showFaceSelection) {
    const sel = new Set(state.selectedFaceIds);
    if (sel.has('cyl-face-side')) {
      parts.push(
        `<rect x="${X(cylX)}" y="${Y(0)}" width="${(2 * r * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}" fill="rgba(64,145,108,0.22)" stroke="#2e7d54" stroke-width="2.5" data-face="cyl-face-side"/>` +
          `<text x="${X(cylX + r)}" y="${Y(h / 2)}" font-size="11.5" text-anchor="middle" fill="#1c5c3c">侧面 · 已选入纸样</text>`,
      );
    }
    if (sel.has('cyl-face-upper')) {
      parts.push(
        `<ellipse cx="${X(cylX + r)}" cy="${Y(h)}" rx="${(r * scale).toFixed(1)}" ry="${Math.max(3, r * scale * 0.28).toFixed(1)}" fill="rgba(64,145,108,0.4)" stroke="#2e7d54" stroke-width="2.5" data-face="cyl-face-upper"/>` +
          `<text x="${X(cylX + r)}" y="${(originY + h * scale - 6).toFixed(1)}" font-size="10.5" text-anchor="middle" fill="#1c5c3c">上盖面 · 已选入</text>`,
      );
    }
    if (sel.has('cyl-face-lower')) {
      parts.push(
        `<path d="M ${X(cylX)} ${Y(0)} a ${(r * scale).toFixed(1)} ${Math.max(3, r * scale * 0.28).toFixed(1)} 0 0 0 ${(2 * r * scale).toFixed(1)} 0" fill="rgba(64,145,108,0.4)" stroke="#2e7d54" stroke-width="2.5" data-face="cyl-face-lower"/>` +
          `<text x="${X(cylX + r)}" y="${(originY + Math.max(3, r * scale * 0.28) + 12).toFixed(1)}" font-size="10.5" text-anchor="middle" fill="#1c5c3c">下盖面 · 已选入</text>`,
      );
    }
  }

  // --- net edge markers, anchored by unroll parameterization ---
  if (opts.showEdgeMarkers) {
    const anchors = netEdgeAnchors(geo);
    for (const [edgeId, p] of Object.entries(anchors)) {
      let mx: number;
      let my: number;
      if (horizontal) {
        // model strip coords (x: r..r+L unroll length, y: 0..h parametric) map
        // straight onto the horizontal strip rect
        mx = stripRect.x + Math.min(Math.max(p.x - r, 0), stripRect.w);
        my = stripRect.y + p.y;
      } else {
        // vertical presentation: the parametric y axis (0..h) maps to the
        // horizontal side of the rect and the unroll-length axis maps to the
        // vertical side — markers keep their parametric edge, not screen looks
        mx = stripRect.x + p.y;
        my = stripRect.y + Math.min(Math.max(p.x - r, 0), stripRect.h);
      }
      const n = edgeId.slice(-1);
      parts.push(
        `<g data-edge="${esc(edgeId)}"><circle cx="${(originX + mx * scale).toFixed(1)}" cy="${(originY + my * scale).toFixed(1)}" r="9" fill="#ffffff" stroke="${ACCENT}" stroke-width="1.5"/><text x="${(originX + mx * scale).toFixed(1)}" y="${(originY + my * scale + 3.5).toFixed(1)}" font-size="11" text-anchor="middle" fill="${PEN}">${n}</text></g>`,
      );
    }
  }

  const unrollPct = (state.unrollPermille / 10).toFixed(0);
  const badge = opts.unrollBadge ? `（${esc(opts.unrollBadge)}）` : '';
  const aria = `平面图表达。半径${opts.showRadius ? ' ' + mmToCmDisplay(r) + ' 厘米' : '隐藏'}；高度${
    opts.showHeight ? ' ' + mmToCmDisplay(h) + ' 厘米' : '隐藏'
  }；展开 ${unrollPct}%${badge}。${sectionLabel(state.section)}${
    opts.showFaceSelection && state.selectedFaceIds.length
      ? `已选入纸样：${state.selectedFaceIds.join('、')}。`
      : ''
  }`;

  return {
    markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${opts.width} ${opts.height}" role="img" aria-label="${esc(aria)}" data-expression="SVG_DOM"><g>${parts.join('\n')}</g></svg>`,
    ariaLabel: aria,
  };
}

/**
 * SVG/DOM expression for rondo.cylinder@2 layer tasks (L4): side-view layer
 * stack (rectangles filled up to the CONFIRMED visibleLayerCount — animation
 * frames are ViewState and never drawn here) plus the cross-section circle
 * (each layer's shape). Shared numeric facts (thickness display) come from
 * the same exact-rational helpers the judging side uses. Paper-token ink-line
 * language, same palette as renderCylinderSvg.
 */
export function renderLayersSvg(
  state: CylinderStateV2,
  opts: {
    showRadius: boolean;
    showHeight: boolean;
    width: number;
    height: number;
  },
): SvgSceneResult {
  const r = state.radiusMm;
  const h = state.heightMm;
  const n = state.layerCount;
  const visible = state.visibleLayerCount;
  const thickness = layerThicknessCmDisplay(h, n);

  const gapMm = Math.max(14, r * 0.5);
  const stackW = 2 * r;
  const crossR = r;
  const totalW = stackW + gapMm + 2 * crossR;
  const pad = 46;
  const scale = Math.min((opts.width - 2 * pad) / Math.max(totalW, 1), (opts.height - 2 * pad) / Math.max(h, 1));
  const originX = pad + (opts.width - 2 * pad - totalW * scale) / 2;
  const originY = pad + (opts.height - 2 * pad - h * scale) / 2;
  const X = (mm: number) => (originX + mm * scale).toFixed(1);
  const Y = (mm: number) => (originY + mm * scale).toFixed(1);

  const parts: string[] = [];
  // paper ground (same full-bleed page as the @1 expression)
  parts.push(`<rect x="0" y="0" width="${opts.width}" height="${opts.height}" fill="${PAPER}"/>`);
  // outer can silhouette (ink outline, dashed — the un-sliced can)
  parts.push(
    `<rect x="${X(0)}" y="${Y(0)}" width="${(stackW * scale).toFixed(1)}" height="${(h * scale).toFixed(1)}" fill="none" stroke="${INK}" stroke-width="2" stroke-dasharray="7 4"/>`,
  );
  // layer rectangles, bottom-up; only layers k <= visible are filled
  const layerH = h / n;
  for (let k = 1; k <= n; k += 1) {
    const yTop = h - k * layerH;
    const filled = k <= visible;
    parts.push(
      `<rect x="${X(0)}" y="${Y(yTop)}" width="${(stackW * scale).toFixed(1)}" height="${Math.max(0.8, layerH * scale).toFixed(1)}" fill="${filled ? CHIP_FILL : CARD_FILL}" fill-opacity="${filled ? 0.95 : 0.55}" stroke="${INK}" stroke-width="1" data-layer="${k}" data-layer-filled="${filled ? '1' : '0'}"/>`,
    );
  }
  // cross-section circle (shape of each layer) to the right
  const cx = stackW + gapMm + crossR;
  parts.push(
    `<ellipse cx="${X(cx)}" cy="${Y(h / 2)}" rx="${(crossR * scale).toFixed(1)}" ry="${(crossR * scale).toFixed(1)}" fill="rgba(39,52,99,0.14)" stroke="${INK}" stroke-width="1.5"/>`,
  );
  // labels: values only from confirmed state
  const labels: string[] = [];
  if (opts.showRadius) labels.push(`r = ${mmToCmDisplay(r)} cm`);
  if (opts.showHeight) labels.push(`h = ${mmToCmDisplay(h)} cm`);
  labels.push(`层数 n = ${n}；层厚 ${thickness.text} cm`);
  labels.push(`已装 ${visible} 层`);
  parts.push(
    `<text x="${X(0)}" y="${(originY + h * scale + 16).toFixed(1)}" font-size="12" fill="${PEN}">${esc(labels.join(' · '))}</text>`,
  );

  const aria = `平面图表达（层叠）。${labels.join('；')}。层数改变不改变总体积。`;
  return {
    markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${opts.width} ${opts.height}" role="img" aria-label="${esc(aria)}" data-expression="SVG_DOM"><g>${parts.join('\n')}</g></svg>`,
    ariaLabel: aria,
  };
}
