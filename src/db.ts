import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import path from 'node:path';
import {
  ConnectionRegistry,
  DEFAULT_BUSY_TIMEOUT_MS,
  buildConnectionKey,
  isShareablePath,
} from './utils/connection-registry.js';

export { DEFAULT_BUSY_TIMEOUT_MS };

/** Shared `better-sqlite3` handles for this process, keyed by connection identity. */
const sharedConnections = new ConnectionRegistry<Database.Database>();

/** Exposed for tests and diagnostics. */
export function sharedConnectionCount(): number {
  return sharedConnections.size;
}

/**
 * Common interface for database adapters.
 * Implement this interface to support different SQLite backends (e.g. better-sqlite3, Cloudflare Durable Objects).
 */
export interface IDatabaseAdapter {
  connect(): Promise<void>;
  run(sql: string, params?: unknown[]): Promise<{ lastID: number; changes: number }>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface MongoLiteOptions {
  filePath: string;
  verbose?: boolean;
  readOnly?: boolean;
  /** Write-Ahead Logging. Defaults to `true`. */
  WAL?: boolean;
  /**
   * How long (ms) SQLite waits for a lock held by another connection before
   * throwing `SQLITE_BUSY`. Defaults to {@link DEFAULT_BUSY_TIMEOUT_MS}; set to
   * `0` to fail immediately.
   */
  busyTimeout?: number;
  /**
   * Reuse a single underlying SQLite connection across every instance in this
   * process that resolves to the same database file and settings, instead of
   * opening one connection per instance. Reference counted — `close()` only
   * closes the real handle once the last holder releases it.
   *
   * Ignored for `:memory:` databases, which are private to their connection.
   * Defaults to `false`.
   */
  shared?: boolean;
}

/**
 * SQLiteDB class provides a wrapper around the better-sqlite3 library
 * to simplify database operations.
 */
export class SQLiteDB implements IDatabaseAdapter {
  private db: Database.Database | null = null;
  private readonly filePath: string;
  private readonly verbose: boolean;
  private readonly readOnly: boolean;
  private readonly WAL: boolean;
  private readonly busyTimeout: number;
  private readonly shareKey: string | null;
  private openPromise: Promise<void> | null = null;

  /**
   * Creates an instance of SQLiteDB.
   * @param {string | MongoLiteOptions} dbPathOrOptions - The path to the SQLite database file or an options object.
   * Use ':memory:' for an in-memory database.
   */
  constructor(dbPathOrOptions: string | MongoLiteOptions) {
    let shared: boolean;

    if (typeof dbPathOrOptions === 'string') {
      this.filePath = dbPathOrOptions;
      this.verbose = false;
      this.readOnly = false;
      this.WAL = true;
      this.busyTimeout = DEFAULT_BUSY_TIMEOUT_MS;
      shared = false;
    } else {
      this.filePath = dbPathOrOptions.filePath;
      this.verbose = dbPathOrOptions.verbose || false;
      this.readOnly = dbPathOrOptions.readOnly || false;
      this.WAL = dbPathOrOptions.WAL ?? true;
      this.busyTimeout = dbPathOrOptions.busyTimeout ?? DEFAULT_BUSY_TIMEOUT_MS;
      shared = dbPathOrOptions.shared ?? false;
    }

    this.shareKey =
      shared && isShareablePath(this.filePath)
        ? buildConnectionKey({
            backend: 'better-sqlite3',
            filePath: path.resolve(this.filePath),
            readOnly: this.readOnly,
            WAL: this.WAL,
            busyTimeout: this.busyTimeout,
            verbose: this.verbose,
          })
        : null;
  }

