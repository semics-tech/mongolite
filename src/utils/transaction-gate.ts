import type { IDatabaseAdapter } from '../db.js';

/** Default time (ms) an operation waits for the transaction lock before failing. */
export const DEFAULT_TRANSACTION_LOCK_TIMEOUT_MS = 5000;

/** Thrown for misuse of a session or a failed transaction. */
export class MongoLiteTransactionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'MongoLiteTransactionError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Thrown when `BEGIN IMMEDIATE` could not take SQLite's write lock (`SQLITE_BUSY`). */
export class TransactionBusyError extends MongoLiteTransactionError {
  /** The caller may retry the whole transaction. */
  readonly retryable = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransactionBusyError';
  }
}

interface Waiter {
  kind: 'shared' | 'exclusive';
  grant: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Per-connection read/write gate.
 *
 * Every ordinary statement takes a *shared* hold for its duration; a
 * transaction takes the *exclusive* hold from `BEGIN` to `COMMIT`/`ROLLBACK`.
 * While a transaction is open, statements from callers that are not part of it
 * queue here, so they can never land inside (or be rolled back with) someone
 * else's transaction. Waiters are served first-in first-out, and give up with
 * a {@link MongoLiteTransactionError} after {@link lockTimeoutMs}.
 */
export class TransactionGate {
  /** How long a caller waits for the gate before failing. `0` or less disables the timeout. */
  lockTimeoutMs = DEFAULT_TRANSACTION_LOCK_TIMEOUT_MS;

  private exclusiveHeld = false;
  private sharedCount = 0;
  private queue: Waiter[] = [];

  /** True while a transaction holds the gate. */
  get locked(): boolean {
    return this.exclusiveHeld;
  }

  acquireShared(): Promise<() => void> {
    return this.acquire('shared');
  }

  acquireExclusive(): Promise<() => void> {
    return this.acquire('exclusive');
  }

  private canGrant(kind: Waiter['kind']): boolean {
    return kind === 'shared' ? !this.exclusiveHeld : !this.exclusiveHeld && this.sharedCount === 0;
  }

  private take(kind: Waiter['kind']): () => void {
    if (kind === 'shared') this.sharedCount++;
    else this.exclusiveHeld = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === 'shared') this.sharedCount--;
      else this.exclusiveHeld = false;
      this.pump();
    };
  }

  private acquire(kind: Waiter['kind']): Promise<() => void> {
    if (this.queue.length === 0 && this.canGrant(kind)) {
      return Promise.resolve(this.take(kind));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        grant: () => resolve(this.take(kind)),
        reject,
        timer: null,
      };
      if (this.lockTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          reject(
            new MongoLiteTransactionError(
              `Timed out after ${this.lockTimeoutMs}ms waiting for another transaction on this ` +
                'connection to finish. Did a transaction callback run an operation without ' +
                '{ session }, or was a transaction never committed or aborted?'
            )
          );
          this.pump();
        }, this.lockTimeoutMs);
      }
      this.queue.push(waiter);
    });
  }

  private pump(): void {
    while (this.queue.length > 0 && this.canGrant(this.queue[0].kind)) {
      const waiter = this.queue.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.grant();
    }
  }
}

/** One gate per shared connection key, so instances sharing a handle share the gate. */
const sharedGates = new Map<string, TransactionGate>();

/** Returns the gate for a connection: shared per `shareKey`, otherwise private. */
export function gateForConnection(shareKey: string | null): TransactionGate {
  if (!shareKey) return new TransactionGate();
  let gate = sharedGates.get(shareKey);
  if (!gate) {
    gate = new TransactionGate();
    sharedGates.set(shareKey, gate);
  }
  return gate;
}

/**
 * Adapter wrapper that routes every statement through a {@link TransactionGate}.
 * `MongoLite.collection()` builds collections on this, so un-sessioned
 * operations wait while a transaction is open.
 */
export class GatedAdapter implements IDatabaseAdapter {
  constructor(
    readonly raw: IDatabaseAdapter,
    readonly gate: TransactionGate
  ) {}

  connect(): Promise<void> {
    return this.raw.connect();
  }

  close(): Promise<void> {
    return this.raw.close();
  }

  private async shared<R>(fn: () => Promise<R>): Promise<R> {
    const release = await this.gate.acquireShared();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  run(sql: string, params?: unknown[]): Promise<{ lastID: number; changes: number }> {
    return this.shared(() => this.raw.run(sql, params));
  }

  get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    return this.shared(() => this.raw.get<T>(sql, params));
  }

  all<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.shared(() => this.raw.all<T>(sql, params));
  }

  exec(sql: string): Promise<void> {
    return this.shared(() => this.raw.exec(sql));
  }

  /**
   * Runs `fn` as one atomic unit (`BEGIN` … `COMMIT`, `ROLLBACK` on error)
   * holding the gate exclusively, so no other statement interleaves.
   */
  async runAtomic<R>(fn: (db: IDatabaseAdapter) => Promise<R>): Promise<R> {
    const release = await this.gate.acquireExclusive();
    try {
      await this.raw.exec('BEGIN TRANSACTION');
      try {
        const result = await fn(this.raw);
        await this.raw.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          await this.raw.exec('ROLLBACK');
        } catch (rollbackError) {
          console.error('Error during rollback:', rollbackError);
        }
        throw error;
      }
    } finally {
      release();
    }
  }
}
