/**
 * The HTTP transport end to end: a real MongoLite client replicating over a real HTTP
 * server into a real MongoDB.
 *
 * The claim under test is that the transport is transparent — replicating through an
 * API must produce the same upstream state, and the same conflict behaviour, as
 * connecting to MongoDB directly. A unit test with a fake `fetch` cannot show that.
 */
import test, { after } from 'node:test';
import { expect } from 'expect';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { MongoClient } from 'mongodb';
import { MongoLite } from '../../src/index.js';
import { createSyncReceiver } from '../../src/server.js';
import { getSharedMongoUri, stopSharedMongoMemoryServer } from './harness/setup.js';
import { existsSync, unlinkSync } from 'fs';

let counter = 0;

interface Harness {
  client: MongoLite;
  mongo: MongoClient;
  dbName: string;
  baseUrl: string;
  requests: string[];
  dispose: () => Promise<void>;
}

/** Mounts a receiver on a throwaway HTTP server, the way an API would. */
async function createHarness(label: string): Promise<Harness> {
  const uri = await getSharedMongoUri();
  const dbName = `mongolite_http_${label}_${(counter += 1)}`;
  const dbPath = `./test-http-parity-${label}-${counter}.sqlite`;

  const removeLocalDb = (): void => {
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
  };
  removeLocalDb();

  const mongo = new MongoClient(uri);
  await mongo.connect();

  const receiver = createSyncReceiver({
    client: mongo as never,
    database: dbName,
    allowedCollections: ['users', 'orders'],
    // The in-memory server is a standalone, which has no majority to wait for.
    writeConcern: { w: 1 },
  });

  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      void (async () => {
        requests.push(req.url ?? '');
        const isFetch = (req.url ?? '').endsWith('/_sync/fetch');
        const result = isFetch ? await receiver.fetch(body) : await receiver.apply(body);
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const client = new MongoLite(dbPath);
  await client.connect();

  return {
    client,
    mongo,
    dbName,
    baseUrl,
    requests,
    dispose: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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

test('HTTP parity - inserts, updates and deletes reach MongoDB through the API', async () => {
  const h = await createHarness('crud');
  const sync = h.client.syncToHttp({
    baseUrl: h.baseUrl,
    database: h.dbName,
    pollIntervalMs: 25,
  });

  try {
    const users = h.client.collection('users');
    await users.ensureTable();
    await sync.start();

    const upstream = h.mongo.db(h.dbName).collection('users');

    await users.insertOne({ _id: 'u1', name: 'Alice', age: 30 } as never);
    await sync.waitForDrain();
    expect(await upstream.findOne({ _id: 'u1' })).toMatchObject({ name: 'Alice', _v: 1 });

    await users.updateOne({ _id: 'u1' }, { $set: { age: 31 } });
    await sync.waitForDrain();
    expect(await upstream.findOne({ _id: 'u1' })).toMatchObject({ age: 31, _v: 2 });

    await users.deleteOne({ _id: 'u1' });
    await sync.waitForDrain();
    expect(await upstream.countDocuments()).toBe(0);

    expect(h.requests.some((url) => url.endsWith('/_sync'))).toBe(true);
  } finally {
    await sync.stop();
    await h.dispose();
  }
});

test('HTTP parity - numbers keep the same type as over a direct connection', async () => {
  const h = await createHarness('numbers');
  const sync = h.client.syncToHttp({
    baseUrl: h.baseUrl,
    database: h.dbName,
    pollIntervalMs: 25,
  });

  try {
    const users = h.client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', count: 31, ratio: 1.5 } as never);
    await sync.waitForDrain();

    const stored = await h.mongo.db(h.dbName).collection('users').findOne({ _id: 'u1' });
    // Canonical Extended JSON would have made these Int32 over HTTP but doubles over a
    // direct connection — the same local write producing different upstream types.
    expect(typeof stored?.count).toBe('number');
    expect(stored?.count).toBe(31);
    expect(stored?.ratio).toBe(1.5);
  } finally {
    await sync.stop();
    await h.dispose();
  }
});

test('HTTP parity - a concurrent server edit is not overwritten', async () => {
  const h = await createHarness('conflict');
  const sync = h.client.syncToHttp({
    baseUrl: h.baseUrl,
    database: h.dbName,
    pollIntervalMs: 25,
  });

  try {
    const users = h.client.collection('users');
    await users.ensureTable();
    await sync.start();

    const upstream = h.mongo.db(h.dbName).collection('users');
    const conflicts: unknown[] = [];
    sync.on('conflict', (event) => conflicts.push(event));

    await users.insertOne({ _id: 'u1', name: 'Alice', age: 30 } as never);
    await sync.waitForDrain();

    // Another writer gets there first.
    await upstream.updateOne(
      { _id: 'u1' },
      { $set: { name: 'Edited elsewhere' }, $inc: { _v: 1 } }
    );

    await users.updateOne({ _id: 'u1' }, { $set: { age: 31 } });
    await sync.waitForDrain();

    // The concurrency protection has to survive the HTTP hop, or the two transports
    // would have different safety properties.
    expect(await upstream.findOne({ _id: 'u1' })).toMatchObject({
      name: 'Edited elsewhere',
      _v: 2,
    });
    expect(conflicts).toHaveLength(1);

    // The read-back that refreshes the shadow also went over HTTP.
    expect(h.requests.some((url) => url.endsWith('/_sync/fetch'))).toBe(true);
    expect(await users.findOne({ _id: 'u1' })).toMatchObject({ name: 'Edited elsewhere' });
  } finally {
    await sync.stop();
    await h.dispose();
  }
});

test('HTTP parity - a server-side Date survives an unrelated local edit', async () => {
  const h = await createHarness('bson');
  const sync = h.client.syncToHttp({
    baseUrl: h.baseUrl,
    database: h.dbName,
    pollIntervalMs: 25,
  });

  try {
    const users = h.client.collection('users');
    await users.ensureTable();
    await sync.start();

    const upstream = h.mongo.db(h.dbName).collection('users');

    await users.insertOne({ _id: 'u1', name: 'Alice' } as never);
    await sync.waitForDrain();

    // A real BSON Date appears upstream, added by another writer.
    const createdAt = new Date('2024-01-01T00:00:00.000Z');
    await upstream.updateOne({ _id: 'u1' }, { $set: { createdAt }, $inc: { _v: 1 } });

    // This edit loses and is rebased — the conflict round trip happens over HTTP.
    await users.updateOne({ _id: 'u1' }, { $set: { name: 'Discarded' } });
    await sync.waitForDrain();
    expect(await upstream.findOne({ _id: 'u1' })).toMatchObject({ name: 'Alice', _v: 2 });

    // Now up to date, so this one lands.
    await users.updateOne({ _id: 'u1' }, { $set: { name: 'Alice II' } });
    await sync.waitForDrain();

    const after = await upstream.findOne({ _id: 'u1' });
    expect(after?.name).toBe('Alice II');
    expect(after?.createdAt).toBeInstanceOf(Date);
    expect((after?.createdAt as Date).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  } finally {
    await sync.stop();
    await h.dispose();
  }
});

test('HTTP parity - a disallowed collection is refused and dead-lettered', async () => {
  const h = await createHarness('denied');
  const sync = h.client.syncToHttp({
    baseUrl: h.baseUrl,
    database: h.dbName,
    pollIntervalMs: 25,
    collections: ['secrets'],
  });

  try {
    const secrets = h.client.collection('secrets');
    await secrets.ensureTable();
    await sync.start();

    await secrets.insertOne({ _id: 's1', token: 'nope' } as never);
    await sync.waitForDrain();

    // 403 is permanent, so the batch is dead-lettered rather than retried forever.
    const dead = await sync.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0].error).toContain('403');
    expect(await h.mongo.db(h.dbName).collection('secrets').countDocuments()).toBe(0);
    expect((await sync.status()).pending).toBe(0);
  } finally {
    await sync.stop();
    await h.dispose();
  }
});
