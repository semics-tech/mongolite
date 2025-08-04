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

describe('MongoLiteCollection - Insert Operations', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;

  beforeEach(async () => {
    client = new MongoLite(':memory:', {
      verbose: true,
    });
    await client.connect();
    collection = client.collection<TestDoc>('testInsertCollection');
  });

  afterEach(async () => {
    await client.close();
  });

  describe('insertOne()', () => {
    it('should insert a document with a specified _id', async () => {
      const testDoc = { _id: 'custom1', name: 'testDoc', value: 100 };
      const result = await collection.insertOne(testDoc);

      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.insertedId, 'custom1');

      // Verify document was inserted
      const insertedDoc = await collection.findOne({ _id: 'custom1' });
      assert.deepStrictEqual(insertedDoc, testDoc);
    });

    it('should generate an _id if not specified', async () => {
      const testDoc = { name: 'testDoc', value: 100 } as TestDoc;
      const result = await collection.insertOne(testDoc);

      assert.strictEqual(result.acknowledged, true);
      assert.ok(result.insertedId, 'Should have an insertedId');

      // Verify document was inserted with the generated _id
      const insertedDoc = await collection.findOne({ _id: result.insertedId });
      assert.ok(insertedDoc, 'Document should be found with generated _id');
      assert.strictEqual(insertedDoc?.name, testDoc.name);
      assert.strictEqual(insertedDoc?.value, testDoc.value);
    });

    it('should insert a document with nested fields', async () => {
      const testDoc = {
        _id: 'nested1',
        name: 'nestedDoc',
        value: 100,
        nested: { subValue: 'nested value' },
      };

      const result = await collection.insertOne(testDoc);
      assert.strictEqual(result.acknowledged, true);

      // Verify document was inserted with nested fields
      const insertedDoc = await collection.findOne({ 'nested.subValue': 'nested value' });
      assert.deepStrictEqual(insertedDoc, testDoc);
    });

    it('should insert a document with array fields', async () => {
      const testDoc = {
        _id: 'array1',
        name: 'arrayDoc',
        value: 100,
        tags: ['tag1', 'tag2', 'tag3'],
      };

      const result = await collection.insertOne(testDoc);
      assert.strictEqual(result.acknowledged, true);

      // Verify document was inserted with array fields
      const insertedDoc = await collection.findOne({ _id: 'array1' });
      assert.deepStrictEqual(insertedDoc, testDoc);
      assert.deepStrictEqual(insertedDoc?.tags, ['tag1', 'tag2', 'tag3']);
    });

    it('should reject insertion if document with the same _id already exists', async () => {
      const testDoc = { _id: 'duplicate', name: 'doc', value: 100 };

      // First insertion should succeed
      await collection.insertOne(testDoc);

      // Second insertion with same _id should fail
      try {
        await collection.insertOne(testDoc);
        assert.fail('Should have thrown an error for duplicate _id');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes('duplicate') ||
            error.message.includes('unique') ||
            error.message.includes('UNIQUE constraint failed'),
          `Error message should mention uniqueness violation: ${error.message}`
        );
      }
    });
  });

  describe('insertMany()', () => {
    it('should insert multiple documents', async () => {
      const testDocs = [
        { _id: 'batch1', name: 'batchDoc1', value: 10 },
        { _id: 'batch2', name: 'batchDoc2', value: 20 },
        { _id: 'batch3', name: 'batchDoc3', value: 30 },
      ];

      const result = await collection.insertMany(testDocs);

      // Assuming insertMany returns an array of individual results or a summary object
      assert.ok(result, 'Result should exist');

      // Verify all documents were inserted
      const insertedDocs = await collection.find({}).toArray();
      assert.strictEqual(insertedDocs.length, 3);

      // Check each document individually
      for (const doc of testDocs) {
        const found = await collection.findOne({ _id: doc._id });
        assert.deepStrictEqual(found, doc);
      }
    });

    it('should generate _ids for documents that do not specify them', async () => {
      const testDocs = [
        { name: 'genDoc1', value: 10 } as TestDoc,
        { name: 'genDoc2', value: 20 } as TestDoc,
        { name: 'genDoc3', value: 30 } as TestDoc,
      ];

      await collection.insertMany(testDocs);

      // Verify all documents were inserted with generated _ids
      const insertedDocs = await collection.find({}).toArray();
      assert.strictEqual(insertedDocs.length, 3);

      // Each document should have an _id
      for (const doc of insertedDocs) {
        assert.ok(doc._id, `Document should have a generated _id`);
      }
    });

    it('should stop insertion and throw error if a document has a duplicate _id', async () => {
      // First insert a document
      await collection.insertOne({ _id: 'existing', name: 'existingDoc', value: 100 });

      // Try to insert a batch with one document having the same _id
      const testDocs = [
        { _id: 'batch1', name: 'batchDoc1', value: 10 },
        { _id: 'existing', name: 'duplicateDoc', value: 20 }, // This should cause an error
        { _id: 'batch3', name: 'batchDoc3', value: 30 },
      ];

      try {
        await collection.insertMany(testDocs);
        assert.fail('Should have thrown an error for duplicate _id');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes('UNIQUE constraint failed: testInsertCollection._id'),
          `Error message should mention uniqueness violation: ${error.message}`
        );

        // Verify that none of the documents in the batch were inserted
        // (or only documents before the duplicate were inserted, depending on implementation)
        const doc3 = await collection.findOne({ _id: 'batch3' });
        assert.strictEqual(doc3, null, 'Document after duplicate should not be inserted');
      }
    });

    it('should insert an empty array without error', async () => {
      await collection.insertMany([]);

      // Verify collection is still empty
      const docs = await collection.find({}).toArray();
      assert.strictEqual(docs.length, 0);
    });
  });

  describe('JSON Safety and Validation', () => {
    it('should validate documents before insertion', async () => {
      const invalidDoc = {
        name: 'test',
        value: 100,
        invalidFunction: () => 'not allowed',
      } as unknown as TestDoc;

      try {
        await collection.insertOne(invalidDoc);
        assert.fail('Should have rejected document with function');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Functions are not allowed'));
      }
    });

    it('should safely stringify complex valid documents', async () => {
      const complexDoc = {
        name: 'complex',
        value: 100,
        nested: {
          array: [1, 2, { deep: 'value' }],
          date: new Date(),
          boolean: true,
          nullValue: null,
        },
      };

      const result = await collection.insertOne(complexDoc);
      assert.strictEqual(result.acknowledged, true);

      const retrieved = await collection.findOne({ _id: result.insertedId });
      assert.ok(retrieved);
      assert.strictEqual(retrieved.name, 'complex');
      assert.strictEqual(retrieved.value, 100);
      assert.ok(retrieved.nested);
    });

    it('should handle Date objects correctly in documents', async () => {
      const testDate = new Date('2023-01-01T00:00:00.000Z');
      const docWithDate = {
        name: 'dateTest',
        value: 100,
        createdAt: testDate,
        metadata: {
          lastModified: testDate,
        },
      };

      const result = await collection.insertOne(docWithDate);
      assert.strictEqual(result.acknowledged, true);

      const retrieved = await collection.findOne({ _id: result.insertedId });
      assert.ok(retrieved);
      assert.strictEqual(retrieved.name, 'dateTest');
      assert.ok(retrieved.createdAt instanceof Date);
      assert.strictEqual(retrieved.createdAt.toISOString(), testDate.toISOString());
    });
  });
});
