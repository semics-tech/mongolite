/**
 * The HTTP transport: sink, wire protocol, and receiver.
 *
 * The sink is exercised against a fake `fetch`, and the receiver against the same fake
 * MongoDB driver used elsewhere, so the whole loop runs under `npm test` without a
 * server. End-to-end behaviour against a real MongoDB lives in
 * `tests/parity/sync.http.parity.test.ts`.
 */
import test from 'node:test';
import { expect } from 'expect';
import { EJSON, ObjectId } from 'bson';
import { HttpUpstreamSink, buildWriteCommand } from '../src/index.js';
import type { SyncOperation } from '../src/index.js';
import { createSyncReceiver } from '../src/server.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function createFakeFetch(
  reply: {
    status?: number;
    body?: unknown;
    setCookie?: string;
    throws?: Error;
  } = {}
) {
  const calls: Captured[] = [];

  const fetchImpl = async (url: string, init: Record<string, unknown>) => {
    calls.push({
      url,
      method: init.method as string,
      headers: init.headers as Record<string, string>,
      // Decode so assertions see BSON types, not their Extended JSON encoding.
      body: EJSON.parse(init.body as string, { relaxed: true }) as Record<string, unknown>,
    });

    if (reply.throws) throw reply.throws;

    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      headers: {
        get: (name: string) => (name === 'set-cookie' ? (reply.setCookie ?? null) : null),
      },
      text: async () =>
        EJSON.stringify(reply.body ?? { protocol: 1, applied: calls.length }, { relaxed: true }),
    };
  };

  return { fetchImpl, calls };
}

function upsertOp(documentId: string, overrides: Partial<SyncOperation> = {}): SyncOperation {
  return {
    collection: 'users',
    sourceCollection: 'users',
    documentId,
    type: 'upsert',
    document: { _id: documentId, name: 'Alice' },
    outboxId: 1,
    ...overrides,
  };
}

test('HttpSink - posts a batch to the sync endpoint', async () => {
  const fake = createFakeFetch({ body: { protocol: 1, applied: 1 } });
  const sink = new HttpUpstreamSink({
    baseUrl: 'https://api.example.com/',
    database: 'app',
    fetch: fake.fetchImpl,
  });

  const result = await sink.apply([
    upsertOp('u1', { baseVersion: 3, diff: { set: { age: 31 }, unset: [] } }),
  ]);

  expect(result.applied).toBe(1);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0].url).toBe('https://api.example.com/sync/app/_sync');
  expect(fake.calls[0].method).toBe('POST');

  const operations = fake.calls[0].body.operations as Array<Record<string, unknown>>;
  expect(fake.calls[0].body.protocol).toBe(1);
  expect(operations[0]).toMatchObject({
    collection: 'users',
    documentId: 'u1',
    type: 'upsert',
    baseVersion: 3,
  });
});

test('HttpSink - carries the MongoDB command so an API can forward it', async () => {
  const fake = createFakeFetch();
  const sink = new HttpUpstreamSink({
    baseUrl: 'https://api.example.com',
    database: 'app',
    fetch: fake.fetchImpl,
  });

  await sink.apply([
    upsertOp('u1', { baseVersion: 7, diff: { set: { age: 31 }, unset: ['nick'] } }),
  ]);

  const operations = fake.calls[0].body.operations as Array<Record<string, unknown>>;
  const command = operations[0].command as { updateOne: { filter: Record<string, unknown> } };

  // The version predicate has to survive the hop, or the HTTP transport would quietly
  // lose the concurrency protection the direct connection has.
  expect(command.updateOne.filter._v).toBe(7);
});

test('HttpSink - BSON types survive the round trip', async () => {
  const fake = createFakeFetch({
    body: {
      protocol: 1,
      applied: 0,
      conflicts: [
        {
          index: 0,
          reason: 'version-mismatch',
          serverDocument: { _id: new ObjectId('507f1f77bcf86cd799439011'), at: new Date(0) },
          serverVersion: 9,
        },
      ],
    },
  });
  const sink = new HttpUpstreamSink({
    baseUrl: 'https://api.example.com',
    database: 'app',
    fetch: fake.fetchImpl,
  });

  const result = await sink.apply([upsertOp('507f1f77bcf86cd799439011', { baseVersion: 1 })]);

  // Outbound: a 24-hex id is sent as a real ObjectId, not the string it is stored as.
  const operations = fake.calls[0].body.operations as Array<Record<string, unknown>>;
  const command = operations[0].command as { updateOne: { filter: { _id: unknown } } };
  expect(command.updateOne.filter._id).toBeInstanceOf(ObjectId);

  // Inbound: the server document comes back with its Date intact, so the shadow keeps
  // real BSON rather than an ISO string.
  const serverDocument = result.conflicts?.[0].serverDocument as Record<string, unknown>;
  expect(serverDocument.at).toBeInstanceOf(Date);
  expect(serverDocument._id).toBeInstanceOf(ObjectId);
});

