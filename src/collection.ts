import { v4 as uuidv4 } from 'uuid';
import { SQLiteDB } from './db';
import {
  DocumentWithId,
  Filter,
  UpdateFilter,
  InsertOneResult,
  UpdateResult,
  DeleteResult,
  QueryOperators,
  UpdateOperators,
  SortCriteria,
  Projection,
} from './types';

interface SQLiteRow {
  _id: string;
  data: string; // JSON string
}

/**
 * Represents a cursor for find operations, allowing chaining of limit, skip, and sort.
 */
export class FindCursor<T extends DocumentWithId> {
  private queryParts: {
    sql: string;
    params: unknown[];
  };
  private limitCount: number | null = null;
  private skipCount: number | null = null;
  private sortCriteria: SortCriteria<T> | null = null;
  private projectionFields: Projection<T> | null = null;

  constructor(
    private db: SQLiteDB,
    private collectionName: string,
    initialFilter: Filter<T>
  ) {
    this.queryParts = this.buildSelectQuery(initialFilter);
  }

  private parseJsonPath(path: string): string {
    return `'$.${path.replace(/\./g, '.')}'`;
  }

  private buildWhereClause(filter: Filter<T>, params: unknown[]): string {
    const conditions: string[] = [];

    // Handle $and, $or, $nor logical operators at the top level
    if (filter.$and) {
        const andConditions = filter.$and.map(subFilter => `(${this.buildWhereClause(subFilter, params)})`).join(' AND ');
        conditions.push(`(${andConditions})`);
    } else if (filter.$or) {
        const orConditions = filter.$or.map(subFilter => `(${this.buildWhereClause(subFilter, params)})`).join(' OR ');
        conditions.push(`(${orConditions})`);
    } else if (filter.$nor) {
        const norConditions = filter.$nor.map(subFilter => `(${this.buildWhereClause(subFilter, params)})`).join(' OR ');
        conditions.push(`NOT (${norConditions})`);
    } else {
        // Handle field conditions
        for (const key in filter) {
            if (key.startsWith('$')) continue; // Skip logical operators already handled

            const value = filter[key as keyof Filter<T>];
            if (key === '_id') {
                if (typeof value === 'string') {
                    conditions.push('_id = ?');
                    params.push(value);
                } else if (typeof value === 'object' && value !== null && (value as QueryOperators<string>).$in) {
                    const inValues = (value as QueryOperators<string>).$in as string[];
                    if (inValues.length > 0) {
                        conditions.push(`_id IN (${inValues.map(() => '?').join(',')})`);
                        params.push(...inValues);
                    } else {
                        conditions.push('1=0'); // No values in $in means nothing matches
                    }
                } else if (typeof value === 'object' && value !== null && (value as QueryOperators<string>).$ne) {
                    conditions.push('_id <> ?');
                    params.push((value as QueryOperators<string>).$ne);
                }
                // Add other _id specific operators if needed
            } else {
                const jsonPath = this.parseJsonPath(key);
                if (typeof value === 'object' && value !== null) {
                    // Handle operators like $gt, $lt, $in, $exists, $not etc.
                    for (const op in value) {
                        const opValue = (value as QueryOperators<any>)[op as keyof QueryOperators<any>];
                        switch (op) {
                            case '$eq':
                                conditions.push(`json_extract(data, ${jsonPath}) = json(?)`);
                                params.push(JSON.stringify(opValue));
                                break;
                            case '$ne':
                                conditions.push(`json_extract(data, ${jsonPath}) != json(?)`);
                                params.push(JSON.stringify(opValue));
                                break;
                            case '$gt':
                                conditions.push(`json_extract(data, ${jsonPath}) > json(?)`);
                                params.push(JSON.stringify(opValue));
                                break;
                            case '$gte':
                                conditions.push(`json_extract(data, ${jsonPath}) >= json(?)`);
                                params.push(JSON.stringify(opValue));
                                break;
                            case '$lt':
                                conditions.push(`json_extract(data, ${jsonPath}) < json(?)`);
                                params.push(JSON.stringify(opValue));
                                break;
                            case '$lte':
                                conditions.push(`json_extract(data, ${jsonPath}) <= json(?)`);
                                params.push(JSON.stringify(opValue));
                                break;
                            case '$in':
                                if (Array.isArray(opValue) && opValue.length > 0) {
                                    const inConditions = opValue.map(() => `json_extract(data, ${jsonPath}) = json(?)`).join(' OR ');
                                    conditions.push(`(${inConditions})`);
                                    opValue.forEach(val => params.push(JSON.stringify(val)));
                                } else {
                                    conditions.push('1=0'); // Empty $in array, nothing will match
                                }
                                break;
                            case '$nin':
                                if (Array.isArray(opValue) && opValue.length > 0) {
                                    const ninConditions = opValue.map(() => `json_extract(data, ${jsonPath}) != json(?)`).join(' AND ');
                                    conditions.push(`(${ninConditions})`);
                                    opValue.forEach(val => params.push(JSON.stringify(val)));
                                }
                                // Empty $nin array means match everything, so no condition needed
                                break;
                            case '$exists':
                                if (opValue === true) {
                                    conditions.push(`json_extract(data, ${jsonPath}) IS NOT NULL`);
                                } else {
                                    conditions.push(`json_extract(data, ${jsonPath}) IS NULL`);
                                }
                                break;
                            // Add other operators as needed
                        }
                    }
                } else {
                    // Direct equality for non-object values
                    conditions.push(`json_extract(data, ${jsonPath}) = json(?)`);
                    params.push(JSON.stringify(value));
                }
            }
        }
    }
    return conditions.length > 0 ? conditions.join(' AND ') : '1=1';
  }

