import { ObjectId } from 'bson';
import { SQLiteDB } from './db.js';
import {
  DocumentWithId,
  Filter,
  UpdateFilter,
  InsertOneResult,
  UpdateResult,
  DeleteResult,
  Projection,
  SQLiteRow,
  IndexSpecification,
  CreateIndexOptions,
  CreateIndexResult,
  DropIndexResult,
  IndexInfo,
} from './types.js';
import { FindCursor } from './cursors/findCursor.js';
import { extractRawIndexColumns } from './utils/indexing.js';

/**
 * MongoLiteCollection provides methods to interact with a specific SQLite table
 * as if it were a MongoDB collection.
 */
export class MongoLiteCollection<T extends DocumentWithId> {
  constructor(
    private db: SQLiteDB,
    public readonly name: string,
    private readonly options: { verbose?: boolean } = {}
  ) {
    this.ensureTable().catch((err) => {
      // This error should be handled or logged appropriately.
      // For now, console.error is used. In a real app, a more robust
      // error handling mechanism would be needed, potentially failing
      // the collection initialization or notifying the user.
      console.error(`Failed to ensure table ${this.name} exists:`, err);
    });
  }

  /**
   * Ensures the SQLite table for this collection exists, creating it if necessary.
   * The table will have an `_id` column (indexed) and a `data` column for JSON.
   * @private
   */
  public async ensureTable(): Promise<void> {
    // Using " " around table name to handle names with special characters or keywords
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS "${this.name}" (
        _id TEXT PRIMARY KEY,
        data TEXT
      );
    `;
    // It's generally good practice to create an index on _id, but TEXT PRIMARY KEY often implies an index.
    // Explicitly creating an index can be done if performance dictates.
    // const createIndexSQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_${this.name}__id ON "${this.name}"(_id);`;
    try {
      await this.db.exec(createTableSQL);
      // await this.db.exec(createIndexSQL); // If explicit index is desired
    } catch (error) {
      console.error(`Error ensuring table "${this.name}":`, error);
      throw error; // Re-throw to allow caller to handle
    }
  }

  /**
   * Inserts a single document into the collection.
   * If `_id` is not provided, a UUID will be generated.
   * @param doc The document to insert.
   * @returns {Promise<InsertOneResult>} An object containing the outcome of the insert operation.
   */
  async insertOne(doc: Omit<T, '_id'> & { _id?: string }): Promise<InsertOneResult> {
    await this.ensureTable(); // Ensure table exists before insert
    const docId = doc._id || new ObjectId().toString();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, ...dataToStore } = { ...doc, _id: docId }; // Ensure _id is part of the internal structure

    const jsonData = JSON.stringify(dataToStore);

