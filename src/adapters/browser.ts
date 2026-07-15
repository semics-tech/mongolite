import type { IDatabaseAdapter } from '../db.js';

type SqlJsColumnType = string | number | bigint | null | Uint8Array;
type SqlJsBindParams = SqlJsColumnType[] | Record<string, SqlJsColumnType> | null;

/**
 * Minimal interface representing a sql.js Statement object.
 * @see https://sql.js.org/documentation/Statement.html
 */
export interface SqlJsStatement {
  bind(params?: SqlJsBindParams): boolean;
  step(): boolean;
  getAsObject(params?: SqlJsBindParams | null): Record<string, SqlJsColumnType>;
  free(): boolean;
}

/**
 * Minimal interface representing a sql.js Database object.
 * @see https://sql.js.org/documentation/Database.html
 */
export interface SqlJsDatabase {
  run(sql: string, params?: SqlJsBindParams): SqlJsDatabase;
  exec(sql: string): Array<{ columns: string[]; values: SqlJsColumnType[][] }>;
  prepare(sql: string): SqlJsStatement;
  close(): void;
}

/**
 * Database adapter that wraps a {@link SqlJsDatabase} instance, enabling MongoLite
 * to run in browser environments via [sql.js](https://sql.js.org/).
 *
 * ## Usage
 *
 * Install [sql.js](https://www.npmjs.com/package/sql.js) and initialise it before
 * constructing the adapter:
 *
 * ```ts
 * import initSqlJs from 'sql.js';
 * import { MongoLite, BrowserSqliteAdapter } from 'mongolite-ts';
 *
 * const SQL = await initSqlJs({
 *   locateFile: (file) => `https://cdn.jsdelivr.net/npm/sql.js/dist/${file}`,
 * });
 * const sqlJsDb = new SQL.Database(); // in-memory; persist via OPFS or IndexedDB
 *
 * const client = new MongoLite(new BrowserSqliteAdapter(sqlJsDb));
 * await client.connect();
 * const users = client.collection('users');
 * await users.insertOne({ name: 'Alice', age: 30 });
 * await client.close();
 * ```
 *
 * ## Limitations
 *
 * - **`$regex` queries are not supported** — sql.js does not ship with a `regexp()`
 *   SQL function. Use JS-side filtering as a workaround.
 * - **`lastID` / `changes`** are not exposed by the sql.js API. `run()` always
 *   returns `{ lastID: 0, changes: 0 }`, which is safe because MongoLite does not
 *   use these values internally.
 * - **Persistence** — by default sql.js stores data in memory. For durable storage
 *   use the OPFS back-end or export the database buffer to IndexedDB.
 */
export class BrowserSqliteAdapter implements IDatabaseAdapter {
  private readonly db: SqlJsDatabase;

  /**
   * @param db An initialised sql.js `Database` instance.
   */
  constructor(db: SqlJsDatabase) {
    this.db = db;
  }

  /**
   * No-op: sql.js Database is already open on construction.
   */
  async connect(): Promise<void> {
    // Nothing to do — the sql.js Database is ready to use immediately.
  }

  /**
   * Closes the underlying sql.js Database and frees its WASM memory.
   */
  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Executes a DML statement (INSERT, UPDATE, DELETE) with optional bound parameters.
   * Returns `{ lastID: 0, changes: 0 }` — sql.js does not expose these values.
   */
  async run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
    this.db.run(sql, params as SqlJsColumnType[]);
    return { lastID: 0, changes: 0 };
  }

  /**
   * Executes a SQL query and returns the first matching row, or `undefined`.
   */
  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as SqlJsColumnType[]);
      if (stmt.step()) {
        return stmt.getAsObject() as T;
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  /**
   * Executes a SQL query and returns all matching rows.
   */
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as SqlJsColumnType[]);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  /**
   * Executes one or more SQL statements (DDL, transactions, etc.).
   */
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
}
