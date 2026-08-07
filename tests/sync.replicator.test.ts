import test from 'node:test';
import { expect } from 'expect';
import { MongoLite } from '../src/index.js';
import type { SyncApplyResult, SyncOperation, SyncSink } from '../src/index.js';
import { existsSync, unlinkSync } from 'fs';

interface TestUser {
  _id?: string;
  name: string;
  age?: number;
  status?: string;
  [key: string]: unknown;
}

/**
 * In-memory sink that records what replication actually sent upstream, and can
 * be told to fail so retry and dead-letter behaviour is exercised without a
 * real MongoDB.
 */
class RecordingSink implements SyncSink {
  readonly name = 'recording';

  /** Final upstream state, keyed by `collection/_id`. */
  readonly state = new Map<string, Record<string, unknown>>();
  /** Every batch as it was received, for asserting on coalescing. */
  readonly batches: SyncOperation[][] = [];
  connectCount = 0;
  closed = false;

  /** When set, `apply` throws — simulating an unreachable upstream. */
  failWith: Error | null = null;
  /** Documents whose `_id` is listed here are rejected permanently. */
  rejectIds = new Set<string>();

  async connect(): Promise<void> {
    this.connectCount += 1;
  }

  async apply(operations: SyncOperation[]): Promise<SyncApplyResult> {
    if (this.failWith) throw this.failWith;

    this.batches.push(operations.map((op) => ({ ...op })));

    const failures = [];
    let applied = 0;

    for (const [index, op] of operations.entries()) {
      if (this.rejectIds.has(op.documentId)) {
        failures.push({ index, message: `rejected ${op.documentId}`, code: 121 });
        continue;
      }

      const key = `${op.collection}/${op.documentId}`;
      if (op.type === 'delete') this.state.delete(key);
      else this.state.set(key, op.document!);
      applied += 1;
    }

    return { applied, failures: failures.length > 0 ? failures : undefined };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function tempDb(label: string): string {
  const path = `./test-sync-${label}.sqlite`;
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
  return path;
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

test('Sync - replicates inserts, updates and deletes', async () => {
  const dbPath = tempDb('basic');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new RecordingSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20 });

  try {
    const users = client.collection<TestUser>('users');
    await users.ensureTable();
    await sync.start();

    const { insertedId } = await users.insertOne({ name: 'Alice', age: 30 });
    await sync.waitForDrain();

    expect(sink.state.get(`users/${insertedId}`)).toMatchObject({
      _id: insertedId,
      name: 'Alice',
      age: 30,
    });

    await users.updateOne({ _id: insertedId }, { $set: { age: 31 } });
    await sync.waitForDrain();
    expect(sink.state.get(`users/${insertedId}`)).toMatchObject({ age: 31 });

    await users.deleteOne({ _id: insertedId });
    await sync.waitForDrain();
    expect(sink.state.has(`users/${insertedId}`)).toBe(false);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - a full document is replaced upstream, so removed fields disappear', async () => {
  const dbPath = tempDb('replace');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new RecordingSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20 });

  try {
    const users = client.collection<TestUser>('users');
    await users.ensureTable();
    await sync.start();

    const { insertedId } = await users.insertOne({ name: 'Bob', status: 'active' });
    await sync.waitForDrain();
    expect(sink.state.get(`users/${insertedId}`)).toHaveProperty('status', 'active');

    await users.updateOne({ _id: insertedId }, { $unset: { status: '' } });
    await sync.waitForDrain();

    expect(sink.state.get(`users/${insertedId}`)).not.toHaveProperty('status');
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - coalesces a run of changes into one upstream write per document', async () => {
  const dbPath = tempDb('coalesce');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new RecordingSink();
  // Nothing drains while stopped, so all the changes below queue into one batch.
  const sync = client.createSync(sink, { pollIntervalMs: 5_000 });

  try {
    const users = client.collection<TestUser>('users');
    await users.ensureTable();
    await sync.start();
    await sync.waitForDrain();

    const { insertedId } = await users.insertOne({ name: 'Carol', age: 1 });
    for (let age = 2; age <= 6; age += 1) {
      await users.updateOne({ _id: insertedId }, { $set: { age } });
    }

    sync.notify();
    await sync.waitForDrain();

    const writes = sink.batches.flat().filter((op) => op.documentId === insertedId);
    expect(writes).toHaveLength(1);
    expect(writes[0].type).toBe('upsert');
    expect(writes[0].document).toMatchObject({ age: 6 });
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - buffers durably while the upstream is down, then catches up', async () => {
  const dbPath = tempDb('outage');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new RecordingSink();
  const sync = client.createSync(sink, {
    pollIntervalMs: 20,
    retryDelayMs: 20,
    maxRetryDelayMs: 40,
  });

  try {
    const users = client.collection<TestUser>('users');
    await users.ensureTable();
    await sync.start();
    await sync.waitForDrain();

    sink.failWith = new Error('ECONNREFUSED');

    await users.insertOne({ _id: 'u1', name: 'Dave' });
    await users.insertOne({ _id: 'u2', name: 'Erin' });

    // Give the replicator time to try, fail, and back off.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const degraded = await sync.status();
    expect(degraded.pending).toBeGreaterThan(0);
    expect(degraded.retries).toBeGreaterThan(0);
    expect(degraded.lastError).toContain('ECONNREFUSED');
    expect(sink.state.size).toBe(0);

    sink.failWith = null;
    await sync.waitForDrain();

    expect(sink.state.get('users/u1')).toMatchObject({ name: 'Dave' });
    expect(sink.state.get('users/u2')).toMatchObject({ name: 'Erin' });
    expect((await sync.status()).pending).toBe(0);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - resumes from its checkpoint after a restart, replaying nothing extra', async () => {
  const dbPath = tempDb('resume');
  const client = new MongoLite(dbPath);
  await client.connect();

  const users = client.collection<TestUser>('users');
  await users.ensureTable();

  const firstSink = new RecordingSink();
  const first = client.createSync(firstSink, { pollIntervalMs: 20 });

  try {
    await first.start();
    await users.insertOne({ _id: 'a', name: 'Alice' });
    await first.waitForDrain();
    await first.stop();

    // Changed while replication was stopped — triggers keep capturing.
    await users.insertOne({ _id: 'b', name: 'Bob' });
    await users.updateOne({ _id: 'a' }, { $set: { name: 'Alice II' } });

    const secondSink = new RecordingSink();
    const second = client.createSync(secondSink, { pollIntervalMs: 20 });
    await second.start();
    await second.waitForDrain();

    // Only the two changes made while stopped — 'a' is here for its update, not a replay.
    const seen = secondSink.batches.flat();
    expect(seen).toHaveLength(2);
    expect(secondSink.state.get('users/b')).toMatchObject({ name: 'Bob' });
    expect(secondSink.state.get('users/a')).toMatchObject({ name: 'Alice II' });

    await second.stop();
  } finally {
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - backfills documents that existed before replication started', async () => {
  const dbPath = tempDb('backfill');
  const client = new MongoLite(dbPath);
  await client.connect();

  const users = client.collection<TestUser>('users');
  await users.ensureTable();
  await users.insertMany([
    { _id: 'old1', name: 'Old One' },
    { _id: 'old2', name: 'Old Two' },
  ]);

  const sink = new RecordingSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20 });

  try {
    await sync.start();
    await sync.waitForDrain();

    expect(sink.state.get('users/old1')).toMatchObject({ name: 'Old One' });
    expect(sink.state.get('users/old2')).toMatchObject({ name: 'Old Two' });
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - initial "changes-only" skips pre-existing documents', async () => {
  const dbPath = tempDb('changes-only');
  const client = new MongoLite(dbPath);
  await client.connect();

  const users = client.collection<TestUser>('users');
  await users.ensureTable();
  await users.insertOne({ _id: 'pre', name: 'Pre-existing' });

  const sink = new RecordingSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20, initial: 'changes-only' });

  try {
    await sync.start();
    await sync.waitForDrain();
    expect(sink.state.has('users/pre')).toBe(false);

    await users.insertOne({ _id: 'post', name: 'After' });
    await sync.waitForDrain();
    expect(sink.state.has('users/post')).toBe(true);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - replicates only the selected collections, honouring renames', async () => {
  const dbPath = tempDb('filter');
  const client = new MongoLite(dbPath);
  await client.connect();

  const users = client.collection<TestUser>('users');
  const logs = client.collection<TestUser>('logs');
  await users.ensureTable();
  await logs.ensureTable();

  const sink = new RecordingSink();
  const sync = client.createSync(sink, {
    pollIntervalMs: 20,
    collections: ['users'],
    collectionMap: { users: 'app_users' },
  });

  try {
    await sync.start();
    await users.insertOne({ _id: 'u1', name: 'Alice' });
    await logs.insertOne({ _id: 'l1', name: 'noise' });
    await sync.waitForDrain();

    expect(sink.state.has('app_users/u1')).toBe(true);
    expect(sink.state.has('users/u1')).toBe(false);
    expect([...sink.state.keys()].some((key) => key.startsWith('logs/'))).toBe(false);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - transform rewrites documents and can drop them', async () => {
  const dbPath = tempDb('transform');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new RecordingSink();
  const sync = client.createSync(sink, {
    pollIntervalMs: 20,
    transform: (doc) => {
      if (doc.secret === true) return null;
      const { password: _password, ...rest } = doc;
      return { ...rest, replicatedAt: 'stamped' };
    },
  });

  try {
    const users = client.collection<TestUser>('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'keep', name: 'Alice', password: 'hunter2' });
    await users.insertOne({ _id: 'drop', name: 'Hidden', secret: true });
    await sync.waitForDrain();

    const kept = sink.state.get('users/keep');
    expect(kept).toMatchObject({ name: 'Alice', replicatedAt: 'stamped' });
    expect(kept).not.toHaveProperty('password');
    expect(sink.state.has('users/drop')).toBe(false);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - a permanently rejected document is dead-lettered, not retried forever', async () => {
  const dbPath = tempDb('deadletter');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new RecordingSink();
  sink.rejectIds.add('bad');
  const sync = client.createSync(sink, { pollIntervalMs: 20 });

  try {
    const users = client.collection<TestUser>('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'bad', name: 'Poison' });
    await users.insertOne({ _id: 'good', name: 'Fine' });
    await sync.waitForDrain();

    // The healthy document still got through — one bad row cannot stall the stream.
    expect(sink.state.has('users/good')).toBe(true);
    expect(sink.state.has('users/bad')).toBe(false);

    const dead = await sync.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0].documentId).toBe('bad');
    expect(dead[0].error).toContain('rejected bad');
    expect((await sync.status()).pending).toBe(0);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - prunes acknowledged rows so the outbox does not grow forever', async () => {
  const dbPath = tempDb('prune');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new RecordingSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20 });

  try {
    const users = client.collection<TestUser>('users');
    await users.ensureTable();
    await sync.start();

    for (let i = 0; i < 20; i += 1) {
      await users.insertOne({ _id: `u${i}`, name: `User ${i}` });
    }
    await sync.waitForDrain();

    const remaining = await client.database.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM __mongolite_sync_outbox__'
    );
    expect(Number(remaining?.total)).toBe(0);
    expect(sink.state.size).toBe(20);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - two replicators to different upstreams both receive every change', async () => {
  const dbPath = tempDb('fanout');
  const client = new MongoLite(dbPath);
  await client.connect();

  const primary = new RecordingSink();
  const analytics = new RecordingSink();
  const syncA = client.createSync(primary, { name: 'primary', pollIntervalMs: 20 });
  const syncB = client.createSync(analytics, { name: 'analytics', pollIntervalMs: 20 });

  try {
    const users = client.collection<TestUser>('users');
    await users.ensureTable();
    await syncA.start();
    await syncB.start();

    await users.insertOne({ _id: 'shared', name: 'Alice' });
    await syncA.waitForDrain();
    await syncB.waitForDrain();

    expect(primary.state.get('users/shared')).toMatchObject({ name: 'Alice' });
    expect(analytics.state.get('users/shared')).toMatchObject({ name: 'Alice' });
  } finally {
    await syncA.stop();
    await syncB.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - internal tables are not exposed as collections', async () => {
  const dbPath = tempDb('hidden');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new RecordingSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20 });

  try {
    const users = client.collection<TestUser>('users');
    await users.ensureTable();
    await sync.start();
    await users.insertOne({ name: 'Alice' });
    await sync.waitForDrain();

    const collections = await client.listCollections().toArray();
    expect(collections).toContain('users');
    expect(collections.filter((name) => name.startsWith('__mongolite'))).toHaveLength(0);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - status reports progress', async () => {
  const dbPath = tempDb('status');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new RecordingSink();
  const sync = client.createSync(sink, { name: 'reporting', pollIntervalMs: 20 });

  try {
    const users = client.collection<TestUser>('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ name: 'Alice' });
    await sync.waitForDrain();

    const status = await sync.status();
    expect(status.name).toBe('reporting');
    expect(status.running).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.applied).toBe(1);
    expect(status.pending).toBe(0);
    expect(status.deadLettered).toBe(0);
    expect(status.checkpoint).toBeGreaterThan(0);
    expect(status.collections).toContain('users');
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});
