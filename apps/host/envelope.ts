/**
 * Host wire envelope shared by Desktop Main (supervisor) and the DSH Host
 * utility process. Pure data + guards; no Electron, no Node built-ins —
 * safe to import from any Node bundle and to unit test.
 *
 * Frozen requirements implemented here (ARCHITECTURE.md §6, A-PLATFORM):
 * - every message carries requestId, protocolVersion, hostEpoch and a sender
 *   binding; Main drops late responses from a non-current Host epoch;
 * - on Host disconnect, pending WRITE commands resolve to delivery-unknown
 *   semantics (transport code RECEIPT_UNKNOWN) so the client replays the
 *   ORIGINAL idempotency key through the receipt query instead of resending
 *   a new command;
 * - queries/status are resendable and fail with HOST_DISCONNECTED instead.
 *
 * Transport codes are desktop-shell internal. Domain-facing errors keep the
 * frozen 12-code RondoError union (modules/contracts/public/errors.ts); the
 * transport code rides beside them in the IPC result, never inside it.
 */
import type { HostPhase, HostStatusProjection } from '../../modules/contracts/public/desktop';
import { PROTOCOL_VERSION } from '../../modules/contracts/public/protocol';
import { HOST_TRANSPORT_CODES, type HostTransportCode } from '../../adapters/desktop-client/transport';

/** Version of the Main<->Host wire envelope itself. */
export const HOST_WIRE_VERSION = 1 as const;

/** Sender binding source for messages authored by Desktop Main. */
export const HOST_SENDER_MAIN = 'desktop-main' as const;
/** Sender binding source for messages authored by the Host. */
export const HOST_SENDER_HOST = 'rondo-host' as const;

/** Fixed request kinds; the closed set the Host router accepts. */
export const HOST_REQUEST_KINDS = [
  'command',
  'query',
  'receipt',
  'auth.setupGuardian',
  'auth.unlockGuardian',
  'auth.enterLearner',
  'auth.lock',
  'auth.session',
  'view.getEvaluation',
  'view.getHints',
  'view.getReviewCard',
  'view.getMigration',
  'view.getTimelineDetail',
  'view.listLearners',
  'view.listAttempts',
  'view.registerExplanationRevision',
  'view.getLastDeletionScopeHash',
  'view.nowMs',
  'status',
  'shutdown',
] as const;
export type HostRequestKind = (typeof HOST_REQUEST_KINDS)[number];

/** Kinds whose delivery state is unknown when the Host dies mid-flight. */
export const WRITE_REQUEST_KINDS: ReadonlySet<HostRequestKind> = new Set<HostRequestKind>([
  'command',
]);

/** Desktop-shell transport codes (internal; not the frozen RondoError union). */
export { HOST_TRANSPORT_CODES } from '../../adapters/desktop-client/transport';
export type { HostTransportCode } from '../../adapters/desktop-client/transport';

export interface HostSenderBinding {
  readonly source: string;
  readonly windowId: number;
  readonly webContentsId: number;
}

export interface HostWireRequest {
  readonly direction: 'request';
  readonly wireVersion: 1;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly hostEpoch: string;
  readonly kind: HostRequestKind;
  readonly sender: HostSenderBinding;
  readonly payload: unknown;
}

export interface HostWireError {
  readonly code: string;
  readonly message: string;
  readonly context?: Record<string, string | number | boolean | null>;
}

export interface HostWireResponse {
  readonly direction: 'response';
  readonly wireVersion: 1;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly hostEpoch: string;
  readonly kind: HostRequestKind;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: HostWireError;
}

/** Host -> renderer invalidation push relayed by Main (no business emitter in R0). */
export interface HostWireEvent {
  readonly direction: 'event';
  readonly wireVersion: 1;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly hostEpoch: string;
  readonly kind: 'invalidation';
  readonly notice: unknown;
}

