/**
 * Tests for the `better-sqlite3`-backed SQLiteDB adapter, exposed via the
 * `mongolite-ts/better-sqlite3` entry point.
 *
 * `better-sqlite3` is now an optional dependency and the default backend for
 * every other test in this suite is `NodeSqliteAdapter` (node:sqlite) — this
 * file is the dedicated coverage for the legacy native-addon path.
 *
 * `better-sqlite3` ships prebuilt binaries per platform/Node ABI; if it failed
 * to install (or wasn't installed, since it's optional), this whole suite is
 * skipped rather than failed.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { DocumentWithId, MongoLiteCollection } from '../src/index.js';

interface TestDoc extends DocumentWithId {
  name: string;
  value: number;
}

let MongoLite: typeof import('../src/better-sqlite3.js').MongoLite;
let SQLiteDB: typeof import('../src/better-sqlite3.js').SQLiteDB;
let skipReason: string | false = false;

try {
  ({ MongoLite, SQLiteDB } = await import('../src/better-sqlite3.js'));
} catch {
  skipReason = 'requires the optional better-sqlite3 dependency to be installed';
}

describe('better-sqlite3 (SQLiteDB) adapter', { skip: skipReason }, () => {
  let client: InstanceType<typeof MongoLite>;
  let collection: MongoLiteCollection<TestDoc>;

  beforeEach(async () => {
    client = new MongoLite(':memory:');
    await client.connect();
    collection = client.collection<TestDoc>('testBetterSqlite3Collection');
  });

  afterEach(async () => {
    await client.close();
  });

  it('inserts and finds a document', async () => {
    const result = await collection.insertOne({ _id: 'doc1', name: 'Alice', value: 42 });
    assert.strictEqual(result.acknowledged, true);
    assert.strictEqual(result.insertedId, 'doc1');

    const found = await collection.findOne({ _id: 'doc1' });
    assert.deepStrictEqual(found, { _id: 'doc1', name: 'Alice', value: 42 });
  });

  it('updates and deletes a document', async () => {
    await collection.insertOne({ _id: 'doc2', name: 'Bob', value: 1 });

    const updateResult = await collection.updateOne({ _id: 'doc2' }, { $set: { value: 2 } });
    assert.strictEqual(updateResult.modifiedCount, 1);

    const updated = await collection.findOne({ _id: 'doc2' });
    assert.strictEqual(updated?.value, 2);

    const deleteResult = await collection.deleteOne({ _id: 'doc2' });
    assert.strictEqual(deleteResult.deletedCount, 1);
    assert.strictEqual(await collection.findOne({ _id: 'doc2' }), null);
  });

  it('supports $regex queries via the registered regexp UDF', async () => {
    await collection.insertMany([
      { _id: 'a', name: 'Alice', value: 1 },
      { _id: 'b', name: 'Bob', value: 2 },
    ]);

    const results = await collection.find({ name: { $regex: '^A' } }).toArray();
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0]._id, 'a');
  });

  it('exposes the underlying better-sqlite3 Database via getDbInstance', async () => {
    const adapter = new SQLiteDB(':memory:');
    await adapter.connect();
    const db = await adapter.getDbInstance();
    assert.strictEqual(typeof db.prepare, 'function');
    await adapter.close();
  });

  it('rejects writes when readOnly is set on a non-existent file', async () => {
    const adapter = new SQLiteDB({
      filePath: '/nonexistent/path/should-not-exist.db',
      readOnly: true,
    });
    await assert.rejects(() => adapter.connect());
  });
});
