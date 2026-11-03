/**
 * Desktop Main IPC routes: the fixed channel set, sender/frame/origin
 * assertion on EVERY invoke, and per-message schema validation with the
 * frozen public contracts before anything reaches the Host.
 *
 * Frozen security requirements (ARCHITECTURE §6 / A-PLATFORM item 3):
 * - sender must be the trusted main window's webContents AND the main frame;
 * - frame URL must be the rondo://app origin (hash-insensitive);
 * - unknown senders surface UNKNOWN_RENDERER, schema failures SCHEMA_MISMATCH;
 * - there is no generic invoke channel: each channel is a literal below.
 */
import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent, WebFrameMain } from 'electron';
import { safeParseEnvelope } from '../../modules/contracts/public/envelope';
import { commandKindSchema } from '../../modules/contracts/public/envelope';
import { idSchema } from '../../modules/contracts/public/protocol';
import { safeParsePublicQuery } from '../../modules/contracts/public/queries';
import {
  safeParseEnterLearnerInput,
  safeParseSetupGuardianInput,
  safeParseUnlockGuardianInput,
} from '../../modules/contracts/public/auth';
import { safeParseSaveExportInput } from '../../modules/contracts/public/desktop';
import { rondoError, rondoErrorCodeSchema } from '../../modules/contracts/public/errors';
import type { RondoError } from '../../modules/contracts/public/errors';
import { HOST_TRANSPORT_CODES, type HostTransportCode } from '../host/envelope';
import { ipcErr, ipcOk, type IpcResult } from '../../adapters/desktop-client/ipc-result';
import type { HostSupervisor } from './host-supervisor';
import type { LifecycleLog } from './lifecycle-log';
import type { QuitFlowController } from './quit-flow-controller';
import type { PlatformInfo } from '../../adapters/desktop-client/platform-info';

export const APP_ORIGIN = 'rondo://app';

type WireError = { code: string; message: string; context?: Record<string, string | number | boolean | null> };

function errFromWire(error: WireError, transport: string | undefined): IpcResult<never> {
  const codeCheck = rondoErrorCodeSchema.safeParse(error.code);
  const asRondo = rondoError(
    codeCheck.success ? codeCheck.data : 'INVALID_OPERATION',
    error.message,
    error.context,
  );
  const transportCheck =
    transport !== undefined && (HOST_TRANSPORT_CODES as readonly string[]).includes(transport)
      ? (transport as HostTransportCode)
      : undefined;
  return ipcErr(asRondo, transportCheck);
}

export interface IpcRouteDeps {
  getWindow(): BrowserWindow | null;
  supervisor: HostSupervisor;
  quitFlow: QuitFlowController;
  platformInfo(): PlatformInfo;
  log: LifecycleLog;
  /** Opens the system save dialog for a Host-confirmed export (Main-owned destination; renderer never supplies a path). */
  saveExportViaDialog(window: BrowserWindow, preparedExportRef: string): Promise<IpcResult<unknown>>;
}

