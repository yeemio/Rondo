/**
 * IPC result envelope between preload and Desktop Main. Domain errors keep
 * the frozen RondoError shape (12-code union); transport-level facts ride in
 * the optional `transport` field so the frozen code set stays closed.
 *
 * Renderer-safe: no Electron, no Node imports.
 */
import type { RondoError } from '../../modules/contracts/public/errors';
import type { HostTransportCode } from './transport';

export interface IpcOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface IpcErr {
  readonly ok: false;
  readonly error: RondoError;
  readonly transport?: HostTransportCode;
}

export type IpcResult<T> = IpcOk<T> | IpcErr;

export function ipcOk<T>(value: T): IpcOk<T> {
  return { ok: true, value };
}

export function ipcErr(error: RondoError, transport?: HostTransportCode): IpcErr {
  return transport === undefined ? { ok: false, error } : { ok: false, error, transport };
}

export function isIpcErr(value: unknown): value is IpcErr {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}
