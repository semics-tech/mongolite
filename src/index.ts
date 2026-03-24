import { SQLiteDB, IDatabaseAdapter, MongoLiteOptions as DBMongoLiteOptions } from './db.js';
import { MongoLite as MongoLiteBase, MongoLiteBaseOptions } from './mongo-client.js';

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
export { BrowserSqliteAdapter } from './adapters/browser.js';
export type { SqlJsDatabase, SqlJsStatement } from './adapters/browser.js';

export interface MongoLiteClientOptions extends DBMongoLiteOptions {}

/**
 * MongoLite class is the main entry point for interacting with the SQLite-backed database.
 *
 * You can construct it with:
 * - A file path string — uses the built-in `better-sqlite3` adapter.
 * - A `MongoLiteClientOptions` object — uses the built-in adapter with options.
 * - An `IDatabaseAdapter` instance — use a custom adapter such as
 *   `CloudflareDurableObjectAdapter` for Cloudflare Durable Objects.
 */
export class MongoLite extends MongoLiteBase {
  /**
   * Creates a new MongoLite client instance.
   * @param dbPathOrOptions Path to the SQLite database file, an options object,
   *                        or an `IDatabaseAdapter` for custom backends.
   */
  constructor(
    dbPathOrOptions: string | MongoLiteClientOptions | IDatabaseAdapter,
    options: MongoLiteBaseOptions = {}
  ) {
    if (
      dbPathOrOptions &&
      typeof dbPathOrOptions === 'object' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).connect === 'function' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).run === 'function' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).get === 'function' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).all === 'function' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).exec === 'function' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).close === 'function'
    ) {
      // Custom adapter (e.g. CloudflareDurableObjectAdapter)
      super(dbPathOrOptions as IDatabaseAdapter, options);
    } else {
      super(new SQLiteDB(dbPathOrOptions as string | MongoLiteClientOptions), options);
    }
  }
}
