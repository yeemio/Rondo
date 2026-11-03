/**
 * Scene tests: geometry/domain-math invariants, ViewState boundary, the
 * controller's draft/confirm/context-loss contract, SVG no-leak rendering,
 * keyboard equivalence declarations, and renderer registration.
 * Headless: no DOM, no WebGL — pure modules only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  circumferenceRationalMm,
  lateralAreaRationalCm2,
  rationalToDecimal,
  computeUnrollGeometry,
  netEdgeAnchors,
  mmToCmDisplay,
  circleAreaRationalCm2,
  volumeRationalCm3,
  layerThicknessCmDisplay,
  layerThicknessRationalMm,
  cumulativeLayerRow,
} from '../../modules/scenes/cylinder/geometry';
import { rotate, zoom, applyPreset, resetView, normalizeCamera, DEFAULT_CAMERA } from '../../modules/scenes/cylinder/view';
import { SceneController, overlayOperation, type SceneRenderer, type ExpressionMode } from '../../modules/scenes/cylinder/controller';
import { renderCylinderSvg, renderLayersSvg } from '../../modules/scenes/cylinder/svgScene';
import { CYLINDER_KEYBOARD_COMMAND_MAP, isSceneKeyEvent, isViewControlKey } from '../../modules/scenes/cylinder/keyboard';
import {
  keyboardCommandMapSchema,
  cylinderStateV2Schema,
  safeParseCylinderOperationV1,
  safeParseCylinderOperationV2,
  safeParseCylinderStateV2,
  sceneStateSchemaForContractVersion,
  safeParseSceneStateForVersion,
} from '../../modules/contracts/public/scene';
import { lookupScene, allSceneRegistrations } from '../../modules/scenes';

const state = (r: number, h: number, unroll = 0, section: 'NONE' | 'TRANSVERSE' | 'AXIAL' = 'NONE') => ({
  radiusMm: r,
  heightMm: h,
  unrollPermille: unroll,
  section,
  selectedFaceIds: [],
});
const layerState = (r: number, h: number, n: number, visible: number) => ({
  ...state(r, h),
  layerCount: n,
  visibleLayerCount: visible,
});

test('scenes: exact-π domain math (157/50), no float tolerance', () => {
  const cm = (mm: { numerator: number; denominator: number }) => ({ numerator: mm.numerator, denominator: mm.denominator * 10 });
  assert.equal(rationalToDecimal(cm(circumferenceRationalMm(30)), 2), '18.84'); // guided 2×3.14×3.0
  assert.equal(rationalToDecimal(cm(circumferenceRationalMm(5)), 2), '3.14'); // tall-thin
  assert.equal(rationalToDecimal(lateralAreaRationalCm2(30, 80), 2), '150.72');
  assert.equal(rationalToDecimal(lateralAreaRationalCm2(15, 90), 2), '84.78'); // S1
  assert.equal(rationalToDecimal(lateralAreaRationalCm2(25, 100), 2), '157.00'); // I3
  // HALF_UP on exact rationals: 2.345 -> 2.35
  assert.equal(rationalToDecimal({ numerator: 2345, denominator: 1000 }, 2), '2.35');
  assert.equal(rationalToDecimal({ numerator: 469, denominator: 200 }, 2), '2.35');
  assert.equal(mmToCmDisplay(35), '3.5');
});

test('scenes: tall-thin counter-example geometry — C(3.14cm) < h(12.0cm)', () => {
  const geo = computeUnrollGeometry(state(5, 120, 1000));
  const cCm = rationalToDecimal({ ...circumferenceRationalMm(5), denominator: circumferenceRationalMm(5).denominator * 10 }, 2);
  assert.equal(cCm, '3.14');
  assert.ok(Number(cCm) < 12.0, 'circumference edge must be SHORTER than height edge at r=0.5/h=12.0');
  // full unroll: flat strip length (graphics-true π) ≈ circumference
  assert.ok(Math.abs(geo.flatStripLengthMm / 10 - 3.14) < 0.01);
});

test('scenes: net edges anchored by unroll parameterization, not screen looks', () => {
  const rolled = netEdgeAnchors(computeUnrollGeometry(state(30, 80, 0)));
  const unrolled = netEdgeAnchors(computeUnrollGeometry(state(30, 80, 1000)));
  // rolled: edges 1 and 3 coincide on the seam; edges 2/4 sit on the parametric top/bottom
  assert.equal(rolled['net-edge-1'].x, rolled['net-edge-3'].x);
  assert.equal(unrolled['net-edge-3'].x - unrolled['net-edge-1'].x > 0, true);
  assert.equal(unrolled['net-edge-2'].y, 80);
  assert.equal(unrolled['net-edge-4'].y, 0);
});

test('scenes: ViewState math clamps and presets; never touches domain state', () => {
  const cam = normalizeCamera({ azimuthDeg: 350, elevationDeg: 95, distanceMm: 99 });
  assert.equal(cam.azimuthDeg, 350);
  assert.equal(cam.elevationDeg, 90);
  assert.equal(cam.distanceMm, 120, 'distance clamps at the minimum');
  const zoomedIn = zoom(cam, 2);
  assert.equal(zoomedIn.distanceMm, 120, 'zoom-in cannot push past the clamp');
  const zoomedOut = zoom(cam, 1 / 4);
  assert.equal(zoomedOut.distanceMm, 480);
  const top = applyPreset(cam, 'TOP');
  assert.equal(top.elevationDeg, 90);
  assert.deepEqual(resetView(), DEFAULT_CAMERA);
});

function recordingRenderer(log: string[]): SceneRenderer {
  let lastMode: ExpressionMode = 'SVG_DOM';
  return {
    render(s, v, m) {
      lastMode = m;
      log.push(`render:${m}:${s.radiusMm}x${s.heightMm}u${s.unrollPermille}s${s.section}@a${Math.round(v.azimuthDeg)}`);
    },
  };
  void lastMode;
}

test('scenes: controller — preview is local, confirm emits exactly one typed op', () => {
  const ops: unknown[] = [];
  const log: string[] = [];
  const controller = new SceneController({
    renderer: recordingRenderer(log),
    initialState: state(30, 80),
    initialMode: 'SVG_DOM',
    onOperation: (op) => ops.push(op),
    onModeChange: () => {},
  });
  controller.rotateView(45, 10); // ViewState only
  controller.zoomView(1.2);
  assert.equal(ops.length, 0, 'camera changes must not emit domain operations');
  assert.equal(controller.getConfirmedState().radiusMm, 30);
  assert.equal(controller.getConfirmedState().heightMm, 80);
  controller.previewOperation({ type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 });
  assert.ok(controller.hasDraft());
  assert.equal(controller.getPreviewState().radiusMm, 40, 'preview overlays the draft');
  assert.equal(controller.getConfirmedState().radiusMm, 30, 'confirm state untouched until Host returns');
  controller.cancelDraft();
  assert.equal(controller.getPreviewState().radiusMm, 30);
  controller.previewOperation({ type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 });
  controller.confirmDraft();
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], { type: 'SetDimension', dimension: 'RADIUS', valueMm: 40 });
  // authoritative projection lands
  controller.applyConfirmedState(state(40, 80));
  assert.equal(controller.getConfirmedState().radiusMm, 40);
  controller.dispose();
});

test('scenes: overlayOperation maps all four typed operations', () => {
  const base = state(30, 80);
  assert.deepEqual(overlayOperation(base, { type: 'SetDimension', dimension: 'HEIGHT', valueMm: 100 }), { ...base, heightMm: 100 });
  assert.deepEqual(overlayOperation(base, { type: 'SetUnroll', valuePermille: 1000 }), { ...base, unrollPermille: 1000 });
  assert.deepEqual(overlayOperation(base, { type: 'SetSection', section: 'AXIAL' }), { ...base, section: 'AXIAL' });
  assert.deepEqual(overlayOperation(base, { type: 'SelectFaces', faceIds: ['f1'] }), { ...base, selectedFaceIds: ['f1'] });
});

test('scenes: context loss keeps confirmed state + draft + focus; restore rebuilds same state', () => {
  const ops: unknown[] = [];
  const modes: string[] = [];
  const log: string[] = [];
  const controller = new SceneController({
    renderer: recordingRenderer(log),
    initialState: state(30, 80),
    initialMode: 'WEBGL2',
    onOperation: (op) => ops.push(op),
    onModeChange: (m, reason) => modes.push(`${m}:${reason}`),
  });
  controller.previewOperation({ type: 'SetUnroll', valuePermille: 500 });
  controller.handleContextLost();
  assert.equal(controller.getMode(), 'SVG_DOM', 'loss switches to SVG_DOM');
  assert.ok(controller.hasDraft(), 'draft survives the loss');
  assert.deepEqual(controller.getDraft(), { type: 'SetUnroll', valuePermille: 500 });
  assert.equal(controller.getConfirmedState().unrollPermille, 0, 'confirmed state survives');
  controller.confirmDraft(); // the SAME single op continues in SVG mode
  assert.equal(ops.length, 1);
  const fresh = recordingRenderer([]);
  controller.handleContextRestored(fresh);
  assert.equal(controller.getMode(), 'WEBGL2');
  assert.equal(controller.getConfirmedState().unrollPermille, 0, 'restore does not rebuild the attempt or resubmit');
  assert.ok(modes.includes('SVG_DOM:context-loss'));
  assert.ok(modes.includes('WEBGL2:context-restored'));
});

test('scenes: SVG rendering — hidden materials never appear (no DOM leak)', () => {
  // L1-I1 assessment style: all dimension labels hidden
  const i1 = renderCylinderSvg(state(45, 120), {
    showRadius: false,
    showDiameter: false,
    showHeight: false,
    showEdgeMarkers: false,
    stripOrientation: 'HORIZONTAL',
    unrollBadge: '',
    width: 640,
    height: 360,
  });
  assert.ok(!i1.markup.includes('data-dim'), 'no dimension labels in markup');
  assert.ok(!i1.markup.includes('4.5') && !i1.markup.includes('12.0'), 'no numeric r/h values leaked');
  assert.ok(i1.ariaLabel.includes('半径隐藏'), 'aria states hiding instead of leaking');
  // L1-I2 style: r/h visible, diameter hidden
  const i2 = renderCylinderSvg(state(20, 70), {
    showRadius: true,
    showDiameter: false,
    showHeight: true,
    showEdgeMarkers: false,
    stripOrientation: 'HORIZONTAL',
    unrollBadge: '',
    width: 640,
    height: 360,
  });
  assert.ok(i2.markup.includes('r = 2.0 cm') && i2.markup.includes('h = 7.0 cm'), 'givens visible');
  assert.ok(!i2.markup.includes('d = 4.0 cm'), 'target diameter value absent');
  // L2 unrolled strip with edge markers
  const l2 = renderCylinderSvg(state(30, 80, 1000), {
    showRadius: true,
    showDiameter: false,
    showHeight: true,
    showEdgeMarkers: true,
    stripOrientation: 'HORIZONTAL',
    unrollBadge: '',
    width: 640,
    height: 360,
  });
  for (const edge of ['net-edge-1', 'net-edge-2', 'net-edge-3', 'net-edge-4']) {
    assert.ok(l2.markup.includes(`data-edge="${edge}"`), `${edge} marker present`);
  }
  // vertical presentation keeps the same marker ids (orientation is expression-only)
  const vertical = renderCylinderSvg(state(15, 90, 1000), {
    showRadius: false,
    showDiameter: false,
    showHeight: false,
    showEdgeMarkers: true,
    stripOrientation: 'VERTICAL',
    unrollBadge: '',
    width: 640,
    height: 360,
  });
  for (const edge of ['net-edge-1', 'net-edge-2', 'net-edge-3', 'net-edge-4']) {
    assert.ok(vertical.markup.includes(`data-edge="${edge}"`), `${edge} marker kept under vertical presentation`);
  }
});

test('scenes: keyboard map parses against the frozen schema; inputs not hijacked', () => {
  keyboardCommandMapSchema.parse(CYLINDER_KEYBOARD_COMMAND_MAP);
  for (const opId of ['SetDimension', 'SetUnroll', 'SetSection', 'SelectFaces', 'SetLayerCount', 'SetVisibleLayerCount']) {
    assert.ok(
      CYLINDER_KEYBOARD_COMMAND_MAP.some((e) => e.operationId === opId),
      `${opId} must have a declared keyboard entry`,
    );
  }
  assert.ok(isViewControlKey('ArrowLeft') && isViewControlKey('f') && !isViewControlKey('x'));
  // events from form controls keep native behavior
  const fromInput = isSceneKeyEvent({ target: { tagName: 'INPUT' } as never, defaultPrevented: false });
  const fromSlider = isSceneKeyEvent({ target: { tagName: 'input' } as never, defaultPrevented: false });
  const fromScene = isSceneKeyEvent({ target: { tagName: 'DIV' } as never, defaultPrevented: false });
  assert.equal(fromInput, false);
  assert.equal(fromSlider, false);
  assert.equal(fromScene, true);
});

test('scenes: renderer registry — rondo.cylinder@1 and @2 registered; unknown rejected', () => {
  const reg1 = lookupScene('rondo.cylinder', '1');
  assert.ok(reg1);
  const reg2 = lookupScene('rondo.cylinder', '2');
  assert.ok(reg2, 'rondo.cylinder@2 must be registered (L34-1)');
  assert.equal(lookupScene('rondo.cylinder', '3'), null, 'unknown version must be rejected, not guessed');
  assert.equal(lookupScene('rondo.cube', '1'), null, 'unknown renderer must be rejected');
  assert.equal(allSceneRegistrations().length, 2);
  assert.deepEqual([...reg1!.expressions], ['WEBGL2', 'SVG_DOM']);
  assert.deepEqual([...reg2!.expressions], ['WEBGL2', 'SVG_DOM']);
  // @1: SelectFaces is a frozen V1 op (L3 ships on @1, L34-2); layer ops never
  assert.ok(reg1!.descriptor.allowedOperations.includes('SelectFaces'));
  for (const layerOp of ['SetLayerCount', 'SetVisibleLayerCount']) {
    assert.ok(!reg1!.descriptor.allowedOperations.includes(layerOp), `@1 must not register ${layerOp}`);
    assert.ok(reg2!.descriptor.allowedOperations.includes(layerOp), `@2 must register ${layerOp}`);
  }
  assert.equal(reg2!.descriptor.publicStateSchemaVersion, '2');
});

test('scenes: V2 schema — layer pair roundtrip, bounds, and version rejection matrix', () => {
  // roundtrip
  const s = cylinderStateV2Schema.parse(layerState(30, 80, 8, 3));
  assert.equal(s.layerCount, 8);
  assert.equal(s.visibleLayerCount, 3);
  // bounds: visible > layer rejected; layerCount > 40 rejected
  assert.equal(safeParseCylinderStateV2(layerState(30, 80, 8, 9)).success, false);
  assert.equal(safeParseCylinderStateV2(layerState(30, 80, 41, 1)).success, false);
  // V2 ops parse under the V2 union (both layer members + inherited V1 four)
  assert.equal(safeParseCylinderOperationV2({ type: 'SetLayerCount', value: 16 }).success, true);
  assert.equal(safeParseCylinderOperationV2({ type: 'SetVisibleLayerCount', value: 0 }).success, true);
  assert.equal(safeParseCylinderOperationV2({ type: 'SetVisibleLayerCount', value: -1 }).success, false);
  assert.equal(safeParseCylinderOperationV2({ type: 'SelectFaces', faceIds: ['cyl-face-side'] }).success, true);
  // REJECTION: the frozen V1 operation schema refuses V2-only members —
  // an @1 task can never accept a layer operation at the syntax layer
  assert.equal(safeParseCylinderOperationV1({ type: 'SetLayerCount', value: 16 }).success, false);
  assert.equal(safeParseCylinderOperationV1({ type: 'SetVisibleLayerCount', value: 3 }).success, false);
  // version-discriminating helper: unknown version → null; V2 state under @1 → fail
  assert.equal(sceneStateSchemaForContractVersion('3'), null);
  assert.equal(sceneStateSchemaForContractVersion('nope'), null);
  const v2UnderV1 = safeParseSceneStateForVersion('1', layerState(30, 80, 8, 3));
  assert.equal(v2UnderV1!.success, false, 'a V2 state must not parse under the @1 descriptor');
  const v2UnderV2 = safeParseSceneStateForVersion('2', layerState(30, 80, 8, 3));
  assert.equal(v2UnderV2!.success, true);
  const v1UnderV2 = safeParseSceneStateForVersion('2', state(30, 80));
  assert.equal(v1UnderV2!.success, false, 'a V1 state must not parse under the @2 descriptor');
});

test('scenes: layer math — derived thickness, cumulative rows, volume invariance (exact rationals)', () => {
  // L34-5: thickness is derived; integer-mm thickness displays exactly, else 约
  const t8 = layerThicknessCmDisplay(80, 8);
  assert.equal(t8.text, '1.0');
  assert.equal(t8.approximate, false);
  const t16 = layerThicknessCmDisplay(80, 16);
  assert.equal(t16.text, '0.5');
  assert.equal(t16.approximate, false);
  const t13 = layerThicknessCmDisplay(65, 13); // D1: 5mm layers
  assert.equal(t13.text, '0.5');
  const t7 = layerThicknessCmDisplay(70, 7);
  assert.equal(t7.text, '1.0');
  assert.equal(rationalToDecimal(layerThicknessRationalMm(65, 13), 1), '5.0'); // mm
  // per-layer / cumulative exactness at the guided example (28.26 per layer)
  const row3 = cumulativeLayerRow(30, 80, 8, 3);
  assert.equal(rationalToDecimal(row3.layerVolumeCm3, 2), '28.26');
  assert.equal(rationalToDecimal(row3.cumulativeCm3, 2), '84.78');
  const row8 = cumulativeLayerRow(30, 80, 8, 8);
  assert.equal(rationalToDecimal(row8.cumulativeCm3, 2), '226.08');
  // invariance: 8 layers vs 16 layers, same total; per-layer halves
  const row16 = cumulativeLayerRow(30, 80, 16, 16);
  assert.equal(rationalToDecimal(row16.layerVolumeCm3, 2), '14.13');
  assert.equal(rationalToDecimal(row16.cumulativeCm3, 2), '226.08');
  // circle area / volume helpers
  assert.equal(rationalToDecimal(circleAreaRationalCm2(30), 2), '28.26');
  assert.equal(rationalToDecimal(circleAreaRationalCm2(50), 2), '78.50');
  assert.equal(rationalToDecimal(volumeRationalCm3(30, 80), 2), '226.08');
  assert.equal(rationalToDecimal(volumeRationalCm3(50, 60), 2), '471.00');
});

test('scenes: overlayOperation covers V2 layer ops (controller draft path)', () => {
  const base = layerState(30, 80, 8, 3);
  assert.deepEqual(overlayOperation(base, { type: 'SetLayerCount', value: 16 }), { ...base, layerCount: 16, visibleLayerCount: 3 });
  assert.deepEqual(overlayOperation(base, { type: 'SetVisibleLayerCount', value: 8 }), { ...base, visibleLayerCount: 8 });
  // clamp on shrink: reducing layers clamps visible
  assert.deepEqual(overlayOperation({ ...base, visibleLayerCount: 8 }, { type: 'SetLayerCount', value: 4 }), {
    ...base,
    layerCount: 4,
    visibleLayerCount: 4,
  });
});

test('scenes: layers SVG — confirmed rows only; labels gated; invariance text present', () => {
  const s = renderLayersSvg(layerState(30, 80, 8, 3), { showRadius: true, showHeight: true, width: 640, height: 360 });
  // exactly the first three layers carry the filled flag; rows 4..8 outlined
  for (let k = 1; k <= 8; k += 1) {
    const filled = s.markup.includes(`data-layer="${k}" data-layer-filled="${k <= 3 ? '1' : '0'}"`);
    assert.ok(filled, `layer ${k} filled flag must reflect visibleLayerCount=3`);
  }
  assert.ok(s.markup.includes('r = 3.0 cm') && s.markup.includes('h = 8.0 cm'), 'givens labels visible');
  assert.ok(s.markup.includes('层数 n = 8') && s.markup.includes('已装 3 层'));
  assert.ok(s.ariaLabel.includes('层数改变不改变总体积'));
  const hidden = renderLayersSvg(layerState(30, 80, 8, 3), { showRadius: false, showHeight: false, width: 640, height: 360 });
  assert.ok(!hidden.markup.includes('r = 3.0'), 'hidden labels never render');
});

test('scenes: L3 face selection renders highlight + text markers (not color-only)', () => {
  const withSel = renderCylinderSvg({ ...state(30, 80), selectedFaceIds: ['cyl-face-side', 'cyl-face-lower'] }, {
    showRadius: true,
    showDiameter: false,
    showHeight: true,
    showEdgeMarkers: false,
    stripOrientation: 'HORIZONTAL',
    unrollBadge: '',
    width: 640,
    height: 360,
    showFaceSelection: true,
  });
  assert.ok(withSel.markup.includes('data-face="cyl-face-side"'));
  assert.ok(withSel.markup.includes('data-face="cyl-face-lower"'));
  assert.ok(!withSel.markup.includes('data-face="cyl-face-upper"'));
  assert.ok(withSel.markup.includes('已选入'), 'text channel present, not color alone');
  assert.ok(withSel.ariaLabel.includes('已选入纸样'));
});
