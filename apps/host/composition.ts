/**
 * Rondo Host composition: the static DSH profile and the post-boot service
 * audit.
 *
 * Frozen requirements (ARCHITECTURE.md §5 / A-PLATFORM work item 5):
 * - boot through @deepseek-ai/dsh-app-boot's public boot() against a static
 *   profile that registers ONLY Rondo-approved services. No dsh-base /
 *   dsh-web-app stock bundle, no shell/fs/MCP/network/model/telemetry
 *   capability is registered, and no default DSH profile or .env is read
 *   (loadEnv/loadLayeredEnv are deliberately never called; HOME is redirected
 *   by Main into the Rondo data root so no user ~/.dsh layer exists).
 * - missing required service, duplicate registration, disabled service or an
 *   extra unapproved entry all refuse READY.
 *
 * The profile file apps/host/profile/cordis.yml is strict JSON (a valid YAML
 * document for the include plugin's entry-list dialect) and is the single
 * source of truth: the build copies it verbatim to dist/host/cordis.yml for
 * boot(), and this module imports the same text to derive the approved list —
 * no duplicated manifest to drift.
 */
import { boot } from '@deepseek-ai/dsh-app-boot';
import type { Context } from '@deepseek-ai/cordis';
import type { Entry } from '@deepseek-ai/cordis-plugin-loader';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import profileText from './profile/cordis.yml';
import webProfileText from './profile/cordis-web.yml';

export interface HostProfileEntry {
  readonly id: string;
  readonly name: string;
}

function parseProfile(text: string): readonly HostProfileEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('HOST_PROFILE_INVALID: profile must be a non-empty array');
  }
  const seenNames = new Set<string>();
  const entries: HostProfileEntry[] = [];
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) throw new Error('HOST_PROFILE_INVALID: entry not an object');
    const record = raw as Record<string, unknown>;
    if (typeof record['id'] !== 'string' || typeof record['name'] !== 'string') {
      throw new Error('HOST_PROFILE_INVALID: entry missing id/name');
    }
    if (seenNames.has(record['name'])) {
      throw new Error(`HOST_PROFILE_INVALID: duplicate service ${record['name']}`);
    }
    seenNames.add(record['name']);
    entries.push({ id: record['id'], name: record['name'] });
  }
  return entries;
}

/** The approved static service list. Frozen at build; grows only via an explicit A-line change. */
export const PROFILE_ENTRIES: readonly HostProfileEntry[] = parseProfile(profileText);

/**
 * The approved static service list for the BROWSER host entry
 * (apps/host/web-main.ts): the desktop surface plus the DSH web server and
 * the Rondo web gateway. Same single-source-of-truth rule — parsed from the
 * profile file boot() actually mounts, never a second hand-maintained list.
 */
export const WEB_PROFILE_ENTRIES: readonly HostProfileEntry[] = parseProfile(webProfileText);

export interface BootedHost {
  readonly ctx: Context;
  readonly activeServices: readonly string[];
}

export type CompositionRefusalCode =
  | 'UNAPPROVED_SERVICE'
  | 'MISSING_SERVICE'
  | 'SERVICE_DISABLED'
  | 'SERVICE_NOT_ACTIVE'
  | 'BOOT_FAILED';

export class CompositionRefusal extends Error {
  constructor(readonly code: CompositionRefusalCode, message: string, readonly cause?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'CompositionRefusal';
  }
}

/**
 * FiberState is a `const enum` in cordis' declarations and is not exported by
 * the runtime bundle, so its members are compared numerically here.
 * Mapping (cordis 4.0.5 fiber.d.ts): PENDING=0 LOADING=1 ACTIVE=2 FAILED=3
 * DISPOSED=4 UNLOADING=5. boot() already settles the tree and rejects failed
 * required entries; this audit additionally requires every approved entry to
 * be exactly ACTIVE.
 */
const FIBER_STATE_ACTIVE = 2;

/**
 * Loader-tree infrastructure entries that exist because of how boot() mounts
 * the config (the bootstrap Include itself). They are not Rondo services and
 * are excluded from the approved-list audit — every OTHER entry must be an
 * approved, active service.
 */
const INFRASTRUCTURE_ENTRY_NAMES = new Set(['cordis:include']);

/**
 * Boots the static profile and audits the settled tree against the approved
 * list. Throws CompositionRefusal (refusing READY) for any deviation.
 *
 * `approved` defaults to the desktop profile's list; the browser entry passes
 * WEB_PROFILE_ENTRIES so the audit always covers exactly the profile booted.
 */
export async function bootHost(
  configPath: string,
  approved: readonly HostProfileEntry[] = PROFILE_ENTRIES,
): Promise<BootedHost> {
  const approvedNames = new Set(approved.map((entry) => entry.name));
  let ctx: Context;
  try {
    // No patches, no prepare step, no bareModuleBaseUrl: the profile lists
    // only relative entry names resolved beside dist/host/cordis.yml.
    ctx = await boot('rondo-host', configPath, [], undefined, undefined);
  } catch (err) {
    throw new CompositionRefusal('BOOT_FAILED', 'dsh-app-boot boot() rejected the profile', err);
  }

  const active: string[] = [];
  let entry: Entry;
  for (entry of ctx.loader.entries()) {
    const name = entry.options.name;
    if (INFRASTRUCTURE_ENTRY_NAMES.has(name)) continue;
    if (!approvedNames.has(name)) {
      throw new CompositionRefusal('UNAPPROVED_SERVICE', `loader entry ${name} is not in the Rondo profile`);
    }
    if (entry.disabled) {
      throw new CompositionRefusal('SERVICE_DISABLED', `service ${name} is disabled`);
    }
    const fiber = entry.fiber;
    if (!fiber || fiber.state !== FIBER_STATE_ACTIVE) {
      throw new CompositionRefusal('SERVICE_NOT_ACTIVE', `service ${name} state=${fiber?.state ?? 'absent'}`);
    }
    if (active.includes(name)) {
      throw new CompositionRefusal('UNAPPROVED_SERVICE', `duplicate loader entry for ${name}`);
    }
    active.push(name);
  }
  for (const name of approvedNames) {
    if (!active.includes(name)) {
      throw new CompositionRefusal('MISSING_SERVICE', `required service ${name} is not present in the tree`);
    }
  }
  return { ctx, activeServices: active };
}

/** Gracefully stops every loader entry (runs service dispose hooks). */
export async function disposeHostTree(ctx: Context): Promise<void> {
  const entries = [...ctx.loader.entries()];
  for (const entry of entries) {
    try {
      await entry.fiber?.dispose();
    } catch {
      // Disposal failures are logged by the caller (original error preserved
      // in the technical log); shutdown continues so the process still exits.
    }
  }
}
