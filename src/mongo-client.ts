/**
 * Cloudflare-safe MongoLite client base class.
 *
 * This module does NOT import `better-sqlite3` and is safe to use inside
 * Cloudflare Workers / Durable Objects. It exports the core `MongoLite` class
 * that accepts any `IDatabaseAdapter` implementation.
 *
 * Node.js consumers should import from the package root (`mongolite-ts`) which
 * provides additional constructor overloads accepting a file path or options object.
 */
import type { IDatabaseAdapter } from './db.js';
import { MongoLiteCollection } from './collection.js';
import { DocumentWithId } from './types.js';

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
        const result = await this.db.all<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
        );
        return result.map((row) => row.name);
      },
    };
  }

  /**
   * Returns a typed collection handle.
   * @param name The collection (table) name.
   */
  collection<T extends DocumentWithId = DocumentWithId>(name: string): MongoLiteCollection<T> {
    return new MongoLiteCollection<T>(this.db, name, this.options);
  }
}
