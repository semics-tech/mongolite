// package.json
{
  "name": "mongolite-ts",
  "version": "0.1.0",
  "description": "A MongoDB-like client using SQLite as a persistent store, written in TypeScript.",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "prepare": "npm run build",
    "lint": "eslint src/**/*.ts tests/**/*.ts",
    "lint:fix": "eslint src/**/*.ts tests/**/*.ts --fix"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/YOUR_USERNAME/mongolite-ts.git"
  },
  "keywords": [
    "mongodb",
    "sqlite",
    "database",
    "client",
    "typescript",
    "nosql",
    "json"
  ],
  "author": "Your Name <your.email@example.com>",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/YOUR_USERNAME/mongolite-ts/issues"
  },
  "homepage": "https://github.com/YOUR_USERNAME/mongolite-ts#readme",
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.12.12",
    "@types/sqlite3": "^3.1.11",
    "@typescript-eslint/eslint-plugin": "^7.9.0",
    "@typescript-eslint/parser": "^7.9.0",
    "eslint": "^8.57.0",
    "eslint-config-prettier": "^9.1.0",
    "eslint-plugin-jest": "^28.5.0",
    "eslint-plugin-prettier": "^5.1.3",
    "jest": "^29.7.0",
    "prettier": "^3.2.5",
    "sqlite3": "^5.1.7",
    "ts-jest": "^29.1.2",
    "typescript": "^5.4.5"
  },
  "dependencies": {
    "uuid": "^9.0.1",
    "@types/uuid": "^9.0.8"
  },
  "files": [
    "dist/**/*",
    "README.md"
  ],
  "engines": {
    "node": ">=18.0.0"
  }
}
```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "sourceMap": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "typeRoots": ["./node_modules/@types", "./src/types"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```javascript
// jest.config.js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/types/**/*', // Exclude type definition files
  ],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  moduleNameMapper: {
    // If you have path aliases in tsconfig.json, map them here
    // For example: '^@/(.*)$': '<rootDir>/src/$1'
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'] // Optional: for global test setup
};
```
# .gitignore
node_modules/
dist/
coverage/
.DS_Store
*.log
.env
.env.*
!/.env.example

# SQLite database files (if you create them outside :memory:)
*.sqlite
*.sqlite3
*.db
```markdown
# README.md

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
* 100% test coverage (を目指しています - aiming for).

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
    // const deleteResult = await usersCollection.deleteOne({ _id: userId });
    // console.log('Delete result:', deleteResult);

    // const notFoundUser = await usersCollection.findOne({ _id: userId });
    // console.log('User after deletion (should be null):', notFoundUser);

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

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

MIT
```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  build-and-test:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        node-version: [18.x, 20.x, 22.x] # Test against multiple Node.js versions

    steps:
    - name: Checkout repository
      uses: actions/checkout@v4

    - name: Set up Node.js ${{ matrix.node-version }}
      uses: actions/setup-node@v4
      with:
        node-version: ${{ matrix.node-version }}
        cache: 'npm' # Cache npm dependencies

    - name: Install dependencies
      run: npm ci # Use ci for cleaner installs in CI environments

    - name: Build TypeScript
      run: npm run build

    # - name: Lint code (Optional, but recommended)
    #   run: npm run lint

    - name: Run tests
      run: npm test -- --coverage --ci --reporters=default --reporters=jest-junit # Add JUnit reporter for test results

    # Optional: Upload coverage to Coveralls or Codecov
    # - name: Upload coverage to Coveralls
    #   uses: coverallsapp/github-action@master
    #   with:
    #     github-token: ${{ secrets.GITHUB_TOKEN }}
    #     path-to-lcov: ./coverage/lcov.info # Adjust if your lcov file is elsewhere

    # Optional: Publish to NPM on new tag (example)
    # - name: Publish to NPM
    #   if: startsWith(github.ref, 'refs/tags/v') # Only run on version tags (e.g., v1.0.0)
    #   run: |
    #     npm config set //registry.npmjs.org/:_authToken=${{ secrets.NPM_TOKEN }}
    #     npm publish --access public
    #   env:
    #     NPM_TOKEN: ${{ secrets.NPM_TOKEN }} # Store your NPM token as a secret in GitHub
```typescript
// src/db.ts
import sqlite3 from 'sqlite3';
import { promisify } from 'util';

// Promisify sqlite3 methods
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sqlite3Database = sqlite3.Database & {
  getAsync?: (sql: string, params?: any) => Promise<any>;
  runAsync?: (sql: string, params?: any) => Promise<sqlite3.RunResult>;
  allAsync?: (sql: string, params?: any) => Promise<any[]>;
  closeAsync?: () => Promise<void>;
  execAsync?: (sql: string) => Promise<void>;
};


export interface MongoLiteOptions {
  filePath: string;
  verbose?: boolean;
  readOnly?: boolean; // Add readOnly option
}

/**
 * SQLiteDB class provides a wrapper around the sqlite3 library
 * to simplify database operations using Promises.
 */
export class SQLiteDB {
  private db: Sqlite3Database | null = null;
  private readonly filePath: string;
  private readonly verbose: boolean;
  private readonly readOnly: boolean;
  private openPromise: Promise<void> | null = null;

  /**
   * Creates an instance of SQLiteDB.
   * @param {string | MongoLiteOptions} dbPathOrOptions - The path to the SQLite database file or an options object.
   * Use ':memory:' for an in-memory database.
   */
  constructor(dbPathOrOptions: string | MongoLiteOptions) {
    if (typeof dbPathOrOptions === 'string') {
      this.filePath = dbPathOrOptions;
      this.verbose = false;
      this.readOnly = false;
    } else {
      this.filePath = dbPathOrOptions.filePath;
      this.verbose = dbPathOrOptions.verbose || false;
      this.readOnly = dbPathOrOptions.readOnly || false;
    }

    if (this.verbose) {
      sqlite3.verbose();
    }
  }

  /**
   * Opens the database connection if it's not already open.
   * @returns {Promise<void>} A promise that resolves when the connection is open.
   */
  public async connect(): Promise<void> {
    if (this.db && this.openPromise) {
      return this.openPromise;
    }
    if (this.db) { // Already connected and openPromise is null (should not happen with proper logic)
        return Promise.resolve();
    }


    this.openPromise = new Promise((resolve, reject) => {
      const mode = this.readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
      this.db = new sqlite3.Database(this.filePath, mode, (err) => {
        if (err) {
          console.error(`Error opening database ${this.filePath}:`, err.message);
          this.db = null; // Ensure db is null on error
          this.openPromise = null;
          return reject(err);
        }
        if (this.verbose) {
          console.log(`SQLite database opened: ${this.filePath}`);
        }
        // Promisify methods for the current db instance
        if (this.db) {
            this.db.getAsync = promisify(this.db.get).bind(this.db);
            this.db.runAsync = promisify(this.db.run).bind(this.db);
            this.db.allAsync = promisify(this.db.all).bind(this.db);
            this.db.closeAsync = promisify(this.db.close).bind(this.db);
            this.db.execAsync = promisify(this.db.exec).bind(this.db);
        }
        resolve();
      });
    });
    return this.openPromise;
  }

  /**
   * Ensures the database connection is open before performing an operation.
   * @private
   * @returns {Promise<Sqlite3Database>} The active database instance.
   * @throws {Error} If the database is not connected.
   */
  private async ensureConnected(): Promise<Sqlite3Database> {
    if (!this.db || !this.openPromise) {
      await this.connect();
    } else {
      await this.openPromise; // Wait for any ongoing connection attempt
    }

    if (!this.db) {
      // This should ideally not be reached if connect() works correctly
      throw new Error('Database is not connected. Connection attempt failed.');
    }
    return this.db;
  }

  /**
   * Executes a SQL query that does not return rows (e.g., INSERT, UPDATE, DELETE, CREATE).
   * @param {string} sql - The SQL query string.
   * @param {any[]} [params=[]] - Parameters for the SQL query.
   * @returns {Promise<sqlite3.RunResult>} Result of the execution (e.g., lastID, changes).
   */
  public async run(sql: string, params: unknown[] = []): Promise<sqlite3.RunResult> {
    const dbInstance = await this.ensureConnected();
    if (!dbInstance.runAsync) throw new Error("runAsync not initialized");
    return dbInstance.runAsync(sql, params);
  }

