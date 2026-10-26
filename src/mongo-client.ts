/**
 * Cloudflare-safe MongoLite client base class.
 *
 * This module does NOT import `better-sqlite3` and is safe to use inside
 * Cloudflare Workers / Durable Objects. It exports the core `MongoLite` class
 * that accepts any `IDatabaseAdapter` implementation.
 *
 * Node.js consumers should import from the package root (`@semics-tech/mongolite`) which
 * provides additional constructor overloads accepting a file path or options object.
 */
import type { IDatabaseAdapter } from './db.js';
import { MongoLiteCollection } from './collection.js';
import { DocumentWithId } from './types.js';
import { SyncReplicator } from './sync/replicator.js';
import type { SyncOptions, SyncSink } from './sync/types.js';
import { ClientSession } from './session.js';
import {
  GatedAdapter,
  MongoLiteTransactionError,
  TransactionGate,
} from './utils/transaction-gate.js';

export { ClientSession } from './session.js';
export type { SessionOptions, TransactionOptions, WithTransactionOptions } from './session.js';
export { MongoLiteTransactionError, TransactionBusyError } from './utils/transaction-gate.js';

export type { IDatabaseAdapter };

export type MongoLiteBaseOptions = {
  verbose?: boolean;
  /**
   * How long (ms) an operation waits for another transaction on the same
   * connection to finish before failing. Defaults to 5000; `0` waits forever.
   */
  transactionLockTimeoutMs?: number;
};

/**
 * Core MongoLite client. Accepts any `IDatabaseAdapter` implementation.
 *
 * This class is intentionally free of `better-sqlite3` dependencies so that it
 * can be bundled for Cloudflare Workers / Durable Objects. For Node.js use, prefer
 * importing `MongoLite` from the package root, which adds convenient constructor
 * overloads for file paths and options objects.
 */
export class MongoLite {
  protected db: IDatabaseAdapter;
  protected options: MongoLiteBaseOptions;
  private readonly gated: GatedAdapter;
  private readonly sessions = new Set<ClientSession>();

  constructor(adapter: IDatabaseAdapter, options: MongoLiteBaseOptions = {}) {
    this.db = adapter;
    this.options = options;
    const gate = adapter.transactionGate ?? new TransactionGate();
    if (options.transactionLockTimeoutMs !== undefined) {
      gate.lockTimeoutMs = options.transactionLockTimeoutMs;
    }
    this.gated = new GatedAdapter(adapter, gate);
  }

  /**
   * Starts a session for multi-document transactions, like the MongoDB driver's
   * `client.startSession()`. Supported on the better-sqlite3, `node:sqlite` and
   * sql.js adapters; the Cloudflare adapter throws.
   */
  startSession(): ClientSession {
    if (!this.db.supportsTransactions) {
      throw new MongoLiteTransactionError(
        'Transactions are not supported yet on this adapter (Cloudflare Durable Objects and ' +
          'custom adapters). Use the better-sqlite3, node:sqlite or sql.js adapters.'
      );
    }
    const session = new ClientSession(this.gated, (s) => this.sessions.delete(s));
    this.sessions.add(session);
    return session;
  }

  /** Runs `fn` with a fresh session and always ends it. */
  async withSession<R>(fn: (session: ClientSession) => Promise<R>): Promise<R> {
    const session = this.startSession();
    try {
      return await fn(session);
    } finally {
      await session.endSession();
    }
  }

  /**
   * Connects to the database.
   * For most custom adapters (e.g. Cloudflare) this is a no-op.
   */
  async connect(): Promise<void> {
    return this.db.connect();
  }

  /**
   * Returns the underlying database adapter instance.
   */
  get database(): IDatabaseAdapter {
    return this.db;
  }

  /**
   * Closes the database connection.
   * For most custom adapters (e.g. Cloudflare) this is a no-op.
   */
  async close(): Promise<void> {
    // Abort open transactions first so the lock is released and nothing is left half-written.
    await Promise.all([...this.sessions].map((s) => s.endSession()));
    return this.db.close();
  }

  /**
   * Lists all collections (tables) in the database.
   * @returns An object with a `toArray` method that resolves to an array of collection names.
   */
  listCollections(): { toArray: () => Promise<string[]> } {
    return {
      toArray: async () => {
        // `__mongolite*` tables are internal bookkeeping (change log, sync
        // outbox and checkpoints), not user collections.
        const result = await this.db.all<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__mongolite%'`
        );
        return result.map((row) => row.name);
      },
    };
  }

  /**
   * Starts replicating this database's changes to an upstream {@link SyncSink}.
   *
   * Node.js users replicating to MongoDB should prefer the `syncToMongo`
   * overload on the package-root `MongoLite`, which takes a connection string
   * directly. This method is the backend-agnostic form — pass any sink to
   * replicate over HTTP, into a queue, or to a test double.
   *
   * The returned replicator is **not** started; call `start()` on it.
   */
  createSync(sink: SyncSink, options: SyncOptions = {}): SyncReplicator {
    return new SyncReplicator(this.gated, sink, { verbose: this.options.verbose, ...options });
  }

  /**
   * Returns a typed collection handle.
   * @param name The collection (table) name.
   */
  collection<T extends DocumentWithId = DocumentWithId>(name: string): MongoLiteCollection<T> {
    return new MongoLiteCollection<T>(this.gated, name, this.options);
  }
}
