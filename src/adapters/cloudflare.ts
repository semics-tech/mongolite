import { IDatabaseAdapter } from '../db.js';

/**
 * Allowed scalar binding values accepted by Cloudflare's SqlStorage.exec().
 */
export type SqlStorageValue = string | number | boolean | null | ArrayBuffer;

/**
 * Minimal interface for the cursor returned by SqlStorage.exec().
 * This matches the Cloudflare Durable Objects SqlStorage API.
 */
export interface SqlStorageCursor<T = Record<string, SqlStorageValue>> {
  toArray(): T[];
  one(): T;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly columnNames: readonly string[];
}

/**
 * Minimal interface for the Cloudflare Durable Objects SqlStorage API.
 * Pass `ctx.storage.sql` from your Durable Object to the adapter constructor.
 *
 * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
 */
export interface SqlStorage {
  exec<T = Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlStorageCursor<T>;
}

/**
 * Database adapter that wraps the Cloudflare Durable Objects `SqlStorage` API,
 * allowing MongoLite to be used inside a Cloudflare Durable Object.
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
 *     const adapter = new CloudflareDurableObjectAdapter(ctx.storage.sql);
 *     this.client = new MongoLite(adapter);
 *   }
 *
 *   async fetch(request: Request) {
 *     await this.client.connect();
 *     const users = this.client.collection('users');
 *     await users.insertOne({ name: 'Alice', age: 30 });
 *     const user = await users.findOne({ name: 'Alice' });
 *     return Response.json(user);
 *   }
 * }
 * ```
 *
 * ## Limitations
 *
 * - **`$regex` queries are not supported.** Cloudflare's SQLite does not allow custom
 *   SQL functions, so the `regexp()` UDF registered by the default Node.js adapter is
 *   unavailable. Queries using `$regex` will throw a SQL error at runtime.
 * - `WAL` mode and most `PRAGMA` statements are not available in Cloudflare Durable
 *   Objects (Cloudflare manages this internally).
 * - Change Streams (`collection.watch()`) use SQL triggers and a change-log table.
 *   They work in Cloudflare Durable Objects, but the polling mechanism relies on
 *   `setInterval`, which is supported in the Workers runtime.
 */
export class CloudflareDurableObjectAdapter implements IDatabaseAdapter {
  private readonly sql: SqlStorage;

  /**
   * @param sql The `SqlStorage` instance from a Cloudflare Durable Object context
   *            (i.e. `ctx.storage.sql`).
   */
  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  /**
   * No-op: Cloudflare Durable Objects manage the storage lifecycle automatically.
   */
  async connect(): Promise<void> {
    // Nothing to do — the SqlStorage instance is already live.
  }

  /**
   * No-op: Cloudflare Durable Objects manage the storage lifecycle automatically.
   */
  async close(): Promise<void> {
    // Nothing to do — storage is managed by the Durable Object runtime.
  }

  /**
   * Executes a SQL statement that does not return rows (INSERT, UPDATE, DELETE, DDL).
   */
  async run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
    const cursor = this.sql.exec(sql, ...(params as SqlStorageValue[]));
    return { lastID: 0, changes: cursor.rowsWritten };
  }

  /**
   * Executes a SQL query and returns the first matching row, or `undefined`.
   */
  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = this.sql.exec<T>(sql, ...(params as SqlStorageValue[])).toArray();
    return rows[0];
  }

  /**
   * Executes a SQL query and returns all matching rows.
   */
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.sql.exec<T>(sql, ...(params as SqlStorageValue[])).toArray();
  }

  /**
   * Executes a single SQL statement (DDL, transactions, etc.).
   *
   * Cloudflare's `SqlStorage.exec` only supports one statement at a time, and
   * some valid statements (e.g. `CREATE TRIGGER ... BEGIN ...; ...; END;`)
   * contain internal semicolons. Callers must therefore pass exactly one
   * statement per call; this method will not attempt to split multi-statement
   * SQL strings.
   */
  async exec(sql: string): Promise<void> {
    this.sql.exec(sql);
  }
}
