import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index';

interface TestDoc extends DocumentWithId {
  name: string;
  value: number;
  tags?: string[];
  category?: string;
  score?: number;
}

describe('MongoLiteCollection - Find-and-Modify Operations', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;

  const testDocs: TestDoc[] = [
    { _id: '1', name: 'Alice', value: 10, tags: ['admin', 'user'], category: 'A', score: 85 },
    { _id: '2', name: 'Bob', value: 20, tags: ['user'], category: 'B', score: 60 },
    { _id: '3', name: 'Charlie', value: 30, tags: ['user', 'mod'], category: 'A', score: 90 },
    { _id: '4', name: 'Dave', value: 40, tags: ['admin'], category: 'C', score: 72 },
    { _id: '5', name: 'Eve', value: 50, tags: ['user'], category: 'B', score: 45 },
  ];

  beforeEach(async () => {
    client = new MongoLite(':memory:');
    await client.connect();
    collection = client.collection<TestDoc>('findAndModifyTest');
    for (const doc of testDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  describe('findOneAndUpdate()', () => {
    it('should return the document before the update by default', async () => {
      const original = await collection.findOneAndUpdate({ _id: '1' }, { $set: { value: 999 } });
      assert.strictEqual(original?.value, 10);

      const updated = await collection.findOne({ _id: '1' });
      assert.strictEqual(updated?.value, 999);
    });

    it('should return the document after the update with returnDocument: "after"', async () => {
      const updated = await collection.findOneAndUpdate(
        { _id: '1' },
        { $set: { value: 999 } },
        { returnDocument: 'after' }
      );
      assert.strictEqual(updated?.value, 999);
    });

    it('should return null when no document matches', async () => {
      const result = await collection.findOneAndUpdate(
        { _id: 'nonexistent' },
        { $set: { value: 1 } }
      );
      assert.strictEqual(result, null);
    });

    it('should upsert and return the new document when upsert: true and no match', async () => {
      const result = await collection.findOneAndUpdate(
        { _id: 'new1' },
        { $set: { name: 'NewDoc', value: 0 } },
        { upsert: true, returnDocument: 'after' }
      );
      assert.ok(result, 'result should not be null for upsert');
    });

    it('should apply projection to the returned document', async () => {
      const doc = await collection.findOneAndUpdate(
        { _id: '1' },
        { $set: { value: 999 } },
        { returnDocument: 'before', projection: { name: 1 } }
      );
      assert.ok(doc?.name);
      assert.strictEqual(doc?.value, undefined);
    });
  });

  describe('findOneAndDelete()', () => {
    it('should delete the document and return the deleted document', async () => {
      const deleted = await collection.findOneAndDelete({ _id: '1' });
      assert.strictEqual(deleted?.name, 'Alice');

      const shouldBeGone = await collection.findOne({ _id: '1' });
      assert.strictEqual(shouldBeGone, null);
    });

    it('should return null when no document matches', async () => {
      const result = await collection.findOneAndDelete({ _id: 'nonexistent' });
      assert.strictEqual(result, null);
    });

    it('should apply projection to the returned document', async () => {
      const deleted = await collection.findOneAndDelete({ _id: '2' }, { projection: { name: 1 } });
      assert.ok(deleted?.name);
      assert.strictEqual(deleted?._id, '2');
      assert.strictEqual(deleted?.value, undefined);
    });
  });

  describe('findOneAndReplace()', () => {
    it('should replace the document and return the original by default', async () => {
      const original = await collection.findOneAndReplace(
        { _id: '1' },
        { name: 'Replaced', value: 0 }
      );
      assert.strictEqual(original?.name, 'Alice');

      const replaced = await collection.findOne({ _id: '1' });
      assert.strictEqual(replaced?.name, 'Replaced');
      assert.strictEqual(replaced?.value, 0);
    });

    it('should return the new document with returnDocument: "after"', async () => {
      const updated = await collection.findOneAndReplace(
        { _id: '1' },
        { name: 'Replaced', value: 0 },
        { returnDocument: 'after' }
      );
      assert.strictEqual(updated?.name, 'Replaced');
    });

    it('should return null when no document matches and upsert is false', async () => {
      const result = await collection.findOneAndReplace(
        { _id: 'nonexistent' },
        { name: 'Ghost', value: -1 }
      );
      assert.strictEqual(result, null);
    });
  });
});
