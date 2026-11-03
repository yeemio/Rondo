/**
 * LocalAuthPort implementation: guardian setup, unlock, learner entry, lock,
 * session projection, and the ServerContextProvider the learning server
 * consumes.
 *
 * Frozen sources:
 * - modules/contracts/public/auth.ts (five fixed operations; outputs never
 *   contain credentials, salts, or derived values)
 * - LIFECYCLE-DATA-API.md §5 (setupGuardian only on an uninitialized data
 *   root, one family per transaction, idempotent by key) and §8 (scrypt with
 *   per-credential random salt, fixed parameters, failure throttling;
 *   credentials never leave the Host, never logged, never projected)
 * - B-D4 (hostSession persists bound to hostEpoch; a Host restart advances
 *   the epoch and invalidates every older session; wake-from-sleep only
 *   re-validates)
 *
 * Actor-id modeling (H0-README B open question): a GUARDIAN session's
 * actorId is the guardianActor row id; a LEARNER session's actorId is the
 * deterministic `learner-actor:<learnerId>` -- stable across sessions so the
 * idempotency scope (familyId, actorId, idempotencyKey) converges replays
 * from a re-authenticated learner to one effect (LIFECYCLE §4).
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type {
  AuthSession,
  EnterLearnerInput,
  LocalAuthPort,
  LockResult,
  SetupGuardianInput,
  UnlockGuardianInput,
} from '../contracts/public/auth';
import { parseEnterLearnerInput, parseSetupGuardianInput, parseUnlockGuardianInput } from '../contracts/public/auth';
import { rondoError } from '../contracts/public/errors';
import type { ServerContext, ServerContextProvider } from '../contracts/server/context';
import type { ServerClock, IdGenerator } from '../contracts/server/learning';
import type { StoragePort, Repositories, RepoScope } from '../contracts/server/storage';
import type { SqliteRepositories } from '../../adapters/sqlite/repositories';

/** Fixed scrypt parameters, frozen with the local schema (LIFECYCLE §8). */
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

export const DEFAULT_GUARDIAN_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_LEARNER_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes ("短期会话")
export const DEFAULT_MAX_FAILED_ATTEMPTS = 5;
export const DEFAULT_LOCKOUT_MS = 5 * 60 * 1000;

export function learnerActorId(learnerId: string): string {
  return `learner-actor:${learnerId}`;
}

export interface LocalAuthDeps {
  readonly storage: StoragePort;
  readonly time: ServerClock;
  readonly ids: IdGenerator;
  /** Trusted main-window reference; sessions are bound to it. */
  readonly windowRef: string;
  /** Host epoch this auth instance belongs to; advancing it kills older sessions. */
  readonly hostEpoch: string;
  readonly guardianSessionTtlMs?: number;
  readonly learnerSessionTtlMs?: number;
  readonly maxFailedAttempts?: number;
  readonly lockoutMs?: number;
}

export interface LocalAuth extends LocalAuthPort {
  readonly contextProvider: ServerContextProvider;
}

interface CurrentSessionRef {
  readonly sessionId: string;
}

