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
  nested?: { sub: string; num?: number };
  items?: Array<{ id: number; label: string }>;
  createdAt?: Date | string;
}

describe('MongoLiteCollection - MongoDB Parity', () => {
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
    collection = client.collection<TestDoc>('parityTest');
    for (const doc of testDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // insertMany result shape
  // ─────────────────────────────────────────────────────────────────────────
  describe('insertMany() result', () => {
    it('should return InsertManyResult with insertedCount and insertedIds', async () => {
      const db2 = new MongoLite(':memory:');
      await db2.connect();
      const col2 = db2.collection<TestDoc>('insertManyTest');
      const result = await col2.insertMany([
        { name: 'X', value: 1 },
        { name: 'Y', value: 2 },
        { name: 'Z', value: 3 },
      ]);
      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.insertedCount, 3);
      assert.ok(result.insertedIds[0]);
      assert.ok(result.insertedIds[1]);
      assert.ok(result.insertedIds[2]);
      await db2.close();
    });

    it('should return empty result for empty array', async () => {
      const db2 = new MongoLite(':memory:');
      await db2.connect();
      const col2 = db2.collection<TestDoc>('insertManyEmpty');
      const result = await col2.insertMany([]);
      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.insertedCount, 0);
      assert.deepStrictEqual(result.insertedIds, {});
      await db2.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // $regex operator
  // ─────────────────────────────────────────────────────────────────────────
  describe('$regex operator', () => {
    it('should match documents with $regex pattern string', async () => {
      const docs = await collection.find({ name: { $regex: '^A' } }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0].name, 'Alice');
    });

    it('should match documents with $regex and $options case-insensitive', async () => {
      const docs = await collection.find({ name: { $regex: 'alice', $options: 'i' } }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0].name, 'Alice');
    });

    it('should match documents with bare RegExp value', async () => {
      const docs = await collection.find({ name: /^[AB]/ }).toArray();
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d.name === 'Alice'));
      assert.ok(docs.some((d) => d.name === 'Bob'));
    });

    it('should match documents with case-insensitive RegExp', async () => {
      const docs = await collection.find({ name: /^eve$/i }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0].name, 'Eve');
    });

    it('should return no results when regex does not match', async () => {
      const docs = await collection.find({ name: { $regex: '^Z' } }).toArray();
      assert.strictEqual(docs.length, 0);
    });

    it('should work with $regex on nested fields', async () => {
      await collection.insertOne({
        _id: '99',
        name: 'Test',
        value: 99,
        nested: { sub: 'hello world' },
      });
      const docs = await collection.find({ 'nested.sub': { $regex: 'hello' } }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0]._id, '99');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // $size operator
  // ─────────────────────────────────────────────────────────────────────────
  describe('$size operator', () => {
    it('should match documents where array has exactly N elements', async () => {
      const docs = await collection.find({ tags: { $size: 2 } }).toArray();
      // Alice has ['admin','user'], Charlie has ['user','mod'] → 2 each
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d.name === 'Alice'));
      assert.ok(docs.some((d) => d.name === 'Charlie'));
    });

    it('should match documents where array has 1 element', async () => {
      const docs = await collection.find({ tags: { $size: 1 } }).toArray();
      // Bob, Dave, Eve have 1 tag each
      assert.strictEqual(docs.length, 3);
    });

    it('should return no results when no array matches the size', async () => {
      const docs = await collection.find({ tags: { $size: 5 } }).toArray();
      assert.strictEqual(docs.length, 0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // $type operator
  // ─────────────────────────────────────────────────────────────────────────
  describe('$type operator', () => {
    it('should match documents where field is a string (type 2)', async () => {
      const docs = await collection.find({ name: { $type: 2 } }).toArray();
      assert.strictEqual(docs.length, 5);
    });

    it('should match documents where field is a string (type "string")', async () => {
      const docs = await collection.find({ name: { $type: 'string' } }).toArray();
      assert.strictEqual(docs.length, 5);
    });

    it('should match documents where field is a number (type 1)', async () => {
      const docs = await collection.find({ value: { $type: 1 } }).toArray();
      assert.strictEqual(docs.length, 5);
    });

    it('should match documents where field is an array (type 4)', async () => {
      const docs = await collection.find({ tags: { $type: 4 } }).toArray();
      assert.strictEqual(docs.length, 5);
    });

    it('should match documents where field is a boolean (type 8)', async () => {
      const docs = await collection.find({ active: { $type: 8 } }).toArray();
      assert.strictEqual(docs.length, 5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // $mod operator
  // ─────────────────────────────────────────────────────────────────────────
  describe('$mod operator', () => {
    it('should match documents where value % 2 === 0 (even values)', async () => {
      const docs = await collection.find({ value: { $mod: [2, 0] } }).toArray();
      // Values: 10, 20, 30, 40, 50 → all even
      assert.strictEqual(docs.length, 5);
    });

    it('should match documents where value % 3 === 0', async () => {
      const docs = await collection.find({ value: { $mod: [3, 0] } }).toArray();
      // Values: 30 → only 30 is divisible by 3 among 10,20,30,40,50
      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0].value, 30);
    });

    it('should match documents where value % 10 === 0', async () => {
      const docs = await collection.find({ value: { $mod: [10, 0] } }).toArray();
      assert.strictEqual(docs.length, 5);
    });

    it('should match documents where value % 4 === 0', async () => {
      const docs = await collection.find({ value: { $mod: [4, 0] } }).toArray();
      // 20 and 40 are divisible by 4
      assert.strictEqual(docs.length, 2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // New update operators
  // ─────────────────────────────────────────────────────────────────────────
  describe('$addToSet operator', () => {
    it('should add an element to an array if not present', async () => {
      await collection.updateOne({ _id: '1' }, { $addToSet: { tags: 'newTag' } });
      const doc = await collection.findOne({ _id: '1' });
      assert.ok(doc?.tags?.includes('newTag'));
      assert.ok(doc?.tags?.includes('admin'));
    });

    it('should not add duplicate elements', async () => {
      await collection.updateOne({ _id: '1' }, { $addToSet: { tags: 'admin' } });
      const doc = await collection.findOne({ _id: '1' });
      const adminCount = doc?.tags?.filter((t) => t === 'admin').length;
      assert.strictEqual(adminCount, 1);
    });

    it('should create the array if it does not exist', async () => {
      await collection.updateOne({ _id: '1' }, { $unset: { tags: '' } });
      await collection.updateOne({ _id: '1' }, { $addToSet: { tags: 'newTag' } });
      const doc = await collection.findOne({ _id: '1' });
      assert.deepStrictEqual(doc?.tags, ['newTag']);
    });

    it('should support $each modifier', async () => {
      await collection.updateOne(
        { _id: '2' },
        { $addToSet: { tags: { $each: ['x', 'y', 'user'] } } }
      );
      const doc = await collection.findOne({ _id: '2' });
      assert.ok(doc?.tags?.includes('x'));
      assert.ok(doc?.tags?.includes('y'));
      const userCount = doc?.tags?.filter((t) => t === 'user').length;
      assert.strictEqual(userCount, 1); // 'user' should not be duplicated
    });
  });

  describe('$pop operator', () => {
    it('should remove the last element with $pop: 1', async () => {
      await collection.updateOne({ _id: '1' }, { $pop: { tags: 1 } });
      const doc = await collection.findOne({ _id: '1' });
      // Alice originally has ['admin', 'user'], remove last → ['admin']
      assert.deepStrictEqual(doc?.tags, ['admin']);
    });

    it('should remove the first element with $pop: -1', async () => {
      await collection.updateOne({ _id: '1' }, { $pop: { tags: -1 } });
      const doc = await collection.findOne({ _id: '1' });
      // Alice originally has ['admin', 'user'], remove first → ['user']
      assert.deepStrictEqual(doc?.tags, ['user']);
    });

    it('should work with updateMany', async () => {
      await collection.updateMany({ category: 'A' }, { $pop: { tags: 1 } });
      const alice = await collection.findOne({ _id: '1' });
      const charlie = await collection.findOne({ _id: '3' });
      assert.deepStrictEqual(alice?.tags, ['admin']);
      assert.deepStrictEqual(charlie?.tags, ['user']);
    });
  });

  describe('$mul operator', () => {
    it('should multiply a numeric field', async () => {
      await collection.updateOne({ _id: '1' }, { $mul: { value: 2 } });
      const doc = await collection.findOne({ _id: '1' });
      assert.strictEqual(doc?.value, 20);
    });

    it('should set field to 0 when multiplying non-existent field', async () => {
      await collection.updateOne({ _id: '1' }, { $mul: { score: 0 } });
      const doc = await collection.findOne({ _id: '1' });
      assert.strictEqual(doc?.score, 0);
    });

    it('should work with updateMany', async () => {
      await collection.updateMany({ category: 'A' }, { $mul: { value: 10 } });
      const alice = await collection.findOne({ _id: '1' });
      const charlie = await collection.findOne({ _id: '3' });
      assert.strictEqual(alice?.value, 100);
      assert.strictEqual(charlie?.value, 300);
    });
  });

  describe('$min operator', () => {
    it('should update field to the minimum value', async () => {
      await collection.updateOne({ _id: '1' }, { $min: { value: 5 } });
      const doc = await collection.findOne({ _id: '1' });
      assert.strictEqual(doc?.value, 5); // 5 < 10
    });

    it('should not update when existing value is already lower', async () => {
      await collection.updateOne({ _id: '1' }, { $min: { value: 100 } });
      const doc = await collection.findOne({ _id: '1' });
      assert.strictEqual(doc?.value, 10); // 10 < 100, keep 10
    });
  });

  describe('$max operator', () => {
    it('should update field to the maximum value', async () => {
      await collection.updateOne({ _id: '1' }, { $max: { value: 100 } });
      const doc = await collection.findOne({ _id: '1' });
      assert.strictEqual(doc?.value, 100); // 100 > 10
    });

    it('should not update when existing value is already higher', async () => {
      await collection.updateOne({ _id: '1' }, { $max: { value: 5 } });
      const doc = await collection.findOne({ _id: '1' });
      assert.strictEqual(doc?.value, 10); // 10 > 5, keep 10
    });
  });

  describe('$currentDate operator', () => {
    it('should set field to current date as ISO string', async () => {
      const beforeUpdate = new Date();
      await collection.updateOne({ _id: '1' }, { $currentDate: { createdAt: true } });
      const doc = await collection.findOne({ _id: '1' });
      assert.ok(doc?.createdAt, 'createdAt should be set');
      const afterUpdate = new Date();
      const setDate = new Date(doc!.createdAt as string);
      assert.ok(setDate >= beforeUpdate, 'set date should be >= beforeUpdate');
      assert.ok(setDate <= afterUpdate, 'set date should be <= afterUpdate');
    });

    it('should work with updateMany', async () => {
      await collection.updateMany({ category: 'A' }, { $currentDate: { createdAt: true } });
      const alice = await collection.findOne({ _id: '1' });
      const charlie = await collection.findOne({ _id: '3' });
      assert.ok(alice?.createdAt);
      assert.ok(charlie?.createdAt);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // findOneAndUpdate
  // ─────────────────────────────────────────────────────────────────────────
  describe('findOneAndUpdate()', () => {
    it('should return the document before update by default', async () => {
      const original = await collection.findOneAndUpdate({ _id: '1' }, { $set: { value: 999 } });
      assert.strictEqual(original?.value, 10); // before update
      const updated = await collection.findOne({ _id: '1' });
      assert.strictEqual(updated?.value, 999); // actually updated
    });

    it('should return the document after update with returnDocument: "after"', async () => {
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

    it('should upsert when upsert: true and no document matches', async () => {
      const result = await collection.findOneAndUpdate(
        { _id: 'new1' },
        { $set: { name: 'NewDoc', value: 0 } },
        { upsert: true, returnDocument: 'after' }
      );
      assert.ok(result, 'result should not be null for upsert');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // findOneAndDelete
  // ─────────────────────────────────────────────────────────────────────────
  describe('findOneAndDelete()', () => {
    it('should delete the document and return it', async () => {
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

  // ─────────────────────────────────────────────────────────────────────────
  // findOneAndReplace
  // ─────────────────────────────────────────────────────────────────────────
  describe('findOneAndReplace()', () => {
    it('should replace the document and return original by default', async () => {
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

  // ─────────────────────────────────────────────────────────────────────────
  // replaceOne
  // ─────────────────────────────────────────────────────────────────────────
  describe('replaceOne()', () => {
    it('should replace all fields of a matching document', async () => {
      const result = await collection.replaceOne({ _id: '1' }, { name: 'Replaced', value: 0 });
      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);
      assert.strictEqual(result.upsertedId, null);

      const doc = await collection.findOne({ _id: '1' });
      assert.strictEqual(doc?.name, 'Replaced');
      assert.strictEqual(doc?.value, 0);
      assert.strictEqual(doc?.category, undefined); // removed
    });

    it('should return matchedCount 0 when no document matches', async () => {
      const result = await collection.replaceOne({ _id: 'none' }, { name: 'X', value: 0 });
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
    });

    it('should upsert when upsert: true and no document matches', async () => {
      const result = await collection.replaceOne(
        { _id: 'upserted' },
        { name: 'Upserted', value: 999 },
        { upsert: true }
      );
      assert.strictEqual(result.matchedCount, 0);
      assert.ok(result.upsertedId);

      const doc = await collection.findOne({ _id: result.upsertedId! });
      assert.strictEqual(doc?.name, 'Upserted');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // distinct
  // ─────────────────────────────────────────────────────────────────────────
  describe('distinct()', () => {
    it('should return distinct values for a simple field', async () => {
      const categories = await collection.distinct('category');
      assert.deepStrictEqual(categories.sort(), ['A', 'B', 'C']);
    });

    it('should return distinct values from array fields', async () => {
      const tags = await collection.distinct('tags');
      const sorted = (tags as string[]).sort();
      assert.ok(sorted.includes('admin'));
      assert.ok(sorted.includes('user'));
      assert.ok(sorted.includes('mod'));
    });

    it('should respect a filter when provided', async () => {
      const categories = await collection.distinct('category', { active: true });
      // active docs: Alice (A), Charlie (A), Eve (B)
      assert.deepStrictEqual((categories as string[]).sort(), ['A', 'B']);
    });

    it('should return empty array when no documents match', async () => {
      const result = await collection.distinct('category', { _id: 'nonexistent' });
      assert.deepStrictEqual(result, []);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // estimatedDocumentCount
  // ─────────────────────────────────────────────────────────────────────────
  describe('estimatedDocumentCount()', () => {
    it('should return the total number of documents', async () => {
      const count = await collection.estimatedDocumentCount();
      assert.strictEqual(count, 5);
    });

    it('should return 0 for an empty collection', async () => {
      const db2 = new MongoLite(':memory:');
      await db2.connect();
      const col2 = db2.collection<TestDoc>('empty');
      await col2.ensureTable();
      const count = await col2.estimatedDocumentCount();
      assert.strictEqual(count, 0);
      await db2.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // drop
  // ─────────────────────────────────────────────────────────────────────────
  describe('drop()', () => {
    it('should drop the collection table', async () => {
      await collection.drop();
      // After dropping, trying to query should either throw or return empty
      // We try to ensure the table doesn't exist by checking listCollections
      const collections = await client.listCollections().toArray();
      assert.ok(!collections.includes('parityTest'));
    });

    it('should not throw if collection does not exist', async () => {
      const db2 = new MongoLite(':memory:');
      await db2.connect();
      const col2 = db2.collection<TestDoc>('nonExistentTable');
      // Should not throw
      await assert.doesNotReject(() => col2.drop());
      await db2.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // aggregate
  // ─────────────────────────────────────────────────────────────────────────
  describe('aggregate()', () => {
    it('should support $match stage', async () => {
      const results = await collection.aggregate([{ $match: { category: 'A' } }]).toArray();
      assert.strictEqual(results.length, 2);
      assert.ok(results.every((d) => d['category'] === 'A'));
    });

    it('should support $sort stage', async () => {
      const results = await collection.aggregate([{ $sort: { value: -1 } }]).toArray();
      assert.strictEqual(results[0]['value'], 50);
      assert.strictEqual(results[4]['value'], 10);
    });

    it('should support $limit stage', async () => {
      const results = await collection
        .aggregate([{ $sort: { value: 1 } }, { $limit: 2 }])
        .toArray();
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0]['value'], 10);
    });

    it('should support $skip stage', async () => {
      const results = await collection.aggregate([{ $sort: { value: 1 } }, { $skip: 3 }]).toArray();
      assert.strictEqual(results.length, 2);
    });

    it('should support $count stage', async () => {
      const results = await collection.aggregate([{ $count: 'total' }]).toArray();
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]['total'], 5);
    });

    it('should support $group with $sum', async () => {
      const results = await collection
        .aggregate([{ $group: { _id: '$category', total: { $sum: '$value' } } }])
        .toArray();
      const catA = results.find((r) => r['_id'] === 'A');
      assert.ok(catA, 'Category A should exist');
      assert.strictEqual(catA!['total'], 40); // Alice(10) + Charlie(30)
    });

    it('should support $group with $avg', async () => {
      const results = await collection
        .aggregate([
          { $match: { category: 'A' } },
          { $group: { _id: '$category', avgScore: { $avg: '$score' } } },
        ])
        .toArray();
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]['avgScore'], 87.5); // (85 + 90) / 2
    });

    it('should support $group with $min and $max', async () => {
      const results = await collection
        .aggregate([
          { $group: { _id: null, minVal: { $min: '$value' }, maxVal: { $max: '$value' } } },
        ])
        .toArray();
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]['minVal'], 10);
      assert.strictEqual(results[0]['maxVal'], 50);
    });

    it('should support $group with $push', async () => {
      const results = await collection
        .aggregate([
          { $match: { category: 'B' } },
          { $group: { _id: '$category', names: { $push: '$name' } } },
        ])
        .toArray();
      assert.strictEqual(results.length, 1);
      assert.deepStrictEqual((results[0]['names'] as string[]).sort(), ['Bob', 'Eve']);
    });

    it('should support $group with $first and $last', async () => {
      const results = await collection
        .aggregate([
          { $sort: { value: 1 } },
          { $group: { _id: '$category', first: { $first: '$name' }, last: { $last: '$name' } } },
        ])
        .toArray();
      const catA = results.find((r) => r['_id'] === 'A');
      assert.ok(catA);
      assert.strictEqual(catA!['first'], 'Alice');
      assert.strictEqual(catA!['last'], 'Charlie');
    });

    it('should support $project stage', async () => {
      const results = await collection
        .aggregate([{ $match: { _id: '1' } }, { $project: { name: 1, value: 1 } }])
        .toArray();
      assert.strictEqual(results.length, 1);
      assert.ok(results[0]['name']);
      assert.ok(results[0]['value'] !== undefined);
      assert.strictEqual(results[0]['category'], undefined);
    });

    it('should support $unwind stage', async () => {
      const results = await collection
        .aggregate([{ $match: { _id: '1' } }, { $unwind: '$tags' }])
        .toArray();
      // Alice has ['admin', 'user'] → 2 unwound documents
      assert.strictEqual(results.length, 2);
    });

    it('should support $addFields stage', async () => {
      const results = await collection
        .aggregate([{ $match: { _id: '1' } }, { $addFields: { doubled: 20 } }])
        .toArray();
      assert.strictEqual(results[0]['doubled'], 20);
    });

    it('should support multiple pipeline stages', async () => {
      const results = await collection
        .aggregate([
          { $match: { active: true } },
          { $sort: { score: -1 } },
          { $limit: 2 },
          { $project: { name: 1, score: 1 } },
        ])
        .toArray();
      assert.strictEqual(results.length, 2);
      // Active docs: Alice(85), Charlie(90), Eve(45) → sorted desc: Charlie, Alice → limit 2
      assert.strictEqual(results[0]['name'], 'Charlie');
      assert.strictEqual(results[1]['name'], 'Alice');
    });

    it('should return empty array for aggregate on empty match', async () => {
      const results = await collection.aggregate([{ $match: { _id: 'nonexistent' } }]).toArray();
      assert.strictEqual(results.length, 0);
    });
  });
});
