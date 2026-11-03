/**
 * Rondo Host utility-process entry.
 *
 * Started exclusively by Desktop Main via utilityProcess.fork with a fixed
 * entry path, an independent data root, the packaged content root and an
 * environment whitelist (see apps/desktop/host-supervisor.ts). Never resolves
 * Node or config through the user PATH, never reads a default DSH profile/.env
 * (loadEnv / loadLayeredEnv are not called; Main redirects HOME inside the
 * Rondo data root so no user ~/.dsh layer can exist).
 *
 * Wire behavior (apps/host/envelope.ts): epoch-bound requests, ready
 * handshake with runtime-read identity facts, status/shutdown lifecycle ops,
 * everything else dispatched through the approved router service.
 *
 * integrated/ wiring: the single business SQLite connection, the content
 * service, local auth and the learning server are assembled by the
 * rondoLearning profile service (apps/host/services/learning-wiring.ts).
 * Shutdown follows B-INTEGRATION §close: router freeze -> server.close ->
 * content.close -> storage.close (CloseReport logged) -> storage.closeConnection
 * -> dispose Host tree -> exit.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFailLoud } from '@deepseek-ai/dsh-app-boot';
import type { Context } from '@deepseek-ai/cordis';
import { PROTOCOL_VERSION } from '../../modules/contracts/public/protocol';
import type { HostPhase } from '../../modules/contracts/public/desktop';
import { bootHost, disposeHostTree, CompositionRefusal } from './composition';
import { setHostRuntime } from './runtime';
import type { RondoLearningCloseReport } from './services/learning-wiring';
import type { RondoOpError } from './services/ipc-router';
import {
  HOST_WIRE_VERSION,
  parseHostWireRequest,
  type HostIdentityReport,
  type HostInternalStatus,
  type HostWireError,
  type HostWireRequest,
  type HostWireResponse,
} from './envelope';

installFailLoud('rondo-host');

// Electron utility-process port, narrowed locally: @types/node does not know
// it and the Electron d.ts augmentation must not leak into the host bundle.
interface HostParentPort {
  on(event: 'message', listener: (event: { data?: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  postMessage(message: unknown): void;
}

const parentPort: HostParentPort = (process as unknown as { parentPort: HostParentPort }).parentPort;

const dataRoot = process.env['RONDO_DATA_ROOT'];
if (!dataRoot || !dataRoot.startsWith('/')) {
  process.stderr.write('rondo-host: RONDO_DATA_ROOT must be an absolute path\n');
  process.exit(2);
}
const contentRoot = process.env['RONDO_CONTENT_ROOT'];
if (!contentRoot || !contentRoot.startsWith('/')) {
  process.stderr.write('rondo-host: RONDO_CONTENT_ROOT must be an absolute path\n');
  process.exit(2);
}

const logsDir = join(dataRoot, 'technical', 'logs');
mkdirSync(logsDir, { recursive: true });

function log(event: string, facts: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: Date.now(), event, ...facts });
  try {
    appendFileSync(join(logsDir, 'host-lifecycle.log'), `${line}\n`);
  } catch {
    process.stderr.write(`rondo-host: log write failed for ${event}\n`);
  }
}

const hostEpoch = randomUUID();
setHostRuntime({ dataRoot, hostEpoch, contentRoot });

const hostDir = dirname(fileURLToPath(import.meta.url));
const configPath = join(hostDir, 'cordis.yml');
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
let shuttingDown = false;

function status(): HostInternalStatus {
  return {
    hostPhase: state.phase,
    canAcceptCommands: state.phase === 'READY' && state.frozenReason === null,
    pendingUnknownCommands: false,
    unsavedDraftCount: 0,
    activeServices: activeServicesView(),
  };
}

let activeServices: readonly string[] = [];
function activeServicesView(): readonly string[] {
  return activeServices;
}

const startedAt = Date.now();
log('host-starting', { hostEpoch, dataRoot, contentRoot, startedFromExistingRoot });

let ctx: Context;
try {
  const booted = await bootHost(configPath);
  ctx = booted.ctx;
  activeServices = booted.activeServices;
  state.ctx = ctx;
} catch (err) {
  const refusal = err instanceof CompositionRefusal ? err.code : 'BOOT_FAILED';
  const detail = err instanceof Error ? err.message : String(err);
  log('host-boot-failed', { refusal, detail });
  process.stderr.write(`rondo-host: boot refused READY (${refusal}): ${detail}\n`);
  process.exit(3);
}

// Real learning wiring (storage -> content -> auth -> server -> retention ->
// full router surface). Any throw refuses READY.
try {
  await ctx.rondoLearning.initialize();
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  log('learning-wiring-failed', { detail });
  process.stderr.write(`rondo-host: learning wiring refused READY: ${detail}\n`);
  process.exit(3);
}

// Recovery step: reopening an existing root re-verifies the schema identity
// before the Host reports READY (ARCHITECTURE §6/§8 recovery entry).
const learning = ctx.rondoLearning;
if (startedFromExistingRoot) {
  state.phase = 'RECOVERING';
  log('host-recovering', { hostEpoch });
  try {
    const verified = learning.verifyRecovery();
    log('host-recovery-verified', { schemaVersion: verified.schemaVersion, sqliteVersion: verified.sqliteVersion });
  } catch (err) {
    log('host-recovery-failed', { detail: (err as Error).message });
    process.stderr.write(`rondo-host: recovery refused READY: ${(err as Error).message}\n`);
    process.exit(4);
  }
}
state.phase = 'READY';

const identity: HostIdentityReport = {
  hostPhase: 'READY',
  hostEpoch,
  nodeVersion: process.versions.node,
  electronVersion: process.versions.electron ?? null,
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
log('host-ready', { hostEpoch, identity });
parentPort.postMessage({
  direction: 'ready',
  wireVersion: HOST_WIRE_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  hostEpoch,
  identity,
});

// Lifecycle ops are registered by the host itself through the same register
// seam business services use (duplicate registration would have refused READY).
ctx.rondoRouter.register('status', () => status());

function toWireError(err: unknown): HostWireError {
  const opError = err as Partial<RondoOpError>;
  if (opError && typeof opError.rondo === 'object' && opError.rondo !== null) {
    const rondo = opError.rondo;
    return { code: rondo.code, message: rondo.message, ...(rondo.context ? { context: rondo.context } : {}) };
  }
  const message = err instanceof Error ? err.message : String(err);
  log('host-internal-error', { message });
  return { code: 'INVALID_OPERATION', message: 'Host 内部错误，已记录技术日志。' };
}

function respond(request: HostWireRequest, ok: boolean, result?: unknown, error?: HostWireError): void {
  const response: HostWireResponse = {
    direction: 'response',
    wireVersion: HOST_WIRE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    hostEpoch,
    kind: request.kind,
    ok,
    ...(ok ? { result } : { error }),
  };
  parentPort.postMessage(response);
}

const SHUTDOWN_MODES = ['DRAIN', 'CANCEL'] as const;
type ShutdownMode = (typeof SHUTDOWN_MODES)[number];

async function shutdown(mode: ShutdownMode, request: HostWireRequest | null): Promise<HostInternalStatus> {
  if (shuttingDown) return status();
  shuttingDown = true;
  state.phase = 'QUIESCING';
  state.frozenReason = `shutdown:${mode}`;
  ctx.rondoRouter.freeze(`shutdown:${mode}`);
  log('host-quiescing', { hostEpoch, mode });
  if (mode === 'DRAIN') {
    const remaining = await ctx.rondoRouter.settleInFlight(5000);
    if (remaining > 0) log('host-drain-remaining', { remaining });
  }
  // "close the database" barrier, B-INTEGRATION §close order:
  // server.close -> content.close -> storage.close (facts logged) ->
  // storage.closeConnection -> dispose Host tree -> exit.
  let closeReport: RondoLearningCloseReport;
  try {
    closeReport = await learning.closeBusiness();
    state.lastCloseReport = closeReport;
    log('host-db-closed', { hostEpoch, closeReport });
  } catch (err) {
    log('host-db-close-failed', { detail: (err as Error).message });
    throw err;
  }
  learning.closeConnection();
  try {
    await ctx.parallel('exit', 'SIGTERM');
  } catch (err) {
    log('host-exit-event-failed', { detail: (err as Error).message });
  }
  await disposeHostTree(ctx);
  const finalStatus = status();
  state.phase = 'STOPPED';
  log('host-exit', { hostEpoch, mode, closeReport });
  if (request) {
    respond(request, true, { closed: true, closeReport, status: finalStatus });
  }
  // Give the parent a moment to observe the ack + exit event, then exit.
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.exit(0);
}

parentPort.on('message', (event) => {
  void handleInbound(event.data);
});

async function handleInbound(value: unknown): Promise<void> {
  const parsed = parseHostWireRequest(value, hostEpoch);
  if (!parsed.ok) {
    log('host-protocol-violation', { reason: parsed.reason });
    return;
  }
  const request = parsed.request;
  if (request.kind === 'shutdown') {
    const payloadRecord =
      typeof request.payload === 'object' && request.payload !== null
        ? (request.payload as Record<string, unknown>)
        : null;
    const modeValue = payloadRecord?.['mode'];
    const mode = SHUTDOWN_MODES.find((candidate) => candidate === modeValue) ?? null;
    if (!mode) {
      respond(request, false, undefined, { code: 'SCHEMA_MISMATCH', message: 'shutdown mode 必须是 DRAIN 或 CANCEL' });
      return;
    }
    try {
      await shutdown(mode, request);
    } catch (err) {
      log('host-shutdown-failed', { detail: (err as Error).message });
      respond(request, false, undefined, toWireError(err));
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.exit(5);
    }
    return;
  }
  try {
    const result = await ctx.rondoRouter.dispatch(request.kind, request.payload);
    respond(request, true, result);
  } catch (err) {
    respond(request, false, undefined, toWireError(err));
  }
}

// Parent went away (Main quit or crashed): leave gracefully, DB close via dispose hook.
parentPort.on('close', () => {
  if (!shuttingDown) {
    void shutdown('CANCEL', null).catch(() => process.exit(6));
  }
});