test('HttpSink - auth headers are resolved per request', async () => {
  const fake = createFakeFetch();
  let issued = 0;

  const sink = new HttpUpstreamSink({
    baseUrl: 'https://api.example.com',
    database: 'app',
    headers: { 'luna-environment': 'prod' },
    getAuthHeaders: () => ({ Authorization: `Bearer token-${(issued += 1)}` }),
    fetch: fake.fetchImpl,
  });

  await sink.apply([upsertOp('u1')]);
  await sink.apply([upsertOp('u2')]);

  expect(fake.calls[0].headers['luna-environment']).toBe('prod');
  // Resolved per request, so a short-lived token can be refreshed between batches.
  expect(fake.calls[0].headers.Authorization).toBe('Bearer token-1');
  expect(fake.calls[1].headers.Authorization).toBe('Bearer token-2');
});

test('HttpSink - a session cookie is captured and replayed', async () => {
  const fake = createFakeFetch({ setCookie: 'session=abc; Path=/' });
  const sink = new HttpUpstreamSink({
    baseUrl: 'https://api.example.com',
    database: 'app',
    fetch: fake.fetchImpl,
  });

  await sink.apply([upsertOp('u1')]);
  await sink.apply([upsertOp('u2')]);

  expect(fake.calls[0].headers.cookie).toBeUndefined();
  expect(fake.calls[1].headers.cookie).toBe('session=abc; Path=/');
});

test('HttpSink - a 5xx throws so the replicator retries', async () => {
  const fake = createFakeFetch({ status: 503, body: { error: 'upstream down' } });
  const sink = new HttpUpstreamSink({
    baseUrl: 'https://api.example.com',
    database: 'app',
    fetch: fake.fetchImpl,
  });

  await expect(sink.apply([upsertOp('u1')])).rejects.toThrow('503');
});

test('HttpSink - a network failure throws so the replicator retries', async () => {
  const fake = createFakeFetch({ throws: new Error('ECONNREFUSED') });
  const sink = new HttpUpstreamSink({
    baseUrl: 'https://api.example.com',
    database: 'app',
    fetch: fake.fetchImpl,
  });

  await expect(sink.apply([upsertOp('u1')])).rejects.toThrow('ECONNREFUSED');
});

test('HttpSink - a 4xx is dead-lettered rather than retried forever', async () => {
  const fake = createFakeFetch({ status: 400, body: { error: 'bad payload' } });
  const sink = new HttpUpstreamSink({
    baseUrl: 'https://api.example.com',
    database: 'app',
    fetch: fake.fetchImpl,
  });

  // Throwing would mean "transient" to the replicator, and a request the API refuses
  // will be refused identically on every retry.
  const result = await sink.apply([upsertOp('u1'), upsertOp('u2')]);
  expect(result.applied).toBe(0);
  expect(result.failures).toHaveLength(2);
  expect(result.failures?.[0]).toMatchObject({ index: 0, code: 400 });
});

test('HttpSink - 429 and 408 are retried, not dead-lettered', async () => {
  for (const status of [408, 429]) {
    const fake = createFakeFetch({ status, body: {} });
    const sink = new HttpUpstreamSink({
      baseUrl: 'https://api.example.com',
      database: 'app',
      fetch: fake.fetchImpl,
    });
    await expect(sink.apply([upsertOp('u1')])).rejects.toThrow(String(status));
  }
});

test('HttpSink - fetch reads documents back for conflict reconciliation', async () => {
  const fake = createFakeFetch({
    body: { protocol: 1, documents: [{ _id: 'u1', name: 'Alice', _v: 4 }] },
  });
  const sink = new HttpUpstreamSink({
    baseUrl: 'https://api.example.com',
    database: 'app',
    fetch: fake.fetchImpl,
  });

  const documents = await sink.fetch('users', ['u1']);

  expect(fake.calls[0].url).toBe('https://api.example.com/sync/app/_sync/fetch');
  expect(documents).toEqual([{ _id: 'u1', name: 'Alice', _v: 4 }]);
});

// ---------------------------------------------------------------------------- receiver

