# MongoLite-TS

[![CI](https://github.com/YOUR_USERNAME/mongolite-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_USERNAME/mongolite-ts/actions/workflows/ci.yml)
[![NPM version](https://img.shields.io/npm/v/mongolite-ts.svg)](https://www.npmjs.com/package/mongolite-ts)
[![Coverage Status](https://coveralls.io/repos/github/YOUR_USERNAME/mongolite-ts/badge.svg?branch=main)](https://coveralls.io/github/YOUR_USERNAME/mongolite-ts?branch=main)

A MongoDB-like client that uses SQLite as its underlying persistent store. Written in TypeScript, this package provides a familiar API for developers accustomed to MongoDB, while leveraging the simplicity and file-based nature of SQLite. It supports basic CRUD operations and JSON querying capabilities.

## Features

* MongoDB-like API (`insertOne`, `findOne`, `updateOne`, `deleteOne`, etc.)
* SQLite backend for persistence.
* Automatic `_id` (UUID) generation and indexing.
* Support for querying JSON fields.
* Written in TypeScript with strong typing.
* 100% test coverage (aiming for).

## Installation

```bash
npm install mongolite-ts sqlite3
# or
yarn add mongolite-ts sqlite3
```

**Note:** `sqlite3` is a peer dependency and needs to be installed separately.

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

* `filter`: The query criteria to select the document.
* `update`: The update operations to apply. Supports operators like `$set`, `$unset`, `$inc`, `$push`, `$pull`.
* Returns `UpdateResult`: `{ acknowledged: boolean; matchedCount: number; modifiedCount: number; upsertedId: string | null; }`. (Upsert not yet implemented, `upsertedId` will be `null`).

#### `async deleteOne(filter: Filter<T>): Promise<DeleteResult>`

Deletes a single document matching the filter.

* `filter`: The query criteria to select the document.
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
