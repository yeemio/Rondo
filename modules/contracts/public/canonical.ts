/**
 * Canonical serialization and idempotency payload hash (B-D5, coordinator
 * delta item 3).
 *
 * Canonical form: recursive key-sorted JSON.stringify, no whitespace, UTF-8.
 * NaN, Infinity, -Infinity, undefined, and non-JSON values are rejected, not
 * silently coerced. Integers serialize as-is.
 *
 * SHA-256 input (fields joined with a single NUL separator, U+0000):
 *   protocolVersion + NUL + kind + NUL + canonical(payload) + NUL
 *   + canonical(target) + NUL + canonical(binding ?? null) + NUL
 *   + String(expectedAttemptVersion ?? null)
 *
 * Same logical payload under a different key order MUST produce the same
 * hash; this is asserted by the contract fixtures (tests/contracts/canonical.test.ts).
 *
 * Uses only web-standard globals (crypto.subtle, TextEncoder) available in
 * Node >= 19 and Electron renderers; no Node built-in imports. The separator
 * is built via String.fromCharCode(0) to keep this source file pure ASCII.
 */

/** Field separator inside the hashed message: the single character U+0000. */
export const PAYLOAD_HASH_SEPARATOR: string = String.fromCharCode(0);

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  switch (type) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`non-finite number is not canonicalizable: ${value}`);
      }
      return JSON.stringify(value);
    }
    case 'undefined':
      throw new CanonicalizationError('undefined is not canonicalizable');
    case 'bigint':
      throw new CanonicalizationError('bigint is not canonicalizable');
    case 'symbol':
      throw new CanonicalizationError('symbol is not canonicalizable');
    case 'function':
      throw new CanonicalizationError('function is not canonicalizable');
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError('only plain objects are canonicalizable');
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
      return `{${parts.join(',')}}`;
    }
    default:
      throw new CanonicalizationError(`unsupported value type: ${String(type)}`);
  }
}

export interface PayloadHashInput {
  readonly protocolVersion: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly target: unknown;
  readonly binding?: unknown;
  readonly expectedAttemptVersion?: number;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export async function computePayloadHash(input: PayloadHashInput): Promise<string> {
  const message = [
    input.protocolVersion,
    input.kind,
    canonicalize(input.payload),
    canonicalize(input.target),
    canonicalize(input.binding ?? null),
    String(input.expectedAttemptVersion ?? null),
  ].join(PAYLOAD_HASH_SEPARATOR);
  const encoded = new TextEncoder().encode(message);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return toHex(digest);
}
