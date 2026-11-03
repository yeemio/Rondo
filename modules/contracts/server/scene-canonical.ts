/**
 * Server-side canonical scene validation port.
 *
 * Frozen sources:
 * - SCENE-CONTRACTS.md §1/§2 and B proposals §G: B validates and normalizes
 *   typed operations (integer mm ranges, unroll 0..1000, section enum,
 *   registered face ids); rejects full client-state overrides; Host re-checks
 *   givens/phase/attemptVersion; ViewState never enters here.
 * - H0-SPEC.md §2 scene-canonical.ts: B implements; C's scene components only
 *   consume public state and emit typed operations.
 */
import type { CyclePhase } from '../public/queries';
import type { CylinderOperationV1, PublicSceneState } from '../public/scene';

export interface OperationValidationInput {
  readonly taskSpec: {
    readonly rendererId: string;
    readonly rendererContractVersion: string;
    readonly allowedOperationIds: readonly string[];
  };
  readonly operation: CylinderOperationV1;
  readonly phase: CyclePhase;
  readonly attemptVersion: number;
}

export type OperationValidation =
  | { ok: true; normalizedOperation: CylinderOperationV1 }
  | { ok: false; code: 'INVALID_OPERATION' | 'UNKNOWN_RENDERER' | 'SCHEMA_MISMATCH' };

export interface SceneCanonicalPort {
  /** Validates an operation against task givens, phase, and the registered renderer; returns the normalized form. */
  validateOperation(input: OperationValidationInput): Promise<OperationValidation>;
  /** Normalizes a scene state (integer mm clamping is NOT allowed -- out-of-range is an error, not a silent fix). */
  normalizeState(input: {
    rendererId: string;
    rendererContractVersion: string;
    state: PublicSceneState;
  }): Promise<PublicSceneState>;
}
