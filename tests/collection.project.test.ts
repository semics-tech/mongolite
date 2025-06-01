import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index';

interface TestDoc extends DocumentWithId {
  name: string;
  age: number;
  email: string;
  address: {
    city: string;
    country: string;
  };
  tags?: string[];
}

describe('MongoLiteCollection - Projection Operations', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<TestDoc>;
  const testDocs: TestDoc[] = [
    {
      _id: '1',
      name: 'Test User 1',
      age: 30,
      email: 'test1@example.com',
      address: {
        city: 'Test City 1',
        country: 'Test Country 1',
      },
      tags: ['tag1', 'tag2'],
    },
    {
      _id: '2',
      name: 'Test User 2',
      age: 40,
      email: 'test2@example.com',
      address: {
        city: 'Test City 2',
        country: 'Test Country 2',
      },
      tags: ['tag2', 'tag3'],
    },
  ];

  beforeEach(async () => {
    client = new MongoLite(':memory:', {
      verbose: true,
    });
    await client.connect();
    collection = client.collection<TestDoc>('testProjectionCollection');
    // Insert test data
    for (const doc of testDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  describe('findOne() with projection', () => {
    it('should support numeric projection values (1)', async () => {
      const doc = await collection.findOne({ _id: '1' }, { name: 1, 'address.city': 1 });

      assert.strictEqual(Object.keys(doc!).length, 3);
      assert.strictEqual(doc!._id, '1');
      assert.strictEqual(doc!.name, 'Test User 1');
      assert.strictEqual(doc!.address.city, 'Test City 1');
      assert.strictEqual(doc!.address.country, undefined);
      assert.strictEqual(doc!.age, undefined);
      assert.strictEqual(doc!.email, undefined);
      assert.strictEqual(doc!.tags, undefined);
    });

    it('should support boolean projection values (true)', async () => {
      const doc = await collection.findOne({ _id: '1' }, { name: true, 'address.city': true });

      assert.strictEqual(Object.keys(doc!).length, 3);
      assert.strictEqual(doc!._id, '1');
      assert.strictEqual(doc!.name, 'Test User 1');
      assert.strictEqual(doc!.address.city, 'Test City 1');
      assert.strictEqual(doc!.address.country, undefined);
      assert.strictEqual(doc!.age, undefined);
      assert.strictEqual(doc!.email, undefined);
      assert.strictEqual(doc!.tags, undefined);
    });

    it('should support numeric projection values (0)', async () => {
      const doc = await collection.findOne({ _id: '1' }, { age: 0, email: 0, tags: 0 });

      assert.strictEqual(doc!._id, '1');
      assert.strictEqual(doc!.name, 'Test User 1');
      assert.strictEqual(doc!.address.city, 'Test City 1');
      assert.strictEqual(doc!.address.country, 'Test Country 1');
      assert.strictEqual(doc!.age, undefined);
      assert.strictEqual(doc!.email, undefined);
      assert.strictEqual(doc!.tags, undefined);
    });

    it('should support boolean projection values (false)', async () => {
      const doc = await collection.findOne({ _id: '1' }, { age: false, email: false, tags: false });

      assert.strictEqual(doc!._id, '1');
      assert.strictEqual(doc!.name, 'Test User 1');
      assert.strictEqual(doc!.address.city, 'Test City 1');
      assert.strictEqual(doc!.address.country, 'Test Country 1');
      assert.strictEqual(doc!.age, undefined);
      assert.strictEqual(doc!.email, undefined);
      assert.strictEqual(doc!.tags, undefined);
    });

    it('should handle _id exclusion with numeric projection (0)', async () => {
      const doc = await collection.findOne({ _id: '1' }, { _id: 0, name: 1, 'address.city': 1 });

      assert.strictEqual(Object.keys(doc!).length, 2);
      assert.strictEqual(doc!._id, undefined);
      assert.strictEqual(doc!.name, 'Test User 1');
      assert.strictEqual(doc!.address.city, 'Test City 1');
    });

    it('should handle _id exclusion with boolean projection (false)', async () => {
      const doc = await collection.findOne(
        { _id: '1' },
        { _id: false, name: true, 'address.city': true }
      );

      assert.strictEqual(Object.keys(doc!).length, 2);
      assert.strictEqual(doc!._id, undefined);
      assert.strictEqual(doc!.name, 'Test User 1');
      assert.strictEqual(doc!.address.city, 'Test City 1');
    });
  });

  describe('find() with projection', () => {
    it('should apply projection to all returned documents', async () => {
      const docs = await collection.find({}).project({ name: 1, age: 1 }).toArray();

      assert.strictEqual(docs.length, 2);

      for (const doc of docs) {
        assert.strictEqual(Object.keys(doc).length, 3); // _id, name, age
        assert.ok(doc._id);
        assert.ok(doc.name);
        assert.ok(typeof doc.age === 'number');
        assert.strictEqual(doc.email, undefined);
        assert.strictEqual(doc.address, undefined);
        assert.strictEqual(doc.tags, undefined);
      }
    });

    it('should support boolean projection values in find().project()', async () => {
      const docs = await collection.find({}).project({ name: true, age: true }).toArray();

      assert.strictEqual(docs.length, 2);

      for (const doc of docs) {
        assert.strictEqual(Object.keys(doc).length, 3); // _id, name, age
        assert.ok(doc._id);
        assert.ok(doc.name);
        assert.ok(typeof doc.age === 'number');
        assert.strictEqual(doc.email, undefined);
        assert.strictEqual(doc.address, undefined);
        assert.strictEqual(doc.tags, undefined);
      }
    });

    it('should exclude fields with boolean false in find().project()', async () => {
      const docs = await collection.find({}).project({ email: false, tags: false }).toArray();

      assert.strictEqual(docs.length, 2);

      for (const doc of docs) {
        assert.ok(doc._id);
        assert.ok(doc.name);
        assert.ok(typeof doc.age === 'number');
        assert.ok(doc.address);
        assert.strictEqual(doc.email, undefined);
        assert.strictEqual(doc.tags, undefined);
      }
    });

    it('should support mixing boolean and numeric values in projection', async () => {
      const docs = await collection
        .find({})
        .project({ name: true, age: 1, email: false, tags: 0 })
        .toArray();

      assert.strictEqual(docs.length, 2);

      for (const doc of docs) {
        assert.strictEqual(Object.keys(doc).length, 3); // _id, name, age
        assert.ok(doc._id);
        assert.ok(doc.name);
        assert.ok(typeof doc.age === 'number');
        assert.strictEqual(doc.email, undefined);
        assert.strictEqual(doc.tags, undefined);
      }
    });
  });
});
