import initSqlJs from 'sql.js';
import type { SqlJsStatic, Database as SqlJsDatabase } from 'sql.js';
import type { IDatabaseAdapter } from '../db.js';

/**
 * Options for the SqlJsAdapter.
 */
export interface SqlJsAdapterOptions {
  /**
   * Custom locateFile callback for loading the sql.js WASM binary.
   * In browsers, this can be used to point to a CDN or bundled WASM file.
   * Defaults to loading from the sql.js npm package path (works in Node.js).
   */
  locateFile?: (filename: string) => string;

  /**
   * Browser persistence backend.
   * - 'memory'       : No persistence; database is lost when closed (default).
   * - 'indexeddb'    : Persist via the browser IndexedDB API.
   * - 'localstorage' : Persist via the browser localStorage API (size-limited).
   */
  persistence?: 'memory' | 'indexeddb' | 'localstorage';

  /**
   * Logical name / key used to store and retrieve the database when persistence
   * is 'indexeddb' or 'localstorage'. Required when persistence is not 'memory'.
   */
  dbName?: string;

  /**
   * Log SQL statements to the console when true.
   */
  verbose?: boolean;
}

/**
 * SqlJsAdapter provides an IDatabaseAdapter implementation backed by sql.js,
 * a WebAssembly port of SQLite that runs in both Node.js and browsers.
 *
 * Usage (Node.js / browser – in-memory):
 *   const adapter = new SqlJsAdapter();
 *   const client  = new MongoLite({ adapter });
 *
 * Usage (browser – IndexedDB persistence):
 *   const adapter = new SqlJsAdapter({ persistence: 'indexeddb', dbName: 'my-app' });
 *   const client  = new MongoLite({ adapter });
 */
export class SqlJsAdapter implements IDatabaseAdapter {
  private db: SqlJsDatabase | null = null;
  private SQL: SqlJsStatic | null = null;
  private readonly options: SqlJsAdapterOptions;

  constructor(options: SqlJsAdapterOptions = {}) {
    this.options = options;
  }

  /**
   * Opens the database, loading existing data from the configured persistence
   * backend when applicable.
   */
  async connect(): Promise<void> {
    this.SQL = await initSqlJs(
      this.options.locateFile ? { locateFile: this.options.locateFile } : {}
    );

    const initialData = await this.loadPersistedData();
    this.db = initialData ? new this.SQL.Database(initialData) : new this.SQL.Database();

    // Register the regexp UDF required by the $regex query operator.
    // WARNING: Patterns are compiled via JavaScript RegExp. User-supplied patterns that are
    // not validated for catastrophic backtracking (ReDoS) could block the event loop.
    // Avoid using untrusted/unvalidated patterns with $regex in security-sensitive contexts.
    this.db.create_function('regexp', (pattern: unknown, value: unknown): number => {
      if (typeof pattern !== 'string' || value === null || value === undefined) return 0;
      try {
        return new RegExp(pattern).test(String(value)) ? 1 : 0;
      } catch {
        return 0;
      }
    });

    // Register the regexp_flags UDF required by $regex with $options.
    this.db.create_function(
      'regexp_flags',
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

    if (this.options.verbose) {
      console.log('SqlJsAdapter: database opened');
    }
  }

  /**
   * Executes a SQL statement that does not return rows (INSERT, UPDATE, DELETE, DDL).
   */
  async run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
    this.ensureOpen();
    if (this.options.verbose) {
      console.log('SqlJsAdapter run:', sql, params);
    }
    try {
      this.db!.run(sql, params as (string | number | null | Uint8Array)[]);
      const lastIDResult = this.db!.exec('SELECT last_insert_rowid()');
      const changesResult = this.db!.exec('SELECT changes()');
      const lastID = (lastIDResult[0]?.values[0]?.[0] as number) ?? 0;
      const changes = (changesResult[0]?.values[0]?.[0] as number) ?? 0;
      return { lastID, changes };
    } catch (err) {
      console.error('SqlJsAdapter error running SQL:', sql, err);
      throw err;
    }
  }