/** Identity facts the Host reports once at READY. Runtime readback, never hardcoded environment claims. */
export interface HostIdentityReport {
  readonly hostPhase: HostPhase;
  readonly hostEpoch: string;
  readonly nodeVersion: string;
  readonly electronVersion: string | null;
  readonly sqliteVersion: string | null;
  readonly dshFamily: string | null;
  readonly activeServices: readonly string[];
  readonly schemaVersion: number | null;
  readonly startedFromExistingRoot: boolean;
  readonly bootMs: number;
  /** integrated/ wiring facts: content releases the Host registered, and the loud per-release refusal codes (B/C contract gaps). */
  readonly registeredReleases?: readonly string[];
  readonly contentGaps?: readonly { releaseId: string; code: string }[];
  /** Structured entry-routing signal for the web entry screen. */
  readonly guardianConfigured?: boolean;
}

/** Internal status used by the quit-flow decision (projects to the frozen 3-field HostStatusProjection). */
export interface HostInternalStatus extends HostStatusProjection {
  readonly unsavedDraftCount: number;
  readonly activeServices: readonly string[];
  readonly guardianConfigured?: boolean;
}

export type HostWireInbound = HostWireResponse | HostWireEvent | HostReadyMessage;

export interface HostReadyMessage {
  readonly direction: 'ready';
  readonly wireVersion: 1;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly hostEpoch: string;
  readonly identity: HostIdentityReport;
}

// ---------------------------------------------------------------------------
// Structural guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isHostReadyMessage(value: unknown): value is HostReadyMessage {
  return (
    isRecord(value) &&
    value['direction'] === 'ready' &&
    value['wireVersion'] === HOST_WIRE_VERSION &&
    value['protocolVersion'] === PROTOCOL_VERSION &&
    typeof value['hostEpoch'] === 'string' &&
    value['hostEpoch'].length > 0 &&
    isRecord(value['identity'])
  );
}

export function isHostWireResponse(value: unknown): value is HostWireResponse {
  return (
    isRecord(value) &&
    value['direction'] === 'response' &&
    value['wireVersion'] === HOST_WIRE_VERSION &&
    value['protocolVersion'] === PROTOCOL_VERSION &&
    typeof value['requestId'] === 'string' &&
    typeof value['hostEpoch'] === 'string' &&
    typeof value['kind'] === 'string' &&
    (HOST_REQUEST_KINDS as readonly string[]).includes(value['kind']) &&
    typeof value['ok'] === 'boolean' &&
    (value['ok'] === true || isRecord(value['error']))
  );
}

export function isHostWireEvent(value: unknown): value is HostWireEvent {
  return (
    isRecord(value) &&
    value['direction'] === 'event' &&
    value['wireVersion'] === HOST_WIRE_VERSION &&
    value['protocolVersion'] === PROTOCOL_VERSION &&
    value['kind'] === 'invalidation' &&
    typeof value['hostEpoch'] === 'string'
  );
}

/** Validates an inbound request envelope at the Host edge (epoch must match the running Host). */
export function parseHostWireRequest(
  value: unknown,
  currentEpoch: string,
): { ok: true; request: HostWireRequest } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: 'not an object' };
  if (value['direction'] !== 'request') return { ok: false, reason: 'direction' };
  if (value['wireVersion'] !== HOST_WIRE_VERSION) return { ok: false, reason: 'wireVersion' };
  if (value['protocolVersion'] !== PROTOCOL_VERSION) return { ok: false, reason: 'protocolVersion' };
  if (value['hostEpoch'] !== currentEpoch) return { ok: false, reason: 'hostEpoch' };
  const requestId = value['requestId'];
  if (typeof requestId !== 'string' || requestId.length === 0) return { ok: false, reason: 'requestId' };
  const kind = value['kind'];
  if (typeof kind !== 'string' || !(HOST_REQUEST_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, reason: 'kind' };
  }
  const sender = value['sender'];
  if (!isRecord(sender) || sender['source'] !== HOST_SENDER_MAIN) return { ok: false, reason: 'sender' };
  if (typeof sender['windowId'] !== 'number' || typeof sender['webContentsId'] !== 'number') {
    return { ok: false, reason: 'sender binding' };
  }
  return {
    ok: true,
    request: value as unknown as HostWireRequest,
  };
}

/** Classification used when the Host dies or a request times out mid-flight. */
export function transportCodeForLostRequest(kind: HostRequestKind, timedOut: boolean): HostTransportCode {
  if (WRITE_REQUEST_KINDS.has(kind)) return 'RECEIPT_UNKNOWN';
  return timedOut ? 'HOST_RESPONSE_UNKNOWN' : 'HOST_DISCONNECTED';
}
