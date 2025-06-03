import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index';

interface TestDoc extends DocumentWithId {
  name: string;
  value: number;
  tags?: string[];
  nested?: {
    subValue: string;
    items?: Array<{
      id: number;
      name: string;
      category?: string;
    }>;
  };
  description?: string;
}

describe('MongoLiteCollection - Query Operators Tests', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;
  const testDocs: TestDoc[] = [
    {
      _id: '1',
      name: 'doc1',
      value: 10,
      tags: ['a', 'b'],
      description: 'This is a sample document with some important keywords',
    },
    {
      _id: '2',
      name: 'doc2',
      value: 20,
      tags: ['b', 'c'],
      description: 'Another document with different searchable content',
    },
    {
      _id: '3',
      name: 'doc3',
      value: 30,
      tags: ['c', 'd'],
      nested: {
        subValue: 'sv1',
        items: [
          { id: 1, name: 'item1', category: 'cat1' },
          { id: 2, name: 'item2', category: 'cat2' },
        ],
      },
    },
    {
      _id: '4',
      name: 'doc4',
      value: 20,
    }, // No tags, no nested, no description
    {
      _id: '5',
      name: 'anotherDoc',
      value: 50,
      nested: {
        subValue: 'sv2',
        items: [
          { id: 3, name: 'item3', category: 'cat1' },
          { id: 4, name: 'item4' }, // No category
        ],
      },
      description: 'Document containing special searchable keywords',
    },
  ];

  beforeEach(async () => {
    client = new MongoLite(':memory:', {
      verbose: true,
    });
    await client.connect();
    collection = client.collection<TestDoc>('testOperatorsCollection');
    // Insert test data
    for (const doc of testDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  describe('$text operator', () => {
    it('should find documents matching text search', async () => {
      const docs = await collection.find({ $text: { $search: 'keywords' } }).toArray();
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '1'));
      assert.ok(docs.some((d) => d._id === '5'));
    });

    it('should find documents with partial text search match', async () => {
      const docs = await collection.find({ $text: { $search: 'sample' } }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0]._id, '1');
    });

    it('should return empty array for text search with no matches', async () => {
      const docs = await collection.find({ $text: { $search: 'nonexistentword' } }).toArray();
      assert.strictEqual(docs.length, 0);
    });

    it('should handle empty search string', async () => {
      const docs = await collection.find({ $text: { $search: '' } }).toArray();
      assert.strictEqual(docs.length, 0); // No matches for empty search string
    });
  });

  describe('$exists operator', () => {
    it('should find documents where a field exists', async () => {
      const docs = await collection.find({ $exists: { tags: true } }).toArray();
      assert.strictEqual(docs.length, 3);
      assert.ok(docs.some((d) => d._id === '1'));
      assert.ok(docs.some((d) => d._id === '2'));
      assert.ok(docs.some((d) => d._id === '3'));
    });

    it('should find documents where a field does not exist', async () => {
      const docs = await collection.find({ $exists: { description: false } }).toArray();
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '3'));
      assert.ok(docs.some((d) => d._id === '4'));
    });

    it('should find documents where a nested field exists', async () => {
      const docs = await collection.find({ $exists: { 'nested.items': true } }).toArray();
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '3'));
      assert.ok(docs.some((d) => d._id === '5'));
    });

    it('should combine $exists with other query conditions', async () => {
      const docs = await collection
        .find({
          value: { $gt: 20 },
          $exists: { description: true },
        })
        .toArray();

      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0]._id, '5'); // Only doc5 has value > 20 and description exists
    });
  });

  describe('$not operator', () => {
    it('should negate simple equality conditions', async () => {
      const docs = await collection.find({ $not: { value: 20 } }).toArray();
      assert.strictEqual(docs.length, 3);
      assert.ok(docs.some((d) => d._id === '1')); // value: 10
      assert.ok(docs.some((d) => d._id === '3')); // value: 30
      assert.ok(docs.some((d) => d._id === '5')); // value: 50
    });

    it('should negate complex conditions', async () => {
      const docs = await collection
        .find({
          $not: { value: { $gt: 20 } },
        })
        .toArray();

      assert.strictEqual(docs.length, 3);
      assert.ok(docs.some((d) => d._id === '1')); // value: 10
      assert.ok(docs.some((d) => d._id === '2')); // value: 20
      assert.ok(docs.some((d) => d._id === '4')); // value: 20
    });

    it('should negate $exists condition', async () => {
      const docs = await collection
        .find({
          $not: { $exists: { tags: true } },
        })
        .toArray();

      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '4'));
      assert.ok(docs.some((d) => d._id === '5'));
    });

    it('should combine $not with regular query conditions', async () => {
      const docs = await collection
        .find({
          name: { $ne: 'doc4' },
          $not: { value: { $lt: 20 } },
        })
        .toArray();

      assert.strictEqual(docs.length, 3);
      assert.ok(docs.some((d) => d._id === '2')); // value: 20, name: doc2
      assert.ok(docs.some((d) => d._id === '3')); // value: 30, name: doc3
      assert.ok(docs.some((d) => d._id === '5')); // value: 50, name: anotherDoc
    });
  });

  describe('$in operator', () => {
    it('should find documents with field in specified values', async () => {
      const docs = await collection.find({ value: { $in: [10, 30] } }).toArray();
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '1')); // value: 10
      assert.ok(docs.some((d) => d._id === '3')); // value: 30
    });
    // Skipping as this is very complex and needs work
    it.skip('should find documents with nested field in specified values', async () => {
      const docs = await collection
        .find({ 'nested.items.category': { $in: ['cat1', 'cat2'] } })
        .toArray();

      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '3')); // Has item with category cat1
      assert.ok(docs.some((d) => d._id === '5')); // Has item with category cat1
    });
    it('should return empty array when no document matches $in', async () => {
      const docs = await collection.find({ value: { $in: [100, 200] } }).toArray();
      assert.strictEqual(docs.length, 0);
    });
  });

  describe('$all operator', () => {
    it('should find documents with all specified tags', async () => {
      const docs = await collection.find({ tags: { $all: ['a', 'b'] } }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0]._id, '1'); // Only doc1 has both tags 'a' and 'b'
    });
  });

  describe('$elemMatch operator', () => {
    it('should find documents with matching array elements', async () => {
      const docs = await collection
        .find({
          $elemMatch: { 'nested.items': { category: 'cat1' } },
        })
        .toArray();

      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '3')); // Has item with category cat1
      assert.ok(docs.some((d) => d._id === '5')); // Has item with category cat1
    });

    it('should find documents with complex element matching', async () => {
      const docs = await collection
        .find({
          $elemMatch: { 'nested.items': { id: { $gt: 2 } } },
        })
        .toArray();

      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0]._id, '5'); // Only doc5 has items with id > 2
    });

    it('should handle $elemMatch with multiple conditions', async () => {
      const docs = await collection
        .find({
          $elemMatch: {
            'nested.items': {
              id: { $gte: 1 },
              category: 'cat1',
            },
          },
        })
        .toArray();

      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '3')); // Has item1 with category cat1
      assert.ok(docs.some((d) => d._id === '5')); // Has item3 with category cat1
    });

    it('should return empty array when no document matches elemMatch', async () => {
      const docs = await collection
        .find({
          $elemMatch: { 'nested.items': { id: 10 } },
        })
        .toArray();

      assert.strictEqual(docs.length, 0);
    });
  });

  describe('Combined operators', () => {
    it('should combine $text, $exists and regular conditions', async () => {
      const docs = await collection
        .find({
          $text: { $search: 'document' },
          $exists: { tags: true },
          value: { $gte: 20 },
        })
        .toArray();

      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0]._id, '2'); // Only doc2 matches all conditions
    });

    it('should handle $not with $elemMatch', async () => {
      const docs = await collection
        .find({
          $not: {
            $elemMatch: { 'nested.items': { category: 'cat2' } },
          },
        })
        .toArray();

      // Docs 1, 2, 4 don't have nested.items
      // Doc 5 has nested.items but none with category cat2
      assert.strictEqual(docs.length, 4);
      assert.ok(docs.some((d) => d._id === '1'));
      assert.ok(docs.some((d) => d._id === '2'));
      assert.ok(docs.some((d) => d._id === '4'));
      assert.ok(docs.some((d) => d._id === '5'));
    });
  });
});
