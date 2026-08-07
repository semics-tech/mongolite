/**
 * Conflict handling through the replicator, with a fake upstream that models the
 * essentials of a real one: documents carry a `_v`, writes are conditional on it, and
 * a write whose predicate misses reports a conflict rather than an error.
 */
import test from 'node:test';
import { expect } from 'expect';
import { MongoLite } from '../src/index.js';
import type {
  SyncApplyConflict,
  SyncApplyResult,
  SyncConflictContext,
  SyncOperation,
  SyncSink,
} from '../src/index.js';
import { applyDiff } from '../src/index.js';
import { existsSync, unlinkSync } from 'fs';

/**
 * A miniature versioned document store standing in for MongoDB — enough to exercise
 * compare-and-swap without a server.
 */
class VersionedSink implements SyncSink {
  readonly name = 'versioned';

  /** Upstream documents keyed by `collection/_id`, each carrying a `_v`. */
  readonly docs = new Map<string, Record<string, unknown>>();
  /** Operations received, for asserting on what was actually sent. */
  readonly seen: SyncOperation[][] = [];

  async apply(operations: SyncOperation[]): Promise<SyncApplyResult> {
    this.seen.push(operations.map((op) => ({ ...op })));

    const conflicts: SyncApplyConflict[] = [];
    let applied = 0;

    for (const [index, op] of operations.entries()) {
      const key = `${op.collection}/${op.documentId}`;
      const current = this.docs.get(key);
      const currentVersion = typeof current?._v === 'number' ? current._v : null;

      if (op.type === 'delete') {
        if (op.baseVersion !== null && op.baseVersion !== undefined && current) {
          if (currentVersion !== op.baseVersion) {
            conflicts.push({
              index,
              reason: 'version-mismatch',
              serverDocument: current,
              serverVersion: currentVersion,
            });
            continue;
          }
        }
        this.docs.delete(key);
        applied += 1;
        continue;
      }

      // Never been upstream: create it, unless someone got there first.
      if (op.baseVersion === null || op.baseVersion === undefined) {
        if (current) {
          conflicts.push({
            index,
            reason: 'already-exists',
            serverDocument: current,
            serverVersion: currentVersion,
          });
          continue;
        }
        this.docs.set(key, { ...(op.document ?? {}), _v: 1 });
        applied += 1;
        continue;
      }

      // Known revision: the write only lands if nobody moved the document.
      if (!current) {
        conflicts.push({ index, reason: 'missing' });
        continue;
      }
      if (currentVersion !== op.baseVersion) {
        conflicts.push({
          index,
          reason: 'version-mismatch',
          serverDocument: current,
          serverVersion: currentVersion,
        });
        continue;
      }

      const next = op.diff ? applyDiff(current, op.diff) : { ...(op.document ?? {}) };
      this.docs.set(key, { ...next, _v: op.baseVersion + 1 });
      applied += 1;
    }

    return { applied, conflicts: conflicts.length > 0 ? conflicts : undefined };
  }

  async fetch(collection: string, documentIds: string[]): Promise<Record<string, unknown>[]> {
    return documentIds
      .map((id) => this.docs.get(`${collection}/${id}`))
      .filter((doc): doc is Record<string, unknown> => Boolean(doc));
  }

  /** Simulates another writer changing a document behind our back. */
  writeDirectly(collection: string, documentId: string, patch: Record<string, unknown>): void {
    const key = `${collection}/${documentId}`;
    const current = this.docs.get(key) ?? { _v: 0 };
    const version = typeof current._v === 'number' ? current._v : 0;
    this.docs.set(key, { ...current, ...patch, _v: version + 1 });
  }
}

