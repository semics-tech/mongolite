/**
 * Unit tests for the SQLiteDB wrapper helpers that the collection layer does
 * not exercise: raw instance access, prepare(), and the begin/commit/rollback
 * helpers. Skipped when the optional better-sqlite3 dependency is missing.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

let SQLiteDB: typeof import('../src/better-sqlite3.js').SQLiteDB;
let skipReason: string | false = false;

try {
  ({ SQLiteDB } = await import('../src/better-sqlite3.js'));
} catch {
  skipReason = 'requires the optional better-sqlite3 dependency to be installed';
}

describe('SQLiteDB wrapper helpers', { skip: skipReason }, () => {
  let db: InstanceType<typeof SQLiteDB>;

  beforeEach(async () => {
    db = new SQLiteDB(':memory:');
    await db.connect();
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  });

  afterEach(async () => {
    await db.close();
  });

  it('getDbInstance returns the raw open database', async () => {
    const raw = await db.getDbInstance();
    assert.strictEqual(raw.open, true);
  });

  it('prepare returns a reusable statement', async () => {
    const insert = await db.prepare('INSERT INTO t (v) VALUES (?)');
    insert.run('a');
    insert.run('b');
    const rows = await db.all<{ v: string }>('SELECT v FROM t ORDER BY id');
    assert.deepStrictEqual(
      rows.map((r) => r.v),
      ['a', 'b']
    );
  });

  it('commitTransaction persists changes made after beginTransaction', async () => {
    await db.beginTransaction();
    await db.run('INSERT INTO t (v) VALUES (?)', ['x']);
    await db.commitTransaction();
    const rows = await db.all('SELECT * FROM t');
    assert.strictEqual(rows.length, 1);
  });

  it('rollbackTransaction discards changes made after beginTransaction', async () => {
    await db.beginTransaction();
    await db.run('INSERT INTO t (v) VALUES (?)', ['x']);
    await db.rollbackTransaction();
    const rows = await db.all('SELECT * FROM t');
    assert.strictEqual(rows.length, 0);
  });

  it('helpers reconnect lazily after close', async () => {
    await db.close();
    const raw = await db.getDbInstance();
    assert.strictEqual(raw.open, true);
    const stmt = await db.prepare('SELECT 1 AS one');
    assert.deepStrictEqual(stmt.get(), { one: 1 });
  });
});
