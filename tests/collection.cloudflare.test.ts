/**
 * Tests for the CloudflareDurableObjectAdapter.
 *
 * Because Cloudflare's `SqlStorage` runtime is only available inside Cloudflare Workers,
 * these tests use a lightweight `MockSqlStorage` that wraps an in-memory better-sqlite3
 * database and implements the same `SqlStorage` interface.  This lets us verify that the
 * adapter correctly bridges the MongoLite API to the Cloudflare SqlStorage contract
 * without needing to deploy to Cloudflare.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
  CloudflareDurableObjectAdapter,
  SqlStorage,
  SqlStorageCursor,
  SqlStorageValue,
} from '../src/adapters/cloudflare.js';
import { MongoLite, DocumentWithId, MongoLiteCollection } from '../src/index.js';

// ---------------------------------------------------------------------------
// MockSqlStorage — thin wrapper around better-sqlite3 that mimics the
// Cloudflare SqlStorage interface used by CloudflareDurableObjectAdapter.
// ---------------------------------------------------------------------------

class MockSqlStorageCursor<T> implements SqlStorageCursor<T> {
  private rows: T[];
  public readonly columnNames: readonly string[];
  public readonly rowsRead: number;
  public readonly rowsWritten: number;

  constructor(rows: T[], columnNames: string[], rowsRead: number, rowsWritten: number) {
    this.rows = rows;
    this.columnNames = columnNames;
    this.rowsRead = rowsRead;
    this.rowsWritten = rowsWritten;
  }

  toArray(): T[] {
    return this.rows;
  }

  one(): T {
    if (this.rows.length === 0) {
      throw new Error('No rows returned');
    }
    return this.rows[0];
  }
}

class MockSqlStorage implements SqlStorage {
  private db: Database.Database;

  constructor() {
    this.db = new Database(':memory:');
  }

  exec<T = Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlStorageCursor<T> {
    // Like Durable Object SqlStorage, refuse transaction-control statements.
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END)\b/i.test(query)) {
      throw new Error(
        'To execute a transaction, please use the state.storage.transactionSync() API'
      );
    }
    const stmt = this.db.prepare(query);
    const isSelect = /^\s*SELECT/i.test(query);

    if (isSelect) {
      const rows = stmt.all(...bindings) as T[];
      return new MockSqlStorageCursor<T>(
        rows,
        rows.length > 0 ? Object.keys(rows[0] as object) : [],
        rows.length,
        0
      );
    } else {
      const result = stmt.run(...bindings);
      return new MockSqlStorageCursor<T>([], [], 0, result.changes);
    }
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Test interfaces
// ---------------------------------------------------------------------------

interface UserDoc extends DocumentWithId {
  name: string;
  age: number;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('CloudflareDurableObjectAdapter', () => {
  let mockSql: MockSqlStorage;
  let adapter: CloudflareDurableObjectAdapter;
  let client: MongoLite;
  let users: MongoLiteCollection<UserDoc>;

  beforeEach(async () => {
    mockSql = new MockSqlStorage();
    adapter = new CloudflareDurableObjectAdapter(mockSql);
    client = new MongoLite(adapter);
    await client.connect(); // should be a no-op for the CF adapter
    users = client.collection<UserDoc>('users');
    await users.ensureTable();
  });

  afterEach(async () => {
    await client.close(); // should be a no-op for the CF adapter
    mockSql.close();
  });

  // -------------------------------------------------------------------------
  // Adapter lifecycle
  // -------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('connect() and close() are no-ops and do not throw', async () => {
      const a = new CloudflareDurableObjectAdapter(mockSql);
      await assert.doesNotReject(() => a.connect());
      await assert.doesNotReject(() => a.close());
    });
  });

  // -------------------------------------------------------------------------
  // Low-level adapter methods
  // -------------------------------------------------------------------------

  describe('low-level adapter methods', () => {
    it('exec() creates a table without throwing', async () => {
      await assert.doesNotReject(() =>
        adapter.exec(`CREATE TABLE IF NOT EXISTS test_table (_id TEXT PRIMARY KEY, data TEXT)`)
      );
    });

    it('run() inserts a row and returns rowsWritten', async () => {
      await adapter.exec(`CREATE TABLE IF NOT EXISTS raw_test (_id TEXT PRIMARY KEY, data TEXT)`);
      const result = await adapter.run(`INSERT INTO raw_test (_id, data) VALUES (?, ?)`, [
        'id1',
        '{"v":1}',
      ]);
      assert.strictEqual(result.changes, 1);
    });

    it('get() returns the first matching row', async () => {
      await adapter.exec(`CREATE TABLE IF NOT EXISTS raw_test2 (_id TEXT PRIMARY KEY, data TEXT)`);
      await adapter.run(`INSERT INTO raw_test2 (_id, data) VALUES (?, ?)`, ['a', '{"x":42}']);
      const row = await adapter.get<{ _id: string; data: string }>(
        `SELECT _id, data FROM raw_test2 WHERE _id = ?`,
        ['a']
      );
      assert.ok(row);
      assert.strictEqual(row._id, 'a');
    });

    it('get() returns undefined when no row matches', async () => {
      await adapter.exec(`CREATE TABLE IF NOT EXISTS raw_test3 (_id TEXT PRIMARY KEY, data TEXT)`);
      const row = await adapter.get(`SELECT * FROM raw_test3 WHERE _id = ?`, ['missing']);
      assert.strictEqual(row, undefined);
    });

    it('all() returns all matching rows', async () => {
      await adapter.exec(`CREATE TABLE IF NOT EXISTS raw_test4 (_id TEXT PRIMARY KEY, data TEXT)`);
      await adapter.run(`INSERT INTO raw_test4 VALUES (?, ?)`, ['r1', '{}']);
      await adapter.run(`INSERT INTO raw_test4 VALUES (?, ?)`, ['r2', '{}']);
      const rows = await adapter.all<{ _id: string }>(`SELECT _id FROM raw_test4`);
      assert.strictEqual(rows.length, 2);
    });

    it('exec() executes a single statement including multi-line DDL', async () => {
      await assert.doesNotReject(() =>
        adapter.exec(`CREATE TABLE IF NOT EXISTS t1 (_id TEXT PRIMARY KEY, data TEXT)`)
      );
    });

    it('exec() executes a CREATE TRIGGER statement with an internal semicolon', async () => {
      await adapter.exec(`CREATE TABLE IF NOT EXISTS t_src (_id TEXT PRIMARY KEY, data TEXT)`);
      await adapter.exec(`CREATE TABLE IF NOT EXISTS t_log (id INTEGER PRIMARY KEY, val TEXT)`);
      // This trigger body contains a semicolon inside BEGIN...END — the old splitting
      // logic would break it; the fixed implementation passes it through intact.
      await assert.doesNotReject(() =>
        adapter.exec(`
          CREATE TRIGGER t_src_insert
          AFTER INSERT ON t_src
          FOR EACH ROW
          BEGIN
            INSERT INTO t_log (val) VALUES (NEW._id);
          END
        `)
      );
    });
  });

  // -------------------------------------------------------------------------
  // MongoLite CRUD through the Cloudflare adapter
  // -------------------------------------------------------------------------

  describe('insertOne() / findOne()', () => {
    it('inserts a document and retrieves it by _id', async () => {
      const result = await users.insertOne({ _id: 'u1', name: 'Alice', age: 30 });
      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.insertedId, 'u1');

      const found = await users.findOne({ _id: 'u1' });
      assert.ok(found);
      assert.strictEqual(found.name, 'Alice');
      assert.strictEqual(found.age, 30);
    });

    it('auto-generates _id when not provided', async () => {
      const result = await users.insertOne({ name: 'Bob', age: 25 } as UserDoc);
      assert.ok(result.insertedId, 'Should have a generated _id');

      const found = await users.findOne({ _id: result.insertedId });
      assert.ok(found);
      assert.strictEqual(found.name, 'Bob');
    });

    it('findOne() returns null when no document matches', async () => {
      const found = await users.findOne({ name: 'Ghost' });
      assert.strictEqual(found, null);
    });
  });

  describe('insertMany() / find()', () => {
    it('inserts multiple documents and retrieves them all', async () => {
      const result = await users.insertMany([
        { _id: 'm1', name: 'Carol', age: 22 },
        { _id: 'm2', name: 'Dave', age: 35 },
        { _id: 'm3', name: 'Eve', age: 28 },
      ]);
      assert.strictEqual(result.acknowledged, true);
      assert.strictEqual(result.insertedCount, 3);

      const all = await users.find({}).toArray();
      assert.strictEqual(all.length, 3);
    });
  });

  describe('updateOne()', () => {
    it('updates a field on a matching document', async () => {
      await users.insertOne({ _id: 'upd1', name: 'Frank', age: 40 });
      const updateResult = await users.updateOne({ _id: 'upd1' }, { $set: { age: 41 } });
      assert.strictEqual(updateResult.modifiedCount, 1);

      const doc = await users.findOne({ _id: 'upd1' });
      assert.strictEqual(doc?.age, 41);
    });
  });

  describe('deleteOne()', () => {
    it('deletes a single matching document', async () => {
      await users.insertOne({ _id: 'del1', name: 'Grace', age: 27 });
      const deleteResult = await users.deleteOne({ _id: 'del1' });
      assert.strictEqual(deleteResult.deletedCount, 1);

      const found = await users.findOne({ _id: 'del1' });
      assert.strictEqual(found, null);
    });
  });

  describe('countDocuments()', () => {
    it('returns correct count after insertions', async () => {
      await users.insertMany([
        { _id: 'c1', name: 'Hank', age: 50 },
        { _id: 'c2', name: 'Ivy', age: 32 },
      ]);
      const count = await users.countDocuments({});
      assert.strictEqual(count, 2);
    });
  });

  describe('listCollections()', () => {
    it('lists collections created through the adapter', async () => {
      // The users table was created in beforeEach
      const collections = await client.listCollections().toArray();
      assert.ok(
        collections.includes('users'),
        `Expected 'users' in ${JSON.stringify(collections)}`
      );
    });
  });

  // -------------------------------------------------------------------------
  // MongoLite constructor — adapter path
  // -------------------------------------------------------------------------

  describe('MongoLite constructor with IDatabaseAdapter', () => {
    it('accepts an IDatabaseAdapter instance directly', async () => {
      const sql = new MockSqlStorage();
      const cfAdapter = new CloudflareDurableObjectAdapter(sql);
      const db = new MongoLite(cfAdapter);
      await db.connect();

      const col = db.collection<UserDoc>('cftest');
      await col.ensureTable();
      const r = await col.insertOne({ name: 'Test', age: 1 } as UserDoc);
      assert.ok(r.insertedId);

      await db.close();
      sql.close();
    });
  });

  // -------------------------------------------------------------------------
  // Change Streams — exercises the CREATE TRIGGER path through the adapter
  // -------------------------------------------------------------------------

  // ChangeStream.setupChangeTracking() is async but started fire-and-forget
  // from the constructor. Give it time to finish before making mutations.
  const TRIGGER_SETUP_WAIT_MS = 300;

  describe('watch() / Change Streams', () => {
    it('observes an insert event via collection.watch()', async () => {
      const stream = users.watch();

      await new Promise((resolve) => setTimeout(resolve, TRIGGER_SETUP_WAIT_MS));

      const eventPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          stream.close();
          reject(new Error('Timed out waiting for change stream event'));
        }, 5000);

        stream.on('change', (change) => {
          clearTimeout(timeout);
          try {
            assert.strictEqual(change.operationType, 'insert');
            assert.strictEqual(change.fullDocument?.name, 'WatchTest');
          } finally {
            stream.close();
          }
          resolve();
        });
      });

      await users.insertOne({ _id: 'ws1', name: 'WatchTest', age: 10 });

      await eventPromise;
    });

    it('observes an update event via collection.watch()', async () => {
      await users.insertOne({ _id: 'ws2', name: 'UpdateWatch', age: 20 });

      const stream = users.watch();

      await new Promise((resolve) => setTimeout(resolve, TRIGGER_SETUP_WAIT_MS));

      const eventPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          stream.close();
          reject(new Error('Timed out waiting for change stream update event'));
        }, 5000);

        stream.on('change', (change) => {
          clearTimeout(timeout);
          try {
            assert.strictEqual(change.operationType, 'update');
            assert.strictEqual(change.documentKey._id, 'ws2');
          } finally {
            stream.close();
          }
          resolve();
        });
      });

      await users.updateOne({ _id: 'ws2' }, { $set: { age: 21 } });

      await eventPromise;
    });
  });

  // -------------------------------------------------------------------------
  // Transactions (undo-log emulation)
  // -------------------------------------------------------------------------

  describe('transactions', () => {
    const names = async () => (await users.find({}).toArray()).map((u) => u.name).sort();

    it('commits on success and returns the callback value', async () => {
      const session = client.startSession();
      const out = await session.withTransaction(async () => {
        await users.insertOne({ name: 'A', age: 1 }, { session });
        await users.insertOne({ name: 'B', age: 2 }, { session });
        return 42;
      });
      assert.strictEqual(out, 42);
      assert.deepStrictEqual(await names(), ['A', 'B']);
      await session.endSession();
    });

    it('rolls back inserts, updates and deletes when the callback throws', async () => {
      await users.insertMany([
        { name: 'keep', age: 1 },
        { name: 'gone', age: 2 },
      ]);
      const session = client.startSession();
      await assert.rejects(
        session.withTransaction(async () => {
          await users.insertOne({ name: 'new', age: 3 }, { session });
          await users.updateOne({ name: 'keep' }, { $set: { age: 99 } }, { session });
          await users.deleteOne({ name: 'gone' }, { session });
          // read-your-writes inside the transaction
          assert.strictEqual(
            (await users.findOne({ name: 'new' }, undefined, { session }))?.age,
            3
          );
          throw new Error('boom');
        }),
        /boom/
      );
      assert.deepStrictEqual(await names(), ['gone', 'keep']);
      assert.strictEqual((await users.findOne({ name: 'keep' }))?.age, 1);
      await session.endSession();
    });

    it('aborts the whole transaction on a duplicate _id', async () => {
      await users.insertOne({ _id: 'x', name: 'x', age: 1 });
      const session = client.startSession();
      await assert.rejects(
        session.withTransaction(async () => {
          await users.insertOne({ name: 'before', age: 1 }, { session });
          await users.insertOne({ _id: 'x', name: 'dup', age: 1 }, { session });
        })
      );
      assert.deepStrictEqual(await names(), ['x']);
      await session.endSession();
    });

    it('insertMany inside a transaction rolls back with the transaction (savepoint)', async () => {
      const session = client.startSession();
      await assert.rejects(
        session.withTransaction(async () => {
          await users.insertMany(
            [
              { name: 'm1', age: 1 },
              { name: 'm2', age: 2 },
            ],
            { session }
          );
          throw new Error('nope');
        })
      );
      assert.deepStrictEqual(await names(), []);
      await session.endSession();
    });

    it('reports correct modifiedCount despite undo-trigger writes', async () => {
      await users.insertMany([
        { name: 'a', age: 1 },
        { name: 'b', age: 1 },
      ]);
      const session = client.startSession();
      await session.withTransaction(async () => {
        const r = await users.updateMany({ age: 1 }, { $set: { age: 2 } }, { session });
        assert.strictEqual(r.modifiedCount, 2);
      });
      await session.endSession();
    });

    it('operations without the session wait for the transaction, then see its result', async () => {
      const session = client.startSession();
      let outside: Promise<unknown> | undefined;
      await session.withTransaction(async () => {
        await users.insertOne({ name: 'in', age: 1 }, { session });
        outside = users.find({}).toArray();
      });
      assert.strictEqual(((await outside) as unknown[]).length, 1);
      await session.endSession();
    });

    it('leaves no triggers or undo rows behind after commit or rollback', async () => {
      const session = client.startSession();
      await session.withTransaction(async () => {
        await users.insertOne({ name: 'a', age: 1 }, { session });
      });
      await assert.rejects(
        session.withTransaction(async () => {
          await users.insertOne({ name: 'b', age: 1 }, { session });
          throw new Error('x');
        })
      );
      const trig = await adapter.all<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='trigger'`
      );
      assert.deepStrictEqual(trig, []);
      const undo = await adapter.all(`SELECT * FROM __mongolite_undo__`);
      assert.deepStrictEqual(undo, []);
      await session.endSession();
    });

    it('does not emit spurious change-stream rows when rolling back', async () => {
      const cs = users.watch();
      await new Promise((r) => setTimeout(r, 20));
      await cs.close();
      const countChanges = async () =>
        (await adapter.get<{ c: number }>(`SELECT COUNT(*) AS c FROM __mongolite_changes__`))!.c;
      const before = await countChanges();
      const session = client.startSession();
      await assert.rejects(
        session.withTransaction(async () => {
          await users.insertOne({ name: 'ghost', age: 1 }, { session });
          throw new Error('x');
        })
      );
      assert.strictEqual(await countChanges(), before);
      await session.endSession();
    });

    it('recovers a transaction left half-done by an eviction on connect()', async () => {
      await users.insertOne({ name: 'safe', age: 1 });
      const s = client.startSession();
      s.startTransaction();
      await users.insertOne({ name: 'orphan', age: 1 }, { session: s });
      await users.deleteOne({ name: 'safe' }, { session: s });
      // simulate eviction: a fresh adapter over the same storage, session never finished
      const fresh = new CloudflareDurableObjectAdapter(mockSql);
      await fresh.connect();
      const after = new MongoLite(fresh).collection<UserDoc>('users');
      assert.deepStrictEqual(
        (await after.find({}).toArray()).map((u) => u.name),
        ['safe']
      );
      assert.deepStrictEqual(
        await fresh.all(`SELECT name FROM sqlite_master WHERE type='trigger'`),
        []
      );
    });

    it('uses storage.transactionSync for commit, rollback and recovery when given', async () => {
      let calls = 0;
      const storage = {
        transactionSync<T>(fn: () => T): T {
          calls++;
          return fn();
        },
      };
      const a = new CloudflareDurableObjectAdapter(mockSql, storage);
      const c = new MongoLite(a);
      await c.connect();
      const col = c.collection<UserDoc>('tx2');
      await col.ensureTable();
      const s = c.startSession();
      await s.withTransaction(async () => {
        await col.insertOne({ name: 'z', age: 1 }, { session: s });
      });
      assert.ok(calls >= 3); // recovery, begin, commit
      await s.endSession();
    });

    it('supports raw SAVEPOINT / ROLLBACK TO / RELEASE through the adapter', async () => {
      await adapter.exec('BEGIN IMMEDIATE');
      await users.insertOne({ name: 'one', age: 1 });
      await adapter.exec('SAVEPOINT sp1');
      await users.insertOne({ name: 'two', age: 2 });
      await adapter.exec('ROLLBACK TO sp1');
      await adapter.exec('RELEASE sp1');
      await adapter.exec('COMMIT');
      assert.deepStrictEqual(await names(), ['one']);
    });

    it('rejects nested BEGIN and COMMIT without BEGIN', async () => {
      await assert.rejects(adapter.exec('COMMIT'), /no transaction is active/);
      await adapter.exec('BEGIN');
      await assert.rejects(adapter.exec('BEGIN'), /within a transaction/);
      await adapter.exec('ROLLBACK');
    });
  });
});
