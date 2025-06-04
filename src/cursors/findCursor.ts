import {
  DocumentWithId,
  Filter,
  QueryOperators,
  SortCriteria,
  Projection,
  SQLiteRow,
} from '../types.js';
import { SQLiteDB } from '../db.js';

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

  private buildWhereClause(filter: Filter<T>, params: unknown[]): string {
    const conditions: string[] = [];

    // Handle $and, $or, $nor logical operators at the top level
    for (const key of Object.keys(filter)) {
      if (key === '$and' && filter.$and) {
        const condition = filter.$and;
        const andConditions = condition
          .map((subFilter) => `(${this.buildWhereClause(subFilter, params)})`)
          .join(' AND ');
        conditions.push(`(${andConditions})`);
      } else if (key === '$or' && filter.$or) {
        const condition = filter.$or;
        const orConditions = condition
          .map((subFilter) => `(${this.buildWhereClause(subFilter, params)})`)
          .join(' OR ');
        conditions.push(`(${orConditions})`);
      } else if (key === '$nor' && filter.$nor) {
        const condition = filter.$nor;
        const norConditions = condition
          .map((subFilter) => `(${this.buildWhereClause(subFilter, params)})`)
          .join(' OR ');
        conditions.push(`NOT (${norConditions})`);
      } else if (key === '$text' && filter.$text) {
        // Handle text search (basic implementation)
        const search = filter.$text.$search;
        if (typeof search === 'string' && search.trim() !== '') {
          conditions.push(`data LIKE ?`);
          params.push(`%${search}%`); // Simple LIKE search
        } else {
          conditions.push('1=0'); // No valid search term, nothing matches
        }
      } else if (key === '$exists' && filter.$exists) {
        // Handle existence check
        const existsConditions = Object.entries(filter.$exists)
          .map(([field, exists]) => {
            const jsonPath = this.parseJsonPath(field);
            if (exists) {
              return `json_extract(data, ${jsonPath}) IS NOT NULL`;
            } else {
              return `json_extract(data, ${jsonPath}) IS NULL`;
            }
          })
          .join(' AND ');
        conditions.push(`(${existsConditions})`);
      } else if (key === '$not' && filter.$not) {
        // Handle negation of conditions
        const notConditions = filter.$not;
        const notClause = this.buildWhereClause(notConditions, params);
        conditions.push(`NOT (${notClause})`);
      } else if (key === '$all' && filter.$all) {
        // Handle array all match
        const allConditions = Object.entries(filter.$all)
          .map(([field, values]) => {
            const arrayPath = this.parseJsonPath(field);
            if (Array.isArray(values) && values.length > 0) {
              const inConditions = values
                .map(() => `json_extract(data, ${arrayPath}) = ?`)
                .join(' AND ');
              params.push(...values);
              return `(${inConditions})`;
            } else {
              return '1=0'; // Empty $all means nothing matches
            }
          })
          .join(' AND ');
        conditions.push(`(${allConditions})`);
      } else if (key === '$elemMatch' && filter.$elemMatch) {
        // Handle array element match
        const elemMatchConditions = Object.entries(filter.$elemMatch)
          .map(([field, subFilter]) => {
            const arrayPath = this.parseJsonPath(field);

            // First check if the field exists and is an array
            const checkArrayCondition = `json_type(json_extract(data, ${arrayPath})) = 'array'`;

            // Use a subquery with json_each to find at least one array element matching all conditions
            let elemMatchSubquery = `EXISTS (
              SELECT 1 FROM json_each(json_extract(data, ${arrayPath})) as elements
              WHERE `;

            // Process the conditions for the array elements
            if (typeof subFilter === 'object' && subFilter !== null) {
              const elemConditions = Object.entries(subFilter)
                .map(([subField, subValue]) => {
                  if (typeof subValue === 'object' && subValue !== null) {
                    // Handle operators in the subfilter
                    const subConditions: string[] = [];
                    for (const op in subValue) {
                      const opValue = subValue[op];
                      switch (op) {
                        case '$eq':
                          subConditions.push(`json_extract(elements.value, '$.${subField}') = ?`);
                          params.push(opValue);
                          break;
                        case '$gt':
                          subConditions.push(`json_extract(elements.value, '$.${subField}') > ?`);
                          params.push(opValue);
                          break;
                        case '$gte':
                          subConditions.push(`json_extract(elements.value, '$.${subField}') >= ?`);
                          params.push(opValue);
                          break;
                        case '$lt':
                          subConditions.push(`json_extract(elements.value, '$.${subField}') < ?`);
                          params.push(opValue);
                          break;
                        case '$lte':
                          subConditions.push(`json_extract(elements.value, '$.${subField}') <= ?`);
                          params.push(opValue);
                          break;
                        // Add other operators as needed
                      }
                    }
                    return subConditions.join(' AND ');
                  } else {
                    // Simple equality for direct value
                    params.push(subValue);
                    return `json_extract(elements.value, '$.${subField}') = ?`;
                  }
                })
                .join(' AND ');

              elemMatchSubquery += elemConditions;
            } else {
              // Simple equality check for the entire element
              params.push(subFilter);
              elemMatchSubquery += `elements.value = ?`;
            }

            elemMatchSubquery += ')';

            return `${checkArrayCondition} AND ${elemMatchSubquery}`;
          })
          .join(' AND ');

        conditions.push(`(${elemMatchConditions})`);
      } else {
        // Handle field conditions
        if (key.startsWith('$')) continue; // Skip logical operators already handled

        const value = filter[key as keyof Filter<T>];
        if (key === '_id') {
          if (typeof value === 'string') {
            conditions.push('_id = ?');
            params.push(value);
          } else if (
            typeof value === 'object' &&
            value !== null &&
            (value as QueryOperators<string>).$in
          ) {
            const inValues = (value as QueryOperators<string>).$in as string[];
            if (inValues.length > 0) {
              conditions.push(`_id IN (${inValues.map(() => '?').join(',')})`);
              params.push(...inValues);
            } else {
              conditions.push('1=0'); // No values in $in means nothing matches
            }
          } else if (
            typeof value === 'object' &&
            value !== null &&
            (value as QueryOperators<string>).$ne
          ) {
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
                  conditions.push(`json_extract(data, ${jsonPath}) = ?`);
                  params.push(opValue);
                  break;
                case '$ne':
                  if (opValue === null) {
                    conditions.push(`json_extract(data, ${jsonPath}) IS NOT NULL`);
                  } else {
                    conditions.push(`json_extract(data, ${jsonPath}) != ?`);
                    params.push(opValue);
                  }
                  break;
                case '$gt':
                  conditions.push(`json_extract(data, ${jsonPath}) > ?`);
                  params.push(opValue);
                  break;
                case '$gte':
                  conditions.push(`json_extract(data, ${jsonPath}) >= ?`);
                  params.push(opValue);
                  break;
                case '$lt':
                  conditions.push(`json_extract(data, ${jsonPath}) < ?`);
                  params.push(opValue);
                  break;
                case '$lte':
                  conditions.push(`json_extract(data, ${jsonPath}) <= ?`);
                  params.push(opValue);
                  break;
                case '$in':
                  if (Array.isArray(opValue) && opValue.length > 0) {
                    const inConditions = opValue
                      .map(() => `json_extract(data, ${jsonPath}) = ?`)
                      .join(' OR ');
                    conditions.push(`(${inConditions})`);
                    opValue.forEach((val) => params.push(val));
                  } else {
                    conditions.push('1=0'); // Empty $in array, nothing will match
                  }
                  break;
                case '$nin':
                  if (Array.isArray(opValue) && opValue.length > 0) {
                    const ninConditions = opValue
                      .map(() => `json_extract(data, ${jsonPath}) != ?`)
                      .join(' AND ');
                    conditions.push(`(${ninConditions})`);
                    opValue.forEach((val) => params.push(val));
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
                case '$not':
                  // Handle negation of conditions
                  const notCondition = this.buildWhereClause(
                    { [key]: opValue } as Filter<T>,
                    params
                  );
                  conditions.push(`NOT (${notCondition})`);
                  break;
                case '$all':
                  if (Array.isArray(opValue) && opValue.length > 0) {
                    // Check if the field is an array
                    const arrayTypeCheck = `json_type(json_extract(data, ${jsonPath})) = 'array'`;

                    // For each value in the $all array, create a subquery to check if it exists in the array
                    const allConditions = opValue
                      .map(() => {
                        return `EXISTS (SELECT 1 FROM json_each(json_extract(data, ${jsonPath})) WHERE json_each.value = ?)`;
                      })
                      .join(' AND ');

                    conditions.push(`(${arrayTypeCheck} AND ${allConditions})`);
                    opValue.forEach((val) => params.push(val));
                  } else {
                    conditions.push('1=0'); // Empty $all array, nothing will match
                  }
                  break;
                case '$elemMatch':
                  // Handle array element match
                  // For nested.items we need to check for conditions on the same array element
                  // Build a query that checks if there's at least one array element that satisfies all conditions
                  const arrayPath = this.parseJsonPath(key);
                  let elemMatchSubquery = `EXISTS (
                    SELECT 1 
                    FROM json_each(json_extract(data, ${arrayPath})) as array_elements 
                    WHERE `;

                  // Process each condition in the $elemMatch
                  if (typeof opValue === 'object' && opValue !== null) {
                    const subConditions = Object.entries(opValue)
                      .map(([sfKey, sfValue]) => {
                        if (typeof sfValue === 'object' && sfValue !== null) {
                          // Handle operators in the subfilter
                          const subOpConditions: string[] = [];
                          for (const op in sfValue) {
                            const opVal = sfValue[op as keyof QueryOperators<any>];
                            switch (op) {
                              case '$eq':
                                subOpConditions.push(
                                  `json_extract(array_elements.value, '$.${sfKey}') = ?`
                                );
                                params.push(opVal);
                                break;
                              case '$gt':
                                subOpConditions.push(
                                  `json_extract(array_elements.value, '$.${sfKey}') > ?`
                                );
                                params.push(opVal);
                                break;
                              case '$gte':
                                subOpConditions.push(
                                  `json_extract(array_elements.value, '$.${sfKey}') >= ?`
                                );
                                params.push(opVal);
                                break;
                              case '$lt':
                                subOpConditions.push(
                                  `json_extract(array_elements.value, '$.${sfKey}') < ?`
                                );
                                params.push(opVal);
                                break;
                              case '$lte':
                                subOpConditions.push(
                                  `json_extract(array_elements.value, '$.${sfKey}') <= ?`
                                );
                                params.push(opVal);
                                break;
                              // Add other operators as needed
                            }
                          }
                          return subOpConditions.join(' AND ');
                        } else {
                          // Simple equality for direct value
                          params.push(sfValue);
                          return `json_extract(array_elements.value, '$.${sfKey}') = ?`;
                        }
                      })
                      .join(' AND ');

                    elemMatchSubquery += subConditions;
                  } else {
                    // Simple equality check for the entire element
                    params.push(opValue);
                    elemMatchSubquery += `array_elements.value = ?`;
                  }

                  elemMatchSubquery += ')';
                  conditions.push(elemMatchSubquery);
                  break;
                // Add other operators as needed
              }
            }
          } else {
            // Direct equality for non-object values
            if (value === null) {
              conditions.push(`json_extract(data, ${jsonPath}) IS NULL`);
            } else {
              conditions.push(`json_extract(data, ${jsonPath}) = ?`);
              params.push(value);
            }
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

    const rows = await this.db.all<SQLiteRow>(finalSql, finalParams);
    return rows.map((row) => {
      const doc = { _id: row._id, ...JSON.parse(row.data) } as T;
      return this.applyProjection(doc);
    });
  }
}
