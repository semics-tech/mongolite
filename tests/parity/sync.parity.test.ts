/**
 * End-to-end replication against a real MongoDB server.
 *
 * The fake-sink tests cover the replicator's logic; these cover the parts only a
 * real server can verify — that the driver accepts the bulk operations we build,
 * that `_id` mapping produces documents a native client would recognise, and
 * that upstream state actually converges on local state.
 */
import test, { after } from 'node:test';
import { expect } from 'expect';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoLite } from '../../src/index.js';
import type { SyncReplicator } from '../../src/index.js';
import { getSharedMongoUri, stopSharedMongoMemoryServer } from './harness/setup.js';
import { existsSync, unlinkSync } from 'fs';

interface Harness {
  client: MongoLite;
  sync: SyncReplicator;
  mongo: MongoClient;
  dbName: string;
  dispose: () => Promise<void>;
}

let dbCounter = 0;

async function createHarness(
  label: string,
  syncOptions: Record<string, unknown> = {}
): Promise<Harness> {
  const uri = await getSharedMongoUri();
  const dbName = `mongolite_sync_${label}_${(dbCounter += 1)}`;
  const dbPath = `./test-sync-parity-${label}-${dbCounter}.sqlite`;

  const removeLocalDb = (): void => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
  };
  removeLocalDb();

  const client = new MongoLite(dbPath);
  await client.connect();

  const sync = client.syncToMongo({
    connectionString: uri,
    database: dbName,
    pollIntervalMs: 25,
    // The in-memory server is a standalone, which has no majority to wait for.
    writeConcern: { w: 1 },
    ...syncOptions,
  });

  const mongo = new MongoClient(uri);
  await mongo.connect();

  return {
    client,
    sync,
    mongo,
    dbName,
    dispose: async () => {
      await sync.stop();
      await mongo.db(dbName).dropDatabase();
      await mongo.close();
      await client.close();
      removeLocalDb();
    },
  };
}

after(async () => {
  await stopSharedMongoMemoryServer();
});

test('Sync parity - inserts, updates and deletes reach MongoDB', async () => {
  const h = await createHarness('crud');

  try {
    const users = h.client.collection('users');
    await users.ensureTable();
    await h.sync.start();

    const upstream = h.mongo.db(h.dbName).collection('users');

    const { insertedId } = await users.insertOne({ name: 'Alice', age: 30 } as never);
    await h.sync.waitForDrain();

    // MongoLite generates ObjectId-shaped ids, so they arrive as real ObjectIds.
    const inserted = await upstream.findOne({ _id: new ObjectId(insertedId) });
    expect(inserted).toMatchObject({ name: 'Alice', age: 30 });

    await users.updateOne({ _id: insertedId }, { $set: { age: 31 }, $unset: { name: '' } });
    await h.sync.waitForDrain();

    const updated = await upstream.findOne({ _id: new ObjectId(insertedId) });
    expect(updated).toMatchObject({ age: 31 });
    // The local document is authoritative: a field removed locally is gone upstream.
    expect(updated).not.toHaveProperty('name');

    await users.deleteOne({ _id: insertedId });
    await h.sync.waitForDrain();

    expect(await upstream.countDocuments()).toBe(0);
  } finally {
    await h.dispose();
  }
});

test('Sync parity - non-ObjectId string ids are preserved as strings', async () => {
  const h = await createHarness('stringids');

  try {
    const users = h.client.collection('users');
    await users.ensureTable();
    await h.sync.start();

    await users.insertOne({ _id: 'user-alice', name: 'Alice' } as never);
    await h.sync.waitForDrain();

    const doc = await h.mongo.db(h.dbName).collection('users').findOne({ _id: 'user-alice' });
    expect(doc).toMatchObject({ _id: 'user-alice', name: 'Alice' });
  } finally {
    await h.dispose();
  }
});

