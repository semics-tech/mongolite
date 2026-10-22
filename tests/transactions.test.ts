/**
 * Multi-document transactions: `client.startSession()` / `session.withTransaction`.
 *
 * The same suite runs against every adapter that supports transactions:
 * better-sqlite3, node:sqlite (skipped on Node < 22.5) and sql.js (through a
 * small shim, since sql.js itself isn't a dependency). The Cloudflare adapter
 * must refuse with a clear error.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { SQLiteDB } from '../src/db.js';
import { BrowserSqliteAdapter, type SqlJsDatabase } from '../src/adapters/browser.js';
import { CloudflareDurableObjectAdapter } from '../src/adapters/cloudflare.js';
import type { SqlStorage } from '../src/adapters/cloudflare.js';
import { MongoLite as MongoLiteClient } from '../src/mongo-client.js';
import {
  MongoLiteCollection,
  MongoLiteTransactionError,
  type IDatabaseAdapter,
  type DocumentWithId,
} from '../src/index.js';

interface Item extends DocumentWithId {
  name: string;
  qty?: number;
}

/** Minimal sql.js `Database` look-alike backed by an in-memory better-sqlite3 database. */
function fakeSqlJs(): SqlJsDatabase {
  const db = new Database(':memory:');
  return {
    run(sql, params) {
      db.prepare(sql).run(...((params as unknown[]) ?? []));
      return this;
    },
    exec(sql) {
      db.exec(sql);
      return [];
    },
    prepare(sql) {
      let params: unknown[] = [];
      let rows: Record<string, unknown>[] | null = null;
      let i = 0;
      return {
        bind(p) {
          params = (p as unknown[]) ?? [];
          rows = null;
          i = 0;
          return true;
        },
        step() {
          rows ??= db.prepare(sql).all(...params) as Record<string, unknown>[];
          return i++ < rows.length;
        },
        getAsObject() {
          return rows![i - 1] as never;
        },
        free: () => true,
      };
    },
    close() {
      db.close();
    },
  };
}

type Backend = { name: string; make: () => IDatabaseAdapter; skip?: string | false };

const backends: Backend[] = [
  { name: 'better-sqlite3', make: () => new SQLiteDB(':memory:') },
  { name: 'sql.js', make: () => new BrowserSqliteAdapter(fakeSqlJs()) },
];

