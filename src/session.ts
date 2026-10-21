import { ObjectId } from 'bson';
import type { IDatabaseAdapter } from './db.js';
import {
  GatedAdapter,
  MongoLiteTransactionError,
  TransactionBusyError,
} from './utils/transaction-gate.js';

/** Accepted for driver compatibility and ignored: SQLite has no read/write concern. */
export interface TransactionOptions {
  readConcern?: unknown;
  writeConcern?: unknown;
  readPreference?: unknown;
}

/** Options accepted by collection methods that can join a transaction. */
export interface SessionOptions {
  session?: ClientSession;
}

type SessionState = 'idle' | 'starting' | 'active' | 'committed' | 'aborted';

/**
 * A client session, mirroring the MongoDB Node driver's `ClientSession`.
 * Create one with `client.startSession()`, run `withTransaction`, and pass
 * `{ session }` to every collection call that belongs in the transaction.
 *
 * The transaction holds an exclusive per-connection lock from the first
 * operation until commit or abort; operations without this session wait.
 */
export class ClientSession {
  readonly id: string = new ObjectId().toString();
  private state: SessionState = 'idle';
  private ended = false;
  private release: (() => void) | null = null;
  private beginPromise: Promise<void> | null = null;
  private savepointCounter = 0;
  /** @internal */
  readonly adapter: SessionAdapter;

  /** @internal */
  constructor(
    /** @internal */ readonly gated: GatedAdapter,
    private readonly onEnd: (s: ClientSession) => void
  ) {
    this.adapter = new SessionAdapter(this);
  }

  get hasEnded(): boolean {
    return this.ended;
  }

  inTransaction(): boolean {
    return this.state === 'starting' || this.state === 'active';
  }

  private assertUsable(): void {
    if (this.ended) throw new MongoLiteTransactionError('Cannot use a session that has ended');
  }

  /**
   * Starts a transaction. The SQLite `BEGIN IMMEDIATE` is issued lazily by the
   * first operation (or `withTransaction`), as in the driver.
   */
  startTransaction(_options?: TransactionOptions): void {
    this.assertUsable();
    if (this.inTransaction())
      throw new MongoLiteTransactionError('Transaction already in progress');
    this.state = 'starting';
  }

  /** Takes the connection lock and issues `BEGIN IMMEDIATE`, once. @internal */
  private ensureBegun(): Promise<void> {
    if (!this.beginPromise) {
      this.beginPromise = (async () => {
        const release = await this.gated.gate.acquireExclusive();
        try {
          await this.gated.raw.exec('BEGIN IMMEDIATE');
        } catch (error) {
          release();
          this.state = 'aborted';
          if ((error as { code?: string }).code === 'SQLITE_BUSY') {
            throw new TransactionBusyError('Could not start transaction: database is busy', {
              cause: error,
            });
          }
          throw error;
        }
        this.release = release;
        this.state = 'active';
      })();
    }
    return this.beginPromise;
  }

  private finish(next: SessionState): void {
    this.state = next;
    this.beginPromise = null;
    const release = this.release;
    this.release = null;
    release?.();
  }

  /** @internal Resolves the adapter an operation on this session must use. */
  async opTarget(): Promise<IDatabaseAdapter> {
    this.assertUsable();
    if (this.state === 'starting' || this.state === 'active') {
      await this.ensureBegun();
      return this.gated.raw;
    }
    if (this.state === 'aborted') {
      throw new MongoLiteTransactionError(
        'Transaction was aborted; start a new transaction to continue using this session'
      );
    }
    // No transaction: behaves like an ordinary operation.
    return this.gated;
  }

  /** @internal A statement failed inside the transaction: roll everything back. */
  async failedInTransaction(): Promise<void> {
    if (this.state !== 'active') return;
    try {
      await this.gated.raw.exec('ROLLBACK');
    } catch {
      // Nothing more we can do; the lock is released below regardless.
    }
    this.finish('aborted');
  }

  /** @internal */
  isActive(): boolean {
    return this.state === 'active';
  }

  /** @internal */
  nextSavepoint(): string {
    return `mongolite_sp_${++this.savepointCounter}`;
  }

