/**
 * Parity for the basic transaction semantics: the same scenario runs through
 * `session.withTransaction` on real MongoDB (a single-node replica set, which
 * transactions require) and on MongoLite, and the committed end state, the
 * callback's return value and the error behaviour must match.
 *
 * Only the shared semantics are asserted (commit, abort/rollback on throw,
 * manual abort, own writes visible, failed write aborts the transaction).
 * Isolation differs by design: SQLite blocks other writers and readers on the
 * connection until commit, while MongoDB serves them the pre-transaction snapshot.
 */
import test, { after, before, describe } from 'node:test';
import { expect } from 'expect';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoLite } from '../../src/index.js';

type Doc = { _id: string; name: string; qty?: number };

/** What a scenario may do, implemented once per backend. */
interface Txn {
  insert(doc: Doc): Promise<void>;
  inc(id: string, by: number): Promise<void>;
  remove(id: string): Promise<void>;
  count(): Promise<number>;
}

interface Backend {
  name: string;
  seed(docs: Doc[]): Promise<void>;
  withTransaction<R>(fn: (t: Txn) => Promise<R>): Promise<R>;
  /** Manual form: start, run, then abort. */
  startAbort(fn: (t: Txn) => Promise<void>): Promise<void>;
  startCommit(fn: (t: Txn) => Promise<void>): Promise<void>;
  all(): Promise<Doc[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

let replSet: MongoMemoryReplSet;
const backends: Backend[] = [];

function mongoBackend(client: MongoClient): Backend {
  const coll = client.db('mongolite_parity_txn').collection<Doc>('items');
  const bind = (session: import('mongodb').ClientSession): Txn => ({
    insert: async (d) => void (await coll.insertOne({ ...d }, { session })),
    inc: async (id, by) =>
      void (await coll.updateOne({ _id: id }, { $inc: { qty: by } }, { session })),
    remove: async (id) => void (await coll.deleteOne({ _id: id }, { session })),
    count: () => coll.countDocuments({}, { session }),
  });
  return {
    name: 'mongodb',
    seed: async (docs) => void (await coll.insertMany(docs.map((d) => ({ ...d })))),
    async withTransaction(fn) {
      const session = client.startSession();
      try {
        let out!: Awaited<ReturnType<typeof fn>>;
        await session.withTransaction(async () => {
          out = await fn(bind(session));
        });
        return out;
      } finally {
        await session.endSession();
      }
    },
    async startAbort(fn) {
      const session = client.startSession();
      try {
        session.startTransaction();
        await fn(bind(session));
        await session.abortTransaction();
      } finally {
        await session.endSession();
      }
    },
    async startCommit(fn) {
      const session = client.startSession();
      try {
        session.startTransaction();
        await fn(bind(session));
        await session.commitTransaction();
      } finally {
        await session.endSession();
      }
    },
    all: async () => (await coll.find({}).sort({ _id: 1 }).toArray()) as Doc[],
    reset: async () => void (await coll.deleteMany({})),
    close: () => client.close(),
  };
}

function mongoliteBackend(client: MongoLite): Backend {
  const coll = client.collection<Doc>('items');
  const bind = (session: ReturnType<MongoLite['startSession']>): Txn => ({
    insert: async (d) => void (await coll.insertOne({ ...d }, { session })),
    inc: async (id, by) =>
      void (await coll.updateOne({ _id: id }, { $inc: { qty: by } }, { session })),
    remove: async (id) => void (await coll.deleteOne({ _id: id }, { session })),
    count: () => coll.countDocuments({}, { session }),
  });
  return {
    name: 'mongolite',
    seed: async (docs) => void (await coll.insertMany(docs.map((d) => ({ ...d })))),
    async withTransaction(fn) {
      const session = client.startSession();
      try {
        return await session.withTransaction(() => fn(bind(session)));
      } finally {
        await session.endSession();
      }
    },
    async startAbort(fn) {
      const session = client.startSession();
      try {
        session.startTransaction();
        await fn(bind(session));
        await session.abortTransaction();
      } finally {
        await session.endSession();
      }
    },
    async startCommit(fn) {
      const session = client.startSession();
      try {
        session.startTransaction();
        await fn(bind(session));
        await session.commitTransaction();
      } finally {
        await session.endSession();
      }
    },
    all: async () => (await coll.find({}).sort({ _id: 1 }).toArray()) as Doc[],
    reset: async () => void (await coll.deleteMany({})),
    close: () => client.close(),
  };
}

before(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: process.env.MONGOMS_VERSION ? { version: process.env.MONGOMS_VERSION } : undefined,
  });
  const mongo = new MongoClient(replSet.getUri());
  await mongo.connect();
  // Transactions on MongoDB < 4.4 need the collection to exist first; harmless otherwise.
  await mongo.db('mongolite_parity_txn').createCollection('items');
  const lite = new MongoLite(':memory:');
  await lite.connect();
  backends.push(mongoBackend(mongo), mongoliteBackend(lite));
});

