import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index';

interface TestDoc extends DocumentWithId {
  name: string;
  value: number;
  data?: unknown;
  nested?: { field: string };
}

describe('MongoLiteCollection - JSON Safety', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;

  beforeEach(async () => {
    client = new MongoLite(':memory:', {
      verbose: true,
    });
    await client.connect();
    collection = client.collection<TestDoc>('testJsonSafetyCollection');
  });

  afterEach(async () => {
    await client.close();
  });

  describe('Document Validation on Insert', () => {
    it('should reject documents with functions', async () => {
      const invalidDoc = {
        name: 'test',
        value: 100,
        data: () => 'function not allowed',
      } as unknown as TestDoc;

      try {
        await collection.insertOne(invalidDoc);
        assert.fail('Should have thrown an error for function in document');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes('Functions are not allowed'),
          `Error message should mention functions: ${error.message}`
        );
      }
    });

    it('should reject documents with symbols', async () => {
      const invalidDoc = {
        name: 'test',
        value: 100,
        data: Symbol('not allowed'),
      } as unknown as TestDoc;

      try {
        await collection.insertOne(invalidDoc);
        assert.fail('Should have thrown an error for symbol in document');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes('Symbols are not allowed'),
          `Error message should mention symbols: ${error.message}`
        );
      }
    });

    it('should reject documents with BigInt values', async () => {
      const invalidDoc = {
        name: 'test',
        value: 100,
        data: BigInt(123),
      } as unknown as TestDoc;

      try {
        await collection.insertOne(invalidDoc);
        assert.fail('Should have thrown an error for BigInt in document');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes('BigInt values are not supported'),
          `Error message should mention BigInt: ${error.message}`
        );
      }
    });

    it('should reject documents with RegExp objects', async () => {
      const invalidDoc = {
        name: 'test',
        value: 100,
        data: /test/,
      } as unknown as TestDoc;

      try {
        await collection.insertOne(invalidDoc);
        assert.fail('Should have thrown an error for RegExp in document');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes('RegExp objects are not supported'),
          `Error message should mention RegExp: ${error.message}`
        );
      }
    });

    it('should reject documents with circular references', async () => {
      interface CircularDoc {
        name: string;
        value: number;
        self?: CircularDoc;
      }
      const circular: CircularDoc = { name: 'test', value: 100 };
      circular.self = circular;

      try {
        await collection.insertOne(circular as unknown as TestDoc);
        assert.fail('Should have thrown an error for circular reference');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes('Circular reference'),
          `Error message should mention circular reference: ${error.message}`
        );
      }
    });

    it('should accept valid documents with complex structures', async () => {
      const validDoc = {
        name: 'complex',
        value: 100,
        data: {
          array: [1, 2, 3, 'string'],
          nested: {
            deep: {
              value: true,
              date: new Date(),
            },
          },
          nullValue: null,
          undefinedValue: undefined,
        },
      };

      const result = await collection.insertOne(validDoc);
      assert.strictEqual(result.acknowledged, true);
      assert.ok(result.insertedId);

      // Verify the document was stored correctly
      const retrieved = await collection.findOne({ _id: result.insertedId });
      assert.ok(retrieved);
      assert.strictEqual(retrieved.name, 'complex');
      assert.strictEqual(retrieved.value, 100);
    });
  });

  describe('Malformed JSON Recovery', () => {
    it('should handle corrupted JSON data in the database', async () => {
      // First insert a valid document
      const doc = { name: 'test', value: 100 };
      const result = await collection.insertOne(doc);

      // Directly corrupt the JSON in the database
      const corruptedJson = '{"name": "test", "value": 100, "corrupted": "missing quote}';
      await client.database.run(`UPDATE "${collection.name}" SET data = ? WHERE _id = ?`, [
        corruptedJson,
        result.insertedId,
      ]);

      // Try to find the document - should return a fallback object
      const retrieved = await collection.findOne({ _id: result.insertedId });
      assert.ok(retrieved);
      assert.strictEqual(retrieved._id, result.insertedId);
      
      // Should have corruption markers
      assert.ok('__mongoLiteCorrupted' in retrieved);
      assert.strictEqual(retrieved.__mongoLiteCorrupted, true);
      assert.ok('__originalData' in retrieved);
      assert.ok('__error' in retrieved);
    });

    it('should attempt to recover from double-escaped quotes', async () => {
      const doc = { name: 'test with "quotes"', value: 100 };
      const result = await collection.insertOne(doc);

      // Corrupt with double-escaped quotes
      const corruptedJson = '{"name": "test with \\"quotes\\"", "value": 100}';
      await client.database.run(`UPDATE "${collection.name}" SET data = ? WHERE _id = ?`, [
        corruptedJson,
        result.insertedId,
      ]);

      // Should successfully recover
      const retrieved = await collection.findOne({ _id: result.insertedId });
      assert.ok(retrieved);
      assert.strictEqual(retrieved.name, 'test with "quotes"');
      assert.strictEqual(retrieved.value, 100);
      assert.ok(!('__mongoLiteCorrupted' in retrieved));
    });

    it('should handle empty or null JSON data', async () => {
      const doc = { name: 'test', value: 100 };
      const result = await collection.insertOne(doc);

      // Set empty JSON
      await client.database.run(`UPDATE "${collection.name}" SET data = ? WHERE _id = ?`, [
        '',
        result.insertedId,
      ]);

      const retrieved = await collection.findOne({ _id: result.insertedId });
      assert.ok(retrieved);
      assert.strictEqual(retrieved._id, result.insertedId);
      // Should return an empty object (no other properties)
      assert.strictEqual(Object.keys(retrieved).length, 1); // Only _id
    });

    it('should handle non-string data column', async () => {
      const doc = { name: 'test', value: 100 };
      const result = await collection.insertOne(doc);

      // Set non-string data (this shouldn't happen in normal operation but could happen with corruption)
      await client.database.run(`UPDATE "${collection.name}" SET data = ? WHERE _id = ?`, [
        null,
        result.insertedId,
      ]);

      const retrieved = await collection.findOne({ _id: result.insertedId });
      assert.ok(retrieved);
      assert.strictEqual(retrieved._id, result.insertedId);
      // Should return an empty object (no other properties)
      assert.strictEqual(Object.keys(retrieved).length, 1); // Only _id
    });
  });

  describe('Batch Insert Safety', () => {
    it('should validate all documents in a batch before insertion', async () => {
      const docs = [
        { name: 'valid1', value: 1 },
        { name: 'valid2', value: 2 },
        { name: 'invalid', value: 3, func: () => 'not allowed' } as unknown as TestDoc,
        { name: 'valid3', value: 4 },
      ];

      try {
        await collection.insertMany(docs);
        assert.fail('Should have thrown an error for invalid document in batch');
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('Functions are not allowed'));
      }

      // Verify no documents were inserted
      const count = await collection.find({}).count();
      assert.strictEqual(count, 0);
    });

    it('should successfully insert valid batch after validation', async () => {
      const docs = [
        { name: 'valid1', value: 1, data: { complex: true } },
        { name: 'valid2', value: 2, data: [1, 2, 3] },
        { name: 'valid3', value: 3, data: null },
      ];

      const results = await collection.insertMany(docs);
      assert.strictEqual(results.length, 3);
      results.forEach((result) => {
        assert.strictEqual(result.acknowledged, true);
        assert.ok(result.insertedId);
      });

      // Verify all documents were inserted
      const count = await collection.find({}).count();
      assert.strictEqual(count, 3);
    });
  });

  describe('Update Safety', () => {
    it('should handle corrupted JSON during updates', async () => {
      const doc = { name: 'test', value: 100 };
      const result = await collection.insertOne(doc);

      // Corrupt the JSON
      const corruptedJson = '{"name": "test", "value": 100, "corrupted": "missing quote}';
      await client.database.run(`UPDATE "${collection.name}" SET data = ? WHERE _id = ?`, [
        corruptedJson,
        result.insertedId,
      ]);

      // Update should still work with fallback object
      const updateResult = await collection.updateOne(
        { _id: result.insertedId },
        { $set: { name: 'updated' } }
      );

      assert.strictEqual(updateResult.acknowledged, true);
      assert.strictEqual(updateResult.matchedCount, 1);
      assert.strictEqual(updateResult.modifiedCount, 1);

      // Verify the update worked
      const updated = await collection.findOne({ _id: result.insertedId });
      assert.ok(updated);
      assert.strictEqual(updated.name, 'updated');
    });

    it('should safely stringify updated documents', async () => {
      const doc = { name: 'test', value: 100 };
      const result = await collection.insertOne(doc);

      // Try to update with complex data
      const updateResult = await collection.updateOne(
        { _id: result.insertedId },
        {
          $set: {
            data: {
              array: [1, 2, 3],
              nested: { deep: { value: true } },
              date: new Date(),
            },
          },
        }
      );

      assert.strictEqual(updateResult.acknowledged, true);
      assert.strictEqual(updateResult.modifiedCount, 1);

      const updated = await collection.findOne({ _id: result.insertedId });
      assert.ok(updated);
      assert.ok(updated.data);
    });
  });

  describe('Large Document Handling', () => {
    it('should handle documents with large amounts of data', async () => {
      const largeString = 'x'.repeat(10000);
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({
        index: i,
        data: `item-${i}`,
      }));

      const doc = {
        name: 'large',
        value: 100,
        largeString,
        largeArray,
      };

      const result = await collection.insertOne(doc);
      assert.strictEqual(result.acknowledged, true);

      const retrieved = await collection.findOne({ _id: result.insertedId });
      assert.ok(retrieved);
      assert.strictEqual(retrieved.name, 'large');
      assert.strictEqual(retrieved.largeString, largeString);
      assert.ok(Array.isArray(retrieved.largeArray));
      assert.strictEqual((retrieved.largeArray as unknown[]).length, 1000);
    });
  });
});
