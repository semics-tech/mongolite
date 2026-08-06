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

function createFakeDriver(options: { failWith?: unknown } = {}) {
  const recorded: Recorded[] = [];
  const clientOptions: Array<Record<string, unknown> | undefined> = [];
  const uris: string[] = [];

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
            return { upsertedCount: operations.length };
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

test('MongoSink - upserts replace the whole document, keyed by _id', async () => {
  const fake = createFakeDriver();
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    database: 'app',
    driver: fake.driver,
  });

  await sink.connect();
  const result = await sink.apply([upsert('user-1', { name: 'Alice' })]);

  expect(result.applied).toBe(1);
  expect(result.failures).toBeUndefined();
  expect(fake.recorded).toHaveLength(1);
  expect(fake.recorded[0].collection).toBe('app.users');

  // `replaceOne` + `upsert` is what makes a replay idempotent: re-running the
  // same batch lands on the same upstream state.
  expect(fake.recorded[0].operations[0]).toEqual({
    replaceOne: {
      filter: { _id: 'user-1' },
      replacement: { _id: 'user-1', name: 'Alice' },
      upsert: true,
    },
  });
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

  const writes = fake.recorded[0].operations as Array<{ replaceOne: { filter: { _id: unknown } } }>;
  expect(writes[0].replaceOne.filter._id).toBeInstanceOf(FakeObjectId);
  expect(String(writes[0].replaceOne.filter._id)).toBe('507f1f77bcf86cd799439011');
  expect(writes[1].replaceOne.filter._id).toBe('user-alice');
});

test('MongoSink - idMapping "string" leaves every id as a string', async () => {
  const fake = createFakeDriver();
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    idMapping: 'string',
    driver: fake.driver,
  });

  await sink.apply([upsert('507f1f77bcf86cd799439011', { name: 'Alice' })]);

  const writes = fake.recorded[0].operations as Array<{ replaceOne: { filter: { _id: unknown } } }>;
  expect(writes[0].replaceOne.filter._id).toBe('507f1f77bcf86cd799439011');
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
      // 11000 (duplicate key) can be transient during a failover, so it is not
      // on the permanent list — the safe default is to retry the batch.
      writeErrors: [{ index: 0, code: 11000, errmsg: 'E11000 duplicate key error' }],
    }),
  });
  const sink = new MongoUpstreamSink({
    connectionString: 'mongodb://localhost:27017',
    driver: fake.driver,
  });

  await expect(sink.apply([upsert('u1', { name: 'Alice' })])).rejects.toThrow('bulk write failed');
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
