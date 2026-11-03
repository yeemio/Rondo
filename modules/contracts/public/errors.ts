/**
 * Rondo stable error codes (12, closed union) and RondoError shape.
 *
 * Frozen sources:
 * - LIFECYCLE-DATA-API.md §6 (stable error code list; raw stacks only in local
 *   redacted technical logs; VERSION_CONFLICT returns the currently visible
 *   version and a recovery hint)
 * - H0-SPEC.md §1 errors.ts
 */
import { z } from 'zod';

export const RONDO_ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CONTENT_UNAVAILABLE',
  'CONTENT_REVOKED',
  'UNKNOWN_RENDERER',
  'SCHEMA_MISMATCH',
  'INVALID_OPERATION',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'HOST_RECOVERING',
  'PERSISTENCE_FAILED',
  'CAPABILITY_UNAVAILABLE',
] as const;

export type RondoErrorCode = (typeof RONDO_ERROR_CODES)[number];

export const rondoErrorCodeSchema = z.enum(RONDO_ERROR_CODES);

export function parseRondoErrorCode(input: unknown): RondoErrorCode {
  return rondoErrorCodeSchema.parse(input);
}

export function safeParseRondoErrorCode(input: unknown): z.SafeParseReturnType<unknown, RondoErrorCode> {
  return rondoErrorCodeSchema.safeParse(input);
}

/**
 * Context values are bounded scalars only. They must never carry private
 * rules, raw stacks, or answer-derivable material.
 */
export const rondoErrorContextSchema = z.record(
  z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
);

export const rondoErrorSchema = z
  .object({
    code: rondoErrorCodeSchema,
    message: z.string().min(1).max(500),
    context: rondoErrorContextSchema.optional(),
  })
  .strict()
  .superRefine((err, ctx) => {
    if (err.code === 'VERSION_CONFLICT') {
      const current = err.context?.currentVisibleVersion;
      if (typeof current !== 'number' || !Number.isInteger(current) || current < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'VERSION_CONFLICT must carry context.currentVisibleVersion (integer >= 1)',
        });
      }
    }
  });

export type RondoError = z.infer<typeof rondoErrorSchema>;

export function parseRondoError(input: unknown): RondoError {
  return rondoErrorSchema.parse(input);
}

export function safeParseRondoError(input: unknown): z.SafeParseReturnType<unknown, RondoError> {
  return rondoErrorSchema.safeParse(input);
}

export function rondoError(
  code: RondoErrorCode,
  message: string,
  context?: z.infer<typeof rondoErrorContextSchema>,
): RondoError {
  return context === undefined ? { code, message } : { code, message, context };
}

/** VERSION_CONFLICT always returns the currently visible version plus a recovery hint (LIFECYCLE §6). */
export function versionConflictError(currentVisibleVersion: number, recoveryHint: string): RondoError {
  return {
    code: 'VERSION_CONFLICT',
    message: '版本冲突：操作所基于的版本已过期。',
    context: { currentVisibleVersion, recoveryHint },
  };
}