function createFakeMongo(
  options: {
    upstream?: Record<string, Record<string, unknown>>;
    result?: Record<string, number>;
  } = {}
) {
  const bulkCalls: Array<{ collection: string; operations: unknown[] }> = [];

  const client = {
    async connect() {},
    async close() {},
    db(name?: string) {
      return {
        collection: (collection: string) => ({
          bulkWrite: async (operations: unknown[]) => {
            bulkCalls.push({ collection: `${name ?? ''}.${collection}`, operations });
            return options.result ?? { matchedCount: operations.length, upsertedCount: 0 };
          },
          find: (filter: Record<string, unknown>) => ({
            toArray: async () =>
              (((filter._id as { $in?: unknown[] })?.$in ?? []) as unknown[])
                .map((id) => options.upstream?.[String(id)])
                .filter((doc): doc is Record<string, unknown> => Boolean(doc)),
          }),
        }),
      };
    },
  };

  return { client: client as never, bulkCalls };
}

function applyRequest(operations: unknown[]): Record<string, unknown> {
  return { protocol: 1, replicator: 'default', operations };
}

test('Receiver - applies a batch and reports what landed', async () => {
  const mongo = createFakeMongo({ result: { matchedCount: 1, upsertedCount: 0 } });
  const receiver = createSyncReceiver({ client: mongo.client, database: 'app' });

  const response = await receiver.apply(
    applyRequest([
      {
        collection: 'users',
        documentId: 'u1',
        type: 'upsert',
        baseVersion: 3,
        diff: { set: { age: 31 }, unset: [] },
      },
    ])
  );

  expect(response.status).toBe(200);
  expect(EJSON.parse(response.body)).toMatchObject({ applied: 1 });
  expect(mongo.bulkCalls[0].collection).toBe('app.users');
});

test('Receiver - rebuilds the command instead of trusting what the client sent', async () => {
  const mongo = createFakeMongo({ result: { matchedCount: 1 } });
  const receiver = createSyncReceiver({ client: mongo.client, database: 'app' });

  await receiver.apply(
    applyRequest([
      {
        collection: 'users',
        documentId: 'u1',
        type: 'upsert',
        baseVersion: 3,
        diff: { set: { age: 31 }, unset: [] },
        // A hostile client tries to smuggle in an unbounded update.
        command: { updateMany: { filter: {}, update: { $set: { admin: true } } } },
      },
    ])
  );

  const executed = mongo.bulkCalls[0].operations[0] as Record<string, unknown>;
  expect(executed).not.toHaveProperty('updateMany');
  expect(executed).toHaveProperty('updateOne');
  expect((executed.updateOne as { filter: Record<string, unknown> }).filter._v).toBe(3);
});

test('Receiver - trustClientCommands opts into passthrough', async () => {
  const mongo = createFakeMongo({ result: { matchedCount: 1 } });
  const receiver = createSyncReceiver({
    client: mongo.client,
    database: 'app',
    trustClientCommands: true,
  });

  const command = { updateOne: { filter: { _id: 'u1' }, update: { $set: { age: 9 } } } };
  await receiver.apply(
    applyRequest([
      {
        collection: 'users',
        documentId: 'u1',
        type: 'upsert',
        baseVersion: 3,
        diff: { set: { age: 9 }, unset: [] },
        command,
      },
    ])
  );

  // The client's command is executed verbatim, version bump and all — which is why this
  // is opt-in and off by default.
  expect(mongo.bulkCalls[0].operations[0]).toEqual(command);
});

test('Receiver - rejects collections outside the allow-list', async () => {
  const mongo = createFakeMongo();
  const receiver = createSyncReceiver({
    client: mongo.client,
    database: 'app',
    allowedCollections: ['users'],
  });

  const response = await receiver.apply(
    applyRequest([
      { collection: 'billing', documentId: 'x', type: 'upsert', document: { amount: 1 } },
    ])
  );

  expect(response.status).toBe(403);
  expect(mongo.bulkCalls).toHaveLength(0);
});

test('Receiver - verifyRequest can refuse a batch', async () => {
  const mongo = createFakeMongo();
  const seen: Array<{ collections: string[]; operationCount: number }> = [];
  const receiver = createSyncReceiver({
    client: mongo.client,
    database: 'app',
    verifyRequest: (context) => {
      seen.push({ collections: context.collections, operationCount: context.operationCount });
      return false;
    },
  });

  const response = await receiver.apply(
    applyRequest([{ collection: 'users', documentId: 'u1', type: 'upsert', document: { a: 1 } }])
  );

  expect(response.status).toBe(403);
  expect(seen[0]).toEqual({ collections: ['users'], operationCount: 1 });
  expect(mongo.bulkCalls).toHaveLength(0);
});

