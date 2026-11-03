/**
 * Scene public contracts: descriptor, cylinder state/operations (V1 and V2),
 * ViewState boundary type, keyboard command map.
 *
 * Frozen sources:
 * - SCENE-CONTRACTS.md §1 (SceneDescriptor, WEBGL2/SVG_DOM equivalence)
 * - SCENE-CONTRACTS.md §2 (integer mm, radius 5..100, height 10..200,
 *   unroll 0..1000, section enum, CylinderOperationV1 four members)
 * - H0-SPEC.md §1 scene.ts
 * - L34-1 (adjudicated 2026-10-27, H0 delta h0-mathl34-20261027-1): the same
 *   renderer family versioned up — rondo.cylinder@2 adds CylinderStateV2 /
 *   CylinderOperationV2 (layerCount/visibleLayerCount, SetLayerCount /
 *   SetVisibleLayerCount). V1 stays frozen and unchanged; L1–L3 releases keep
 *   @1/"1" with zero migration. Layer thickness is heightMm ÷ layerCount, an
 *   exact derived value never stored in state; changing layer count never
 *   changes total volume (SCENE-CONTRACTS §5 L4 row).
 * - Integration W1 (2026-10-27, H0 delta H0-DELTA-INTEGRATION-20261027-3):
 *   merging the THEMES-A and GESP2 family deltas beside L34-1 — the public
 *   state union also carries rondo.gridboard@1 (scene-gridboard.ts) and
 *   rondo.steps@1 (scene-steps.ts) members. Each family module stays the
 *   single source of its own state/operation schemas; unknown renderers and
 *   versions are still rejected, never routed to a "generic renderer".
 *
 * Renderer-visible: no server/sqlite/Node imports.
 */
import { z } from 'zod';
import { activityStateSchema, type ActivityState } from './activity';
import { idSchema } from './protocol';
import { gridBoardStateV1Schema, type GridBoardStateV1 } from './scene-gridboard';
import { stepProgramStateV1Schema, type StepProgramStateV1 } from './scene-steps';

export const CYLINDER_RENDERER_ID = 'rondo.cylinder' as const;
export const CYLINDER_RENDERER_CONTRACT_VERSION = '1' as const;
export const CYLINDER_RENDERER_CONTRACT_VERSION_V2 = '2' as const;

export const RADIUS_MM_MIN = 5;
export const RADIUS_MM_MAX = 100;
export const HEIGHT_MM_MIN = 10;
export const HEIGHT_MM_MAX = 200;
export const UNROLL_PERMILLE_MIN = 0;
export const UNROLL_PERMILLE_MAX = 1000;

/** Server rejects NaN, Infinity, negative, out-of-range, or non-integer geometry (SCENE-CONTRACTS §2). */
export const sectionSchema = z.enum(['NONE', 'TRANSVERSE', 'AXIAL']);
export type CylinderSection = z.infer<typeof sectionSchema>;

export const cylinderStateV1Schema = z
  .object({
    radiusMm: z.number().int().min(RADIUS_MM_MIN).max(RADIUS_MM_MAX),
    heightMm: z.number().int().min(HEIGHT_MM_MIN).max(HEIGHT_MM_MAX),
    unrollPermille: z.number().int().min(UNROLL_PERMILLE_MIN).max(UNROLL_PERMILLE_MAX),
    section: sectionSchema,
    selectedFaceIds: z.array(idSchema).max(8),
  })
  .strict();

export type CylinderStateV1 = z.infer<typeof cylinderStateV1Schema>;

export function parseCylinderStateV1(input: unknown): CylinderStateV1 {
  return cylinderStateV1Schema.parse(input);
}

export function safeParseCylinderStateV1(input: unknown): z.SafeParseReturnType<unknown, CylinderStateV1> {
  return cylinderStateV1Schema.safeParse(input);
}

export const CYLINDER_OPERATION_TYPES = ['SetDimension', 'SetUnroll', 'SetSection', 'SelectFaces'] as const;
export type CylinderOperationType = (typeof CYLINDER_OPERATION_TYPES)[number];

// The four V1 operation members, extracted verbatim (same fields, same
// strictness) so V1 and V2 unions share leaves without re-typing them.
const setDimensionMember = z
  .object({
    type: z.literal('SetDimension'),
    dimension: z.enum(['RADIUS', 'HEIGHT']),
    valueMm: z.number().int(),
  })
  .strict();
const setUnrollMember = z
  .object({
    type: z.literal('SetUnroll'),
    valuePermille: z.number().int().min(UNROLL_PERMILLE_MIN).max(UNROLL_PERMILLE_MAX),
  })
  .strict();
const setSectionMember = z
  .object({
    type: z.literal('SetSection'),
    section: sectionSchema,
  })
  .strict();
const selectFacesMember = z
  .object({
    type: z.literal('SelectFaces'),
    faceIds: z.array(idSchema).max(8),
  })
  .strict();

