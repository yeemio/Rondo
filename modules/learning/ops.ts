import { rondoError } from '../contracts/public/errors';
/**
 * Server-side canonical cylinder operation application (scene-canonical
 * semantics for the registered rondo.cylinder@1 renderer).
 *
 * Frozen sources:
 * - SCENE-CONTRACTS.md §2 (integer mm; radius 5..100; height 10..200;
 *   unroll 0..1000; section enum; tasks may NARROW ranges, never widen)
 * - contracts/server/scene-canonical.ts (normalizeState never clamps;
 *   out-of-range is an error)
 *
 * The public zod schema already rejects out-of-global-range values; the
 * caller additionally checks the task's construction domains (narrowing)
 * before calling apply.
 */
import type { CylinderOperationV1, CylinderStateV1 } from '../contracts/public/scene';
import { cylinderStateV1Schema, cylinderStateV2Schema, type CylinderStateV2, type CylinderOperationV2 } from '../contracts/public/scene';

export function applyCylinderOperation(
  state: CylinderStateV1 | CylinderStateV2,
  op: CylinderOperationV1 | CylinderOperationV2,
): CylinderStateV1 | CylinderStateV2 {
  let next: CylinderStateV1 | CylinderStateV2;
  switch (op.type) {
    case 'SetDimension':
      next =
        op.dimension === 'RADIUS'
          ? { ...state, radiusMm: op.valueMm }
          : { ...state, heightMm: op.valueMm };
      break;
    case 'SetUnroll':
      next = { ...state, unrollPermille: op.valuePermille };
      break;
    case 'SetSection':
      next = { ...state, section: op.section };
      break;
    case 'SelectFaces':
      next = { ...state, selectedFaceIds: [...op.faceIds] };
      break;
    case 'SetLayerCount': {
      const layered = state as CylinderStateV2;
      next = { ...layered, layerCount: op.value, visibleLayerCount: Math.min(layered.visibleLayerCount, op.value) };
      break;
    }
    case 'SetVisibleLayerCount': {
      const layered = state as CylinderStateV2;
      if (op.value > layered.layerCount) {
        throw rondoError('INVALID_OPERATION', `可见层数 ${op.value} 超过当前层数 ${layered.layerCount}。`);
      }
      next = { ...layered, visibleLayerCount: op.value };
      break;
    }
  }
  // Re-validate through the frozen state schema: integer/range/enum
  // discipline is enforced on the RESULT, so no derived drift is possible.
  const isV2 = next !== undefined && (next as CylinderStateV2).layerCount !== undefined;
  return isV2 ? cylinderStateV2Schema.parse(next) : cylinderStateV1Schema.parse(next);
}

export function visibilityForPhase(phase: 'PREDICT' | 'OPERATE' | 'VERIFY' | 'EXPLAIN' | 'REVIEW'): 'PREDICTION' | 'OBSERVATION' | 'ASSESSMENT' | 'REVIEW' {
  switch (phase) {
    case 'PREDICT':
      return 'PREDICTION';
    case 'OPERATE':
      return 'OBSERVATION';
    case 'VERIFY':
      return 'ASSESSMENT';
    case 'EXPLAIN':
    case 'REVIEW':
      return 'REVIEW';
  }
}
