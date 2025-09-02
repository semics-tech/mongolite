/**
 * Represents a document with an optional _id field.
 */
export interface DocumentWithId {
  _id?: string;
  [key: string]: unknown;
}

/**
 * Result of insertOne operation.
 */
export interface InsertOneResult {
  acknowledged: boolean;
  insertedId: string;
}

/**
 * Result of updateOne operation.
 */
export interface UpdateResult {
  acknowledged: boolean;
  matchedCount: number;
  modifiedCount: number;
  upsertedId: string | null;
}

/**
 * Result of deleteOne/deleteMany operations.
 */
export interface DeleteResult {
  acknowledged: boolean;
  deletedCount: number;
}

/**
 * Operators for filtering documents.
 * T is the type of the field being queried.
 */
export interface QueryOperators<T> {
  $eq?: T;
  $ne?: T;
  $gt?: T;
  $gte?: T;
  $lt?: T;
  $lte?: T;
  $in?: T[];
  $nin?: T[];
  $all?: T extends unknown[] ? T : never;
  $exists?: boolean;
  $not?: QueryOperators<T>;
}

/**
 * Logical filter operators.
 */
export interface LogicalOperators<T> {
  $and?: Filter<T>[];
  $or?: Filter<T>[];
  $nor?: Filter<T>[];
}

/**
 * Text search operator for full-text search.
 */
export interface TextSearchOperator {
  $search: string;
}

/**
 * Filter type for querying documents.
 * T is the document type.
 */
export type Filter<T> = {
  [P in keyof T]?: T[P] | QueryOperators<T[P]>;
} & {
  [key: string]: unknown; // For dot notation and nested fields
} & Partial<LogicalOperators<T>> & {
    $text?: TextSearchOperator; // Add text search operator
  };

/**
 * Operators for updating documents.
 * T is the document type.
 */
export interface UpdateOperators<T> {
  $set?: {
    [P in keyof T]?: T[P];
  } & {
    [key: string]: unknown; // For dot notation and nested fields
  };
  $unset?: {
    [P in keyof T]?: '';
  } & {
    [key: string]: '';
  };
  $inc?: {
    [P in keyof T]?: number;
  } & {
    [key: string]: number;
  };
  $push?: {
    [P in keyof T]?: unknown | { $each: unknown[] };
  } & {
    [key: string]: unknown | { $each: unknown[] };
  };
  $pull?: {
    [P in keyof T]?: unknown;
  } & {
    [key: string]: unknown;
  };
}

/**
 * UpdateFilter type for updating documents.
 */
export type UpdateFilter<T> = Partial<UpdateOperators<T>>;

/**
 * SortCriteria type for sorting documents.
 */
export type SortCriteria<T> = {
  [P in keyof T]?: 1 | -1;
} & {
  [key: string]: 1 | -1; // For dot notation and nested fields
};

/**
 * Projection type for selecting fields.
 */
export type Projection<T> = {
  [P in keyof T]?: 0 | 1 | boolean;
} & {
  [key: string]: 0 | 1 | boolean; // For dot notation and nested fields
};

/** * Represents a row in the SQLite database.
 * The data field is a JSON string representing the document.
 */
export interface SQLiteRow {
  _id: string;
  data: string; // JSON string
}

/**
 * Index specification type.
 * Specifies fields to index and their sort order (1 for ascending, -1 for descending).
 */
export type IndexSpecification = {
  [key: string]: 1 | -1 | string;
};

/**
 * Options for createIndex.
 */
export interface CreateIndexOptions {
  /**
   * Unique index flag. If true, the index will enforce uniqueness of the indexed field.
   */
  unique?: boolean;

  /**
   * Name of the index. If not specified, a name will be generated.
   */
  name?: string;

  /**
   * If true, create the index in the background and don't block other operations.
   * In SQLite this might not make a significant difference.
   */
  background?: boolean;

  /**
   * If true, MongoDB will ignore any duplicate values when creating a unique index.
   * Not directly applicable to SQLite, but retained for API compatibility.
   */
  sparse?: boolean;
}

/**
 * Result of createIndex operation.
 */
export interface CreateIndexResult {
  /**
   * Indicates whether the index creation operation was acknowledged.
   */
  acknowledged: boolean;

  /**
   * The name of the created index.
   */
  name: string;
}

/**
 * Result of dropIndex operation.
 */
export interface DropIndexResult {
  /**
   * Indicates whether the index deletion operation was acknowledged.
   */
  acknowledged: boolean;

  /**
   * The name of the dropped index.
   */
  name: string;
}

/**
 * Result of a listIndexes operation.
 */
export interface IndexInfo {
  /**
   * Name of the index.
   */
  name: string;

  /**
   * The fields this index is defined on.
   */
  key: { [key: string]: number };

  /**
   * Whether this index enforces uniqueness.
   */
  unique?: boolean;
}
