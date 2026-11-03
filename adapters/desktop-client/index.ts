/**
 * adapters/desktop-client: maps the fixed preload surface to the frozen
 * typed client contracts (RondoClient / LocalAuthPort / DesktopPort).
 *
 * Responsibilities (and nothing else):
 * - unwrap the IpcResult envelope, surfacing domain errors as typed
 *   RondoClientError (frozen code set) with the transport fact attached;
 * - validate every response with the frozen public zod schemas (defense at
 *   the renderer edge);
 * - implement the delivery-unknown replay rule: a write command whose
 *   transport resolved to RECEIPT_UNKNOWN is NOT resent — the ORIGINAL
 *   idempotency key is replayed through the receipt query; only a CONFIRMED
 *   lookup returns, everything else still surfaces RECEIPT_UNKNOWN to the
 *   caller.
 *
 * No domain rules live here (frozen boundary). Electron-free and injectable
 * for unit tests.
 */
import type { InvalidationNotice, RondoClient, Unsubscribe } from '../../modules/contracts/public/client';
import { safeParseInvalidationNotice } from '../../modules/contracts/public/client';
import type { PublicCommandEnvelope, CommandKind } from '../../modules/contracts/public/envelope';
import { safeParseEnvelope } from '../../modules/contracts/public/envelope';
import type { CommandReceipt, ReceiptLookup } from '../../modules/contracts/public/receipts';
import { safeParseCommandReceipt, safeParseReceiptLookup } from '../../modules/contracts/public/receipts';
import type { PublicProjection, PublicQuery } from '../../modules/contracts/public/queries';
import { safeParsePublicProjection } from '../../modules/contracts/public/queries';
import type {
  AuthSession,
  EnterLearnerInput,
  LocalAuthPort,
  LockResult,
  SetupGuardianInput,
  UnlockGuardianInput,
} from '../../modules/contracts/public/auth';
import { safeParseAuthSession } from '../../modules/contracts/public/auth';
import type {
  DesktopPort,
  HostStatusProjection,
  QuitFlowState,
  SaveExportInput,
  SaveExportResult,
} from '../../modules/contracts/public/desktop';
import {
  safeParseHostStatus,
  safeParseQuitFlowState,
  safeParseSaveExportResult,
} from '../../modules/contracts/public/desktop';
import type { RondoErrorCode } from '../../modules/contracts/public/errors';
import type { IpcResult } from './ipc-result';
import type {
  RondoAuthPreloadApi,
  RondoDesktopPreloadApi,
  RondoPreloadApi,
  RondoPlatformPreloadApi,
} from './preload-api';
import { parsePlatformInfo, type PlatformInfo } from './platform-info';

/** Typed client-facing error. `transport` carries desktop-shell facts (e.g. RECEIPT_UNKNOWN). */
export class RondoClientError extends Error {
  constructor(
    readonly code: RondoErrorCode,
    message: string,
    readonly context?: Record<string, string | number | boolean | null>,
    readonly transport?: string,
  ) {
    super(message);
    this.name = 'RondoClientError';
  }
}

function unwrapError(result: { ok: false; error: { code: string; message: string; context?: Record<string, string | number | boolean | null> }; transport?: string }): never {
  throw new RondoClientError(
    result.error.code as RondoErrorCode,
    result.error.message,
    result.error.context,
    result.transport,
  );
}

function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  unwrapError(result);
}

function schemaFailure(domain: string, detail: string): never {
  throw new RondoClientError('SCHEMA_MISMATCH', `${domain} 未通过 schema 校验：${detail}`);
}

