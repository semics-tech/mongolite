import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index';

interface Doc extends DocumentWithId {
  name?: string;
  price?: number;
  qty?: number;
  cat?: string;
  tags?: string[];
  meta?: { a: number };
  userId?: string;
}

describe('Aggregation correctness', () => {
  let client: MongoLite;
  let c: MongoLiteCollection<Doc>;

  beforeEach(async () => {
    client = new MongoLite(':memory:');
    await client.connect();
    c = client.collection<Doc>('agg');
    await c.insertMany([
      { _id: '1', name: 'a', price: 10, qty: 2, cat: 'x', tags: ['t1', 't2'], userId: 'u1' },
      { _id: '2', name: 'b', price: 5, qty: 10, cat: 'x', tags: [], userId: 'u2' },
      { _id: '3', name: 'c', price: 7, qty: 1, cat: 'y', userId: 'u1' },
      { _id: '4', name: 'd', price: 3, qty: 3, cat: 'y', tags: ['t1'], userId: 'zz' },
    ]);
  });
  afterEach(async () => {
    await client.close();
  });

  describe('unknown stages / accumulators', () => {
    it('throws on an unknown stage', async () => {
      await assert.rejects(c.aggregate([{ $bucket: {} }]).toArray(), /\$bucket/);
    });
    it('throws on an unknown stage after a valid one', async () => {
      await assert.rejects(c.aggregate([{ $match: {} }, { $nope: 1 }]).toArray(), /\$nope/);
    });
    it('throws on an unknown $group accumulator', async () => {
      await assert.rejects(
        c.aggregate([{ $group: { _id: null, x: { $stdDevPop: '$price' } } }]).toArray(),
        /\$stdDevPop/
      );
    });
  });

  describe('$addFields / $project / $expr', () => {
    it('$addFields evaluates expressions', async () => {
      const r = await c
        .aggregate([
          { $match: { _id: '1' } },
          { $addFields: { total: { $multiply: ['$price', '$qty'] }, copy: '$name', k: 5 } },
        ])
        .toArray();
      assert.strictEqual(r[0].total, 20);
      assert.strictEqual(r[0].copy, 'a');
      assert.strictEqual(r[0].k, 5);
    });
    it('$set is an alias of $addFields', async () => {
      const r = await c
        .aggregate([{ $match: { _id: '1' } }, { $set: { d: { $add: ['$price', 1] } } }])
        .toArray();
      assert.strictEqual(r[0].d, 11);
    });
    it('$project keeps computed fields', async () => {
      const r = await c
        .aggregate([
          { $match: { _id: '1' } },
          { $project: { name: 1, total: { $multiply: ['$price', '$qty'] }, _id: 0 } },
        ])
        .toArray();
      assert.deepStrictEqual(r, [{ name: 'a', total: 20 }]);
    });
    it('$match with $expr evaluates (first stage)', async () => {
      const r = await c.aggregate([{ $match: { $expr: { $gt: ['$price', '$qty'] } } }]).toArray();
      assert.deepStrictEqual(r.map((d) => d._id).sort(), ['1', '3']);
    });
    it('$match with $expr evaluates (later stage)', async () => {
      const r = await c
        .aggregate([
          { $sort: { _id: 1 } },
          { $match: { cat: 'y', $expr: { $gt: ['$price', '$qty'] } } },
        ])
        .toArray();
      assert.deepStrictEqual(
        r.map((d) => d._id),
        ['3']
      );
    });
    it('$expr inside $or', async () => {
      const r = await c
        .aggregate([{ $match: { $or: [{ _id: '1' }, { $expr: { $eq: ['$name', 'b'] } }] } }])
        .toArray();
      assert.deepStrictEqual(r.map((d) => d._id).sort(), ['1', '2']);
    });
  });

  describe('scalar $elemMatch', () => {
    it('works in find()', async () => {
      const r = await c.find({ tags: { $elemMatch: { $eq: 't2' } } }).toArray();
      assert.deepStrictEqual(
        r.map((d) => d._id),
        ['1']
      );
    });
    it('works in aggregate $match', async () => {
      const r = await c.aggregate([{ $match: { tags: { $elemMatch: { $eq: 't1' } } } }]).toArray();
      assert.deepStrictEqual(r.map((d) => d._id).sort(), ['1', '4']);
    });
  });

  describe('$unwind', () => {
    it('drops empty/missing arrays by default', async () => {
      const r = await c.aggregate([{ $unwind: '$tags' }]).toArray();
      assert.strictEqual(r.length, 3);
    });
    it('preserveNullAndEmptyArrays keeps them', async () => {
      const r = await c
        .aggregate([
          { $unwind: { path: '$tags', preserveNullAndEmptyArrays: true } },
          { $sort: { _id: 1 } },
        ])
        .toArray();
      assert.strictEqual(r.length, 5);
      const two = r.find((d) => d._id === '2')!;
      assert.ok(!('tags' in two));
      const three = r.find((d) => d._id === '3')!;
      assert.ok(!('tags' in three));
    });
    it('includeArrayIndex', async () => {
      const r = await c
        .aggregate([
          { $match: { _id: '1' } },
          { $unwind: { path: '$tags', includeArrayIndex: 'i' } },
        ])
        .toArray();
      assert.deepStrictEqual(
        r.map((d) => d.i),
        [0, 1]
      );
    });
  });

  describe('$group', () => {
    it('$addToSet de-duplicates', async () => {
      const r = await c
        .aggregate([{ $group: { _id: '$cat', users: { $addToSet: '$userId' } } }])
        .toArray();
      const x = r.find((d) => d._id === 'x')!;
      assert.deepStrictEqual((x.users as string[]).sort(), ['u1', 'u2']);
      const y = r.find((d) => d._id === 'y')!;
      assert.deepStrictEqual((y.users as string[]).sort(), ['u1', 'zz']);
    });
    it('$sum evaluates expressions', async () => {
      const r = await c
        .aggregate([{ $group: { _id: null, rev: { $sum: { $multiply: ['$price', '$qty'] } } } }])
        .toArray();
      assert.strictEqual(r[0].rev, 20 + 50 + 7 + 9);
    });
  });

  describe('$replaceRoot', () => {
    it('promotes a nested document', async () => {
      await c.insertOne({ _id: '9', meta: { a: 1 } });
      const r = await c
        .aggregate([{ $match: { _id: '9' } }, { $replaceRoot: { newRoot: '$meta' } }])
        .toArray();
      assert.deepStrictEqual(r, [{ a: 1 }]);
    });
    it('supports a merged expression via $replaceWith', async () => {
      const r = await c
        .aggregate([
          { $match: { _id: '1' } },
          { $replaceWith: { n: '$name', p: { $add: ['$price', 1] } } },
        ])
        .toArray();
      assert.deepStrictEqual(r, [{ n: 'a', p: 11 }]);
    });
    it('throws when newRoot is not an object', async () => {
      await assert.rejects(
        c.aggregate([{ $replaceRoot: { newRoot: '$name' } }]).toArray(),
        /newRoot/
      );
    });
  });

  describe('$lookup', () => {
    beforeEach(async () => {
      const users = client.collection<DocumentWithId & { label: string; ids?: string[] }>('users');
      await users.insertMany([
        { _id: 'u1', label: 'One' },
        { _id: 'u2', label: 'Two' },
      ]);
    });
    it('joins on equality, returns array under `as`', async () => {
      const r = await c
        .aggregate([
          { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
          { $sort: { _id: 1 } },
        ])
        .toArray();
      assert.strictEqual((r[0].user as { label: string }[])[0].label, 'One');
      assert.strictEqual((r[1].user as { label: string }[])[0].label, 'Two');
      assert.deepStrictEqual(r[3].user, []);
    });
    it('rejects pipeline form', async () => {
      await assert.rejects(
        c.aggregate([{ $lookup: { from: 'users', pipeline: [], as: 'x' } }]).toArray(),
        /not supported/
      );
    });
  });
});
