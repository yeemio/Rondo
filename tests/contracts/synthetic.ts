/**
 * Synthetic fixtures shared by the contract tests (test-only).
 *
 * Everything here is synthetic: no donor data, no real learning facts
 * (H0-SPEC §4). The stub service is a test-only implementation of the server
 * ports; it never judges responses.
 */
import { parsePublicQuestionSpec } from '../../modules/contracts/public/question';
import type { PublicQuestionSpec } from '../../modules/contracts/public/question';
import { PROTOCOL_VERSION } from '../../modules/contracts/public/protocol';
import { CYLINDER_RENDERER_CONTRACT_VERSION, CYLINDER_RENDERER_ID } from '../../modules/contracts/public/scene';

export const SYNTH_PROTOCOL_VERSION = PROTOCOL_VERSION;
export const SYNTH_RELEASE_ID = 'rel-cyl-l1-0001';
export const SYNTH_RENDERER_ID = CYLINDER_RENDERER_ID;
export const SYNTH_RENDERER_CONTRACT_VERSION = CYLINDER_RENDERER_CONTRACT_VERSION;
export const SYNTH_TASK_ID = 'task-cyl-parameters-01';

export const SYNTH_INITIAL_STATE = {
  radiusMm: 30,
  heightMm: 80,
  unrollPermille: 0,
  section: 'NONE',
  selectedFaceIds: [],
} as const;

export const SYNTH_COMMITTED_RADIUS_MM = 40;

/** A fully valid synthetic PublicQuestionSpec; negative tests mutate it with forbidden fields. */
export function sampleQuestionSpec(overrides?: { radiusMm?: number }): PublicQuestionSpec {
  return parsePublicQuestionSpec({
    questionInstanceId: 'qi-synth-0001',
    releaseId: SYNTH_RELEASE_ID,
    taskId: SYNTH_TASK_ID,
    taskVersion: '1',
    prompt: [
      { type: 'TEXT', text: '把半径从 3.0 cm 改为 4.0 cm 后，哪些量会变化？' },
      {
        type: 'MEASUREMENT_TABLE',
        columns: [
          { label: '半径', unitId: 'mm' },
          { label: '高度', unitId: 'mm' },
        ],
        rows: [[String(overrides?.radiusMm ?? SYNTH_INITIAL_STATE.radiusMm), String(SYNTH_INITIAL_STATE.heightMm)]],
      },
      { type: 'FORMULA', expression: 'C = 2 × 3.14 × r' },
    ],
    responseSchemaId: 'rondo.response.propertyJudgments.v1',
    numericPolicy: { pi: '3.14', displayDecimals: 2, acceptedUnitIds: ['mm', 'cm'] },
    scene: {
      rendererId: SYNTH_RENDERER_ID,
      rendererContractVersion: SYNTH_RENDERER_CONTRACT_VERSION,
      state: { ...SYNTH_INITIAL_STATE, radiusMm: overrides?.radiusMm ?? SYNTH_INITIAL_STATE.radiusMm },
    },
    allowedOperationIds: ['SetDimension', 'SetSection'],
    materialVisibility: 'PREDICTION',
  });
}
