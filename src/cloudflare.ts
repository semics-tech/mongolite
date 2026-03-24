/**
 * Cloudflare-safe entry point for MongoLite.
 *
 * Import from `mongolite-ts/cloudflare` inside Cloudflare Workers / Durable Objects.
 * This module does **not** import `better-sqlite3`, so it bundles cleanly with `wrangler`.
 *
 * ## Requirements
 *
 * - Enable **Node.js compatibility** in your Worker configuration (e.g. `nodejs_compat`
 *   flag in `wrangler.toml`/`wrangler.jsonc`). The `ChangeStream` class depends on
 *   Node's built-in `events` module, which requires this flag even if you don't use
 *   change streams directly.
 *
 * ## Usage
 *
 * ```ts
 * import { DurableObject } from 'cloudflare:workers';
 * import { MongoLite, CloudflareDurableObjectAdapter } from 'mongolite-ts/cloudflare';
 *
 * export class MyDurableObject extends DurableObject {
 *   private client: MongoLite;
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.client = new MongoLite(new CloudflareDurableObjectAdapter(ctx.storage.sql));
 *     ctx.blockConcurrencyWhile(() => this.client.collection('users').ensureTable());
 *   }
 * }
 * ```
 */

// Core MongoLite class — accepts any IDatabaseAdapter, no better-sqlite3 dependency.
export { MongoLite } from './mongo-client.js';
export type { MongoLiteBaseOptions } from './mongo-client.js';

// Cloudflare-specific adapter
export { CloudflareDurableObjectAdapter } from './adapters/cloudflare.js';
export type {
  SqlStorage,
  SqlStorageCursor,
  SqlStorageValue,
} from './adapters/cloudflare.js';

// Shared types and interfaces
export type { IDatabaseAdapter } from './db.js';
export { MongoLiteCollection } from './collection.js';
export * from './types.js';

// Change streams (requires nodejs_compat in Workers)
export { ChangeStream } from './changeStream.js';
export type {
  ChangeStreamDocument,
  ChangeStreamOptions,
  ChangeOperationType,
} from './changeStream.js';
