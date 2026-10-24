# MongoDB Compatibility

MongoLite implements a **subset** of the MongoDB driver API on top of SQLite. This page lists what is supported, what is partial, and what is not, so you can decide before you migrate code. It was checked against the source and by running small pipelines against mongolite 1.4.1 (2026-10-20).

Legend: ✅ supported · ⚠️ partial (see note) · ❌ not supported

> **Note:** unknown aggregation stages, `$group` accumulators and expression operators **throw an error** rather than being ignored.

## Aggregation stages

| Stage                                                                                              | Status | Notes                                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `$match`                                                                                           | ⚠️     | Query operators as in the table below, plus `$expr`. Only a leading `$match` without `$expr` is pushed down to SQL                             |
| `$project`                                                                                         | ✅     | Inclusion, exclusion, `"$field"` renames and computed expressions (`{ $add: [...] }`)                                                          |
| `$addFields`, `$set`                                                                               | ✅     | Values are evaluated as expressions. `$set` is an alias                                                                                        |
| `$sort`                                                                                            | ✅     | Multiple keys, `1` / `-1`. In memory                                                                                                           |
| `$limit`, `$skip`                                                                                  | ✅     |                                                                                                                                                |
| `$count`                                                                                           | ✅     |                                                                                                                                                |
| `$group`                                                                                           | ⚠️     | `_id` may be `null`, a `"$field"` or an object of fields. Accumulators below                                                                   |
| `$unwind`                                                                                          | ✅     | String or `{ path, preserveNullAndEmptyArrays, includeArrayIndex }`                                                                            |
| `$lookup`                                                                                          | ⚠️     | Equality form (`from`, `localField`, `foreignField`, `as`) against another collection in the same database. The `pipeline` / `let` form throws |
| `$facet`, `$bucket`, `$bucketAuto`                                                                 | ❌     | Throws                                                                                                                                         |
| `$replaceRoot`, `$replaceWith`                                                                     | ✅     | `newRoot` must evaluate to an object                                                                                                           |
| `$sortByCount`, `$sample`, `$redact`, `$graphLookup`, `$geoNear`, `$setWindowFields`, `$unionWith` | ❌     | Throws                                                                                                                                         |
| `$out`, `$merge`                                                                                   | ❌     | Throws                                                                                                                                         |

Everything after the first stage runs in memory in JavaScript, so large pipelines load the matching documents into the process.

### `$group` accumulators

| Accumulator                                                     | Status | Notes                                                         |
| --------------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| `$sum`                                                          | ✅     | A number or any expression. Non-numeric values count as 0     |
| `$avg`, `$min`, `$max`                                          | ✅     | Any expression. `$avg` ignores non-numbers                    |
| `$push`, `$addToSet`                                            | ✅     | Any expression. `$addToSet` de-duplicates by value            |
| `$first`, `$last`                                               | ✅     | Order is the order of the preceding stages (no implicit sort) |
| `$count`                                                        | ✅     | Counts the documents in the group                             |
| `$stdDevPop`, `$stdDevSamp`, `$mergeObjects`, `$top`, `$bottom` | ❌     | Throws                                                        |

### Aggregation expressions

A common subset is evaluated in `$project`, `$addFields`, `$group`, `$replaceRoot` and `$match` `$expr`: field paths, `$$ROOT`, `$add`, `$subtract`, `$multiply`, `$divide`, `$mod`, `$concat`, `$toUpper`, `$toLower`, comparison and boolean operators, `$cond`, `$ifNull`, `$size`, `$arrayElemAt`, `$first`, `$last` and `$literal`: ✅. Other operators (for example `$dateToString`, `$map`, `$filter`) throw: ❌. If you need them, compute in application code after `toArray()`.

## Query filter operators (`find`, `findOne`, `$match`, counts, deletes)

