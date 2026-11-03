/**
 * Runtime parameters injected by apps/host/main.ts BEFORE boot() and read by
 * the profile services at init. Keeps cordis.yml purely static (the frozen
 * "static profile" requirement) while still passing runtime facts like the
 * data root that only Main knows.
 *
 * State lives on globalThis because each profile service is a SEPARATE esbuild
 * bundle: a plain module variable would exist once per bundle, and the
 * setter (host main) and readers (services) would see different copies.
 */
export interface HostRuntimeParams {
  readonly dataRoot: string;
  readonly hostEpoch: string;
  /**
   * Built content root (dist/content, B release layout) handed in by Desktop
   * Main through the env whitelist (RONDO_CONTENT_ROOT). The packaged content
   * directory in dev builds points at the project build product.
   */
  readonly contentRoot: string;
  /**
   * Public web dist root (dist/web) served by the web gateway's static
   * fallback. Set only by the browser entry (apps/host/web-main.ts); the
   * desktop host never serves HTTP.
   */
  readonly webRoot?: string;
}

const GLOBAL_KEY = '__RONDO_HOST_RUNTIME__';

export function setHostRuntime(params: HostRuntimeParams): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = params;
}

export function getHostRuntime(): HostRuntimeParams {
  const current = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as HostRuntimeParams | undefined;
  if (!current) {
    throw new Error('HOST_RUNTIME_UNSET: services may only initialize after main.ts set the runtime params');
  }
  return current;
}