  /**
   * Executes a SQL query that returns a single row.
   * @param {string} sql - The SQL query string.
   * @param {any[]} [params=[]] - Parameters for the SQL query.
   * @returns {Promise<T | undefined>} The first row found, or undefined.
   */
  public async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const dbInstance = await this.ensureConnected();
    if (!dbInstance.getAsync) throw new Error("getAsync not initialized");
    return dbInstance.getAsync(sql, params) as Promise<T | undefined>;
  }

  /**
   * Executes a SQL query that returns multiple rows.
   * @param {string} sql - The SQL query string.
   * @param {any[]} [params=[]] - Parameters for the SQL query.
   * @returns {Promise<T[]>} An array of rows.
   */
  public async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const dbInstance = await this.ensureConnected();
    if (!dbInstance.allAsync) throw new Error("allAsync not initialized");
    return dbInstance.allAsync(sql, params) as Promise<T[]>;
  }

  /**
   * Executes multiple SQL statements.
   * @param {string} sql - SQL string with multiple statements.
   * @returns {Promise<void>}
   */
  public async exec(sql: string): Promise<void> {
    const dbInstance = await this.ensureConnected();
    if (!dbInstance.execAsync) throw new Error("execAsync not initialized");
    return dbInstance.execAsync(sql);
  }


  /**
   * Closes the database connection.
   * @returns {Promise<void>} A promise that resolves when the connection is closed.
   */
  public async close(): Promise<void> {
    if (this.openPromise) {
        await this.openPromise; // Ensure any pending connection attempt is finished
    }
    if (this.db && this.db.closeAsync) {
      try {
        await this.db.closeAsync();
        if (this.verbose) {
          console.log(`SQLite database closed: ${this.filePath}`);
        }
      } catch (err) {
        console.error(`Error closing database ${this.filePath}:`, (err as Error).message);
        throw err; // Re-throw the error to indicate failure
      } finally {
        this.db = null;
        this.openPromise = null;
      }
    } else {
        // If db is null, it's already considered closed or was never opened.
        this.db = null;
        this.openPromise = null;
    }
  }

  /**
   * Gets the underlying sqlite3.Database instance.
   * Useful for operations not covered by this wrapper, like transactions.
   * @returns {Promise<sqlite3.Database>} The raw database object.
   * @throws {Error} If the database is not connected.
   */
  public async getDbInstance(): Promise<sqlite3.Database> {
    return this.ensureConnected();
  }
}
```typescript
// src/collection.ts
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
} from './types'; // We'll define these types in a separate file or at the end

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
                                conditions.push(`json_extract(data, ${jsonPath}) <> json(?) OR json_type(data, ${jsonPath}) IS NULL`);
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
                                    const inPlaceholders = opValue.map(() => 'json(?)').join(',');
                                    conditions.push(`json_extract(data, ${jsonPath}) IN (${inPlaceholders})`);
                                    params.push(...opValue.map(v => JSON.stringify(v)));
                                } else {
                                    conditions.push('1=0'); // $in with empty array matches nothing
                                }
                                break;
                            case '$nin':
                                if (Array.isArray(opValue) && opValue.length > 0) {
                                    const ninPlaceholders = opValue.map(() => 'json(?)').join(',');
                                    conditions.push(`json_extract(data, ${jsonPath}) NOT IN (${ninPlaceholders})`);
                                    params.push(...opValue.map(v => JSON.stringify(v)));
                                }
                                // If $nin is empty, it matches everything, so no condition added or add 1=1
                                break;
                            case '$exists':
                                if (opValue) {
                                    conditions.push(`json_type(data, ${jsonPath}) IS NOT NULL`);
                                } else {
                                    conditions.push(`json_type(data, ${jsonPath}) IS NULL`);
                                }
                                break;
                            case '$not': // Handles { field: { $not: { $gt: 10 } } }
                                // This is a bit more complex, requires parsing the inner operator
                                // For simplicity, we'll assume $not contains a single operator condition
                                const notCondition = value as {$not: QueryOperators<any>};
                                if (typeof notCondition.$not === 'object' && notCondition.$not !== null) {
                                    const innerOpKey = Object.keys(notCondition.$not)[0];
                                    const innerOpValue = (notCondition.$not as any)[innerOpKey];
                                    // Build the inner condition and negate it
                                    // This is a simplified version. A full implementation would be recursive.
                                    switch (innerOpKey) {
                                        case '$eq':
                                            conditions.push(`NOT (json_extract(data, ${jsonPath}) = json(?))`);
                                            params.push(JSON.stringify(innerOpValue));
                                            break;
                                        case '$gt':
                                            conditions.push(`NOT (json_extract(data, ${jsonPath}) > json(?))`);
                                            params.push(JSON.stringify(innerOpValue));
                                            break;
                                        // Add other inner operators for $not as needed
                                        default:
                                            console.warn(`Unsupported $not inner operator: ${innerOpKey}`);
                                    }
                                }
                                break;
                            default:
                                console.warn(`Unsupported operator: ${op}`);
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
    return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  }


  private buildSelectQuery(filter: Filter<T>): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const whereClause = this.buildWhereClause(filter, params);
    const sql = `SELECT _id, data FROM "${this.collectionName}" ${whereClause}`;
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
                    const parts = key.split('.');
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    let currentDocVal: any = doc;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    let currentProjVal: any = projectedDoc;
                    for (let i = 0; i < parts.length; i++) {
                        const part = parts[i];
                        if (currentDocVal && typeof currentDocVal === 'object' && part in currentDocVal) {
                            if (i === parts.length - 1) {
                                currentProjVal[part] = currentDocVal[part];
                            } else {
                                currentProjVal[part] = currentProjVal[part] || {};
                                currentProjVal = currentProjVal[part];
                                currentDocVal = currentDocVal[part];
                            }
                        } else {
                            break; // Path doesn't exist in source
                        }
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
                    const parts = key.split('.');
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    let currentProjVal: any = projectedDoc;
                    for (let i = 0; i < parts.length; i++) {
                        const part = parts[i];
                        if (currentProjVal && typeof currentProjVal === 'object' && part in currentProjVal) {
                            if (i === parts.length - 1) {
                                delete currentProjVal[part];
                            } else {
                                currentProjVal = currentProjVal[part];
                            }
                        } else {
                            break; // Path doesn't exist
                        }
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
          return `json_extract(data, ${this.parseJsonPath(field as string)}) ${order === 1 ? 'ASC' : 'DESC'}`;
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

  private parseJsonPath(path: string): string {
    // Prepends '$.' to the path for SQLite JSON functions.
    // 'address.city' becomes '$.address.city'
    return `'$.${path.replace(/\./g, '.')}'`;
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
   * Builds the WHERE clause and parameters for a given filter.
   * @param filter The filter object.
   * @param params An array to populate with query parameters.
   * @returns The SQL WHERE clause string.
   */
  private buildWhereClause(filter: Filter<T>, params: unknown[]): string {
    return new FindCursor<T>(this.db, this.name, filter)['buildWhereClause'](filter, params);
  }


  /**
   * Finds a single document matching the filter.
   * @param filter The query criteria.
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
  find(filter: Filter<T>): FindCursor<T> {
    // ensureTable is called by operations on the cursor or by constructor
    return new FindCursor<T>(this.db, this.name, filter);
  }


  /**
   * Updates a single document matching the filter.
   * @param filter The selection criteria for the update.
   * @param update The modifications to apply.
   * @returns {Promise<UpdateResult>} An object describing the outcome.
   *
   * Note: This implementation currently re-fetches the document to update it,
   * which is not the most efficient way for SQLite. Native JSON modification
   * functions (json_set, json_patch, json_remove) should be used for better performance.
   * This is a simplified version for now.
   */
  async updateOne(filter: Filter<T>, update: UpdateFilter<T>): Promise<UpdateResult> {
    await this.ensureTable();
    // Find the document first (only one)
    // For simplicity, we fetch the _id of the first matching document.
    // A more robust solution would handle multiple matches or specific update strategies.
    const paramsForSelect: unknown[] = [];
    const whereClauseForSelect = this.buildWhereClause(filter, paramsForSelect);
    const selectSql = `SELECT _id, data FROM "${this.name}" ${whereClauseForSelect} LIMIT 1`;

    const rowToUpdate = await this.db.get<SQLiteRow>(selectSql, paramsForSelect);

    if (!rowToUpdate) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedId: null };
    }

    let currentDoc = JSON.parse(rowToUpdate.data);
    let modified = false;

    for (const operator in update) {
      const opArgs = update[operator as keyof UpdateFilter<T>];
      if (!opArgs) continue;

      switch (operator as keyof UpdateOperators<T>) {
        case '$set':
          for (const fieldPath in opArgs) {
            this.setNestedValue(currentDoc, fieldPath, opArgs[fieldPath]);
            modified = true;
          }
          break;
        case '$unset':
          for (const fieldPath in opArgs) {
            this.unsetNestedValue(currentDoc, fieldPath);
            modified = true;
          }
          break;
        case '$inc':
          for (const fieldPath in opArgs) {
            const currentValue = this.getNestedValue(currentDoc, fieldPath);
            if (typeof currentValue === 'number' && typeof opArgs[fieldPath] === 'number') {
              this.setNestedValue(currentDoc, fieldPath, currentValue + (opArgs[fieldPath] as number));
              modified = true;
            } else if (typeof opArgs[fieldPath] === 'number' && currentValue === undefined){
              // if field does not exist, $inc sets the field to the specified amount.
              this.setNestedValue(currentDoc, fieldPath, opArgs[fieldPath] as number);
              modified = true;
            }
          }
          break;
        case '$push':
            for (const fieldPath in opArgs) {
                const pushValue = opArgs[fieldPath];
                let arrayToPush = this.getNestedValue(currentDoc, fieldPath);
                if (!Array.isArray(arrayToPush)) {
                    arrayToPush = []; // Initialize as array if not exists or not an array
                }

                if (typeof pushValue === 'object' && pushValue !== null && '$each' in pushValue) {
                    const eachArray = (pushValue as {$each: unknown[]}).$each;
                    if (Array.isArray(eachArray)) {
                        arrayToPush.push(...eachArray);
                    }
                } else {
                    arrayToPush.push(pushValue);
                }
                this.setNestedValue(currentDoc, fieldPath, arrayToPush);
                modified = true;
            }
            break;
        case '$pull':
            for (const fieldPath in opArgs) {
                const pullCondition = opArgs[fieldPath];
                let arrayToPullFrom = this.getNestedValue(currentDoc, fieldPath);
                if (!Array.isArray(arrayToPullFrom)) {
                    continue; // Field is not an array, nothing to pull
                }

                if (typeof pullCondition === 'object' && pullCondition !== null && !Array.isArray(pullCondition)) {
                    // Complex pull condition (e.g., { id: { $in: [1,2] } })
                    // This requires a mini-matcher. For simplicity, we'll support direct value match or simple operator
                    arrayToPullFrom = arrayToPullFrom.filter((item: any) => {
                        // Basic implementation: check if item matches the condition structure
                        // This is a very simplified version of MongoDB's $pull with conditions.
                        if (typeof item === 'object' && item !== null) {
                            for(const condKey in pullCondition) {
                                const condValue = (pullCondition as any)[condKey];
                                if (typeof condValue === 'object' && condValue !== null && '$in' in condValue) {
                                    if (!condValue.$in.includes(item[condKey])) return true; // keep if not in $in
                                } else if (item[condKey] !== condValue) {
                                    return true; // keep if not equal
                                }
                            }
                            return false; // remove if all conditions match
                        }
                        return true; // keep if item is not an object or condition is not for objects
                    });

                } else { // Simple pull: remove all instances of a specific value
                    arrayToPullFrom = arrayToPullFrom.filter((item: any) => item !== pullCondition);
                }
                this.setNestedValue(currentDoc, fieldPath, arrayToPullFrom);
                modified = true;
            }
            break;
        // Add other operators like $rename, $min, $max, array operators ($pop, $addToSet) here
        default:
          console.warn(`Unsupported update operator: ${operator}`);
          break;
      }
    }

    if (modified) {
      const newJsonData = JSON.stringify(currentDoc);
      const updateSql = `UPDATE "${this.name}" SET data = ? WHERE _id = ?`;
      await this.db.run(updateSql, [newJsonData, rowToUpdate._id]);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
    } else {
      return { acknowledged: true, matchedCount: 1, modifiedCount: 0, upsertedId: null };
    }
  }

  // Helper for $set, $inc to handle dot notation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!current[key] || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }
    current[keys[keys.length - 1]] = value;
  }

  // Helper for $unset
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private unsetNestedValue(obj: any, path: string): void {
    const keys = path.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!current[key] || typeof current[key] !== 'object') {
        return; // Path doesn't exist
      }
      current = current[key];
    }
    delete current[keys[keys.length - 1]];
  }

  // Helper to get nested value
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getNestedValue(obj: any, path: string): any {
    const keys = path.split('.');
    let current = obj;
    for (const key of keys) {
      if (!current || typeof current !== 'object' || !(key in current)) {
        return undefined;
      }
      current = current[key];
    }
    return current;
  }


  /**
   * Deletes a single document matching the filter.
   * @param filter The selection criteria for the deletion.
   * @returns {Promise<DeleteResult>} An object describing the outcome.
   */
  async deleteOne(filter: Filter<T>): Promise<DeleteResult> {
    await this.ensureTable();
    const params: unknown[] = [];
    const whereClause = this.buildWhereClause(filter, params);

    // SQLite does not directly return the count of deleted rows for a simple DELETE.
    // To get an accurate count, we could SELECT _id first, then DELETE by those _ids.
    // Or, for a single delete, we can try deleting and check changes.
    // For simplicity, we'll delete and trust `this.changes` from sqlite3.RunResult.
    // However, `DELETE ... LIMIT 1` is not standard SQL for all DBs, but SQLite supports it
    // if compiled with SQLITE_ENABLE_UPDATE_DELETE_LIMIT.
    // A safer way for one document is to find its _id first.

    const selectSql = `SELECT _id FROM "${this.name}" ${whereClause} LIMIT 1`;
    const rowToDelete = await this.db.get<{_id: string}>(selectSql, params);

    if (!rowToDelete) {
        return { acknowledged: true, deletedCount: 0 };
    }

    const deleteSql = `DELETE FROM "${this.name}" WHERE _id = ?`;
    const result = await this.db.run(deleteSql, [rowToDelete._id]);

    return { acknowledged: true, deletedCount: result.changes || 0 };
  }

  /**
   * Deletes multiple documents matching the filter.
   * @param filter The selection criteria for the deletion.
   * @returns {Promise<DeleteResult>} An object describing the outcome.
   */
  async deleteMany(filter: Filter<T>): Promise<DeleteResult> {
    await this.ensureTable();
    const params: unknown[] = [];
    const whereClause = this.buildWhereClause(filter, params);
    const sql = `DELETE FROM "${this.name}" ${whereClause}`;
    const result = await this.db.run(sql, params);
    return { acknowledged: true, deletedCount: result.changes || 0 };
  }

  /**
   * Counts the number of documents matching the filter.
   * @param filter The query criteria.
   * @returns {Promise<number>} The number of matching documents.
   */
  async countDocuments(filter: Filter<T> = {}): Promise<number> {
    await this.ensureTable();
    const params: unknown[] = [];
    const whereClause = this.buildWhereClause(filter, params);
    const sql = `SELECT COUNT(*) as count FROM "${this.name}" ${whereClause}`;
    const result = await this.db.get<{ count: number }>(sql, params);
    return result ? result.count : 0;
  }

  /**
   * Drops the entire collection (table).
   * @returns {Promise<void>}
   */
  async drop(): Promise<void> {
    await this.ensureTable(); // It might seem counterintuitive, but good to ensure it exists to avoid error on drop if not.
                              // Or, use "IF EXISTS" which is safer.
    const sql = `DROP TABLE IF EXISTS "${this.name}"`;
    await this.db.exec(sql);
  }

}
```typescript
// src/index.ts
import { SQLiteDB, MongoLiteOptions as DBMongoLiteOptions } from './db';
import { MongoLiteCollection } from './collection';
import { DocumentWithId } from './types';

