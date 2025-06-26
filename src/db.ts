import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';

export interface MongoLiteOptions {
  filePath: string;
  verbose?: boolean;
  readOnly?: boolean;
  WAL?: boolean; // Add Write-Ahead Logging option
}

/**
 * SQLiteDB class provides a wrapper around the better-sqlite3 library
 * to simplify database operations.
 */
export class SQLiteDB {
  private db: Database.Database | null = null;
  private readonly filePath: string;
  private readonly verbose: boolean;
  private readonly readOnly: boolean;
  private readonly WAL: boolean;
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
        const options: Database.Options = {
          readonly: this.readOnly,
          verbose: this.verbose ? console.log : undefined,
        };

        this.db = new Database(this.filePath, options);

        // Enable Write-Ahead Logging if requested
        if (this.WAL && !this.readOnly) {
          this.db.pragma('journal_mode = WAL');
        }

        if (this.verbose) {
          console.log(`SQLite database opened: ${this.filePath}`);
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
        this.db.close();
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
