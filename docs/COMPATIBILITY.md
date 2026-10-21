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

| Area                                                                                                                                                                     | Status | Notes                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `insertOne`, `insertMany`, `findOne`, `find`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`, `countDocuments`, `estimatedDocumentCount`, `distinct` | ✅     |                                                                                                                        |
| `findOneAndUpdate`, `findOneAndDelete`, `findOneAndReplace`                                                                                                              | ✅     |                                                                                                                        |
| `createIndex`, `listIndexes`, `dropIndex`, `dropIndexes`                                                                                                                 | ⚠️     | Indexes are SQLite indexes on JSON paths. `unique` and `name` are supported; `sparse`, partial and TTL indexes are not |
| `aggregate(...).toArray()`                                                                                                                                               | ⚠️     | Returns a handle with `toArray()` only (no `for await`, `next()` or `explain()`)                                       |
| `watch()` change streams                                                                                                                                                 | ⚠️     | Local, in-process events only. See [CHANGE_STREAMS.md](./CHANGE_STREAMS.md)                                            |
| `bulkWrite`, `initializeOrderedBulkOp`                                                                                                                                   | ❌     |                                                                                                                        |
| Multi-document transactions (`startSession`, `withTransaction`)                                                                                                          | ❌     | Each write is atomic on its own; `insertMany` is one SQLite transaction. See below                                     |
| Schema validation, collations, capped collections, GridFS, views, Atlas Search                                                                                           | ❌     |                                                                                                                        |

## Transactions: feasibility note (spike, not implemented)

Findings from a time-boxed read of the code; nothing here is built.

- **SQLite can do it.** SQLite supports `BEGIN`/`COMMIT`/`ROLLBACK`, and `insertMany` already uses one. A single connection serialises writers, so isolation is simple (effectively serializable) for one process.
- **Sketch.** Add `client.startSession()` returning a session with `withTransaction(fn)`. Collection methods would accept `{ session }`; with a session they run on the session's connection inside `BEGIN IMMEDIATE`, and `withTransaction` commits on success and rolls back on throw. Nested calls would use `SAVEPOINT`.
- **Hard parts.**
  1. Interleaving: while a transaction is open on the shared connection, un-sessioned writes from other async tasks would land inside it. Needs a per-client async mutex or a second connection per session.
  2. Change streams and the sync outbox must emit only after `COMMIT` and discard on `ROLLBACK`.
  3. Adapter differences: `node:sqlite` and better-sqlite3 are synchronous and straightforward. The browser (sql.js) adapter works on an in-memory copy, and Cloudflare Durable Objects expose `transactionSync` / `storage.transaction` rather than raw `BEGIN`, so each adapter needs its own begin/commit/rollback.
  4. The existing `SQLITE_BUSY` retry wrapper must not retry inside an open transaction.
- **Rough size.** Node adapters only: a few days including tests. All adapters plus change-stream/outbox correctness: roughly a week or more.
- **Recommendation.** Not a launch blocker. Keep the docs explicit that there are no multi-document transactions, and consider a minimal `collection`-level `client.transaction(async () => ...)` for the Node adapters first.
