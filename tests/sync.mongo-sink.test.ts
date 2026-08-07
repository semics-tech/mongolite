/**
 * Tests for the MongoDB sink that do not need a running server.
 *
 * The `driver` option lets a fake stand in for the `mongodb` module, so the
 * pieces worth pinning down — the bulk operations we build, `_id` mapping,
 * client options, and which errors are retried versus dead-lettered — are
 * covered by `npm test`. End-to-end behaviour against a real server lives in
 * `tests/parity/sync.parity.test.ts`.
 */
import test from 'node:test';
import { expect } from 'expect';
import { MongoUpstreamSink } from '../src/index.js';
import type { SyncOperation } from '../src/index.js';

/** Stands in for `bson.ObjectId` — identity is all the assertions need. */
class FakeObjectId {
  constructor(readonly value: string) {}
  static isValid(id: string): boolean {
    return /^[0-9a-fA-F]{24}$/.test(id) || id.length === 12;
  }
  toString(): string {
    return this.value;
  }
}

interface Recorded {
  collection: string;
  operations: unknown[];
  options?: Record<string, unknown>;
}

function createFakeDriver(
  options: {
    failWith?: unknown;
    /** Counts the server reports back, overriding the "everything landed" default. */
    result?: Record<string, number>;
    /** Documents the collection contains, keyed by `_id`, for re-reads after a miss. */
    upstream?: Record<string, Record<string, unknown>>;
  } = {}
) {
  const recorded: Recorded[] = [];
  const clientOptions: Array<Record<string, unknown> | undefined> = [];
  const uris: string[] = [];
  const queries: Array<Record<string, unknown>> = [];

  class FakeMongoClient {
    constructor(uri: string, opts?: Record<string, unknown>) {
      uris.push(uri);
      clientOptions.push(opts);
    }
    async connect(): Promise<void> {}
    async close(): Promise<void> {}
    db(name?: string) {
      return {
        collection: (collection: string) => ({
          bulkWrite: async (operations: unknown[], opts?: Record<string, unknown>) => {
            recorded.push({ collection: `${name ?? ''}.${collection}`, operations, options: opts });
            if (options.failWith) throw options.failWith;
            return options.result ?? { matchedCount: operations.length, upsertedCount: 0 };
          },
          find: (filter: Record<string, unknown>) => {
            queries.push(filter);
            const ids = ((filter._id as { $in?: unknown[] })?.$in ?? []).map(String);
            return {
              toArray: async () =>
                ids
                  .map((id) => options.upstream?.[id])
                  .filter((doc): doc is Record<string, unknown> => Boolean(doc)),
            };
          },
        }),
      };
    }
  }

  return {
    driver: { MongoClient: FakeMongoClient, ObjectId: FakeObjectId } as never,
    recorded,
    clientOptions,
    uris,
    queries,
  };
}

function upsert(documentId: string, document: Record<string, unknown>): SyncOperation {
  return {
    collection: 'users',
    sourceCollection: 'users',
    documentId,
    type: 'upsert',
    document: { _id: documentId, ...document },
    outboxId: 1,
  };
}

test('MongoSink - a document never seen upstream is created without overwriting', async () => {
  const fake = createFakeDriver({ result: { matchedCount: 0, upsertedCount: 1 } });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    database: 'app',
    driver: fake.driver,
  });

  await sink.connect();
  const result = await sink.apply([upsert('user-1', { name: 'Alice' })]);

  expect(result.applied).toBe(1);
  expect(result.failures).toBeUndefined();
  expect(result.conflicts).toBeUndefined();
  expect(fake.recorded[0].collection).toBe('app.users');

  // `$setOnInsert` means an existing upstream document is left alone rather than
  // clobbered — the local store does not get to overwrite what it never read.
  expect(fake.recorded[0].operations[0]).toEqual({
    updateOne: {
      filter: { _id: 'user-1' },
      update: {
        $setOnInsert: { name: 'Alice', _v: 1 },
        $currentDate: { _updatedAt: true },
      },
      upsert: true,
    },
  });
});

