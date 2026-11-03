/**
 * Grid-board scene contracts (rondo.gridboard@1): the equal-partition /
 * quantity-board family for taskFamilies themes.micro.v1 (微课 ②③④ supplements
 * and ②③ diagnostics) and themes.frac.v1 (主题一：分数、百分数与比例).
 *
 * Frozen sources (THEMES-A contract delta, 2026-10-27, mirroring the approved
 * GESP2 precedent — new scene module beside the frozen cylinder contract; the
 * public scene state union and the commitOperation operation union grow by a
 * versioned delta, unknown renderers/versions are still rejected):
 * - Owner 定位 2026-10-27（先修微课 + 主题一）：等分圆盘/条带、数轴标点、
 *   缩放对比条、百格板、矩形/点阵；SVG/DOM 为主，无 three.js 依赖。
 * - SCENE-CONTRACTS §1/§3/§6（双表达等价、操作对应可验证领域状态、键盘等价入口）
 *
 * One state serves every board projection: rows×cols cells with `filled`
 * marked cells. The task content declares the visual projection (圆盘 / 条带 /
 * 数轴 / 矩形 / 点阵 / 百格板); the state itself is the domain fact the server
 * judges against (等分数=cols, 涂色份数=filled, 总格数=rows×cols).
 *
 * 微课①（半径与直径）does NOT use this family: it renders the cylinder base
 * circle (rondo.cylinder@1 top-view projection, SetDimension(RADIUS) already
 * registered), so it adds no new scene surface.
 *
 * Renderer-visible: no server/sqlite/Node imports.
 */
import { z } from 'zod';
import { nonNegativeIntSchema } from './protocol';

export const GRID_RENDERER_ID = 'rondo.gridboard' as const;
export const GRID_RENDERER_CONTRACT_VERSION = '1' as const;

/** Max board dimension (rows/cols); the state stays a teaching-scale board. */
export const GRID_MAX_DIM = 24;
/** Max cells (24×24); `filled` is bounded by the actual rows×cols at apply. */
export const GRID_MAX_CELLS = GRID_MAX_DIM * GRID_MAX_DIM;

export const GRID_ROWS_MIN = 1;
export const GRID_COLS_MIN = 1;

export const gridBoardStateV1Schema = z
  .object({
    rows: z.number().int().min(GRID_ROWS_MIN).max(GRID_MAX_DIM),
    cols: z.number().int().min(GRID_COLS_MIN).max(GRID_MAX_DIM),
    filled: z.number().int().min(0).max(GRID_MAX_CELLS),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (state.filled > state.rows * state.cols) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `filled (${state.filled}) exceeds rows*cols (${state.rows * state.cols})`,
      });
    }
  });

export type GridBoardStateV1 = z.infer<typeof gridBoardStateV1Schema>;

export function parseGridBoardStateV1(input: unknown): GridBoardStateV1 {
  return gridBoardStateV1Schema.parse(input);
}

export function safeParseGridBoardStateV1(input: unknown): z.SafeParseReturnType<unknown, GridBoardStateV1> {
  return gridBoardStateV1Schema.safeParse(input);
}

export const GRID_OPERATION_TYPES = ['SetGridSize', 'SetFilled', 'ScaleBoth'] as const;
export type GridOperationType = (typeof GRID_OPERATION_TYPES)[number];

/**
 * Typed operations for the grid-board family. All travel through the existing
 * learning.commitOperation channel; no new command kinds, no new error codes.
 * - SetGridSize: set the row and/or column count (at least one field; the
 *   server clamps `filled` down when the board shrinks below it).
 * - SetFilled: set the marked-cell count (0..rows×cols at apply time).
 * - ScaleBoth: multiply cols AND filled by 2|3|4 (等值缩放操作——分子分母同乘),
 *   keeping rows unchanged; rejected when cols×m > GRID_MAX_DIM or filled×m
 *   would exceed the board.
 */
export const gridOperationV1Schema = z
  .union([
    z
      .object({
        type: z.literal('SetGridSize'),
        rows: z.number().int().min(GRID_ROWS_MIN).max(GRID_MAX_DIM).optional(),
        cols: z.number().int().min(GRID_COLS_MIN).max(GRID_MAX_DIM).optional(),
      })
      .strict(),
    z
      .object({ type: z.literal('SetFilled'), count: nonNegativeIntSchema })
      .strict(),
    z
      .object({ type: z.literal('ScaleBoth'), multiplier: z.union([z.literal(2), z.literal(3), z.literal(4)]) })
      .strict(),
  ])
  .superRefine((op, ctx) => {
    if (op.type === 'SetGridSize' && op.rows === undefined && op.cols === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'SetGridSize requires rows or cols' });
    }
  });

export type GridOperationV1 = z.infer<typeof gridOperationV1Schema>;

export function parseGridOperationV1(input: unknown): GridOperationV1 {
  return gridOperationV1Schema.parse(input);
}

export function safeParseGridOperationV1(input: unknown): z.SafeParseReturnType<unknown, GridOperationV1> {
  return gridOperationV1Schema.safeParse(input);
}

/** Applies an operation to a state (pure; range checks per the schema notes). Returns null when out of range. */
export function applyGridOperation(state: GridBoardStateV1, op: GridOperationV1): GridBoardStateV1 | null {
  switch (op.type) {
    case 'SetGridSize': {
      const rows = op.rows ?? state.rows;
      const cols = op.cols ?? state.cols;
      return { rows, cols, filled: Math.min(state.filled, rows * cols) };
    }
    case 'SetFilled': {
      if (op.count > state.rows * state.cols) return null;
      return { ...state, filled: op.count };
    }
    case 'ScaleBoth': {
      const cols = state.cols * op.multiplier;
      const filled = state.filled * op.multiplier;
      if (cols > GRID_MAX_DIM) return null;
      return { ...state, cols, filled };
    }
    default: {
      const exhaustive: never = op;
      void exhaustive;
      return null;
    }
  }
}