export function createLocalAuth(deps: LocalAuthDeps): LocalAuth {
  const guardianTtl = deps.guardianSessionTtlMs ?? DEFAULT_GUARDIAN_SESSION_TTL_MS;
  const learnerTtl = deps.learnerSessionTtlMs ?? DEFAULT_LEARNER_SESSION_TTL_MS;
  const maxFailed = deps.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
  const lockoutMs = deps.lockoutMs ?? DEFAULT_LOCKOUT_MS;
  let current: CurrentSessionRef | null = null;

  function deriveFamilyId(idempotencyKey: string): string {
    const digest = createHash('sha256').update(`rondo.setup.v1:${idempotencyKey}`).digest('hex');
    return `fam-${digest.slice(0, 24)}`;
  }

  function bootstrapScope(familyId: string): RepoScope {
    return { familyId, actorId: 'host-auth-bootstrap' };
  }

  function deriveKey(passphrase: string, saltHex: string): string {
    return scryptSync(passphrase, Buffer.from(saltHex, 'hex'), SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
    }).toString('hex');
  }

  function passphraseMatches(input: string, saltHex: string, expectedKeyHex: string): boolean {
    const actual = Buffer.from(deriveKey(input, saltHex), 'hex');
    const expected = Buffer.from(expectedKeyHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Resolves the current session against the database (revocation/expiry/epoch). */
  async function resolveCurrentSessionRow(): Promise<import('../contracts/server/storage').HostSessionRecord | null> {
    if (current === null) return null;
    const row = await deps.storage.read(async (repos) =>
      repos.hostSession.findActive(bootstrapScope(''), current!.sessionId, deps.hostEpoch),
    );
    if (row === null || row.expiresAt <= deps.time.now()) return null;
    return row;
  }

  async function resolveCurrentSession(): Promise<AuthSession | null> {
    const row = await resolveCurrentSessionRow();
    if (row === null) return null;
    if (row.role === 'GUARDIAN') {
      const actor = await deps.storage.read(async (repos) =>
        repos.guardianActor.findById(bootstrapScope(row.familyId), row.guardianActorId ?? ''),
      );
      return {
        role: 'GUARDIAN',
        actorId: row.guardianActorId ?? '',
        familyId: row.familyId,
        displayName: actor?.displayName ?? 'Guardian',
        expiresAtMs: row.expiresAt,
      };
    }
    const learner = await deps.storage.read(async (repos) => repos.learner.findById(bootstrapScope(row.familyId), row.learnerId ?? ''));
    return {
      role: 'LEARNER',
      actorId: learnerActorId(row.learnerId ?? ''),
      familyId: row.familyId,
      displayName: learner?.alias ?? 'Learner',
      learnerId: row.learnerId ?? '',
      expiresAtMs: row.expiresAt,
    };
  }

  async function issueSession(input: {
    familyId: string;
    role: 'GUARDIAN' | 'LEARNER';
    guardianActorId: string | null;
    learnerId: string | null;
    displayName: string;
  }): Promise<AuthSession> {
    const now = deps.time.now();
    const ttl = input.role === 'GUARDIAN' ? guardianTtl : learnerTtl;
    const sessionId = deps.ids.newId('sess');
    await deps.storage.tx('auth.issueSession', async (repos) => {
      await repos.hostSession.insert(bootstrapScope(input.familyId), {
        sessionId,
        familyId: input.familyId,
        role: input.role,
        guardianActorId: input.guardianActorId,
        learnerId: input.learnerId,
        windowRef: deps.windowRef,
        hostEpoch: deps.hostEpoch,
        issuedAt: now,
        expiresAt: now + ttl,
        revokedAt: null,
        revocationVersion: 0,
      });
    });
    current = { sessionId };
    return {
      role: input.role,
      actorId: input.role === 'GUARDIAN' ? (input.guardianActorId ?? '') : learnerActorId(input.learnerId ?? ''),
      familyId: input.familyId,
      displayName: input.displayName,
      ...(input.learnerId !== null ? { learnerId: input.learnerId } : {}),
      expiresAtMs: now + ttl,
    };
  }

  const auth: LocalAuth = {
    async setupGuardian(input: SetupGuardianInput): Promise<AuthSession> {
      const parsed = parseSetupGuardianInput(input);
      const familyId = deriveFamilyId(parsed.idempotencyKey);
      const scope = bootstrapScope(familyId);
      const now = deps.time.now();

      const existing = await deps.storage.read(async (repos) => credentialFindAny(repos));
      if (existing !== null) {
        // Data root already initialized. Same key => idempotent repeat, but the
        // passphrase must still verify (the key alone is not a credential).
        if (existing.familyId !== familyId) {
          throw rondoError('INVALID_OPERATION', '本机数据根已初始化，不能创建第二个家庭。');
        }
        if (!passphraseMatches(parsed.passphrase, existing.salt, existing.derivedKey)) {
          throw rondoError('UNAUTHENTICATED', '口令不正确。');
        }
        const actorRow = await deps.storage.read(async (repos) => repos.guardianActor.listByFamily(scope, familyId));
        const actor = actorRow[0];
        return issueSession({ familyId, role: 'GUARDIAN', guardianActorId: actor?.actorId ?? '', learnerId: null, displayName: actor?.displayName ?? parsed.guardianDisplayName });
      }

      const salt = randomBytes(16).toString('hex');
      const derivedKey = deriveKey(parsed.passphrase, salt);
      const actorId = deps.ids.newId('actor');
      const sessionId = deps.ids.newId('sess');
      await deps.storage.tx('auth.setupGuardian', async (repos) => {
        // Single transaction: family + guardian actor + credential + session.
        await repos.family.insert(scope, { familyId, displayName: parsed.familyDisplayName, createdAt: now });
        await repos.guardianActor.insert(scope, { actorId, familyId, displayName: parsed.guardianDisplayName, createdAt: now });
        await repos.guardianCredential.insert(scope, {
          familyId,
          algorithm: 'scrypt',
          paramsJson: JSON.stringify(SCRYPT_PARAMS),
          salt,
          derivedKey,
          failedAttempts: 0,
          lockUntil: null,
        });
        await repos.hostSession.insert(scope, {
          sessionId,
          familyId,
          role: 'GUARDIAN',
          guardianActorId: actorId,
          learnerId: null,
          windowRef: deps.windowRef,
          hostEpoch: deps.hostEpoch,
          issuedAt: now,
          expiresAt: now + guardianTtl,
          revokedAt: null,
          revocationVersion: 0,
        });
      });
      current = { sessionId };
      return {
        role: 'GUARDIAN',
        actorId,
        familyId,
        displayName: parsed.guardianDisplayName,
        expiresAtMs: now + guardianTtl,
      };
    },

    async unlockGuardian(input: UnlockGuardianInput): Promise<AuthSession> {
      const parsed = parseUnlockGuardianInput(input);
      const credential = await deps.storage.read(async (repos) => credentialFindAny(repos));
      if (credential === null) {
        throw rondoError('UNAUTHENTICATED', '本机尚未设置监护人。');
      }
      const now = deps.time.now();
      if (credential.lockUntil !== null && credential.lockUntil > now) {
        throw rondoError('UNAUTHENTICATED', '失败次数过多，已临时锁定。', { retryAfterMs: credential.lockUntil - now });
      }
      if (!passphraseMatches(parsed.passphrase, credential.salt, credential.derivedKey)) {
        const failed = credential.failedAttempts + 1;
        const lockUntil = failed >= maxFailed ? now + lockoutMs : null;
        await deps.storage.tx('auth.unlockFailure', async (repos) => {
          await repos.guardianCredential.recordFailedAttempt(bootstrapScope(credential.familyId), credential.familyId, lockUntil);
        });
        throw rondoError('UNAUTHENTICATED', '口令不正确。');
      }
      if (credential.failedAttempts > 0 || credential.lockUntil !== null) {
        await deps.storage.tx('auth.unlockReset', async (repos) => {
          await credentialClearFailures(repos, credential.familyId);
        });
      }
      const actorRow = await deps.storage.read(async (repos) => repos.guardianActor.listByFamily(bootstrapScope(credential.familyId), credential.familyId));
      const actor = actorRow[0];
      return issueSession({
        familyId: credential.familyId,
        role: 'GUARDIAN',
        guardianActorId: actor?.actorId ?? '',
        learnerId: null,
        displayName: actor?.displayName ?? 'Guardian',
      });
    },

    async enterLearner(input: EnterLearnerInput): Promise<AuthSession> {
      const parsed = parseEnterLearnerInput(input);
      const session = await resolveCurrentSession();
      if (session === null || session.role !== 'GUARDIAN') {
        throw rondoError('UNAUTHENTICATED', '进入学习者前需要有效的监护人会话。');
      }
      const familyId = session.familyId;
      const learner = await deps.storage.read(async (repos) => repos.learner.findById(bootstrapScope(familyId), parsed.learnerId));
      if (learner === null || learner.familyId !== familyId) {
        throw rondoError('FORBIDDEN', '该学习者不属于当前家庭。');
      }
      const guardianRow = await resolveCurrentSessionRow();
      return issueSession({
        familyId,
        role: 'LEARNER',
        guardianActorId: guardianRow?.guardianActorId ?? null,
        learnerId: learner.learnerId,
        displayName: learner.alias,
      });
    },

    async lock(): Promise<LockResult> {
      if (current !== null) {
        const sessionId = current.sessionId;
        await deps.storage.tx('auth.lock', async (repos) => {
          await repos.hostSession.revoke(bootstrapScope(''), sessionId);
        });
        current = null;
      }
      return { locked: true };
    },

    async session(): Promise<AuthSession | null> {
      return resolveCurrentSession();
    },

    contextProvider: ((sessionRef: string, windowRef: string) => {
      return deps.storage
        .read(async (repos) => repos.hostSession.findActive(bootstrapScope(''), sessionRef, deps.hostEpoch))
        .then((row) => {
          if (row === null) return null;
          if (row.windowRef !== windowRef) return null;
          if (row.expiresAt <= deps.time.now()) return null;
          const ctx: ServerContext = {
            familyId: row.familyId,
            actorId: row.role === 'GUARDIAN' ? (row.guardianActorId ?? '') : learnerActorId(row.learnerId ?? ''),
            role: row.role,
            ...(row.learnerId !== null ? { learnerId: row.learnerId } : {}),
            sessionId: row.sessionId,
            windowRef: row.windowRef,
            hostEpoch: row.hostEpoch,
          };
          return ctx;
        });
    }) as ServerContextProvider,
  };

  return auth;
}

// -- narrow seams onto the concrete repository bundle (documented bootstrap) --

type CredentialCapable = Repositories & {
  guardianCredential: Repositories['guardianCredential'] & {
    findAny(): Promise<import('../../modules/contracts/server/storage').GuardianCredentialRecord | null>;
    clearFailures(familyId: string): Promise<void>;
  };
};

function asCredentialCapable(repos: Repositories): CredentialCapable {
  const candidate = repos.guardianCredential as CredentialCapable['guardianCredential'];
  if (typeof candidate.findAny !== 'function' || typeof candidate.clearFailures !== 'function') {
    throw rondoError('PERSISTENCE_FAILED', 'storage lacks the auth bootstrap seam');
  }
  return repos as CredentialCapable;
}

async function credentialFindAny(repos: Repositories) {
  return asCredentialCapable(repos).guardianCredential.findAny();
}

async function credentialClearFailures(repos: Repositories, familyId: string) {
  await asCredentialCapable(repos).guardianCredential.clearFailures(familyId);
}