test('MongoSink - a known revision is updated conditionally, with only the changed fields', async () => {
  const fake = createFakeDriver({ result: { matchedCount: 1 } });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    database: 'app',
    driver: fake.driver,
  });

  await sink.apply([
    {
      ...upsert('user-1', { name: 'Alice', age: 31 }),
      baseVersion: 7,
      diff: { set: { age: 31 }, unset: ['nickname'] },
    },
  ]);

  // The `_v: 7` predicate is the whole point: if another writer moved the document
  // on, this matches nothing instead of silently overwriting their change.
  expect(fake.recorded[0].operations[0]).toEqual({
    updateOne: {
      filter: { _id: 'user-1', _v: 7 },
      update: {
        $inc: { _v: 1 },
        $currentDate: { _updatedAt: true },
        $set: { age: 31 },
        $unset: { nickname: '' },
      },
    },
  });
});

test('MongoSink - a conditional write that matches nothing is reported as a conflict', async () => {
  const fake = createFakeDriver({
    // The server moved on: our `_v: 7` predicate matched no document.
    result: { matchedCount: 0 },
    upstream: { 'user-1': { _id: 'user-1', name: 'Changed by someone else', _v: 9 } },
  });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  const result = await sink.apply([
    {
      ...upsert('user-1', { name: 'Alice' }),
      baseVersion: 7,
      diff: { set: { name: 'Alice' }, unset: [] },
    },
  ]);

  expect(result.applied).toBe(0);
  // Crucially not a failure: a conflict is reconciled, never dead-lettered.
  expect(result.failures).toBeUndefined();
  expect(result.conflicts).toEqual([
    {
      index: 0,
      reason: 'version-mismatch',
      serverDocument: { _id: 'user-1', name: 'Changed by someone else', _v: 9 },
      serverVersion: 9,
    },
  ]);
});

test('MongoSink - a conflict is caught even when the other writer bumped _v by exactly one', async () => {
  const fake = createFakeDriver({
    result: { matchedCount: 0 },
    // Another client following the same protocol incremented `_v` by one, exactly as
    // our own successful write would have. Only the document contents distinguish
    // "we landed" from "they landed", and getting that wrong silently drops the
    // conflict this whole mechanism exists to catch.
    upstream: { u1: { _id: 'u1', name: 'Edited elsewhere', age: 30, _v: 2 } },
  });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  const result = await sink.apply([
    { ...upsert('u1', { age: 31 }), baseVersion: 1, diff: { set: { age: 31 }, unset: [] } },
  ]);

  expect(result.conflicts).toHaveLength(1);
  expect(result.conflicts?.[0]).toMatchObject({ reason: 'version-mismatch', serverVersion: 2 });
  expect(result.applied).toBe(0);
});

test('MongoSink - a write that did land is not reported as a conflict', async () => {
  const fake = createFakeDriver({
    // One op in the batch missed, so the aggregate count is short — but this document
    // is at the expected version *and* carries our change, so it landed.
    result: { matchedCount: 0 },
    upstream: { u1: { _id: 'u1', name: 'Alice', age: 31, _v: 2 } },
  });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  const result = await sink.apply([
    { ...upsert('u1', { age: 31 }), baseVersion: 1, diff: { set: { age: 31 }, unset: [] } },
  ]);

  expect(result.conflicts).toBeUndefined();
  expect(result.applied).toBe(1);
});

test('MongoSink - versioning off restores unconditional whole-document replacement', async () => {
  const fake = createFakeDriver();
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    versioning: false,
    driver: fake.driver,
  });

  await sink.apply([upsert('user-1', { name: 'Alice' })]);

  expect(fake.recorded[0].operations[0]).toEqual({
    replaceOne: {
      filter: { _id: 'user-1' },
      replacement: { _id: 'user-1', name: 'Alice' },
      upsert: true,
    },
  });
});

test('MongoSink - fetch reads documents back by _id', async () => {
  const fake = createFakeDriver({
    upstream: { a: { _id: 'a', name: 'Alice' }, b: { _id: 'b', name: 'Bob' } },
  });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  const documents = await sink.fetch('users', ['a', 'missing', 'b']);

  expect(documents).toEqual([
    { _id: 'a', name: 'Alice' },
    { _id: 'b', name: 'Bob' },
  ]);
});