function tempDb(label: string): string {
  const path = `./test-conflict-${label}.sqlite`;
  cleanup(path);
  return path;
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

test('Conflicts - a push carries the version it last saw, and the version advances', async () => {
  const dbPath = tempDb('cas');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new VersionedSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20 });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice' } as never);
    await sync.waitForDrain();
    expect(sink.docs.get('users/u1')).toMatchObject({ name: 'Alice', _v: 1 });

    await users.updateOne({ _id: 'u1' }, { $set: { name: 'Alice II' } });
    await sync.waitForDrain();

    // The second push asserted _v: 1 — the version it had actually seen.
    const second = sink.seen.at(-1)?.[0];
    expect(second?.baseVersion).toBe(1);
    expect(sink.docs.get('users/u1')).toMatchObject({ name: 'Alice II', _v: 2 });
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Conflicts - only the changed fields are pushed', async () => {
  const dbPath = tempDb('diff');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new VersionedSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20 });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice', age: 30, city: 'London' } as never);
    await sync.waitForDrain();

    await users.updateOne({ _id: 'u1' }, { $set: { age: 31 } });
    await sync.waitForDrain();

    const update = sink.seen.at(-1)?.[0];
    expect(update?.diff?.set).toEqual({ age: 31 });
    expect(update?.diff?.unset).toEqual([]);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Conflicts - a stale local push loses to a concurrent server edit', async () => {
  const dbPath = tempDb('lose');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new VersionedSink();
  const conflicts: Array<SyncConflictContext & { resolution: string }> = [];
  const sync = client.createSync(sink, { pollIntervalMs: 20 });
  sync.on('conflict', (event) => conflicts.push(event));

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice', age: 30 } as never);
    await sync.waitForDrain();

    // Someone else edits the document upstream, bumping it to _v: 2.
    sink.writeDirectly('users', 'u1', { name: 'Edited elsewhere' });

    // Our local edit still believes it is replacing _v: 1.
    await users.updateOne({ _id: 'u1' }, { $set: { age: 31 } });
    await sync.waitForDrain();

    // The server's value survives — this is the clobbering that used to happen silently.
    expect(sink.docs.get('users/u1')).toMatchObject({ name: 'Edited elsewhere', _v: 2 });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      documentId: 'u1',
      reason: 'version-mismatch',
      baseVersion: 1,
      serverVersion: 2,
      resolution: 'server',
    });

    // The local document adopts the winning version, so "server wins" sticks rather
    // than being re-asserted by the next local edit.
    expect(await users.findOne({ _id: 'u1' })).toMatchObject({ name: 'Edited elsewhere' });
    // Bookkeeping fields stay out of the local document.
    expect(await users.findOne({ _id: 'u1' })).not.toHaveProperty('_v');

    const status = await sync.status();
    expect(status.conflicts).toBe(1);
    // A conflict is reconciled, never dead-lettered.
    expect(status.deadLettered).toBe(0);
    expect(await sync.deadLetters()).toHaveLength(0);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Conflicts - after losing, the next local edit is based on the server version', async () => {
  const dbPath = tempDb('rebase');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new VersionedSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20 });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice', age: 30 } as never);
    await sync.waitForDrain();

    sink.writeDirectly('users', 'u1', { name: 'Edited elsewhere' });
    await users.updateOne({ _id: 'u1' }, { $set: { age: 31 } });
    await sync.waitForDrain();

    // The shadow was refreshed from the server, so this one asserts _v: 2 and lands.
    await users.updateOne({ _id: 'u1' }, { $set: { age: 32 } });
    await sync.waitForDrain();

    expect(sink.docs.get('users/u1')).toMatchObject({
      name: 'Edited elsewhere',
      age: 32,
      _v: 3,
    });
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Conflicts - onConflict returning "local" forces the local version through', async () => {
  const dbPath = tempDb('force');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new VersionedSink();
  const sync = client.createSync(sink, {
    pollIntervalMs: 20,
    onConflict: () => 'local',
  });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice', age: 30 } as never);
    await sync.waitForDrain();

    sink.writeDirectly('users', 'u1', { name: 'Edited elsewhere' });
    await users.updateOne({ _id: 'u1' }, { $set: { age: 31 } });

    // The first drain hits the conflict and re-queues; the retry is new work queued
    // during that drain, so it lands on the next pass.
    await sync.waitForDrain();
    await sync.waitForDrain();

    // Re-queued against the refreshed base, so the retry wins rather than looping.
    expect(sink.docs.get('users/u1')).toMatchObject({ name: 'Alice', age: 31, _v: 3 });
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Conflicts - onConflict returning "skip" abandons the local change', async () => {
  const dbPath = tempDb('skip');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new VersionedSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20, onConflict: () => 'skip' });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice', age: 30 } as never);
    await sync.waitForDrain();

    sink.writeDirectly('users', 'u1', { name: 'Edited elsewhere' });
    await users.updateOne({ _id: 'u1' }, { $set: { age: 31 } });
    await sync.waitForDrain();

    expect(sink.docs.get('users/u1')).toMatchObject({ name: 'Edited elsewhere', _v: 2 });
    expect(sink.docs.get('users/u1')).not.toHaveProperty('age', 31);
    expect((await sync.status()).pending).toBe(0);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Conflicts - a document that already exists upstream is adopted, not overwritten', async () => {
  const dbPath = tempDb('exists');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new VersionedSink();
  // The upstream already holds this document — another client created it.
  sink.docs.set('users/u1', { name: 'Created elsewhere', _v: 4 });

  const conflicts: SyncConflictContext[] = [];
  const sync = client.createSync(sink, { pollIntervalMs: 20 });
  sync.on('conflict', (event) => conflicts.push(event));

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Created locally' } as never);
    await sync.waitForDrain();

    expect(sink.docs.get('users/u1')).toMatchObject({ name: 'Created elsewhere', _v: 4 });
    expect(conflicts[0]).toMatchObject({ reason: 'already-exists', documentId: 'u1' });
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Conflicts - a delete is conditional on the version too', async () => {
  const dbPath = tempDb('delete');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new VersionedSink();
  const conflicts: SyncConflictContext[] = [];
  const sync = client.createSync(sink, { pollIntervalMs: 20 });
  sync.on('conflict', (event) => conflicts.push(event));

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice' } as never);
    await sync.waitForDrain();

    sink.writeDirectly('users', 'u1', { name: 'Edited elsewhere' });
    await users.deleteOne({ _id: 'u1' });
    await sync.waitForDrain();

    // The document survives: deleting a revision we never saw would discard
    // someone else's change.
    expect(sink.docs.has('users/u1')).toBe(true);
    expect(conflicts[0]).toMatchObject({ operation: 'delete', reason: 'version-mismatch' });
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Conflicts - a no-op local write is not pushed at all', async () => {
  const dbPath = tempDb('noop');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new VersionedSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20 });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice' } as never);
    await sync.waitForDrain();
    const batchesAfterInsert = sink.seen.length;

    // Rewriting the same value changes nothing upstream, so no version is burned.
    await users.updateOne({ _id: 'u1' }, { $set: { name: 'Alice' } });
    await sync.waitForDrain();

    expect(sink.seen.length).toBe(batchesAfterInsert);
    expect(sink.docs.get('users/u1')).toMatchObject({ _v: 1 });
    expect((await sync.status()).pending).toBe(0);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('Conflicts - versioning can be turned off for a single-writer upstream', async () => {
  const dbPath = tempDb('off');
  const client = new MongoLite(dbPath);
  await client.connect();

  const sink = new VersionedSink();
  const sync = client.createSync(sink, { pollIntervalMs: 20, versioning: false });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice' } as never);
    await sync.waitForDrain();

    const op = sink.seen.at(-1)?.[0];
    expect(op?.baseVersion).toBeUndefined();
    expect(op?.diff).toBeUndefined();
    expect(op?.document).toMatchObject({ name: 'Alice' });
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});
