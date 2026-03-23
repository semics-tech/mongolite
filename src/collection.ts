import { ObjectId } from 'bson';
import { SQLiteDB } from './db.js';
import {
  DocumentWithId,
  Filter,
  UpdateFilter,
  InsertOneResult,
  InsertManyResult,
  UpdateResult,
  DeleteResult,
  Projection,
  SQLiteRow,
  IndexSpecification,
  CreateIndexOptions,
  CreateIndexResult,
  DropIndexResult,
  IndexInfo,
  FindOneAndUpdateOptions,
  FindOneAndDeleteOptions,
  FindOneAndReplaceOptions,
  ReplaceOptions,
  AggregationPipeline,
} from './types.js';
import { FindCursor } from './cursors/findCursor.js';
import { extractRawIndexColumns } from './utils/indexing.js';
import { ChangeStream, ChangeStreamOptions } from './changeStream.js';

/**
 * Safely stringifies JSON data with validation and error handling.
 * Prevents storing malformed JSON that could cause parsing issues later.
 * @param data The data to stringify
 * @param context Optional context for error messages
 * @returns The JSON string
 * @throws Error if the data cannot be safely stringified
 */
function safeJsonStringify(data: unknown, context?: string): string {
  try {
    // First, validate that the data is JSON-serializable by attempting to stringify it
    const jsonString = JSON.stringify(data);

    // Verify that the stringified data can be parsed back (round-trip test)
    try {
      const parsed = JSON.parse(jsonString);
      // Basic validation that the round-trip preserved the data structure
      if (typeof data === 'object' && data !== null && typeof parsed !== 'object') {
        throw new Error('Round-trip JSON validation failed: type mismatch');
      }
    } catch (parseError) {
      throw new Error(
        `Round-trip JSON validation failed: ${parseError instanceof Error ? parseError.message : 'Unknown parse error'}`
      );
    }

    return jsonString;
  } catch (error) {
    const contextMsg = context ? ` in ${context}` : '';
    if (error instanceof Error) {
      throw new Error(`Failed to safely stringify JSON data${contextMsg}: ${error.message}`);
    }
    throw new Error(`Failed to safely stringify JSON data${contextMsg}: Unknown error`);
  }
}

/**
 * Safely parses JSON data with fallback mechanisms for malformed JSON.
 * @param jsonString The JSON string to parse
 * @param context Optional context for error messages and recovery
 * @returns The parsed object or a fallback object
 */
