/**
 * B-owned content file formats: per-task public files and hint files.
 *
 * These zod schemas are the loader's structural rejection surface: strict
 * objects, so any private/forbidden field (answer, correctIndex, privateTests,
 * scoringFunction, seed, answerHash) fails validation by structure, not by
 * keyword scanning (server-ports-recommendation.md §3 step 2).
 */
import { z } from 'zod';
import { activityStateSchema } from '../contracts/public/activity';
import { idSchema } from '../contracts/public/protocol';
import { authoredBlocksSchema, MATERIAL_VISIBILITIES, numericPolicySchema } from '../contracts/public/question';
import { sectionSchema } from '../contracts/public/scene';
import { RADIUS_MM_MIN, RADIUS_MM_MAX, HEIGHT_MM_MIN, HEIGHT_MM_MAX, UNROLL_PERMILLE_MAX } from '../contracts/public/scene';

export const CYLINDER_TASK_FAMILIES = [
  'cylinder.parameters.v1',
  'cylinder.net.v1',
  // integration W1 (L3/L4 content): the faces family ships on @1 (SelectFaces
  // is a frozen V1 member), the layers family ships on @2 (L34-1/L34-2).
  'cylinder.faces.v1',
  'cylinder.layers.v1',
] as const;
export type CylinderTaskFamily = (typeof CYLINDER_TASK_FAMILIES)[number];

const visibilityOrder: Record<(typeof MATERIAL_VISIBILITIES)[number], number> = {
  PREDICTION: 0,
  OBSERVATION: 1,
  ASSESSMENT: 2,
  REVIEW: 3,
};

export function visibilityRank(visibility: (typeof MATERIAL_VISIBILITIES)[number]): number {
  return visibilityOrder[visibility];
}

export const taskPromptGroupSchema = z
  .object({
    minVisibility: z.enum(MATERIAL_VISIBILITIES),
    blocks: authoredBlocksSchema,
  })
  .strict();
export type TaskPromptGroup = z.infer<typeof taskPromptGroupSchema>;

export const taskGivensSchema = z
  .object({
    radiusMm: z.number().int().min(RADIUS_MM_MIN).max(RADIUS_MM_MAX),
    heightMm: z.number().int().min(HEIGHT_MM_MIN).max(HEIGHT_MM_MAX),
  })
  .strict();
export type TaskGivens = z.infer<typeof taskGivensSchema>;

