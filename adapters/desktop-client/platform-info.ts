/**
 * PlatformInfo: the fixed diagnostics shape returned by Desktop Main's
 * 'rondo:platform:info' channel. All facts are read back at runtime —
 * versions, Host identity/epoch, data-root paths — never hardcoded claims.
 *
 * Renderer-safe (zod + public contracts only).
 */
import { z } from 'zod';
import { PROTOCOL_VERSION } from '../../modules/contracts/public/protocol';
import { hostStatusSchema } from '../../modules/contracts/public/desktop';

const hostIdentitySchema = z
  .object({
    hostPhase: z.enum(['STARTING', 'RECOVERING', 'READY', 'QUIESCING', 'STOPPED', 'START_FAILED', 'RECOVERY_REQUIRED']),
    hostEpoch: z.string().min(1),
    nodeVersion: z.string(),
    electronVersion: z.string().nullable(),
    sqliteVersion: z.string().nullable(),
    dshFamily: z.string().nullable(),
    activeServices: z.array(z.string().min(1).max(128)).max(64),
    schemaVersion: z.number().int().nullable(),
    startedFromExistingRoot: z.boolean(),
    bootMs: z.number().int().min(0),
    registeredReleases: z.array(z.string().min(1).max(128)).max(16).optional(),
    contentGaps: z
      .array(z.object({ releaseId: z.string().min(1).max(128), code: z.string().min(1).max(64) }).strict())
      .max(16)
      .optional(),
    guardianConfigured: z.boolean().optional(),
  })
  .strict();

export const platformInfoSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    appVersion: z.string().min(1).max(64),
    electronVersion: z.string(),
    chromeVersion: z.string(),
    mainNodeVersion: z.string(),
    dataRoot: z.string().min(1),
    paths: z
      .object({
        root: z.string(),
        learning: z.string(),
        content: z.string(),
        desktop: z.string(),
        technicalDsh: z.string(),
        technicalLogs: z.string(),
        temporary: z.string(),
      })
      .strict(),
    host: hostIdentitySchema.nullable(),
    hostStatus: hostStatusSchema,
  })
  .strict();

export type PlatformInfo = z.infer<typeof platformInfoSchema>;

export function parsePlatformInfo(input: unknown): PlatformInfo {
  return platformInfoSchema.parse(input);
}
