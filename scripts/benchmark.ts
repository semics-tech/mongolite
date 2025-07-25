#!/usr/bin/env npx tsx

import { MongoLite } from '../src/index.js';
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface BenchmarkResult {
  operation: string;
  recordCount: number;
  duration: number;
  opsPerSecond: number;
  avgTimePerOp: number;
}

interface StorageTest {
  recordCount: number;
  dbSizeBytes: number;
  dbSizeMB: number;
  avgRecordSize: number;
}

interface TestDocument {
  _id?: string;
  name: string;
  age: number;
  email: string;
  score: number;
  tags: string[];
  metadata: {
    created: Date;
    lastModified: Date;
    version: number;
    description: string;
  };
  active: boolean;
  [key: string]: unknown;
}

class MongoLiteBenchmark {
  private client: MongoLite;
  private dbPath: string;
  private collectionName = 'benchmark_collection';

  constructor() {
    this.dbPath = path.join(__dirname, 'benchmark.sqlite');
    this.client = new MongoLite(this.dbPath);
  }

  async cleanup() {
    try {
      await this.client.close();
      if (fs.existsSync(this.dbPath)) {
        fs.unlinkSync(this.dbPath);
      }
    } catch (error) {
      console.warn('Cleanup warning:', error);
    }
  }

  generateTestDocument(index: number): TestDocument {
    return {
      name: `User ${index}`,
      age: Math.floor(Math.random() * 80) + 18,
      email: `user${index}@example.com`,
      score: Math.random() * 100,
      tags: [`tag${index % 10}`, `category${index % 5}`, `type${index % 3}`],
      metadata: {
        created: new Date(),
        lastModified: new Date(),
        version: Math.floor(Math.random() * 10) + 1,
        description: `This is a test document with index ${index}. It contains various data types to simulate real-world usage patterns.`
      },
      active: index % 4 !== 0 // 75% active
    };
  }

  async benchmarkInserts(recordCount: number): Promise<BenchmarkResult[]> {
    const collection = this.client.collection<TestDocument>(this.collectionName);
    const documents = Array.from({ length: recordCount }, (_, i) => this.generateTestDocument(i));
    const results: BenchmarkResult[] = [];

    // Individual inserts
    const individualDocs = documents.slice(0, 1000); // Test with smaller set for individual
    let startTime = performance.now();

    for (const doc of individualDocs) {
      await collection.insertOne(doc);
    }

    let endTime = performance.now();
    let duration = endTime - startTime;

    results.push({
      operation: 'INSERT_INDIVIDUAL',
      recordCount: individualDocs.length,
      duration,
      opsPerSecond: individualDocs.length / (duration / 1000),
      avgTimePerOp: duration / individualDocs.length
    });

    // Batch inserts (if insertMany is available)
    try {
      const batchDocs = documents.slice(1000);
      startTime = performance.now();

      // Try insertMany if available, otherwise fall back to chunked insertOne
      if (typeof collection.insertMany === 'function') {
        await collection.insertMany(batchDocs);
      } else {
        // Batch in chunks of 100 for better performance
        const chunkSize = 100;
        for (let i = 0; i < batchDocs.length; i += chunkSize) {
          const chunk = batchDocs.slice(i, i + chunkSize);
          const promises = chunk.map(doc => collection.insertOne(doc));
          await Promise.all(promises);
        }
      }

      endTime = performance.now();
      duration = endTime - startTime;

      results.push({
        operation: 'INSERT_BATCH',
        recordCount: batchDocs.length,
        duration,
        opsPerSecond: batchDocs.length / (duration / 1000),
        avgTimePerOp: duration / batchDocs.length
      });
    } catch (error) {
      console.warn('Batch insert not available, using chunked individual inserts');
    }

    return results;
  }

  async createIndexes(): Promise<void> {
    const collection = this.client.collection<TestDocument>(this.collectionName);

    try {
      // Create indexes on commonly queried fields
      await collection.createIndex({ age: 1 });
      await collection.createIndex({ 'metadata.version': 1 });
      await collection.createIndex({ active: 1 });
      await collection.createIndex({ score: 1 });
      await collection.createIndex({ tags: 1 });
      console.log('✅ Indexes created successfully');
    } catch (error) {
      console.warn('⚠️  Index creation not available or failed:', error);
    }
  }