let nodeSqliteSkip: string | false = false;
try {
  const { NodeSqliteAdapter } = await import('../src/adapters/node-sqlite.js');
  backends.push({ name: 'node:sqlite', make: () => new NodeSqliteAdapter(':memory:') });
} catch {
  nodeSqliteSkip = 'requires node:sqlite (Node.js 22.5+)';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const names = async (c: { find: (f?: object) => { toArray: () => Promise<Item[]> } }) =>
  (await c.find({}).toArray()).map((d) => d.name).sort();

for (const backend of backends) {
  describe(`transactions (${backend.name})`, { skip: backend.skip }, () => {
    let client: MongoLiteClient;
    let items: MongoLiteCollection<Item>;

    beforeEach(async () => {
      client = new MongoLiteClient(backend.make(), { transactionLockTimeoutMs: 400 });
      await client.connect();
      items = client.collection<Item>('items');
      await items.ensureTable();
    });

    afterEach(async () => {
      await client.close();
    });

    it('commits all writes and returns the callback value', async () => {
      const session = client.startSession();
      const result = await session.withTransaction(async () => {
        await items.insertOne({ name: 'a', qty: 1 }, { session });
        await items.insertMany([{ name: 'b' }, { name: 'c' }], { session });
        await items.updateOne({ name: 'a' }, { $inc: { qty: 4 } }, { session });
        return 'done';
      });
      await session.endSession();

      assert.strictEqual(result, 'done');
      assert.deepStrictEqual(await names(items), ['a', 'b', 'c']);
      assert.strictEqual((await items.findOne({ name: 'a' }))?.qty, 5);
    });

    it('rolls back everything and rethrows the original error when the callback throws', async () => {
      await items.insertOne({ name: 'before' });
      const session = client.startSession();
      const boom = new Error('boom');
      await assert.rejects(
        session.withTransaction(async () => {
          await items.insertOne({ name: 'x' }, { session });
          await items.deleteOne({ name: 'before' }, { session });
          throw boom;
        }),
        (err) => err === boom
      );
      assert.strictEqual(session.inTransaction(), false);
      assert.deepStrictEqual(await names(items), ['before']);
      await session.endSession();
    });

    it('sees its own uncommitted writes inside the transaction', async () => {
      await client.withSession(async (session) => {
        await session.withTransaction(async () => {
          await items.insertOne({ name: 'mine', _id: 'm1' }, { session });
          assert.strictEqual(
            (await items.findOne({ _id: 'm1' }, undefined, { session }))?.name,
            'mine'
          );
          assert.strictEqual(await items.countDocuments({}, { session }), 1);
        });
      });
    });

    it('supports manual startTransaction / commitTransaction / abortTransaction', async () => {
      const session = client.startSession();
      session.startTransaction();
      assert.strictEqual(session.inTransaction(), true);
      await items.insertOne({ name: 'kept' }, { session });
      await session.commitTransaction();
      assert.strictEqual(session.inTransaction(), false);

      session.startTransaction();
      await items.insertOne({ name: 'dropped' }, { session });
      await session.abortTransaction();

      assert.deepStrictEqual(await names(items), ['kept']);
      await session.endSession();
    });

    it('rolls back insertMany inside a transaction (savepoint) and keeps earlier writes on commit', async () => {
      await client.withSession(async (session) => {
        await session.withTransaction(async () => {
          await items.insertOne({ name: 'one' }, { session });
          await items.insertMany([{ name: 'two' }, { name: 'three' }], { session });
        });
      });
      assert.deepStrictEqual(await names(items), ['one', 'three', 'two']);

      await client.withSession(async (session) => {
        await assert.rejects(
          session.withTransaction(async () => {
            await items.insertMany([{ name: 'four' }, { name: 'five' }], { session });
            throw new Error('nope');
          })
        );
      });
      assert.deepStrictEqual(await names(items), ['one', 'three', 'two']);
    });

    it('aborts the whole transaction when an operation fails (duplicate _id)', async () => {
      await items.insertOne({ _id: 'dup', name: 'orig' });
      const session = client.startSession();
      await assert.rejects(
        session.withTransaction(async () => {
          await items.insertOne({ name: 'first' }, { session });
          await items.insertOne({ _id: 'dup', name: 'again' }, { session });
        })
      );
      assert.strictEqual(session.inTransaction(), false);
      assert.deepStrictEqual(await names(items), ['orig']);
      await session.endSession();
    });

    it('rejects later operations on a session whose transaction an operation aborted', async () => {
      await items.insertOne({ _id: 'dup', name: 'orig' });
      const session = client.startSession();
      session.startTransaction();
      await assert.rejects(items.insertOne({ _id: 'dup', name: 'x' }, { session }));
      await assert.rejects(items.insertOne({ name: 'y' }, { session }), MongoLiteTransactionError);
      await session.endSession();
      assert.deepStrictEqual(await names(items), ['orig']);
    });

    describe('per-connection lock', () => {
      it('makes an un-sessioned write wait until the transaction commits', async () => {
        const session = client.startSession();
        const order: string[] = [];
        let outside!: Promise<unknown>;

        await session.withTransaction(async () => {
          await items.insertOne({ name: 'inside' }, { session });
          outside = items.insertOne({ name: 'outside' }).then(() => order.push('outside done'));
          await sleep(50);
          order.push('txn body ends');
        });
        order.push('committed');
        await outside;

        assert.deepStrictEqual(order, ['txn body ends', 'committed', 'outside done']);
        assert.deepStrictEqual(await names(items), ['inside', 'outside']);
        await session.endSession();
      });

      it('does not roll back an un-sessioned write when the transaction aborts', async () => {
        const session = client.startSession();
        let outside!: Promise<unknown>;
        await assert.rejects(
          session.withTransaction(async () => {
            await items.insertOne({ name: 'inside' }, { session });
            outside = items.insertOne({ name: 'outside' });
            await sleep(30);
            throw new Error('abort it');
          })
        );
        await outside;
        assert.deepStrictEqual(await names(items), ['outside']);
        await session.endSession();
      });

      it('lets an un-sessioned read wait instead of seeing uncommitted rows', async () => {
        const session = client.startSession();
        let seen = -1;
        let read!: Promise<unknown>;
        await session.withTransaction(async () => {
          await items.insertOne({ name: 'inside' }, { session });
          read = items.countDocuments({}).then((n) => (seen = n));
          await sleep(30);
          assert.strictEqual(seen, -1, 'read must still be waiting');
        });
        await read;
        assert.strictEqual(seen, 1, 'read runs after commit and sees the committed row');
        await session.endSession();
      });

      it('serialises two sessions: the second transaction starts after the first ends', async () => {
        const a = client.startSession();
        const b = client.startSession();
        const log: string[] = [];
        const first = a.withTransaction(async () => {
          log.push('a start');
          await items.insertOne({ name: 'a' }, { session: a });
          await sleep(60);
          log.push('a end');
        });
        await sleep(10);
        const second = b.withTransaction(async () => {
          // BEGIN is lazy: this first operation is what waits for a's lock.
          await items.insertOne({ name: 'b' }, { session: b });
          log.push('b first write');
        });
        await Promise.all([first, second]);
        assert.deepStrictEqual(log, ['a start', 'a end', 'b first write']);
        assert.deepStrictEqual(await names(items), ['a', 'b']);
        await a.endSession();
        await b.endSession();
      });

      it('fails loudly instead of hanging when a transaction is never finished', async () => {
        const session = client.startSession();
        session.startTransaction();
        await items.insertOne({ name: 'stuck' }, { session });
        await assert.rejects(
          items.insertOne({ name: 'waiting' }),
          (err: Error) => err instanceof MongoLiteTransactionError && /session/.test(err.message)
        );
        await session.endSession(); // abort frees the lock
        await items.insertOne({ name: 'after' });
        assert.deepStrictEqual(await names(items), ['after']);
      });
    });

    describe('misuse', () => {
      it('throws on double start, commit/abort with none, and use after endSession', async () => {
        const session = client.startSession();
        await assert.rejects(session.commitTransaction(), /No transaction started/);
        await assert.rejects(session.abortTransaction(), /No transaction started/);
        session.startTransaction();
        assert.throws(() => session.startTransaction(), /already in progress/);
        await session.abortTransaction();
        await assert.rejects(session.abortTransaction(), /twice/);
        await session.endSession();
        assert.throws(() => session.startTransaction(), /ended/);
        await assert.rejects(items.insertOne({ name: 'x' }, { session }), /ended/);
      });

      it('rejects nested withTransaction on the same session', async () => {
        const session = client.startSession();
        await assert.rejects(
          session.withTransaction(async () => {
            await session.withTransaction(async () => undefined);
          }),
          /already in progress/
        );
        await session.endSession();
      });

      it('rejects a session from another client', async () => {
        const other = new MongoLiteClient(backend.make());
        await other.connect();
        const foreign = other.startSession();
        await assert.rejects(
          items.insertOne({ name: 'x' }, { session: foreign }),
          /different client/
        );
        await other.close();
      });

      it('endSession aborts an open transaction and close() releases the lock', async () => {
        const s1 = client.startSession();
        s1.startTransaction();
        await items.insertOne({ name: 'gone' }, { session: s1 });
        await s1.endSession();
        assert.strictEqual(s1.hasEnded, true);

        const s2 = client.startSession();
        s2.startTransaction();
        await items.insertOne({ name: 'gone too' }, { session: s2 });
        // close() (in afterEach) must abort s2 rather than hang or commit
        assert.strictEqual(await items.countDocuments({}, { session: s2 }), 1);
      });

      it('ops with a session but no transaction behave like ordinary operations', async () => {
        const session = client.startSession();
        await items.insertOne({ name: 'plain' }, { session });
        assert.deepStrictEqual(await names(items), ['plain']);
        await session.endSession();
      });
    });
  });
}

describe('transactions (node:sqlite availability)', { skip: nodeSqliteSkip }, () => {
  it('is exercised above', () => {
    assert.ok(backends.some((b) => b.name === 'node:sqlite'));
  });
});

describe('transactions (Cloudflare adapter)', () => {
  it('throws a clear "not supported yet" error', async () => {
    const storage = { exec: () => ({}) } as unknown as SqlStorage;
    const client = new MongoLiteClient(new CloudflareDurableObjectAdapter(storage));
    assert.throws(
      () => client.startSession(),
      (err: Error) =>
        err instanceof MongoLiteTransactionError && /not supported yet/.test(err.message)
    );
    await assert.rejects(
      client.withSession(async () => 1),
      /not supported yet/
    );
  });
});
