import { SQLiteDB, IDatabaseAdapter, MongoLiteOptions as DBMongoLiteOptions } from './db.js';
import { MongoLiteCollection } from './collection.js';
import { DocumentWithId } from './types.js';

export { MongoLiteCollection } from './collection.js';
export * from './types.js';
export { ChangeStream } from './changeStream.js';
export type {
  ChangeStreamDocument,
  ChangeStreamOptions,
  ChangeOperationType,
} from './changeStream.js';
export type { IDatabaseAdapter } from './db.js';
export {
  CloudflareDurableObjectAdapter,
} from './adapters/cloudflare.js';
export type {
  SqlStorage,
  SqlStorageCursor,
  SqlStorageValue,
} from './adapters/cloudflare.js';

export interface MongoLiteClientOptions extends DBMongoLiteOptions {}

type MongoLiteOptions = {
  verbose?: boolean;
};
/**
 * MongoLite class is the main entry point for interacting with the SQLite-backed database.
 *
 * You can construct it with:
 * - A file path string — uses the built-in `better-sqlite3` adapter.
 * - A `MongoLiteClientOptions` object — uses the built-in adapter with options.
 * - An `IDatabaseAdapter` instance — use a custom adapter such as
 *   `CloudflareDurableObjectAdapter` for Cloudflare Durable Objects.
 */
export class MongoLite {
  private db: IDatabaseAdapter;
  private options: MongoLiteOptions;

  /**
   * Creates a new MongoLite client instance.
   * @param dbPathOrOptions Path to the SQLite database file, an options object,
   *                        or an `IDatabaseAdapter` for custom backends.
   */
  constructor(
    dbPathOrOptions: string | MongoLiteClientOptions | IDatabaseAdapter,
    options: MongoLiteOptions = {}
  ) {
    if (
      typeof dbPathOrOptions === 'object' &&
      'connect' in dbPathOrOptions &&
      'run' in dbPathOrOptions &&
      'get' in dbPathOrOptions &&
      'all' in dbPathOrOptions &&
      'exec' in dbPathOrOptions &&
      'close' in dbPathOrOptions
    ) {
      // Custom adapter (e.g. CloudflareDurableObjectAdapter)
      this.db = dbPathOrOptions as IDatabaseAdapter;
    } else {
      this.db = new SQLiteDB(dbPathOrOptions as string | MongoLiteClientOptions);
    }
    this.options = options;
  }

  /**
   * Connects to the database.
   * For the built-in SQLite adapter this opens the file.
   * For custom adapters (e.g. Cloudflare) this is typically a no-op.
   * @returns {Promise<void>} A promise that resolves when connected.
   */
  async connect(): Promise<void> {
    return this.db.connect();
  }

  /**
   * Get the underlying database adapter instance.
   * @returns {IDatabaseAdapter} The database adapter.
   */
  get database(): IDatabaseAdapter {
    return this.db;
  }

  /**
   * Closes the database connection.
   * For custom adapters (e.g. Cloudflare) this is typically a no-op.
   */
  async close(): Promise<void> {
    return this.db.close();
  }

  /**
   * Lists all collections (tables) in the database.
   * @returns An object with a toArray method that resolves to an array of collection names.
   */
  listCollections(): { toArray: () => Promise<string[]> } {
    // Query the SQLite schema to get all user-created tables
    return {
      toArray: async () => {
        const result = await this.db.all<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
        );
        return result.map((row) => row.name);
      },
    };
  }

  /**
   * Gets a collection (table) in the database.
   * @param name The name of the collection.
   * @returns A MongoLiteCollection instance.
   */
  collection<T extends DocumentWithId = DocumentWithId>(name: string): MongoLiteCollection<T> {
    return new MongoLiteCollection<T>(this.db, name, this.options);
  }
}
