import { DocumentWithId, Filter, SortCriteria, Projection, SQLiteRow } from '../types.js';
import { SQLiteDB } from '../db.js';

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
 * Helper function to convert JavaScript values to SQLite-compatible values.
 * This ensures that boolean values are converted to 0/1 integers that SQLite can handle.
 * Date objects are converted to ISO strings for SQLite storage and comparison.
 * @param value The value to convert
 * @returns A SQLite-compatible value
 */
function toSQLiteValue(value: unknown): unknown {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

/**
 * Helper function to recursively restore Date objects from JSON-parsed data.
 * Converts ISO date strings back to Date objects.
 * @param obj The object to process
 * @returns The object with Date strings converted back to Date objects
 */
function restoreDates(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Check if string is an ISO date string
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
    if (isoDateRegex.test(obj)) {
      const date = new Date(obj);
      // Verify it's a valid date and the string represents the same date
      if (!isNaN(date.getTime()) && date.toISOString() === obj) {
        return date;
      }
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => restoreDates(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = restoreDates(value);
    }
    return result;
  }

  return obj;
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
    initialFilter: Filter<T>,
    private readonly options: { verbose?: boolean } = {}
  ) {
    this.queryParts = this.buildSelectQuery(initialFilter);
  }

  private parseJsonPath(path: string): string {
    return `'$.${path.replace(/\./g, '.')}'`;
  }

  /**
   * Helper method to generate a comparison condition
   */
  private buildComparisonCondition(
    field: string,
    operator: string,
    value: unknown,
    params: unknown[],
    elementPrefix: string = 'data'
  ): string {
    // Handle _id specially as it's a column, not in the JSON
    if (field === '_id' && elementPrefix === 'data') {
      switch (operator) {
        case '$eq':
          params.push(toSQLiteValue(value));
          return '_id = ?';
        case '$ne':
          params.push(toSQLiteValue(value));
          return '_id <> ?';
        case '$in':
          if (Array.isArray(value) && value.length > 0) {
            // Convert each value to SQLite-compatible type
            params.push(...value.map((v) => toSQLiteValue(v)));
            return `_id IN (${value.map(() => '?').join(',')})`;
          }
          return '1=0'; // Empty array, nothing matches
        case '$nin':
          if (Array.isArray(value) && value.length > 0) {
            // Convert each value to SQLite-compatible type
            params.push(...value.map((v) => toSQLiteValue(v)));
            return `_id NOT IN (${value.map(() => '?').join(',')})`;
          }
          return '1=1'; // Empty array, everything matches
        default:
          // Handle other operators that might be applied to _id
          return '1=0'; // Unsupported operator for _id
      }
    }

    // For JSON fields
    const jsonPath =
      elementPrefix === 'data'
        ? `json_extract(${elementPrefix}, ${this.parseJsonPath(field)})`
        : `json_extract(${elementPrefix}.value, '$.${field}')`;

    switch (operator) {
      case '$eq':
        if (value === null) {
          return `${jsonPath} IS NULL`;
        }

        // Handle Date objects with exact equality
        if (value instanceof Date) {
          params.push(toSQLiteValue(value));
          return `${jsonPath} = ?`;
        }

        // Handle string matching for equality and array matching as par mongodb client
        params.push(toSQLiteValue(value));
        params.push(toSQLiteValue(value));
        return `(${jsonPath} = ? OR ${jsonPath} LIKE '%' || ? || '%')`; // For string matching
      case '$ne':
        if (value === null) {
          return `${jsonPath} IS NOT NULL`;
        }
        params.push(toSQLiteValue(value));
        return `${jsonPath} != ?`;
      case '$gt':
        params.push(toSQLiteValue(value));
        return `${jsonPath} > ?`;
      case '$gte':
        params.push(toSQLiteValue(value));
        return `${jsonPath} >= ?`;
      case '$lt':
        params.push(toSQLiteValue(value));
        return `${jsonPath} < ?`;
      case '$lte':
        params.push(toSQLiteValue(value));
        return `${jsonPath} <= ?`;
      case '$exists':
        return value ? `${jsonPath} IS NOT NULL` : `${jsonPath} IS NULL`;
      case '$in':
        if (Array.isArray(value) && value.length > 0) {
          const conditions = value.map(() => `${jsonPath} = ?`).join(' OR ');
          params.push(...value.map((v) => toSQLiteValue(v)));
          return `(${conditions})`;
        }
        return '1=0'; // Empty array, nothing matches
      case '$nin':
        if (Array.isArray(value) && value.length > 0) {
          const conditions = value.map(() => `${jsonPath} != ?`).join(' AND ');
          params.push(...value.map((v) => toSQLiteValue(v)));
          return `(${conditions})`;
        }
        return '1=1'; // Empty array, everything matches
      default:
        return '1=0'; // Unsupported operator
    }
  }

  /**
   * Builds a subquery for array operations like $all and $elemMatch
   */
  private buildArraySubquery(
    field: string,
    operator: string,
    value: unknown,
    params: unknown[]
  ): string {
    const arrayPath = this.parseJsonPath(field);
    const arrayTypeCheck = `json_type(json_extract(data, ${arrayPath})) = 'array'`;

    if (operator === '$all') {
      if (Array.isArray(value) && value.length > 0) {
        const allConditions = value
          .map((item) => {
            params.push(item);
            return `EXISTS (SELECT 1 FROM json_each(json_extract(data, ${arrayPath})) WHERE json_each.value = ?)`;
          })
          .join(' AND ');
        return `(${arrayTypeCheck} AND ${allConditions})`;
      }
      return '1=0'; // Empty $all array, nothing matches
    } else if (operator === '$elemMatch') {
      let elemMatchSubquery = `EXISTS (
        SELECT 1 
        FROM json_each(json_extract(data, ${arrayPath})) as array_elements 
        WHERE `;

      if (typeof value === 'object' && value !== null) {
        const conditions = this.buildObjectConditions(value, params, 'array_elements');
        elemMatchSubquery += conditions;
      } else {
        // Simple equality check for the entire element
        params.push(value);
        elemMatchSubquery += `array_elements.value = ?`;
      }

      elemMatchSubquery += ')';
      return `${arrayTypeCheck} AND ${elemMatchSubquery}`;
    }

    return '1=0'; // Unsupported array operator
  }

  /**
   * Builds conditions for an object with potentially nested operators
   */
  private buildObjectConditions(
    obj: object,
    params: unknown[],
    elementPrefix: string = 'data'
  ): string {
    const conditions: string[] = [];

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Check if this is an operator object
        const operatorKeys = Object.keys(value);
        const isOperatorObject = operatorKeys.every((k) => k.startsWith('$'));

        if (isOperatorObject) {
          // This is an object with operators like { age: { $gt: 30 } }
          const opConditions = operatorKeys.map((op) =>
            this.buildComparisonCondition(key, op, value[op], params, elementPrefix)
          );
          conditions.push(`(${opConditions.join(' AND ')})`);
        } else {
          // This is a nested object, handle recursively
          // In this implementation, we'd need to handle dot notation
          // which might require more complex logic
          conditions.push('1=0'); // Placeholder for nested object handling
        }
      } else {
        // Simple equality
        conditions.push(this.buildComparisonCondition(key, '$eq', value, params, elementPrefix));
      }
    }

    return conditions.length > 0 ? conditions.join(' AND ') : '1=1';
  }

  private buildWhereClause(filter: Filter<T>, params: unknown[]): string {
    const conditions: string[] = [];

    for (const key of Object.keys(filter)) {
      const value = filter[key as keyof Filter<T>];

      // Handle logical operators
      if (key === '$and' && filter.$and) {
        const andConditions = filter.$and
          .map((subFilter) => `(${this.buildWhereClause(subFilter, params)})`)
          .join(' AND ');
        conditions.push(`(${andConditions})`);
      } else if (key === '$or' && filter.$or) {
        const orConditions = filter.$or
          .map((subFilter) => `(${this.buildWhereClause(subFilter, params)})`)
          .join(' OR ');
        conditions.push(`(${orConditions})`);
      } else if (key === '$nor' && filter.$nor) {
        const norConditions = filter.$nor
          .map((subFilter) => `(${this.buildWhereClause(subFilter, params)})`)
          .join(' OR ');
        conditions.push(`NOT (${norConditions})`);
      } else if (key === '$not' && filter.$not) {
        // Create a nested filter with the $not contents
        const nestedFilter = {
          [Object.keys(filter.$not)[0]]: filter.$not[Object.keys(filter.$not)[0]],
        } as Filter<T>;
        const notClause = this.buildWhereClause(nestedFilter, params);
        conditions.push(`NOT (${notClause})`);
      }
      // Handle text search
      else if (key === '$text' && filter.$text) {
        const textSearch = filter.$text as import('../types.js').TextSearchOperator;
        const search = textSearch.$search;
        if (typeof search === 'string' && search.trim() !== '') {
          conditions.push(`data LIKE ?`);
          params.push(`%${search}%`); // Simple LIKE search
        } else {
          conditions.push('1=0'); // No valid search term, nothing matches
        }
      }
      // Handle field existence checks
      else if (key === '$exists' && filter.$exists) {
        const existsConditions = Object.entries(filter.$exists)
          .map(([field, exists]) => this.buildComparisonCondition(field, '$exists', exists, params))
          .join(' AND ');
        conditions.push(`(${existsConditions})`);
      }
      // Handle array operations
      else if ((key === '$all' || key === '$elemMatch') && filter[key]) {
        const arrayConditions = Object.entries(filter[key])
          .map(([field, value]) => this.buildArraySubquery(field, key, value, params))
          .join(' AND ');
        conditions.push(`(${arrayConditions})`);
      }
      // Handle regular field conditions
      else if (!key.startsWith('$')) {
        // It's a field path
        if (key === '_id') {
          if (typeof value === 'string') {
            conditions.push(this.buildComparisonCondition('_id', '$eq', value, params));
          } else if (typeof value === 'object' && value !== null) {
            // Handle operators on _id
            const opConditions = Object.entries(value)
              .map(([op, opValue]) => this.buildComparisonCondition('_id', op, opValue, params))
              .join(' AND ');
            conditions.push(`(${opConditions})`);
          }
        } else {
          // Regular field with JSON path
          if (value instanceof Date) {
            // Handle Date objects for simple equality
            const jsonPath = this.parseJsonPath(key);
            conditions.push(`json_extract(data, ${jsonPath}) = ?`);
            params.push(toSQLiteValue(value));
          } else if (typeof value === 'object' && value !== null) {
            // Check if any key is an operator
            const hasOperators = Object.keys(value).some((k) => k.startsWith('$'));

            if (hasOperators) {
              // Handle operators for this field
              const opConditions = Object.entries(value)
                .map(([op, opValue]) => {
                  if (op === '$elemMatch' || op === '$all') {
                    return this.buildArraySubquery(key, op, opValue, params);
                  }
                  return this.buildComparisonCondition(key, op, opValue, params);
                })
                .join(' AND ');
              conditions.push(`(${opConditions})`);
            } else {
              // This is an object equality check (exact match)
              const jsonPath = this.parseJsonPath(key);
              conditions.push(`json_extract(data, ${jsonPath}) = ?`);
              params.push(JSON.stringify(value));
            }
          } else {
            // Simple equality check
            conditions.push(this.buildComparisonCondition(key, '$eq', value, params));
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

    if (this.options.verbose) {
      console.log(`Building SQL query for collection "${this.collectionName}"`);
      console.log(`Filter: ${JSON.stringify(filter)}`);
      console.log(`Where Clause: ${whereClause}`);
      console.log(`SQL Query: ${sql}`);
      console.log(`Parameters: ${JSON.stringify(params)}`);
    }
    return { sql, params };
  }

  /**
   * Specifies the maximum number of documents the cursor will return.
   * @param count The number of documents to limit to.
   * @returns The `FindCursor` instance for chaining.
   */
  public limit(count: number): this {
    if (count < 0) throw new Error('Limit must be a non-negative number.');
    this.limitCount = count;
    return this;
  }

  /**
   * Specifies the number of documents to skip.
   * @param count The number of documents to skip.
   * @returns The `FindCursor` instance for chaining.
   */
  public skip(count: number): this {
    if (count < 0) throw new Error('Skip must be a non-negative number.');
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
      if (
        this.projectionFields[key as keyof T] === 1 ||
        this.projectionFields[key as keyof T] === true
      ) {
        hasExplicitInclusion = true;
        break;
      }
      if (
        this.projectionFields[key as keyof T] === 0 ||
        this.projectionFields[key as keyof T] === false
      ) {
        includeMode = false;
        // No break here, need to check all for explicit inclusions if _id is also 0
      }
    }

    if (
      (this.projectionFields._id === 0 || this.projectionFields._id === false) &&
      !hasExplicitInclusion
    ) {
      // If _id is excluded and no other fields are explicitly included,
      // it's an exclusion projection where other fields are implicitly included.
      includeMode = false;
    } else if (hasExplicitInclusion) {
      includeMode = true;
    }

    if (includeMode) {
      // Inclusion mode
      for (const key in this.projectionFields) {
        if (
          this.projectionFields[key as keyof T] === 1 ||
          this.projectionFields[key as keyof T] === true
        ) {
          if (key.includes('.')) {
            // Handle nested paths for inclusion (basic implementation)
            const path = key.split('.');
            let current = doc as Record<string, unknown>;
            let target = projectedDoc as Record<string, unknown>;

            // Navigate to the last parent in the path
            for (let i = 0; i < path.length - 1; i++) {
              const segment = path[i];
              if (current[segment] === undefined || current[segment] === null) break;

              if (target[segment] === undefined) {
                target[segment] = {};
              }

              current = current[segment] as Record<string, unknown>;
              target = target[segment] as Record<string, unknown>;
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
      if (this.projectionFields._id !== 0 && this.projectionFields._id !== false && '_id' in doc) {
        projectedDoc._id = doc._id;
      }
    } else {
      // Exclusion mode
      Object.assign(projectedDoc, doc);
      for (const key in this.projectionFields) {
        if (
          this.projectionFields[key as keyof T] === 0 ||
          this.projectionFields[key as keyof T] === false
        ) {
          if (key.includes('.')) {
            // Handle nested paths for exclusion (basic implementation)
            const path = key.split('.');
            let current = projectedDoc as Record<string, unknown>;

            // Navigate to the parent of the property to exclude
            for (let i = 0; i < path.length - 1; i++) {
              const segment = path[i];
              if (current[segment] === undefined) break;
              current = current[segment] as Record<string, unknown>;
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
      const sortClauses = Object.entries(this.sortCriteria).map(([field, order]) => {
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

    // Handle malformed json in the database
    const rows = await this.db.all<SQLiteRow>(finalSql, finalParams);
    return rows.map((row) => {
      const parsedData = safeJsonParse(row.data, `findCursor toArray for document ${row._id}`);
      const restoredData = restoreDates(parsedData) as Record<string, unknown>;
      const doc = { _id: row._id, ...restoredData } as T;
      return this.applyProjection(doc);
    });
  }

  /**
   *  Executes the query and returns the first matching document.
   *  @returns A promise that resolves to the first matching document or null if no matches are found.
   *  @throws Error if the query fails.
   */
  public async first(): Promise<Partial<T> | null> {
    const results = await this.limit(1).toArray();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Executes the query and returns a count of matching documents.
   * @returns A promise that resolves to the count of matching documents.
   */
  public async count(): Promise<number> {
    const whereClause = this.buildWhereClause({}, []);
    const countSql = `SELECT COUNT(*) as count FROM "${this.collectionName}" WHERE ${whereClause}`;
    const result = await this.db.get<{ count: number }>(countSql);
    return result?.count ?? 0; // Return 0 if result is undefined
  }
}
