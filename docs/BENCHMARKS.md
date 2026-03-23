# Performance Benchmarks

*Last updated: 2025-07-27*

## Operation Performance

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

## Storage Capacity

| Records | Database Size (MB) | Avg Record Size (bytes) |
|---------|-------------------|------------------------|
| 1,000 | 0.44 | 459 |
| 10,000 | 4.27 | 448 |
| 50,000 | 21.36 | 448 |
| 100,000 | 42.75 | 448 |

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
