/**
 * Server-side trusted context.
 *
 * Frozen sources:
 * - B proposals §C (suggested shape: familyId, actorId, role, learnerId?,
 *   sessionId, windowRef, hostEpoch)
 * - server-ports-recommendation.md §2 (ServerContextProvider:
 *   (sessionRef, windowRef) => ServerContext | null; only Host authentication
 *   produces contexts)
 * - LIFECYCLE-DATA-API.md §7 (client-supplied learnerId is a claim, not a
 *   permission; receipt idempotency scope familyId/actorId comes from the
 *   context only)
 *
 * This module is server-only: it must never be imported into a renderer
 * bundle (checked by A's boundary checks).
 */

export type AuthRole = 'GUARDIAN' | 'LEARNER';

export interface ServerContext {
  readonly familyId: string;
  readonly actorId: string;
  readonly role: AuthRole;
  readonly learnerId?: string;
  readonly sessionId: string;
  /** Trusted-window reference validated by Desktop Main (rondo://app origin discipline). */
  readonly windowRef: string;
  /** Host epoch; advancing it invalidates all older sessions (B-D4). */
  readonly hostEpoch: string;
}

/**
 * Only the Host's authenticated session store produces contexts. Returns null
 * for unknown/expired/revoked session refs or window mismatches; callers then
 * surface UNAUTHENTICATED. Public payload actor/familyId fields never
 * contribute to a context.
 */
export type ServerContextProvider = (
  sessionRef: string,
  windowRef: string,
) => ServerContext | null | Promise<ServerContext | null>;
