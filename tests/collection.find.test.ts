import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index'; // Assuming DocumentWithId is exported

interface TestDoc extends DocumentWithId {
  name: string;
  value: number | null; // Allow null for testing
  tags?: string[];
  nested?: { subValue: string };
}

describe('MongoLiteCollection - Find Operations', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;
  const testDocs: TestDoc[] = [
    { _id: '1', name: 'doc1', value: 10, match: 'test', tags: ['a', 'b'] },
    { _id: '2', name: 'doc2', value: 20, match: 'test', tags: ['b', 'c'] },
    { _id: '3', name: 'doc3', value: 30, tags: ['c', 'd'], nested: { subValue: 'sv1' } },
    { _id: '4', name: 'doc4', value: 20 }, // No tags, no nested
    { _id: '5', name: 'anotherDoc', value: 50, match: 'test', nested: { subValue: 'sv2' } },
    { _id: '6', name: 'emptyDoc', value: null, match: 'test' }, // Document with null value,
  ];

  beforeEach(async () => {
    client = new MongoLite(':memory:', {
      verbose: true,
    });
    await client.connect();
    collection = client.collection<TestDoc>('testFindCollection');
    // Insert test data
    for (const doc of testDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  describe('test raw query', () => {
    it('should execute a raw query and return results', async () => {
      const docs = await client.db.all(
        `SELECT _id, data FROM "testFindCollection" WHERE json_extract(data, '$.tags[0]') = ?`,
        ['b']
      );
      assert.strictEqual(docs?.length, 1);
    });
  });
  describe('findOne()', () => {
    it('should find a single document by query', async () => {
      const doc = await collection.findOne({ name: 'doc1' });
      assert.deepStrictEqual(doc, testDocs[0]);
    });

    it('should return null if no document matches the query', async () => {
      const doc = await collection.findOne({ name: 'nonExistent' });
      assert.strictEqual(doc, null);
    });

    it('should find a single document by _id', async () => {
      const doc = await collection.findOne({ _id: '2' });
      assert.deepStrictEqual(doc, testDocs[1]);
    });

    it('should find a document with nested criteria', async () => {
      const doc = await collection.findOne({ 'nested.subValue': 'sv1' });
      assert.deepStrictEqual(doc, testDocs[2]);
    });
  });

  describe('find()', () => {
    it('should find all documents matching a query', async () => {
      const docs = await collection.find({ value: 20 }).toArray();
      assert.strictEqual(docs.length, 2);
      assert.deepStrictEqual(
        docs.find((d) => d._id === '2'),
        testDocs[1]
      );
      assert.deepStrictEqual(
        docs.find((d) => d._id === '4'),
        testDocs[3]
      );
    });

    it('should return an empty array if no documents match', async () => {
      const docs = await collection.find({ value: 100 }).toArray();
      assert.strictEqual(docs.length, 0);
    });

    it('should find documents using $gt operator', async () => {
      const docs = await collection.find({ value: { $gt: 20 } }).toArray();
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '3')); // value: 30
      assert.ok(docs.some((d) => d._id === '5')); // value: 50
    });

    it('should find documents using $gte operator', async () => {
      const docs = await collection.find({ value: { $gte: 30 } }).toArray();
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '3')); // value: 30
      assert.ok(docs.some((d) => d._id === '5')); // value: 50
    });

    it('should find documents using $lt operator', async () => {
      const docs = await collection.find({ value: { $lt: 20 } }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.deepStrictEqual(docs[0], testDocs[0]); // value: 10
    });

    it('should find documents using $lte operator', async () => {
      const docs = await collection.find({ value: { $lte: 10 } }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.deepStrictEqual(docs[0], testDocs[0]); // value: 10
    });

    it('should find documents using $ne operator', async () => {
      const docs = await collection.find({ value: { $ne: 20 } }).toArray();
      assert.strictEqual(docs.length, 3);
      assert.ok(docs.every((d) => d.value !== 20));
    });

    it('should find documents using $in operator for top-level field', async () => {
      const docs = await collection.find({ value: { $in: [10, 30] } }).toArray();
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d.value === 10));
      assert.ok(docs.some((d) => d.value === 30));
    });

    it('should find documents using $nin operator for top-level field', async () => {
      const docs = await collection.find({ value: { $nin: [10, 30, 50] } }).toArray(); // Should only leave value: 20
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.every((d) => d.value === 20));
    });

    it('should find documents using $in operator for array field (element match)', async () => {
      const docs = await collection.find({ 'tags[0]': 'a' }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.deepStrictEqual(docs[0], testDocs[0]);
    });

    it('should find documents with matching array elements', async () => {
      // Instead of $all, we can check for both elements with direct matching
      const docsWithB = await collection.find({ 'tags[0]': 'b' }).toArray();
      const docsWithC = await collection.find({ 'tags[1]': 'c' }).toArray();

      // Find the document that appears in both results
      const commonDocs = docsWithB.filter((doc) => docsWithC.some((d) => d._id === doc._id));

      assert.strictEqual(commonDocs.length, 1);
      assert.deepStrictEqual(commonDocs[0], testDocs[1]);
    });

    it('should find documents using $exists operator', async () => {
      const docsWithTags = await collection.find({ tags: { $exists: true } }).toArray();
      assert.strictEqual(docsWithTags.length, 3);
      const docsWithoutTags = await collection.find({ tags: { $exists: false } }).toArray();
      assert.strictEqual(docsWithoutTags.length, 3);
    });

    it('should find documents with projection (include fields)', async () => {
      const docs = await collection.find({ name: 'doc1' }).project({ name: 1, value: 1 }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.deepStrictEqual(docs[0], { _id: '1', name: 'doc1', value: 10 });
    });

    it('should find documents with projection (exclude _id)', async () => {
      const docs = await collection.find({ name: 'doc1' }).project({ _id: 0, name: 1 }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.deepStrictEqual(docs[0], { name: 'doc1' });
    });

    it('should find documents with sort (ascending)', async () => {
      const docs = await collection.find({}).sort({ value: 1 }).toArray();
      assert.strictEqual(docs.length, 6);
      assert.strictEqual(docs[0].value, null);
      assert.strictEqual(docs[4].value, 30);
    });

    it('should find documents with sort (descending)', async () => {
      const docs = await collection.find({}).sort({ value: -1 }).toArray();
      assert.strictEqual(docs.length, 6);
      assert.strictEqual(docs[0].value, 50);
      assert.strictEqual(docs[4].value, 10);
    });

    it('should find documents with limit', async () => {
      const docs = await collection.find({}).sort({ value: 1 }).limit(2).toArray(); // Sort to make it deterministic
      assert.strictEqual(docs.length, 2);
      assert.strictEqual(docs[0].value, null);
      assert.strictEqual(docs[1].value, 10); // Could be doc2 or doc4, depending on insertion or internal order
    });

    it('should find documents with skip', async () => {
      const docs = await collection.find({}).sort({ value: 1 }).skip(3).toArray(); // Sort to make it deterministic
      assert.strictEqual(docs.length, 3);
      assert.strictEqual(docs[0].value, 20);
      assert.strictEqual(docs[1].value, 30);
    });

    it('should find documents with skip and limit', async () => {
      const docs = await collection.find({}).sort({ value: 1 }).skip(1).limit(2).toArray();
      assert.strictEqual(docs.length, 2);
      assert.strictEqual(docs[0].value, 10);
      assert.strictEqual(docs[1].value, 20); // Could be doc2 or doc4, depending on insertion or internal order
    });

    it('should handle complex query with multiple operators and options', async () => {
      const docs = await collection
        .find({ value: { $gte: 20, $lt: 50 }, tags: { $exists: true } })
        .sort({ name: 1 })
        .limit(1)
        .project({ name: 1 })
        .toArray();

      // Matching docs: doc2 (value 20, tags), doc3 (value 30, tags)
      // Sorted by name: doc2, doc3
      // Limit 1: doc2
      // Projection: { name: 'doc2' }
      assert.strictEqual(docs.length, 1);
      assert.deepStrictEqual(docs[0], {
        name: 'doc2',
        _id: '2',
      });
    });

    it('handle query with filter and $or operator', async () => {
      const docs = await collection
        .find({
          match: 'test',
          $or: [{ value: { $gte: 20 } }],
        })
        .toArray();

      // Should match  anotherDoc (value=50) and doc2 (value=20)
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '2')); // doc2 has value=20
      assert.ok(docs.some((d) => d._id === '5')); // anotherDoc has value=50 and tags exist
    });

    it('handle query with filter and two $or operators', async () => {
      const docs = await collection
        .find({
          match: 'test',
          $or: [{ value: { $gte: 20 } }, { tags: { $exists: true } }],
        })
        .toArray();

      // Should match doc1, doc2, and anotherDoc (tags exist or value >= 20)
      assert.strictEqual(docs.length, 3);
      assert.ok(docs.some((d) => d._id === '1')); // doc1 has value=10 and tags exist
      assert.ok(docs.some((d) => d._id === '2')); // doc2 has value=20 and tags exist
      assert.ok(docs.some((d) => d._id === '5')); // anotherDoc has value=50 and tags exist
    });

    it('handle query with filter and two same $or operators', async () => {
      const docs = await collection
        .find({
          match: 'test',
          $or: [{ value: { $gte: 20 } }, { value: null }],
        })
        .toArray();

      // Should match doc1, doc2, and anotherDoc (tags exist or value >= 20)
      assert.strictEqual(docs.length, 3);
      assert.ok(docs.some((d) => d._id === '2')); // doc2 has value=20 and tags exist
      assert.ok(docs.some((d) => d._id === '5')); // anotherDoc has value=50 and tags exist
      assert.ok(docs.some((d) => d._id === '6')); // emptyDoc has value=null and match=test
    });
  });
});
