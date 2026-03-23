/**
 * Tests for the three MongoLite storage modes:
 *   1. Node.js file mode     – persists to a SQLite file on disk via better-sqlite3
 *   2. Node.js in-memory mode – ephemeral in-process database via better-sqlite3
 *   3. Browser / sql.js mode  – WebAssembly SQLite (SqlJsAdapter), usable in browsers
 *                               and testable in Node.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { MongoLite, SqlJsAdapter, DocumentWithId } from '../src/index.js';

interface TestDoc extends DocumentWithId {
  name: string;
  value: number;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCRUDSuite(client: MongoLite, label: string): Promise<void> {
  const col = client.collection<TestDoc>('storageModeTest');

  // insertOne
  const insertResult = await col.insertOne({ _id: `${label}-1`, name: 'Alice', value: 1 });
  assert.strictEqual(insertResult.acknowledged, true);
  assert.strictEqual(insertResult.insertedId, `${label}-1`);

  // insertMany
  const manyResult = await col.insertMany([
    { _id: `${label}-2`, name: 'Bob', value: 2 },
    { _id: `${label}-3`, name: 'Carol', value: 3, tags: ['a', 'b'] },
  ]);
  assert.strictEqual(manyResult.insertedCount, 2);

  // findOne
  const found = await col.findOne({ _id: `${label}-1` });
  assert.ok(found, 'findOne should return a document');
  assert.strictEqual(found?.name, 'Alice');

  // find (all)
  const all = await col.find({}).toArray();
  assert.strictEqual(all.length, 3);

  // updateOne
  const updateResult = await col.updateOne({ _id: `${label}-1` }, { $set: { value: 99 } });
  assert.strictEqual(updateResult.modifiedCount, 1);
  const updated = await col.findOne({ _id: `${label}-1` });
  assert.strictEqual(updated?.value, 99);

  // deleteOne
  const deleteResult = await col.deleteOne({ _id: `${label}-3` });
  assert.strictEqual(deleteResult.deletedCount, 1);
  const afterDelete = await col.find({}).toArray();
  assert.strictEqual(afterDelete.length, 2);

  // countDocuments
  const count = await col.countDocuments({});
  assert.strictEqual(count, 2);

  // listCollections
  const collections = await client.listCollections().toArray();
  assert.ok(collections.includes('storageModeTest'));
}

// ---------------------------------------------------------------------------
// Mode 1 – Node.js file mode (better-sqlite3, file on disk)
// ---------------------------------------------------------------------------

describe('Storage Modes - Node.js file mode', () => {
  let client: MongoLite;
  let dbPath: string;

  before(async () => {
    dbPath = path.join(os.tmpdir(), `mongolite-test-${Date.now()}-${process.pid}.db`);
    client = new MongoLite(dbPath);
    await client.connect();
  });

  after(async () => {
    await client.close();
    // Clean up the temp file
    try {
      fs.unlinkSync(dbPath);
      // WAL mode may create extra files
      const walFiles = [dbPath + '-wal', dbPath + '-shm'];
      for (const f of walFiles) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    } catch {
      // ignore cleanup errors
    }
  });

  it('should support full CRUD operations in file mode', async () => {
    await runCRUDSuite(client, 'file');
  });

  it('should persist data to disk (database file exists)', () => {
    assert.ok(fs.existsSync(dbPath), 'SQLite file should exist on disk');
  });
});

// ---------------------------------------------------------------------------
// Mode 2 – Node.js in-memory mode (better-sqlite3, :memory:)
// ---------------------------------------------------------------------------

describe('Storage Modes - Node.js in-memory mode', () => {
  let client: MongoLite;

  before(async () => {
    client = new MongoLite(':memory:');
    await client.connect();
  });

  after(async () => {
    await client.close();
  });

  it('should support full CRUD operations in in-memory mode', async () => {
    await runCRUDSuite(client, 'mem');
  });

  it('should start empty for each new :memory: instance', async () => {
    const freshClient = new MongoLite(':memory:');
    await freshClient.connect();
    const col = freshClient.collection<TestDoc>('emptyCheck');
    const count = await col.countDocuments({});
    assert.strictEqual(count, 0);
    await freshClient.close();
  });
});

// ---------------------------------------------------------------------------
// Mode 3 – Browser / sql.js adapter mode (SqlJsAdapter)
// ---------------------------------------------------------------------------

describe('Storage Modes - Browser/sql.js adapter mode', () => {
  let client: MongoLite;

  before(async () => {
    const adapter = new SqlJsAdapter();
    client = new MongoLite({ adapter });
    await client.connect();
  });

  after(async () => {
    await client.close();
  });

  it('should support full CRUD operations via SqlJsAdapter', async () => {
    await runCRUDSuite(client, 'sqljs');
  });

  it('should support the $regex query operator via sql.js UDF', async () => {
    const col = client.collection<TestDoc>('regexTest');
    await col.insertMany([
      { _id: 'r1', name: 'apple', value: 1 },
      { _id: 'r2', name: 'apricot', value: 2 },
      { _id: 'r3', name: 'banana', value: 3 },
    ]);
    const results = await col.find({ name: { $regex: '^ap' } }).toArray();
    assert.strictEqual(results.length, 2);
    assert.ok(results.every((d) => d.name.startsWith('ap')));
  });

  it('should handle transactions (BEGIN / COMMIT) correctly', async () => {
    const col = client.collection<TestDoc>('txTest');
    // insertMany internally uses a transaction
    await col.insertMany([
      { _id: 'tx1', name: 'Alpha', value: 10 },
      { _id: 'tx2', name: 'Beta', value: 20 },
    ]);
    const count = await col.countDocuments({});
    assert.strictEqual(count, 2);
  });

  it('should list collections correctly', async () => {
    const collections = await client.listCollections().toArray();
    assert.ok(Array.isArray(collections));
    // At least the collections created above should be present
    assert.ok(collections.includes('storageModeTest'));
  });

  it('SqlJsAdapter.export() should return a non-empty Uint8Array', async () => {
    const adapter = client.database;
    assert.ok(adapter instanceof SqlJsAdapter, 'database adapter should be a SqlJsAdapter');
    const exported = adapter.export();
    assert.ok(exported instanceof Uint8Array);
    assert.ok(exported.length > 0);
  });
});

// ---------------------------------------------------------------------------
// SqlJsAdapter – persistence helpers (in-memory re-load simulation)
// ---------------------------------------------------------------------------

describe('SqlJsAdapter - data re-load via export/import', () => {
  it('should preserve data when exported and re-imported', async () => {
    // First connection: insert data and export
    const adapter1 = new SqlJsAdapter();
    const client1 = new MongoLite({ adapter: adapter1 });
    await client1.connect();
    const col1 = client1.collection<TestDoc>('persistCheck');
    await col1.insertOne({ _id: 'p1', name: 'Persisted', value: 42 });
    const exported = adapter1.export();
    await client1.close();

    // Second connection: import from the exported bytes
    const adapter2 = new SqlJsAdapter();
    // Manually connect and initialise with exported data
    await adapter2.connect();
    // Rebuild from exported bytes by creating a fresh adapter seeded with data
    // (simulates what persistence backends do internally)
    // We test via a helper that creates a Database from existing data
    const { default: initSqlJs } = await import('sql.js');
    const SQL = await initSqlJs();
    const db3 = new SQL.Database(exported);
    // Verify the data is present in the re-loaded database
    const stmt = db3.prepare('SELECT * FROM persistCheck WHERE _id = ?');
    stmt.bind(['p1']);
    assert.ok(stmt.step(), 'Row should be found in re-loaded database');
    const row = stmt.getAsObject();
    assert.strictEqual(row['_id'], 'p1');
    const data = JSON.parse(row['data'] as string) as TestDoc;
    assert.strictEqual(data.name, 'Persisted');
    assert.strictEqual(data.value, 42);
    stmt.free();
    db3.close();
    await adapter2.close();
  });
});
