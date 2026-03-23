# API Reference

## `MongoLite`

### `constructor(dbPathOrOptions: string | MongoLiteOptions)`

Creates a new `MongoLite` client instance.

- `dbPathOrOptions`: Either a string path to the SQLite database file (e.g., `'./mydb.sqlite'`, `':memory:'`) or an options object.
  - `MongoLiteOptions`:
    - `filePath`: string — Path to the SQLite database file.
    - `verbose?`: boolean — (Optional) Enable verbose logging from the `sqlite3` driver.

### `async connect(): Promise<void>`

Explicitly opens the database connection. Operations will automatically connect if the DB is not already open.

### `async close(): Promise<void>`

Closes the database connection.

### `listCollections(): Promise<string[]>`

Lists all collections (tables) in the database.

```typescript
const collections = await client.listCollections().toArray();
console.log('Available collections:', collections);
```

### `collection<T>(name: string): MongoLiteCollection<T>`

Gets a reference to a collection (table).

- `name`: The name of the collection.
- Returns a `MongoLiteCollection` instance.

---

## `MongoLiteCollection<T>`

Represents a collection and provides methods to interact with its documents. `T` is a generic type for your document structure, which must extend `DocumentWithId` (i.e., have an optional `_id: string` field).

### `async insertOne(doc): Promise<InsertOneResult>`

Inserts a single document. If `_id` is not provided, a UUID will be generated.

- Returns `{ acknowledged: boolean; insertedId: string }`.

### `async insertMany(docs): Promise<InsertManyResult>`

Inserts multiple documents in a single operation.

- Returns `{ acknowledged: boolean; insertedIds: string[] }`.

### `async findOne(filter): Promise<T | null>`

Finds a single document matching the filter. Returns `null` if not found.

### `find(filter): FindCursor<T>`

Finds multiple documents matching the filter. Returns a chainable `FindCursor`.

### `async updateOne(filter, update): Promise<UpdateResult>`

Updates a single document matching the filter.

- Returns `{ acknowledged: boolean; matchedCount: number; modifiedCount: number; upsertedId: string | null }`.

### `async updateMany(filter, update): Promise<UpdateResult>`

Updates all documents matching the filter.

### `async deleteOne(filter): Promise<DeleteResult>`

Deletes a single document matching the filter.

- Returns `{ acknowledged: boolean; deletedCount: number }`.

### `async deleteMany(filter): Promise<DeleteResult>`

Deletes all documents matching the filter.

### `async replaceOne(filter, replacement): Promise<UpdateResult>`

Replaces a single document matching the filter with the provided document.

### `async findOneAndUpdate(filter, update, options?): Promise<T | null>`

Finds a document, updates it, and returns the original or updated document.

### `async findOneAndDelete(filter, options?): Promise<T | null>`

Finds a document, deletes it, and returns the deleted document.

### `async findOneAndReplace(filter, replacement, options?): Promise<T | null>`

Finds a document, replaces it, and returns the original or new document.

### `async distinct(field, filter?): Promise<unknown[]>`

Returns an array of distinct values for the given field.

### `async countDocuments(filter?): Promise<number>`

Returns the count of documents matching the filter.

### `async estimatedDocumentCount(): Promise<number>`

Returns a fast estimate of the total document count.

### `async drop(): Promise<void>`

Drops the collection (deletes the underlying table).

### `async aggregate(pipeline): Promise<unknown[]>`

Runs an aggregation pipeline. Supported stages: `$match`, `$group`, `$sort`, `$limit`, `$skip`, `$project`, `$count`, `$unwind`.

### `watch(options?): ChangeStream<T>`

Opens a change stream to watch for changes on this collection.

See [CHANGE_STREAMS.md](./CHANGE_STREAMS.md) for full documentation.

---

## `FindCursor<T>`

Returned by `collection.find()`. Supports chaining before execution.

### `async toArray(): Promise<T[]>`

Fetches all matching documents into an array.

### `async next(): Promise<T | null>`

Returns the next document, or `null` when exhausted.

### `limit(count: number): FindCursor<T>`

Limits the number of documents returned.

### `skip(count: number): FindCursor<T>`

