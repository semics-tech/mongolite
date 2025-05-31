import sqlite3 from 'sqlite3';
import { promisify } from 'util';

// Promisify sqlite3 methods
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sqlite3Database = sqlite3.Database & {
  getAsync?: <T = any>(sql: string, params?: any) => Promise<T>;
  runAsync?: (sql: string, params?: any) => Promise<sqlite3.RunResult>;
  allAsync?: <T = any>(sql: string, params?: any) => Promise<T[]>;
  closeAsync?: () => Promise<void>;
  execAsync?: (sql: string) => Promise<void>;
};

export interface MongoLiteOptions {
  filePath: string;
  verbose?: boolean;
  readOnly?: boolean; // Add readOnly option
}

/**
 * SQLiteDB class provides a wrapper around the sqlite3 library
 * to simplify database operations using Promises.
 */
export class SQLiteDB {
  private db: Sqlite3Database | null = null;
  private readonly filePath: string;
  private readonly verbose: boolean;
  private readonly readOnly: boolean;
  private openPromise: Promise<void> | null = null;

  /**
   * Creates an instance of SQLiteDB.
   * @param {string | MongoLiteOptions} dbPathOrOptions - The path to the SQLite database file or an options object.
   * Use ':memory:' for an in-memory database.
   */
  constructor(dbPathOrOptions: string | MongoLiteOptions) {
    if (typeof dbPathOrOptions === 'string') {
      this.filePath = dbPathOrOptions;
      this.verbose = false;
      this.readOnly = false;
    } else {
      this.filePath = dbPathOrOptions.filePath;
      this.verbose = dbPathOrOptions.verbose || false;
      this.readOnly = dbPathOrOptions.readOnly || false;
    }

    if (this.verbose) {
      sqlite3.verbose();
    }
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
      const mode = this.readOnly
        ? sqlite3.OPEN_READONLY
        : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
      this.db = new sqlite3.Database(this.filePath, mode, (err) => {
        if (err) {
          console.error(`Error opening database ${this.filePath}:`, err.message);
          this.db = null; // Ensure db is null on error
          this.openPromise = null;
          return reject(err);
        }
        if (this.verbose) {
          console.log(`SQLite database opened: ${this.filePath}`);
        }
        // Promisify methods for the current db instance
        if (this.db) {
          // Use explicit type casting to ensure proper TypeScript types
          this.db.getAsync = promisify(this.db.get).bind(this.db) as Sqlite3Database['getAsync'];
          this.db.runAsync = promisify(this.db.run).bind(this.db) as Sqlite3Database['runAsync'];
          this.db.allAsync = promisify(this.db.all).bind(this.db) as Sqlite3Database['allAsync'];
          this.db.closeAsync = promisify(this.db.close).bind(
            this.db
          ) as Sqlite3Database['closeAsync'];
          this.db.execAsync = promisify(this.db.exec).bind(this.db) as Sqlite3Database['execAsync'];
        }
        resolve();
      });
    });
    return this.openPromise;
  }

  /**
   * Ensures the database connection is open before performing an operation.
   * @private
   * @returns {Promise<Sqlite3Database>} The active database instance.
   * @throws {Error} If the database is not connected.
   */
  private async ensureConnected(): Promise<Sqlite3Database> {
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
   * @returns {Promise<sqlite3.RunResult>} Result of the execution (e.g., lastID, changes).
   */
  public async run(sql: string, params: unknown[] = []): Promise<sqlite3.RunResult> {
    const dbInstance = await this.ensureConnected();
    if (!dbInstance.runAsync) throw new Error('runAsync not initialized');
    return dbInstance.runAsync(sql, params);
  }

  /**
   * Executes a SQL query that returns a single row.
   * @param {string} sql - The SQL query string.
   * @param {any[]} [params=[]] - Parameters for the SQL query.
   * @returns {Promise<T | undefined>} The first row found, or undefined.
   */
  public async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const dbInstance = await this.ensureConnected();
    if (!dbInstance.getAsync) throw new Error('getAsync not initialized');
    return dbInstance.getAsync(sql, params) as Promise<T | undefined>;
  }

  /**
   * Executes a SQL query that returns multiple rows.
   * @param {string} sql - The SQL query string.
   * @param {any[]} [params=[]] - Parameters for the SQL query.
   * @returns {Promise<T[]>} An array of rows.
   */
  public async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const dbInstance = await this.ensureConnected();
    if (!dbInstance.allAsync) throw new Error('allAsync not initialized');
    return dbInstance.allAsync(sql, params) as Promise<T[]>;
  }

  /**
   * Executes multiple SQL statements.
   * @param {string} sql - SQL string with multiple statements.
   * @returns {Promise<void>}
   */
  public async exec(sql: string): Promise<void> {
    const dbInstance = await this.ensureConnected();
    if (!dbInstance.execAsync) throw new Error('execAsync not initialized');
    return dbInstance.execAsync(sql);
  }

  /**
   * Closes the database connection.
   * @returns {Promise<void>} A promise that resolves when the connection is closed.
   */
  public async close(): Promise<void> {
    if (this.openPromise) {
      await this.openPromise; // Ensure any pending connection attempt is finished
    }
    if (this.db && this.db.closeAsync) {
      try {
        await this.db.closeAsync();
        if (this.verbose) {
          console.log(`SQLite database closed: ${this.filePath}`);
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
   * Gets the underlying sqlite3.Database instance.
   * Useful for operations not covered by this wrapper, like transactions.
   * @returns {Promise<sqlite3.Database>} The raw database object.
   * @throws {Error} If the database is not connected.
   */
  public async getDbInstance(): Promise<sqlite3.Database> {
    return this.ensureConnected();
  }
}
