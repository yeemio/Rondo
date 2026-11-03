/**
 * DesktopPort: fixed desktop actions, closed set.
 *
 * Frozen sources:
 * - LIFECYCLE-DATA-API.md §5 (file selection / export / quit belong to a
 *   narrow desktop port; no arbitrary IPC channel, path, or command strings)
 * - ARCHITECTURE.md §10 / LIFECYCLE §10 (desktop state machine and quit flow)
 * - H0-SPEC.md §1 desktop.ts
 *
 * saveExport takes only an opaque server-issued preparedExportRef; the
 * destination comes from the system save dialog, never from the renderer.
 */
import { z } from 'zod';
import { idSchema } from './protocol';

export const saveExportInputSchema = z
  .object({ preparedExportRef: idSchema })
  .strict();

export type SaveExportInput = z.infer<typeof saveExportInputSchema>;

export function parseSaveExportInput(input: unknown): SaveExportInput {
  return saveExportInputSchema.parse(input);
}

export function safeParseSaveExportInput(input: unknown): z.SafeParseReturnType<unknown, SaveExportInput> {
  return saveExportInputSchema.safeParse(input);
}

/** Only the explicit export categories may cross the browser export transport. */
export const browserExportPayloadSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.number().int().nonnegative(), scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  categories: z.object({
    ALIASES: z.array(z.unknown()).optional(), CONTENT_VERSIONS: z.array(z.unknown()).optional(),
    PROCESS: z.array(z.unknown()).optional(), SUBMISSIONS: z.array(z.unknown()).optional(),
    FEEDBACK: z.array(z.unknown()).optional(), EXPLANATIONS: z.array(z.unknown()).optional(),
    GUARDIAN_ANNOTATIONS: z.array(z.unknown()).optional(),
  }).strict(),
}).strict();

export const browserExportFileSchema = z.object({
  name: z.string().min(1).max(500), type: z.enum(['application/json;charset=utf-8', 'text/plain;charset=utf-8']), text: z.string(),
}).strict();
export type BrowserExportFile = z.infer<typeof browserExportFileSchema>;

export const saveExportResultSchema = z
  .object({
    saved: z.boolean(),
    /** Browser downloads cannot establish disk persistence. Legacy desktop saved=true remains supported. */
    delivery: z.enum(['READY', 'DOWNLOAD_INITIATED', 'CANCELLED', 'FAILED']).optional(),
    detail: z.string().max(500).optional(),
    files: z.array(browserExportFileSchema).length(2).optional(),
    /** User-facing label of where the export landed (display only, not a path API). */
    savedToLabel: z.string().min(1).max(500).optional(),
  })
  .strict()
  .refine((value) => !value.delivery || !value.saved, 'Browser delivery cannot assert disk persistence.');

export type SaveExportResult = z.infer<typeof saveExportResultSchema>;

export function parseSaveExportResult(input: unknown): SaveExportResult {
  return saveExportResultSchema.parse(input);
}

export function safeParseSaveExportResult(input: unknown): z.SafeParseReturnType<unknown, SaveExportResult> {
  return saveExportResultSchema.safeParse(input);
}

export const QUIT_FLOW_PHASES = ['IDLE', 'PROMPTING', 'SAVING', 'COMPLETING', 'COMPLETED', 'CANCELLED'] as const;
export type QuitFlowPhase = (typeof QUIT_FLOW_PHASES)[number];

export const quitFlowStateSchema = z
  .object({ phase: z.enum(QUIT_FLOW_PHASES) })
  .strict();

export type QuitFlowState = z.infer<typeof quitFlowStateSchema>;

export function parseQuitFlowState(input: unknown): QuitFlowState {
  return quitFlowStateSchema.parse(input);
}

export function safeParseQuitFlowState(input: unknown): z.SafeParseReturnType<unknown, QuitFlowState> {
  return quitFlowStateSchema.safeParse(input);
}

export const HOST_PHASES = [
  'STARTING',
  'RECOVERING',
  'READY',
  'QUIESCING',
  'STOPPED',
  'START_FAILED',
  'RECOVERY_REQUIRED',
] as const;
export type HostPhase = (typeof HOST_PHASES)[number];

export const hostStatusSchema = z
  .object({
    hostPhase: z.enum(HOST_PHASES),
    canAcceptCommands: z.boolean(),
    /** True when at least one write command is in delivery-unknown state (receipt not confirmed). */
    pendingUnknownCommands: z.boolean(),
  })
  .strict();

export type HostStatusProjection = z.infer<typeof hostStatusSchema>;

export function parseHostStatus(input: unknown): HostStatusProjection {
  return hostStatusSchema.parse(input);
}

export function safeParseHostStatus(input: unknown): z.SafeParseReturnType<unknown, HostStatusProjection> {
  return hostStatusSchema.safeParse(input);
}

export interface DesktopPort {
  saveExport(input: SaveExportInput): Promise<SaveExportResult>;
  requestQuit(): Promise<QuitFlowState>;
  cancelQuit(): Promise<QuitFlowState>;
  hostStatus(): Promise<HostStatusProjection>;
}