| Operator                                                                                      | Status | Notes                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`                                                    | ✅     |                                                                                                                                                                                          |
| `$in`, `$nin`                                                                                 | ✅     |                                                                                                                                                                                          |
| `$and`, `$or`, `$nor`, `$not`                                                                 | ✅     |                                                                                                                                                                                          |
| `$exists`, `$type`, `$mod`, `$size`, `$all`                                                   | ✅     |                                                                                                                                                                                          |
| `$regex` (with `$options`)                                                                    | ✅     |                                                                                                                                                                                          |
| `$elemMatch`                                                                                  | ✅     | Sub-document conditions and the scalar form `{ $elemMatch: { $gt: 5, $lt: 10 } }`                                                                                                        |
| `$text`                                                                                       | ⚠️     | A case-insensitive-by-SQLite substring match (`LIKE %term%`) over the whole stored document, not MongoDB's text-index semantics (no text index, tokenising, scoring or language support) |
| `$where`, `$jsonSchema`, `$geoWithin`, `$near`, `$bitsAllSet` and other bitwise/geo operators | ❌     |                                                                                                                                                                                          |

## Update operators

| Operator                                                         | Status |
| ---------------------------------------------------------------- | ------ |
| `$set`, `$unset`, `$inc`, `$mul`, `$min`, `$max`, `$currentDate` | ✅     |
| `$push` (with `$each`), `$pull`, `$addToSet`, `$pop`             | ✅     |
| `$rename`, `$setOnInsert`, `$bit`                                | ❌     |
| Positional operators (`$`, `$[]`, `$[<id>]`) and `arrayFilters`  | ❌     |
| Pipeline-style updates (`update: [ { $set: ... } ]`)             | ❌     |

`upsert` is supported on `updateOne`, but an upserted document is built from `$set` only (other operators, and `$setOnInsert`, are not applied to it).

## Collection and client API

| Area                                                                                                                                                                     | Status | Notes                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insertOne`, `insertMany`, `findOne`, `find`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`, `countDocuments`, `estimatedDocumentCount`, `distinct` | ✅     |                                                                                                                                                                     |
| `findOneAndUpdate`, `findOneAndDelete`, `findOneAndReplace`                                                                                                              | ✅     |                                                                                                                                                                     |
| `createIndex`, `listIndexes`, `dropIndex`, `dropIndexes`                                                                                                                 | ⚠️     | Indexes are SQLite indexes on JSON paths. `unique` and `name` are supported; `sparse`, partial and TTL indexes are not                                              |
| `aggregate(...).toArray()`                                                                                                                                               | ⚠️     | Returns a handle with `toArray()` only (no `for await`, `next()` or `explain()`)                                                                                    |
| `watch()` change streams                                                                                                                                                 | ⚠️     | Local, in-process events only. See [CHANGE_STREAMS.md](./CHANGE_STREAMS.md)                                                                                         |
| `bulkWrite`, `initializeOrderedBulkOp`                                                                                                                                   | ❌     |                                                                                                                                                                     |
| Multi-document transactions (`startSession`, `withTransaction`)                                                                                                          | ⚠️     | Supported on the better-sqlite3, `node:sqlite` and sql.js adapters; the Cloudflare adapter throws "not supported yet". See below                                    |
| `withTransaction` retry on `TransientTransactionError` (`maxRetries`, experimental)                                                                                      | ⚠️     | Opt-in (default 0). Retries `SQLITE_BUSY`/`SQLITE_LOCKED` as `TransactionBusyError`; there is no `WriteConflict`, writers wait. The callback must be safe to re-run |
| Schema validation, collations, capped collections, GridFS, views, Atlas Search                                                                                           | ❌     |                                                                                                                                                                     |

## Transactions (partial: Node adapters, not Cloudflare)

```ts
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    await orders.insertOne({ sku: 'a' }, { session });
    await stock.updateOne({ sku: 'a' }, { $inc: { qty: -1 } }, { session });
  });
} finally {
  await session.endSession();
}
```

- **Supported:** `client.startSession()`, `client.withSession(fn)`, `session.withTransaction(fn)` (commits when `fn` resolves and returns its value; rolls back and rethrows when it throws), `startTransaction` / `commitTransaction` / `abortTransaction`, `inTransaction()`, `endSession()` (aborts an open transaction). Pass `{ session }` to collection methods to join the transaction. Works on better-sqlite3, `node:sqlite` and sql.js. The Cloudflare adapter throws `MongoLiteTransactionError: Transactions are not supported yet`.
- **How it works:** `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`, with a per-connection lock. While a transaction is open, operations without that session (including reads, change streams and the sync worker on the same client) wait until it ends, so they can never run inside or be rolled back by someone else's transaction. A wait longer than `transactionLockTimeoutMs` (default 5000, client option) fails with an error instead of hanging. `insertMany` inside a transaction uses a savepoint.
- **Differences from MongoDB:**
  - Isolation is serializable with a single writer: a concurrent writer or reader waits for the commit instead of getting a snapshot or a `WriteConflict` error.
  - A failed operation inside a transaction (for example a duplicate `_id`) aborts the whole transaction, as in MongoDB; later operations on the session throw until a new transaction starts.
  - `withTransaction` does not retry unless you pass `maxRetries` (experimental, default 0, max 10; `retryDelayMs` default 20, exponential backoff with jitter, capped at 500). `SQLITE_BUSY`/`SQLITE_LOCKED` from `BEGIN IMMEDIATE` or a statement throws `TransactionBusyError` (`code: 'SQLITE_BUSY'`, label `TransientTransactionError`, `retryable: true`); with `maxRetries` the callback is re-run from scratch, so it must be safe to re-run. Callback errors and non-busy commit errors are never retried, and `startTransaction()` is not retried. See [API.md](./API.md).
  - `readConcern`, `writeConcern` and `readPreference` options are accepted and ignored. Nested `withTransaction` on one session throws.
  - Transactions are ACID on one local database file. They are not distributed, and sync to MongoDB pushes documents idempotently rather than as one upstream transaction.
- **Not covered yet:** automatic retry by default, and change-stream and sync-outbox behaviour on rollback (both are written by SQLite triggers on the same connection, so they should roll back with the transaction, but there are no tests for it yet).
