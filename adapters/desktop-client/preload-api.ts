/**
 * The exact fixed function surface preload.cts exposes on window. Fixed
 * names, fixed argument shapes — no arbitrary channel, path or command
 * strings anywhere (frozen preload requirement).
 *
 * Renderer-safe types only.
 */
import type { IpcResult } from './ipc-result';

export interface RondoPreloadApi {
  command(envelope: unknown): Promise<IpcResult<unknown>>;
  query(request: unknown): Promise<IpcResult<unknown>>;
  receipt(request: unknown): Promise<IpcResult<unknown>>;
  subscribeInvalidation(cb: (notice: unknown) => void): () => void;
}

export interface RondoAuthPreloadApi {
  setupGuardian(input: unknown): Promise<IpcResult<unknown>>;
  unlockGuardian(input: unknown): Promise<IpcResult<unknown>>;
  enterLearner(input: unknown): Promise<IpcResult<unknown>>;
  lock(): Promise<IpcResult<unknown>>;
  session(): Promise<IpcResult<unknown>>;
}

export interface RondoDesktopPreloadApi {
  saveExport(input: unknown): Promise<IpcResult<unknown>>;
  requestQuit(): Promise<IpcResult<unknown>>;
  cancelQuit(): Promise<IpcResult<unknown>>;
  hostStatus(): Promise<IpcResult<unknown>>;
}

/**
 * Fixed desktop-shell diagnostics surface (A-owned, R0 evidence): runtime
 * identity readback through the narrow IPC. Not part of the frozen business
 * contracts; reported to the coordinator as a candidate contract addition.
 */
export interface RondoPlatformPreloadApi {
  info(): Promise<IpcResult<unknown>>;
}

/**
 * The R2 view channel surface (closed `rondo:view:<op>` set). Fixed op names,
 * fixed argument shapes — same discipline as the other preload faces.
 */
export interface RondoViewPreloadApi {
  getEvaluation(input: { cycleId: string }): Promise<IpcResult<unknown>>;
  getHints(input: { cycleId: string }): Promise<IpcResult<unknown>>;
  getReviewCard(input: { cycleId: string }): Promise<IpcResult<unknown>>;
  getMigration(input: { learnerId: string }): Promise<IpcResult<unknown>>;
  getTimelineDetail(input: { attemptId: string }): Promise<IpcResult<unknown>>;
  listLearners(input: Record<string, never>): Promise<IpcResult<unknown>>;
  listAttempts(input: { learnerId?: string }): Promise<IpcResult<unknown>>;
  registerExplanationRevision(input: { cycleId: string }): Promise<IpcResult<unknown>>;
  getLastDeletionScopeHash(input: Record<string, never>): Promise<IpcResult<unknown>>;
  nowMs(input: Record<string, never>): Promise<IpcResult<unknown>>;
}

export interface RondoWindowApi {
  Rondo: RondoPreloadApi;
  RondoAuth: RondoAuthPreloadApi;
  RondoDesktop: RondoDesktopPreloadApi;
  RondoPlatform: RondoPlatformPreloadApi;
}

/**
 * The aggregate `window.rondo` bundle the product entry consumes
 * (apps/web/src/client/ports.ts productPorts). client/auth/desktop reuse the
 * exact fixed surfaces above; view is the R2 closed op set.
 */
export interface RondoBundlePreloadApi {
  client: RondoPreloadApi;
  auth: RondoAuthPreloadApi;
  desktop: RondoDesktopPreloadApi;
  view: RondoViewPreloadApi;
  platform: RondoPlatformPreloadApi;
}
