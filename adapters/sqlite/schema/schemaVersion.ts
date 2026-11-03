/**
 * Single source of truth for the Rondo SQLite schema version (A-owned;
 * adapters/sqlite/schema/** is the only place DDL may live).
 *
 * schemaVersion = 1 corresponds to 0001_init.sql. The adapter (B) reads this
 * on open and rejects with SCHEMA_MISMATCH when the database disagrees.
 */
export const SCHEMA_VERSION = 1 as const;

export type SchemaVersion = typeof SCHEMA_VERSION;

export function assertSupportedSchemaVersion(version: number): void {
  if (version !== SCHEMA_VERSION) {
    throw new Error(`SCHEMA_MISMATCH: expected schema version ${SCHEMA_VERSION}, found ${version}`);
  }
}
