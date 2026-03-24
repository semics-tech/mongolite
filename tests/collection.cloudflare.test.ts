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
    const stmt = this.db.prepare(query);
    const isSelect = query.trim().toUpperCase().startsWith('SELECT');

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
});
