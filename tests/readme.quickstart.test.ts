import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index.js';

// Mirrors the README Quick Start and Transactions snippets so they can't drift from the API.
describe('README snippets', () => {
  it('quick start runs as written (no explicit connect())', async () => {
    const client = new MongoLite(':memory:');
    const users = client.collection('users');

    const result = await users.insertOne({ name: 'Alice', age: 30 });
    assert.ok(result.insertedId);
    const user = await users.findOne({ name: 'Alice' });
    assert.strictEqual(user?.age, 30);
    await users.updateOne({ name: 'Alice' }, { $set: { age: 31 } });
    assert.strictEqual((await users.findOne({ name: 'Alice' }))?.age, 31);
    await users.deleteOne({ name: 'Alice' });
    assert.strictEqual(await users.findOne({ name: 'Alice' }), null);

    await client.close();
  });

  it('transactions snippet commits and rolls back', async () => {
    const client = new MongoLite(':memory:');
    await client.connect();
    const orders = client.collection('orders');
    const stock = client.collection('stock');
    await stock.insertOne({ sku: 'a', qty: 5 });

    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await orders.insertOne({ sku: 'a' }, { session });
        await stock.updateOne({ sku: 'a' }, { $inc: { qty: -1 } }, { session });
      });
    } finally {
      await session.endSession();
    }
    assert.strictEqual((await stock.findOne({ sku: 'a' }))?.qty, 4);
    assert.strictEqual(await orders.countDocuments({}), 1);

    const s2 = client.startSession();
    await assert.rejects(
      s2.withTransaction(async () => {
        await orders.insertOne({ sku: 'b' }, { session: s2 });
        throw new Error('boom');
      }),
      /boom/
    );
    await s2.endSession();
    assert.strictEqual(await orders.countDocuments({}), 1);

    await client.close();
  });
});
