/**
 * Tests for the NodeSqliteAdapter, which backs MongoLite with Node.js's
 * built-in `node:sqlite` module instead of the `better-sqlite3` native addon.
 *
 * `node:sqlite` only exists on Node.js 22.5+, and CI runs this suite against
 * Node 20.x too — so both the module and the adapter are imported dynamically,
 * and the whole suite is skipped (not failed) when `node:sqlite` is unavailable.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite, DocumentWithId, MongoLiteCollection } from '../src/index.js';

interface TestDoc extends DocumentWithId {
  name: string;
  value: number;
}

let NodeSqliteAdapter: typeof import('../src/adapters/node-sqlite.js').NodeSqliteAdapter;
let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
let skipReason: string | false = false;

try {
  ({ DatabaseSync } = await import('node:sqlite'));
  ({ NodeSqliteAdapter } = await import('../src/adapters/node-sqlite.js'));
} catch {
  skipReason = 'requires node:sqlite (Node.js 22.5+)';
}

describe('NodeSqliteAdapter', { skip: skipReason }, () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;

  beforeEach(async () => {
    client = new MongoLite(new NodeSqliteAdapter(':memory:'));
    await client.connect();
    collection = client.collection<TestDoc>('testNodeSqliteCollection');
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

  it('exposes the underlying DatabaseSync via getDbInstance', async () => {
    const adapter = new NodeSqliteAdapter(':memory:');
    await adapter.connect();
    const db = await adapter.getDbInstance();
    assert.ok(db instanceof DatabaseSync);
    await adapter.close();
  });

  it('rejects writes when readOnly is set', async () => {
    const adapter = new NodeSqliteAdapter({ filePath: ':memory:', readOnly: true });
    await adapter.connect();
    await assert.rejects(() => adapter.exec('CREATE TABLE t (id INTEGER)'));
    await adapter.close();
  });
});
