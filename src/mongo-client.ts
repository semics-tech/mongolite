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

export type { IDatabaseAdapter };

export type MongoLiteBaseOptions = {
  verbose?: boolean;
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

  constructor(adapter: IDatabaseAdapter, options: MongoLiteBaseOptions = {}) {
    this.db = adapter;
    this.options = options;
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
    return new SyncReplicator(this.db, sink, { verbose: this.options.verbose, ...options });
  }

  /**
   * Returns a typed collection handle.
   * @param name The collection (table) name.
   */
  collection<T extends DocumentWithId = DocumentWithId>(name: string): MongoLiteCollection<T> {
    return new MongoLiteCollection<T>(this.db, name, this.options);
  }
}
