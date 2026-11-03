/**
 * LocalAuthPort: five fixed operations, closed set.
 *
 * Frozen sources:
 * - LIFECYCLE-DATA-API.md §5 (LocalAuthPort semantics: setupGuardian only on
 *   an uninitialized local data root from the trusted main window, single
 *   family per transaction, idempotent by key; unlockGuardian verifies local
 *   guardian credentials; enterLearner requires a guardian session and a
 *   learner of that family; lock revokes the window session; session is a
 *   read-only identity projection)
 * - LIFECYCLE-DATA-API.md §8 (credentials never leave the Host; scrypt with
 *   per-credential salt; failure throttling)
 * - B proposals §B; H0-SPEC.md §1 auth.ts
 *
 * Outputs NEVER contain credentials, salts, or derived values. The
 * passphrase travels only to the Host and is never logged or projected.
 */
import { z } from 'zod';
import { idSchema } from './protocol';

export const AUTH_ROLES = ['GUARDIAN', 'LEARNER'] as const;
export type AuthRole = (typeof AUTH_ROLES)[number];

export const authSessionSchema = z
  .object({
    role: z.enum(AUTH_ROLES),
    actorId: idSchema,
    familyId: idSchema,
    displayName: z.string().min(1).max(64),
    learnerId: idSchema.optional(),
    expiresAtMs: z.number().int().min(0),
  })
  .strict();

export type AuthSession = z.infer<typeof authSessionSchema>;

export function parseAuthSession(input: unknown): AuthSession {
  return authSessionSchema.parse(input);
}

export function safeParseAuthSession(input: unknown): z.SafeParseReturnType<unknown, AuthSession> {
  return authSessionSchema.safeParse(input);
}

export const setupGuardianInputSchema = z
  .object({
    /** Raw idempotency key: repeated setup returns the original result, never a second family. */
    idempotencyKey: idSchema,
    familyDisplayName: z.string().min(1).max(64),
    guardianDisplayName: z.string().min(1).max(64),
    /** Credential input; Host-only. Minimum length enforced at the schema edge as well. */
    passphrase: z.string().min(8).max(256),
  })
  .strict();

export type SetupGuardianInput = z.infer<typeof setupGuardianInputSchema>;

export function parseSetupGuardianInput(input: unknown): SetupGuardianInput {
  return setupGuardianInputSchema.parse(input);
}

export function safeParseSetupGuardianInput(input: unknown): z.SafeParseReturnType<unknown, SetupGuardianInput> {
  return setupGuardianInputSchema.safeParse(input);
}

export const unlockGuardianInputSchema = z
  .object({ passphrase: z.string().min(1).max(256) })
  .strict();

export type UnlockGuardianInput = z.infer<typeof unlockGuardianInputSchema>;

export function parseUnlockGuardianInput(input: unknown): UnlockGuardianInput {
  return unlockGuardianInputSchema.parse(input);
}

export function safeParseUnlockGuardianInput(input: unknown): z.SafeParseReturnType<unknown, UnlockGuardianInput> {
  return unlockGuardianInputSchema.safeParse(input);
}

export const enterLearnerInputSchema = z
  .object({ learnerId: idSchema })
  .strict();

export type EnterLearnerInput = z.infer<typeof enterLearnerInputSchema>;

export function parseEnterLearnerInput(input: unknown): EnterLearnerInput {
  return enterLearnerInputSchema.parse(input);
}

export function safeParseEnterLearnerInput(input: unknown): z.SafeParseReturnType<unknown, EnterLearnerInput> {
  return enterLearnerInputSchema.safeParse(input);
}

export const lockResultSchema = z
  .object({ locked: z.literal(true) })
  .strict();

export type LockResult = z.infer<typeof lockResultSchema>;

export function parseLockResult(input: unknown): LockResult {
  return lockResultSchema.parse(input);
}

export function safeParseLockResult(input: unknown): z.SafeParseReturnType<unknown, LockResult> {
  return lockResultSchema.safeParse(input);
}

export interface LocalAuthPort {
  setupGuardian(input: SetupGuardianInput): Promise<AuthSession>;
  unlockGuardian(input: UnlockGuardianInput): Promise<AuthSession>;
  enterLearner(input: EnterLearnerInput): Promise<AuthSession>;
  lock(): Promise<LockResult>;
  /** Read-only identity projection; null when no session is active. */
  session(): Promise<AuthSession | null>;
}
