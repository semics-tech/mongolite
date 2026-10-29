# Performance Benchmarks

_Last updated: 2026-10-29 (mongolite 1.6.0, `master` at 93be94f)_

## Environment and method

- **Hardware:** Linux arm64 container on an Apple-silicon host, 2 vCPUs, 4 GB RAM (a VM, so slower than bare metal; commit-bound rows suffer most)
- **Software:** Docker `node:24` image, Node.js v24.22.2, SQLite 3.53.4 via the built-in `node:sqlite` adapter (the default for a file path)
- **Command:** `npm run benchmark` (`scripts/benchmark.ts`), single run, single process
- **Dataset:** 10,000 documents (~450 bytes each: strings, numbers, a 3-element `tags` array, a nested `metadata` object), file-backed database
- **Timing:** wall-clock via `performance.now()` around a sequential `await` loop. Every operation is its own auto-committed statement: no explicit transaction, no batching, no warm-up, no repeated runs, so expect a few percent of run-to-run noise.
- **Indexes:** the `_INDEXED` rows run after `createIndex` on `age`, `metadata.version`, `active`, `score` and `tags`. `UPDATE` and `DELETE` run last, with those indexes present, but filter on `name`, which is **not** indexed, so each does a table scan.
- **Caveat:** the numbers published before 2026-10-20 (2025-07-27: `DELETE` 58 ops/s, `UPDATE` 164 ops/s) came from a different machine and an older version, so they are not comparable with these.

## Reproducing

```bash
git clone https://github.com/semics-tech/mongolite && cd mongolite
npm ci
npm run benchmark        # ~20 s; also writes scripts/benchmark-results.md (git-ignored)
```

Use Node 24.16+ (the repo's minimum) so the built-in `node:sqlite` adapter is the one measured. Expect the absolute numbers to move with your hardware. Earlier runs on a bare-metal Apple M1 (2026-10-20, mongolite 1.4.1 plus the `deleteOne` fix) gave higher write numbers (`INSERT_INDIVIDUAL` 8,099 to 10,933 ops/s, `UPDATE` about 1,900 ops/s, `DELETE` 6,920 ops/s), so the hardware matters more than the version. Those two M1 runs differed by about 26% on `INSERT_INDIVIDUAL`, the most commit-bound row. Treat single-run figures as indicative, not as guarantees.

## Operation Performance

| Operation                | Records Tested | Duration (ms) | Ops/Second | Avg Time/Op (ms) |
| ------------------------ | -------------- | ------------- | ---------- | ---------------- |
| INSERT_INDIVIDUAL        | 1,000          | 305.07        | 3278       | 0.305            |
| INSERT_BATCH             | 9,000          | 123.20        | 73051      | 0.014            |
| QUERY_SIMPLE_NO_INDEX    | 1,000          | 31.32         | 31928      | 0.031            |
| QUERY_COMPLEX_NO_INDEX   | 500            | 18.08         | 27650      | 0.036            |
| QUERY_ARRAY_NO_INDEX     | 500            | 17.57         | 28461      | 0.035            |
| QUERY_FIND_MANY_NO_INDEX | 100            | 53.66         | 1864       | 0.537            |
| QUERY_SIMPLE_INDEXED     | 1,000          | 26.67         | 37500      | 0.027            |
| QUERY_COMPLEX_INDEXED    | 500            | 19.01         | 26302      | 0.038            |
| QUERY_ARRAY_INDEXED      | 500            | 17.42         | 28700      | 0.035            |
| QUERY_FIND_MANY_INDEXED  | 100            | 51.43         | 1944       | 0.514            |
| UPDATE                   | 1,000          | 764.19        | 1309       | 0.764            |
| DELETE                   | 1,000          | 218.36        | 4580       | 0.218            |

Reading these numbers honestly:

- The query benchmarks use `findOne`, which stops at the first match. They barely differ with or without an index because a match is found within the first few rows. They measure per-call overhead, not scan cost. The `find().limit(100)` rows are the more representative read.
- `UPDATE` and `DELETE` filter on the unindexed `name` field and walk the table in order, so the Nth operation scans about N rows. Add an index on the field you filter by and the cost stays flat.
- The 2025 figures of 58 ops/s (`DELETE`) and 164 ops/s (`UPDATE`) are not a current problem: they predate the fix below and came from other hardware and an older version. The 2026-10-29 re-run measures 4,580 and 1,309 ops/s. The remaining gap versus reads is the benchmark's design (unindexed `name` filter, one commit per operation), not a bug.
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