  private buildSelectQuery(filter: Filter<T>): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const whereClause = this.buildWhereClause(filter, params);
    const sql = `SELECT _id, data FROM "${this.collectionName}" WHERE ${whereClause}`;
    return { sql, params };
  }

  /**
   * Specifies the maximum number of documents the cursor will return.
   * @param count The number of documents to limit to.
   * @returns The `FindCursor` instance for chaining.
   */
  public limit(count: number): this {
    if (count < 0) throw new Error("Limit must be a non-negative number.");
    this.limitCount = count;
    return this;
  }

  /**
   * Specifies the number of documents to skip.
   * @param count The number of documents to skip.
   * @returns The `FindCursor` instance for chaining.
   */
  public skip(count: number): this {
    if (count < 0) throw new Error("Skip must be a non-negative number.");
    this.skipCount = count;
    return this;
  }

  /**
   * Specifies the sorting order for the documents.
   * @param sortCriteria An object defining sort order (e.g., `{ age: -1, name: 1 }`).
   * @returns The `FindCursor` instance for chaining.
   */
  public sort(sortCriteria: SortCriteria<T>): this {
    this.sortCriteria = sortCriteria;
    return this;
  }

  /**
   * Specifies the fields to return (projection).
   * @param projection An object where keys are field names and values are 1 (include) or 0 (exclude).
   * `_id` is included by default unless explicitly excluded.
   * @returns The `FindCursor` instance for chaining.
   */
  public project(projection: Projection<T>): this {
    this.projectionFields = projection;
    return this;
  }

  private applyProjection(doc: T): Partial<T> {
    if (!this.projectionFields) return doc;

    const projectedDoc: Partial<T> = {};
    let includeMode = true; // true if any field is 1, false if any field is 0 (excluding _id)
    let hasExplicitInclusion = false;

    // Determine if it's an inclusion or exclusion projection
    for (const key in this.projectionFields) {
        if (key === '_id') continue;
        if (this.projectionFields[key as keyof T] === 1) {
            hasExplicitInclusion = true;
            break;
        }
        if (this.projectionFields[key as keyof T] === 0) {
            includeMode = false;
            // No break here, need to check all for explicit inclusions if _id is also 0
        }
    }
    
    if (this.projectionFields._id === 0 && !hasExplicitInclusion) {
        // If _id is excluded and no other fields are explicitly included,
        // it's an exclusion projection where other fields are implicitly included.
        includeMode = false;
    } else if (hasExplicitInclusion) {
        includeMode = true;
    }

    if (includeMode) { // Inclusion mode
        for (const key in this.projectionFields) {
            if (this.projectionFields[key as keyof T] === 1) {
                if (key.includes('.')) {
                    // Handle nested paths for inclusion (basic implementation)
                    const path = key.split('.');
                    let current: any = doc;
                    let target: any = projectedDoc;

                    // Navigate to the last parent in the path
                    for (let i = 0; i < path.length - 1; i++) {
                        const segment = path[i];
                        if (current[segment] === undefined) break;
                        
                        if (target[segment] === undefined) {
                            target[segment] = {};
                        }
                        
                        current = current[segment];
                        target = target[segment];
                    }
                    
                    // Set the final property if we reached it
                    const lastSegment = path[path.length - 1];
                    if (current && current[lastSegment] !== undefined) {
                        target[lastSegment] = current[lastSegment];
                    }
                } else if (key in doc) {
                    projectedDoc[key as keyof T] = doc[key as keyof T];
                }
            }
        }
        // _id is included by default in inclusion mode, unless explicitly excluded
        if (this.projectionFields._id !== 0 && '_id' in doc) {
            projectedDoc._id = doc._id;
        }
    } else { // Exclusion mode
        Object.assign(projectedDoc, doc);
        for (const key in this.projectionFields) {
            if (this.projectionFields[key as keyof T] === 0) {
                if (key.includes('.')) {
                    // Handle nested paths for exclusion (basic implementation)
                    const path = key.split('.');
                    let current: any = projectedDoc;
                    
                    // Navigate to the parent of the property to exclude
                    for (let i = 0; i < path.length - 1; i++) {
                        const segment = path[i];
                        if (current[segment] === undefined) break;
                        current = current[segment];
                    }
                    
                    // Delete the final property if we reached its parent
                    const lastSegment = path[path.length - 1];
                    if (current && current[lastSegment] !== undefined) {
                        delete current[lastSegment];
                    }
                } else {
                    delete projectedDoc[key as keyof T];
                }
            }
        }
    }
    return projectedDoc;
  }

  /**
   * Executes the query and returns all matching documents as an array.
   * @returns A promise that resolves to an array of documents.
   */
  public async toArray(): Promise<Partial<T>[]> {
    let finalSql = this.queryParts.sql;
    const finalParams = [...this.queryParts.params];

    if (this.sortCriteria) {
      const sortClauses = Object.entries(this.sortCriteria)
        .map(([field, order]) => {
          if (field === '_id') {
            return `_id ${order === 1 ? 'ASC' : 'DESC'}`;
          }
          return `json_extract(data, ${this.parseJsonPath(field)}) ${order === 1 ? 'ASC' : 'DESC'}`;
        });
      if (sortClauses.length > 0) {
        finalSql += ` ORDER BY ${sortClauses.join(', ')}`;
      }
    }

    if (this.limitCount !== null) {
      finalSql += ` LIMIT ?`;
      finalParams.push(this.limitCount);
    }

    if (this.skipCount !== null) {
      if (this.limitCount === null) {
        // SQLite requires a LIMIT if OFFSET is used.
        // Use a very large number if no limit is specified.
        finalSql += ` LIMIT -1`; // Or a large number like 999999999
      }
      finalSql += ` OFFSET ?`;
      finalParams.push(this.skipCount);
    }

    const rows = await this.db.all<SQLiteRow>(finalSql, finalParams);
    return rows.map(row => {
        const doc = { _id: row._id, ...JSON.parse(row.data) } as T;
        return this.applyProjection(doc);
    });
  }
}

