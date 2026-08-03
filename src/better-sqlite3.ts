/**
 * `better-sqlite3`-backed entry point for MongoLite.
 *
 * The main `@semics-tech/mongolite` entry point defaults to `NodeSqliteAdapter`, backed by
 * Node.js's built-in `node:sqlite` module, which requires Node.js 22.5.0+. Import
 * from `@semics-tech/mongolite/better-sqlite3` instead if you need to run on an older
 * Node.js runtime, or you simply prefer the more battle-tested `better-sqlite3`
 * native addon.
 *
 * `better-sqlite3` is an **optional dependency** of this package — install it
 * yourself if it wasn't already pulled in:
 *
 * ```bash
 * npm install better-sqlite3
 * ```
 *
 * ## Usage
 *
 * ```ts
 * import { MongoLite } from '@semics-tech/mongolite/better-sqlite3';
 *
 * const client = new MongoLite('./myapp.sqlite');
 * await client.connect();
 * const users = client.collection('users');
 * await users.insertOne({ name: 'Alice', age: 30 });
 * await client.close();
 * ```
 */

import { SQLiteDB } from './db.js';
import type { IDatabaseAdapter, MongoLiteOptions as DBMongoLiteOptions } from './db.js';
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
export { SQLiteDB } from './db.js';

export interface MongoLiteClientOptions extends DBMongoLiteOptions {}

/**
 * MongoLite client backed by the `better-sqlite3` native addon.
 *
 * You can construct it with:
 * - A file path string — uses the built-in `SQLiteDB` (`better-sqlite3`) adapter.
 * - A `MongoLiteClientOptions` object — uses the built-in adapter with options.
 * - An `IDatabaseAdapter` instance — use a custom adapter for other backends.
 */
export class MongoLite extends MongoLiteBase {
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
      super(dbPathOrOptions as IDatabaseAdapter, options);
    } else {
      super(new SQLiteDB(dbPathOrOptions as string | MongoLiteClientOptions), options);
    }
  }
}