    const sql = `INSERT INTO "${this.name}" (_id, data) VALUES (?, ?)`;
    try {
      await this.db.run(sql, [docId, jsonData]);
      return { acknowledged: true, insertedId: docId };
    } catch (error) {
      // Handle potential errors, e.g., unique constraint violation if _id already exists
      console.error(`Error inserting document into ${this.name}:`, error);
      // Check for unique constraint error (SQLite specific error code)
      if ((error as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT') {
        throw new Error(`Duplicate _id: ${docId}`);
      }
      // Handle SQLITE_BUSY
      if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') {
        return this.retryWithBackoff(() => this.insertOne(doc), `insert for ${docId}`);
      }
      throw error; // Re-throw other errors
    }
  }

  /**
   * Inserts multiple documents into the collection.
   * If any document does not have an `_id`, a UUID will be generated.
   * Uses batch insert with transactions for improved performance.
   * @param docs An array of documents to insert.
   * @returns {Promise<InsertOneResult[]>} An array of results for each insert operation.
   * */
  async insertMany(docs: (Omit<T, '_id'> & { _id?: string })[]): Promise<InsertOneResult[]> {
    await this.ensureTable(); // Ensure table exists before insert

    if (docs.length === 0) {
      return [];
    }

    const results: InsertOneResult[] = [];
    const batchSize = 500; // Process in batches to avoid memory issues with very large datasets

    // Process documents in batches
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      const batchResults = await this.insertBatch(batch);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Inserts a batch of documents using a single transaction for optimal performance.
   * @private
   */
  private async insertBatch(docs: (Omit<T, '_id'> & { _id?: string })[]): Promise<InsertOneResult[]> {
    const results: InsertOneResult[] = [];

    // Prepare all documents and their data upfront
    const preparedDocs = docs.map(doc => {
      const docId = doc._id || new ObjectId().toString();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, ...dataToStore } = { ...doc, _id: docId };
      return {
        id: docId,
        data: JSON.stringify(dataToStore)
      };
    });

    const insertBatchOperation = async () => {
      // Begin transaction
      await this.db.exec('BEGIN TRANSACTION');

      try {
        const sql = `INSERT INTO "${this.name}" (_id, data) VALUES (?, ?)`;

        // Use a prepared statement for better performance
        for (const preparedDoc of preparedDocs) {
          await this.db.run(sql, [preparedDoc.id, preparedDoc.data]);
          results.push({ acknowledged: true, insertedId: preparedDoc.id });
        }

        // Commit the transaction
        await this.db.exec('COMMIT');
      } catch (error) {
        // Rollback on any error
        try {
          await this.db.exec('ROLLBACK');
        } catch (rollbackError) {
          console.error(`Error during rollback in ${this.name}:`, rollbackError);
        }

        // Clear results since transaction failed
        results.length = 0;

        // Handle specific error types
        if ((error as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT') {
          // Find which document caused the constraint violation
          const errorMessage = (error as Error).message;
          const duplicateId = preparedDocs.find(doc => errorMessage.includes(doc.id))?.id || 'unknown';
          throw new Error(`Duplicate _id: ${duplicateId}`);
        }

        throw error;
      }
    };

    try {
      await insertBatchOperation();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') {
        // Retry the entire batch with backoff
        await this.retryWithBackoff(
          insertBatchOperation,
          `batch insert of ${docs.length} documents`
        );
      } else {
        throw error;
      }
    }

    return results;
  }

  /**
   * Finds a single document matching the filter.
   * @param filter The query criteria.
   * @param projection Optional. Specifies the fields to return.
   * @returns {Promise<T | null>} The found document or `null`.
   */
  async findOne(filter: Filter<T>, projection?: Projection<T>): Promise<Partial<T> | null> {
    await this.ensureTable();
    const cursor = this.find(filter).limit(1);
    if (projection) {
      cursor.project(projection);
    }
    const results = await cursor.toArray();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Finds multiple documents matching the filter and returns a cursor.
   * @param filter The query criteria.
   * @returns {FindCursor<T>} A `FindCursor` instance.
   */
  find(filter: Filter<T> = {}): FindCursor<T> {
    // ensureTable is called by operations on the cursor or by constructor
    return new FindCursor<T>(this.db, this.name, filter, this.options);
  }

  /**
   * Updates a single document matching the filter.
   * @param filter The selection criteria for the update.
   * @param update The modifications to apply.
   * @returns {Promise<UpdateResult>} An object describing the outcome.
   */
  async updateOne(
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options: { upsert?: boolean } = {}
  ): Promise<UpdateResult> {
    await this.ensureTable();

    // Find the document first (only one)
    const paramsForSelect: unknown[] = [];
    const whereClause = new FindCursor<T>(this.db, this.name, filter)['buildWhereClause'](
      filter,
      paramsForSelect
    );
    const selectSql = `SELECT _id, data FROM "${this.name}" WHERE ${whereClause} LIMIT 1`;

    const rowToUpdate = await this.db.get<SQLiteRow>(selectSql, paramsForSelect);

    if (!rowToUpdate && !options.upsert) {
      // If no document found and upsert is not requested, return no changes
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
    }
    // If no document found and upsert is requested, create a new document
    if (!rowToUpdate && options.upsert) {
      // Check if _id is a valid ObjectId or provided
      if (update.$set?._id && !ObjectId.isValid(update.$set._id)) {
        throw new Error(`_id must be a valid ObjectId or not provided for upsert in ${this.name}`);
      }
      // Generate a new _id if not provided
      // If _id is provided in $set, use it; otherwise, generate a new ObjectId
      const newDocId = update.$set?._id || new ObjectId().toString();
      const newDoc = { _id: newDocId, ...update.$set } as T; // Assuming $set is used for upsert
      // Ensure _id is set
      const jsonData = JSON.stringify(newDoc);
      const insertSql = `INSERT INTO "${this.name}" (_id, data) VALUES (?, ?)`;
      try {
        await this.db.run(insertSql, [newDocId, jsonData]);
        return {
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedId: newDocId,
        };
      } catch (error) {
        console.error(`Error inserting document during upsert in ${this.name}:`, error);
        if ((error as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT') {
          throw new Error(`Duplicate _id during upsert: ${newDocId}`);
        }
        throw error; // Re-throw other errors
      }
    }
    if (!rowToUpdate) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
    }

    const currentDoc = JSON.parse(rowToUpdate.data);
    let modified = false;

    // Process update operators
    for (const operator in update) {
      const opArgs = update[operator as keyof UpdateFilter<T>];
      if (!opArgs) continue;

      switch (operator) {
        case '$set':
          for (const path in opArgs) {
            const value = opArgs[path];
            this.setNestedValue(currentDoc, path, value);
            modified = true;
          }
          break;

        case '$unset':
          for (const path in opArgs) {
            this.unsetNestedValue(currentDoc, path);
            modified = true;
          }
          break;

        case '$inc':
          for (const path in opArgs) {
            const value = opArgs[path];
            if (typeof value === 'number') {
              const currentValue = this.getNestedValue(currentDoc, path) || 0;
              if (typeof currentValue === 'number') {
                this.setNestedValue(currentDoc, path, currentValue + value);
                modified = true;
              }
            }
          }
          break;

        case '$push':
          for (const path in opArgs) {
            const value = opArgs[path];
            const currentValue = this.getNestedValue(currentDoc, path);

            if (Array.isArray(currentValue)) {
              if (typeof value === 'object' && value !== null && '$each' in value) {
                if (Array.isArray(value.$each)) {
                  currentValue.push(...value.$each);
                  modified = true;
                }
              } else {
                currentValue.push(value);
                modified = true;
              }
            } else if (currentValue === undefined) {
              // If the field doesn't exist, create it as an array
              if (typeof value === 'object' && value !== null && '$each' in value) {
                if (Array.isArray(value.$each)) {
                  this.setNestedValue(currentDoc, path, [...value.$each]);
                  modified = true;
                }
              } else {
                this.setNestedValue(currentDoc, path, [value]);
                modified = true;
              }
            }
          }
          break;

        case '$pull':
          for (const path in opArgs) {
            const value = opArgs[path];
            const currentValue = this.getNestedValue(currentDoc, path);

            if (Array.isArray(currentValue)) {
              // Simple equality pull
              const newArray = currentValue.filter((item) => {
                if (typeof item === 'object' && typeof value === 'object') {
                  // For objects, do a deep comparison (simplified)
                  return JSON.stringify(item) !== JSON.stringify(value);
                }
                return item !== value;
              });

              if (newArray.length !== currentValue.length) {
                this.setNestedValue(currentDoc, path, newArray);
                modified = true;
              }
            }
          }
          break;
      }
    }

    if (modified) {
      // Update the document in SQLite
      const updateSql = `UPDATE "${this.name}" SET data = ? WHERE _id = ?`;
      const updateParams = [JSON.stringify(currentDoc), rowToUpdate._id];

      try {
        await this.db.run(updateSql, updateParams);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') {
          await this.retryWithBackoff(
            async () => this.db.run(updateSql, updateParams),
            `update for ${rowToUpdate._id}`
          );
        } else {
          throw error;
        }
      }

      return {
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: 1, // Since we found and modified exactly one document
        upsertedId: null,
      };
    }

    return {
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 0, // No changes were made
      upsertedId: null,
    };
  }

  /**
   * Updates multiple documents matching the filter.
   * @param filter The selection criteria for the update.
   * @param update The modifications to apply.
   * @returns {Promise<UpdateResult>} An object describing the outcome.
   */
  async updateMany(filter: Filter<T>, update: UpdateFilter<T>): Promise<UpdateResult> {
    await this.ensureTable();
    const paramsForSelect: unknown[] = [];
    const whereClause = new FindCursor<T>(this.db, this.name, filter)['buildWhereClause'](
      filter,
      paramsForSelect
    );
    const selectSql = `SELECT _id, data FROM "${this.name}" WHERE ${whereClause}`;
    const rowsToUpdate = await this.db.all<SQLiteRow>(selectSql, paramsForSelect);
    if (rowsToUpdate.length === 0) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
    }
    let modifiedCount = 0;
    const updatedIds: string[] = [];
    for (const rowToUpdate of rowsToUpdate) {
      const currentDoc = JSON.parse(rowToUpdate.data);
      let modified = false;
      // Process update operators
      for (const operator in update) {
        const opArgs = update[operator as keyof UpdateFilter<T>];
        if (!opArgs) continue;
        switch (operator) {
          case '$set':
            for (const path in opArgs) {
              const value = opArgs[path];
              this.setNestedValue(currentDoc, path, value);
              modified = true;
            }
            break;
          case '$unset':
            for (const path in opArgs) {
              this.unsetNestedValue(currentDoc, path);
              modified = true;
            }
            break;
          case '$inc':
            for (const path in opArgs) {
              const value = opArgs[path];
              if (typeof value === 'number') {
                const currentValue = this.getNestedValue(currentDoc, path) || 0;
                if (typeof currentValue === 'number') {
                  this.setNestedValue(currentDoc, path, currentValue + value);
                  modified = true;
                }
              }
            }
            break;
          case '$push':
            for (const path in opArgs) {
              const value = opArgs[path];
              const currentValue = this.getNestedValue(currentDoc, path);
              if (Array.isArray(currentValue)) {
                if (typeof value === 'object' && value !== null && '$each' in value) {
                  if (Array.isArray(value.$each)) {
                    currentValue.push(...value.$each);
                    modified = true;
                  }
                } else {
                  currentValue.push(value);
                  modified = true;
                }
              } else if (currentValue === undefined) {
                // If the field doesn't exist, create it as an array
                if (typeof value === 'object' && value !== null && '$each' in value) {
                  if (Array.isArray(value.$each)) {
                    this.setNestedValue(currentDoc, path, [...value.$each]);
                    modified = true;
                  }
                } else {
                  this.setNestedValue(currentDoc, path, [value]);
                  modified = true;
                }
              }
            }
            break;
          case '$pull':
            for (const path in opArgs) {
              const value = opArgs[path];
              const currentValue = this.getNestedValue(currentDoc, path);
              if (Array.isArray(currentValue)) {
                // Simple equality pull
                const newArray = currentValue.filter((item) => {
                  if (typeof item === 'object' && typeof value === 'object') {
                    // For objects, do a deep comparison (simplified)
                    return JSON.stringify(item) !== JSON.stringify(value);
                  }
                  return item !== value;
                });

                if (newArray.length !== currentValue.length) {
                  this.setNestedValue(currentDoc, path, newArray);
                  modified = true;
                }
              }
            }
            break;
          // Add other operators as needed
          default:
            throw new Error(`Unsupported update operator: ${operator}`);
        }
      }
      if (modified) {
        // Update the document in SQLite
        const updateSql = `UPDATE "${this.name}" SET data = ? WHERE _id = ?`;
        const updateParams = [JSON.stringify(currentDoc), rowToUpdate._id];
        try {
          await this.db.run(updateSql, updateParams);
          modifiedCount++;
          updatedIds.push(rowToUpdate._id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') {
            await this.retryWithBackoff(async () => {
              await this.db.run(updateSql, updateParams);
              modifiedCount++;
              updatedIds.push(rowToUpdate._id);
            }, `update for ${rowToUpdate._id} in batch operation`);
          } else {
            throw error;
          }
        }
      }
    }
    return {
      acknowledged: true,
      matchedCount: rowsToUpdate.length,
      modifiedCount: modifiedCount,
      upsertedId: null, // We don't support upsert yet
    };
  }

  /**
   * Creates an index on the specified field(s) of the collection.
   *
   * @param fieldOrSpec The field or specification to create the index on.
   * @param options Options for creating the index.
   * @returns A promise that resolves to the result of the operation.
   *
   * @example
   * // Create a simple index on the "name" field
   * collection.createIndex({ name: 1 });
   *
   * // Create a unique index on the "email" field
   * collection.createIndex({ email: 1 }, { unique: true });
   *
   * // Create a compound index on multiple fields
   * collection.createIndex({ name: 1, age: -1 });
   */
  async createIndex(
    fieldOrSpec: string | IndexSpecification,
    options: CreateIndexOptions = {}
  ): Promise<CreateIndexResult> {
    await this.ensureTable();

    // Convert string field to index spec format
    const spec: IndexSpecification =
      typeof fieldOrSpec === 'string' ? { [fieldOrSpec]: 1 } : fieldOrSpec;

    // Generate index name if not provided
    const indexName = options.name || this.generateIndexName(spec);

    // Build the index fields part for SQLite (field1, field2, ...)
    const indexFields = Object.entries(spec)
      .map(([field, direction]) => {
        // For JSON field paths, we need to use json_extract
        if (field.includes('.') || field !== '_id') {
          const jsonPath = this.parseJsonPath(field);
          return `json_extract(data, ${jsonPath}) ${direction === -1 ? 'DESC' : 'ASC'}`;
        }
        // For _id field, use the column directly
        return `_id ${direction === -1 ? 'DESC' : 'ASC'}`;
      })
      .join(', ');

    // Create the SQL for the index
    const uniqueClause = options.unique ? 'UNIQUE' : '';
    const createIndexSQL = `CREATE ${uniqueClause} INDEX IF NOT EXISTS "${indexName}" ON "${this.name}" (${indexFields})`;

    try {
      if (this.options.verbose) {
        console.log(`Creating index ${indexName} on collection ${this.name}`);
      }
      await this.db.exec(createIndexSQL);
      return { acknowledged: true, name: indexName };
    } catch (error) {
      console.error(`Error creating index ${indexName} on collection ${this.name}:`, error);
      throw error;
    }
  }

  /**
   * Generate a MongoDB-like index name from an index specification.
   * Format: collectionName_field1_1_field2_-1
   */
  private generateIndexName(spec: IndexSpecification): string {
    const nameParts = Object.entries(spec).map(
      ([field, direction]) => `${field.replace(/\./g, '_')}_${direction}`
    );
    return `${this.name}_${nameParts.join('_')}`;
  }

  /**
   * Lists all indexes on the collection.
   *
   * @returns A promise that resolves to an object with a toArray method
   * that returns the list of indexes.
   */
  listIndexes(): { toArray: () => Promise<IndexInfo[]> } {
    return {
      toArray: async (): Promise<IndexInfo[]> => {
        await this.ensureTable();

        try {
          // Query SQLite master table for indexes on this collection
          const indexes = await this.db.all<{ name: string; sql: string }>(
            `SELECT name, sql FROM sqlite_master 
             WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_autoindex%'`,
            [this.name]
          );

          const results: IndexInfo[] = [];

          // Parse the SQL to determine indexed fields and options
          for (const index of indexes) {
            const indexInfo: IndexInfo = {
              name: index.name,
              key: {},
            };

            // Parse the CREATE INDEX statement to extract field information
            // Example: CREATE UNIQUE INDEX "users_email_1" ON "users" (json_extract(data, '$.email') ASC)
            const sqlLower = index.sql.toLowerCase();
            indexInfo.unique = sqlLower.includes('unique index');

            // Extract the fields from the SQL
            const rawColumns = extractRawIndexColumns(index.sql);
            for (const col of rawColumns) {
              // Use the column name as the key, and direction as value
              indexInfo.key[col.column] = col.direction === 'DESC' ? -1 : 1;
            }
            results.push(indexInfo);
          }

          return results;
        } catch (error) {
          console.error(`Error listing indexes for collection ${this.name}:`, error);
          throw error;
        }
      },
    };
  }

  /**
   * Drops a specified index from the collection.
   *
   * @param indexName The name of the index to drop.
   * @returns A promise that resolves to the result of the operation.
   */
  async dropIndex(indexName: string): Promise<DropIndexResult> {
    await this.ensureTable();

    try {
      if (this.options.verbose) {
        console.log(`Dropping index ${indexName} from collection ${this.name}`);
      }
      await this.db.exec(`DROP INDEX IF EXISTS "${indexName}"`);
      return { acknowledged: true, name: indexName };
    } catch (error) {
      console.error(`Error dropping index ${indexName} from collection ${this.name}:`, error);
      throw error;
    }
  }

  /**
   * Drops all indexes from the collection, except for the index on _id.
   *
   * @returns A promise that resolves to the result of the operation.
   */
  async dropIndexes(): Promise<{ acknowledged: boolean; droppedCount: number }> {
    await this.ensureTable();

    try {
      const indexes = await this.listIndexes().toArray();
      let droppedCount = 0;

      for (const index of indexes) {
        // Skip primary key index on _id if it exists
        if (index.name === `sqlite_autoindex_${this.name}_1`) continue;

        await this.db.exec(`DROP INDEX IF EXISTS "${index.name}"`);
        droppedCount++;
      }

      return { acknowledged: true, droppedCount };
    } catch (error) {
      console.error(`Error dropping indexes from collection ${this.name}:`, error);
      throw error;
    }
  }

  /**
   * Prepends '$.' to the path for SQLite JSON functions.
   * @private
   * @param path Field path, e.g., 'address.city'
   * @returns JSON path string for SQLite, e.g., '$.address.city'
   */
  private parseJsonPath(path: string): string {
    // Prepends '$.' to the path for SQLite JSON functions.
    // 'address.city' becomes '$.address.city'
    return `'$.${path}'`;
  }

  // Helper for $set, $inc to handle dot notation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = obj;

    // Navigate to the last parent in the path
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];

      // Create nested objects if they don't exist
      if (current[key] === undefined || current[key] === null) {
        current[key] = {};
      } else if (typeof current[key] !== 'object') {
        // If it's not an object but we need to go deeper, replace it with an object
        current[key] = {};
      }

      current = current[key];
    }

    // Set the value at the final key
    current[keys[keys.length - 1]] = value;
  }

  // Helper for $unset
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private unsetNestedValue(obj: any, path: string): void {
    const keys = path.split('.');
    let current = obj;

    // Navigate to the last parent in the path
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (current[key] === undefined || current[key] === null || typeof current[key] !== 'object') {
        return; // Path doesn't exist, nothing to unset
      }
      current = current[key];
    }

    // Delete the property at the final key
    delete current[keys[keys.length - 1]];
  }

  // Helper to get nested value
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getNestedValue(obj: any, path: string): any {
    const keys = path.split('.');
    let current = obj;

    // Navigate through the path
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (current[key] === undefined) {
        return undefined; // Path doesn't exist
      }
      current = current[key];
    }

    return current;
  }

  /**
   * Deletes a single document matching the filter.
   * @param filter The criteria to select the document to delete.
   * @returns {Promise<DeleteResult>} An object describing the outcome.
   */
  async deleteOne(filter: Filter<T>): Promise<DeleteResult> {
    await this.ensureTable();

    const paramsForDelete: unknown[] = [];
    const whereClause = new FindCursor<T>(this.db, this.name, filter)['buildWhereClause'](
      filter,
      paramsForDelete
    );

    // Get the number of documents that would be deleted
    const countSql = `SELECT COUNT(*) as count FROM "${this.name}" WHERE ${whereClause} LIMIT 1`;
    const countResult = await this.db.get<{ count: number }>(countSql, paramsForDelete);

    const deleteSql = `
      DELETE FROM "${this.name}"
      WHERE ROWID IN (SELECT ROWID FROM "${this.name}" WHERE ${whereClause} LIMIT 1);
    `;

    try {
      await this.db.run(deleteSql, paramsForDelete);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') {
        await this.retryWithBackoff(
          async () => this.db.run(deleteSql, paramsForDelete),
          `delete for filter ${JSON.stringify(filter)}`
        );
      } else {
        throw error;
      }
    }

    return { acknowledged: true, deletedCount: countResult?.count ? 1 : 0 };
  }

  /**
   * Deletes multiple documents matching the filter.
   * @param filter The criteria to select documents to delete.
   * @returns {Promise<DeleteResult>} An object describing the outcome.
   */
  async deleteMany(filter: Filter<T>): Promise<DeleteResult> {
    await this.ensureTable();

    const paramsForDelete: unknown[] = [];
    const whereClause = new FindCursor<T>(this.db, this.name, filter)['buildWhereClause'](
      filter,
      paramsForDelete
    );

    // Get the number of documents that would be deleted
    const countSql = `SELECT COUNT(*) as count FROM "${this.name}" WHERE ${whereClause}`;
    const countResult = await this.db.get<{ count: number }>(countSql, paramsForDelete);

    const deleteSql = `DELETE FROM "${this.name}" WHERE ${whereClause}`;

    try {
      await this.db.run(deleteSql, paramsForDelete);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') {
        await this.retryWithBackoff(
          async () => this.db.run(deleteSql, paramsForDelete),
          `delete many for filter ${JSON.stringify(filter)}`
        );
      } else {
        throw error;
      }
    }

    return { acknowledged: true, deletedCount: countResult ? countResult.count : 0 };
  }

  /**
   * Counts the number of documents matching the filter.
   * @param filter The criteria to select documents to count.
   * @returns {Promise<number>} The count of matching documents.
   */
  async countDocuments(filter: Filter<T> = {}): Promise<number> {
    await this.ensureTable();

    const paramsForCount: unknown[] = [];
    const whereClause = new FindCursor<T>(this.db, this.name, filter)['buildWhereClause'](
      filter,
      paramsForCount
    );
    const countSql = `SELECT COUNT(*) as count FROM "${this.name}" WHERE ${whereClause}`;

    const result = await this.db.get<{ count: number }>(countSql, paramsForCount);
    return result?.count || 0;
  }

  /**
   * Retries an operation with exponential backoff when SQLITE_BUSY errors occur.
   * @param operation The operation function to retry.
   * @param operationDescription A description of the operation for logging purposes.
   * @param maxRetries The maximum number of retry attempts (default: 5).
   * @param initialDelayMs The initial delay before the first retry in milliseconds (default: 100).
   * @param maxDelayMs The maximum delay between retries in milliseconds (default: 10000).
   * @returns The result of the operation once successful.
   * @private
   */
  private async retryWithBackoff<R>(
    operation: () => Promise<R>,
    operationDescription: string,
    maxRetries = 5,
    initialDelayMs = 100,
    maxDelayMs = 10000
  ): Promise<R> {
    let retryCount = 0;
    let delayMs = initialDelayMs;

    while (true) {
      try {
        if (retryCount > 0) {
          console.warn(
            `Retry attempt ${retryCount}/${maxRetries} for ${operationDescription} after ${delayMs}ms delay...`
          );
        }
        return await operation();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY' && retryCount < maxRetries) {
          retryCount++;

          // Wait using exponential backoff with jitter
          await new Promise((resolve) => {
            // Add some randomness (jitter) to prevent multiple clients from retrying simultaneously
            const jitter = Math.random() * 0.3 + 0.85; // Random factor between 0.85 and 1.15
            delayMs = Math.min(delayMs * 2 * jitter, maxDelayMs);
            setTimeout(resolve, delayMs);
          });

          // Continue to next iteration to retry
          continue;
        }

        // If we've exhausted retries or it's a different error, rethrow
        if (retryCount >= maxRetries && (error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') {
          console.error(
            `Maximum retries (${maxRetries}) reached for ${operationDescription}. Operation failed.`
          );
        }
        throw error;
      }
    }
  }
}
