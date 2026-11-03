/**
 * Independent Rondo data root under Application Support (frozen ARCHITECTURE
 * §8): Rondo/{learning,content,desktop,technical/dsh,technical/logs,temporary}.
 * Electron's own session storage is redirected into Rondo/desktop so nothing
 * of this app lands in a donor or shared location.
 *
 * The root can be overridden with RONDO_DATA_ROOT (absolute) — used by the
 * desktop check harness to run against a synthetic directory.
 */
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface RondoDataPaths {
  readonly root: string;
  readonly learning: string;
  readonly content: string;
  readonly desktop: string;
  readonly technicalDsh: string;
  readonly technicalLogs: string;
  readonly technicalHome: string;
  readonly temporary: string;
}

export const DATA_SUBDIRS = [
  'learning',
  'content',
  'desktop',
  'technical/dsh',
  'technical/logs',
  'technical/home',
  'temporary',
] as const;

export function resolveDataRoot(appDataDir: string, envOverride: string | undefined): string {
  if (envOverride !== undefined) {
    if (!isAbsolute(envOverride)) {
      throw new Error(`RONDO_DATA_ROOT must be absolute, got: ${envOverride}`);
    }
    return envOverride;
  }
  return join(appDataDir, 'Rondo');
}

export function ensureDataRoot(root: string): RondoDataPaths {
  const paths: RondoDataPaths = {
    root,
    learning: join(root, 'learning'),
    content: join(root, 'content'),
    desktop: join(root, 'desktop'),
    technicalDsh: join(root, 'technical', 'dsh'),
    technicalLogs: join(root, 'technical', 'logs'),
    technicalHome: join(root, 'technical', 'home'),
    temporary: join(root, 'temporary'),
  };
  for (const sub of DATA_SUBDIRS) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  return paths;
}
