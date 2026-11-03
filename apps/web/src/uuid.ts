/** UUID helper for the renderer (crypto.randomUUID is available in the sandboxed Chromium context). */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}
