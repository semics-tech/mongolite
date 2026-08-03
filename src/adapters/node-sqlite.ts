import { DatabaseSync } from 'node:sqlite';
import type { IDatabaseAdapter, MongoLiteOptions } from '../db.js';

/** Scalar values `node:sqlite` accepts as bound statement parameters. */
type SqlBindValue = string | number | bigint | null | NodeJS.ArrayBufferView;

/**
 * Database adapter backed by Node.js's built-in `node:sqlite` module — no native
 * addon, no prebuilt binary, no `node-gyp`. Requires Node.js 22.5.0+ (the module
 * is marked experimental by Node.js until it graduates to stable).
 *
 * ## Usage
 *
 * ```ts
 * import { MongoLite, NodeSqliteAdapter } from 'mongolite-ts';
 *
 * const client = new MongoLite(new NodeSqliteAdapter('./data.db'));
 * await client.connect();
 * const users = client.collection('users');
 * await users.insertOne({ name: 'Alice', age: 30 });
 * await client.close();
 * ```
 *
 * ## Limitations
 *
 * - **Experimental.** `node:sqlite` is still marked experimental upstream and its
 *   API may change between Node.js minor versions.
 * - **Node.js 22.5.0+ only.** Importing this adapter on an older runtime (or on
 *   Bun/Deno without a `node:sqlite` polyfill) throws at import time.
 * - Rows are returned with a `null` prototype (per `node:sqlite`'s API). Plain
 *   property access (`row.foo`) and `JSON.stringify`/`Object.keys` all work as
 *   expected; `row.hasOwnProperty(...)` does not.
 */
export class NodeSqliteAdapter implements IDatabaseAdapter {
  private db: DatabaseSync | null = null;
  private readonly filePath: string;
  private readonly verbose: boolean;
  private readonly readOnly: boolean;
  private readonly WAL: boolean;
  private openPromise: Promise<void> | null = null;

  /**
   * @param dbPathOrOptions Path to the SQLite database file (use `':memory:'`
   * for an in-memory database), or an options object mirroring the built-in
   * `better-sqlite3` adapter's `MongoLiteOptions`.
   */
  constructor(dbPathOrOptions: string | MongoLiteOptions) {
    if (typeof dbPathOrOptions === 'string') {
      this.filePath = dbPathOrOptions;
      this.verbose = false;
      this.readOnly = false;
      this.WAL = false;
    } else {
      this.filePath = dbPathOrOptions.filePath;
      this.verbose = dbPathOrOptions.verbose || false;
      this.readOnly = dbPathOrOptions.readOnly || false;
      this.WAL = dbPathOrOptions.WAL || true;
    }
  }

  /**
   * Opens the database connection if it's not already open.
   */
  public async connect(): Promise<void> {
    if (this.db && this.openPromise) {
      return this.openPromise;
    }
    if (this.db) {
      return Promise.resolve();
    }

    this.openPromise = new Promise((resolve, reject) => {
      try {
        this.db = new DatabaseSync(this.filePath, { readOnly: this.readOnly });

        if (this.WAL && !this.readOnly) {
          this.db.exec('PRAGMA journal_mode = WAL');
        }

        // Register regexp UDF for $regex operator support.
        // WARNING: Patterns are compiled via JavaScript RegExp. User-supplied patterns that are
        // not validated for catastrophic backtracking (ReDoS) could block the event loop.
        // Avoid using untrusted/unvalidated patterns with $regex in security-sensitive contexts.
        this.db.function(
          'regexp',
          { deterministic: true },
          (pattern: unknown, value: unknown): number => {
            if (typeof pattern !== 'string' || value === null || value === undefined) return 0;
            try {
              return new RegExp(pattern).test(String(value)) ? 1 : 0;
            } catch {
              return 0;
            }
          }
        );

        // Register regexp_flags UDF for $regex with $options support
        this.db.function(
          'regexp_flags',
          { deterministic: true },
          (pattern: unknown, flags: unknown, value: unknown): number => {
            if (typeof pattern !== 'string' || value === null || value === undefined) return 0;
            try {
              const f = typeof flags === 'string' ? flags : '';
              return new RegExp(pattern, f).test(String(value)) ? 1 : 0;
            } catch {
              return 0;
            }
          }
        );

        if (this.verbose) {
          console.log(`SQLite database opened (node:sqlite): ${this.filePath}`);
        }

        resolve();
      } catch (err) {
        console.error(`Error opening database ${this.filePath}:`, (err as Error).message);
        this.db = null;
        this.openPromise = null;
        reject(err);
      }
    });

    return this.openPromise;
  }

  private async ensureConnected(): Promise<DatabaseSync> {
    if (!this.db || !this.openPromise) {
      await this.connect();
    } else {
      await this.openPromise;
    }

    if (!this.db) {
      throw new Error('Database is not connected. Connection attempt failed.');
    }
    return this.db;
  }

  public async run(
    sql: string,
    params: unknown[] = []
  ): Promise<{ lastID: number; changes: number }> {
    const dbInstance = await this.ensureConnected();
    try {
      const result = dbInstance.prepare(sql).run(...(params as SqlBindValue[]));
      return {
        lastID: Number(result.lastInsertRowid),
        changes: Number(result.changes),
      };
    } catch (err) {
      console.error(`Error running SQL: ${sql}`, err);
      throw err;
    }
  }

  public async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const dbInstance = await this.ensureConnected();
    try {
      return dbInstance.prepare(sql).get(...(params as SqlBindValue[])) as T | undefined;
    } catch (err) {
      console.error(`Error getting SQL: ${sql}`, err);
      throw err;
    }
  }

  public async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const dbInstance = await this.ensureConnected();
    try {
      return dbInstance.prepare(sql).all(...(params as SqlBindValue[])) as T[];
    } catch (err) {
      console.error(`Error getting all SQL: ${sql}`, err);
      throw err;
    }
  }

  public async exec(sql: string): Promise<void> {
    const dbInstance = await this.ensureConnected();
    try {
      dbInstance.exec(sql);
    } catch (err) {
      console.error(`Error executing SQL: ${sql}`, err);
      throw err;
    }
  }

  public async close(): Promise<void> {
    if (this.openPromise) {
      await this.openPromise;
    }
    if (this.db) {
      try {
        this.db.close();
        if (this.verbose) {
          console.log(`SQLite database closed (node:sqlite): ${this.filePath}`);
        }
      } catch (err) {
        console.error(`Error closing database ${this.filePath}:`, (err as Error).message);
        throw err;
      } finally {
        this.db = null;
        this.openPromise = null;
      }
    } else {
      this.db = null;
      this.openPromise = null;
    }
  }

  /**
   * Gets the underlying `node:sqlite` `DatabaseSync` instance.
   * Useful for operations not covered by this wrapper.
   */
  public async getDbInstance(): Promise<DatabaseSync> {
    return this.ensureConnected();
  }
}
