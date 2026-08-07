import test from 'node:test';
import { expect } from 'expect';
import { MongoLite, SyncOutbox } from '../src/index.js';
import type { SyncApplyResult, SyncOperation, SyncSink } from '../src/index.js';
import { existsSync, unlinkSync } from 'fs';

function tempDb(label: string): string {
  const path = `./test-outbox-${label}.sqlite`;
  cleanup(path);
  return path;
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

/** Sink that refuses everything, so the outbox is guaranteed to back up. */
const deadSink: SyncSink = {
  name: 'dead',
  async apply(): Promise<SyncApplyResult> {
    throw new Error('upstream unavailable');
  },
};

test('Outbox - triggers capture inserts, updates and deletes in order', async () => {
  const dbPath = tempDb('capture');
  const client = new MongoLite(dbPath);
  await client.connect();

  try {
    const users = client.collection('users');
    await users.ensureTable();

    const outbox = new SyncOutbox(client.database);
    await outbox.ensureSchema();
    await outbox.ensureTriggers('users');

    await users.insertOne({ _id: 'u1', name: 'Alice' } as never);
    await users.updateOne({ _id: 'u1' }, { $set: { name: 'Alice II' } });
    await users.deleteOne({ _id: 'u1' });

    const records = await outbox.readBatch(0, 100, null);
    expect(records.map((r) => r.operation)).toEqual(['insert', 'update', 'delete']);
    expect(records.map((r) => r.documentId)).toEqual(['u1', 'u1', 'u1']);

    // Ids are monotonic, which is what makes them usable as a checkpoint.
    expect(records[0].id).toBeLessThan(records[1].id);
    expect(records[1].id).toBeLessThan(records[2].id);

    // Documents are reassembled with the `_id` that lives in its own column.
    expect(records[0].document).toEqual({ _id: 'u1', name: 'Alice' });
    expect(records[1].document).toEqual({ _id: 'u1', name: 'Alice II' });
    expect(records[2].document).toBeNull();
  } finally {
    await client.close();
    cleanup(dbPath);
  }
});

test('Outbox - capture keeps running while no replicator is active', async () => {
  const dbPath = tempDb('offline');
  const client = new MongoLite(dbPath);
  await client.connect();

  try {
    const users = client.collection('users');
    await users.ensureTable();

    const outbox = new SyncOutbox(client.database);
    await outbox.ensureSchema();
    await outbox.ensureTriggers('users');

    for (let i = 0; i < 5; i += 1) {
      await users.insertOne({ _id: `u${i}`, n: i } as never);
    }

    expect(await outbox.pendingCount(0, null)).toBe(5);
    expect(await outbox.currentSequence()).toBe(5);
  } finally {
    await client.close();
    cleanup(dbPath);
  }
});

test('Outbox - compaction keeps the newest revision of each document', async () => {
  const dbPath = tempDb('compact');
  const client = new MongoLite(dbPath);
  await client.connect();

  try {
    const users = client.collection('users');
    await users.ensureTable();

    const outbox = new SyncOutbox(client.database);
    await outbox.ensureSchema();
    await outbox.ensureTriggers('users');
    await outbox.loadState('default'); // Registers a checkpoint at 0.

    await users.insertOne({ _id: 'hot', counter: 0 } as never);
    for (let i = 1; i <= 9; i += 1) {
      await users.updateOne({ _id: 'hot' }, { $set: { counter: i } });
    }
    await users.insertOne({ _id: 'cold', counter: 0 } as never);

    expect(await outbox.pendingCount(0, null)).toBe(11);

    const removed = await outbox.compact();
    expect(removed).toBe(9);

    const records = await outbox.readBatch(0, 100, null);
    expect(records).toHaveLength(2);

    // Compaction is lossless because replication carries whole documents:
    // the surviving row still reproduces the final state.
    const hot = records.find((r) => r.documentId === 'hot');
    expect(hot?.document).toMatchObject({ counter: 9 });
    expect(records.find((r) => r.documentId === 'cold')?.document).toMatchObject({ counter: 0 });
  } finally {
    await client.close();
    cleanup(dbPath);
  }
});

test('Outbox - rows are pinned until every registered replicator has passed them', async () => {
  const dbPath = tempDb('pin');
  const client = new MongoLite(dbPath);
  await client.connect();

  try {
    const users = client.collection('users');
    await users.ensureTable();

    const outbox = new SyncOutbox(client.database);
    await outbox.ensureSchema();
    await outbox.ensureTriggers('users');
    await outbox.loadState('fast');
    await outbox.loadState('slow');

    for (let i = 0; i < 4; i += 1) {
      await users.insertOne({ _id: `u${i}` } as never);
    }

    // The fast replicator is done; the slow one has not started.
    await outbox.saveCheckpoint('fast', 4);
    expect(await outbox.prune()).toBe(0);
    expect(await outbox.pendingCount(0, null)).toBe(4);

    await outbox.saveCheckpoint('slow', 2);
    expect(await outbox.prune()).toBe(2);

    // Forgetting the slow replicator releases what its checkpoint was holding.
    await outbox.unregister('slow');
    expect(await outbox.prune()).toBe(2);
    expect(await outbox.pendingCount(0, null)).toBe(0);
  } finally {
    await client.close();
    cleanup(dbPath);
  }
});

test('Outbox - removeTriggers stops capture without touching queued rows', async () => {
  const dbPath = tempDb('detach');
  const client = new MongoLite(dbPath);
  await client.connect();

  try {
    const users = client.collection('users');
    await users.ensureTable();

    const outbox = new SyncOutbox(client.database);
    await outbox.ensureSchema();
    await outbox.ensureTriggers('users');

    await users.insertOne({ _id: 'before' } as never);
    await outbox.removeTriggers('users');
    await users.insertOne({ _id: 'after' } as never);

    const records = await outbox.readBatch(0, 100, null);
    expect(records.map((r) => r.documentId)).toEqual(['before']);
  } finally {
    await client.close();
    cleanup(dbPath);
  }
});

test('Sync - a dropped and recreated collection is re-armed on the next scan', async () => {
  const dbPath = tempDb('recreate');
  const client = new MongoLite(dbPath);
  await client.connect();

  const seen: SyncOperation[] = [];
  const sink: SyncSink = {
    name: 'collecting',
    async apply(operations): Promise<SyncApplyResult> {
      seen.push(...operations);
      return { applied: operations.length };
    },
  };

  const sync = client.createSync(sink, { pollIntervalMs: 20, collectionScanIntervalMs: 30 });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();
    await sync.waitForDrain();

    // Dropping a table drops its triggers with it.
    await client.database.exec('DROP TABLE "users"');
    await users.ensureTable();

    // Wait for a rescan to notice the triggers are gone and reinstall them.
    await new Promise((resolve) => setTimeout(resolve, 120));

    await users.insertOne({ _id: 'after-recreate', name: 'Alice' } as never);
    await sync.waitForDrain();

    expect(seen.map((op) => op.documentId)).toContain('after-recreate');
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Outbox - overflow compacts the backlog during a long outage', async () => {
  const dbPath = tempDb('overflow');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sync = client.createSync(deadSink, {
    pollIntervalMs: 20,
    retryDelayMs: 10,
    maxRetryDelayMs: 20,
    maxOutboxSize: 5,
  });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    const overflow = new Promise<{ pending: number; compacted: number }>((resolve) => {
      sync.once('overflow', resolve);
    });

    // One document, rewritten repeatedly, with the upstream refusing writes.
    await users.insertOne({ _id: 'hot', counter: 0 } as never);
    for (let i = 1; i <= 20; i += 1) {
      await users.updateOne({ _id: 'hot' }, { $set: { counter: i } });
    }

    const event = await overflow;
    expect(event.pending).toBeGreaterThan(5);
    expect(event.compacted).toBeGreaterThan(0);

    // The backlog collapsed to the single surviving revision.
    expect(await sync.log.pendingCount(0, null)).toBe(1);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Outbox - unparseable stored JSON is dead-lettered rather than stalling the stream', async () => {
  const dbPath = tempDb('poison');
  const client = new MongoLite(dbPath);
  await client.connect();

  const seen: SyncOperation[] = [];
  const sink: SyncSink = {
    name: 'collecting',
    async apply(operations): Promise<SyncApplyResult> {
      seen.push(...operations);
      return { applied: operations.length };
    },
  };

  const sync = client.createSync(sink, { pollIntervalMs: 20 });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();
    await sync.waitForDrain();

    // Corrupt one row behind the collection API's back, the way a truncated
    // write or an external process could.
    await client.database.run('INSERT INTO "users" (_id, data) VALUES (?, ?)', [
      'broken',
      '{"name": "unterminated',
    ]);
    await client.database.run('INSERT INTO "users" (_id, data) VALUES (?, ?)', [
      'fine',
      '{"name":"Alice"}',
    ]);

    await sync.waitForDrain();

    expect(seen.map((op) => op.documentId)).toEqual(['fine']);

    const dead = await sync.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0].documentId).toBe('broken');
    expect(dead[0].error).toContain('could not be parsed');
    expect((await sync.status()).pending).toBe(0);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});
