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

describe('MongoLiteCollection - Update Operations', () => {
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
    collection = client.collection<TestDoc>('testUpdateCollection');
    // Insert test data
    for (const doc of testDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  describe('updateOne()', () => {
    it('should update a single document by _id', async () => {
      const result = await collection.updateOne(
        { _id: '1' },
        { $set: { name: 'updatedDoc1', value: 100 } }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      // Verify document was updated
      const updatedDoc = await collection.findOne({ _id: '1' });
      assert.strictEqual(updatedDoc?.name, 'updatedDoc1');
      assert.strictEqual(updatedDoc?.value, 100);
      // Tags should remain unchanged
      assert.deepStrictEqual(updatedDoc?.tags, ['a', 'b']);
    });

    it('should update a single document by query criteria', async () => {
      const result = await collection.updateOne(
        { value: 20, name: 'doc2' },
        { $set: { name: 'updatedByQuery' } }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      // Verify document was updated
      const updatedDoc = await collection.findOne({ _id: '2' });
      assert.strictEqual(updatedDoc?.name, 'updatedByQuery');
      assert.strictEqual(updatedDoc?.value, 20); // Unchanged
    });

    it('should update nested fields', async () => {
      const result = await collection.updateOne(
        { _id: '3' },
        { $set: { 'nested.subValue': 'updatedNested' } }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      // Verify nested field was updated
      const updatedDoc = await collection.findOne({ _id: '3' });
      assert.strictEqual(updatedDoc?.nested?.subValue, 'updatedNested');
    });

    it('should add new fields if they do not exist', async () => {
      const result = await collection.updateOne(
        { _id: '4' }, // This doc doesn't have tags or nested
        { $set: { tags: ['new'], nested: { subValue: 'newNested' } } }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      // Verify new fields were added
      const updatedDoc = await collection.findOne({ _id: '4' });
      assert.deepStrictEqual(updatedDoc?.tags, ['new']);
      assert.deepStrictEqual(updatedDoc?.nested, { subValue: 'newNested' });
    });

    it('should update array fields', async () => {
      const result = await collection.updateOne({ _id: '1' }, { $set: { tags: ['x', 'y', 'z'] } });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      // Verify array was updated
      const updatedDoc = await collection.findOne({ _id: '1' });
      assert.deepStrictEqual(updatedDoc?.tags, ['x', 'y', 'z']);
    });

    it('should return appropriate results when no documents match the filter', async () => {
      const result = await collection.updateOne(
        { _id: 'nonexistent' },
        { $set: { name: 'shouldNotUpdate' } }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
    });

    it('should use $inc operator to increment numeric values', async () => {
      const result = await collection.updateOne({ _id: '1' }, { $inc: { value: 5 } });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      // Verify value was incremented
      const updatedDoc = await collection.findOne({ _id: '1' });
      assert.strictEqual(updatedDoc?.value, 15); // 10 + 5
    });

    it('should use $inc operator to decrement numeric values with negative values', async () => {
      const result = await collection.updateOne({ _id: '2' }, { $inc: { value: -7 } });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      // Verify value was decremented
      const updatedDoc = await collection.findOne({ _id: '2' });
      assert.strictEqual(updatedDoc?.value, 13); // 20 - 7
    });

    it('should use $unset operator to remove fields', async () => {
      const result = await collection.updateOne({ _id: '3' }, { $unset: { nested: '' } });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      // Verify field was removed
      const updatedDoc = await collection.findOne({ _id: '3' });
      assert.strictEqual(updatedDoc?.nested, undefined);
    });

    it('should handle multiple update operators in one update operation', async () => {
      const result = await collection.updateOne(
        { _id: '5' },
        {
          $set: { name: 'multiOpUpdate' },
          $inc: { value: 10 },
          $unset: { nested: '' },
        }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      // Verify all operations were applied
      const updatedDoc = await collection.findOne({ _id: '5' });
      assert.strictEqual(updatedDoc?.name, 'multiOpUpdate'); // $set
      assert.strictEqual(updatedDoc?.value, 60); // $inc (50 + 10)
      assert.strictEqual(updatedDoc?.nested, undefined); // $unset
    });
  });

  describe('updateMany()', () => {
    it('should update multiple documents matching a filter', async () => {
      // Update all docs with value=20
      const result = await collection.updateMany(
        { value: 20 },
        { $set: { name: 'updatedValue20' } }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 2); // doc2 and doc4 have value=20
      assert.strictEqual(result.modifiedCount, 2);

      // Verify both documents were updated
      const updatedDocs = await collection.find({ name: 'updatedValue20' }).toArray();
      assert.strictEqual(updatedDocs.length, 2);
      assert.ok(updatedDocs.some((d) => d._id === '2'));
      assert.ok(updatedDocs.some((d) => d._id === '4'));
    });

    it('should update all documents when filter is empty', async () => {
      const result = await collection.updateMany({}, { $set: { updated: true } as any });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 5); // All 5 test documents
      assert.strictEqual(result.modifiedCount, 5);

      // Verify all documents were updated
      const allDocs = await collection.find({}).toArray();
      assert.strictEqual(allDocs.length, 5);
      assert.ok(allDocs.every((d) => (d as any).updated === true));
    });

    it('should increment values for multiple documents', async () => {
      const result = await collection.updateMany(
        { value: { $lt: 40 } }, // docs with value < 40
        { $inc: { value: 100 } }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 4); // doc1, doc2, doc3, doc4
      assert.strictEqual(result.modifiedCount, 4);

      // Verify values were incremented
      const updatedDocs = await collection.find({ value: { $gte: 100 } }).toArray();
      assert.strictEqual(updatedDocs.length, 4);

      // Check specific values
      const doc1 = await collection.findOne({ _id: '1' });
      assert.strictEqual(doc1?.value, 110); // 10 + 100

      const doc3 = await collection.findOne({ _id: '3' });
      assert.strictEqual(doc3?.value, 130); // 30 + 100
    });

    it('should return appropriate results when no documents match the filter', async () => {
      const result = await collection.updateMany(
        { value: 9999 },
        { $set: { name: 'shouldNotUpdate' } }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
    });

    it('should apply complex updates to multiple documents', async () => {
      const result = await collection.updateMany(
        { tags: { $exists: true } }, // docs with tags field
        {
          $set: { categoryUpdated: true } as any,
          $inc: { value: -5 },
          $unset: { tags: '' },
        }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 3); // doc1, doc2, doc3
      assert.strictEqual(result.modifiedCount, 3);

      // Verify updates were applied
      const updatedDocs = await collection.find({ categoryUpdated: true }).toArray();
      assert.strictEqual(updatedDocs.length, 3);

      // Verify specific changes
      for (const doc of updatedDocs) {
        // Tags should be removed
        assert.strictEqual(doc.tags, undefined);

        // Values should be decremented
        const originalDoc = testDocs.find((d) => d._id === doc._id);
        assert.strictEqual(doc.value, (originalDoc?.value || 0) - 5);
      }
    });
  });

  describe('updateOne() with replacement', () => {
    it('should replace an entire document except the _id', async () => {
      const newDoc = {
        name: 'completelyNew',
        value: 999,
        extra: 'new field',
      };

      const result = await collection.updateOne({ _id: '1' }, { $set: newDoc });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      // Verify document was updated with new fields
      const updatedDoc = await collection.findOne({ _id: '1' });

      // Should match the replacement document but keep original _id
      assert.strictEqual(updatedDoc?._id, '1');
      assert.strictEqual(updatedDoc?.name, 'completelyNew');
      assert.strictEqual(updatedDoc?.value, 999);
      assert.strictEqual((updatedDoc as any).extra, 'new field');
    });

    it('should update a document by query criteria', async () => {
      const newDoc = {
        name: 'replacedByQuery',
        value: 888,
      };

      const result = await collection.updateOne({ name: 'doc2', value: 20 }, { $set: newDoc });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      // Verify document was updated
      const updatedDoc = await collection.findOne({ _id: '2' });
      assert.strictEqual(updatedDoc?.name, 'replacedByQuery');
      assert.strictEqual(updatedDoc?.value, 888);
    });

    it('should return appropriate results when no documents match the filter', async () => {
      const newDoc = {
        name: 'shouldNotReplace',
        value: 0,
      };

      const result = await collection.updateOne({ _id: 'nonexistent' }, { $set: newDoc });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
    });

    it('should update only the first matching document when multiple documents match', async () => {
      const newDoc = {
        name: 'replacedValue20',
        value: 777,
      };

      // Should match both doc2 and doc4 which have value=20
      const result = await collection.updateOne({ value: 20 }, { $set: newDoc });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1); // Only updates first match
      assert.strictEqual(result.modifiedCount, 1);

      // Verify only one document was updated
      const value20Docs = await collection.find({ value: 20 }).toArray();
      assert.strictEqual(value20Docs.length, 1); // One document should still have value=20

      const updatedDocs = await collection.find({ name: 'replacedValue20' }).toArray();
      assert.strictEqual(updatedDocs.length, 1); // Only one document should have the new name
    });
  });
});
