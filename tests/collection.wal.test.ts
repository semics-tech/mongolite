import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite, MongoLiteCollection, DocumentWithId } from '../src/index';
import fs from 'fs';

interface TestDoc extends DocumentWithId {
  name: string;
  value: number;
  timestamp: number;
}

// Test file path for the SQLite database
const TEST_DB_PATH = 'test-wal-mode.sqlite';

describe('MongoLiteCollection - WAL Mode Concurrency', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;

  beforeEach(async () => {
    // Remove the test database if it exists
    try {
      if (fs.existsSync(TEST_DB_PATH)) {
        fs.unlinkSync(TEST_DB_PATH);
      }
    } catch (err) {
      console.error('Error cleaning up test database:', err);
    }

    // Create client with WAL mode enabled
    client = new MongoLite({
      filePath: TEST_DB_PATH,
      verbose: true,
      WAL: true, // Enable Write-Ahead Logging
    });

    await client.connect();
    collection = client.collection<TestDoc>('testWalCollection');
  });

  afterEach(async () => {
    await client.close();

    // Clean up the test database
    try {
      if (fs.existsSync(TEST_DB_PATH)) {
        fs.unlinkSync(TEST_DB_PATH);
      }
      // Also clean up WAL and SHM files that might be created
      const walFile = `${TEST_DB_PATH}-wal`;
      const shmFile = `${TEST_DB_PATH}-shm`;
      if (fs.existsSync(walFile)) {
        fs.unlinkSync(walFile);
      }
      if (fs.existsSync(shmFile)) {
        fs.unlinkSync(shmFile);
      }
    } catch (err) {
      console.error('Error cleaning up test database files:', err);
    }
  });

  it('should allow concurrent inserts and reads without locking', async () => {
    const totalDocs = 500;
    const queryInterval = 10; // Query after every N inserts
    const results: { insertTime: number; queryTime: number; docCount: number }[] = [];

    // Insert initial documents for querying
    const initialDocs = 50;
    for (let i = 0; i < initialDocs; i++) {
      await collection.insertOne({
        name: `Doc ${i}`,
        value: i,
        timestamp: Date.now(),
      });
    }

    // Test concurrent operations
    for (let i = initialDocs; i < totalDocs; i++) {
      const startInsertTime = Date.now();

      // Insert a document
      await collection.insertOne({
        name: `Doc ${i}`,
        value: i,
        timestamp: startInsertTime,
      });

      const insertTime = Date.now() - startInsertTime;

      // Every queryInterval documents, perform a query to test concurrency
      if (i % queryInterval === 0) {
        const startQueryTime = Date.now();

        // Perform a query while inserts are happening
        const docs = await collection.find({}).toArray();
        const queryTime = Date.now() - startQueryTime;

        // Record the result
        results.push({
          insertTime,
          queryTime,
          docCount: docs.length,
        });

        // Verify that the query returned the expected number of documents
        assert.strictEqual(docs.length, i + 1, `Expected ${i + 1} documents, got ${docs.length}`);
      }
    }

    // Verify that we have the expected number of results
    const expectedResultsCount = Math.floor((totalDocs - initialDocs) / queryInterval) + 1;
    assert.ok(
      results.length > 0 && results.length <= expectedResultsCount,
      `Expected around ${expectedResultsCount} result entries, got ${results.length}`
    );

    // Log the average query and insert times for inspection
    const avgInsertTime = results.reduce((sum, r) => sum + r.insertTime, 0) / results.length;
    const avgQueryTime = results.reduce((sum, r) => sum + r.queryTime, 0) / results.length;

    console.log(`Average insert time: ${avgInsertTime}ms`);
    console.log(`Average query time: ${avgQueryTime}ms`);
  });

  it('should handle multiple concurrent readers without locking', async () => {
    // Insert a set of documents first
    const docsToInsert = 100;
    for (let i = 0; i < docsToInsert; i++) {
      await collection.insertOne({
        name: `Multi-read Doc ${i}`,
        value: i,
        timestamp: Date.now(),
      });
    }

    // Now test multiple concurrent readers
    const readers = 5;
    const readerPromises: Promise<boolean>[] = [];

    for (let i = 0; i < readers; i++) {
      readerPromises.push(
        (async () => {
          // Each reader will do multiple queries
          const queries = 10;
          for (let j = 0; j < queries; j++) {
            const docs = await collection
              .find({
                value: { $lt: 50 + j }, // Vary the query slightly for each iteration
              })
              .toArray();

            // Ensure we got valid results
            assert.ok(docs.length > 0, `Reader ${i}, query ${j} should return results`);
            assert.ok(
              docs.length <= docsToInsert,
              `Reader ${i}, query ${j} returned too many results`
            );
          }
          return true;
        })()
      );
    }

    // Wait for all readers to complete
    const results = await Promise.all(readerPromises);

    // Verify all readers completed successfully
    assert.strictEqual(
      results.filter((r) => r === true).length,
      readers,
      'All readers should complete successfully'
    );
  });

  it('should allow a writer and multiple readers to operate concurrently', async () => {
    // This test simulates a scenario with one writer constantly inserting
    // and multiple readers constantly querying

    // Counter to track successful operations
    let readsCompleted = 0;
    let writesCompleted = 0;
    const targetOperations = 50; // Total writes we want to complete

    // Writer function - continuously inserts documents
    const writerPromise = (async () => {
      for (let i = 0; i < targetOperations; i++) {
        await collection.insertOne({
          name: `Concurrent Doc ${i}`,
          value: i,
          timestamp: Date.now(),
        });
        writesCompleted++;

        // Small delay to allow readers to interleave
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();

    // Reader functions - continuously query the collection
    const readerCount = 3;
    const readerPromises = Array.from({ length: readerCount }).map((_, readerIndex) =>
      (async () => {
        while (writesCompleted < targetOperations) {
          const docs = await collection.find({}).toArray();

          // Verify we got a valid result (at least the documents written so far)
          assert.ok(
            docs.length <= writesCompleted,
            `Reader ${readerIndex} got ${docs.length} docs, but only ${writesCompleted} were written`
          );

          readsCompleted++;

          // Small delay to prevent readers from overwhelming the system
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })()
    );

    // Wait for writer and all readers to complete
    await Promise.all([writerPromise, ...readerPromises]);

    // Verify all operations completed
    assert.strictEqual(
      writesCompleted,
      targetOperations,
      `Expected ${targetOperations} writes, got ${writesCompleted}`
    );

    console.log(`Completed ${readsCompleted} reads while performing ${writesCompleted} writes`);
    assert.ok(readsCompleted > 0, 'Should have completed some reads');

    // Final verification - make sure we can read all the documents
    const finalDocs = await collection.find({}).toArray();
    assert.strictEqual(
      finalDocs.length,
      targetOperations,
      `Expected ${targetOperations} docs in final query, got ${finalDocs.length}`
    );
  });
});
