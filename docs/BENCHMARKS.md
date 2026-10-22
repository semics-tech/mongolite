# Performance Benchmarks

_Last updated: 2026-10-20 (mongolite 1.4.1 plus the `deleteOne` fix, now on `master`)_

## Environment and method

- **Hardware:** Apple M1 (arm64), 8 cores, 8 GB RAM, local SSD
- **Software:** macOS (Darwin 25.6), Node.js v24.21.0, SQLite 3.53.4 via the built-in `node:sqlite` adapter (the default for a file path)
- **Command:** `npm run benchmark` (`scripts/benchmark.ts`), single run, single process
- **Dataset:** 10,000 documents (~450 bytes each: strings, numbers, a 3-element `tags` array, a nested `metadata` object), file-backed database
- **Timing:** wall-clock via `performance.now()` around a sequential `await` loop. Every operation is its own auto-committed statement: no explicit transaction, no batching, no warm-up, no repeated runs, so expect a few percent of run-to-run noise.
- **Indexes:** the `_INDEXED` rows run after `createIndex` on `age`, `metadata.version`, `active`, `score` and `tags`. `UPDATE` and `DELETE` run last, with those indexes present, but filter on `name`, which is **not** indexed, so each does a table scan.
- **Caveat:** the old numbers (2025-07-27) came from a different machine and an older version, so they are not directly comparable.

## Reproducing

```bash
git clone https://github.com/semics-tech/mongolite && cd mongolite
npm ci
npm run benchmark        # ~20 s; also writes scripts/benchmark-results.md (git-ignored)
```

Use Node 24.16+ (the repo's minimum) so the built-in `node:sqlite` adapter is the one measured. Expect the absolute numbers to move with your hardware. A second full run on the same machine on 2026-10-20 reproduced every row within about 10%, except `INSERT_INDIVIDUAL` (8,099 ops/s versus 10,933 above) and `UPDATE` (1,865 versus 1,993 ops/s), which are dominated by per-statement commit cost and vary the most. Treat single-run figures as indicative, not as guarantees.

## Operation Performance

| Operation                | Records Tested | Duration (ms) | Ops/Second | Avg Time/Op (ms) |
| ------------------------ | -------------- | ------------- | ---------- | ---------------- |
| INSERT_INDIVIDUAL        | 1,000          | 91.46         | 10933      | 0.091            |
| INSERT_BATCH             | 9,000          | 110.44        | 81495      | 0.012            |
| QUERY_SIMPLE_NO_INDEX    | 1,000          | 23.39         | 42755      | 0.023            |
| QUERY_COMPLEX_NO_INDEX   | 500            | 15.48         | 32306      | 0.031            |
| QUERY_ARRAY_NO_INDEX     | 500            | 14.77         | 33842      | 0.030            |
| QUERY_FIND_MANY_NO_INDEX | 100            | 43.47         | 2300       | 0.435            |
| QUERY_SIMPLE_INDEXED     | 1,000          | 21.11         | 47373      | 0.021            |
| QUERY_COMPLEX_INDEXED    | 500            | 15.52         | 32221      | 0.031            |
| QUERY_ARRAY_INDEXED      | 500            | 14.60         | 34253      | 0.029            |
| QUERY_FIND_MANY_INDEXED  | 100            | 42.95         | 2329       | 0.429            |
| UPDATE                   | 1,000          | 501.75        | 1993       | 0.502            |
| DELETE                   | 1,000          | 144.52        | 6920       | 0.145            |

Reading these numbers honestly:

- The query benchmarks use `findOne`, which stops at the first match. They barely differ with or without an index because a match is found within the first few rows. They measure per-call overhead, not scan cost. The `find().limit(100)` rows are the more representative read.
- `UPDATE` and `DELETE` filter on the unindexed `name` field and walk the table in order, so the Nth operation scans about N rows. Add an index on the field you filter by and the cost stays flat.
- `DELETE` was 121 ops/s (8.2 ms/op) before the `deleteOne` fix (now merged): `deleteOne` ran an extra `SELECT COUNT(*) ... LIMIT 1` that scanned every matching row (`LIMIT` does not stop an aggregate). It now reads the statement's change count instead.

## Storage Capacity

| Records | Database Size (MB) | Avg Record Size (bytes) |
| ------- | ------------------ | ----------------------- |
| 1,000   | 0.38               | 397                     |
| 10,000  | 4.14               | 435                     |
| 50,000  | 21.35              | 448                     |
| 100,000 | 42.66              | 447                     |

## Notes

- **INSERT_INDIVIDUAL**: Individual `insertOne()` operations
- **INSERT_BATCH**: Batch insertions (`insertMany` or chunked `Promise.all`)
- **QUERY_SIMPLE_NO_INDEX**: Single field queries without indexes
- **QUERY_SIMPLE_INDEXED**: Single field queries with indexes
- **QUERY_COMPLEX_NO_INDEX**: Multi-field queries without indexes
- **QUERY_COMPLEX_INDEXED**: Multi-field queries with indexes
- **QUERY_ARRAY_NO_INDEX**: Array field queries without indexes
- **QUERY_ARRAY_INDEXED**: Array field queries with indexes
- **QUERY_FIND_MANY_NO_INDEX**: Batch queries returning up to 100 records without indexes
- **QUERY_FIND_MANY_INDEXED**: Batch queries returning up to 100 records with indexes
- **UPDATE**: Individual `updateOne()` operations with `$set`
- **DELETE**: Individual `deleteOne()` operations

## Performance Optimizations

- Batch inserts provide significant performance improvements over individual inserts
- Indexes dramatically improve query performance for filtered operations
- Complex queries benefit most from appropriate indexing
- Array field queries can be optimized with proper index strategies

## Storage Characteristics

- SQLite databases scale well with MongoLite
- Average record size includes JSON overhead and SQLite indexing
- Practical limits depend on available disk space and memory
- WAL mode provides better concurrent access for larger datasets
- Indexes add storage overhead but provide query performance benefits

## Recommendations

- Use batch operations for bulk data insertion
- Create indexes on frequently queried fields
- Monitor database file size growth with your specific data patterns
- Consider compound indexes for complex multi-field queries
