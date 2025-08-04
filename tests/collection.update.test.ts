import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index';
import { ObjectId } from 'bson';

interface TestDoc extends DocumentWithId {
  name: string;
  value: number;
  tags?: string[];
  nested?: { subValue: string };
  category?: string;
  updated?: boolean;
  created?: boolean;
  auto?: boolean;
  matched?: boolean;
  numbers?: number[];
  objects?: { key: string }[];
  otherNested?: { deep: { field: string } };
  categoryUpdated?: boolean;
  extra?: string;
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
      const result = await collection.updateMany({}, { $set: { updated: true } });

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 5); // All 5 test documents
      assert.strictEqual(result.modifiedCount, 5);

      // Verify all documents were updated
      const allDocs = await collection.find({}).toArray();
      assert.strictEqual(allDocs.length, 5);
      assert.ok(allDocs.every((d) => d.updated === true));
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
          $set: { categoryUpdated: true },
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
      assert.strictEqual(updatedDoc?.extra, 'new field');
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

  describe('updateOne() with upsert option', () => {
    it('should create a new document when no document matches and upsert is true', async () => {
      const newDoc = {
        name: 'upsertedDoc',
        value: 123,
        tags: ['upsert', 'test'],
      };

      // Upsert with a non-existent _id
      const result = await collection.updateOne(
        { _id: 'nonexistent' },
        { $set: newDoc },
        { upsert: true }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
      assert.ok(result.upsertedId !== null, 'upsertedId should not be null');

      // Verify document was created
      const upsertedDoc = await collection.findOne({ _id: result.upsertedId });
      assert.strictEqual(upsertedDoc?.name, 'upsertedDoc');
      assert.strictEqual(upsertedDoc?.value, 123);
      assert.deepStrictEqual(upsertedDoc?.tags, ['upsert', 'test']);
    });

    it('should throw an error when trying to upsert with an invalid ObjectId in $set._id', async () => {
      // Attempting to upsert with an invalid ObjectId in $set._id
      await assert.rejects(
        async () => {
          await collection.updateOne(
            { _id: 'nonexistent' },
            { $set: { _id: 'invalid-object-id', name: 'shouldNotUpsert' } },
            { upsert: true }
          );
        },
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(
            error.message.includes('_id must be a valid ObjectId or not provided for upsert')
          );
          return true;
        },
        'Should throw an error about invalid ObjectId'
      );

      // Verify no document was created
      const docs = await collection.find({ name: 'shouldNotUpsert' }).toArray();
      assert.strictEqual(docs.length, 0, 'No document should have been created');
    });

    it('should allow upsert with a valid ObjectId in $set._id', async () => {
      // Generate a valid ObjectId string using the bson ObjectId
      const validObjectId = new ObjectId().toString();

      // Upsert with a valid ObjectId
      const result = await collection.updateOne(
        { _id: 'nonexistent' },
        {
          $set: {
            _id: validObjectId,
            name: 'validObjectIdUpsert',
            value: 500,
          },
        },
        { upsert: true }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
      assert.strictEqual(result.upsertedId, validObjectId);

      // Verify document was created with the specified _id
      const upsertedDoc = await collection.findOne({ _id: validObjectId });
      assert.strictEqual(upsertedDoc?._id, validObjectId);
      assert.strictEqual(upsertedDoc?.name, 'validObjectIdUpsert');
      assert.strictEqual(upsertedDoc?.value, 500);
    });

    it('should update existing document when upsert is true but document exists', async () => {
      // Use an existing document ID
      const result = await collection.updateOne(
        { _id: '1' },
        { $set: { name: 'upsertUpdateExisting', value: 999 } },
        { upsert: true }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);
      assert.strictEqual(result.upsertedId, null); // No upsert occurred

      // Verify document was updated, not inserted
      const updatedDoc = await collection.findOne({ _id: '1' });
      assert.strictEqual(updatedDoc?.name, 'upsertUpdateExisting');
      assert.strictEqual(updatedDoc?.value, 999);
    });

    it('should create new document with complex query filter when upsert is true', async () => {
      const result = await collection.updateOne(
        { name: 'nonexistentName', value: { $gt: 1000 } },
        { $set: { name: 'complexQueryUpsert', value: 1500, tags: ['complex'] } },
        { upsert: true }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
      assert.ok(result.upsertedId !== null);

      // Verify document was created
      const upsertedDoc = await collection.findOne({ _id: result.upsertedId });
      assert.strictEqual(upsertedDoc?.name, 'complexQueryUpsert');
      assert.strictEqual(upsertedDoc?.value, 1500);
      assert.deepStrictEqual(upsertedDoc?.tags, ['complex']);
    });

    // TODO Implement
    it.skip('should handle upsert with multiple update operators', async () => {
      const result = await collection.updateOne(
        { _id: 'multiOpUpsert' },
        {
          $set: { _id: 'multiOpUpsert', name: 'multiOperatorUpsert', category: 'test' },
          $inc: { value: 50 }, // Should set to 50 since doc doesn't exist
        },
        { upsert: true }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
      assert.strictEqual(result.upsertedId, 'multiOpUpsert');

      // Verify document was created with all operators applied
      const upsertedDoc = await collection.findOne({ _id: 'multiOpUpsert' });
      assert.strictEqual(upsertedDoc?.name, 'multiOperatorUpsert');
      assert.strictEqual(upsertedDoc?.category, 'test');
      assert.strictEqual(upsertedDoc?.value, 50); // $inc on non-existent field
    });

    // TODO Implement
    it.skip('should handle upsert with $unset operator (should be ignored for new document)', async () => {
      const result = await collection.updateOne(
        { _id: 'unsetUpsert' },
        {
          $set: { name: 'unsetTest', value: 100 },
          $unset: { nonExistentField: '' }, // Should be ignored
        },
        { upsert: true }
      );

      if (!result.upsertedId) {
        throw new Error('upsertedId should not be null for upsert operation');
      }

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
      assert.ok(
        ObjectId.isValid(result.upsertedId),
        'upsertedId should be a valid ObjectId string'
      );

      // Verify document was created correctly
      const upsertedDoc = await collection.findOne({ _id: result.upsertedId });
      assert.strictEqual(upsertedDoc?.name, 'unsetTest');
      assert.strictEqual(upsertedDoc?.value, 100);
    });

    // TODO Implement nested updates
    it.skip('should handle upsert with nested field updates', async () => {
      const result = await collection.updateOne(
        { _id: 'nestedUpsert' },
        {
          $set: {
            'nested.field1': 'value1',
            'nested.field2': 'value2',
            'otherNested.deep.field': 'deepValue',
          },
        },
        { upsert: true }
      );

      if (!result.upsertedId) {
        throw new Error('upsertedId should not be null for upsert operation');
      }

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
      assert.ok(
        ObjectId.isValid(result.upsertedId),
        'upsertedId should be a valid ObjectId string'
      );

      // Verify nested structure was created correctly
      const upsertedDoc = await collection.findOne({ _id: result.upsertedId });
      assert.deepStrictEqual(upsertedDoc?.nested, {
        field1: 'value1',
        field2: 'value2',
      });
      assert.deepStrictEqual(upsertedDoc?.otherNested, {
        deep: { field: 'deepValue' },
      });
    });

    it('should handle upsert with array field initialization', async () => {
      const result = await collection.updateOne(
        { _id: 'arrayUpsert' },
        {
          $set: {
            name: 'arrayTest',
            tags: ['tag1', 'tag2', 'tag3'],
            numbers: [1, 2, 3, 4],
            objects: [{ key: 'value1' }, { key: 'value2' }],
          },
        },
        { upsert: true }
      );

      if (!result.upsertedId) {
        throw new Error('upsertedId should not be null for upsert operation');
      }

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
      assert.ok(
        ObjectId.isValid(result.upsertedId),
        'upsertedId should be a valid ObjectId string'
      );

      // Verify arrays were created correctly
      const upsertedDoc = await collection.findOne({ _id: result.upsertedId });
      assert.strictEqual(upsertedDoc?.name, 'arrayTest');
      assert.deepStrictEqual(upsertedDoc?.tags, ['tag1', 'tag2', 'tag3']);
      assert.deepStrictEqual(upsertedDoc?.numbers, [1, 2, 3, 4]);
      assert.deepStrictEqual(upsertedDoc?.objects, [{ key: 'value1' }, { key: 'value2' }]);
    });

    it('should handle upsert when filter contains non-_id fields', async () => {
      const result = await collection.updateOne(
        { name: 'filterUpsert', category: 'special' },
        {
          $set: {
            name: 'filterUpsert',
            category: 'special',
            value: 777,
            created: true,
          },
        },
        { upsert: true }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
      assert.ok(result.upsertedId !== null);

      // Verify document includes filter fields and update fields
      const upsertedDoc = await collection.findOne({ _id: result.upsertedId });
      assert.strictEqual(upsertedDoc?.name, 'filterUpsert');
      assert.strictEqual(upsertedDoc?.category, 'special');
      assert.strictEqual(upsertedDoc?.value, 777);
      assert.strictEqual(upsertedDoc?.created, true);
    });

    it('should generate new ObjectId when no _id is specified in filter or update', async () => {
      const result = await collection.updateOne(
        { name: 'autoIdUpsert' },
        { $set: { value: 555, auto: true } },
        { upsert: true }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
      assert.ok(result.upsertedId !== null);
      assert.ok(typeof result.upsertedId === 'string');
      assert.ok(
        ObjectId.isValid(result.upsertedId),
        'upsertedId should be a valid ObjectId string'
      );

      // Verify the generated ID is a valid ObjectId format
      assert.ok(ObjectId.isValid(result.upsertedId));

      // Verify document was created with auto-generated ID
      const upsertedDoc = await collection.findOne({ _id: result.upsertedId });
      assert.strictEqual(upsertedDoc?.name, undefined);
      assert.strictEqual(upsertedDoc?.value, 555);
      assert.strictEqual(upsertedDoc?.auto, true);
    });

    it('should handle upsert with empty update object', async () => {
      const result = await collection.updateOne(
        { _id: 'emptyUpdate' },
        { $set: {} },
        { upsert: true }
      );

      if (!result.upsertedId) {
        throw new Error('upsertedId should not be null for upsert operation');
      }

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
      assert.ok(
        ObjectId.isValid(result.upsertedId),
        'upsertedId should be a valid ObjectId string'
      );

      // Verify document was created with just the _id
      const upsertedDoc = await collection.findOne({ _id: result.upsertedId });
      assert.strictEqual(upsertedDoc?._id, result.upsertedId);
      assert.strictEqual(Object.keys(upsertedDoc || {}).length, 1); // Only _id field
    });

    it('should handle upsert with filter containing operators', async () => {
      const result = await collection.updateOne(
        { value: { $gte: 2000 }, name: 'specialOperator' },
        {
          $set: {
            name: 'specialOperatorUpsert',
            value: 2500,
            matched: true,
          },
        },
        { upsert: true }
      );

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.matchedCount, 0);
      assert.strictEqual(result.modifiedCount, 0);
      assert.ok(result.upsertedId !== null);

      // Verify document was created (filter operators are ignored for upsert document creation)
      const upsertedDoc = await collection.findOne({ _id: result.upsertedId });
      assert.strictEqual(upsertedDoc?.name, 'specialOperatorUpsert');
      assert.strictEqual(upsertedDoc?.value, 2500);
      assert.strictEqual(upsertedDoc?.matched, true);
    });

    it('should not upsert when upsert option is false or not provided', async () => {
      // Test with explicit false
      const result1 = await collection.updateOne(
        { _id: 'noUpsert1' },
        { $set: { name: 'shouldNotCreate' } },
        { upsert: false }
      );

      assert.strictEqual(result1.acknowledged, true);
      assert.strictEqual(result1.matchedCount, 0);
      assert.strictEqual(result1.modifiedCount, 0);
      assert.strictEqual(result1.upsertedId, null);

      // Test without upsert option (default false)
      const result2 = await collection.updateOne(
        { _id: 'noUpsert2' },
        { $set: { name: 'shouldNotCreate' } }
      );

      assert.strictEqual(result2.acknowledged, true);
      assert.strictEqual(result2.matchedCount, 0);
      assert.strictEqual(result2.modifiedCount, 0);
      assert.strictEqual(result2.upsertedId, null);

      // Verify no documents were created
      const doc1 = await collection.findOne({ _id: 'noUpsert1' });
      const doc2 = await collection.findOne({ _id: 'noUpsert2' });
      assert.strictEqual(doc1, null);
      assert.strictEqual(doc2, null);
    });
  });
});
