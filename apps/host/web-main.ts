/**
 * Rondo Host browser entry (standalone Node, no Electron).
 *
 * Started by scripts/start-web.mjs (or directly with the env below): boots the
 * SAME static-profile discipline through dsh-app-boot, wires the SAME learning
 * services (single SQLite connection -> content -> auth -> learning server),
 * then serves the public web dist and the frozen op routes over the DSH web
 * server on a loopback address through services/web-gateway.ts. The desktop
 * entry (apps/host/main.ts) is untouched; both entries share the profile
 * services and differ only in transport.
 *
 * Env contract (mirrors the desktop host whitelist):
 * - RONDO_DATA_ROOT    absolute; learning SQLite + technical logs live here
 * - RONDO_CONTENT_ROOT absolute; dist/content (B release layout, incl. private)
 * - RONDO_WEB_ROOT     optional absolute; public web dist (default dist/web
 *                      beside this bundle)
 *
 * Lifecycle: SIGINT/SIGTERM run the same close order as the desktop host
 * (router freeze -> settle in-flight -> closeBusiness -> closeConnection ->
 * dispose tree -> exit); there is no parent port, so the process owns its own
 * shutdown. Recovery on an existing data root re-verifies the schema identity
 * before READY, exactly like the desktop entry.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFailLoud } from '@deepseek-ai/dsh-app-boot';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { PROTOCOL_VERSION } from '../../modules/contracts/public/protocol';
import type { HostPhase } from '../../modules/contracts/public/desktop';
import { bootHost, disposeHostTree, CompositionRefusal, WEB_PROFILE_ENTRIES } from './composition';
import { setHostRuntime } from './runtime';
import type { RondoLearningCloseReport } from './services/learning-wiring';
import { rondoOpError } from './services/ipc-router';
import { rondoError } from '../../modules/contracts/public/errors';
import type { WebPlatformInfo } from './services/web-gateway';

installFailLoud('rondo-host');

const dataRoot = process.env['RONDO_DATA_ROOT'];
if (!dataRoot || !dataRoot.startsWith('/')) {
  process.stderr.write('rondo-web-host: RONDO_DATA_ROOT must be an absolute path\n');
  process.exit(2);
}
const contentRoot = process.env['RONDO_CONTENT_ROOT'];
if (!contentRoot || !contentRoot.startsWith('/')) {
  process.stderr.write('rondo-web-host: RONDO_CONTENT_ROOT must be an absolute path\n');
  process.exit(2);
}

const hostDir = dirname(fileURLToPath(import.meta.url));
const webRoot = process.env['RONDO_WEB_ROOT'] && process.env['RONDO_WEB_ROOT'].startsWith('/')
  ? process.env['RONDO_WEB_ROOT']
  : join(dirname(hostDir), 'web');

const logsDir = join(dataRoot, 'technical', 'logs');
mkdirSync(logsDir, { recursive: true });

function log(event: string, facts: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: Date.now(), event, ...facts });
  try {
    appendFileSync(join(logsDir, 'host-lifecycle.log'), `${line}\n`);
  } catch {
    process.stderr.write(`rondo-web-host: log write failed for ${event}\n`);
  }
}

const hostEpoch = randomUUID();
setHostRuntime({ dataRoot, hostEpoch, contentRoot, webRoot });

const configPath = join(hostDir, 'cordis-web.yml');
const learningDbPath = join(dataRoot, 'learning', 'learning.sqlite');
const startedFromExistingRoot = existsSync(learningDbPath);

function readDshFamily(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('@deepseek-ai/dsh-app-boot/package.json') as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

interface HostState {
  phase: HostPhase;
  frozenReason: string | null;
  ctx: Context | null;
  lastCloseReport: RondoLearningCloseReport | null;
}

const state: HostState = { phase: 'STARTING', frozenReason: null, ctx: null, lastCloseReport: null };
let activeServices: readonly string[] = [];
let shuttingDown = false;

function status(): Record<string, unknown> {
  return {
    hostPhase: state.phase,
    canAcceptCommands: state.phase === 'READY' && state.frozenReason === null,
    pendingUnknownCommands: false,
    unsavedDraftCount: 0,
    activeServices,
  };
}

const startedAt = Date.now();
log('web-host-starting', { hostEpoch, dataRoot, contentRoot, webRoot, startedFromExistingRoot });

let ctx: Context;
try {
  const booted = await bootHost(configPath, WEB_PROFILE_ENTRIES);
  ctx = booted.ctx;
  activeServices = booted.activeServices;
  state.ctx = ctx;
} catch (err) {
  const refusal = err instanceof CompositionRefusal ? err.code : 'BOOT_FAILED';
  const detail = err instanceof Error ? err.message : String(err);
  log('web-host-boot-failed', { refusal, detail });
  process.stderr.write(`rondo-web-host: boot refused READY (${refusal}): ${detail}\n`);
  process.exit(3);
}

// Same learning wiring as the desktop host: single connection, content
// releases, auth, learning server, full router surface. Any throw refuses READY.
const learning = ctx.rondoLearning;
try {
  await learning.initialize();
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  log('learning-wiring-failed', { detail });
  process.stderr.write(`rondo-web-host: learning wiring refused READY: ${detail}\n`);
  process.exit(3);
}

if (startedFromExistingRoot) {
  state.phase = 'RECOVERING';
  log('web-host-recovering', { hostEpoch });
  try {
    const verified = learning.verifyRecovery();
    log('web-host-recovery-verified', { schemaVersion: verified.schemaVersion, sqliteVersion: verified.sqliteVersion });
  } catch (err) {
    log('web-host-recovery-failed', { detail: (err as Error).message });
    process.stderr.write(`rondo-web-host: recovery refused READY: ${(err as Error).message}\n`);
    process.exit(4);
  }
}
state.phase = 'READY';

// Lifecycle ops through the same register seam the desktop host uses.
ctx.rondoRouter.register('status', () => status());

// Browser platform facts: honest runtime readback, no desktop claims
// (electronVersion etc. are intentionally absent — this is not a desktop).
ctx.rondoWebGateway.setPlatformInfoProvider(async (): Promise<WebPlatformInfo> => {
  if (state.phase !== 'READY') {
    throw rondoOpError(rondoError('INVALID_OPERATION', `Host 未就绪（${state.phase}）。`));
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    surface: 'web',
    hostPhase: state.phase,
    hostEpoch,
    nodeVersion: process.versions.node,
    sqliteVersion: learning.sqliteVersion(),
    dshFamily: readDshFamily(),
    activeServices,
    schemaVersion: learning.schemaVersion(),
    registeredReleases: [...learning.registeredReleases],
    guardianConfigured: await learning.guardianConfigured(),
  };
});

const origin = ctx.webServer.getOrigin();
const identityFacts = {
  hostEpoch,
  nodeVersion: process.versions.node,
  sqliteVersion: learning.sqliteVersion(),
  dshFamily: readDshFamily(),
  activeServices,
  schemaVersion: learning.schemaVersion(),
  startedFromExistingRoot,
  bootMs: Date.now() - startedAt,
  registeredReleases: [...learning.registeredReleases],
  contentGaps: learning.contentGaps.map((gap) => ({ releaseId: gap.releaseId, code: gap.code })),
  guardianConfigured: await learning.guardianConfigured(),
};
log('web-host-ready', { hostEpoch, origin, identity: identityFacts });
process.stdout.write(`Rondo 浏览器入口已就绪: ${origin}/\n`);
process.stdout.write(`  数据根: ${dataRoot}\n  内容根: ${contentRoot}\n  Web 根: ${webRoot}\n`);

async function shutdown(mode: 'DRAIN' | 'CANCEL', signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  state.phase = 'QUIESCING';
  state.frozenReason = `shutdown:${mode}`;
  ctx.rondoRouter.freeze(`shutdown:${mode}`);
  log('web-host-quiescing', { hostEpoch, mode, signal });
  if (mode === 'DRAIN') {
    const remaining = await ctx.rondoRouter.settleInFlight(5000);
    if (remaining > 0) log('web-host-drain-remaining', { remaining });
  }
  let closeReport: RondoLearningCloseReport;
  try {
    closeReport = await learning.closeBusiness();
    state.lastCloseReport = closeReport;
    log('web-host-db-closed', { hostEpoch, closeReport });
  } catch (err) {
    log('web-host-db-close-failed', { detail: (err as Error).message });
    process.exit(5);
  }
  learning.closeConnection();
  try {
    await ctx.parallel('exit', 'SIGTERM');
  } catch (err) {
    log('web-host-exit-event-failed', { detail: (err as Error).message });
  }
  await disposeHostTree(ctx);
  state.phase = 'STOPPED';
  log('web-host-exit', { hostEpoch, mode, closeReport });
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown('DRAIN', signal).catch(() => process.exit(6));
  });
}