test('MongoSink - deletes are keyed by _id alone', async () => {
  const fake = createFakeDriver();
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  await sink.apply([
    {
      collection: 'users',
      sourceCollection: 'users',
      documentId: 'user-1',
      type: 'delete',
      outboxId: 2,
    },
  ]);

  expect(fake.recorded[0].operations[0]).toEqual({ deleteOne: { filter: { _id: 'user-1' } } });
});

test('MongoSink - ObjectId-shaped ids become ObjectIds, others stay strings', async () => {
  const fake = createFakeDriver();
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  await sink.apply([
    upsert('507f1f77bcf86cd799439011', { name: 'Alice' }),
    upsert('user-alice', { name: 'Bob' }),
  ]);

  const writes = fake.recorded[0].operations as Array<{ updateOne: { filter: { _id: unknown } } }>;
  expect(writes[0].updateOne.filter._id).toBeInstanceOf(FakeObjectId);
  expect(String(writes[0].updateOne.filter._id)).toBe('507f1f77bcf86cd799439011');
  expect(writes[1].updateOne.filter._id).toBe('user-alice');
});

test('MongoSink - idMapping "string" leaves every id as a string', async () => {
  const fake = createFakeDriver();
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    idMapping: 'string',
    driver: fake.driver,
  });

  await sink.apply([upsert('507f1f77bcf86cd799439011', { name: 'Alice' })]);

  const writes = fake.recorded[0].operations as Array<{ updateOne: { filter: { _id: unknown } } }>;
  expect(writes[0].updateOne.filter._id).toBe('507f1f77bcf86cd799439011');
});

test('MongoSink - operations are grouped into one bulkWrite per collection', async () => {
  const fake = createFakeDriver();
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    database: 'app',
    driver: fake.driver,
  });

  await sink.apply([
    upsert('u1', { name: 'Alice' }),
    { ...upsert('o1', { total: 1 }), collection: 'orders', sourceCollection: 'orders' },
    upsert('u2', { name: 'Bob' }),
  ]);

  expect(fake.recorded).toHaveLength(2);
  expect(fake.recorded.map((r) => r.collection).sort()).toEqual(['app.orders', 'app.users']);
  expect(fake.recorded.find((r) => r.collection === 'app.users')?.operations).toHaveLength(2);

  // Distinct documents, so ordering buys nothing and unordered lets the server parallelise.
  expect(fake.recorded[0].options).toMatchObject({ ordered: false });
});

test('MongoSink - defaults to majority write concern', async () => {
  const fake = createFakeDriver();
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  await sink.apply([upsert('u1', { name: 'Alice' })]);
  expect(fake.recorded[0].options).toMatchObject({ writeConcern: { w: 'majority' } });
});

test('MongoSink - credential files and driver options reach the client', async () => {
  const fake = createFakeDriver();
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb+srv://cluster.example.com/app',
    authMechanism: 'MONGODB-X509',
    tlsCertificateKeyFile: '/etc/ssl/client.pem',
    tlsCAFile: '/etc/ssl/ca.pem',
    driverOptions: { serverApi: { version: '1' }, maxPoolSize: 5 },
    driver: fake.driver,
  });

  await sink.connect();

  expect(fake.uris[0]).toBe('mongodb+srv://cluster.example.com/app');
  expect(fake.clientOptions[0]).toEqual({
    authMechanism: 'MONGODB-X509',
    tlsCertificateKeyFile: '/etc/ssl/client.pem',
    tlsCAFile: '/etc/ssl/ca.pem',
    serverApi: { version: '1' },
    maxPoolSize: 5,
  });

  // Unset options are omitted entirely, so they cannot override what the
  // connection string already specified.
  expect(fake.clientOptions[0]).not.toHaveProperty('tls');
  expect(fake.clientOptions[0]).not.toHaveProperty('auth');
});

