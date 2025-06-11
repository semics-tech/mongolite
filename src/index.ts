import { SQLiteDB, MongoLiteOptions as DBMongoLiteOptions } from './db.js';
import { MongoLiteCollection } from './collection.js';
import { DocumentWithId } from './types.js';

export { MongoLiteCollection } from './collection.js';
export * from './types.js';

export interface MongoLiteClientOptions extends DBMongoLiteOptions {}

type MongoLiteOptions = {
  verbose?: boolean;
};
/**
 * MongoLite class is the main entry point for interacting with the SQLite-backed database.
 */
export class MongoLite {
  private db: SQLiteDB;
  private options: MongoLiteOptions;

  /**
   * Creates a new MongoLite client instance.
   * @param dbPathOrOptions Path to the SQLite database file or an options object.
   */
  constructor(dbPathOrOptions: string | MongoLiteClientOptions, options: MongoLiteOptions = {}) {
    this.db = new SQLiteDB(dbPathOrOptions);
    this.options = options;
  }

  /**
   * Connects to the database.
   * Note: Most operations will auto-connect if needed.
   */
  async connect(): Promise<void> {
    return this.db.connect();
  }

  /**
   * Closes the database connection.
   */
  async close(): Promise<void> {
    return this.db.close();
  }

  /**
   * Lists all collections (tables) in the database.
   * @returns An object with a toArray method that resolves to an array of collection names.
   */
  listCollections(): { toArray: () => Promise<string[]> } {
    // Query the SQLite schema to get all user-created tables
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
   * Gets a collection (table) in the database.
   * @param name The name of the collection.
   * @returns A MongoLiteCollection instance.
   */
  collection<T extends DocumentWithId = DocumentWithId>(name: string): MongoLiteCollection<T> {
    return new MongoLiteCollection<T>(this.db, name, this.options);
  }
}