export const taskFileSchema = z
  .object({
    taskId: idSchema,
    taskFamily: z.enum(CYLINDER_TASK_FAMILIES),
    title: z.string().min(1).max(200),
    promptGroups: z.array(taskPromptGroupSchema).min(1).max(16),
    responseSchemaId: idSchema,
    numericPolicy: numericPolicySchema,
    /**
     * Operations this task opens; each id must be a registered
     * CylinderOperationV1 member. May be empty: L1 pure-observation tasks
     * (SCENE-CONTRACTS §3 L1 row 1 — orbiting the object only changes
     * ViewState) legally open zero domain operations; the cycle then goes
     * predict -> submit straight from OPERATE with no committed operation.
     */
    allowedOperationIds: z.array(idSchema).max(32),
    /** Authored fixed givens. When sampleParams is true the server samples instead. */
    givens: taskGivensSchema,
    sampleParams: z.boolean().optional(),
    /** Assessment-style task: SetDimension is rejected regardless of ranges. */
    lockedDimensions: z.boolean().optional(),
    sceneObjects: z
      .union([
        // cylinder @1 parameters/net tasks name the cylinder + numbered edges
        z
          .object({
            cylinderObjectIds: z.array(idSchema).max(16),
            netEdgeIds: z.array(idSchema).max(16),
          })
          .strict(),
        // faces-family (L3) tasks name the selectable faces instead
        z
          .object({
            faceIds: z.array(idSchema).max(16),
          })
          .strict(),
      ])
      .optional(),
    initialState: z
      .object({
        unrollPermille: z.number().int().min(0).max(UNROLL_PERMILLE_MAX),
        section: sectionSchema,
        selectedFaceIds: z.array(idSchema).max(8),
        /** @2 (layers family, L34-1) tasks pin the layer pair here. */
        layerCount: z.number().int().min(1).max(40).optional(),
        visibleLayerCount: z.number().int().min(0).max(40).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TaskFile = z.infer<typeof taskFileSchema>;

// ---------------------------------------------------------------------------
// THEMES-A family task files (themes.micro.v1 / themes.frac.v1; integration W1
// port of the C-line shapes, verbatim field set — GRID givens are the board
// state; micro-lesson ① carries cylinder givens for the base-circle view)
// ---------------------------------------------------------------------------

const visibilityListSchema = z
  .array(
    z
      .object({
        material: idSchema,
        phases: z.array(z.string().min(1).max(16)).max(8),
        note: z.string().max(200).optional(),
      })
      .strict(),
  )
  .max(16);

export const THEMES_TASK_FAMILIES = ['themes.micro.v1', 'themes.frac.v1'] as const;
export type ThemesTaskFamily = (typeof THEMES_TASK_FAMILIES)[number];

const operationConstraintSchema = z.record(z.unknown());
export type OperationConstraint = z.infer<typeof operationConstraintSchema>;

const explainSchema = z
  .object({
    selections: z
      .array(
        z
          .object({
            itemId: idSchema,
            prompt: z.string().min(1).max(400),
            multi: z.boolean().optional(),
            options: z
              .array(z.object({ id: idSchema, label: z.string().min(1).max(200) }).strict())
              .min(2)
              .max(8),
          })
          .strict(),
      )
      .max(8),
    freeTextPrompt: z.string().min(1).max(400),
  })
  .strict();

const hintEntrySchema = z
  .object({
    level: z.number().int().min(1).max(4),
    label: z.string().min(1).max(64),
    text: z.string().max(2000).optional(),
    /** Level-4 answer hints may omit the text (served from the private hints file). */
    revealsAnswer: z.boolean().optional(),
  })
  .strict();

export const themesTaskFileSchema = z
  .object({
    taskId: idSchema,
    taskVersion: idSchema,
    taskFamily: z.enum(THEMES_TASK_FAMILIES),
    // Task files never carry an explicit kind — the UI derives it from the
    // taskId convention (.g*/.i* -> GUIDED/INDEPENDENT, .s1. -> STRANGER,
    // .d1. -> DELAYED_TRANSFER), same as the cylinder family.
    kind: z.enum(['GUIDED', 'INDEPENDENT', 'STRANGER', 'DELAYED_TRANSFER']).optional(),
    title: z.string().min(1).max(200),
    boardView: z.string().min(1).max(32),
    promptGroups: z.array(taskPromptGroupSchema).min(1).max(16),
    /** 微课① rides the cylinder base circle; every other board task carries the grid state. */
    givens: z.record(z.unknown()),
    givenLocks: z.array(idSchema).max(16),
    responseSchemaId: idSchema,
    allowedOperationIds: z.array(idSchema).max(32),
    operationConstraints: z.array(operationConstraintSchema).max(8),
    visibility: visibilityListSchema,
    hints: z.array(hintEntrySchema).max(4),
    explain: explainSchema,
    exitEvidence: z.array(z.string().min(1).max(64)).max(8),
    expressions: z
      .object({ boardSvg: z.string().min(1).max(400), boardTable: z.string().min(1).max(400) })
      .strict(),
  })
  .strict();
export type ThemesTaskFile = z.infer<typeof themesTaskFileSchema>;

// ---------------------------------------------------------------------------
// GESP2 family task files (cpp.steps.v1; integration W1 port, verbatim field
// set — givens carry the frozen step program + inputs + trace cursor)
// ---------------------------------------------------------------------------

export const CPP_TASK_FAMILY = 'cpp.steps.v1' as const;
export type CppTaskFamily = typeof CPP_TASK_FAMILY;

export const cppTaskFileSchema = z
  .object({
    taskId: idSchema,
    taskVersion: idSchema,
    taskFamily: z.literal(CPP_TASK_FAMILY),
    // Task files never carry an explicit kind — the UI derives it from the
    // taskId convention (.g*/.i* -> GUIDED/INDEPENDENT, .s1. -> STRANGER,
    // .d1. -> DELAYED_TRANSFER), same as the cylinder family.
    kind: z.enum(['GUIDED', 'INDEPENDENT', 'STRANGER', 'DELAYED_TRANSFER']).optional(),
    title: z.string().min(1).max(200),
    promptGroups: z.array(taskPromptGroupSchema).min(1).max(16),
    /** givens carry the frozen step program + inputs + trace cursor (StepProgramStateV1). */
    givens: z.record(z.unknown()),
    givenLocks: z.array(idSchema).max(16).optional(),
    responseSchemaId: idSchema,
    allowedOperationIds: z.array(idSchema).max(32),
    operationConstraints: z.array(operationConstraintSchema).max(8),
    visibility: visibilityListSchema,
    mission: z.string().min(1).max(1000).optional(),
    hints: z.array(hintEntrySchema).max(4),
    explain: explainSchema,
    exitEvidence: z.array(z.string().min(1).max(64)).max(8),
    expressions: z.record(z.string().min(1).max(400)),
  })
  .strict();
export type CppTaskFile = z.infer<typeof cppTaskFileSchema>;

/** Any family's task file (discriminated at load by the release's renderer). */
export const activityTaskFileSchema = z.object({ taskId: idSchema, taskVersion: idSchema, taskFamily: z.literal('mvp.activity.v1'), title: z.string(), promptGroups: z.array(taskPromptGroupSchema).min(1), responseSchemaId: idSchema, allowedOperationIds: z.array(idSchema), givens: activityStateSchema }).strict();
export type AnyFamilyTaskFile = TaskFile | ThemesTaskFile | CppTaskFile | z.infer<typeof activityTaskFileSchema>;

export const hintFileSchema = z
  .object({
    contentRef: idSchema,
    level: z.number().int().min(0).max(5),
    /** Authored classification: an answer-revealing hint marks the cycle as answer-assisted. */
    revealsAnswer: z.boolean(),
    version: idSchema,
    text: z.string().min(1).max(2000),
  })
  .strict();
export type HintFile = z.infer<typeof hintFileSchema>;

export const privateRulesFileSchema = z
  .object({
    ruleSets: z
      .array(
        z
          .object({
            ruleId: idSchema,
            ruleSet: z
              .object({
                ruleSetVersion: idSchema,
                rules: z.array(z.unknown()).min(1).max(32),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();
export type PrivateRulesFile = z.infer<typeof privateRulesFileSchema>;
