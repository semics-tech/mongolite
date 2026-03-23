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
export { SQLiteDB } from './db.js';
export type { IDatabaseAdapter, MongoLiteOptions as MongoLiteNodeOptions } from './db.js';
export { SqlJsAdapter } from './adapters/sqljs.js';
export type { SqlJsAdapterOptions } from './adapters/sqljs.js';

export interface MongoLiteClientOptions extends DBMongoLiteOptions {}

/**
 * Options accepted by the MongoLite constructor when not using a file-path string.
 * Providing an `adapter` lets callers plug in any IDatabaseAdapter implementation,
 * including SqlJsAdapter for browser environments.
 */
export interface MongoLiteAdapterOptions {
  /** A pre-constructed IDatabaseAdapter (e.g. SqlJsAdapter for browser use). */
  adapter: IDatabaseAdapter;
  verbose?: boolean;
}

type MongoLiteOptions = {
  verbose?: boolean;
};
/**
 * MongoLite class is the main entry point for interacting with the SQLite-backed database.
 *
 * Three usage modes are supported:
 *
 * 1. **File mode** (Node.js) – persists to a SQLite file on disk:
 *    ```ts
 *    const client = new MongoLite('./my.db');
 *    ```
 *
 * 2. **In-memory mode** (Node.js) – ephemeral in-process database:
 *    ```ts
 *    const client = new MongoLite(':memory:');
 *    ```
 *
 * 3. **Browser / custom adapter mode** – uses any IDatabaseAdapter, e.g. SqlJsAdapter:
 *    ```ts
 *    import { MongoLite, SqlJsAdapter } from 'mongolite-ts';
 *    const client = new MongoLite({ adapter: new SqlJsAdapter() });
 *    // or with IndexedDB persistence:
 *    const client = new MongoLite({
 *      adapter: new SqlJsAdapter({ persistence: 'indexeddb', dbName: 'my-app' }),
 *    });
 *    ```
 */
export class MongoLite {
  private db: IDatabaseAdapter;
  private options: MongoLiteOptions;

  /**
   * Creates a new MongoLite client instance.
   *
   * @param dbPathOrOptions
   *   - A string path to a SQLite file (or `':memory:'` for in-memory) uses the
   *     built-in Node.js adapter (better-sqlite3).
   *   - A `MongoLiteClientOptions` object likewise uses the Node.js adapter.
   *   - A `MongoLiteAdapterOptions` object with an `adapter` property uses the
   *     supplied IDatabaseAdapter (e.g. SqlJsAdapter for browser environments).
   */
  constructor(
    dbPathOrOptions: string | MongoLiteClientOptions | MongoLiteAdapterOptions,
    options: MongoLiteOptions = {}
  ) {
    if (
      typeof dbPathOrOptions === 'object' &&
      'adapter' in dbPathOrOptions &&
      dbPathOrOptions.adapter
    ) {
      this.db = dbPathOrOptions.adapter;
      this.options = { verbose: dbPathOrOptions.verbose, ...options };
    } else {
      this.db = new SQLiteDB(dbPathOrOptions as string | MongoLiteClientOptions);
      this.options = options;
    }
  }

  /**
   * Connects to the SQLite database.
   * @returns {Promise<void>} A promise that resolves when connected.
   */
  async connect(): Promise<void> {
    return this.db.connect();
  }

  /**
   * Get the underlying database adapter instance for advanced operations or testing.
   * @returns {IDatabaseAdapter} The active adapter.
   */
  get database(): IDatabaseAdapter {
    return this.db;
  }

  /**
   * Closes the database connection.
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
