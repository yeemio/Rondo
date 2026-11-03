/**
 * Migration registry (B-owned, adapters/sqlite/** excluding schema/**).
 *
 * Each entry imports one A-owned `schema/NNNN_name.sql` file as text. The
 * registry is explicit and monotonic; a new migration from A lands as one new
 * import plus one array entry. No DDL is defined here.
 */
import migration0001 from './schema/0001_init.sql';

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly MigrationFile[] = [
  { version: 1, name: '0001_init', sql: migration0001 },
];