function checkSetDimensionRange(op: { type: string; dimension?: string; valueMm?: number }, ctx: z.RefinementCtx): void {
  if (op.type !== 'SetDimension') return;
  const min = op.dimension === 'RADIUS' ? RADIUS_MM_MIN : HEIGHT_MM_MIN;
  const max = op.dimension === 'RADIUS' ? RADIUS_MM_MAX : HEIGHT_MM_MAX;
  if (op.valueMm! < min || op.valueMm! > max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `valueMm out of range for ${op.dimension}: expected ${min}..${max}, got ${op.valueMm}`,
    });
  }
}

/**
 * SetDimension range is dimension-dependent (RADIUS 5..100, HEIGHT 10..200) and
 * checked in the superRefine below; tasks may narrow but never widen ranges.
 */
export const cylinderOperationV1Schema = z
  .discriminatedUnion('type', [setDimensionMember, setUnrollMember, setSectionMember, selectFacesMember])
  .superRefine((op, ctx) => {
    checkSetDimensionRange(op, ctx);
  });

export type CylinderOperationV1 = z.infer<typeof cylinderOperationV1Schema>;

export function parseCylinderOperationV1(input: unknown): CylinderOperationV1 {
  return cylinderOperationV1Schema.parse(input);
}

export function safeParseCylinderOperationV1(input: unknown): z.SafeParseReturnType<unknown, CylinderOperationV1> {
  return cylinderOperationV1Schema.safeParse(input);
}

// ---------------------------------------------------------------------------
// V2 (L34-1): rondo.cylinder@2 — V1 fields unchanged plus the layer pair.
// layerCount 1..40; visibleLayerCount 0..layerCount (task-white-listed server
// side); layer thickness is DERIVED (heightMm ÷ layerCount), never stored.
// ---------------------------------------------------------------------------
export const LAYER_COUNT_MIN = 1;
export const LAYER_COUNT_MAX = 40;

export const cylinderStateV2Schema = cylinderStateV1Schema
  .extend({
    layerCount: z.number().int().min(LAYER_COUNT_MIN).max(LAYER_COUNT_MAX),
    visibleLayerCount: z.number().int().min(0),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.visibleLayerCount > s.layerCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `visibleLayerCount ${s.visibleLayerCount} > layerCount ${s.layerCount}`,
      });
    }
  });

export type CylinderStateV2 = z.infer<typeof cylinderStateV2Schema>;

export function parseCylinderStateV2(input: unknown): CylinderStateV2 {
  return cylinderStateV2Schema.parse(input);
}

export function safeParseCylinderStateV2(input: unknown): z.SafeParseReturnType<unknown, CylinderStateV2> {
  return cylinderStateV2Schema.safeParse(input);
}

export const CYLINDER_OPERATION_TYPES_V2 = [
  'SetDimension',
  'SetUnroll',
  'SetSection',
  'SelectFaces',
  'SetLayerCount',
  'SetVisibleLayerCount',
] as const;
export type CylinderOperationTypeV2 = (typeof CYLINDER_OPERATION_TYPES_V2)[number];

/** V2-only operation members (V1 members are shared verbatim above). */
const setLayerCountMember = z
  .object({
    type: z.literal('SetLayerCount'),
    value: z.number().int().min(LAYER_COUNT_MIN).max(LAYER_COUNT_MAX),
  })
  .strict();
const setVisibleLayerCountMember = z
  .object({
    type: z.literal('SetVisibleLayerCount'),
    value: z.number().int().min(0),
  })
  .strict();

/**
 * CylinderOperationV2: the V1 four members plus the layer pair. A
 * SetVisibleLayerCount value above the CURRENT layerCount is a task-state
 * violation rejected server-side as INVALID_OPERATION (it cannot be a schema
 * constraint: the bound depends on live state, not on the op alone).
 */
export const cylinderOperationV2Schema = z
  .discriminatedUnion('type', [
    setDimensionMember,
    setUnrollMember,
    setSectionMember,
    selectFacesMember,
    setLayerCountMember,
    setVisibleLayerCountMember,
  ])
  .superRefine((op, ctx) => {
    checkSetDimensionRange(op, ctx);
  });

export type CylinderOperationV2 = z.infer<typeof cylinderOperationV2Schema>;

export function parseCylinderOperationV2(input: unknown): CylinderOperationV2 {
  return cylinderOperationV2Schema.parse(input);
}

export function safeParseCylinderOperationV2(input: unknown): z.SafeParseReturnType<unknown, CylinderOperationV2> {
  return cylinderOperationV2Schema.safeParse(input);
}