  async benchmarkQueries(recordCount: number, withIndexes: boolean = false): Promise<BenchmarkResult[]> {
    const collection = this.client.collection<TestDocument>(this.collectionName);
    const results: BenchmarkResult[] = [];
    const indexSuffix = withIndexes ? '_INDEXED' : '_NO_INDEX';

    // Simple field query
    let startTime = performance.now();
    for (let i = 0; i < 1000; i++) {
      await collection.findOne({ age: { $gte: 25 } });
    }
    let endTime = performance.now();
    let duration = endTime - startTime;
    results.push({
      operation: `QUERY_SIMPLE${indexSuffix}`,
      recordCount: 1000,
      duration,
      opsPerSecond: 1000 / (duration / 1000),
      avgTimePerOp: duration / 1000
    });

    // Complex nested query
    startTime = performance.now();
    for (let i = 0; i < 500; i++) {
      await collection.findOne({
        'metadata.version': { $gte: 5 },
        active: true,
        score: { $lt: 75 }
      });
    }
    endTime = performance.now();
    duration = endTime - startTime;
    results.push({
      operation: `QUERY_COMPLEX${indexSuffix}`,
      recordCount: 500,
      duration,
      opsPerSecond: 500 / (duration / 1000),
      avgTimePerOp: duration / 500
    });

    // Array query - use array index notation
    startTime = performance.now();
    for (let i = 0; i < 500; i++) {
      await collection.findOne({ 'tags[0]': 'tag5' });
    }
    endTime = performance.now();
    duration = endTime - startTime;
    results.push({
      operation: `QUERY_ARRAY${indexSuffix}`,
      recordCount: 500,
      duration,
      opsPerSecond: 500 / (duration / 1000),
      avgTimePerOp: duration / 500
    });

    // Find many (limit 100)
    startTime = performance.now();
    for (let i = 0; i < 100; i++) {
      const cursor = collection.find({ active: true });
      await cursor.limit(100).toArray();
    }
    endTime = performance.now();
    duration = endTime - startTime;
    results.push({
      operation: `QUERY_FIND_MANY${indexSuffix}`,
      recordCount: 100,
      duration,
      opsPerSecond: 100 / (duration / 1000),
      avgTimePerOp: duration / 100
    });

    return results;
  }

