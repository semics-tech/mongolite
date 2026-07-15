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

describe('MongoLiteCollection - Aggregate', () => {
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
    collection = client.collection<TestDoc>('aggregateTest');
    for (const doc of testDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  describe('$match stage', () => {
    it('should filter documents using $match', async () => {
      const results = await collection.aggregate([{ $match: { category: 'A' } }]).toArray();
      assert.strictEqual(results.length, 2);
      assert.ok(results.every((d) => d['category'] === 'A'));
    });

    it('should return an empty array when no documents match', async () => {
      const results = await collection.aggregate([{ $match: { _id: 'nonexistent' } }]).toArray();
      assert.strictEqual(results.length, 0);
    });
  });

  describe('$sort stage', () => {
    it('should sort documents in ascending order', async () => {
      const results = await collection.aggregate([{ $sort: { value: 1 } }]).toArray();
      assert.strictEqual(results[0]['value'], 10);
      assert.strictEqual(results[4]['value'], 50);
    });

    it('should sort documents in descending order', async () => {
      const results = await collection.aggregate([{ $sort: { value: -1 } }]).toArray();
      assert.strictEqual(results[0]['value'], 50);
      assert.strictEqual(results[4]['value'], 10);
    });
  });

  describe('$limit and $skip stages', () => {
    it('should limit the number of results', async () => {
      const results = await collection
        .aggregate([{ $sort: { value: 1 } }, { $limit: 2 }])
        .toArray();
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0]['value'], 10);
    });

    it('should skip the specified number of documents', async () => {
      const results = await collection.aggregate([{ $sort: { value: 1 } }, { $skip: 3 }]).toArray();
      assert.strictEqual(results.length, 2);
    });
  });

  describe('$count stage', () => {
    it('should count documents into a named field', async () => {
      const results = await collection.aggregate([{ $count: 'total' }]).toArray();
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]['total'], 5);
    });
  });

  describe('$group stage', () => {
    it('should group documents and compute $sum', async () => {
      const results = await collection
        .aggregate([{ $group: { _id: '$category', total: { $sum: '$value' } } }])
        .toArray();
      const catA = results.find((r) => r['_id'] === 'A');
      assert.ok(catA, 'Category A should exist');
      assert.strictEqual(catA!['total'], 40); // Alice(10) + Charlie(30)
    });

    it('should group documents and compute $avg', async () => {
      const results = await collection
        .aggregate([
          { $match: { category: 'A' } },
          { $group: { _id: '$category', avgScore: { $avg: '$score' } } },
        ])
        .toArray();
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]['avgScore'], 87.5); // (85 + 90) / 2
    });

    it('should group documents and compute $min and $max', async () => {
      const results = await collection
        .aggregate([
          { $group: { _id: null, minVal: { $min: '$value' }, maxVal: { $max: '$value' } } },
        ])
        .toArray();
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]['minVal'], 10);
      assert.strictEqual(results[0]['maxVal'], 50);
    });

    it('should group documents and collect values with $push', async () => {
      const results = await collection
        .aggregate([
          { $match: { category: 'B' } },
          { $group: { _id: '$category', names: { $push: '$name' } } },
        ])
        .toArray();
      assert.strictEqual(results.length, 1);
      assert.deepStrictEqual((results[0]['names'] as string[]).sort(), ['Bob', 'Eve']);
    });

    it('should group documents and return $first and $last values', async () => {
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
  });

  describe('$project stage', () => {
    it('should include only specified fields', async () => {
      const results = await collection
        .aggregate([{ $match: { _id: '1' } }, { $project: { name: 1, value: 1 } }])
        .toArray();
      assert.strictEqual(results.length, 1);
      assert.ok(results[0]['name']);
      assert.ok(results[0]['value'] !== undefined);
      assert.strictEqual(results[0]['category'], undefined);
    });
  });

  describe('$unwind stage', () => {
    it('should unwind an array field into separate documents', async () => {
      const results = await collection
        .aggregate([{ $match: { _id: '1' } }, { $unwind: '$tags' }])
        .toArray();
      // Alice has ['admin', 'user'] → 2 documents after unwind
      assert.strictEqual(results.length, 2);
    });
  });

  describe('$addFields stage', () => {
    it('should add new fields to documents', async () => {
      const results = await collection
        .aggregate([{ $match: { _id: '1' } }, { $addFields: { doubled: 20 } }])
        .toArray();
      assert.strictEqual(results[0]['doubled'], 20);
    });
  });

  describe('multi-stage pipeline', () => {
    it('should support chaining multiple stages together', async () => {
      const results = await collection
        .aggregate([
          { $match: { active: true } },
          { $sort: { score: -1 } },
          { $limit: 2 },
          { $project: { name: 1, score: 1 } },
        ])
        .toArray();
      assert.strictEqual(results.length, 2);
      // Active: Alice(85), Charlie(90), Eve(45) → sorted desc: Charlie, Alice → limit 2
      assert.strictEqual(results[0]['name'], 'Charlie');
      assert.strictEqual(results[1]['name'], 'Alice');
    });

    it('should apply $match after $unwind (not as an initial SQL optimisation)', async () => {
      // $unwind comes first, then $match — the $match must filter the unwound results,
      // not be pushed down to the initial SQL fetch
      const results = await collection
        .aggregate([{ $unwind: '$tags' }, { $match: { tags: 'admin' } }])
        .toArray();
      // Alice has 'admin', Dave has 'admin' → 2 rows after unwind+match
      assert.strictEqual(results.length, 2);
      assert.ok((results as Array<Record<string, unknown>>).every((r) => r['tags'] === 'admin'));
    });

    it('should group with an object _id and return the object (not a JSON string)', async () => {
      const results = await collection
        .aggregate([
          {
            $group: {
              _id: { category: '$category', active: '$active' },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray();
      // Each _id should be an object, not a stringified JSON
      for (const r of results as Array<Record<string, unknown>>) {
        assert.strictEqual(typeof r['_id'], 'object', '_id should be an object');
        assert.ok(r['_id'] !== null);
        assert.ok('category' in (r['_id'] as object));
        assert.ok('active' in (r['_id'] as object));
      }
    });
  });
});