test('Sync parity - idMapping "string" keeps ObjectId-shaped ids as strings', async () => {
  const h = await createHarness('idmapping', { idMapping: 'string' });

  try {
    const users = h.client.collection('users');
    await users.ensureTable();
    await h.sync.start();

    const id = '507f1f77bcf86cd799439011';
    await users.insertOne({ _id: id, name: 'Alice' } as never);
    await h.sync.waitForDrain();

    const upstream = h.mongo.db(h.dbName).collection('users');
    expect(await upstream.findOne({ _id: id })).toMatchObject({ name: 'Alice' });
    expect(await upstream.findOne({ _id: new ObjectId(id) })).toBeNull();
  } finally {
    await h.dispose();
  }
});

test('Sync parity - existing documents are backfilled on first start', async () => {
  const h = await createHarness('backfill');

  try {
    const users = h.client.collection('users');
    await users.ensureTable();
    await users.insertMany([
      { _id: 'a', name: 'Alice' },
      { _id: 'b', name: 'Bob' },
      { _id: 'c', name: 'Carol' },
    ] as never);

    await h.sync.start();
    await h.sync.waitForDrain();

    const upstream = h.mongo.db(h.dbName).collection('users');
    expect(await upstream.countDocuments()).toBe(3);
    expect(await upstream.findOne({ _id: 'b' })).toMatchObject({ name: 'Bob' });
  } finally {
    await h.dispose();
  }
});

test('Sync parity - a batch of mixed operations converges upstream on local state', async () => {
  const h = await createHarness('convergence', { batchSize: 50 });

  try {
    const users = h.client.collection('users');
    const orders = h.client.collection('orders');
    await users.ensureTable();
    await orders.ensureTable();
    await h.sync.start();
    await h.sync.waitForDrain();

    for (let i = 0; i < 120; i += 1) {
      await users.insertOne({ _id: `u${i}`, n: i } as never);
      if (i % 3 === 0) await orders.insertOne({ _id: `o${i}`, user: `u${i}` } as never);
    }
    for (let i = 0; i < 120; i += 2) {
      await users.updateOne({ _id: `u${i}` }, { $set: { n: i * 10 } });
    }
    for (let i = 0; i < 120; i += 5) {
      await users.deleteOne({ _id: `u${i}` });
    }

    await h.sync.waitForDrain();

    const localUsers = await users.find({}).toArray();
    const upstreamUsers = await h.mongo.db(h.dbName).collection('users').find({}).toArray();

    expect(upstreamUsers).toHaveLength(localUsers.length);

    const upstreamById = new Map(upstreamUsers.map((doc) => [doc._id as string, doc]));
    for (const local of localUsers) {
      expect(upstreamById.get(local._id as string)).toMatchObject({ n: local.n });
    }

    expect(await h.mongo.db(h.dbName).collection('orders').countDocuments()).toBe(40);
    expect((await h.sync.status()).pending).toBe(0);
  } finally {
    await h.dispose();
  }
});

test('Sync parity - collections are renamed upstream and excluded ones stay local', async () => {
  const h = await createHarness('mapping', {
    collections: ['users'],
    collectionMap: { users: 'app_users' },
  });

  try {
    const users = h.client.collection('users');
    const secrets = h.client.collection('secrets');
    await users.ensureTable();
    await secrets.ensureTable();
    await h.sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice' } as never);
    await secrets.insertOne({ _id: 's1', token: 'nope' } as never);
    await h.sync.waitForDrain();

    const db = h.mongo.db(h.dbName);
    expect(await db.collection('app_users').countDocuments()).toBe(1);

    const names = (await db.listCollections().toArray()).map((c) => c.name);
    expect(names).toContain('app_users');
    expect(names).not.toContain('users');
    expect(names).not.toContain('secrets');
  } finally {
    await h.dispose();
  }
});

