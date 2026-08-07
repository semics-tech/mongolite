/**
 * End-to-end replication against a fake MongoDB that implements enough of the real
 * semantics to be meaningful: conditional `updateOne` filters, `$set`/`$unset`/`$inc`/
 * `$setOnInsert`, upserts, and — critically — **aggregate** bulk-write counts.
 *
 * That last detail is why this file exists. `bulkWrite` reports only totals, so
 * detecting which conditional write lost takes a re-read and a judgement call. A sink
 * double that reports conflicts directly (as `tests/sync.conflicts.test.ts` does) never
 * exercises that path, and a bug there is invisible until a real server is involved.
 * This runs the genuine `MongoUpstreamSink`, command builder and executor, faking only
 * the database itself.
 */
import test from 'node:test';
import { expect } from 'expect';
import { ObjectId } from 'bson';
import { MongoLite } from '../src/index.js';
import { existsSync, unlinkSync } from 'fs';

/** A minimal MongoDB that honours version predicates and reports aggregate counts. */
function createFakeMongoServer() {
  const collections = new Map<string, Map<string, Record<string, unknown>>>();

  const store = (name: string): Map<string, Record<string, unknown>> => {
    let collection = collections.get(name);
    if (!collection) {
      collection = new Map();
      collections.set(name, collection);
    }
    return collection;
  };

  const matches = (doc: Record<string, unknown> | undefined, filter: Record<string, unknown>) => {
    if (!doc) return false;
    return Object.entries(filter).every(([key, value]) => {
      const actual = key === '_id' ? String(doc._id) : doc[key];
      const expected = key === '_id' ? String(value) : value;
      return actual === expected;
    });
  };

  const applyUpdate = (
    doc: Record<string, unknown>,
    update: Record<string, unknown>,
    inserting: boolean
  ): void => {
    if (inserting && update.$setOnInsert) {
      Object.assign(doc, update.$setOnInsert as Record<string, unknown>);
    }
    for (const [path, value] of Object.entries((update.$set ?? {}) as Record<string, unknown>)) {
      setPath(doc, path, value);
    }
    for (const path of Object.keys((update.$unset ?? {}) as Record<string, unknown>)) {
      unsetPath(doc, path);
    }
    for (const [key, delta] of Object.entries((update.$inc ?? {}) as Record<string, number>)) {
      doc[key] = ((doc[key] as number) ?? 0) + delta;
    }
    for (const key of Object.keys((update.$currentDate ?? {}) as Record<string, unknown>)) {
      doc[key] = new Date();
    }
  };

  const client = {
    async connect() {},
    async close() {},
    db(_name?: string) {
      return {
        collection(name: string) {
          const documents = store(name);
          return {
            async bulkWrite(operations: unknown[]) {
              let matchedCount = 0;
              let upsertedCount = 0;
              let deletedCount = 0;

              for (const raw of operations) {
                const operation = raw as Record<string, Record<string, unknown>>;

                if (operation.deleteOne) {
                  const filter = operation.deleteOne.filter as Record<string, unknown>;
                  const id = String(filter._id);
                  if (matches(documents.get(id), filter)) {
                    documents.delete(id);
                    deletedCount += 1;
                  }
                  continue;
                }

                if (operation.replaceOne) {
                  const filter = operation.replaceOne.filter as Record<string, unknown>;
                  const id = String(filter._id);
                  documents.set(id, {
                    ...(operation.replaceOne.replacement as Record<string, unknown>),
                    _id: id,
                  });
                  matchedCount += 1;
                  continue;
                }

                const filter = operation.updateOne.filter as Record<string, unknown>;
                const update = operation.updateOne.update as Record<string, unknown>;
                const id = String(filter._id);
                const existing = documents.get(id);

                if (matches(existing, filter)) {
                  applyUpdate(existing as Record<string, unknown>, update, false);
                  matchedCount += 1;
                } else if (operation.updateOne.upsert && !existing) {
                  const created: Record<string, unknown> = { _id: id };
                  applyUpdate(created, update, true);
                  documents.set(id, created);
                  upsertedCount += 1;
                }
                // Otherwise the predicate missed: no error, no count — exactly the
                // silence the executor has to notice.
              }

              return { matchedCount, upsertedCount, deletedCount };
            },
            find(filter: Record<string, unknown>) {
              const ids = ((filter._id as { $in?: unknown[] })?.$in ?? []).map(String);
              return {
                async toArray() {
                  return ids
                    .map((id) => documents.get(id))
                    .filter((doc): doc is Record<string, unknown> => Boolean(doc));
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    driver: {
      MongoClient: class {
        constructor() {
          return client;
        }
      },
      ObjectId,
    } as never,
    /** Simulates another writer following the same protocol. */
    writeDirectly(collection: string, id: string, patch: Record<string, unknown>) {
      const documents = store(collection);
      const current = documents.get(id) ?? { _id: id, _v: 0 };
      documents.set(id, { ...current, ...patch, _v: ((current._v as number) ?? 0) + 1 });
    },
    read: (collection: string, id: string) => store(collection).get(id),
    count: (collection: string) => store(collection).size,
  };
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (typeof current[segment] !== 'object' || current[segment] === null) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = value;
}

function unsetPath(target: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  let current: Record<string, unknown> | undefined = target;
  for (const segment of segments.slice(0, -1)) {
    current = current?.[segment] as Record<string, unknown> | undefined;
    if (!current) return;
  }
  delete current[segments[segments.length - 1]];
}

function tempDb(label: string): string {
  const path = `./test-mongo-integration-${label}.sqlite`;
  cleanup(path);
  return path;
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

test('MongoIntegration - inserts, updates and deletes converge upstream', async () => {
  const dbPath = tempDb('crud');
  const server = createFakeMongoServer();
  const client = new MongoLite(dbPath);
  await client.connect();

  const sync = client.syncToMongo({
    connectionString: 'mongodb://fake',
    database: 'app',
    driver: server.driver,
    pollIntervalMs: 20,
  });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice', age: 30 } as never);
    await sync.waitForDrain();
    expect(server.read('users', 'u1')).toMatchObject({ name: 'Alice', age: 30, _v: 1 });

    await users.updateOne({ _id: 'u1' }, { $set: { age: 31 } });
    await sync.waitForDrain();
    expect(server.read('users', 'u1')).toMatchObject({ age: 31, _v: 2 });

    await users.deleteOne({ _id: 'u1' });
    await sync.waitForDrain();
    expect(server.read('users', 'u1')).toBeUndefined();
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('MongoIntegration - a concurrent writer bumping _v by one is still detected', async () => {
  const dbPath = tempDb('conflict');
  const server = createFakeMongoServer();
  const client = new MongoLite(dbPath);
  await client.connect();

  const conflicts: Array<{ documentId: string; serverVersion: number | null }> = [];
  const sync = client.syncToMongo({
    connectionString: 'mongodb://fake',
    database: 'app',
    driver: server.driver,
    pollIntervalMs: 20,
  });
  sync.on('conflict', (event) => conflicts.push(event));

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice', age: 30 } as never);
    await sync.waitForDrain();

    // Another participant in the protocol increments `_v` by exactly one — the same
    // increment our own successful write produces, so the version alone cannot tell
    // the two apart.
    server.writeDirectly('users', 'u1', { name: 'Edited elsewhere' });

    await users.updateOne({ _id: 'u1' }, { $set: { age: 31 } });
    await sync.waitForDrain();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ documentId: 'u1', serverVersion: 2 });
    expect(server.read('users', 'u1')).toMatchObject({ name: 'Edited elsewhere', age: 30 });
    expect((await sync.status()).deadLettered).toBe(0);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});

test('MongoIntegration - a rebased edit lands on the next attempt', async () => {
  const dbPath = tempDb('rebase');
  const server = createFakeMongoServer();
  const client = new MongoLite(dbPath);
  await client.connect();

  const sync = client.syncToMongo({
    connectionString: 'mongodb://fake',
    database: 'app',
    driver: server.driver,
    pollIntervalMs: 20,
  });

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertOne({ _id: 'u1', name: 'Alice', age: 30 } as never);
    await sync.waitForDrain();

    server.writeDirectly('users', 'u1', { name: 'Edited elsewhere' });

    // Loses and is rebased: the server's version is adopted locally.
    await users.updateOne({ _id: 'u1' }, { $set: { age: 31 } });
    await sync.waitForDrain();
    expect(await users.findOne({ _id: 'u1' })).toMatchObject({ name: 'Edited elsewhere' });

    // Now current, so this one lands on top of the other writer's change.
    await users.updateOne({ _id: 'u1' }, { $set: { age: 32 } });
    await sync.waitForDrain();

    expect(server.read('users', 'u1')).toMatchObject({
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

test('MongoIntegration - a mixed batch reports only the operations that actually lost', async () => {
  const dbPath = tempDb('mixed');
  const server = createFakeMongoServer();
  const client = new MongoLite(dbPath);
  await client.connect();

  const conflicts: Array<{ documentId: string }> = [];
  const sync = client.syncToMongo({
    connectionString: 'mongodb://fake',
    database: 'app',
    driver: server.driver,
    pollIntervalMs: 5_000,
  });
  sync.on('conflict', (event) => conflicts.push(event));

  try {
    const users = client.collection('users');
    await users.ensureTable();
    await sync.start();

    await users.insertMany([
      { _id: 'a', n: 0 },
      { _id: 'b', n: 0 },
      { _id: 'c', n: 0 },
    ] as never);
    sync.notify();
    await sync.waitForDrain();

    // Only 'b' is taken by another writer.
    server.writeDirectly('users', 'b', { n: 99 });

    for (const id of ['a', 'b', 'c']) {
      await users.updateOne({ _id: id }, { $set: { n: 1 } });
    }
    sync.notify();
    await sync.waitForDrain();

    // One short count implicates every conditional write in the batch; the re-read has
    // to clear 'a' and 'c' rather than report three conflicts.
    expect(conflicts.map((c) => c.documentId)).toEqual(['b']);
    expect(server.read('users', 'a')).toMatchObject({ n: 1, _v: 2 });
    expect(server.read('users', 'c')).toMatchObject({ n: 1, _v: 2 });
    expect(server.read('users', 'b')).toMatchObject({ n: 99, _v: 2 });

    const status = await sync.status();
    expect(status.conflicts).toBe(1);
    // The two that landed are counted as applied, not written off with the one that lost.
    expect(status.applied).toBe(5);
  } finally {
    await sync.stop();
    await client.close();
    cleanup(dbPath);
  }
});
