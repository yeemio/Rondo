/**
 * PublicQuestionSpec and AuthoredBlocks.
 *
 * Frozen sources:
 * - LIFECYCLE-DATA-API.md §5 (PublicQuestionSpec shape; forbidden private fields)
 * - SHARED-CONTRACT.md "不能分叉的领域保证" (no answer/correctIndex/private
 *   tests/scoring/seed/answer-derivable hashes; givens and allowed teaching
 *   formulas may stay public, projected by materialVisibility)
 * - SCENE-CONTRACTS.md §2 (pi = 3.14 = 157/50 as the course-wide numeric contract)
 * - H0-SPEC.md §1 question.ts
 */
import { z } from 'zod';
import { idSchema } from './protocol';
import { publicSceneStateSchema } from './scene';

export const MATERIAL_VISIBILITIES = ['PREDICTION', 'OBSERVATION', 'ASSESSMENT', 'REVIEW'] as const;
export type MaterialVisibility = (typeof MATERIAL_VISIBILITIES)[number];

/**
 * AuthoredBlocks: bounded block union frozen at H0 (TEXT / FORMULA /
 * IMAGE_REF / MEASUREMENT_TABLE). The block type set only grows via a
 * versioned contract delta.
 */
export const authoredBlockSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('TEXT'),
      text: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal('FORMULA'),
      expression: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal('IMAGE_REF'),
      assetId: idSchema,
      altText: z.string().max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal('MEASUREMENT_TABLE'),
      columns: z
        .array(
          z
            .object({ label: z.string().min(1).max(64), unitId: idSchema.optional() })
            .strict(),
        )
        .min(1)
        .max(8),
      rows: z.array(z.array(z.string().max(64)).max(8)).max(32),
    })
    .strict(),
]);

export type AuthoredBlock = z.infer<typeof authoredBlockSchema>;

export const authoredBlocksSchema = z.array(authoredBlockSchema).min(1).max(64);
export type AuthoredBlocks = z.infer<typeof authoredBlocksSchema>;

export function parseAuthoredBlocks(input: unknown): AuthoredBlocks {
  return authoredBlocksSchema.parse(input);
}

export function safeParseAuthoredBlocks(input: unknown): z.SafeParseReturnType<unknown, AuthoredBlocks> {
  return authoredBlocksSchema.safeParse(input);
}

/**
 * Fields that must NEVER appear on a public question spec, projection, DOM,
 * or asset. The strict schema rejects them as unknown fields; this list is
 * exported so boundary checks and fixtures can assert the rejection
 * explicitly (H0-SPEC §1 question.ts).
 */
export const FORBIDDEN_QUESTION_FIELDS = [
  'answer',
  'correctIndex',
  'privateTests',
  'scoringFunction',
  'seed',
  'answerHash',
] as const;
export type ForbiddenQuestionField = (typeof FORBIDDEN_QUESTION_FIELDS)[number];

export const numericPolicySchema = z
  .object({
    /** pi = 3.14 = 157/50, the exact decimal contract for the first two units (SCENE-CONTRACTS §2). */
    pi: z.literal('3.14'),
    displayDecimals: z.number().int().min(0).max(6),
    acceptedUnitIds: z.array(idSchema).min(1).max(16),
  })
  .strict();
export type NumericPolicy = z.infer<typeof numericPolicySchema>;

export const publicQuestionSpecSchema = z
  .object({
    questionInstanceId: idSchema,
    releaseId: idSchema,
    taskId: idSchema,
    taskVersion: idSchema,
    prompt: authoredBlocksSchema,
    responseSchemaId: idSchema,
    /**
     * Dimension-family contract; meaningless for non-dimensional families
     * (themes grid-board tasks / cpp.steps.v1) — optional per the THEMES-A and
     * GESP2 contract deltas (2026-10-27, A-8 adjudication). Old content keeps
     * carrying it; nothing is backfilled.
     */
    numericPolicy: numericPolicySchema.optional(),
    scene: z
      .object({
        rendererId: idSchema,
        rendererContractVersion: idSchema,
        state: publicSceneStateSchema,
      })
      .strict(),
    allowedOperationIds: z.array(idSchema).max(32),
    materialVisibility: z.enum(MATERIAL_VISIBILITIES),
  })
  .strict();

export type PublicQuestionSpec = z.infer<typeof publicQuestionSpecSchema>;

export function parsePublicQuestionSpec(input: unknown): PublicQuestionSpec {
  return publicQuestionSpecSchema.parse(input);
}

export function safeParsePublicQuestionSpec(input: unknown): z.SafeParseReturnType<unknown, PublicQuestionSpec> {
  return publicQuestionSpecSchema.safeParse(input);
}