after(async () => {
  for (const b of backends) await b.close();
  await replSet?.stop();
});

const strip = (docs: Doc[]) => docs.map(({ _id, name, qty }) => ({ _id, name, qty }));

describe('transactions parity (MongoDB vs MongoLite)', () => {
  const scenarios: [string, (b: Backend) => Promise<unknown>][] = [
    [
      'commit applies every write and returns the callback value',
      async (b) => {
        await b.seed([{ _id: 'a', name: 'a', qty: 1 }]);
        const result = await b.withTransaction(async (t) => {
          await t.insert({ _id: 'b', name: 'b' });
          await t.inc('a', 4);
          return 'ok';
        });
        return { result, docs: strip(await b.all()) };
      },
    ],
    [
      'a throwing callback rolls everything back and rethrows',
      async (b) => {
        await b.seed([{ _id: 'a', name: 'a', qty: 1 }]);
        let thrown: string | null = null;
        try {
          await b.withTransaction(async (t) => {
            await t.insert({ _id: 'b', name: 'b' });
            await t.remove('a');
            throw new Error('boom');
          });
        } catch (e) {
          thrown = (e as Error).message;
        }
        return { thrown, docs: strip(await b.all()) };
      },
    ],
    [
      'writes are visible to the transaction itself before commit',
      async (b) => {
        await b.seed([{ _id: 'a', name: 'a' }]);
        const countInside = await b.withTransaction(async (t) => {
          await t.insert({ _id: 'b', name: 'b' });
          return t.count();
        });
        return { countInside, docs: strip(await b.all()) };
      },
    ],
    [
      'manual abortTransaction discards the writes',
      async (b) => {
        await b.seed([{ _id: 'a', name: 'a', qty: 1 }]);
        await b.startAbort(async (t) => {
          await t.insert({ _id: 'b', name: 'b' });
          await t.inc('a', 10);
        });
        return strip(await b.all());
      },
    ],
    [
      'manual commitTransaction keeps the writes',
      async (b) => {
        await b.seed([{ _id: 'a', name: 'a', qty: 1 }]);
        await b.startCommit(async (t) => {
          await t.insert({ _id: 'b', name: 'b' });
          await t.inc('a', 10);
        });
        return strip(await b.all());
      },
    ],
    [
      'a failed write (duplicate _id) aborts the whole transaction',
      async (b) => {
        await b.seed([{ _id: 'a', name: 'a' }]);
        let failed = false;
        try {
          await b.withTransaction(async (t) => {
            await t.insert({ _id: 'b', name: 'b' });
            await t.insert({ _id: 'a', name: 'dup' });
          });
        } catch {
          failed = true;
        }
        return { failed, docs: strip(await b.all()) };
      },
    ],
  ];

  for (const [title, scenario] of scenarios) {
    test(title, async () => {
      const outcomes: unknown[] = [];
      for (const backend of backends) {
        await backend.reset();
        outcomes.push(JSON.parse(JSON.stringify(await scenario(backend))));
      }
      expect(outcomes[1]).toEqual(outcomes[0]); // mongolite equals mongodb
    });
  }
});