export function createRondoClient(api: RondoPreloadApi): RondoClient {
  async function command(envelope: PublicCommandEnvelope): Promise<CommandReceipt> {
    const parsed = safeParseEnvelope(envelope);
    if (!parsed.success) schemaFailure('命令信封', `${parsed.error.issues.length} 处问题`);
    const result = await api.command(parsed.data);
    if (!result.ok && result.transport === 'RECEIPT_UNKNOWN') {
      // Delivery unknown: replay the ORIGINAL key through the receipt query,
      // never resend the command.
      const lookupResult = await api.receipt({
        idempotencyKey: parsed.data.idempotencyKey,
        commandKind: parsed.data.kind,
      });
      if (lookupResult.ok) {
        const lookup = safeParseReceiptLookup(lookupResult.value);
        if (lookup.success && lookup.data.status === 'CONFIRMED') {
          return lookup.data.receipt;
        }
      }
      throw new RondoClientError(
        'HOST_RECOVERING',
        '写命令送达状态未知，且按原键未查回回执；请稍后以原键重查。',
        { idempotencyKey: parsed.data.idempotencyKey },
        'RECEIPT_UNKNOWN',
      );
    }
    const value = unwrap(result);
    const receipt = safeParseCommandReceipt(value);
    if (!receipt.success) schemaFailure('命令回执', `${receipt.error.issues.length} 处问题`);
    return receipt.data;
  }

  async function query(request: PublicQuery): Promise<PublicProjection> {
    const result = await api.query(request);
    const value = unwrap(result);
    const projection = safeParsePublicProjection(value);
    if (!projection.success) schemaFailure('查询投影', `${projection.error.issues.length} 处问题`);
    return projection.data;
  }

  async function receipt(request: { idempotencyKey: string; commandKind: CommandKind | string }): Promise<ReceiptLookup> {
    const result = await api.receipt(request);
    const value = unwrap(result);
    const lookup = safeParseReceiptLookup(value);
    if (!lookup.success) schemaFailure('回执查询', `${lookup.error.issues.length} 处问题`);
    return lookup.data;
  }

  function subscribeInvalidation(cb: (notice: InvalidationNotice) => void): Unsubscribe {
    return api.subscribeInvalidation((raw) => {
      const notice = safeParseInvalidationNotice(raw);
      if (notice.success) cb(notice.data);
    });
  }

  return { command, query, receipt, subscribeInvalidation };
}

export function createLocalAuthPort(api: RondoAuthPreloadApi): LocalAuthPort {
  async function parseSession(value: unknown): Promise<AuthSession | null> {
    if (value === null) return null;
    const parsed = safeParseAuthSession(value);
    if (!parsed.success) schemaFailure('会话投影', `${parsed.error.issues.length} 处问题`);
    return parsed.data;
  }
  async function parseSessionRequired(value: unknown): Promise<AuthSession> {
    const session = await parseSession(value);
    if (session === null) schemaFailure('会话投影', '期望非空会话');
    return session;
  }
  return {
    async setupGuardian(input: SetupGuardianInput): Promise<AuthSession> {
      return await parseSessionRequired(unwrap(await api.setupGuardian(input)));
    },
    async unlockGuardian(input: UnlockGuardianInput): Promise<AuthSession> {
      return await parseSessionRequired(unwrap(await api.unlockGuardian(input)));
    },
    async enterLearner(input: EnterLearnerInput): Promise<AuthSession> {
      return await parseSessionRequired(unwrap(await api.enterLearner(input)));
    },
    async lock(): Promise<LockResult> {
      const value = unwrap(await api.lock());
      if (value !== null && typeof value === 'object' && (value as { locked?: unknown }).locked === true) {
        return { locked: true };
      }
      schemaFailure('锁定结果', '形状不符');
    },
    async session(): Promise<AuthSession | null> {
      return await parseSession(unwrap(await api.session()));
    },
  };
}

export function createDesktopPort(api: RondoDesktopPreloadApi): DesktopPort {
  return {
    async saveExport(input: SaveExportInput): Promise<SaveExportResult> {
      const value = unwrap(await api.saveExport(input));
      const parsed = safeParseSaveExportResult(value);
      if (!parsed.success) schemaFailure('导出结果', `${parsed.error.issues.length} 处问题`);
      return parsed.data;
    },
    async requestQuit(): Promise<QuitFlowState> {
      const value = unwrap(await api.requestQuit());
      const parsed = safeParseQuitFlowState(value);
      if (!parsed.success) schemaFailure('退出流程状态', `${parsed.error.issues.length} 处问题`);
      return parsed.data;
    },
    async cancelQuit(): Promise<QuitFlowState> {
      const value = unwrap(await api.cancelQuit());
      const parsed = safeParseQuitFlowState(value);
      if (!parsed.success) schemaFailure('退出流程状态', `${parsed.error.issues.length} 处问题`);
      return parsed.data;
    },
    async hostStatus(): Promise<HostStatusProjection> {
      const value = unwrap(await api.hostStatus());
      const parsed = safeParseHostStatus(value);
      if (!parsed.success) schemaFailure('Host 状态', `${parsed.error.issues.length} 处问题`);
      return parsed.data;
    },
  };
}

export function createPlatformInfo(api: RondoPlatformPreloadApi): () => Promise<PlatformInfo> {
  return async () => {
    const value = unwrap(await api.info());
    return parsePlatformInfo(value);
  };
}