test('Receiver - rejects a malformed payload', async () => {
  const mongo = createFakeMongo();
  const receiver = createSyncReceiver({ client: mongo.client, database: 'app' });

  const missingType = await receiver.apply(
    applyRequest([{ collection: 'users', documentId: 'u1' }])
  );
  expect(missingType.status).toBe(400);

  const notAnArray = await receiver.apply({ protocol: 1, operations: 'nope' });
  expect(notAnArray.status).toBe(400);

  expect(mongo.bulkCalls).toHaveLength(0);
});

test('Receiver - rejects an unknown protocol version rather than guessing', async () => {
  const mongo = createFakeMongo();
  const receiver = createSyncReceiver({ client: mongo.client, database: 'app' });

  const response = await receiver.apply({ protocol: 99, operations: [] });

  // 426 tells the client to upgrade rather than to retry.
  expect(response.status).toBe(426);
});

test('Receiver - enforces a batch size limit', async () => {
  const mongo = createFakeMongo();
  const receiver = createSyncReceiver({ client: mongo.client, database: 'app', maxOperations: 2 });

  const response = await receiver.apply(
    applyRequest(
      Array.from({ length: 3 }, (_, i) => ({
        collection: 'users',
        documentId: `u${i}`,
        type: 'upsert',
        document: { i },
      }))
    )
  );

  expect(response.status).toBe(413);
  expect(mongo.bulkCalls).toHaveLength(0);
});

test('Receiver - an internal error does not leak detail to the client', async () => {
  const exploding = {
    db: () => ({
      collection: () => ({
        bulkWrite: async () => {
          throw new Error('mongodb://user:hunter2@internal-host/app is unreachable');
        },
        find: () => ({ toArray: async () => [] }),
      }),
    }),
  };
  const receiver = createSyncReceiver({ client: exploding as never, database: 'app' });

  const response = await receiver.apply(
    applyRequest([{ collection: 'users', documentId: 'u1', type: 'upsert', document: { a: 1 } }])
  );

  expect(response.status).toBe(500);
  expect(response.body).not.toContain('hunter2');
});

test('Receiver - fetch reads documents back', async () => {
  const mongo = createFakeMongo({ upstream: { u1: { _id: 'u1', name: 'Alice', _v: 2 } } });
  const receiver = createSyncReceiver({ client: mongo.client, database: 'app' });

  const response = await receiver.fetch({ protocol: 1, collection: 'users', documentIds: ['u1'] });

  expect(response.status).toBe(200);
  expect(EJSON.parse(response.body)).toMatchObject({
    documents: [{ _id: 'u1', name: 'Alice', _v: 2 }],
  });
});

// ------------------------------------------------------------------ protocol agreement

test('Protocol - client and receiver build identical commands', async () => {
  const cases: SyncOperation[] = [
    upsertOp('507f1f77bcf86cd799439011', { baseVersion: null }),
    upsertOp('u1', {
      baseVersion: 4,
      diff: { set: { 'profile.city': 'Bristol' }, unset: ['nick'] },
    }),
    {
      collection: 'users',
      sourceCollection: 'users',
      documentId: 'u2',
      type: 'delete',
      baseVersion: 9,
      outboxId: 1,
    },
  ];

  const mongo = createFakeMongo({ result: { matchedCount: 3, deletedCount: 3, upsertedCount: 3 } });
  const receiver = createSyncReceiver({ client: mongo.client, database: 'app' });
  const fake = createFakeFetch();
  const sink = new HttpUpstreamSink({
    baseUrl: 'https://api.example.com',
    database: 'app',
    fetch: fake.fetchImpl,
  });

  await sink.apply(cases);
  const sent = fake.calls[0].body.operations as Array<Record<string, unknown>>;

  await receiver.apply(fake.calls[0].body);
  const executed = mongo.bulkCalls.flatMap((call) => call.operations);

  // If these ever diverge, the two halves of the protocol are writing different things
  // for the same change — which shows up as data loss, not as a crash.
  for (const [index, operation] of cases.entries()) {
    const expected = buildWriteCommand(operation);
    expect(EJSON.stringify(sent[index].command)).toBe(EJSON.stringify(expected));
    expect(EJSON.stringify(executed[index])).toBe(EJSON.stringify(expected));
  }
});
