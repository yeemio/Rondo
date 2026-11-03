/**
 * SQLite connection opening, per-connection pragmas and the migration runner.
 *
 * Frozen sources:
 * - SCHEMA-README.md (connection conventions: WAL, foreign_keys ON,
 *   synchronous FULL, BEGIN IMMEDIATE write transactions, bound parameters)
 * - B-D3 (synchronous=FULL: a returned receipt implies the fact is fsynced)
 * - SCHEMA-README migration rules 1-3 (single-transaction apply, appliedAt
 *   rewrite with the real clock, version check against schemaVersion.ts)
 *
 * A corrupted database file makes `new DatabaseSync(file)` throw; this module
 * never recreates or overwrites the file (LIFECYCLE §7: damaged database goes
 * to the read-only recovery path, never a fresh empty replacement).
 */
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations';
import { SCHEMA_VERSION } from './schema/schemaVersion';

export class SchemaMismatchError extends Error {
  constructor(message: string) {
    super(`SCHEMA_MISMATCH: ${message}`);
    this.name = 'SchemaMismatchError';
  }
}

export interface OpenConnectionOptions {
  /** Server millisecond clock; used for schema_migrations.appliedAt. */
  readonly now: () => number;
}

/** Applies pending migrations (each in one transaction) and verifies the version. */
export function runMigrations(db: DatabaseSync, now: () => number): number {
  let applied = 0;
  const registryVersions = new Set(MIGRATIONS.map((m) => m.version));
  let appliedVersions = new Set<number>();
  try {
    const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
    appliedVersions = new Set(rows.map((r) => r.version));
  } catch {
    // schema_migrations does not exist yet on a fresh database.
    appliedVersions = new Set();
  }
  // A database carrying versions this build does not know (downgrade or
  // tampering) must be refused, never re-migrated over.
  for (const version of appliedVersions) {
    if (!registryVersions.has(version)) {
      throw new SchemaMismatchError(`database carries unknown migration version ${version}`);
    }
  }
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.prepare('UPDATE schema_migrations SET appliedAt = ? WHERE version = ?').run(now(), migration.version);
      db.exec('COMMIT');
      applied += 1;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  const found = row.v ?? 0;
  if (found !== SCHEMA_VERSION) {
    throw new SchemaMismatchError(`expected schema version ${SCHEMA_VERSION}, found ${found}`);
  }
  return applied;
}

/** Opens the database, applies per-connection pragmas, runs migrations. */
export function openConnection(file: string, options: OpenConnectionOptions): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA synchronous = FULL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    runMigrations(db, options.now);
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // best effort; the open failure is the reported problem
    }
    throw err;
  }
}

/** Returns the applied schema version (MAX(schema_migrations.version)). */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

/**
 * Consistent-snapshot backup of an open database into a NEW file, using
 * `VACUUM INTO` (the node:sqlite equivalent of the SQLite backup API; the
 * statement produces a transactionally consistent copy and cannot run inside
 * a write transaction, which is exactly the isolation we want).
 */
export function backupDatabaseToFile(db: DatabaseSync, destinationFile: string): void {
  db.prepare('VACUUM INTO ?').run(destinationFile);
}