  async benchmarkUpdates(recordCount: number): Promise<BenchmarkResult> {
    const collection = this.client.collection<TestDocument>(this.collectionName);

    const startTime = performance.now();

    for (let i = 0; i < recordCount; i++) {
      await collection.updateOne(
        { name: `User ${i}` },
        { $set: { 'metadata.lastModified': new Date(), score: Math.random() * 100 } }
      );
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    return {
      operation: 'UPDATE',
      recordCount,
      duration,
      opsPerSecond: recordCount / (duration / 1000),
      avgTimePerOp: duration / recordCount
    };
  }

  async benchmarkDeletes(recordCount: number): Promise<BenchmarkResult> {
    const collection = this.client.collection<TestDocument>(this.collectionName);

    const startTime = performance.now();

    for (let i = 0; i < recordCount; i++) {
      await collection.deleteOne({ name: `User ${i}` });
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    return {
      operation: 'DELETE',
      recordCount,
      duration,
      opsPerSecond: recordCount / (duration / 1000),
      avgTimePerOp: duration / recordCount
    };
  }

  async testStorageLimits(): Promise<StorageTest[]> {
    const tests: StorageTest[] = [];
    const testSizes = [1000, 10000, 50000, 100000];

    for (const size of testSizes) {
      console.log(`Testing storage with ${size.toLocaleString()} records...`);

      // Clean start
      await this.cleanup();
      this.client = new MongoLite(this.dbPath);

      const collection = this.client.collection<TestDocument>(this.collectionName);

      // Insert records
      for (let i = 0; i < size; i++) {
        await collection.insertOne(this.generateTestDocument(i));
        if (i % 10000 === 0 && i > 0) {
          console.log(`  Inserted ${i.toLocaleString()} records...`);
        }
      }

      // Check file size
      const stats = fs.statSync(this.dbPath);
      const dbSizeBytes = stats.size;
      const dbSizeMB = dbSizeBytes / (1024 * 1024);
      const avgRecordSize = dbSizeBytes / size;

      tests.push({
        recordCount: size,
        dbSizeBytes,
        dbSizeMB,
        avgRecordSize
      });

      console.log(`  Database size: ${dbSizeMB.toFixed(2)} MB`);
    }

    return tests;
  }

  async runBenchmarks(): Promise<void> {
    console.log('🚀 Starting MongoLite Performance Benchmarks');
    console.log('===============================================\n');

    try {
      // Storage tests
      console.log('📊 Testing Storage Capacity and Size...');
      const storageTests = await this.testStorageLimits();

      // Performance tests with a reasonable dataset
      await this.cleanup();
      this.client = new MongoLite(this.dbPath);

      console.log('\n⚡ Running Performance Tests...');

      // Insert benchmark
      console.log('Testing INSERT performance...');
      const insertResults = await this.benchmarkInserts(10000);

      // Query benchmarks without indexes
      console.log('Testing QUERY performance (no indexes)...');
      const queryResultsNoIndex = await this.benchmarkQueries(10000, false);

      // Create indexes
      console.log('Creating indexes...');
      await this.createIndexes();

      // Query benchmarks with indexes
      console.log('Testing QUERY performance (with indexes)...');
      const queryResultsWithIndex = await this.benchmarkQueries(10000, true);

      // Update benchmark
      console.log('Testing UPDATE performance...');
      const updateResult = await this.benchmarkUpdates(1000);

      // Delete benchmark
      console.log('Testing DELETE performance...');
      const deleteResult = await this.benchmarkDeletes(1000);

      // Combine all results
      const allResults = [
        ...insertResults,
        ...queryResultsNoIndex,
        ...queryResultsWithIndex,
        updateResult,
        deleteResult
      ];

      // Generate results
      this.printResults(allResults, storageTests);

    } catch (error) {
      console.error('Benchmark failed:', error);
    } finally {
      await this.cleanup();
    }
  }

  private printResults(performanceResults: BenchmarkResult[], storageTests: StorageTest[]): void {
    console.log('\n📈 BENCHMARK RESULTS');
    console.log('====================\n');

    console.log('Performance Results:');
    console.log('-------------------');
    performanceResults.forEach(result => {
      console.log(`${result.operation.padEnd(15)} | ${result.recordCount.toString().padStart(8)} ops | ${result.duration.toFixed(2).padStart(8)} ms | ${result.opsPerSecond.toFixed(0).padStart(8)} ops/s | ${result.avgTimePerOp.toFixed(3).padStart(8)} ms/op`);
    });

    console.log('\nStorage Test Results:');
    console.log('--------------------');
    console.log('Records      | DB Size (MB) | Avg Record Size (bytes)');
    console.log('-------------|--------------|----------------------');
    storageTests.forEach(test => {
      console.log(`${test.recordCount.toLocaleString().padStart(12)} | ${test.dbSizeMB.toFixed(2).padStart(12)} | ${test.avgRecordSize.toFixed(0).padStart(22)}`);
    });

    // Generate markdown for README
    this.generateMarkdownResults(performanceResults, storageTests);
  }

  private generateMarkdownResults(performanceResults: BenchmarkResult[], storageTests: StorageTest[]): void {
    const markdown = `
## Performance Benchmarks

*Last updated: ${new Date().toISOString().split('T')[0]}*

### Operation Performance

| Operation | Records Tested | Duration (ms) | Ops/Second | Avg Time/Op (ms) |
|-----------|----------------|---------------|------------|------------------|
${performanceResults.map(r =>
      `| ${r.operation} | ${r.recordCount.toLocaleString()} | ${r.duration.toFixed(2)} | ${r.opsPerSecond.toFixed(0)} | ${r.avgTimePerOp.toFixed(3)} |`
    ).join('\n')}

### Storage Capacity

| Records | Database Size (MB) | Avg Record Size (bytes) |
|---------|-------------------|------------------------|
${storageTests.map(t =>
      `| ${t.recordCount.toLocaleString()} | ${t.dbSizeMB.toFixed(2)} | ${t.avgRecordSize.toFixed(0)} |`
    ).join('\n')}

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
`;

    fs.writeFileSync(path.join(__dirname, 'benchmark-results.md'), markdown.trim());
    console.log('\n✅ Benchmark results saved to scripts/benchmark-results.md');
    console.log('   You can copy this content to update your README.md');
  }
}

// Run benchmarks if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const benchmark = new MongoLiteBenchmark();
  benchmark.runBenchmarks().catch(console.error);
}

export { MongoLiteBenchmark };