  /**
   * Executes a SQL query and returns the first matching row, or undefined.
   */
  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    this.ensureOpen();
    if (this.options.verbose) {
      console.log('SqlJsAdapter get:', sql, params);
    }
    try {
      const stmt = this.db!.prepare(sql);
      stmt.bind(params as (string | number | null | Uint8Array)[]);
      if (stmt.step()) {
        const row = stmt.getAsObject() as T;
        stmt.free();
        return row;
      }
      stmt.free();
      return undefined;
    } catch (err) {
      console.error('SqlJsAdapter error in get SQL:', sql, err);
      throw err;
    }
  }

  /**
   * Executes a SQL query and returns all matching rows.
   */
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.ensureOpen();
    if (this.options.verbose) {
      console.log('SqlJsAdapter all:', sql, params);
    }
    try {
      const stmt = this.db!.prepare(sql);
      stmt.bind(params as (string | number | null | Uint8Array)[]);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      stmt.free();
      return rows;
    } catch (err) {
      console.error('SqlJsAdapter error in all SQL:', sql, err);
      throw err;
    }
  }

  /**
   * Executes one or more SQL statements (DDL, transactions, etc.).
   */
  async exec(sql: string): Promise<void> {
    this.ensureOpen();
    if (this.options.verbose) {
      console.log('SqlJsAdapter exec:', sql);
    }
    try {
      this.db!.exec(sql);
    } catch (err) {
      console.error('SqlJsAdapter error executing SQL:', sql, err);
      throw err;
    }
  }

  /**
   * Closes the database connection and persists data when configured to do so.
   */
  async close(): Promise<void> {
    if (!this.db) return;
    try {
      await this.persistData();
    } finally {
      this.db.close();
      this.db = null;
      if (this.options.verbose) {
        console.log('SqlJsAdapter: database closed');
      }
    }
  }

  /**
   * Exports the current in-memory database as a Uint8Array.
   * Useful for manually saving database state to any storage backend.
   */
  export(): Uint8Array {
    this.ensureOpen();
    return this.db!.export();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error('SqlJsAdapter: database is not open. Call connect() first.');
    }
  }

  /**
   * Loads previously persisted database bytes from the configured backend.
   * Returns null when no data is stored or persistence is 'memory'.
   */
  private async loadPersistedData(): Promise<Uint8Array | null> {
    const { persistence, dbName } = this.options;
    if (!persistence || persistence === 'memory' || !dbName) return null;

    if (persistence === 'indexeddb') {
      return this.loadFromIndexedDB(dbName);
    }
    if (persistence === 'localstorage') {
      return this.loadFromLocalStorage(dbName);
    }
    return null;
  }

  /**
   * Persists the current database state to the configured backend.
   * No-op when persistence is 'memory' or no dbName is provided.
   */
  private async persistData(): Promise<void> {
    const { persistence, dbName } = this.options;
    if (!persistence || persistence === 'memory' || !dbName || !this.db) return;

    const data = this.db.export();
    if (persistence === 'indexeddb') {
      await this.saveToIndexedDB(dbName, data);
    } else if (persistence === 'localstorage') {
      this.saveToLocalStorage(dbName, data);
    }
  }

  // -- IndexedDB helpers (browser) -------------------------------------------

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private loadFromIndexedDB(dbName: string): Promise<Uint8Array | null> {
    return new Promise((resolve, reject) => {
      const idb: any = (globalThis as any).indexedDB;
      if (!idb) {
        resolve(null);
        return;
      }
      const request: any = idb.open('mongolite', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('databases');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db: any = request.result;
        const store: any = db.transaction('databases', 'readonly').objectStore('databases');
        const getReq: any = store.get(dbName);
        getReq.onsuccess = () => {
          db.close();
          const val: unknown = getReq.result;
          resolve(val instanceof Uint8Array ? val : null);
        };
        getReq.onerror = () => {
          db.close();
          reject(getReq.error);
        };
      };
    });
  }

  private saveToIndexedDB(dbName: string, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      const idb: any = (globalThis as any).indexedDB;
      if (!idb) {
        resolve();
        return;
      }
      const request: any = idb.open('mongolite', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('databases');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db: any = request.result;
        const store: any = db.transaction('databases', 'readwrite').objectStore('databases');
        const putReq: any = store.put(data, dbName);
        putReq.onsuccess = () => {
          db.close();
          resolve();
        };
        putReq.onerror = () => {
          db.close();
          reject(putReq.error);
        };
      };
    });
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // -- localStorage helpers (browser) ----------------------------------------

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private loadFromLocalStorage(dbName: string): Uint8Array | null {
    const ls: any = (globalThis as any).localStorage;
    if (!ls) return null;
    const stored: string | null = ls.getItem(`mongolite:${dbName}`);
    if (!stored) return null;
    try {
      const arr = JSON.parse(stored) as number[];
      return new Uint8Array(arr);
    } catch {
      return null;
    }
  }

  private saveToLocalStorage(dbName: string, data: Uint8Array): void {
    const ls: any = (globalThis as any).localStorage;
    if (!ls) return;
    ls.setItem(`mongolite:${dbName}`, JSON.stringify(Array.from(data)));
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
