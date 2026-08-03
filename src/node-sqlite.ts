/**
 * `node:sqlite`-backed entry point for MongoLite.
 *
 * Import from `mongolite-ts/node-sqlite` to use Node.js's built-in SQLite module
 * instead of the `better-sqlite3` native addon — no prebuilt binary, no `node-gyp`
 * build step. This is a separate entry point (rather than a named export from the
 * main package) because `node:sqlite` requires Node.js 22.5.0+: importing it on an
 * older runtime throws immediately, which would break `mongolite-ts`'s main entry
 * point for everyone still on Node 20/21 if it were imported eagerly there.
 *
 * ## Usage
 *
 * ```ts
 * import { MongoLite, NodeSqliteAdapter } from 'mongolite-ts/node-sqlite';
 *
 * const client = new MongoLite(new NodeSqliteAdapter('./data.db'));
 * await client.connect();
 * const users = client.collection('users');
 * await users.insertOne({ name: 'Alice', age: 30 });
 * await client.close();
 * ```
 */

// Core MongoLite class — accepts any IDatabaseAdapter, no better-sqlite3 dependency.
export { MongoLite } from './mongo-client.js';
export type { MongoLiteBaseOptions } from './mongo-client.js';

// node:sqlite-specific adapter
export { NodeSqliteAdapter } from './adapters/node-sqlite.js';

// Shared types and interfaces
export type { IDatabaseAdapter, MongoLiteOptions } from './db.js';
export { MongoLiteCollection } from './collection.js';
export * from './types.js';

// Change streams
export { ChangeStream } from './changeStream.js';
export type {
  ChangeStreamDocument,
  ChangeStreamOptions,
  ChangeOperationType,
} from './changeStream.js';
