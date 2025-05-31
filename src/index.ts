import { SQLiteDB, MongoLiteOptions as DBMongoLiteOptions } from './db';
import { MongoLiteCollection } from './collection';
import { DocumentWithId } from './types';

export { MongoLiteCollection } from './collection';
export * from './types';

export interface MongoLiteClientOptions extends DBMongoLiteOptions {}

/**
 * MongoLite class is the main entry point for interacting with the SQLite-backed database.
 */
export class MongoLite {
  private db: SQLiteDB;

  /**
   * Creates a new MongoLite client instance.
   * @param dbPathOrOptions Path to the SQLite database file or an options object.
   */
  constructor(dbPathOrOptions: string | MongoLiteClientOptions) {
    this.db = new SQLiteDB(dbPathOrOptions);
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
   * Gets a collection (table) in the database.
   * @param name The name of the collection.
   * @returns A MongoLiteCollection instance.
   */
  collection<T extends DocumentWithId = DocumentWithId>(name: string): MongoLiteCollection<T> {
    return new MongoLiteCollection<T>(this.db, name);
  }
}