test('Sync parity - a concurrent server edit is not overwritten by a stale local push', async () => {
  const h = await createHarness('cas');

  try {
    const users = h.client.collection('users');
    await users.ensureTable();
    await h.sync.start();

    const upstream = h.mongo.db(h.dbName).collection('users');

    await users.insertOne({ _id: 'u1', name: 'Alice', age: 30 } as never);
    await h.sync.waitForDrain();
    expect(await upstream.findOne({ _id: 'u1' })).toMatchObject({ name: 'Alice', _v: 1 });

    // Another writer gets there first, using the same protocol.
    await upstream.updateOne(
      { _id: 'u1' },
      { $set: { name: 'Edited elsewhere' }, $inc: { _v: 1 } }
    );

    // Our local edit still believes it is replacing _v: 1.
    const conflicts: unknown[] = [];
    h.sync.on('conflict', (event) => conflicts.push(event));
    await users.updateOne({ _id: 'u1' }, { $set: { age: 31 } });
    await h.sync.waitForDrain();

    const after = await upstream.findOne({ _id: 'u1' });
    expect(after).toMatchObject({ name: 'Edited elsewhere', _v: 2 });
    expect(conflicts).toHaveLength(1);

    // The local copy adopts the winner.
    expect(await users.findOne({ _id: 'u1' })).toMatchObject({ name: 'Edited elsewhere' });
  } finally {
    await h.dispose();
  }
});

test('Sync parity - a server-side Date survives an unrelated local edit', async () => {
  const h = await createHarness('bsontypes');

  try {
    const users = h.client.collection('users');
    await users.ensureTable();
    await h.sync.start();

    const upstream = h.mongo.db(h.dbName).collection('users');

    await users.insertOne({ _id: 'u1', name: 'Alice' } as never);
    await h.sync.waitForDrain();

    // A real BSON Date the local store cannot represent as anything but a string.
    // A real BSON Date appears upstream, added by another writer.
    const createdAt = new Date('2024-01-01T00:00:00.000Z');
    await upstream.updateOne({ _id: 'u1' }, { $set: { createdAt }, $inc: { _v: 1 } });

    // The client does not know about it yet, so this edit loses and is rebased: the
    // server's version is adopted locally and the shadow refreshed.
    await users.updateOne({ _id: 'u1' }, { $set: { name: 'Discarded' } });
    await h.sync.waitForDrain();
    expect(await upstream.findOne({ _id: 'u1' })).toMatchObject({ name: 'Alice', _v: 2 });

    // Now the client is up to date, so this edit lands.
    await users.updateOne({ _id: 'u1' }, { $set: { name: 'Alice II' } });
    await h.sync.waitForDrain();

    const after = await upstream.findOne({ _id: 'u1' });
    expect(after?.name).toBe('Alice II');
    // The field we never touched is still a Date, not the ISO string a whole-document
    // push would have left behind.
    expect(after?.createdAt).toBeInstanceOf(Date);
    expect((after?.createdAt as Date).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  } finally {
    await h.dispose();
  }
});

test('Sync parity - replication resumes after the replicator is restarted', async () => {
  const h = await createHarness('restart');

  try {
    const users = h.client.collection('users');
    await users.ensureTable();
    await h.sync.start();

    await users.insertOne({ _id: 'a', name: 'Alice' } as never);
    await h.sync.waitForDrain();
    await h.sync.stop();

    // Written with no replicator running — triggers still capture it.
    await users.insertOne({ _id: 'b', name: 'Bob' } as never);
    await users.updateOne({ _id: 'a' }, { $set: { name: 'Alice II' } });

    const resumed = h.client.syncToMongo({
      connectionString: await getSharedMongoUri(),
      database: h.dbName,
      pollIntervalMs: 25,
      writeConcern: { w: 1 },
    });

    await resumed.start();
    await resumed.waitForDrain();

    const upstream = h.mongo.db(h.dbName).collection('users');
    expect(await upstream.findOne({ _id: 'b' })).toMatchObject({ name: 'Bob' });
    expect(await upstream.findOne({ _id: 'a' })).toMatchObject({ name: 'Alice II' });

    await resumed.stop();
  } finally {
    await h.dispose();
  }
});