/**
 * MongoLiteCollection provides methods to interact with a specific SQLite table
 * as if it were a MongoDB collection.
 */
export class MongoLiteCollection<T extends DocumentWithId> {
  constructor(private db: SQLiteDB, public readonly name: string) {
    this.ensureTable().catch(err => {
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
    const docId = doc._id || uuidv4();
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
      throw error; // Re-throw other errors
    }
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
    return new FindCursor<T>(this.db, this.name, filter);
  }

  /**
   * Updates a single document matching the filter.
   * @param filter The selection criteria for the update.
   * @param update The modifications to apply.
   * @returns {Promise<UpdateResult>} An object describing the outcome.
   */
  async updateOne(filter: Filter<T>, update: UpdateFilter<T>): Promise<UpdateResult> {
    await this.ensureTable();
    
    // Find the document first (only one)
    const paramsForSelect: unknown[] = [];
    const whereClause = new FindCursor<T>(this.db, this.name, filter)['buildWhereClause'](filter, paramsForSelect);
    const selectSql = `SELECT _id, data FROM "${this.name}" WHERE ${whereClause} LIMIT 1`;

    const rowToUpdate = await this.db.get<SQLiteRow>(selectSql, paramsForSelect);

    if (!rowToUpdate) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
    }

    let currentDoc = JSON.parse(rowToUpdate.data);
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
              const newArray = currentValue.filter(item => {
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
      
      const result = await this.db.run(updateSql, updateParams);
      return {
        acknowledged: true,
        matchedCount: 1,
        modifiedCount: result.changes || 0,
        upsertedId: null, // We don't support upsert yet
      };
    }
    
    return {
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 0, // No changes were made
      upsertedId: null,
    };
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
    const whereClause = new FindCursor<T>(this.db, this.name, filter)['buildWhereClause'](filter, paramsForDelete);
    const deleteSql = `DELETE FROM "${this.name}" WHERE ${whereClause} LIMIT 1`;
    
    const result = await this.db.run(deleteSql, paramsForDelete);
    return { acknowledged: true, deletedCount: result.changes || 0 };
  }

  /**
   * Deletes multiple documents matching the filter.
   * @param filter The criteria to select documents to delete.
   * @returns {Promise<DeleteResult>} An object describing the outcome.
   */
  async deleteMany(filter: Filter<T>): Promise<DeleteResult> {
    await this.ensureTable();
    
    const paramsForDelete: unknown[] = [];
    const whereClause = new FindCursor<T>(this.db, this.name, filter)['buildWhereClause'](filter, paramsForDelete);
    const deleteSql = `DELETE FROM "${this.name}" WHERE ${whereClause}`;
    
    const result = await this.db.run(deleteSql, paramsForDelete);
    return { acknowledged: true, deletedCount: result.changes || 0 };
  }

  /**
   * Counts the number of documents matching the filter.
   * @param filter The criteria to select documents to count.
   * @returns {Promise<number>} The count of matching documents.
   */
  async countDocuments(filter: Filter<T> = {}): Promise<number> {
    await this.ensureTable();
    
    const paramsForCount: unknown[] = [];
    const whereClause = new FindCursor<T>(this.db, this.name, filter)['buildWhereClause'](filter, paramsForCount);
    const countSql = `SELECT COUNT(*) as count FROM "${this.name}" WHERE ${whereClause}`;
    
    const result = await this.db.get<{ count: number }>(countSql, paramsForCount);
    return result?.count || 0;
  }
}
