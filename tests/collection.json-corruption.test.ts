/**
 * Regression coverage for corrupted `data` columns.
 *
 * SQLite's json1 functions (`json_extract`, `json_each`) throw
 * `malformed JSON` as soon as they evaluate a row whose `data` isn't valid JSON —
 * even a row that could never have matched the filter. Before the
 * `json_valid(data)` guard, a single corrupted document made *every* filtered
 * query against that collection fail, turning one bad row into a full outage for
 * the collection.
 *
 * These tests corrupt a row deliberately (writing raw SQL, bypassing the
 * library's own `safeJsonStringify` validation, which is exactly what an external
 * writer or a partial write would do) and assert reads stay up.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite, MongoLiteCollection, DocumentWithId } from '../src/index';

interface UserDoc extends DocumentWithId {
  name: string;
  clientCode?: string;
  role?: string;
  tags?: string[];
  items?: { k: string }[];
  api?: { available?: boolean };
}

const COLLECTION = 'testCorruptionCollection';

describe('MongoLiteCollection - corrupted JSON resilience', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<UserDoc>;

  /** Writes an unparseable value straight into the data column. */
  const corruptRow = async (id: string, raw = '{"name":"broken",') => {
    await client.database.run(`INSERT INTO "${COLLECTION}" (_id, data) VALUES (?, ?)`, [id, raw]);
  };

  beforeEach(async () => {
    client = new MongoLite(':memory:');
    await client.connect();
    collection = client.collection<UserDoc>(COLLECTION);

    await collection.insertOne({
      _id: 'good-1',
      name: 'Alice',
      clientCode: 'ACME',
      role: 'admin',
      tags: ['a', 'b'],
      api: { available: true },
    });
    await collection.insertOne({
      _id: 'good-2',
      name: 'Bob',
      clientCode: 'BETA',
      role: 'user',
      tags: ['c'],
      api: { available: false },
    });

    await corruptRow('bad-1');
  });

  afterEach(async () => {
    await client.close();
  });

  describe('filtered reads survive a corrupt row', () => {
    it('find() on a top-level field returns the valid documents', async () => {
      const results = await collection.find({ clientCode: 'ACME' }).toArray();

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]._id, 'good-1');
    });

    it('find() on a nested field does not throw', async () => {
      const results = await collection.find({ 'api.available': true }).toArray();

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0]._id, 'good-1');
    });

    it('handles $in, $nin, $or, $regex and $all', async () => {
      const inResults = await collection.find({ role: { $in: ['admin', 'user'] } }).toArray();
      assert.strictEqual(inResults.length, 2);

      const ninResults = await collection.find({ role: { $nin: ['admin'] } }).toArray();
      assert.deepStrictEqual(
        ninResults.map((r) => r._id),
        ['good-2']
      );

      const orResults = await collection
        .find({ $or: [{ clientCode: 'ACME' }, { clientCode: 'BETA' }] })
        .toArray();
      assert.strictEqual(orResults.length, 2);

      const regexResults = await collection.find({ name: { $regex: '^Ali' } }).toArray();
      assert.strictEqual(regexResults.length, 1);

      const allResults = await collection.find({ tags: { $all: ['c'] } }).toArray();
      assert.deepStrictEqual(
        allResults.map((r) => r._id),
        ['good-2']
      );
    });

    it('handles $elemMatch over an array of objects', async () => {
      await collection.insertOne({
        _id: 'good-3',
        name: 'Carol',
        items: [{ k: 'wanted' }],
      } as UserDoc);

      const results = await collection.find({ items: { $elemMatch: { k: 'wanted' } } }).toArray();

      assert.deepStrictEqual(
        results.map((r) => r._id),
        ['good-3']
      );
    });

    it('findOne() does not throw', async () => {
      const found = await collection.findOne({ name: 'Bob' });

      assert.ok(found);
      assert.strictEqual(found._id, 'good-2');
    });

    it('countDocuments() excludes the corrupt row', async () => {
      assert.strictEqual(await collection.countDocuments({ role: { $exists: true } }), 2);
    });

    it('updateMany() does not throw and skips the corrupt row', async () => {
      const result = await collection.updateMany(
        { role: { $exists: true } },
        { $set: { role: 'archived' } }
      );

      assert.strictEqual(result.matchedCount, 2);
    });

    it('aggregate() with a leading $match does not throw', async () => {
      const results = await collection
        .aggregate([{ $match: { clientCode: 'ACME' } }, { $count: 'total' }])
        .toArray();

      assert.deepStrictEqual(results, [{ total: 1 }]);
    });

    it('stays up when every row is corrupt', async () => {
      await collection.deleteMany({});
      await corruptRow('bad-only', '<<not json at all>>');

      assert.deepStrictEqual(await collection.find({ clientCode: 'ACME' }).toArray(), []);
    });
  });

  describe('negated filters must not match corrupt rows', () => {
    // The guard is applied only at the top level for this reason: nested inside a
    // `NOT (...)` it would invert to `NOT (0 AND ...)` = true, so corrupt rows
    // would start matching every negated filter.
    it('$nor does not return the corrupt row', async () => {
      const results = await collection.find({ $nor: [{ clientCode: 'ACME' }] }).toArray();

      assert.deepStrictEqual(
        results.map((r) => r._id),
        ['good-2']
      );
    });

    it('$ne does not return the corrupt row', async () => {
      const results = await collection.find({ clientCode: { $ne: 'ACME' } }).toArray();

      assert.deepStrictEqual(
        results.map((r) => r._id),
        ['good-2']
      );
    });

    it('$not does not return the corrupt row', async () => {
      const results = await collection.find({ $not: { clientCode: 'ACME' } }).toArray();

      assert.deepStrictEqual(
        results.map((r) => r._id),
        ['good-2']
      );
    });
  });

  describe('corrupt rows remain reachable for cleanup', () => {
    it('findInvalidJson() reports them with their raw contents', async () => {
      const invalid = await collection.findInvalidJson();

      assert.strictEqual(invalid.length, 1);
      assert.strictEqual(invalid[0]._id, 'bad-1');
      assert.strictEqual(invalid[0].data, '{"name":"broken",');
    });

    it('countInvalidJson() counts them', async () => {
      assert.strictEqual(await collection.countInvalidJson(), 1);

      await corruptRow('bad-2', 'null-ish {');
      assert.strictEqual(await collection.countInvalidJson(), 2);
    });

    it('reports zero for a healthy collection', async () => {
      await collection.deleteOne({ _id: 'bad-1' });

      assert.strictEqual(await collection.countInvalidJson(), 0);
      assert.deepStrictEqual(await collection.findInvalidJson(), []);
    });

    it('deleteOne({ _id }) can remove a corrupt row', async () => {
      const result = await collection.deleteOne({ _id: 'bad-1' });

      assert.strictEqual(result.deletedCount, 1);
      assert.strictEqual(await collection.countInvalidJson(), 0);
    });

    it('deleteMany({}) purges corrupt rows', async () => {
      // The empty filter is intentionally left unguarded so this escape hatch
      // keeps working — otherwise corrupt rows could never be cleared in bulk.
      await collection.deleteMany({});

      assert.strictEqual(await collection.estimatedDocumentCount(), 0);
    });

    it('unfiltered find() still surfaces the row, in degraded form', async () => {
      const results = await collection.find({}).toArray();
      const corrupt = results.find((r) => r._id === 'bad-1') as
        (UserDoc & { __mongoLiteCorrupted?: boolean }) | undefined;

      assert.ok(corrupt, 'unfiltered reads should still expose the corrupt row');
      assert.strictEqual(corrupt.__mongoLiteCorrupted, true);
    });
  });
});