function safeJsonParse(jsonString: string, context?: string): unknown {
  if (!jsonString || typeof jsonString !== 'string') {
    console.warn(`Invalid JSON string${context ? ` in ${context}` : ''}: not a string or empty`);
    return {};
  }

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    // Log the error for debugging
    console.error(
      `JSON parse error${context ? ` in ${context}` : ''}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    console.error(
      `Malformed JSON string: ${jsonString.substring(0, 500)}${jsonString.length > 500 ? '...' : ''}`
    );

    // Attempt to recover from common JSON corruption issues
    try {
      // Try to fix common escaping issues
      let fixedJson = jsonString;

      // Fix double-escaped quotes
      fixedJson = fixedJson.replace(/\\"/g, '"');

      // Fix improperly escaped backslashes
      fixedJson = fixedJson.replace(/\\\\/g, '\\');

      // Try parsing the fixed JSON
      const recovered = JSON.parse(fixedJson);
      console.warn(`Successfully recovered malformed JSON${context ? ` in ${context}` : ''}`);
      return recovered;
    } catch (recoveryError) {
      console.error(
        `JSON recovery failed${context ? ` in ${context}` : ''}: ${recoveryError instanceof Error ? recoveryError.message : 'Unknown error'}`
      );

      // Last resort: return an empty object with a special marker
      return {
        __mongoLiteCorrupted: true,
        __originalData: jsonString,
        __error: error instanceof Error ? error.message : 'Unknown JSON parse error',
      };
    }
  }
}

/**
 * Validates that a document is safe to store (no functions, circular references, etc.)
 * @param doc The document to validate
 * @param path Current path for error reporting
 * @throws Error if the document contains invalid data
 */
function validateDocumentForStorage(doc: unknown, path = 'root'): void {
  if (doc === null || doc === undefined) {
    return;
  }

  if (typeof doc === 'function') {
    throw new Error(
      `Document validation failed: Functions are not allowed in documents (found at ${path})`
    );
  }

  if (typeof doc === 'symbol') {
    throw new Error(
      `Document validation failed: Symbols are not allowed in documents (found at ${path})`
    );
  }

  if (typeof doc === 'bigint') {
    throw new Error(
      `Document validation failed: BigInt values are not supported, use regular numbers or strings (found at ${path})`
    );
  }

  if (doc instanceof RegExp) {
    throw new Error(
      `Document validation failed: RegExp objects are not supported in documents (found at ${path})`
    );
  }

  if (Array.isArray(doc)) {
    doc.forEach((item, index) => {
      validateDocumentForStorage(item, `${path}[${index}]`);
    });
  } else if (typeof doc === 'object') {
    // Check for circular references by maintaining a Set of visited objects
    const visited = new Set();

    function checkCircular(obj: object, currentPath: string): void {
      if (visited.has(obj)) {
        throw new Error(
          `Document validation failed: Circular reference detected at ${currentPath}`
        );
      }
      visited.add(obj);

      for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'object' && value !== null) {
          checkCircular(value, `${currentPath}.${key}`);
        }
      }

      visited.delete(obj);
    }

    try {
      checkCircular(doc, path);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Circular reference')) {
        throw error;
      }
    }

    // Validate each property
    for (const [key, value] of Object.entries(doc)) {
      validateDocumentForStorage(value, `${path}.${key}`);
    }
  }
}

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

    // Validate the document before storing
    try {
      validateDocumentForStorage(dataToStore);
    } catch (error) {
      throw new Error(
        `Cannot insert document: ${error instanceof Error ? error.message : 'Unknown validation error'}`
      );
    }

    const jsonData = safeJsonStringify(dataToStore, `insertOne for document ${docId}`);

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
   * @returns {Promise<InsertManyResult>} An object containing the outcome of all insert operations.
   * */
  async insertMany(docs: (Omit<T, '_id'> & { _id?: string })[]): Promise<InsertManyResult> {
    await this.ensureTable(); // Ensure table exists before insert

    if (docs.length === 0) {
      return { acknowledged: true, insertedCount: 0, insertedIds: {} };
    }

    const insertedIds: { [key: number]: string } = {};
    const batchSize = 500; // Process in batches to avoid memory issues with very large datasets
    let insertedCount = 0;
    let index = 0;

    // Process documents in batches
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize);
      const batchResults = await this.insertBatch(batch);
      batchResults.forEach((res) => {
        insertedIds[index++] = res.insertedId;
      });
      insertedCount += batchResults.length;
    }

    return { acknowledged: true, insertedCount, insertedIds };
  }

  /**
   * Inserts a batch of documents using a single transaction for optimal performance.
   * @private
   */
  private async insertBatch(
    docs: (Omit<T, '_id'> & { _id?: string })[]
  ): Promise<InsertOneResult[]> {
    const results: InsertOneResult[] = [];

    // Prepare all documents and their data upfront
    const preparedDocs = docs.map((doc) => {
      const docId = doc._id || new ObjectId().toString();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { _id, ...dataToStore } = { ...doc, _id: docId };

      // Validate the document before storing
      try {
        validateDocumentForStorage(dataToStore);
      } catch (error) {
        throw new Error(
          `Cannot insert document ${docId}: ${error instanceof Error ? error.message : 'Unknown validation error'}`
        );
      }

      return {
        id: docId,
        data: safeJsonStringify(dataToStore, `insertBatch for document ${docId}`),
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
          const duplicateId =
            preparedDocs.find((doc) => errorMessage.includes(doc.id))?.id || 'unknown';
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
   * @remarks When using a projection, some fields may be undefined at runtime despite the
   * return type being `T`. This provides better ergonomics for the common case where no
   * projection is used.
   */
  async findOne(filter: Filter<T>, projection?: Projection<T>): Promise<T | null> {
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
      const jsonData = safeJsonStringify(newDoc, `upsert for document ${newDocId}`);
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

    const currentDoc = safeJsonParse(rowToUpdate.data, `updateOne for document ${rowToUpdate._id}`);
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

        case '$addToSet':
          for (const path in opArgs) {
            const value = opArgs[path];
            const currentValue = this.getNestedValue(currentDoc, path);
            const arr: unknown[] = Array.isArray(currentValue) ? currentValue : [];
            const items =
              typeof value === 'object' && value !== null && '$each' in value && Array.isArray(value.$each)
                ? value.$each
                : [value];
            let changed = false;
            for (const item of items) {
              const alreadyPresent = arr.some(
                (el) => JSON.stringify(el) === JSON.stringify(item)
              );
              if (!alreadyPresent) {
                arr.push(item);
                changed = true;
              }
            }
            if (changed || !Array.isArray(currentValue)) {
              this.setNestedValue(currentDoc, path, arr);
              modified = true;
            }
          }
          break;

        case '$pop':
          for (const path in opArgs) {
            const value = opArgs[path];
            const currentValue = this.getNestedValue(currentDoc, path);
            if (Array.isArray(currentValue) && currentValue.length > 0) {
              if (value === 1) {
                currentValue.pop();
              } else if (value === -1) {
                currentValue.shift();
              }
              this.setNestedValue(currentDoc, path, currentValue);
              modified = true;
            }
          }
          break;

        case '$mul':
          for (const path in opArgs) {
            const value = opArgs[path];
            if (typeof value === 'number') {
              const currentValue = this.getNestedValue(currentDoc, path);
              const numericCurrent = typeof currentValue === 'number' ? currentValue : 0;
              this.setNestedValue(currentDoc, path, numericCurrent * value);
              modified = true;
            }
          }
          break;

        case '$min':
          for (const path in opArgs) {
            const value = opArgs[path];
            const currentValue = this.getNestedValue(currentDoc, path);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (currentValue === undefined || (value as any) < (currentValue as any)) {
              this.setNestedValue(currentDoc, path, value);
              modified = true;
            }
          }
          break;

        case '$max':
          for (const path in opArgs) {
            const value = opArgs[path];
            const currentValue = this.getNestedValue(currentDoc, path);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (currentValue === undefined || (value as any) > (currentValue as any)) {
              this.setNestedValue(currentDoc, path, value);
              modified = true;
            }
          }
          break;

        case '$currentDate':
          for (const path in opArgs) {
            const value = opArgs[path as keyof typeof opArgs];

            if (value === true) {
              // Default: store as ISO string date
              this.setNestedValue(currentDoc, path, new Date().toISOString());
              modified = true;
              continue;
            }

            if (value && typeof value === 'object' && '$type' in value) {
              const typeValue = (value as { $type?: unknown }).$type;
              if (typeValue === 'date') {
                this.setNestedValue(currentDoc, path, new Date().toISOString());
                modified = true;
                continue;
              }
              if (typeValue === 'timestamp') {
                // Represent timestamp as a numeric UNIX epoch in milliseconds
                this.setNestedValue(currentDoc, path, Date.now());
                modified = true;
                continue;
              }
              throw new Error(
                `Unsupported $currentDate $type value for path "${path}": ${JSON.stringify(typeValue)}`
              );
            }

            throw new Error(
              `Unsupported $currentDate value for path "${path}": ${JSON.stringify(value)}`
            );
          }
          break;
      }
    }

    if (modified) {
      // Update the document in SQLite
      const updateSql = `UPDATE "${this.name}" SET data = ? WHERE _id = ?`;
      const updateParams = [
        safeJsonStringify(currentDoc, `updateOne for document ${rowToUpdate._id}`),
        rowToUpdate._id,
      ];

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
      const currentDoc = safeJsonParse(
        rowToUpdate.data,
        `updateMany for document ${rowToUpdate._id}`
      );
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
          case '$addToSet':
            for (const path in opArgs) {
              const value = opArgs[path];
              const currentValue = this.getNestedValue(currentDoc, path);
              const arr: unknown[] = Array.isArray(currentValue) ? currentValue : [];
              const items =
                typeof value === 'object' && value !== null && '$each' in value && Array.isArray(value.$each)
                  ? value.$each
                  : [value];
              let changed = false;
              for (const item of items) {
                const alreadyPresent = arr.some(
                  (el) => JSON.stringify(el) === JSON.stringify(item)
                );
                if (!alreadyPresent) {
                  arr.push(item);
                  changed = true;
                }
              }
              if (changed || !Array.isArray(currentValue)) {
                this.setNestedValue(currentDoc, path, arr);
                modified = true;
              }
            }
            break;
          case '$pop':
            for (const path in opArgs) {
              const value = opArgs[path];
              const currentValue = this.getNestedValue(currentDoc, path);
              if (Array.isArray(currentValue) && currentValue.length > 0) {
                if (value === 1) {
                  currentValue.pop();
                } else if (value === -1) {
                  currentValue.shift();
                }
                this.setNestedValue(currentDoc, path, currentValue);
                modified = true;
              }
            }
            break;
          case '$mul':
            for (const path in opArgs) {
              const value = opArgs[path];
              if (typeof value === 'number') {
                const currentValue = this.getNestedValue(currentDoc, path);
                const numericCurrent = typeof currentValue === 'number' ? currentValue : 0;
                this.setNestedValue(currentDoc, path, numericCurrent * value);
                modified = true;
              }
            }
            break;
          case '$min':
            for (const path in opArgs) {
              const value = opArgs[path];
              const currentValue = this.getNestedValue(currentDoc, path);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (currentValue === undefined || (value as any) < (currentValue as any)) {
                this.setNestedValue(currentDoc, path, value);
                modified = true;
              }
            }
            break;
          case '$max':
            for (const path in opArgs) {
              const value = opArgs[path];
              const currentValue = this.getNestedValue(currentDoc, path);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (currentValue === undefined || (value as any) > (currentValue as any)) {
                this.setNestedValue(currentDoc, path, value);
                modified = true;
              }
            }
            break;
          case '$currentDate':
            for (const path in opArgs) {
              this.setNestedValue(currentDoc, path, new Date().toISOString());
              modified = true;
            }
            break;
          default:
            throw new Error(`Unsupported update operator: ${operator}`);
        }
      }
      if (modified) {
        // Update the document in SQLite
        const updateSql = `UPDATE "${this.name}" SET data = ? WHERE _id = ?`;
        const updateParams = [
          safeJsonStringify(currentDoc, `updateMany for document ${rowToUpdate._id}`),
          rowToUpdate._id,
        ];
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
   * Returns the number of documents in the collection.
   * This is an estimate and may not reflect the exact count in concurrent environments.
   * @returns {Promise<number>} The estimated count.
   */
  async estimatedDocumentCount(): Promise<number> {
    await this.ensureTable();
    const result = await this.db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM "${this.name}"`
    );
    return result?.count || 0;
  }

  /**
   * Finds a single document matching the filter, applies the update, and returns the document.
   * @param filter The selection criteria.
   * @param update The modifications to apply.
   * @param options Options including returnDocument ('before'|'after') and upsert.
   * @returns {Promise<T | null>} The document before or after the update, or null.
   */
  async findOneAndUpdate(
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options: FindOneAndUpdateOptions<T> = {}
  ): Promise<T | null> {
    await this.ensureTable();
    const { returnDocument = 'before', upsert = false, projection } = options;

    // Fetch the target document without projection so we always have the _id
    const idDocs = await this.find(filter).limit(1).toArray();
    const existingFullDoc = idDocs.length > 0 ? (idDocs[0] as T & DocumentWithId) : null;
    const existingId = existingFullDoc?._id;

    if (!existingFullDoc && !upsert) {
      return null;
    }

    // Update by _id when available to ensure we modify the exact document we found
    const updateFilter: Filter<T> =
      existingId !== undefined && existingId !== null
        ? ({ _id: existingId } as Filter<T>)
        : filter;

    const updateResult = await this.updateOne(updateFilter, update, { upsert });

    if (returnDocument === 'after') {
      const targetId = updateResult.upsertedId ?? existingId;
      if (!targetId) return null;
      const afterCursor = this.find({ _id: targetId } as Filter<T>).limit(1);
      if (projection) afterCursor.project(projection as Projection<T>);
      const afterDocs = await afterCursor.toArray();
      return afterDocs.length > 0 ? afterDocs[0] : null;
    }

    // returnDocument === 'before'
    if (!existingFullDoc) {
      // Upsert case where no original document existed
      return null;
    }

    if (!projection) {
      return existingFullDoc as T;
    }

    // Apply projection to the located document by _id
    if (existingId === undefined || existingId === null) {
      return null;
    }
    const beforeCursor = this.find({ _id: existingId } as Filter<T>).limit(1);
    beforeCursor.project(projection as Projection<T>);
    const beforeDocs = await beforeCursor.toArray();
    return beforeDocs.length > 0 ? beforeDocs[0] : null;
  }

  /**
   * Finds a single document matching the filter, deletes it, and returns it.
   * @param filter The selection criteria.
   * @param options Options including field projection.
   * @returns {Promise<T | null>} The deleted document or null.
   */
  async findOneAndDelete(
    filter: Filter<T>,
    options: FindOneAndDeleteOptions<T> = {}
  ): Promise<T | null> {
    await this.ensureTable();
    const { projection } = options;

    // Fetch without projection to always have _id for the delete
    const idDocs = await this.find(filter).limit(1).toArray();
    const existingFullDoc = idDocs.length > 0 ? (idDocs[0] as T & DocumentWithId) : null;

    if (!existingFullDoc) {
      return null;
    }

    await this.deleteOne({ _id: existingFullDoc._id } as Filter<T>);

    if (!projection) {
      return existingFullDoc as T;
    }

    // Apply projection to the in-memory document
    const projCursor = this.find({ _id: existingFullDoc._id } as Filter<T>).limit(1);
    projCursor.project(projection as Projection<T>);
    // Since we already deleted, apply projection manually from the full doc
    const fullDocRec = existingFullDoc as Record<string, unknown>;
    return this.applyAggregateProjection(
      fullDocRec,
      projection as Record<string, unknown>
    ) as T;
  }

  /**
   * Finds a single document matching the filter and replaces it entirely.
   * @param filter The selection criteria.
   * @param replacement The replacement document (replaces all fields except _id).
   * @param options Options including returnDocument, upsert, and projection.
   * @returns {Promise<T | null>} The document before or after the replacement, or null.
   */
  async findOneAndReplace(
    filter: Filter<T>,
    replacement: Omit<T, '_id'>,
    options: FindOneAndReplaceOptions<T> = {}
  ): Promise<T | null> {
    await this.ensureTable();
    const { returnDocument = 'before', upsert = false, projection } = options;

    const existingDoc = await this.findOne(filter);

    if (!existingDoc && !upsert) {
      return null;
    }

    if (existingDoc) {
      const docId = existingDoc._id!;
      const newData = safeJsonStringify(replacement, `findOneAndReplace for ${docId}`);
      await this.db.run(`UPDATE "${this.name}" SET data = ? WHERE _id = ?`, [newData, docId]);

      if (returnDocument === 'after') {
        const afterCursor = this.find({ _id: docId } as Filter<T>).limit(1);
        if (projection) afterCursor.project(projection as Projection<T>);
        const afterDocs = await afterCursor.toArray();
        return afterDocs.length > 0 ? afterDocs[0] : null;
      }

      if (!projection) {
        return existingDoc;
      }
      // Apply projection to the pre-replacement document
      return this.applyAggregateProjection(
        existingDoc as Record<string, unknown>,
        projection as Record<string, unknown>
      ) as T;
    } else {
      // Upsert: insert the replacement. Carry _id from filter if it's a simple equality.
      const filterRec = filter as Record<string, unknown>;
      const filterId =
        filterRec['_id'] !== undefined &&
        filterRec['_id'] !== null &&
        typeof filterRec['_id'] !== 'object'
          ? (filterRec['_id'] as string)
          : undefined;

      const docToInsert = filterId
        ? ({ ...replacement, _id: filterId } as Omit<T, '_id'> & { _id?: string })
        : (replacement as Omit<T, '_id'> & { _id?: string });

      const result = await this.insertOne(docToInsert);

      if (returnDocument === 'after') {
        const afterCursor = this.find({ _id: result.insertedId } as Filter<T>).limit(1);
        if (projection) afterCursor.project(projection as Projection<T>);
        const afterDocs = await afterCursor.toArray();
        return afterDocs.length > 0 ? afterDocs[0] : null;
      }
      return null;
    }
  }

  /**
   * Replaces a single document matching the filter.
   * @param filter The selection criteria.
   * @param replacement The replacement document (replaces all fields except _id).
   * @param options Options including upsert.
   * @returns {Promise<UpdateResult>} An object describing the outcome.
   */
  async replaceOne(
    filter: Filter<T>,
    replacement: Omit<T, '_id'>,
    options: ReplaceOptions = {}
  ): Promise<UpdateResult> {
    await this.ensureTable();
    const { upsert = false } = options;

    const existingDoc = await this.findOne(filter);

    if (!existingDoc) {
      if (!upsert) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
      }
      const result = await this.insertOne(replacement as Omit<T, '_id'> & { _id?: string });
      return {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedId: result.insertedId,
      };
    }

    const docId = existingDoc._id!;
    const newData = safeJsonStringify(replacement, `replaceOne for ${docId}`);
    await this.db.run(`UPDATE "${this.name}" SET data = ? WHERE _id = ?`, [newData, docId]);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
  }

  /**
   * Returns distinct values for a field across all documents matching the filter.
   * @param field The field to find distinct values for.
   * @param filter Optional filter to narrow the documents.
   * @returns {Promise<unknown[]>} An array of distinct values.
   */
  async distinct(field: string, filter: Filter<T> = {}): Promise<unknown[]> {
    await this.ensureTable();

    const docs = await this.find(filter).toArray();

    const seen = new Set<string>();
    const results: unknown[] = [];

    for (const doc of docs as Array<Record<string, unknown>>) {
      const value = this.getNestedValue(doc, field);

      if (Array.isArray(value)) {
        for (const item of value) {
          const key = JSON.stringify(item);
          if (!seen.has(key)) {
            seen.add(key);
            results.push(item);
          }
        }
      } else if (value !== undefined) {
        const key = JSON.stringify(value);
        if (!seen.has(key)) {
          seen.add(key);
          results.push(value);
        }
      }
    }

    return results;
  }

  /**
   * Drops the entire collection (table) from the database.
   * @returns {Promise<void>}
   */
  async drop(): Promise<void> {
    await this.db.exec(`DROP TABLE IF EXISTS "${this.name}"`);
  }

  /**
   * Executes an aggregation pipeline on the collection.
   * Supports: $match, $project, $sort, $limit, $skip, $count, $group, $unwind, $addFields.
   * @param pipeline An array of pipeline stage documents.
   * @returns An object with a toArray() method that returns the aggregation result.
   */
  aggregate(pipeline: AggregationPipeline): { toArray: () => Promise<Record<string, unknown>[]> } {
    return {
      toArray: async (): Promise<Record<string, unknown>[]> => {
        await this.ensureTable();
        return this.runAggregationPipeline(pipeline);
      },
    };
  }

  /**
   * Runs an aggregation pipeline and returns results.
   * @private
   */
  private async runAggregationPipeline(
    pipeline: AggregationPipeline
  ): Promise<Record<string, unknown>[]> {
    let results: Record<string, unknown>[] = [];

    // Only push the initial $match down to SQL when it is the very first stage.
    // Applying a $match that appears after other stages (e.g. after $unwind/$group) too
    // early would change pipeline semantics.
    const firstStage = pipeline[0];
    const firstIsMatch = firstStage !== undefined && '$match' in firstStage;

    if (firstIsMatch) {
      const matchFilter = (firstStage as { $match: Filter<T> }).$match;
      const docs = await this.find(matchFilter).toArray();
      results = docs as Record<string, unknown>[];
    } else {
      const docs = await this.find({} as Filter<T>).toArray();
      results = docs as Record<string, unknown>[];
    }

    for (let i = 0; i < pipeline.length; i++) {
      const stage = pipeline[i];
      const stageKey = Object.keys(stage)[0];

      switch (stageKey) {
        case '$match': {
          // Skip the first stage if it was already used for the initial SQL fetch
          if (i === 0 && firstIsMatch) {
            break;
          }
          const matchFilter = stage['$match'] as Filter<T>;
          results = results.filter((doc) => this.matchesFilter(doc, matchFilter));
          break;
        }

        case '$project': {
          const projection = stage['$project'] as Record<string, unknown>;
          results = results.map((doc) => this.applyAggregateProjection(doc, projection));
          break;
        }

        case '$addFields': {
          const fields = stage['$addFields'] as Record<string, unknown>;
          results = results.map((doc) => ({ ...doc, ...fields }));
          break;
        }

        case '$sort': {
          const sortSpec = stage['$sort'] as Record<string, 1 | -1>;
          results = results.sort((a, b) => {
            for (const [field, order] of Object.entries(sortSpec)) {
              const aVal = this.getNestedValue(a, field);
              const bVal = this.getNestedValue(b, field);
              if (aVal === bVal) continue;
              if (aVal === null || aVal === undefined) return order;
              if (bVal === null || bVal === undefined) return -order;
              const cmp = aVal < bVal ? -1 : 1;
              return cmp * order;
            }
            return 0;
          });
          break;
        }

        case '$limit': {
          const limitCount = stage['$limit'] as number;
          results = results.slice(0, limitCount);
          break;
        }

        case '$skip': {
          const skipCount = stage['$skip'] as number;
          results = results.slice(skipCount);
          break;
        }

        case '$count': {
          const countField = stage['$count'] as string;
          results = [{ [countField]: results.length }];
          break;
        }

        case '$group': {
          results = this.applyGroupStage(results, stage['$group'] as Record<string, unknown>);
          break;
        }

        case '$unwind': {
          const path =
            typeof stage['$unwind'] === 'string'
              ? stage['$unwind']
              : (stage['$unwind'] as { path: string }).path;
          const fieldName = path.startsWith('$') ? path.slice(1) : path;
          const unwound: Record<string, unknown>[] = [];
          for (const doc of results) {
            const arrayVal = this.getNestedValue(doc, fieldName);
            if (Array.isArray(arrayVal)) {
              for (const item of arrayVal) {
                const newDoc = { ...doc };
                this.setNestedValue(newDoc, fieldName, item);
                unwound.push(newDoc);
              }
            } else if (arrayVal !== undefined && arrayVal !== null) {
              unwound.push(doc);
            }
          }
          results = unwound;
          break;
        }
      }
    }

    return results;
  }

  /**
   * Applies a $group pipeline stage.
   * @private
   */
  private applyGroupStage(
    docs: Record<string, unknown>[],
    groupSpec: Record<string, unknown>
  ): Record<string, unknown>[] {
    const groups = new Map<string, Record<string, unknown>[]>();

    const idSpec = groupSpec['_id'];

    for (const doc of docs) {
      let groupKey: unknown;
      if (idSpec === null) {
        groupKey = null;
      } else if (typeof idSpec === 'string' && idSpec.startsWith('$')) {
        groupKey = this.getNestedValue(doc, idSpec.slice(1));
      } else if (typeof idSpec === 'object' && idSpec !== null) {
        const keyObj: Record<string, unknown> = {};
        for (const [k, expr] of Object.entries(idSpec as Record<string, unknown>)) {
          if (typeof expr === 'string' && expr.startsWith('$')) {
            keyObj[k] = this.getNestedValue(doc, expr.slice(1));
          } else {
            keyObj[k] = expr;
          }
        }
        groupKey = keyObj;
      } else {
        groupKey = idSpec;
      }

      const keyStr = JSON.stringify(groupKey);
      if (!groups.has(keyStr)) {
        groups.set(keyStr, []);
      }
      groups.get(keyStr)!.push(doc);
    }

    const results: Record<string, unknown>[] = [];
    for (const [keyStr, groupDocs] of groups) {
      const groupResult: Record<string, unknown> = { _id: JSON.parse(keyStr) };

      for (const [field, expr] of Object.entries(groupSpec)) {
        if (field === '_id') continue;
        if (typeof expr === 'object' && expr !== null) {
          const aggOp = Object.keys(expr as object)[0];
          const aggArg = (expr as Record<string, unknown>)[aggOp];

          switch (aggOp) {
            case '$sum': {
              if (typeof aggArg === 'number') {
                groupResult[field] = groupDocs.length * aggArg;
              } else if (typeof aggArg === 'string' && aggArg.startsWith('$')) {
                const fieldName = aggArg.slice(1);
                groupResult[field] = groupDocs.reduce((sum, doc) => {
                  const val = this.getNestedValue(doc, fieldName);
                  return sum + (typeof val === 'number' ? val : 0);
                }, 0);
              }
              break;
            }
            case '$avg': {
              if (typeof aggArg === 'string' && aggArg.startsWith('$')) {
                const fieldName = aggArg.slice(1);
                const nums = groupDocs
                  .map((doc) => this.getNestedValue(doc, fieldName))
                  .filter((v) => typeof v === 'number') as number[];
                groupResult[field] = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
              }
              break;
            }
            case '$min': {
              if (typeof aggArg === 'string' && aggArg.startsWith('$')) {
                const fieldName = aggArg.slice(1);
                const vals = groupDocs
                  .map((doc) => this.getNestedValue(doc, fieldName))
                  .filter((v) => v !== undefined && v !== null);
                groupResult[field] = vals.length > 0 ? vals.reduce((a, b) => (a < b ? a : b)) : null;
              }
              break;
            }
            case '$max': {
              if (typeof aggArg === 'string' && aggArg.startsWith('$')) {
                const fieldName = aggArg.slice(1);
                const vals = groupDocs
                  .map((doc) => this.getNestedValue(doc, fieldName))
                  .filter((v) => v !== undefined && v !== null);
                groupResult[field] = vals.length > 0 ? vals.reduce((a, b) => (a > b ? a : b)) : null;
              }
              break;
            }
            case '$push': {
              if (typeof aggArg === 'string' && aggArg.startsWith('$')) {
                const fieldName = aggArg.slice(1);
                groupResult[field] = groupDocs.map((doc) => this.getNestedValue(doc, fieldName));
              } else {
                groupResult[field] = groupDocs.map(() => aggArg);
              }
              break;
            }
            case '$first': {
              if (typeof aggArg === 'string' && aggArg.startsWith('$')) {
                const fieldName = aggArg.slice(1);
                groupResult[field] =
                  groupDocs.length > 0 ? this.getNestedValue(groupDocs[0], fieldName) : null;
              }
              break;
            }
            case '$last': {
              if (typeof aggArg === 'string' && aggArg.startsWith('$')) {
                const fieldName = aggArg.slice(1);
                groupResult[field] =
                  groupDocs.length > 0
                    ? this.getNestedValue(groupDocs[groupDocs.length - 1], fieldName)
                    : null;
              }
              break;
            }
            case '$count': {
              groupResult[field] = groupDocs.length;
              break;
            }
          }
        }
      }

      results.push(groupResult);
    }

    return results;
  }

  /**
   * Applies a $project stage to a document.
   * @private
   */
  private applyAggregateProjection(
    doc: Record<string, unknown>,
    projection: Record<string, unknown>
  ): Record<string, unknown> {
    const hasInclusion = Object.entries(projection).some(
      ([k, v]) => k !== '_id' && (v === 1 || v === true)
    );

    if (hasInclusion) {
      // Inclusion mode
      const result: Record<string, unknown> = {};
      if (projection['_id'] !== 0 && projection['_id'] !== false) {
        result['_id'] = doc['_id'];
      }
      for (const [field, val] of Object.entries(projection)) {
        if (val === 1 || val === true) {
          result[field] = this.getNestedValue(doc, field);
        } else if (typeof val === 'string' && val.startsWith('$')) {
          result[field] = this.getNestedValue(doc, val.slice(1));
        }
      }
      return result;
    } else {
      // Exclusion mode
      const result = { ...doc };
      for (const [field, val] of Object.entries(projection)) {
        if (val === 0 || val === false) {
          delete result[field];
        }
      }
      return result;
    }
  }

  /**
   * Checks if a document matches a filter (for in-memory aggregation stages).
   * Uses the same logic as FindCursor but applied in JavaScript.
   * @private
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private matchesFilter(doc: Record<string, unknown>, filter: Filter<any>): boolean {
    for (const [key, value] of Object.entries(filter)) {
      if (key === '$and' && Array.isArray(value)) {
        if (!value.every((f) => this.matchesFilter(doc, f))) return false;
        continue;
      }
      if (key === '$or' && Array.isArray(value)) {
        if (!value.some((f) => this.matchesFilter(doc, f))) return false;
        continue;
      }
      if (key === '$nor' && Array.isArray(value)) {
        if (value.some((f) => this.matchesFilter(doc, f))) return false;
        continue;
      }
      if (key.startsWith('$')) continue;

      const docValue = this.getNestedValue(doc, key);

      if (typeof value === 'object' && value !== null && !(value instanceof RegExp) && !(value instanceof Date)) {
        const ops = value as Record<string, unknown>;
        const hasOps = Object.keys(ops).some((k) => k.startsWith('$'));
        if (hasOps) {
          if (!this.matchesOperators(docValue, ops)) return false;
          continue;
        }
      }

      // Simple equality (including Date comparison)
      if (value instanceof Date) {
        if (!(docValue instanceof Date) || docValue.getTime() !== value.getTime()) return false;
      } else if (Array.isArray(docValue)) {
        if (!docValue.some((el) => JSON.stringify(el) === JSON.stringify(value))) return false;
      } else if (JSON.stringify(docValue) !== JSON.stringify(value)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Checks if a value matches a set of query operators (for in-memory filtering).
   * @private
   */
  private matchesOperators(docValue: unknown, ops: Record<string, unknown>): boolean {
    for (const [op, opVal] of Object.entries(ops)) {
      switch (op) {
        case '$eq':
          if (JSON.stringify(docValue) !== JSON.stringify(opVal)) return false;
          break;
        case '$ne':
          if (JSON.stringify(docValue) === JSON.stringify(opVal)) return false;
          break;
        case '$gt':
          if (!((docValue as number) > (opVal as number))) return false;
          break;
        case '$gte':
          if (!((docValue as number) >= (opVal as number))) return false;
          break;
        case '$lt':
          if (!((docValue as number) < (opVal as number))) return false;
          break;
        case '$lte':
          if (!((docValue as number) <= (opVal as number))) return false;
          break;
        case '$in':
          if (!Array.isArray(opVal)) return false;
          if (Array.isArray(docValue)) {
            if (!docValue.some((el) => (opVal as unknown[]).some((v) => JSON.stringify(el) === JSON.stringify(v)))) return false;
          } else {
            if (!(opVal as unknown[]).some((v) => JSON.stringify(v) === JSON.stringify(docValue))) return false;
          }
          break;
        case '$nin':
          if (!Array.isArray(opVal)) return false;
          if ((opVal as unknown[]).some((v) => JSON.stringify(v) === JSON.stringify(docValue))) return false;
          break;
        case '$exists':
          if (opVal && docValue === undefined) return false;
          if (!opVal && docValue !== undefined) return false;
          break;
        case '$regex': {
          const pattern = opVal instanceof RegExp ? opVal : new RegExp(opVal as string);
          if (!pattern.test(String(docValue))) return false;
          break;
        }
        case '$size':
          if (!Array.isArray(docValue) || docValue.length !== (opVal as number)) return false;
          break;
        case '$options':
          break; // consumed by $regex
      }
    }
    return true;
  }

  /**
   * Opens a change stream to watch for changes on this collection.
   * Returns a ChangeStream that emits events when documents are inserted, updated, or deleted.
   *
   * @param options Options for the change stream
   * @returns A ChangeStream instance
   *
   * @example
   * ```typescript
   * const changeStream = collection.watch();
   *
   * changeStream.on('change', (change) => {
   *   console.log('Change detected:', change);
   * });
   *
   * // Or use async iteration
   * for await (const change of changeStream) {
   *   console.log('Change detected:', change);
   * }
   *
   * // Close the change stream when done
   * changeStream.close();
   * ```
   */
  watch(options: ChangeStreamOptions<T> = {}): ChangeStream<T> {
    return new ChangeStream<T>(this.db, this.name, options);
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