test('MongoSink - a connection failure is thrown so the batch is retried', async () => {
  const fake = createFakeDriver({
    failWith: Object.assign(new Error('connection timed out'), {
      name: 'MongoNetworkTimeoutError',
    }),
  });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  await expect(sink.apply([upsert('u1', { name: 'Alice' })])).rejects.toThrow(
    'connection timed out'
  );
});

test('MongoSink - document validation failures are reported, not thrown', async () => {
  const fake = createFakeDriver({
    failWith: Object.assign(new Error('bulk write failed'), {
      name: 'MongoBulkWriteError',
      writeErrors: [{ index: 1, code: 121, errmsg: 'Document failed validation' }],
    }),
  });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  const result = await sink.apply([
    upsert('good', { name: 'Alice' }),
    upsert('bad', { name: 'Invalid' }),
  ]);

  // Only the offending operation is surfaced; the rest of the batch counts as applied.
  expect(result.failures).toHaveLength(1);
  expect(result.failures?.[0]).toMatchObject({ index: 1, code: 121 });
  expect(result.failures?.[0].message).toContain('Document failed validation');
  expect(result.applied).toBe(1);
});

test('MongoSink - an unrecognised write error is retried rather than discarded', async () => {
  const fake = createFakeDriver({
    failWith: Object.assign(new Error('bulk write failed'), {
      name: 'MongoBulkWriteError',
      // An unfamiliar code might be transient, so the safe default is to retry the
      // whole batch rather than assume the write can never succeed.
      writeErrors: [{ index: 0, code: 24601, errmsg: 'something novel went wrong' }],
    }),
  });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  await expect(sink.apply([upsert('u1', { name: 'Alice' })])).rejects.toThrow('bulk write failed');
});

test('MongoSink - a duplicate _id on create is a conflict, not a failure', async () => {
  const fake = createFakeDriver({
    failWith: Object.assign(new Error('bulk write failed'), {
      name: 'MongoBulkWriteError',
      writeErrors: [
        {
          index: 0,
          code: 11000,
          errmsg: 'E11000 duplicate key error collection: app.users index: _id_',
          keyPattern: { _id: 1 },
        },
      ],
    }),
  });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  // Two clients raced to create the same document; the loser reconciles rather than
  // dead-lettering a document that is perfectly valid.
  const result = await sink.apply([upsert('u1', { name: 'Alice' })]);
  expect(result.conflicts).toEqual([{ index: 0, reason: 'already-exists' }]);
  expect(result.failures).toBeUndefined();
});

test('MongoSink - a duplicate on another unique index is a real failure', async () => {
  const fake = createFakeDriver({
    failWith: Object.assign(new Error('bulk write failed'), {
      name: 'MongoBulkWriteError',
      writeErrors: [
        {
          index: 0,
          code: 11000,
          errmsg: 'E11000 duplicate key error collection: app.users index: email_1',
          keyPattern: { email: 1 },
        },
      ],
    }),
  });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  // Not a create race — the document genuinely violates a constraint, and retrying it
  // as a phantom conflict would loop forever.
  const result = await sink.apply([upsert('u1', { name: 'Alice' })]);
  expect(result.failures?.[0]).toMatchObject({ index: 0, code: 11000 });
  expect(result.conflicts).toBeUndefined();
});

test('MongoSink - a retryable-write error is always retried', async () => {
  const fake = createFakeDriver({
    failWith: Object.assign(new Error('primary stepped down'), {
      name: 'MongoBulkWriteError',
      writeErrors: [{ index: 0, code: 121, errmsg: 'Document failed validation' }],
      hasErrorLabel: (label: string) => label === 'RetryableWriteError',
    }),
  });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  // The label wins over the per-write code: a stepdown means the batch's fate
  // is unknown, so it must be retried rather than dead-lettered.
  await expect(sink.apply([upsert('u1', { name: 'Alice' })])).rejects.toThrow(
    'primary stepped down'
  );
});

test('MongoSink - requires a connection string', () => {
  expect(() => new MongoUpstreamSink({ connectionString: '' })).toThrow('connectionString');
});