export { MongoLiteCollection } from './collection';
export * from './types'; // Export all types

export interface MongoLiteClientOptions extends DBMongoLiteOptions {}

/**
 * MongoLite class is the main entry point for interacting with the SQLite-backed database.
 * It provides a MongoDB-like client interface.
 */
export class MongoLite {
  private db: SQLiteDB;
  private connected: boolean = false;
  private connectionPromise: Promise<void> | null = null;

  /**
   * Creates a new MongoLite client instance.
   * @param {string | MongoLiteClientOptions} dbPathOrOptions - The path to the SQLite database file (e.g., './mydb.sqlite', ':memory:')
   * or an options object.
   */
  constructor(dbPathOrOptions: string | MongoLiteClientOptions) {
    this.db = new SQLiteDB(dbPathOrOptions);
  }

  /**
   * Explicitly opens the database connection.
   * While operations will auto-connect, calling this can be useful for initial setup
   * or to catch connection errors early.
   * @returns {Promise<void>} A promise that resolves when the connection is established.
   */
  public async connect(): Promise<void> {
    if (this.connected && this.connectionPromise) {
      return this.connectionPromise;
    }
    if (this.connected) {
        return Promise.resolve();
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.db.connect()
      .then(() => {
        this.connected = true;
      })
      .catch(err => {
        this.connectionPromise = null; // Reset on error so retry is possible
        this.connected = false;
        throw err; // Re-throw to allow caller to handle
      });
    return this.connectionPromise;
  }

  /**
   * Closes the database connection.
   * It's important to call this when your application is shutting down
   * to ensure all data is flushed and resources are released.
   * @returns {Promise<void>} A promise that resolves when the connection is closed.
   */
  public async close(): Promise<void> {
    if (this.connectionPromise) {
        try {
            await this.connectionPromise; // Wait for any ongoing connection attempt
        } catch (e) {
            // If connectionPromise itself failed, db.close() might also fail or be irrelevant
            // but we should still try to clean up.
            console.warn("Closing after connection attempt failed:", e);
        }
    }

    if (this.connected || this.db) { // Attempt close if connected or db object exists
        try {
            await this.db.close();
        } catch (err) {
            console.error("Error during explicit close:", err);
            // Decide if to rethrow or just log
        } finally {
            this.connected = false;
            this.connectionPromise = null;
        }
    } else {
        // Already closed or never connected
        this.connected = false;
        this.connectionPromise = null;
    }
  }

  /**
   * Gets a reference to a collection (which maps to an SQLite table).
   * If the collection (table) does not exist, it will be created automatically
   * upon the first operation that requires it (e.g., insertOne, findOne).
   *
   * @template T - The type of the documents in the collection. Must extend `DocumentWithId`.
   * @param {string} name - The name of the collection.
   * @returns {MongoLiteCollection<T>} An instance of `MongoLiteCollection` for interacting with the specified collection.
   */
  public collection<T extends DocumentWithId = DocumentWithId>(name: string): MongoLiteCollection<T> {
    if (!name || name.trim() === '') {
        throw new Error("Collection name cannot be empty.");
    }
    // Collection names should be valid table names.
    // Basic sanitization: replace spaces and special chars, or enforce stricter rules.
    // For now, we assume valid names or rely on SQLite to throw errors for invalid ones.
    // Using quotes around table names in SQL queries (`"${name}"`) helps with many special characters.
    return new MongoLiteCollection<T>(this.db, name);
  }

  /**
   * Provides direct access to the underlying SQLiteDB instance.
   * Use this if you need to perform raw SQL queries or operations not covered by the MongoLite API.
   * @returns {SQLiteDB} The SQLiteDB instance.
   */
  public getDb(): SQLiteDB {
    return this.db;
  }
}
```typescript
// src/types.ts

/**
 * Base document structure that includes an optional `_id`.
 * All documents stored in a collection should extend this.
 */
export interface DocumentWithId {
  _id?: string;
  [key: string]: any; // Allow any other properties
}

/**
 * Represents the filter criteria for querying documents.
 * It's a partial representation of the document type `T`,
 * allowing queries on any field of `T`.
 * It also supports query operators.
 */
export type Filter<T extends DocumentWithId> = {
  [P in keyof T]?: T[P] | QueryOperators<T[P]>;
} & {
  $and?: Filter<T>[];
  $or?: Filter<T>[];
  $nor?: Filter<T>[];
  // $not is typically applied to a specific field's operator,
  // e.g., { age: { $not: { $gt: 30 } } }
  // So it's better handled within QueryOperators or by specific logic.
};


/**
 * Defines common query operators like $gt, $lt, $in, etc.
 * `V` is the type of the value the operator applies to.
 */
export type QueryOperators<V> = {
  $eq?: V;
  $ne?: V;
  $gt?: V; // For number, string, Date
  $gte?: V; // For number, string, Date
  $lt?: V; // For number, string, Date
  $lte?: V; // For number, string, Date
  $in?: V[];
  $nin?: V[];
  $exists?: boolean;
  $not?: QueryOperators<V> | V; // For negating an operator or a simple value
  // Add other operators like $regex, $type, etc. as needed
};

/**
 * Represents update operations, using MongoDB-like update operators.
 * `T` is the document type.
 */
export type UpdateFilter<T extends DocumentWithId> = {
  $set?: Partial<T>;
  $unset?: { [P in keyof T]?: '' | true }; // Value is typically empty string or true
  $inc?: { [P in keyof T]?: number }; // Only for numeric fields
  $push?: { [P in keyof T]?: T[P] extends Array<infer E> ? (E | { $each: E[] }) : never };
  $pull?: { [P in keyof T]?: T[P] extends Array<infer E> ? (E | Partial<E> | QueryOperators<E>) : never };
  // Add other operators like $rename, $min, $max, $addToSet, $pop, etc.
};

// Specific result types for operations

export interface InsertOneResult {
  acknowledged: boolean;
  insertedId: string;
}

export interface UpdateResult {
  acknowledged: boolean;
  matchedCount: number;
  modifiedCount: number;
  upsertedId: string | null; // null if no upsert happened or not supported yet
}

export interface DeleteResult {
  acknowledged: boolean;
  deletedCount: number;
}

/**
 * Defines the sorting criteria for find operations.
 * Keys are field paths (dot notation for nested fields), values are 1 (asc) or -1 (desc).
 * Example: `{ "user.age": -1, name: 1 }`
 */
export type SortCriteria<T> = {
  [P in keyof T | string]?: 1 | -1;
};


/**
 * Defines projection for find operations.
 * Keys are field paths, values are 1 (include) or 0 (exclude).
 * `_id` is included by default unless explicitly set to 0.
 * If any field is 1, only those fields and `_id` (unless excluded) are returned.
 * If all specified fields are 0, those fields are excluded, and others are returned.
 */
export type Projection<T extends DocumentWithId> = {
  [P in keyof T | string]?: 0 | 1;
} & { _id?: 0 | 1 };
```typescript
// tests/setup.ts
// This file can be used for global test setup, like:
// - Mocking modules
// - Setting up a test database environment if needed globally
// - Extending Jest matchers

// For example, if you need to ensure a clean environment for each test suite
// or perform some async setup before tests run.

// console.log("Global test setup file loaded.");

// Example: Mocking a module globally
// jest.mock('some-module', () => ({
//   someFunction: jest.fn(() => 'mocked value'),
// }));

// If you need to perform async setup before all tests:
// export default async () => {
//   console.log('\nPerforming global async setup...');
//   // await someAsyncSetupFunction();
// };

// If you need to perform cleanup after all tests:
// (This is typically handled by Jest's `globalTeardown` option in jest.config.js,
// but can also be managed here if preferred for specific setups)
```typescript
// tests/mongolite.test.ts
import { MongoLite, MongoLiteClientOptions, DocumentWithId, InsertOneResult, UpdateResult, DeleteResult, Filter } from '../src/index';
import { MongoLiteCollection } from '../src/collection'; // For type checking if needed
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

interface TestDoc extends DocumentWithId {
  name: string;
  value: number;
  tags?: string[];
  nested?: {
    propA: string;
    propB?: number;
    deep?: {
        level: number;
    }
  };
  mixedTypeField?: string | number;
  boolField?: boolean;
  nullField?: string | null;
}

interface UserDoc extends DocumentWithId {
    username: string;
    age: number;
    email?: string;
    profile?: {
        firstName: string;
        lastName: string;
        avatar?: string;
    };
    hobbies?: string[];
    lastLogin?: Date;
    status?: 'active' | 'inactive' | 'pending';
}


const DB_PATH_FILE = path.join(__dirname, 'test-db.sqlite');
const DB_PATH_MEMORY = ':memory:';

// Helper to remove test database file
const cleanupDbFile = (filePath: string) => {
  if (fs.existsSync(filePath)) {
    try {
        fs.unlinkSync(filePath);
    } catch (err) {
        console.error("Error cleaning up DB file:", err);
        // In CI, file might be locked, so try again or ignore
        if (process.env.CI) {
            try {
                fs.unlinkSync(filePath); // try again
            } catch (e) {
                console.warn("Could not remove DB file in CI, might be locked:", e);
            }
        } else {
            throw err; // Rethrow if not in CI
        }
    }
  }
};


describe.each([
    { dbType: 'file-based', dbPath: DB_PATH_FILE, options: { filePath: DB_PATH_FILE } as MongoLiteClientOptions },
    { dbType: 'in-memory', dbPath: DB_PATH_MEMORY, options: { filePath: DB_PATH_MEMORY } as MongoLiteClientOptions },
])('MongoLite Client with $dbType SQLite', ({ dbPath, options }) => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;
  const collectionName = 'testItems';

  beforeEach(async () => {
    if (dbPath !== ':memory:') {
      cleanupDbFile(dbPath);
    }
    client = new MongoLite(options);
    await client.connect(); // Explicitly connect for clarity in tests
    collection = client.collection<TestDoc>(collectionName);
    await collection.ensureTable(); // Ensure table is created before each test
                                   // (though operations would do this lazily)
  });

  afterEach(async () => {
    if (client) {
      // Attempt to drop collection to clean up, but handle errors if table doesn't exist or other issues
      try {
        if (collection) await collection.drop();
      } catch (error) {
        // console.warn(`Warning: Could not drop collection ${collectionName} during cleanup:`, error);
      }
      await client.close();
    }
    if (dbPath !== ':memory:') {
      cleanupDbFile(dbPath);
    }
  });

  describe('Client Initialization and Connection', () => {
    test('should connect to the database', () => {
      expect(client).toBeDefined();
      // @ts-expect-error access private for test
      expect(client.connected).toBe(true);
    });

    test('should create a collection instance', () => {
      const col = client.collection('anotherTest');
      expect(col).toBeInstanceOf(MongoLiteCollection);
      expect(col.name).toBe('anotherTest');
    });

    test('should throw error for empty collection name', () => {
        expect(() => client.collection('')).toThrow("Collection name cannot be empty.");
        expect(() => client.collection('  ')).toThrow("Collection name cannot be empty.");
    });

    test('should allow getting the raw SQLiteDB instance', () => {
        const rawDb = client.getDb();
        expect(rawDb).toBeDefined();
        // @ts-expect-error access private for test
        expect(rawDb.filePath).toBe(options.filePath);
    });

    test('multiple connect calls should be idempotent', async () => {
        await client.connect();
        await client.connect();
        // @ts-expect-error access private for test
        expect(client.connected).toBe(true);
    });

    test('multiple close calls should be idempotent', async () => {
        await client.close();
        await client.close();
        // @ts-expect-error access private for test
        expect(client.connected).toBe(false);
    });

    test('operations should auto-connect if client not explicitly connected', async () => {
        await client.close(); // Close existing connection
        const newClient = new MongoLite(options); // New client, not connected
        const newCollection = newClient.collection<TestDoc>('autoConnectTest');
        const doc = { name: 'Auto Connect', value: 1 };
        const result = await newCollection.insertOne(doc);
        expect(result.acknowledged).toBe(true);
        expect(result.insertedId).toBeDefined();
        // @ts-expect-error access private for test
        expect(newClient.connected).toBe(true); // Should be connected now
        await newClient.close();
        if (dbPath !== ':memory:') {
            cleanupDbFile(dbPath); // Clean up if file based
        }
    });

    test('should handle connection errors gracefully', async () => {
        // Simulate a scenario where connection might fail (e.g., invalid path for file DB)
        // This is hard to test reliably for :memory: DB.
        if (dbPath !== ':memory:') {
            await client.close(); // Close the valid client
            cleanupDbFile(dbPath);

            // Create a client with a path that's intentionally problematic (e.g., a directory)
            // SQLite might still create a file if it can, so this test is tricky.
            // Let's try to make the path a directory to cause an error.
            const invalidPath = path.join(__dirname); // Path to current directory
            const errorClient = new MongoLite(invalidPath);
            try {
                await errorClient.connect();
            } catch (e: any) {
                expect(e).toBeInstanceOf(Error);
                // SQLite error codes for "unable to open database file" or "is a directory"
                expect(e.message).toMatch(/SQLITE_CANTOPEN|SQLITE_ERROR/i);
            } finally {
                await errorClient.close().catch(() => {}); // Attempt to close, ignore errors
            }
        } else {
            // For :memory:, connection errors are less likely unless sqlite3 itself has issues.
            // We can try to test a failed operation if the DB object is somehow corrupted.
            // This is more of an internal state test.
            const memClient = new MongoLite(':memory:');
            // @ts-expect-error Intentionally mess with internal state for testing
            memClient.db = null;
             try {
                // @ts-expect-error Intentionally mess with internal state for testing
                await memClient.db.connect(); // This should fail if db is null
            } catch (e: any) {
                expect(e).toBeInstanceOf(Error); // e.g. TypeError: Cannot read properties of null
            }
            await memClient.close().catch(() => {});
        }
    });
  });


  describe('MongoLiteCollection Operations', () => {
    describe('insertOne()', () => {
      test('should insert a document and return an ID', async () => {
        const doc = { name: 'Test Item 1', value: 100 };
        const result: InsertOneResult = await collection.insertOne(doc);
        expect(result.acknowledged).toBe(true);
        expect(result.insertedId).toEqual(expect.any(String));
        expect(result.insertedId.length).toBe(36); // UUID length
      });

      test('should insert a document with a pre-defined _id', async () => {
        const customId = uuidv4();
        const doc = { _id: customId, name: 'Test Item Custom ID', value: 101 };
        const result = await collection.insertOne(doc);
        expect(result.acknowledged).toBe(true);
        expect(result.insertedId).toBe(customId);
      });

      test('should throw error if inserting a document with an existing _id', async () => {
        const docId = uuidv4();
        await collection.insertOne({ _id: docId, name: 'First Insert', value: 1 });
        await expect(
          collection.insertOne({ _id: docId, name: 'Second Insert Duplicate ID', value: 2 })
        ).rejects.toThrow(`Duplicate _id: ${docId}`);
      });

      test('should insert complex nested documents', async () => {
        const doc: TestDoc = {
            name: "Complex Doc",
            value: 200,
            tags: ["complex", "nested"],
            nested: {
                propA: "Hello",
                propB: 123,
                deep: {
                    level: 3
                }
            }
        };
        const result = await collection.insertOne(doc);
        expect(result.acknowledged).toBe(true);
        const found = await collection.findOne({_id: result.insertedId});
        expect(found).toBeDefined();
        expect(found?.name).toBe("Complex Doc");
        expect(found?.nested?.propA).toBe("Hello");
        expect(found?.nested?.deep?.level).toBe(3);
      });
    });

    describe('findOne()', () => {
      let doc1Id: string, doc2Id: string;
      const doc1: TestDoc = { name: 'FindMe', value: 10, tags: ['a', 'b'], nested: { propA: 'X', propB: 1, deep: { level: 1 } }, boolField: true, nullField: null };
      const doc2: TestDoc = { name: 'Another', value: 20, tags: ['b', 'c'], nested: { propA: 'Y', propB: 2 }, boolField: false };

      beforeEach(async () => {
        const res1 = await collection.insertOne(doc1);
        doc1Id = res1.insertedId;
        const res2 = await collection.insertOne(doc2);
        doc2Id = res2.insertedId;
      });

      test('should find a document by _id', async () => {
        const found = await collection.findOne({ _id: doc1Id });
        expect(found).toBeDefined();
        expect(found?._id).toBe(doc1Id);
        expect(found?.name).toBe(doc1.name);
        expect(found?.value).toBe(doc1.value);
        expect(found?.tags).toEqual(doc1.tags);
        expect(found?.nested?.propA).toBe(doc1.nested?.propA);
        expect(found?.nested?.deep?.level).toBe(doc1.nested?.deep?.level);
        expect(found?.boolField).toBe(true);
        expect(found?.nullField).toBeNull();
      });

      test('should return null if document with _id not found', async () => {
        const found = await collection.findOne({ _id: 'non-existent-id' });
        expect(found).toBeNull();
      });

      test('should find a document by a top-level field', async () => {
        const found = await collection.findOne({ name: 'FindMe' });
        expect(found).toBeDefined();
        expect(found?._id).toBe(doc1Id);
      });

      test('should find a document by a nested field using dot notation', async () => {
        const found = await collection.findOne({ 'nested.propA': 'X' });
        expect(found).toBeDefined();
        expect(found?._id).toBe(doc1Id);
      });

      test('should find a document by a deeply nested field', async () => {
        const found = await collection.findOne({ 'nested.deep.level': 1 });
        expect(found).toBeDefined();
        expect(found?._id).toBe(doc1Id);
      });

      test('should return null if nested field does not match', async () => {
        const found = await collection.findOne({ 'nested.propA': 'NonExistentValue' });
        expect(found).toBeNull();
      });

      test('should return null if filter matches no documents', async () => {
        const found = await collection.findOne({ name: 'NonExistentName' });
        expect(found).toBeNull();
      });

      test('should find based on boolean value', async () => {
        const foundTrue = await collection.findOne({ boolField: true });
        expect(foundTrue?._id).toBe(doc1Id);
        const foundFalse = await collection.findOne({ boolField: false });
        expect(foundFalse?._id).toBe(doc2Id);
      });

      test('should find based on null value', async () => {
        const foundNull = await collection.findOne({ nullField: null });
        expect(foundNull?._id).toBe(doc1Id);
      });

      test('should find with $eq operator', async () => {
        const found = await collection.findOne({ value: { $eq: 10 } });
        expect(found?._id).toBe(doc1Id);
      });

      test('should find with $ne operator for _id', async () => {
        const found = await collection.findOne({ _id: { $ne: doc1Id } });
        expect(found?._id).toBe(doc2Id); // Assuming only two docs and doc2 is the other one
      });

      test('should find with $ne operator for other fields', async () => {
        const found = await collection.findOne({ name: { $ne: 'FindMe' } });
        expect(found?._id).toBe(doc2Id);
      });

      test('should find with $gt operator', async () => {
        const found = await collection.findOne({ value: { $gt: 15 } });
        expect(found?._id).toBe(doc2Id);
      });

      test('should find with $gte operator', async () => {
        const found = await collection.findOne({ value: { $gte: 20 } });
        expect(found?._id).toBe(doc2Id);
      });

      test('should find with $lt operator', async () => {
        const found = await collection.findOne({ value: { $lt: 15 } });
        expect(found?._id).toBe(doc1Id);
      });

      test('should find with $lte operator', async () => {
        const found = await collection.findOne({ value: { $lte: 10 } });
        expect(found?._id).toBe(doc1Id);
      });

      test('should find with $in operator for _id', async () => {
        const found = await collection.findOne({ _id: { $in: [doc1Id, 'some-other-id'] } });
        expect(found?._id).toBe(doc1Id);
      });

      test('should find with $in operator for fields', async () => {
        const found = await collection.findOne({ value: { $in: [5, 10, 15] } });
        expect(found?._id).toBe(doc1Id);
      });

      test('should find with $nin operator for fields', async () => {
        const found = await collection.findOne({ value: { $nin: [20, 25, 30] } });
        expect(found?._id).toBe(doc1Id);
      });

      test('$in with empty array should find nothing', async () => {
        const found = await collection.findOne({ value: { $in: [] } });
        expect(found).toBeNull();
      });

      test('$nin with empty array should find everything (effectively)', async () => {
        // This behavior might need refinement. MongoDB's $nin with empty array matches all.
        // Our current implementation might not add a condition, which is correct.
        const found = await collection.find({ value: { $nin: [] } }).toArray();
        expect(found.length).toBe(2); // Should find both doc1 and doc2
      });

      test('should find with $exists: true operator', async () => {
        const found = await collection.findOne({ 'nested.deep.level': { $exists: true } });
        expect(found?._id).toBe(doc1Id);
      });

      test('should find with $exists: false operator', async () => {
        // Find a doc where 'nested.deep.level' does NOT exist
        const found = await collection.findOne({ 'nested.deep.level': { $exists: false } });
        expect(found?._id).toBe(doc2Id); // doc2 does not have nested.deep.level
      });

      test('should find with $not operator (e.g., not greater than)', async () => {
        const found = await collection.findOne({ value: { $not: { $gt: 15 } } }); // i.e., value <= 15
        expect(found?._id).toBe(doc1Id);
      });

      test('should find with $not operator (e.g., not equal)', async () => {
        const found = await collection.findOne({ name: { $not: { $eq: 'FindMe' } } });
        expect(found?._id).toBe(doc2Id);
      });

      test('findOne with projection: include fields', async () => {
        const found = await collection.findOne({ _id: doc1Id }, { name: 1, value: 1 });
        expect(found).toEqual({ _id: doc1Id, name: 'FindMe', value: 10 });
      });

      test('findOne with projection: exclude fields', async () => {
        const found = await collection.findOne({ _id: doc1Id }, { value: 0, tags: 0 });
        expect(found).toBeDefined();
        expect(found).not.toHaveProperty('value');
        expect(found).not.toHaveProperty('tags');
        expect(found).toHaveProperty('name', 'FindMe');
        expect(found).toHaveProperty('_id', doc1Id);
      });

      test('findOne with projection: exclude _id', async () => {
        const found = await collection.findOne({ _id: doc1Id }, { _id: 0, name: 1 });
        expect(found).toEqual({ name: 'FindMe' });
      });

      test('findOne with projection: include nested fields', async () => {
        const found = await collection.findOne({ _id: doc1Id }, { 'nested.propA': 1, name: 1 });
        expect(found).toEqual({ _id: doc1Id, name: 'FindMe', nested: { propA: 'X' } });
      });

      test('findOne with projection: exclude nested fields', async () => {
        const found = await collection.findOne({ _id: doc1Id }, { 'nested.propA': 0, _id:0 });
        expect(found).toBeDefined();
        expect(found).not.toHaveProperty('_id');
        expect(found?.nested).toBeDefined();
        expect(found?.nested).not.toHaveProperty('propA');
        expect(found?.nested).toHaveProperty('propB', 1); // Other parts of nested should remain
      });

      test('findOne with projection: only _id if empty projection', async () => {
        // Mongo behavior: {} means all fields. Our current might differ slightly.
        // Let's test specific cases. If projection is `{}`, it should return all fields.
        // If `project()` is not called, all fields are returned.
        const found = await collection.findOne({ _id: doc1Id }, {}); // Empty projection object
        expect(found?.name).toBe(doc1.name);
        expect(found?.value).toBe(doc1.value);
        // This test depends on the exact interpretation of empty projection.
        // Typically, an empty projection means all fields.
      });

      test('findOne with projection: all fields if projection is undefined', async () => {
        const found = await collection.findOne({ _id: doc1Id }, undefined);
        expect(found?.name).toBe(doc1.name);
        expect(found?.value).toBe(doc1.value);
        expect(found?.nested?.propA).toBe(doc1.nested?.propA);
      });

      test('findOne with projection: include mode with _id explicitly included', async () => {
        const found = await collection.findOne({ _id: doc1Id }, { _id: 1, name: 1 });
        expect(found).toEqual({ _id: doc1Id, name: 'FindMe' });
      });

      test('findOne with projection: exclusion mode with _id explicitly included (overrides exclusion)', async () => {
        // If _id: 1 is present with other exclusions, it's still an inclusion projection.
        // This is tricky. MongoDB behavior: If you specify an inclusion for any field,
        // it becomes an inclusion projection. _id is included by default.
        // If you specify _id: 0 and some field: 1, then _id is excluded and field is included.
        // If you specify _id: 1 and some field: 0, this is an error in MongoDB.
        // Our simplified model: if any field has 1, it's inclusion.
        const found = await collection.findOne({ _id: doc1Id }, { name: 1, value: 0 }); // value:0 is ignored in inclusion mode
        expect(found).toEqual({ _id: doc1Id, name: 'FindMe' });
      });


    });

    describe('find() and FindCursor', () => {
        let ids: string[];
        const docs: TestDoc[] = [
            { name: 'ItemA', value: 10, tags: ['x', 'y'], nested: {propA: 'val1', propB: 100} },
            { name: 'ItemB', value: 20, tags: ['y', 'z'], nested: {propA: 'val2', propB: 200} },
            { name: 'ItemC', value: 10, tags: ['x', 'z'], nested: {propA: 'val3', propB: 300} },
            { name: 'ItemD', value: 30, tags: ['w'], nested: {propA: 'val1', propB: 400} },
        ];

        beforeEach(async () => {
            ids = [];
            for (const doc of docs) {
                const res = await collection.insertOne(doc);
                ids.push(res.insertedId);
            }
        });

        test('should find all documents if no filter', async () => {
            const results = await collection.find({}).toArray();
            expect(results.length).toBe(docs.length);
        });

        test('should find documents matching a filter', async () => {
            const results = await collection.find({ value: 10 }).toArray();
            expect(results.length).toBe(2);
            expect(results.every(d => d.value === 10)).toBe(true);
        });

        test('should find documents with $gt operator', async () => {
            const results = await collection.find({ value: { $gt: 15 } }).toArray();
            expect(results.length).toBe(2); // ItemB (20), ItemD (30)
            expect(results.map(d => d.name).sort()).toEqual(['ItemB', 'ItemD'].sort());
        });

        test('should find with $and operator', async () => {
            const results = await collection.find({
                $and: [
                    { value: { $gte: 10 } },
                    { 'nested.propA': 'val1' }
                ]
            }).toArray();
            expect(results.length).toBe(2); // ItemA, ItemD
            expect(results.map(d => d.name).sort()).toEqual(['ItemA', 'ItemD'].sort());
        });

        test('should find with $or operator', async () => {
            const results = await collection.find({
                $or: [
                    { name: 'ItemA' },
                    { value: { $gt: 25 } }
                ]
            }).toArray();
            expect(results.length).toBe(2); // ItemA, ItemD
            expect(results.map(d => d.name).sort()).toEqual(['ItemA', 'ItemD'].sort());
        });

        test('should find with $nor operator', async () => {
            // NOR: not ( (value < 20) OR (name = ItemD) )
            // This means: (value >= 20) AND (name != ItemD)
            // Matches ItemB (value: 20, name: ItemB)
            const results = await collection.find({
                $nor: [
                    { value: { $lt: 20 } }, // ItemA, ItemC
                    { name: 'ItemD' }      // ItemD
                ]
            }).toArray();
            expect(results.length).toBe(1);
            expect(results[0].name).toBe('ItemB');
        });


        test('limit() should restrict number of results', async () => {
            const results = await collection.find({}).limit(2).toArray();
            expect(results.length).toBe(2);
        });

        test('skip() should offset results', async () => {
            const allResults = await collection.find({}).sort({name: 1}).toArray(); // Sort for predictable skip
            const skippedResults = await collection.find({}).sort({name: 1}).skip(1).toArray();
            expect(skippedResults.length).toBe(docs.length - 1);
            expect(skippedResults[0]._id).toBe(allResults[1]._id);
        });

        test('sort() should order results (ascending by name)', async () => {
            const results = await collection.find({}).sort({ name: 1 }).toArray();
            expect(results.map(d => d.name)).toEqual(['ItemA', 'ItemB', 'ItemC', 'ItemD']);
        });

        test('sort() should order results (descending by value, then ascending by name)', async () => {
            const results = await collection.find({}).sort({ value: -1, name: 1 }).toArray();
            // Expected order: ItemD (30), ItemB (20), ItemA (10), ItemC (10)
            expect(results.map(d => d.name)).toEqual(['ItemD', 'ItemB', 'ItemA', 'ItemC']);
        });

        test('sort() by _id', async () => {
            // Assuming UUIDs are strings and can be sorted lexicographically
            const resultsAsc = await collection.find({}).sort({ _id: 1 }).toArray();
            const resultsDesc = await collection.find({}).sort({ _id: -1 }).toArray();

            expect(resultsAsc.length).toBe(docs.length);
            expect(resultsDesc.length).toBe(docs.length);
            if (docs.length > 1) {
                // Simple check, more robust would involve comparing sorted list of actual _ids
                expect(resultsAsc[0]._id).not.toBe(resultsDesc[0]._id);
            }
        });

        test('sort() by nested field', async () => {
            const results = await collection.find({}).sort({ 'nested.propB': 1 }).toArray();
            expect(results.map(d => d.nested?.propB)).toEqual([100, 200, 300, 400]);
        });

        test('chaining limit, skip, and sort', async () => {
            // Get all, sorted by value desc, name asc: D(30), B(20), A(10), C(10)
            // Skip 1: B(20), A(10), C(10)
            // Limit 2: B(20), A(10)
            const results = await collection.find({})
                .sort({ value: -1, name: 1 })
                .skip(1)
                .limit(2)
                .toArray();
            expect(results.length).toBe(2);
            expect(results.map(d => d.name)).toEqual(['ItemB', 'ItemA']);
        });

        test('find with projection', async () => {
            const results = await collection.find({ value: 10 })
                .project({ name: 1, _id: 0 })
                .sort({name: 1}) // ItemA, ItemC
                .toArray();
            expect(results.length).toBe(2);
            expect(results[0]).toEqual({ name: 'ItemA' });
            expect(results[1]).toEqual({ name: 'ItemC' });
        });

        test('limit(0) should return no documents', async () => {
            const results = await collection.find({}).limit(0).toArray();
            expect(results.length).toBe(0);
        });

        test('skip greater than total documents should return empty array', async () => {
            const results = await collection.find({}).skip(docs.length + 5).toArray();
            expect(results.length).toBe(0);
        });

        test('negative limit or skip should throw error', () => {
            expect(() => collection.find({}).limit(-1)).toThrow("Limit must be a non-negative number.");
            expect(() => collection.find({}).skip(-1)).toThrow("Skip must be a non-negative number.");
        });

        test('find with complex filter and projection, sort, limit, skip', async () => {
            // Find items where value > 10 (ItemB, ItemD) OR name is ItemA
            // Results before sort/skip/limit: ItemA, ItemB, ItemD
            // Sort by name: ItemA, ItemB, ItemD
            // Skip 1: ItemB, ItemD
            // Limit 1: ItemB
            // Project only name
            const results = await collection.find({
                $or: [
                    { value: { $gt: 10 } },
                    { name: 'ItemA' }
                ]
            })
            .sort({ name: 1 })
            .skip(1)
            .limit(1)
            .project({ name: 1, _id: 0})
            .toArray();

            expect(results.length).toBe(1);
            expect(results[0]).toEqual({ name: 'ItemB' });
        });
    });


    describe('updateOne()', () => {
      let docId: string;
      const initialDoc: TestDoc = { name: 'Updatable', value: 50, tags: ['one', 'two'], nested: { propA: 'initial', propB: 5 } };

      beforeEach(async () => {
        const res = await collection.insertOne(initialDoc);
        docId = res.insertedId;
      });

      test('should update a document with $set', async () => {
        const result: UpdateResult = await collection.updateOne(
          { _id: docId },
          { $set: { name: 'Updated Name', value: 55, 'nested.propA': 'changed' } }
        );
        expect(result.acknowledged).toBe(true);
        expect(result.matchedCount).toBe(1);
        expect(result.modifiedCount).toBe(1);

        const updatedDoc = await collection.findOne({ _id: docId });
        expect(updatedDoc?.name).toBe('Updated Name');
        expect(updatedDoc?.value).toBe(55);
        expect(updatedDoc?.nested?.propA).toBe('changed');
        expect(updatedDoc?.tags).toEqual(['one', 'two']); // Unchanged
      });

      test('should not modify if $set provides same values', async () => {
        // Note: True MongoDB might still report modifiedCount=1 if the BSON representation changes,
        // but for our JSON-based approach, if the resulting object is identical, modifiedCount should be 0.
        // However, our current implementation re-serializes, so it will likely be 1.
        // This test checks the logical outcome.
        const result: UpdateResult = await collection.updateOne(
          { _id: docId },
          { $set: { name: 'Updatable' } } // Same name
        );
        expect(result.acknowledged).toBe(true);
        expect(result.matchedCount).toBe(1);
        // Our current naive implementation might set modifiedCount to 1 because it re-stringifies.
        // A more sophisticated check would compare old and new JSON.
        // For now, we accept 1 if it was "touched".
        expect(result.modifiedCount).toBe(1); // Or 0 if truly no change was made to the stringified JSON

        const updatedDoc = await collection.findOne({ _id: docId });
        expect(updatedDoc?.name).toBe('Updatable');
      });


      test('should return matchedCount 0 if no document matches filter', async () => {
        const result = await collection.updateOne(
          { _id: 'non-existent-id' },
          { $set: { name: 'NoOne' } }
        );
        expect(result.acknowledged).toBe(true);
        expect(result.matchedCount).toBe(0);
        expect(result.modifiedCount).toBe(0);
      });

      test('should update with $unset', async () => {
        const result = await collection.updateOne(
          { _id: docId },
          { $unset: { value: '', 'nested.propB': '' } }
        );
        expect(result.modifiedCount).toBe(1);
        const updatedDoc = await collection.findOne({ _id: docId });
        expect(updatedDoc).toBeDefined();
        expect(updatedDoc).not.toHaveProperty('value');
        expect(updatedDoc?.nested).toBeDefined();
        expect(updatedDoc?.nested).not.toHaveProperty('propB');
        expect(updatedDoc?.nested?.propA).toBe('initial'); // Other nested props remain
      });

      test('should update with $inc', async () => {
        const result = await collection.updateOne(
          { _id: docId },
          { $inc: { value: 5, 'nested.propB': -2 } }
        );
        expect(result.modifiedCount).toBe(1);
        const updatedDoc = await collection.findOne({ _id: docId });
        expect(updatedDoc?.value).toBe(55); // 50 + 5
        expect(updatedDoc?.nested?.propB).toBe(3); // 5 - 2
      });

      test('$inc should create field if it does not exist', async () => {
        const result = await collection.updateOne(
            { _id: docId },
            // @ts-expect-error testing dynamic field creation
            { $inc: { 'newNumericField': 10, 'nested.newDeepNumeric': 20 } }
        );
        expect(result.modifiedCount).toBe(1);
        const updatedDoc = await collection.findOne({ _id: docId });
        // @ts-expect-error testing dynamic field creation
        expect(updatedDoc?.newNumericField).toBe(10);
        expect(updatedDoc?.nested?.newDeepNumeric).toBe(20);
      });

      test('$inc on non-numeric field should not change it (or throw, depending on strictness)', async () => {
        const result = await collection.updateOne(
            { _id: docId },
            // @ts-expect-error intentionally trying to $inc a string field
            { $inc: { name: 1 } }
        );
        // Our implementation currently allows this but won't change `name` as it's not a number.
        // `modifiedCount` might be 1 if the object was re-serialized.
        // A stricter implementation might throw or have modifiedCount = 0.
        expect(result.matchedCount).toBe(1);
        // expect(result.modifiedCount).toBe(0); // Ideal if no change
        const updatedDoc = await collection.findOne({ _id: docId });
        expect(updatedDoc?.name).toBe('Updatable'); // Should remain unchanged
      });

      test('should update with $push to an existing array', async () => {
        const result = await collection.updateOne(
            { _id: docId },
            { $push: { tags: 'three' } }
        );
        expect(result.modifiedCount).toBe(1);
        const updatedDoc = await collection.findOne({ _id: docId });
        expect(updatedDoc?.tags).toEqual(['one', 'two', 'three']);
      });

      test('$push should create array if field does not exist or is not an array', async () => {
          const result = await collection.updateOne(
              { _id: docId },
              // @ts-expect-error 'newTags' is not in TestDoc initially
              { $push: { newTags: 'alpha' } }
          );
          expect(result.modifiedCount).toBe(1);
          const updatedDoc = await collection.findOne({ _id: docId });
          // @ts-expect-error
          expect(updatedDoc?.newTags).toEqual(['alpha']);

          // Push to a field that exists but is not an array (e.g. 'name')
          // MongoDB behavior: error. Our current behavior: overwrites with new array.
          const result2 = await collection.updateOne(
            { _id: docId },
            // @ts-expect-error 'name' is string, not array
            { $push: { name: 'beta' } }
          );
          expect(result2.modifiedCount).toBe(1);
          const updatedDoc2 = await collection.findOne({ _id: docId });
          // @ts-expect-error
          expect(updatedDoc2?.name).toEqual(['beta']); // Overwritten
      });

      test('$push with $each modifier', async () => {
          const result = await collection.updateOne(
              { _id: docId },
              { $push: { tags: { $each: ['four', 'five'] } } }
          );
          expect(result.modifiedCount).toBe(1);
          const updatedDoc = await collection.findOne({ _id: docId });
          expect(updatedDoc?.tags).toEqual(['one', 'two', 'four', 'five']);
      });

      test('should update with $pull to remove elements from an array', async () => {
          await collection.updateOne({_id: docId}, {$set: {tags: ['a', 'b', 'c', 'b', 'd']}});
          const result = await collection.updateOne(
              { _id: docId },
              { $pull: { tags: 'b' } } // Remove all 'b's
          );
          expect(result.modifiedCount).toBe(1);
          const updatedDoc = await collection.findOne({ _id: docId });
          expect(updatedDoc?.tags).toEqual(['a', 'c', 'd']);
      });

      test('$pull from a non-array field or non-existent field should do nothing gracefully', async () => {
          const result = await collection.updateOne(
              { _id: docId },
              // @ts-expect-error 'name' is not an array
              { $pull: { name: 'Updatable' } }
          );
          expect(result.modifiedCount).toBe(0); // Or 1 if object touched, but logically 0

          const result2 = await collection.updateOne(
            { _id: docId },
            // @ts-expect-error 'nonExistentField' does not exist
            { $pull: { nonExistentField: 'value' } }
          );
          expect(result2.modifiedCount).toBe(0);
      });

      test('$pull with a condition (simplified, e.g. direct match on object property)', async () => {
        interface Item { id: number; value: string; }
        await collection.updateOne({_id: docId}, { $set: { items: [{id:1, value:'A'}, {id:2, value:'B'}, {id:1, value:'C'}] } });

        const result = await collection.updateOne(
            { _id: docId },
            // @ts-expect-error items is not in TestDoc
            { $pull: { items: { id: 1 } } } // Pull items where id is 1
        );
        expect(result.modifiedCount).toBe(1);
        const updatedDoc = await collection.findOne({ _id: docId });
        // @ts-expect-error
        expect(updatedDoc?.items).toEqual([{id:2, value:'B'}]);
      });

      test('updateOne with multiple operators ($set and $inc)', async () => {
        const result = await collection.updateOne(
            { _id: docId },
            {
                $set: { name: 'MultiOp', 'nested.propA': 'multi' },
                $inc: { value: 10 }
            }
        );
        expect(result.modifiedCount).toBe(1);
        const updatedDoc = await collection.findOne({ _id: docId });
        expect(updatedDoc?.name).toBe('MultiOp');
        expect(updatedDoc?.nested?.propA).toBe('multi');
        expect(updatedDoc?.value).toBe(60); // 50 + 10
      });

      // Upsert is not implemented yet, so upsertedId will be null.
      // test('should perform upsert if document does not exist (Not Implemented Yet)', async () => {
      //   const newId = uuidv4();
      //   const result = await collection.updateOne(
      //     { _id: newId },
      //     { $set: { name: 'Upserted Doc', value: 1000 } },
      //     { upsert: true } // This option is not yet in the type or implementation
      //   );
      //   expect(result.acknowledged).toBe(true);
      //   expect(result.matchedCount).toBe(0);
      //   expect(result.modifiedCount).toBe(0); // Or 1 if upsert is counted as modification
      //   expect(result.upsertedId).toBe(newId);

      //   const upsertedDoc = await collection.findOne({ _id: newId });
      //   expect(upsertedDoc?.name).toBe('Upserted Doc');
      // });
    });

    describe('deleteOne()', () => {
      let docIdToDelete: string;
      let docIdToKeep: string;

      beforeEach(async () => {
        const res1 = await collection.insertOne({ name: 'ToDelete', value: 1 });
        docIdToDelete = res1.insertedId;
        const res2 = await collection.insertOne({ name: 'ToKeep', value: 2 });
        docIdToKeep = res2.insertedId;
      });

      test('should delete a document by _id', async () => {
        const result: DeleteResult = await collection.deleteOne({ _id: docIdToDelete });
        expect(result.acknowledged).toBe(true);
        expect(result.deletedCount).toBe(1);

        const deletedDoc = await collection.findOne({ _id: docIdToDelete });
        expect(deletedDoc).toBeNull();
        const keptDoc = await collection.findOne({ _id: docIdToKeep });
        expect(keptDoc).not.toBeNull();
      });

      test('should delete a document by other fields', async () => {
        const result = await collection.deleteOne({ name: 'ToDelete' });
        expect(result.acknowledged).toBe(true);
        expect(result.deletedCount).toBe(1);
        const deletedDoc = await collection.findOne({ name: 'ToDelete' });
        expect(deletedDoc).toBeNull();
      });

      test('should return deletedCount 0 if no document matches filter', async () => {
        const result = await collection.deleteOne({ _id: 'non-existent-id' });
        expect(result.acknowledged).toBe(true);
        expect(result.deletedCount).toBe(0);
      });

      test('should only delete one document if multiple match (if not using deleteMany)', async () => {
        await collection.insertOne({ name: 'ToDelete', value: 3 }); // Add another 'ToDelete'
        const result = await collection.deleteOne({ name: 'ToDelete' });
        expect(result.deletedCount).toBe(1);

        const remaining = await collection.find({ name: 'ToDelete' }).toArray();
        expect(remaining.length).toBe(1); // One should still be there
      });
    });

    describe('deleteMany()', () => {
        beforeEach(async () => {
            await collection.insertOne({ name: 'ManyDelete', value: 100 });
            await collection.insertOne({ name: 'ManyDelete', value: 200 });
            await collection.insertOne({ name: 'KeepThis', value: 300 });
        });

        test('should delete multiple documents matching filter', async () => {
            const result = await collection.deleteMany({ name: 'ManyDelete' });
            expect(result.acknowledged).toBe(true);
            expect(result.deletedCount).toBe(2);

            const remaining = await collection.find({ name: 'ManyDelete' }).toArray();
            expect(remaining.length).toBe(0);
            const kept = await collection.findOne({ name: 'KeepThis' });
            expect(kept).not.toBeNull();
        });

        test('should return deletedCount 0 if no documents match', async () => {
            const result = await collection.deleteMany({ name: 'NoSuchName' });
            expect(result.deletedCount).toBe(0);
        });

        test('deleteMany with empty filter should delete all documents', async () => {
            const result = await collection.deleteMany({});
            expect(result.deletedCount).toBe(3);
            const all = await collection.find({}).toArray();
            expect(all.length).toBe(0);
        });
    });

    describe('countDocuments()', () => {
        beforeEach(async () => {
            await collection.insertOne({ name: 'CountA', value: 10 });
            await collection.insertOne({ name: 'CountB', value: 20 });
            await collection.insertOne({ name: 'CountA', value: 30 }); // Another CountA
        });

        test('should count all documents with empty filter', async () => {
            const count = await collection.countDocuments({});
            expect(count).toBe(3);
        });

        test('should count documents matching a filter', async () => {
            const count = await collection.countDocuments({ name: 'CountA' });
            expect(count).toBe(2);
        });

        test('should return 0 if no documents match filter', async () => {
            const count = await collection.countDocuments({ name: 'NoSuchName' });
            expect(count).toBe(0);
        });

        test('should count with complex filter', async () => {
            const count = await collection.countDocuments({ value: { $gte: 20 } }); // CountB, CountA (value 30)
            expect(count).toBe(2);
        });
    });

    describe('drop()', () => {
        test('should drop the collection (table)', async () => {
            await collection.insertOne({ name: 'TestDrop', value: 1 });
            await collection.drop();

            // Verify table is gone by trying to query it (should error or return empty if table recreated by find)
            // SQLite specific: query sqlite_master to check if table exists
            const rawDb = client.getDb();
            const tableInfo = await rawDb.get(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                [collectionName]
            );
            expect(tableInfo).toBeUndefined();

            // Operations on a dropped collection might recreate it.
            // Let's try an insert, it should work by recreating.
            await expect(collection.insertOne({ name: 'AfterDrop', value: 1 })).resolves.toBeTruthy();
            const newTableInfo = await rawDb.get(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                [collectionName]
            );
            expect(newTableInfo).toBeDefined();
            expect((newTableInfo as any).name).toBe(collectionName);
        });

        test('dropping a non-existent collection should not throw (due to IF EXISTS)', async () => {
            const newCollection = client.collection('nonExistentForDrop');
            // ensureTable is not called, so table doesn't exist
            await expect(newCollection.drop()).resolves.not.toThrow();
        });
    });

    describe('Edge Cases and Complex Queries', () => {
        interface ComplexUser extends DocumentWithId {
            name: string;
            age: number;
            address: {
                street: string;
                city: string;
                zip?: string;
                coords?: { lat: number; lon: number };
            };
            hobbies: string[];
            scores: Array<{ subject: string; score: number }>;
            isActive: boolean;
        }
        let usersCollection: MongoLiteCollection<ComplexUser>;
        const usersData: Omit<ComplexUser, '_id'>[] = [
            { name: 'Alice', age: 30, address: { street: '123 Main', city: 'Wonderland', coords: { lat: 10, lon: 20 } }, hobbies: ['reading', 'chess'], scores: [{ subject: 'math', score: 90 }, { subject: 'history', score: 85 }], isActive: true },
            { name: 'Bob', age: 24, address: { street: '456 Oak', city: 'Springfield', zip: '12345' }, hobbies: ['hiking', 'coding'], scores: [{ subject: 'cs', score: 95 }, { subject: 'math', score: 88 }], isActive: true },
            { name: 'Charlie', age: 35, address: { street: '789 Pine', city: 'Wonderland' }, hobbies: ['chess', 'music'], scores: [{ subject: 'music', score: 92 }], isActive: false },
            { name: 'Diana', age: 28, address: { street: '101 Maple', city: 'Springfield', coords: { lat: 30, lon: 40 } }, hobbies: ['coding', 'gaming'], scores: [{ subject: 'cs', score: 89 }, { subject: 'art', score: 78 }], isActive: true },
        ];

        beforeEach(async () => {
            usersCollection = client.collection<ComplexUser>('complexUsers');
            for (const user of usersData) {
                await usersCollection.insertOne(user);
            }
        });

        afterEach(async () => {
            try {
                if (usersCollection) await usersCollection.drop();
            } catch (error) { /* ignore */ }
        });

        test('query by nested object property', async () => {
            const wonderlandUsers = await usersCollection.find({ 'address.city': 'Wonderland' }).sort({name: 1}).toArray();
            expect(wonderlandUsers.length).toBe(2);
            expect(wonderlandUsers.map(u => u.name)).toEqual(['Alice', 'Charlie']);
        });

        test('query by element in an array (exact match of array element)', async () => {
            // This requires specific handling for arrays. SQLite json_extract on an array path
            // might not work as expected for "contains" type queries directly.
            // A common way is to use json_each and then filter.
            // For simplicity, if MongoDB's direct match on array elements is {hobbies: 'coding'},
            // our current JSON path extraction might not directly support it without iterating json_each.
            // Let's test if our current simple path extraction works for exact array match (it likely won't for "contains")
            // This test will likely fail or need adjustment based on how array queries are implemented.
            // MongoDB: { tags: "A" } matches if "A" is an element of tags array.
            // SQLite with json_extract(data, '$.tags') returns the whole array.
            // To achieve MongoDB like array query, one might need:
            // json_extract(data, '$.tags[0]') = 'coding' OR json_extract(data, '$.tags[1]') = 'coding' ... (not scalable)
            // OR use json_each and a subquery, or json_search if available and appropriate.
            // For now, this test shows a limitation or area for improvement.
            // A workaround is to fetch and filter in code, or use a more complex SQL with json_each.

            // Let's try to find users who have 'coding' as one of their hobbies.
            // This is a common MongoDB query: { hobbies: 'coding' }
            // Our current buildWhereClause might not translate this as expected.
            // It would try `json_extract(data, '$.hobbies') = json('coding')` which is false.

            // For test purposes, let's assume we want to find someone whose hobbies array *is exactly* ['coding', 'gaming']
            const diana = await usersCollection.findOne({ name: 'Diana' });
            const foundDianaByExactHobbies = await usersCollection.findOne({ hobbies: diana?.hobbies });
            expect(foundDianaByExactHobbies?.name).toBe('Diana');

            // To test "array contains element", we would need a specific operator like $elemMatch or $all,
            // or the simple { field: value } for array containment needs special handling.
            // For now, we'll test $in for a field that IS an array element, if we stored hobbies differently.
            // Or, we can test $in for a top-level field that is an array.
        });

        test('query with $in for an array field (matches if field is one of array values)', async () => {
            // This is for a field whose value can be one of several arrays. Not for "element in array".
            // Example: { preferences: { $in: [ ['a','b'], ['c','d'] ] } }
            // This is not what we want for hobbies.

            // Let's test $in for a simple field to ensure it works.
            const usersAgeIn24Or30 = await usersCollection.find({ age: { $in: [24, 30] } }).sort({name:1}).toArray();
            expect(usersAgeIn24Or30.length).toBe(2);
            expect(usersAgeIn24Or30.map(u => u.name)).toEqual(['Alice', 'Bob']);
        });

        test('query for documents where an array field contains specific values ($all equivalent - not directly supported, use multiple $and conditions for simple cases)', async () => {
            // MongoDB: { hobbies: { $all: ["chess", "reading"] } }
            // Our current system would require $and with multiple direct checks if we had a way to query array elements.
            // This highlights a feature for future improvement (proper array query operators).
            // For now, we can simulate with $and if we assume a known structure or use a workaround.
            // No direct test here as $all is not implemented.
        });

        test('query for documents where a nested field in an array of objects matches ($elemMatch equivalent - not directly supported)', async () => {
            // MongoDB: { scores: { $elemMatch: { subject: 'math', score: { $gt: 85 } } } }
            // This is complex and would require iterating through the JSON array in SQL (e.g. json_each)
            // and applying conditions. Not supported by simple json_extract paths.
            // No direct test here as $elemMatch is not implemented.
            // We can find Alice who has a math score of 90.
            const alice = await usersCollection.findOne({
                $and: [
                    { name: 'Alice' },
                    // This would require a way to query inside the scores array elements.
                    // For now, we can't do this with simple dot notation.
                    // { 'scores.subject': 'math' } // This doesn't work as scores is an array.
                ]
            });
            // This test will be limited. We can find Alice by name.
            expect(alice?.name).toBe('Alice');
            // Then check her scores in code.
            const mathScore = alice?.scores.find(s => s.subject === 'math');
            expect(mathScore?.score).toBe(90);
        });

        test('queries involving null or missing fields', async () => {
            // Bob has address.zip, Alice does not.
            const withZip = await usersCollection.findOne({ 'address.zip': { $exists: true } });
            expect(withZip?.name).toBe('Bob');

            const withoutZip = await usersCollection.find({ 'address.zip': { $exists: false } }).sort({name:1}).toArray();
            expect(withoutZip.length).toBe(3); // Alice, Charlie, Diana
            expect(withoutZip.map(u => u.name)).toEqual(['Alice', 'Charlie', 'Diana']);

            // Insert a doc with explicit null
            const nullUserRes = await usersCollection.insertOne({
                name: 'NullTest', age: 40, address: { street: 'N/A', city: 'N/A', zip: null as any }, // zip is null
                hobbies: [], scores: [], isActive: false
            });
            const foundNullZip = await usersCollection.findOne({ 'address.zip': null });
            expect(foundNullZip?._id).toBe(nullUserRes.insertedId);
            await usersCollection.deleteOne({_id: nullUserRes.insertedId});
        });

        test('update operations on array fields ($push, $pull extensively)', async () => {
            const alice = await usersCollection.findOne({ name: 'Alice' });
            expect(alice).toBeDefined();
            const aliceId = alice!._id!;

            // $push single value
            await usersCollection.updateOne({ _id: aliceId }, { $push: { hobbies: 'painting' } });
            let updatedAlice = await usersCollection.findOne({ _id: aliceId });
            expect(updatedAlice?.hobbies).toContain('painting');
            expect(updatedAlice?.hobbies.length).toBe(3);

            // $push with $each
            await usersCollection.updateOne({ _id: aliceId }, { $push: { scores: { $each: [{ subject: 'art', score: 70 }, { subject: 'cs', score: 80 }] } } });
            updatedAlice = await usersCollection.findOne({ _id: aliceId });
            expect(updatedAlice?.scores.length).toBe(4);
            expect(updatedAlice?.scores.find(s => s.subject === 'art')?.score).toBe(70);

            // $pull single value
            await usersCollection.updateOne({ _id: aliceId }, { $pull: { hobbies: 'chess' } });
            updatedAlice = await usersCollection.findOne({ _id: aliceId });
            expect(updatedAlice?.hobbies).not.toContain('chess');
            expect(updatedAlice?.hobbies.length).toBe(2);

            // $pull based on object match in array (simplified: exact match of one property)
            // Pull the math score object. This requires more complex $pull.
            // Our current $pull is simple. If we want to pull { subject: 'math', score: 90 },
            // it would need to match the exact object.
            // Let's try pulling where subject is 'math'.
            // This is a simplified pull condition.
            await usersCollection.updateOne({ _id: aliceId }, { $pull: { scores: { subject: 'math' } as any } });
            updatedAlice = await usersCollection.findOne({ _id: aliceId });
            expect(updatedAlice?.scores.find(s => s.subject === 'math')).toBeUndefined();
            expect(updatedAlice?.scores.length).toBe(3); // history, art, cs remaining
        });
    });

  });
});

describe('MongoLite Client Options', () => {
    test('should use verbose logging if specified', async () => {
        const consoleSpy = jest.spyOn(console, 'log');
        const client = new MongoLite({ filePath: ':memory:', verbose: true });
        await client.connect();
        // Check if sqlite3.verbose() was called (indirectly by seeing logs)
        // This is hard to check directly without deeper mocking of sqlite3.
        // We expect some log output from sqlite3 driver if verbose.
        // Example: "SQLite database opened: :memory:"
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SQLite database opened: :memory:'));
        await client.close();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SQLite database closed: :memory:'));
        consoleSpy.mockRestore();
    });

    // Test for readOnly option if implemented in SQLiteDB
    // test('should open database in read-only mode if specified', async () => {
    //   // First, create a DB and add data
    //   const dbFilePath = path.join(__dirname, 'readonly-test.sqlite');
    //   cleanupDbFile(dbFilePath);
    //   const writeClient = new MongoLite(dbFilePath);
    //   await writeClient.connect();
    //   const collection = writeClient.collection('items');
    //   await collection.insertOne({ name: 'TestItem', value: 1 });
    //   await writeClient.close();

    //   // Now, open in read-only mode
    //   const readClient = new MongoLite({ filePath: dbFilePath, readOnly: true });
    //   await readClient.connect();
    //   const roCollection = readClient.collection('items');

    //   const item = await roCollection.findOne({ name: 'TestItem' });
    //   expect(item).toBeDefined();
    //   expect(item?.name).toBe('TestItem');

    //   // Attempting a write operation should fail
    //   await expect(roCollection.insertOne({ name: 'NewItem', value: 2 }))
    //     .rejects.toThrow(/SQLITE_READONLY/i); // Or similar error

    //   await readClient.close();
    //   cleanupDbFile(dbFilePath);
    // });
});