Skips the first N documents.

### `sort(sortCriteria): FindCursor<T>`

Sorts results. Example: `{ age: -1, name: 1 }` (1 = ascending, -1 = descending).

### `project(projection): FindCursor<T>`

Specifies which fields to include or exclude in results.

---

## Indexing

### `async createIndex(fieldOrSpec, options?): Promise<CreateIndexResult>`

Creates an index on the specified field(s).

- `fieldOrSpec`: A field name string or an index spec object, e.g. `{ name: 1, age: -1 }`.
- `options`:
  - `unique`: Enforce uniqueness.
  - `name`: Custom index name.
  - `sparse`: Ignore documents without the indexed field.
- Returns `{ acknowledged: boolean; name: string }`.

```typescript
// Simple index
await collection.createIndex({ name: 1 });

// Unique index
await collection.createIndex({ email: 1 }, { unique: true });

// Compound index
await collection.createIndex({ name: 1, age: -1 });

// Nested field index
await collection.createIndex({ 'address.city': 1 });
```

### `listIndexes(): { toArray: () => Promise<IndexInfo[]> }`

Lists all indexes on the collection. Each `IndexInfo` contains `name`, `key`, and `unique`.

### `async dropIndex(indexName: string): Promise<DropIndexResult>`

Drops the named index. Returns `{ acknowledged: boolean; name: string }`.

### `async dropIndexes(): Promise<{ acknowledged: boolean; droppedCount: number }>`

Drops all indexes except the one on `_id`.

---

## Query Operators

### Comparison

| Operator | Description |
|----------|-------------|
| `{ field: value }` or `{ field: { $eq: value } }` | Equals |
| `{ field: { $ne: value } }` | Not equals |
| `{ field: { $gt: value } }` | Greater than |
| `{ field: { $gte: value } }` | Greater than or equal |
| `{ field: { $lt: value } }` | Less than |
| `{ field: { $lte: value } }` | Less than or equal |
| `{ field: { $in: [v1, v2] } }` | In array |
| `{ field: { $nin: [v1, v2] } }` | Not in array |
| `{ field: { $regex: pattern } }` | Matches regular expression |
| `{ field: { $size: n } }` | Array has N elements |
| `{ field: { $type: typeName } }` | Field is of given type |
| `{ field: { $mod: [divisor, remainder] } }` | Modulo |

### Logical

| Operator | Description |
|----------|-------------|
| `{ $and: [f1, f2] }` | Logical AND |
| `{ $or: [f1, f2] }` | Logical OR |
| `{ $nor: [f1, f2] }` | Logical NOR |
| `{ field: { $not: expr } }` | Negates a single operator expression |

### Element

| Operator | Description |
|----------|-------------|
| `{ field: { $exists: boolean } }` | Field exists (or not) |

### Array

| Operator | Description |
|----------|-------------|
| `{ field: { $all: [v1, v2] } }` | Array contains all values |
| `{ field: { $elemMatch: query } }` | At least one element matches the query |

---

## Update Operators

| Operator | Description |
|----------|-------------|
| `$set` | Sets field values |
| `$unset` | Removes fields |
| `$inc` | Increments numeric fields |
| `$mul` | Multiplies numeric fields |
| `$min` | Sets field to minimum of current and given value |
| `$max` | Sets field to maximum of current and given value |
| `$push` | Appends a value to an array (supports `$each`) |
| `$pull` | Removes matching values from an array |
| `$addToSet` | Adds a value to an array only if it doesn't already exist |
| `$pop` | Removes the first (`-1`) or last (`1`) element of an array |
| `$currentDate` | Sets a field to the current date |

### Examples

```typescript
// $set and $inc
await collection.updateOne({ _id: id }, { $set: { name: 'Bob' }, $inc: { age: 1 } });

// $push with $each
await collection.updateOne({ _id: id }, { $push: { scores: { $each: [90, 92, 85] } } });

// $pull
await collection.updateOne({ _id: id }, { $pull: { scores: 0 } });

// $addToSet
await collection.updateOne({ _id: id }, { $addToSet: { tags: 'new-tag' } });
```