/**
 * The public scene state union: V1 for @1 releases, V2 for @2 (L34-1), plus
 * the gridboard (THEMES-A) and steps (GESP2) family members (integration W1).
 * It grows only via a versioned contract delta from A; unknown renderers and
 * unknown versions are rejected, never routed to a "generic renderer".
 * Version DISCRIMINATION (a V2 state must not be served to an @1 task and
 * vice versa) is checked against the descriptor via
 * sceneStateSchemaForContractVersion below — the union itself only carries
 * syntax.
 */
export const publicSceneStateSchema = z.union([
  activityStateSchema,
  cylinderStateV1Schema,
  cylinderStateV2Schema,
  gridBoardStateV1Schema,
  stepProgramStateV1Schema,
]);
export type PublicSceneState = CylinderStateV1 | CylinderStateV2 | GridBoardStateV1 | StepProgramStateV1 | ActivityState;

/** Registered contract versions of the rondo.cylinder family. */
export const CYLINDER_RENDERER_CONTRACT_VERSIONS = ['1', '2'] as const;

/**
 * Descriptor-checked state parsing (L34-1): returns the state schema bound to
 * the renderer contract version, or null for an unknown version (the caller
 * rejects — never guesses). A V2 state handed to an @1 descriptor therefore
 * fails V1 parsing, which is the dual-version rejection at the schema layer.
 */
export function sceneStateSchemaForContractVersion(rendererContractVersion: string): z.ZodTypeAny | null {
  switch (rendererContractVersion) {
    case '1':
      return cylinderStateV1Schema;
    case '2':
      return cylinderStateV2Schema;
    default:
      return null;
  }
}

/** Safe-parse a state against the version pinned by a descriptor. */
export function safeParseSceneStateForVersion(
  rendererContractVersion: string,
  input: unknown,
): z.SafeParseReturnType<unknown, PublicSceneState> | null {
  const schema = sceneStateSchemaForContractVersion(rendererContractVersion);
  return schema ? (schema.safeParse(input) as z.SafeParseReturnType<unknown, PublicSceneState>) : null;
}

/** Host-checked descriptor; front ends cannot pick renderer URLs or versions (SCENE-CONTRACTS §1). */
export const sceneDescriptorSchema = z
  .object({
    rendererId: idSchema,
    rendererContractVersion: idSchema,
    publicStateSchemaVersion: idSchema,
    publicAssetHashes: z.array(z.string().min(16).max(128)).max(64),
    allowedOperations: z.array(idSchema).max(32),
  })
  .strict();

export type SceneDescriptor = z.infer<typeof sceneDescriptorSchema>;

export function parseSceneDescriptor(input: unknown): SceneDescriptor {
  return sceneDescriptorSchema.parse(input);
}

export function safeParseSceneDescriptor(input: unknown): z.SafeParseReturnType<unknown, SceneDescriptor> {
  return sceneDescriptorSchema.safeParse(input);
}

/**
 * ViewState boundary type: camera, focus, drag-preview values and animation
 * interpolation. Never part of domain commands, never persisted as learning
 * facts, never scored (SCENE-CONTRACTS §1; SHARED-CONTRACT guarantees).
 */
export const viewStateSchema = z
  .object({
    cameraAzimuthDeg: z.number().refine(Number.isFinite, { message: 'must be finite' }),
    cameraElevationDeg: z.number().refine(Number.isFinite, { message: 'must be finite' }),
    cameraDistanceMm: z
      .number()
      .positive()
      .refine(Number.isFinite, { message: 'must be finite' }),
    focusObjectId: idSchema.optional(),
    pendingOperation: z.union([cylinderOperationV1Schema, cylinderOperationV2Schema]).optional(),
    animationProgress: z.number().min(0).max(1).optional(),
  })
  .strict();

export type ViewState = z.infer<typeof viewStateSchema>;

export function parseViewState(input: unknown): ViewState {
  return viewStateSchema.parse(input);
}

export function safeParseViewState(input: unknown): z.SafeParseReturnType<unknown, ViewState> {
  return viewStateSchema.safeParse(input);
}

/**
 * Keyboard equivalent declarations: operation -> keyboard entry points.
 * C registers its maps against this shape; A's boundary checks verify that
 * every domain operation exposed to a learner has a non-pointer equivalent
 * (SCENE-CONTRACTS §3/§6; keyboard and mouse produce identical typed intent).
 */
export const keyboardCommandMapSchema = z
  .array(
    z
      .object({
        operationId: idSchema,
        keys: z.array(z.string().min(1).max(32)).min(1).max(8),
        description: z.string().min(1).max(200),
      })
      .strict(),
  )
  .max(64);

export type KeyboardCommandMap = z.infer<typeof keyboardCommandMapSchema>;

export function parseKeyboardCommandMap(input: unknown): KeyboardCommandMap {
  return keyboardCommandMapSchema.parse(input);
}

export function safeParseKeyboardCommandMap(input: unknown): z.SafeParseReturnType<unknown, KeyboardCommandMap> {
  return keyboardCommandMapSchema.safeParse(input);
}
