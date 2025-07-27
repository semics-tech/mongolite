# MongoLite

[![CI](https://github.com/semics-tech/mongolite/actions/workflows/ci.yml/badge.svg)](https://github.com/semics-tech/mongolite/actions/workflows/ci.yml)
[![NPM version](https://img.shields.io/npm/v/mongolite-ts.svg)](https://www.npmjs.com/package/mongolite-ts)
[![Codecov](https://codecov.io/gh/semics-tech/mongolite/branch/master/graph/badge.svg)](https://codecov.io/gh/semics-tech/mongolite)

A MongoDB-like client that uses SQLite as its underlying persistent store. Written in TypeScript, this package provides a familiar API for developers accustomed to MongoDB, while leveraging the simplicity and file-based nature of SQLite. It supports basic CRUD operations and JSON querying capabilities.

## Features

* MongoDB-like API (`insertOne`, `findOne`, `updateOne`, `deleteOne`, etc.)
* SQLite backend for persistence.
* Automatic `_id` (UUID) generation and indexing.
* Support for Write Ahead Logging (WAL) mode for better concurrency.
* Support for querying JSON fields.
* Written in TypeScript with strong typing.
* 100% test coverage (aiming for).

## Installation

```bash
npm install mongolite-ts
# or
yarn add mongolite-ts
```

## Usage

```typescript
import { MongoLite } from 'mongolite-ts';
import path from 'path';

interface User {
  _id?: string;
  name: string;
  age: number;
  email: string;
  address?: {
    street: string;
    city: string;
  };
  hobbies?: string[];
}

async function main() {
  // Initialize the client.
  // You can use ':memory:' for an in-memory database, or provide a file path.
  const dbPath = path.join(__dirname, 'mydatabase.sqlite');
  const client = new MongoLite(dbPath);

  try {
    // Connect to the database (optional, operations will auto-connect)
    await client.connect();
    console.log('Connected to SQLite database.');

    // Get a collection (equivalent to a table)
    const usersCollection = client.collection<User>('users');

    // Insert a document
    const insertResult = await usersCollection.insertOne({
      name: 'Alice Wonderland',
      age: 30,
      email: 'alice@example.com',
      address: { street: '123 Main St', city: 'Anytown' },
      hobbies: ['reading', 'coding']
    });
    console.log('Inserted user:', insertResult);
    const userId = insertResult.insertedId;

    // Find a document
    const foundUser = await usersCollection.findOne({ _id: userId });
    console.log('Found user by ID:', foundUser);

    const foundUserByEmail = await usersCollection.findOne({ email: 'alice@example.com' });
    console.log('Found user by email:', foundUserByEmail);

    // Find with nested query
    const foundUserByCity = await usersCollection.findOne({ 'address.city': 'Anytown' });
    console.log('Found user by city:', foundUserByCity);

    // Find with operator ($gt)
    const olderUsers = await usersCollection.find({ age: { $gt: 25 } }).toArray();
    console.log('Users older than 25:', olderUsers);


    // Update a document
    const updateResult = await usersCollection.updateOne(
      { _id: userId },
      { $set: { age: 31, 'address.street': '456 New St' }, $push: { hobbies: 'gardening' } }
    );
    console.log('Update result:', updateResult);

    const updatedUser = await usersCollection.findOne({ _id: userId });
    console.log('Updated user:', updatedUser);

    // Delete a document
    const deleteResult = await usersCollection.deleteOne({ _id: userId });
    console.log('Delete result:', deleteResult);

    const notFoundUser = await usersCollection.findOne({ _id: userId });
    console.log('User after deletion (should be null):', notFoundUser);

  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    // Close the database connection when done
    await client.close();
    console.log('Database connection closed.');
  }
}

main();
```

## API

### `MongoLite`

#### `constructor(dbPathOrOptions: string | MongoLiteOptions)`

Creates a new `MongoLite` client instance.

* `dbPathOrOptions`: Either a string path to the SQLite database file (e.g., `'./mydb.sqlite'`, `':memory:'`) or an options object.
    * `MongoLiteOptions`:
        * `filePath`: string - Path to the SQLite database file.
        * `verbose?`: boolean - (Optional) Enable verbose logging from the `sqlite3` driver.

#### `async connect(): Promise<void>`

Explicitly opens the database connection. Operations will automatically connect if the DB is not already open.

#### `async close(): Promise<void>`

Closes the database connection.

#### `listCollections(): Promise<string[]>`

Lists all collections (tables) in the database.

```typescript
// Get all collections
const collections = await client.listCollections().toArray();
console.log('Available collections:', collections);
```

#### `collection<T extends DocumentWithId = DocumentWithId>(name: string): MongoLiteCollection<T>`

Gets a reference to a collection (table).

* `name`: The name of the collection.
* Returns a `MongoLiteCollection` instance.

### `MongoLiteCollection<T extends DocumentWithId>`

Represents a collection and provides methods to interact with its documents. `T` is a generic type for your document structure, which must extend `DocumentWithId` (i.e., have an optional `_id: string` field).

#### `async insertOne(doc: Omit<T, '_id'> & { _id?: string }): Promise<InsertOneResult>`

Inserts a single document into the collection. If `_id` is not provided, a UUID will be generated.

* `doc`: The document to insert.
* Returns `InsertOneResult`: `{ acknowledged: boolean; insertedId: string; }`.

#### `async findOne(filter: Filter<T>): Promise<T | null>`

Finds a single document matching the filter.

* `filter`: The query criteria. Supports direct field matching (e.g., `{ name: 'Alice' }`) and nested field matching using dot notation (e.g., `{ 'address.city': 'Anytown' }`). Also supports operators like `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`.
* Returns the found document or `null`.

#### `find(filter: Filter<T>): FindCursor<T>`

Finds multiple documents matching the filter and returns a cursor.

* `filter`: The query criteria.
* Returns a `FindCursor` instance.

#### `async updateOne(filter: Filter<T>, update: UpdateFilter<T>): Promise<UpdateResult>`

Updates a single document matching the filter.

* `filter`: The selection criteria for the update.
* `update`: The modifications to apply. Supports operators like `$set`, `$unset`, `$inc`, `$push`, `$pull`.
* Returns `UpdateResult`: `{ acknowledged: boolean; matchedCount: number; modifiedCount: number; upsertedId: string | null; }`.

#### `async deleteOne(filter: Filter<T>): Promise<DeleteResult>`

Deletes a single document matching the filter.

* `filter`: The selection criteria for the deletion.
* Returns `DeleteResult`: `{ acknowledged: boolean; deletedCount: number; }`.


### `FindCursor<T>`

#### `async toArray(): Promise<T[]>`

Fetches all documents matching the cursor's query into an array.

#### `limit(count: number): FindCursor<T>`

Specifies the maximum number of documents the cursor will return.

#### `skip(count: number): FindCursor<T>`

Specifies the number of documents to skip.

#### `sort(sortCriteria: SortCriteria<T>): FindCursor<T>`

Specifies the sorting order.
* `sortCriteria`: An object where keys are field paths (dot notation for nested fields) and values are `1` (ascending) or `-1` (descending). Example: `{ 'age': -1, 'name': 1 }`.

## Query Operators

The `filter` parameter in `findOne`, `find`, `updateOne`, and `deleteOne` supports the following:

### Comparison Operators

* `{ field: value }` or `{ field: { $eq: value } }`: Matches documents where `field` equals `value`.
* `{ field: { $ne: value } }`: Matches documents where `field` does not equal `value`.
* `{ field: { $gt: value } }`: Matches documents where `field` is greater than `value`.
* `{ field: { $gte: value } }`: Matches documents where `field` is greater than or equal to `value`.
* `{ field: { $lt: value } }`: Matches documents where `field` is less than `value`.
* `{ field: { $lte: value } }`: Matches documents where `field` is less than or equal to `value`.
* `{ field: { $in: [value1, value2, ...] } }`: Matches documents where `field` is one of the specified values.
* `{ field: { $nin: [value1, value2, ...] } }`: Matches documents where `field` is not one of the specified values.

### Logical Operators (Top-Level Only for now)

* `{ $and: [filter1, filter2, ...] }`: Joins query clauses with a logical AND.
* `{ $or: [filter1, filter2, ...] }`: Joins query clauses with a logical OR.
* `{ $nor: [filter1, filter2, ...] }`: Joins query clauses with a logical NOR.
* `{ $not: filter }`: Inverts the effect of a query expression. (Applied to a single operator expression, e.g., `{ age: { $not: { $gt: 30 } } }`)

### Element Operators

* `{ field: { $exists: boolean } }`: Matches documents that have (or do not have) the specified field.

## Update Operators

The `update` parameter in `updateOne` supports the following:

* `{ $set: { field1: value1, ... } }`: Sets the value of specified fields.
* `{ $unset: { field1: "", ... } }`: Removes specified fields from documents.
* `{ $inc: { field1: amount1, ... } }`: Increments the value of specified fields by a certain amount.
* `{ $push: { arrayField: valueOrModifier, ... } }`: Appends a value to an array. Can use with `$each`.
    * `{ $push: { scores: 89 } }`
    * `{ $push: { scores: { $each: [90, 92, 85] } } }`
* `{ $pull: { arrayField: valueOrCondition, ... } }`: Removes all instances of a value or values that match a condition from an array.
    * `{ $pull: { scores: 0 } }`
    * `{ $pull: { items: { id: { $in: [1, 2] } } } }` (More complex conditions for $pull might be limited initially)
#### `async createIndex(fieldOrSpec: string | IndexSpecification, options?: CreateIndexOptions): Promise<CreateIndexResult>`

Creates an index on the specified field(s) of the collection.

* `fieldOrSpec`: Either a string field name or an index specification object (e.g., `{ name: 1, age: -1 }`).
* `options`: Optional settings for the index creation.
  * `unique`: If `true`, the index will enforce uniqueness of the indexed field.
  * `name`: Custom name for the index. If not provided, a name will be generated automatically.
  * `background`: If `true`, creates the index in the background (in SQLite, this might not have a significant effect).
  * `sparse`: If `true`, ignores documents that don't have the indexed field (for MongoDB compatibility).
* Returns `CreateIndexResult`: `{ acknowledged: boolean; name: string; }`.

```typescript
// Create a simple index on the "name" field
await usersCollection.createIndex({ name: 1 });

// Create a unique index on the "email" field
await usersCollection.createIndex({ email: 1 }, { unique: true });

// Create a compound index on multiple fields
await usersCollection.createIndex({ name: 1, age: -1 });

// You can even create an index on a nested field
await usersCollection.createIndex({ 'address.city': 1 });
```

#### `listIndexes(): { toArray: () => Promise<IndexInfo[]> }`

Lists all indexes on the collection.

* Returns an object with a `toArray()` method that resolves to an array of `IndexInfo` objects.
  * Each `IndexInfo` contains: `name` (string), `key` (object mapping field names to sort direction), and `unique` (boolean).

```typescript
const indexes = await usersCollection.listIndexes().toArray();
console.log('Available indexes:', indexes);
```

#### `async dropIndex(indexName: string): Promise<DropIndexResult>`

Drops a specified index from the collection.

* `indexName`: The name of the index to drop.
* Returns `DropIndexResult`: `{ acknowledged: boolean; name: string; }`.

#### `async dropIndexes(): Promise<{ acknowledged: boolean; droppedCount: number }>`

Drops all indexes from the collection, except for the index on _id.

* Returns an object with `acknowledged` (boolean) and `droppedCount` (number) indicating how many indexes were dropped.

## Performance Benchmarks

*Last updated: 2025-07-27*

### Operation Performance

| Operation | Records Tested | Duration (ms) | Ops/Second | Avg Time/Op (ms) |
|-----------|----------------|---------------|------------|------------------|
| INSERT_INDIVIDUAL | 1,000 | 4704.68 | 213 | 4.705 |
| INSERT_BATCH | 9,000 | 247.67 | 36339 | 0.028 |
| QUERY_SIMPLE_NO_INDEX | 1,000 | 72.35 | 13821 | 0.072 |
| QUERY_COMPLEX_NO_INDEX | 500 | 37.84 | 13214 | 0.076 |
| QUERY_ARRAY_NO_INDEX | 500 | 29.82 | 16768 | 0.060 |
| QUERY_FIND_MANY_NO_INDEX | 100 | 36.71 | 2724 | 0.367 |
| QUERY_SIMPLE_INDEXED | 1,000 | 48.70 | 20533 | 0.049 |
| QUERY_COMPLEX_INDEXED | 500 | 36.09 | 13854 | 0.072 |
| QUERY_ARRAY_INDEXED | 500 | 28.26 | 17692 | 0.057 |
| QUERY_FIND_MANY_INDEXED | 100 | 41.85 | 2390 | 0.418 |
| UPDATE | 1,000 | 6093.94 | 164 | 6.094 |
| DELETE | 1,000 | 17230.04 | 58 | 17.230 |

### Storage Capacity

| Records | Database Size (MB) | Avg Record Size (bytes) |
|---------|-------------------|------------------------|
| 1,000 | 0.44 | 459 |
| 10,000 | 4.27 | 448 |
| 50,000 | 21.36 | 448 |
| 100,000 | 42.75 | 448 |

### Notes

- **INSERT_INDIVIDUAL**: Individual insertOne() operations
- **INSERT_BATCH**: Batch insertions (insertMany or chunked Promise.all)
- **QUERY_SIMPLE_NO_INDEX**: Single field queries without indexes
- **QUERY_SIMPLE_INDEXED**: Single field queries with indexes
- **QUERY_COMPLEX_NO_INDEX**: Multi-field queries without indexes
- **QUERY_COMPLEX_INDEXED**: Multi-field queries with indexes
- **QUERY_ARRAY_NO_INDEX**: Array field queries without indexes
- **QUERY_ARRAY_INDEXED**: Array field queries with indexes
- **QUERY_FIND_MANY_NO_INDEX**: Batch queries returning up to 100 records without indexes
- **QUERY_FIND_MANY_INDEXED**: Batch queries returning up to 100 records with indexes
- **UPDATE**: Individual updateOne() operations with $set
- **DELETE**: Individual deleteOne() operations

**Performance Optimizations:**
- Batch inserts provide significant performance improvements over individual inserts
- Indexes dramatically improve query performance for filtered operations
- Complex queries benefit most from appropriate indexing
- Array field queries can be optimized with proper index strategies

**Storage Characteristics:**
- SQLite databases scale well with MongoLite
- Average record size includes JSON overhead and SQLite indexing
- Practical limits depend on available disk space and memory
- WAL mode provides better concurrent access for larger datasets
- Indexes add storage overhead but provide query performance benefits

**Recommendations:**
- Use batch operations for bulk data insertion
- Create indexes on frequently queried fields
- Monitor database file size growth with your specific data patterns
- Consider compound indexes for complex multi-field queries

## Development
```


## Development

1.  Clone the repository.
2.  Install dependencies: `npm install`
3.  Build the project: `npm run build`
4.  Run tests: `npm test`


### Build Verification

The package includes a comprehensive build verification system that ensures the compiled output works correctly in various contexts:

1. **Module Export Test**: Verifies that all classes and interfaces are correctly exported from the compiled module.

2. **Internal Module Resolution Test**: Ensures that all internal module imports work correctly in the compiled output.

3. **Third-Party Usage Test**: Simulates installing the package in a separate project to verify it works correctly when used as a dependency.

```bash
# Build and verify exports
npm run verify-build

# Test the package as a third-party dependency
npm run test-third-party

# Run all tests including linting, unit tests, and build verification
npm run test:all
```

These tests help prevent common module resolution issues that can occur in ESM packages.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

MIT
