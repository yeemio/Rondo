/**
 * StoragePort implementation over node:sqlite.
 *
 * Frozen sources:
 * - modules/contracts/server/storage.ts (tx = BEGIN IMMEDIATE short write
 *   transaction; read = read-only; Repositories obtainable only inside the
 *   callbacks; close() -> CloseReport with connection close left to the owner)
 * - server-ports-recommendation.md §5 (close order step 4: confirm no pending
 *   transactions -> release statements -> checkpoint WAL -> report)
 * - B-D3 (synchronous=FULL; close checkpoints WAL)
 *
 * Single-writer discipline: write transactions and reads are serialized
 * through one async chain on the single connection. A corrupted database file
 * makes the constructor throw and is never replaced.
 */
import type { DatabaseSync } from 'node:sqlite';
import { openConnection, readSchemaVersion } from './connection';
import { SqliteRepositories } from './repositories';
import { executeDisposal, type DisposalResult, type DisposalSpec } from './disposal';
import { SCHEMA_VERSION } from './schema/schemaVersion';
import type { CloseReport, Repositories, StoragePort, TxHandle } from '../../modules/contracts/server/storage';

export interface SqliteStorageOptions {
  /** Database file path (':memory:' for an in-memory database). */
  readonly file: string;
  /** Server millisecond clock (repository timestamps, CAS endedAt, revocations). */
  readonly now: () => number;
}

export class SqliteStorage implements StoragePort {
  private readonly db: DatabaseSync;
  private readonly repos: SqliteRepositories;
  private closed = false;
  private inFlightTxs = 0;
  private txOpen = false;
  private txCounter = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: SqliteStorageOptions) {
    this.db = openConnection(options.file, { now: options.now });
    this.repos = new SqliteRepositories({
      db: this.db,
      now: options.now,
      statementCache: new Map(),
    });
  }

  /** Host/test maintenance only: the raw connection (the one tx/read use). */
  rawDatabase(): DatabaseSync {
    return this.db;
  }

  /**
   * B-internal seam for the content service's synchronous public-material
   * projection: instance row without family scope (no family data leaks;
   * authorization is the learning server's job). See modules/content/index.ts.
   */
  findInstanceUnscopedSync(questionInstanceId: string): ReturnType<SqliteRepositories['questionInstance']['findByIdUnscopedSync']> {
    // Single synchronous SELECT on the same connection; node:sqlite
    // statements execute synchronously, so no chain serialization is needed.
    return this.repos.questionInstance.findByIdUnscopedSync(questionInstanceId);
  }

  /** B-internal seam: synchronous release-status lookup for ContentService.releaseStatus. */
  findReleaseStatusSync(releaseId: string): string | null {
    const row = this.db.prepare('SELECT status FROM contentRelease WHERE releaseId = ?').get(releaseId) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  }

  schemaVersion(): number {
    return readSchemaVersion(this.db);
  }

  async tx<T>(name: string, fn: (repos: Repositories, tx: TxHandle) => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error('PERSISTENCE_FAILED: storage is closed to new transactions');
    }
    const run = this.tail.then(async () => {
      if (this.closed) {
        throw new Error('PERSISTENCE_FAILED: storage closed while queued');
      }
      this.inFlightTxs += 1;
      this.txCounter += 1;
      const txId = `tx-${this.txCounter}`;
      this.txOpen = true;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this.repos as unknown as Repositories, { txName: name, txId });
        this.db.exec('COMMIT');
        this.txOpen = false;
        return result;
      } catch (err) {
        this.txOpen = false;
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // transaction already ended; the original error is the real failure
        }
        throw err;
      } finally {
        this.inFlightTxs -= 1;
      }
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  async read<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error('PERSISTENCE_FAILED: storage is closed');
    }
    // Serialize reads against write transactions on the same connection so a
    // read never observes a half-open transaction.
    const run = this.tail.then(() => fn(this.repos as unknown as Repositories));
    this.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * Disposal extension (B-internal seam, NOT part of the frozen StoragePort):
   * deletes rows per spec; MUST be called from inside a tx callback.
   */
  dispose(spec: DisposalSpec): DisposalResult {
    if (!this.txOpen) {
      throw new Error('PERSISTENCE_FAILED: dispose must run inside an open transaction');
    }
    return executeDisposal(this.db, spec);
  }

  async close(): Promise<CloseReport> {
    this.closed = true;
    // Bounded drain: wait for the current chain to settle.
    await this.tail;
    const pendingTransactions = this.inFlightTxs;
    let walCheckpointed = false;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      walCheckpointed = true;
    } catch {
      walCheckpointed = false;
    }
    const releasedStatements = this.repos.statementCount();
    return { pendingTransactions, releasedStatements, walCheckpointed };
  }

  /** Closes the underlying connection. The OWNER (A's composition / tests) calls this after close(). */
  closeConnection(): void {
    if (!this.closed) {
      throw new Error('PERSISTENCE_FAILED: call close() before closeConnection()');
    }
    this.db.close();
  }

  static get expectedSchemaVersion(): number {
    return SCHEMA_VERSION;
  }
}

export function createSqliteStorage(options: SqliteStorageOptions): SqliteStorage {
  return new SqliteStorage(options);
}
