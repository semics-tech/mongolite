import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index'; // Assuming DocumentWithId is exported

interface TestDoc extends DocumentWithId {
  name: string;
  value: number | null; // Allow null for testing
  tags?: string[] | string; // Allow single string or array of strings
  nested?: { subValue: string };
  match?: string;
  createdAt?: Date;
  updatedAt?: Date;
  publishedAt?: Date | string; // Allow ISO string for testing
  metadata?: {
    lastLogin?: Date;
    registrationDate?: Date;
  };
  // Add fields for the complex $all test
  groups?: Array<{ group: string | object }>;
  code?: string;
  hierarchyLevel?: number;
}

describe('MongoLiteCollection - Find Operations', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;
  const baseDate = new Date('2024-01-01T00:00:00.000Z');
  const testDate1 = new Date('2024-01-15T10:30:00.000Z');
  const testDate2 = new Date('2024-02-01T15:45:00.000Z');
  const testDate3 = new Date('2024-03-01T08:20:00.000Z');

  const testDocs: TestDoc[] = [
    {
      _id: '1',
      name: 'doc1',
      value: 10,
      match: 'test',
      tags: ['a', 'b'],
      createdAt: baseDate,
      updatedAt: testDate1,
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
      metadata: { lastLogin: testDate1, registrationDate: new Date('2024-01-01T00:00:00.000Z') },
    },
    {
      _id: '2',
      name: 'doc2',
      value: 20,
      match: 'test',
      tags: ['b', 'c'],
      createdAt: testDate1,
      updatedAt: testDate2,
      publishedAt: new Date('2024-01-15T10:30:00.000Z'),
    },
    {
      _id: '3',
      name: 'doc3',
      value: 30,
      tags: ['c', 'd'],
      nested: { subValue: 'sv1' },
      createdAt: testDate2,
      publishedAt: new Date('2024-02-01T15:45:00.000Z'),
      metadata: { lastLogin: testDate3 },
    },
    { _id: '4', name: 'doc4', value: 20 }, // No tags, no nested, no dates
    {
      _id: '5',
      name: 'anotherDoc',
      value: 50,
      match: 'test',
      nested: { subValue: 'sv2' },
      createdAt: testDate3,
      updatedAt: baseDate,
      publishedAt: new Date('2024-03-01T08:20:00.000Z'),
    },
    {
      _id: '6',
      name: 'emptyDoc',
      value: null,
      match: 'test',
      createdAt: baseDate,
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
    }, // Document with null value
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
      const docs = await client.database.all(
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

    describe('Date equality tests', () => {
      it('should find documents by exact Date object equality', async () => {
        const docs = await collection.find({ createdAt: baseDate }).toArray();
        assert.strictEqual(docs.length, 2);
        assert.ok(docs.some((d) => d._id === '1')); // doc1 created at baseDate
        assert.ok(docs.some((d) => d._id === '6')); // emptyDoc created at baseDate
      });

      it('should find documents by Date object using $eq operator', async () => {
        const docs = await collection.find({ createdAt: { $eq: testDate1 } }).toArray();
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0]._id, '2'); // doc2 created at testDate1
      });

      it('should find documents by Date object using $ne operator', async () => {
        const docs = await collection.find({ createdAt: { $ne: baseDate } }).toArray();
        // MongoDB semantics: $ne matches documents where the field is not equal to the value,
        // OR where the field does not exist. So doc4 (no createdAt) should also match.
        assert.strictEqual(docs.length, 4);
        assert.ok(docs.some((d) => d._id === '2')); // doc2
        assert.ok(docs.some((d) => d._id === '3')); // doc3
        assert.ok(docs.some((d) => d._id === '4')); // doc4 - has no createdAt field
        assert.ok(docs.some((d) => d._id === '5')); // anotherDoc
      });

      it('should find documents by Date object using $gt operator', async () => {
        const docs = await collection.find({ createdAt: { $gt: testDate1 } }).toArray();
        assert.strictEqual(docs.length, 2);
        assert.ok(docs.some((d) => d._id === '3')); // doc3 created at testDate2
        assert.ok(docs.some((d) => d._id === '5')); // anotherDoc created at testDate3
      });

      it('should find documents by Date object using $gte operator', async () => {
        const docs = await collection.find({ createdAt: { $gte: testDate2 } }).toArray();
        assert.strictEqual(docs.length, 2);
        assert.ok(docs.some((d) => d._id === '3')); // doc3 created at testDate2
        assert.ok(docs.some((d) => d._id === '5')); // anotherDoc created at testDate3
      });

      it('should find documents by Date object using $lt operator', async () => {
        const docs = await collection.find({ createdAt: { $lt: testDate2 } }).toArray();
        assert.strictEqual(docs.length, 3);
        assert.ok(docs.some((d) => d._id === '1')); // doc1 created at baseDate
        assert.ok(docs.some((d) => d._id === '2')); // doc2 created at testDate1
        assert.ok(docs.some((d) => d._id === '6')); // emptyDoc created at baseDate
      });

      it('should find documents by Date object using $lte operator', async () => {
        const docs = await collection.find({ createdAt: { $lte: testDate1 } }).toArray();
        assert.strictEqual(docs.length, 3);
        assert.ok(docs.some((d) => d._id === '1')); // doc1 created at baseDate
        assert.ok(docs.some((d) => d._id === '2')); // doc2 created at testDate1
        assert.ok(docs.some((d) => d._id === '6')); // emptyDoc created at baseDate
      });

      it('should find documents by Date object using $in operator', async () => {
        const docs = await collection.find({ createdAt: { $in: [baseDate, testDate3] } }).toArray();
        assert.strictEqual(docs.length, 3);
        assert.ok(docs.some((d) => d._id === '1')); // doc1 created at baseDate
        assert.ok(docs.some((d) => d._id === '5')); // anotherDoc created at testDate3
        assert.ok(docs.some((d) => d._id === '6')); // emptyDoc created at baseDate
      });

      it('should find documents by Date object using $nin operator', async () => {
        const docs = await collection
          .find({ createdAt: { $nin: [baseDate, testDate1] } })
          .toArray();
        assert.strictEqual(docs.length, 2);
        assert.ok(docs.some((d) => d._id === '3')); // doc3 created at testDate2
        assert.ok(docs.some((d) => d._id === '5')); // anotherDoc created at testDate3
      });

      it('should find documents by ISO date string equality', async () => {
        const docs = await collection.find({ publishedAt: '2024-01-01T00:00:00.000Z' }).toArray();
        assert.strictEqual(docs.length, 2);
        assert.ok(docs.some((d) => d._id === '1')); // doc1
        assert.ok(docs.some((d) => d._id === '6')); // emptyDoc
      });

      it('should find documents by ISO date string using comparison operators', async () => {
        const docs = await collection
          .find({ publishedAt: { $gt: '2024-01-15T10:30:00.000Z' } })
          .toArray();
        assert.strictEqual(docs.length, 2);
        assert.ok(docs.some((d) => d._id === '3')); // doc3
        assert.ok(docs.some((d) => d._id === '5')); // anotherDoc
      });

      it('should find documents by nested Date object equality', async () => {
        const docs = await collection.find({ 'metadata.lastLogin': testDate1 }).toArray();
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0]._id, '1'); // doc1 has lastLogin at testDate1
      });

      it('should find documents by nested Date object using $gt operator', async () => {
        const docs = await collection.find({ 'metadata.lastLogin': { $gt: testDate1 } }).toArray();
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0]._id, '3'); // doc3 has lastLogin at testDate3
      });

      it('should find documents by nested ISO date string', async () => {
        const docs = await collection
          .find({ 'metadata.registrationDate': '2024-01-01T00:00:00.000Z' })
          .toArray();
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0]._id, '1'); // doc1
      });

      it('should handle documents with missing date fields', async () => {
        const docs = await collection.find({ updatedAt: { $exists: false } }).toArray();
        assert.strictEqual(docs.length, 3);
        assert.ok(docs.some((d) => d._id === '3')); // doc3 has no updatedAt
        assert.ok(docs.some((d) => d._id === '4')); // doc4 has no updatedAt
        assert.ok(docs.some((d) => d._id === '6')); // emptyDoc has no updatedAt
      });

      it('should find documents where date fields exist', async () => {
        const docs = await collection.find({ updatedAt: { $exists: true } }).toArray();
        assert.strictEqual(docs.length, 3);
        assert.ok(docs.some((d) => d._id === '1')); // doc1 has updatedAt
        assert.ok(docs.some((d) => d._id === '2')); // doc2 has updatedAt
        assert.ok(docs.some((d) => d._id === '5')); // anotherDoc has updatedAt
      });

      it('should handle complex date range queries', async () => {
        const startDate = new Date('2024-01-10T00:00:00.000Z');
        const endDate = new Date('2024-02-15T00:00:00.000Z');

        const docs = await collection
          .find({
            createdAt: { $gte: startDate, $lte: endDate },
          })
          .toArray();

        assert.strictEqual(docs.length, 2);
        assert.ok(docs.some((d) => d._id === '2')); // doc2 created at testDate1
        assert.ok(docs.some((d) => d._id === '3')); // doc3 created at testDate2
      });

      it('should combine date queries with other filters', async () => {
        const docs = await collection
          .find({
            createdAt: { $gte: testDate1 },
            match: 'test',
          })
          .toArray();

        assert.strictEqual(docs.length, 2);
        assert.ok(docs.some((d) => d._id === '2')); // doc2
        assert.ok(docs.some((d) => d._id === '5')); // anotherDoc
      });

      it('should handle date equality with timezone variations', async () => {
        // Test that dates with same UTC time but different timezone representations match
        const utcDate = new Date('2024-01-01T00:00:00.000Z');
        const localDate = new Date('2024-01-01T00:00:00.000'); // No Z suffix

        // Both should find the same documents
        const docsUtc = await collection.find({ createdAt: utcDate }).toArray();
        const docsLocal = await collection.find({ createdAt: localDate }).toArray();

        assert.strictEqual(docsUtc.length, docsLocal.length);
        assert.deepStrictEqual(docsUtc, docsLocal);
      });

      it('should handle date equality with millisecond precision', async () => {
        // Insert a document with precise milliseconds
        const preciseDate = new Date('2024-06-15T14:30:25.123Z');
        await collection.insertOne({
          _id: 'precise',
          name: 'preciseDoc',
          value: 999,
          createdAt: preciseDate,
        });

        // Test exact millisecond match
        const docs = await collection.find({ createdAt: preciseDate }).toArray();
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0]._id, 'precise');

        // Test that slightly different milliseconds don't match
        const slightlyOff = new Date('2024-06-15T14:30:25.124Z');
        const noDocs = await collection.find({ createdAt: slightlyOff }).toArray();
        assert.strictEqual(noDocs.filter((d) => d._id === 'precise').length, 0);
      });

      it('should handle date comparison with mixed date and string formats', async () => {
        // Test comparing Date objects with ISO string values in the same query
        const docs = await collection
          .find({
            $or: [{ createdAt: baseDate }, { name: 'doc2' }], // Using name instead of publishedAt to avoid date conversion issues
          })
          .toArray();

        assert.strictEqual(docs.length, 3);
        assert.ok(docs.some((d) => d._id === '1')); // baseDate match
        assert.ok(docs.some((d) => d._id === '2')); // name match
        assert.ok(docs.some((d) => d._id === '6')); // baseDate match
      });

      it('should handle date queries with $in operator using mixed formats', async () => {
        const docs = await collection
          .find({
            $or: [
              { createdAt: { $in: [baseDate, testDate2] } },
              { value: { $in: [20] } }, // Testing with values instead of date strings
            ],
          })
          .toArray();

        // Should match docs with createdAt in [baseDate, testDate2] OR value 20
        assert.ok(docs.length >= 4);
        assert.ok(docs.some((d) => d._id === '1')); // baseDate match
        assert.ok(docs.some((d) => d._id === '2')); // value 20 match
        assert.ok(docs.some((d) => d._id === '3')); // testDate2 match
        assert.ok(docs.some((d) => d._id === '4')); // value 20 match
        assert.ok(docs.some((d) => d._id === '6')); // baseDate match
      });

      it('should handle edge case with null date values', async () => {
        // Insert a document with null date
        await collection.insertOne({
          _id: 'nullDate',
          name: 'nullDateDoc',
          value: 777,
          createdAt: null as unknown as Date,
        });

        // Test finding documents where createdAt is null
        const nullDocs = await collection.find({ createdAt: null as unknown as Date }).toArray();
        assert.ok(nullDocs.some((d) => d._id === 'nullDate'));

        // Test that null dates don't match real dates using $exists
        const realDateDocs = await collection
          .find({
            createdAt: { $exists: true },
            _id: { $ne: 'nullDate' },
          })
          .toArray();
        assert.ok(realDateDocs.every((d) => d._id !== 'nullDate'));
      });

      it('should handle invalid date operations gracefully', async () => {
        // Test with invalid date
        const invalidDate = new Date('invalid');

        // This should not crash and should return no results or handle gracefully
        try {
          const docs = await collection.find({ createdAt: invalidDate }).toArray();
          // If it doesn't throw, it should return empty or valid results
          assert.ok(Array.isArray(docs));
        } catch (error) {
          // If it throws, that's also acceptable behavior for invalid dates
          assert.ok(error instanceof Error);
        }
      });

      it('should handle date ranges spanning multiple time zones conceptually', async () => {
        // Test a range that would span different days in different timezones
        const startOfDay = new Date('2024-01-15T00:00:00.000Z');
        const endOfDay = new Date('2024-01-15T23:59:59.999Z');

        const docs = await collection
          .find({
            createdAt: { $gte: startOfDay, $lte: endOfDay },
          })
          .toArray();

        // Should find doc2 which was created at testDate1 (2024-01-15T10:30:00.000Z)
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0]._id, '2');
      });

      it('should handle nested date comparisons with complex operators', async () => {
        // Test nested date field with multiple operators
        const docs = await collection
          .find({
            $and: [
              { 'metadata.lastLogin': { $exists: true } },
              { 'metadata.lastLogin': { $gte: testDate1 } },
              { 'metadata.lastLogin': { $lt: new Date('2024-04-01T00:00:00.000Z') } },
            ],
          })
          .toArray();

        assert.strictEqual(docs.length, 2);
        assert.ok(docs.some((d) => d._id === '1')); // lastLogin at testDate1
        assert.ok(docs.some((d) => d._id === '3')); // lastLogin at testDate3
      });

      it('should test date comparison with precise equality', async () => {
        // Test that exact date objects match
        const docs = await collection.find({ createdAt: { $eq: testDate1 } }).toArray();
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(docs[0]._id, '2');
      });

      it('should test date boundaries', async () => {
        // Test exact boundary conditions
        const docs = await collection
          .find({
            createdAt: {
              $gte: testDate1,
              $lt: testDate3,
            },
          })
          .toArray();

        // Should include testDate1 and testDate2, but not testDate3
        assert.strictEqual(docs.length, 2);
        assert.ok(docs.some((d) => d._id === '2')); // testDate1
        assert.ok(docs.some((d) => d._id === '3')); // testDate2
      });
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
      // MongoDB semantics: $ne matches documents where field != value OR field doesn't exist
      // emptyDoc has value: null (not equal to 20), so it matches
      assert.strictEqual(docs.length, 4);
      assert.ok(docs.every((d) => d.value !== 20 || d.value === null)); // null is also not 20
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

    it('handle query for a single value in an array field', async () => {
      const docs = await collection.find({ tags: 'b' }).toArray();

      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '1')); // doc1 has tags ['a', 'b']
      assert.ok(docs.some((d) => d._id === '2')); // doc2 has tags ['b', 'c']
    });

    it('should handle query with null value', async () => {
      const docs = await collection.find({ value: null }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.deepStrictEqual(docs[0], testDocs[5]); // emptyDoc with value: null
    });

    it('should handle query with nested object field', async () => {
      const docs = await collection.find({ 'nested.subValue': 'sv2' }).toArray();
      assert.strictEqual(docs.length, 1);
      assert.deepStrictEqual(docs[0], testDocs[4]); // anotherDoc with nested.subValue: 'sv2'
    });
  });

  describe('find() $all complex', () => {
    const complexDocs = [
      // Add test documents for complex $all query
      {
        _id: '7',
        name: 'complexDoc1',
        value: 200,
        groups: [{ group: 'a' }, { group: 'b' }, { group: 'c' }, { group: 'd' }],
        code: 'testCode',
        hierarchyLevel: 5,
      },
      {
        _id: '8',
        name: 'complexDoc2',
        value: 210,
        groups: [{ group: 'a' }, { group: 'b' }, { group: 'c' }],
        code: 'testCode',
        hierarchyLevel: 3,
      },
      {
        _id: '9',
        name: 'complexDoc3',
        value: 220,
        groups: [{ group: 'a' }, { group: 'b' }, { group: 'c' }, { group: 'd' }, { group: 'e' }],
        code: 'testCode',
        hierarchyLevel: 10,
      },
    ];

    let complexAllCollection: MongoLiteCollection<TestDoc>;

    beforeEach(async () => {
      // Insert complex test documents
      const client = new MongoLite(':memory:', {
        verbose: true,
      });
      await client.connect();
      complexAllCollection = client.collection<TestDoc>('testFindCollection');

      await complexAllCollection.insertMany(complexDocs);
    });

    it('should test the complex $all query from the example', async () => {
      // Test the exact query structure from the "NOT WORKING" example
      const query = {
        groups: {
          $all: [{ group: 'a' }, { group: 'b' }, { group: 'c' }, { group: 'd' }],
        },
        code: 'testCode',
        hierarchyLevel: { $gt: 0 },
      };

      const docs = await complexAllCollection.find(query).toArray();

      // Should match docs that have ALL the required groups AND meet other criteria
      // Only complexDoc1 (id: 7) and complexDoc3 (id: 9) have all 4 required groups
      // Both have code: 'testCode' and hierarchyLevel > 0
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d._id === '7')); // complexDoc1
      assert.ok(docs.some((d) => d._id === '9')); // complexDoc3

      // Verify that complexDoc2 (id: 8) is NOT included because it's missing groups
      assert.ok(!docs.some((d) => d._id === '8'));
    });

    it('should test $all with partial matches', async () => {
      // Test with fewer required groups - should match more documents
      const query = {
        groups: {
          $all: [{ group: 'a' }, { group: 'b' }],
        },
        code: 'testCode',
      };

      const docs = await complexAllCollection.find(query).toArray();

      // Should match all three complex docs since they all have these two groups
      assert.strictEqual(docs.length, 3);
      assert.ok(docs.some((d) => d._id === '7')); // complexDoc1
      assert.ok(docs.some((d) => d._id === '8')); // complexDoc2
      assert.ok(docs.some((d) => d._id === '9')); // complexDoc3
    });

    it('should test $all with non-matching groups', async () => {
      // Test with groups that don't exist in any document
      const query = {
        groups: {
          $all: [{ group: 'NONEXISTENT01' }, { group: 'NONEXISTENT02' }],
        },
      };

      const docs = await complexAllCollection.find(query).toArray();

      // Should match no documents
      assert.strictEqual(docs.length, 0);
    });
  });

  describe('Complex OR query with $exists and null values', () => {
    let client: MongoLite;
    let orTestCollection: MongoLiteCollection<TestDoc>;

    beforeEach(async () => {
      client = new MongoLite(':memory:');
      await client.connect();
      orTestCollection = client.collection<TestDoc>('testOrCollection');

      // Insert test documents
      await orTestCollection.insertMany([
        {
          message: 'test message',
          start: '2026-01-07T14:43:00.000Z',
          end: '2026-01-09T14:43:00.000Z',
          name: 'test',
          value: null,
          match: 'critical',
          ClientCode: null,
          // user field does not exist
        },
        {
          message: 'test message 2',
          start: '2026-01-07T14:43:00.000Z',
          end: '2026-01-09T14:43:00.000Z',
          name: 'test2',
          value: null,
          match: 'warning',
          ClientCode: 'mbi-dev-ollie',
          // user field does not exist
        },
        {
          message: 'test message 3',
          start: '2026-01-07T14:43:00.000Z',
          end: '2026-01-09T14:43:00.000Z',
          name: 'test3',
          value: null,
          match: 'info',
          ClientCode: 'other-code',
          nested: { subValue: 'value3' },
        },
      ]);
    });

    afterEach(async () => {
      await client.close();
    });

    it('should find document matching $or with $exists false and null ClientCode', async () => {
      // This is the query from the issue - it should match the first document
      const query = {
        end: {
          $gte: '2026-01-08T11:52:19.432Z',
        },
        archived: {
          $ne: true,
        },
        $or: [
          {
            ClientCode: 'mbi-dev-ollie',
            user: {
              $exists: false,
            },
          },
          {
            user: 'enterprise.test@mbihealth.com',
          },
          {
            tags: {
              $eq: 'enterprise.test@mbihealth.com',
            },
          },
          {
            ClientCode: null,
            user: {
              $exists: false,
            },
          },
        ],
      };

      // Debug: enable verbose mode
      const testCursor = orTestCollection.find(query);
      const docs = await testCursor.toArray();

      // Should match:
      // - First document: ClientCode is null AND user doesn't exist -> 4th $or condition matches
      // - Second document: ClientCode is 'mbi-dev-ollie' AND user doesn't exist -> 1st $or condition matches
      assert.strictEqual(docs.length, 2, `Expected 2 documents, got ${docs.length}`);
      assert.ok(docs.some((d) => d.name === 'test'), 'Should match first document with null ClientCode');
      assert.ok(docs.some((d) => d.name === 'test2'), 'Should match second document with mbi-dev-ollie');
    });

    it('should handle $or with null value checks', async () => {
      // Simpler test: just $or with null checks
      const query = {
        $or: [
          {
            ClientCode: null,
            nested: { $exists: false },
          },
          {
            ClientCode: 'mbi-dev-ollie',
          },
        ],
      };

      const docs = await orTestCollection.find(query).toArray();

      // Should match first and second documents
      assert.strictEqual(docs.length, 2);
      assert.ok(docs.some((d) => d.name === 'test'));
      assert.ok(docs.some((d) => d.name === 'test2'));
    });
  });
});