  /**
   * Opens the database connection if it's not already open.
   * @returns {Promise<void>} A promise that resolves when the connection is open.
   */
  public async connect(): Promise<void> {
    if (this.db && this.openPromise) {
      return this.openPromise;
    }
    if (this.db) {
      // Already connected and openPromise is null (should not happen with proper logic)
      return Promise.resolve();
    }

    this.openPromise = new Promise((resolve, reject) => {
      try {
        // Only runs on a genuinely new connection — when sharing, an existing
        // handle already has its pragmas and UDFs applied.
        const openConnection = (): Database.Database => {
          const options: Database.Options = {
            readonly: this.readOnly,
            verbose: this.verbose ? console.log : undefined,
          };

          const db = new Database(this.filePath, options);

          // Enable Write-Ahead Logging if requested
          if (this.WAL && !this.readOnly) {
            db.pragma('journal_mode = WAL');
          }

          // Wait rather than immediately throwing SQLITE_BUSY when another
          // connection (often another process) holds a lock.
          if (this.busyTimeout > 0) {
            db.pragma(`busy_timeout = ${this.busyTimeout}`);
          }

          // Register regexp UDF for $regex operator support.
          // WARNING: Patterns are compiled via JavaScript RegExp. User-supplied patterns that are
          // not validated for catastrophic backtracking (ReDoS) could block the event loop.
          // Avoid using untrusted/unvalidated patterns with $regex in security-sensitive contexts.
          db.function(
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
          db.function(
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
            console.log(`SQLite database opened: ${this.filePath}`);
          }

          return db;
        };

        this.db = this.shareKey
          ? sharedConnections.acquire(this.shareKey, openConnection)
          : openConnection();

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

  /**
   * Ensures the database connection is open before performing an operation.
   * @private
   * @returns {Promise<Database.Database>} The active database instance.
   * @throws {Error} If the database is not connected.
   */
  private async ensureConnected(): Promise<Database.Database> {
    if (!this.db || !this.openPromise) {
      await this.connect();
    } else {
      await this.openPromise; // Wait for any ongoing connection attempt
    }

    if (!this.db) {
      // This should ideally not be reached if connect() works correctly
      throw new Error('Database is not connected. Connection attempt failed.');
    }
    return this.db;
  }

  /**
   * Executes a SQL query that does not return rows (e.g., INSERT, UPDATE, DELETE, CREATE).
   * @param {string} sql - The SQL query string.
   * @param {any[]} [params=[]] - Parameters for the SQL query.
   * @returns {Promise<{ lastID: number, changes: number }>} Result of the execution.
   */
  public async run(
    sql: string,
    params: unknown[] = []
  ): Promise<{ lastID: number; changes: number }> {
    const dbInstance = await this.ensureConnected();
    try {
      const result = dbInstance.prepare(sql).run(...params);
      return {
        lastID: result.lastInsertRowid as number,
        changes: result.changes,
      };
    } catch (err) {
      console.error(`Error running SQL: ${sql}`, err);
      throw err;
    }
  }

  /**
   * Executes a SQL query that returns a single row.
   * @param {string} sql - The SQL query string.
   * @param {any[]} [params=[]] - Parameters for the SQL query.
   * @returns {Promise<T | undefined>} The first row found, or undefined.
   */
  public async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const dbInstance = await this.ensureConnected();
    try {
      return dbInstance.prepare(sql).get(...params) as T | undefined;
    } catch (err) {
      console.error(`Error getting SQL: ${sql}`, err);
      throw err;
    }
  }

  /**
   * Executes a SQL query that returns multiple rows.
   * @param {string} sql - The SQL query string.
   * @param {any[]} [params=[]] - Parameters for the SQL query.
   * @returns {Promise<T[]>} An array of rows.
   */
  public async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const dbInstance = await this.ensureConnected();
    try {
      return dbInstance.prepare(sql).all(...params) as T[];
    } catch (err) {
      console.error(`Error getting all SQL: ${sql}`, err);
      throw err;
    }
  }

  /**
   * Executes multiple SQL statements.
   * @param {string} sql - SQL string with multiple statements.
   * @returns {Promise<void>}
   */
  public async exec(sql: string): Promise<void> {
    const dbInstance = await this.ensureConnected();
    try {
      dbInstance.exec(sql);
      return Promise.resolve();
    } catch (err) {
      console.error(`Error executing SQL: ${sql}`, err);
      throw err;
    }
  }

  /**
   * Closes the database connection.
   * @returns {Promise<void>} A promise that resolves when the connection is closed.
   */
  public async close(): Promise<void> {
    if (this.openPromise) {
      await this.openPromise; // Ensure any pending connection attempt is finished
    }
    if (this.db) {
      try {
        // When shared, only the last holder actually closes the handle.
        const isLastHolder = this.shareKey
          ? sharedConnections.release(this.shareKey, this.db)
          : true;

        if (isLastHolder) {
          this.db.close();
        }

        if (this.verbose) {
          console.log(
            isLastHolder
              ? `SQLite database closed: ${this.filePath}`
              : `SQLite database released (still in use): ${this.filePath}`
          );
        }
      } catch (err) {
        console.error(`Error closing database ${this.filePath}:`, (err as Error).message);
        throw err; // Re-throw the error to indicate failure
      } finally {
        this.db = null;
        this.openPromise = null;
      }
    } else {
      // If db is null, it's already considered closed or was never opened.
      this.db = null;
      this.openPromise = null;
    }
  }

  /**
   * Gets the underlying better-sqlite3 Database instance.
   * Useful for operations not covered by this wrapper, like transactions.
   * @returns {Promise<Database.Database>} The raw database object.
   * @throws {Error} If the database is not connected.
   */
  public async getDbInstance(): Promise<Database.Database> {
    return this.ensureConnected();
  }

  /**
   * Prepares a SQL statement for later execution.
   * @param {string} sql - The SQL query string.
   * @returns {Promise<Statement>} A prepared statement that can be executed multiple times.
   */
  public async prepare(sql: string): Promise<Statement> {
    const dbInstance = await this.ensureConnected();
    return dbInstance.prepare(sql);
  }

  /**
   * Begins a transaction.
   * @returns {Promise<void>}
   */
  public async beginTransaction(): Promise<void> {
    const dbInstance = await this.ensureConnected();
    dbInstance.prepare('BEGIN').run();
    return Promise.resolve();
  }

  /**
   * Commits a transaction.
   * @returns {Promise<void>}
   */
  public async commitTransaction(): Promise<void> {
    const dbInstance = await this.ensureConnected();
    dbInstance.prepare('COMMIT').run();
    return Promise.resolve();
  }

  /**
   * Rolls back a transaction.
   * @returns {Promise<void>}
   */
  public async rollbackTransaction(): Promise<void> {
    const dbInstance = await this.ensureConnected();
    dbInstance.prepare('ROLLBACK').run();
    return Promise.resolve();
  }
}
