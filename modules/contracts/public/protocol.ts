/**
 * Rondo public protocol constants and shared primitive schemas.
 *
 * Frozen sources:
 * - LIFECYCLE-DATA-API.md §5 (protocolVersion 'rondo.v1')
 * - SCENE-CONTRACTS.md §1 / SHARED-CONTRACT.md (scene protocol version fixed as string "1")
 * - H0-SPEC.md §1 (protocol.ts)
 *
 * This module is renderer-visible. It must never import anything from
 * modules/contracts/server, adapters/, or any Node built-in API.
 */
import { z } from 'zod';

/** The only legal value for PublicCommandEnvelope.protocolVersion. */
export const PROTOCOL_VERSION = 'rondo.v1' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** Scene protocol version. Frozen as the string "1" by SHARED-CONTRACT. */
export const SCENE_PROTOCOL_VERSION = '1' as const;
export type SceneProtocolVersion = typeof SCENE_PROTOCOL_VERSION;

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);

export function parseProtocolVersion(input: unknown): ProtocolVersion {
  return protocolVersionSchema.parse(input);
}

export function safeParseProtocolVersion(input: unknown): z.SafeParseReturnType<unknown, ProtocolVersion> {
  return protocolVersionSchema.safeParse(input);
}

export const sceneProtocolVersionSchema = z.literal(SCENE_PROTOCOL_VERSION);

export function parseSceneProtocolVersion(input: unknown): SceneProtocolVersion {
  return sceneProtocolVersionSchema.parse(input);
}

export function safeParseSceneProtocolVersion(input: unknown): z.SafeParseReturnType<unknown, SceneProtocolVersion> {
  return sceneProtocolVersionSchema.safeParse(input);
}

/** Bounded identifier (server-generated or content-declared ids). */
export const idSchema = z.string().min(1).max(256);

export function parseId(input: unknown): string {
  return idSchema.parse(input);
}

/** Positive integer (versions, seq numbers, limits). */
export const positiveIntSchema = z.number().int().min(1);

export function parsePositiveInt(input: unknown): number {
  return positiveIntSchema.parse(input);
}

/** Non-negative integer. */
export const nonNegativeIntSchema = z.number().int().min(0);

/** Server-clock timestamp in epoch milliseconds (B sqlite-schema-recommendation §1). */
export const epochMsSchema = z.number().int().min(0);
