import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index';

interface TestDoc extends DocumentWithId {
  name: string;
  value: number;
  tags?: string[];
  nested?: { subValue: string };
}

describe('MongoLiteCollection - Delete Operations', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;
  const testDocs: TestDoc[] = [
    { _id: '1', name: 'doc1', value: 10, tags: ['a', 'b'] },
    { _id: '2', name: 'doc2', value: 20, tags: ['b', 'c'] },
    { _id: '3', name: 'doc3', value: 30, tags: ['c', 'd'], nested: { subValue: 'sv1' } },
    { _id: '4', name: 'doc4', value: 20 }, // No tags, no nested
    { _id: '5', name: 'anotherDoc', value: 50, nested: { subValue: 'sv2' } },
  ];

  beforeEach(async () => {
    client = new MongoLite(':memory:', {
      verbose: true,
    });
    await client.connect();
    collection = client.collection<TestDoc>('testDeleteCollection');
    // Insert test data
    for (const doc of testDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  describe('deleteOne()', () => {
    it('should delete a single document by _id', async () => {
      const result = await collection.deleteOne({ _id: '1' });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 1);

      // Verify document was deleted
      const deletedDoc = await collection.findOne({ _id: '1' });
      assert.strictEqual(deletedDoc, null);

      // Verify other documents still exist
      const remainingDocs = await collection.find({}).toArray();
      assert.strictEqual(remainingDocs.length, 4);
    });

    it('should delete a single document by query criteria', async () => {
      const result = await collection.deleteOne({ value: 30 });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 1);

      // Verify document was deleted
      const deletedDoc = await collection.findOne({ value: 30 });
      assert.strictEqual(deletedDoc, null);

      // Verify other documents still exist
      const remainingDocs = await collection.find({}).toArray();
      assert.strictEqual(remainingDocs.length, 4);
    });

    it('should delete only the first matching document when multiple documents match', async () => {
      // Should match both doc2 and doc4 which have value=20
      const result = await collection.deleteOne({ value: 20 });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 1); // Only deletes first match

      // Verify only one document was deleted
      const remainingValue20Docs = await collection.find({ value: 20 }).toArray();
      assert.strictEqual(remainingValue20Docs.length, 1); // One document should still have value=20

      // Verify total document count
      const allDocs = await collection.find({}).toArray();
      assert.strictEqual(allDocs.length, 4);
    });

    it('should delete a document with nested field criteria', async () => {
      const result = await collection.deleteOne({ 'nested.subValue': 'sv1' });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 1);

      // Verify document was deleted
      const deletedDoc = await collection.findOne({ _id: '3' });
      assert.strictEqual(deletedDoc, null);

      // Other document with nested field still exists
      const docWithNested = await collection.findOne({ 'nested.subValue': 'sv2' });
      assert.strictEqual(docWithNested?._id, '5');
    });

    it('should return appropriate results when no documents match the filter', async () => {
      const result = await collection.deleteOne({ _id: 'nonexistent' });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 0);

      // Verify all original documents still exist
      const allDocs = await collection.find({}).toArray();
      assert.strictEqual(allDocs.length, 5);
    });

    it('should handle complex query criteria for deletion', async () => {
      const result = await collection.deleteOne({
        value: { $gt: 20 },
        tags: { $exists: true },
      });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 1);

      // Document with _id: '3' should be deleted (value=30, has tags)
      const deletedDoc = await collection.findOne({ _id: '3' });
      assert.strictEqual(deletedDoc, null);

      // Document with _id: '5' should still exist (value=50, no tags)
      const remainingDoc = await collection.findOne({ _id: '5' });
      assert.ok(remainingDoc);
    });
  });

  describe('deleteMany()', () => {
    it('should delete multiple documents matching a filter', async () => {
      // Delete all docs with value=20
      const result = await collection.deleteMany({ value: 20 });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 2); // doc2 and doc4 have value=20

      // Verify documents were deleted
      const remainingDocs = await collection.find({}).toArray();
      assert.strictEqual(remainingDocs.length, 3);

      // Verify specific documents were deleted
      const doc2 = await collection.findOne({ _id: '2' });
      assert.strictEqual(doc2, null);

      const doc4 = await collection.findOne({ _id: '4' });
      assert.strictEqual(doc4, null);
    });

    it('should delete all documents when filter is empty', async () => {
      const result = await collection.deleteMany({});

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 5); // All 5 test documents

      // Verify all documents were deleted
      const remainingDocs = await collection.find({}).toArray();
      assert.strictEqual(remainingDocs.length, 0);
    });

    it('should delete documents with complex query criteria', async () => {
      const result = await collection.deleteMany({
        value: { $gte: 20 },
        tags: { $exists: true },
      });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 2); // doc2 and doc3

      // Verify correct documents were deleted
      const doc2 = await collection.findOne({ _id: '2' });
      assert.strictEqual(doc2, null);

      const doc3 = await collection.findOne({ _id: '3' });
      assert.strictEqual(doc3, null);

      // Verify other documents still exist
      const doc1 = await collection.findOne({ _id: '1' });
      assert.ok(doc1);

      const doc4 = await collection.findOne({ _id: '4' }); // Has value >= 20 but no tags
      assert.ok(doc4);

      const doc5 = await collection.findOne({ _id: '5' }); // Has value >= 20 but no tags
      assert.ok(doc5);
    });

    it('should return appropriate results when no documents match the filter', async () => {
      const result = await collection.deleteMany({ value: 9999 });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 0);

      // Verify all original documents still exist
      const allDocs = await collection.find({}).toArray();
      assert.strictEqual(allDocs.length, 5);
    });

    it('should delete documents that have tags matching a specific criteria', async () => {
      // Delete documents with specific tags pattern
      const result = await collection.deleteMany({
        $or: [{ _id: '1' }, { _id: '2' }],
      });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 2); // doc1 and doc2

      // Verify correct documents were deleted
      const doc1 = await collection.findOne({ _id: '1' });
      assert.strictEqual(doc1, null);

      const doc2 = await collection.findOne({ _id: '2' });
      assert.strictEqual(doc2, null);

      // Verify other documents still exist
      const doc3 = await collection.findOne({ _id: '3' }); // Has tags but no 'b'
      assert.ok(doc3);

      const remainingDocs = await collection.find({}).toArray();
      assert.strictEqual(remainingDocs.length, 3);
    });
  });

  describe('deleteAll()', () => {
    it('should delete all documents in the collection', async () => {
      const result = await collection.deleteMany({});

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.deletedCount, 5);

      // Verify collection is empty
      const remainingDocs = await collection.find({}).toArray();
      assert.strictEqual(remainingDocs.length, 0);
    });

    it('should create a new empty collection after deleting all documents', async () => {
      // First delete all documents
      await collection.deleteMany({});

      // Then insert a new document
      const newDoc = { _id: 'new', name: 'newDoc', value: 100 };
      await collection.insertOne(newDoc);

      // Verify the document was inserted
      const insertedDoc = await collection.findOne({ _id: 'new' });
      assert.deepStrictEqual(insertedDoc, newDoc);

      // Verify collection only has this one document
      const allDocs = await collection.find({}).toArray();
      assert.strictEqual(allDocs.length, 1);
    });
  });
});
