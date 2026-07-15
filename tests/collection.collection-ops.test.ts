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
  active?: boolean;
}

describe('MongoLiteCollection - Collection Operations', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;

  const testDocs: TestDoc[] = [
    {
      _id: '1',
      name: 'Alice',
      value: 10,
      tags: ['admin', 'user'],
      category: 'A',
      score: 85,
      active: true,
    },
    { _id: '2', name: 'Bob', value: 20, tags: ['user'], category: 'B', score: 60, active: false },
    {
      _id: '3',
      name: 'Charlie',
      value: 30,
      tags: ['user', 'mod'],
      category: 'A',
      score: 90,
      active: true,
    },
    { _id: '4', name: 'Dave', value: 40, tags: ['admin'], category: 'C', score: 72, active: false },
    { _id: '5', name: 'Eve', value: 50, tags: ['user'], category: 'B', score: 45, active: true },
  ];

  beforeEach(async () => {
    client = new MongoLite(':memory:');
    await client.connect();
    collection = client.collection<TestDoc>('collectionOpsTest');
    for (const doc of testDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  describe('distinct()', () => {
    it('should return distinct values for a simple field', async () => {
      const categories = await collection.distinct('category');
      assert.deepStrictEqual((categories as string[]).sort(), ['A', 'B', 'C']);
    });

    it('should return distinct values from array fields', async () => {
      const tags = await collection.distinct('tags');
      const sorted = (tags as string[]).sort();
      assert.ok(sorted.includes('admin'));
      assert.ok(sorted.includes('user'));
      assert.ok(sorted.includes('mod'));
    });

    it('should respect a filter when one is provided', async () => {
      const categories = await collection.distinct('category', { active: true });
      // active docs: Alice (A), Charlie (A), Eve (B)
      assert.deepStrictEqual((categories as string[]).sort(), ['A', 'B']);
    });

    it('should return an empty array when no documents match', async () => {
      const result = await collection.distinct('category', { _id: 'nonexistent' });
      assert.deepStrictEqual(result, []);
    });
  });

  describe('estimatedDocumentCount()', () => {
    it('should return the total number of documents in the collection', async () => {
      const count = await collection.estimatedDocumentCount();
      assert.strictEqual(count, 5);
    });

    it('should return 0 for an empty collection', async () => {
      const db2 = new MongoLite(':memory:');
      await db2.connect();
      const col2 = db2.collection<TestDoc>('emptyCollection');
      await col2.ensureTable();
      const count = await col2.estimatedDocumentCount();
      assert.strictEqual(count, 0);
      await db2.close();
    });
  });

  describe('drop()', () => {
    it('should drop the collection table', async () => {
      await collection.drop();
      const collections = await client.listCollections().toArray();
      assert.ok(!collections.includes('collectionOpsTest'));
    });

    it('should not throw when dropping a table that does not exist', async () => {
      const db2 = new MongoLite(':memory:');
      await db2.connect();
      const col2 = db2.collection<TestDoc>('nonExistentTable');
      await assert.doesNotReject(() => col2.drop());
      await db2.close();
    });
  });
});