  async commitTransaction(): Promise<void> {
    this.assertUsable();
    if (this.state === 'aborted') {
      throw new MongoLiteTransactionError(
        'Cannot call commitTransaction after the transaction was aborted'
      );
    }
    if (!this.inTransaction()) throw new MongoLiteTransactionError('No transaction started');
    if (this.state === 'starting' && !this.beginPromise) {
      // Nothing ran: nothing to commit.
      this.finish('committed');
      return;
    }
    await this.beginPromise;
    if (this.state !== 'active') {
      throw new MongoLiteTransactionError('Cannot commit: the transaction was aborted');
    }
    try {
      await this.gated.raw.exec('COMMIT');
    } catch (error) {
      try {
        await this.gated.raw.exec('ROLLBACK');
      } catch {
        // best effort
      }
      this.finish('aborted');
      throw new MongoLiteTransactionError('Transaction commit failed; it was rolled back', {
        cause: error,
      });
    }
    this.finish('committed');
  }

  async abortTransaction(): Promise<void> {
    this.assertUsable();
    if (this.state === 'aborted') {
      throw new MongoLiteTransactionError('Cannot call abortTransaction twice');
    }
    if (!this.inTransaction()) throw new MongoLiteTransactionError('No transaction started');
    await this.rollbackQuietly();
  }

  private async rollbackQuietly(): Promise<void> {
    if (this.beginPromise) {
      try {
        await this.beginPromise;
      } catch {
        // BEGIN failed; nothing to roll back
      }
    }
    if (this.state === 'active') {
      try {
        await this.gated.raw.exec('ROLLBACK');
      } catch (error) {
        console.error('Error during rollback:', error);
      }
    }
    this.finish('aborted');
  }

  /**
   * Runs `fn` in a transaction: commits when it resolves (returning its value),
   * rolls back and rethrows when it throws. Unlike the driver this does not
   * retry automatically; SQLite has no `TransientTransactionError`.
   */
  async withTransaction<R>(
    fn: (session: ClientSession) => Promise<R>,
    options?: TransactionOptions
  ): Promise<R> {
    this.startTransaction(options);
    let result: R;
    try {
      result = await fn(this);
    } catch (error) {
      if (this.inTransaction()) await this.rollbackQuietly();
      throw error;
    }
    if (this.state === 'committed') return result; // callback committed manually
    await this.commitTransaction();
    return result;
  }

  /** Ends the session, aborting any open transaction. Safe to call twice. */
  async endSession(): Promise<void> {
    if (this.ended) return;
    if (this.inTransaction()) await this.rollbackQuietly();
    this.ended = true;
    this.onEnd(this);
  }
}

/**
 * Adapter a session-bound collection runs on: inside a transaction statements
 * go straight to the connection (we hold the lock); otherwise they take the
 * ordinary gated path.
 */
class SessionAdapter implements IDatabaseAdapter {
  constructor(private readonly session: ClientSession) {}

  connect(): Promise<void> {
    return this.session.gated.connect();
  }

  close(): Promise<void> {
    return this.session.gated.close();
  }

  private async op<R>(fn: (db: IDatabaseAdapter) => Promise<R>): Promise<R> {
    const target = await this.session.opTarget();
    try {
      return await fn(target);
    } catch (error) {
      if (target === this.session.gated.raw) await this.session.failedInTransaction();
      throw error;
    }
  }

  run(sql: string, params?: unknown[]) {
    return this.op((db) => db.run(sql, params));
  }

  get<T>(sql: string, params?: unknown[]) {
    return this.op((db) => db.get<T>(sql, params));
  }

  all<T>(sql: string, params?: unknown[]) {
    return this.op((db) => db.all<T>(sql, params));
  }

  exec(sql: string) {
    return this.op((db) => db.exec(sql));
  }

  /** Multi-statement operations become a savepoint inside the transaction. */
  async runAtomic<R>(fn: (db: IDatabaseAdapter) => Promise<R>): Promise<R> {
    const target = await this.session.opTarget();
    if (target !== this.session.gated.raw) return this.session.gated.runAtomic(fn);

    const name = this.session.nextSavepoint();
    await target.exec(`SAVEPOINT ${name}`);
    try {
      const result = await fn(this);
      await target.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      if (this.session.isActive()) {
        try {
          await target.exec(`ROLLBACK TO ${name}`);
          await target.exec(`RELEASE ${name}`);
        } catch {
          // the transaction-level abort handles the rest
        }
      }
      throw error;
    }
  }
}
