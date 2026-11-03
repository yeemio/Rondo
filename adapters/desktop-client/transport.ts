/**
 * Desktop-shell transport codes shared by Main, Host and the renderer
 * client. These are NOT the frozen 12-code RondoError union — they carry
 * desktop-internal delivery facts (epoch/disconnect/timeout) beside the
 * domain error. Renderer-safe pure data.
 */
export const HOST_TRANSPORT_CODES = [
  'HOST_START_TIMEOUT',
  'HOST_DISCONNECTED',
  'HOST_RESPONSE_UNKNOWN',
  'HOST_QUIESCING',
  'HOST_PROTOCOL_VIOLATION',
  'HOST_SHUTDOWN_TIMEOUT',
  'HOST_EXIT_UNPROVEN',
  'RECEIPT_UNKNOWN',
] as const;

export type HostTransportCode = (typeof HOST_TRANSPORT_CODES)[number];

export function isHostTransportCode(value: unknown): value is HostTransportCode {
  return typeof value === 'string' && (HOST_TRANSPORT_CODES as readonly string[]).includes(value);
}