function assertTrustedSender(event: IpcMainInvokeEvent, deps: IpcRouteDeps): IpcResult<never> | null {
  const window = deps.getWindow();
  if (!window || event.sender !== window.webContents) {
    deps.log.write('ipc-sender-denied', { reason: 'sender' });
    return ipcErr(rondoError('UNKNOWN_RENDERER', '未信任的消息来源。'));
  }
  const frame: WebFrameMain | null = event.senderFrame;
  if (!frame || frame !== window.webContents.mainFrame) {
    deps.log.write('ipc-sender-denied', { reason: 'frame' });
    return ipcErr(rondoError('UNKNOWN_RENDERER', '仅接受主帧消息。'));
  }
  const url = frame.url.replace(/#.*$/, '');
  // Trusted frame paths: the product entry, and (check harness only) the
  // transport probe fixture served from the same rondo://app origin. The
  // probe page is loaded by Desktop Main itself in RONDO_CHECK_DESKTOP mode
  // (apps/desktop/main.ts) — it is never reachable in a product run.
  const probeAllowed = process.env.RONDO_CHECK_DESKTOP === '1';
  const trustedUrls = [`${APP_ORIGIN}/`, `${APP_ORIGIN}/index.html`];
  if (probeAllowed) trustedUrls.push(`${APP_ORIGIN}/__probe/index.html`);
  if (!trustedUrls.includes(url)) {
    deps.log.write('ipc-sender-denied', { reason: 'origin', url });
    return ipcErr(rondoError('UNKNOWN_RENDERER', '消息来源协议/来源不符。'));
  }
  return null;
}

async function callHost(
  deps: IpcRouteDeps,
  kind: Parameters<HostSupervisor['request']>[0],
  payload: unknown,
): Promise<IpcResult<unknown>> {
  try {
    const result = await deps.supervisor.request(kind, payload);
    return ipcOk(result);
  } catch (error) {
    const wire = (error as { hostError?: WireError }).hostError ?? {
      code: 'INVALID_OPERATION',
      message: error instanceof Error ? error.message : String(error),
    };
    return errFromWire(wire, (error as { transport?: string }).transport);
  }
}

function schemaError(domain: string): IpcResult<never> {
  return ipcErr(rondoError('SCHEMA_MISMATCH', `${domain}未通过 schema 校验。`));
}

export function registerDesktopIpc(deps: IpcRouteDeps): void {
  const guard = (event: IpcMainInvokeEvent): IpcResult<never> | null => assertTrustedSender(event, deps);

  ipcMain.handle('rondo:command', async (event, envelope: unknown): Promise<IpcResult<unknown>> => {
    const denied = guard(event);
    if (denied) return denied;
    const parsed = safeParseEnvelope(envelope);
    if (!parsed.success) return schemaError('命令信封');
    return await callHost(deps, 'command', parsed.data);
  });

  ipcMain.handle('rondo:query', async (event, request: unknown): Promise<IpcResult<unknown>> => {
    const denied = guard(event);
    if (denied) return denied;
    const parsed = safeParsePublicQuery(request);
    if (!parsed.success) return schemaError('查询请求');
    return await callHost(deps, 'query', parsed.data);
  });

  ipcMain.handle(
    'rondo:receipt',
    async (event, request: unknown): Promise<IpcResult<unknown>> => {
      const denied = guard(event);
      if (denied) return denied;
      if (typeof request !== 'object' || request === null) return schemaError('回执查询');
      const record = request as Record<string, unknown>;
      const key = idSchema.safeParse(record['idempotencyKey']);
      const kind = commandKindSchema.safeParse(record['commandKind']);
      if (!key.success || !kind.success) return schemaError('回执查询');
      return await callHost(deps, 'receipt', { idempotencyKey: key.data, commandKind: kind.data });
    },
  );

  const authChannel = (
    channel: string,
    op: 'auth.setupGuardian' | 'auth.unlockGuardian' | 'auth.enterLearner' | 'auth.lock' | 'auth.session',
    validate: (input: unknown) => boolean,
  ): void => {    ipcMain.handle(channel, async (event, input: unknown): Promise<IpcResult<unknown>> => {
      const denied = guard(event);
      if (denied) return denied;
      if (validate(input)) return await callHost(deps, op, input);
      return schemaError('认证操作');
    });
  };

  authChannel('rondo:auth:setupGuardian', 'auth.setupGuardian', (input) => safeParseSetupGuardianInput(input).success);
  authChannel('rondo:auth:unlockGuardian', 'auth.unlockGuardian', (input) => safeParseUnlockGuardianInput(input).success);
  authChannel('rondo:auth:enterLearner', 'auth.enterLearner', (input) => safeParseEnterLearnerInput(input).success);
  authChannel('rondo:auth:lock', 'auth.lock', () => true);
  authChannel('rondo:auth:session', 'auth.session', () => true);

  ipcMain.handle('rondo:desktop:saveExport', async (event, input: unknown): Promise<IpcResult<unknown>> => {
    const denied = guard(event);
    if (denied) return denied;
    const parsed = safeParseSaveExportInput(input);
    if (!parsed.success) return schemaError('导出请求');
    // Destination is chosen by the system dialog in Main; the renderer only
    // supplies the opaque server-issued ref.
    const window = deps.getWindow();
    if (!window) return ipcErr(rondoError('UNKNOWN_RENDERER', '窗口不可用。'));
    return await deps.saveExportViaDialog(window, parsed.data.preparedExportRef);
  });

  ipcMain.handle('rondo:desktop:requestQuit', async (event): Promise<IpcResult<unknown>> => {
    const denied = guard(event);
    if (denied) return denied;
    return ipcOk({ phase: await deps.quitFlow.requestQuit() });
  });

  ipcMain.handle('rondo:desktop:cancelQuit', async (event): Promise<IpcResult<unknown>> => {
    const denied = guard(event);
    if (denied) return denied;
    return ipcOk({ phase: await deps.quitFlow.cancelQuit() });
  });

  ipcMain.handle('rondo:desktop:hostStatus', (event): IpcResult<unknown> => {
    const denied = guard(event);
    if (denied) return denied;
    return ipcOk(deps.quitFlow.hostStatusProjection());
  });

  ipcMain.handle('rondo:platform:info', (event): IpcResult<unknown> => {
    const denied = guard(event);
    if (denied) return denied;
    return ipcOk(deps.platformInfo());
  });

  // -------------------------------------------------------------------------
  // View channels (closed `rondo:view:<op>` set; same sender/frame/origin
  // assertion + zod payload validation as every other channel).
  // -------------------------------------------------------------------------

  const idField = (input: unknown, field: string): string | null => {
    if (typeof input !== 'object' || input === null) return null;
    const parsed = idSchema.safeParse((input as Record<string, unknown>)[field]);
    return parsed.success ? parsed.data : null;
  };

  function viewChannel(
    op: 'view.getEvaluation' | 'view.getHints' | 'view.getReviewCard' | 'view.getMigration' | 'view.getTimelineDetail',
    field: 'cycleId' | 'learnerId' | 'attemptId',
  ): void {
    const channel = `rondo:view:${op.slice('view.'.length)}`;
    ipcMain.handle(channel, async (event, input: unknown): Promise<IpcResult<unknown>> => {
      const denied = guard(event);
      if (denied) return denied;
      const id = idField(input, field);
      if (id === null) return schemaError(`视图查询 ${op}`);
      return await callHost(deps, op, { [field]: id });
    });
  }

  viewChannel('view.getEvaluation', 'cycleId');
  viewChannel('view.getHints', 'cycleId');
  viewChannel('view.getReviewCard', 'cycleId');
  viewChannel('view.getMigration', 'learnerId');
  viewChannel('view.getTimelineDetail', 'attemptId');

  ipcMain.handle('rondo:view:listLearners', async (event): Promise<IpcResult<unknown>> => {
    const denied = guard(event);
    if (denied) return denied;
    return await callHost(deps, 'view.listLearners', {});
  });

  ipcMain.handle('rondo:view:listAttempts', async (event, input: unknown): Promise<IpcResult<unknown>> => {
    const denied = guard(event);
    if (denied) return denied;
    if (input === undefined || input === null || Object.keys(input as object).length === 0) {
      return await callHost(deps, 'view.listAttempts', {});
    }
    const learnerId = idField(input, 'learnerId');
    if (learnerId === null) return schemaError('视图查询 view.listAttempts');
    return await callHost(deps, 'view.listAttempts', { learnerId });
  });

  ipcMain.handle('rondo:view:registerExplanationRevision', async (event, input: unknown): Promise<IpcResult<unknown>> => {
    const denied = guard(event);
    if (denied) return denied;
    const cycleId = idField(input, 'cycleId');
    if (cycleId === null) return schemaError('视图查询 view.registerExplanationRevision');
    return await callHost(deps, 'view.registerExplanationRevision', { cycleId });
  });

  ipcMain.handle('rondo:view:getLastDeletionScopeHash', async (event): Promise<IpcResult<unknown>> => {
    const denied = guard(event);
    if (denied) return denied;
    return await callHost(deps, 'view.getLastDeletionScopeHash', {});
  });

  ipcMain.handle('rondo:view:nowMs', async (event): Promise<IpcResult<unknown>> => {
    const denied = guard(event);
    if (denied) return denied;
    return await callHost(deps, 'view.nowMs', {});
  });
}
