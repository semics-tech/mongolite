/**
 * Coverage for opt-in connection sharing, the `busy_timeout` pragma, and the WAL
 * default.
 *
 * Consumers commonly end up with several clients pointing at one database file —
 * a module-level client, a background job, a request handler — each opening its
 * own connection and then hand-rolling an instance cache to avoid the resulting
 * lock contention. `shared: true` moves that dedup into the library.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MongoLite, DocumentWithId } from '../src/index';
import { sharedConnectionCount } from '../src/adapters/node-sqlite.js';

interface TestDoc extends DocumentWithId {
  name: string;
}

let tempDir: string;
let dbPath: string;

describe('connection sharing', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolite-share-'));
    dbPath = path.join(tempDir, 'shared.sqlite');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reuses one underlying connection for the same file', async () => {
    const before = sharedConnectionCount();

    const a = new MongoLite({ filePath: dbPath, shared: true });
    const b = new MongoLite({ filePath: dbPath, shared: true });
    await a.connect();
    await b.connect();

    assert.strictEqual(sharedConnectionCount(), before + 1, 'expected a single shared handle');

    await a.close();
    await b.close();
  });

  it('resolves equivalent paths to the same connection', async () => {
    const a = new MongoLite({ filePath: dbPath, shared: true });
    const b = new MongoLite({
      filePath: path.join(tempDir, '.', 'shared.sqlite'),
      shared: true,
    });
    const before = sharedConnectionCount();
    await a.connect();
    await b.connect();

    assert.strictEqual(sharedConnectionCount(), before + 1);

    await a.close();
    await b.close();
  });

  it('sees writes made through a sibling client immediately', async () => {
    const writer = new MongoLite({ filePath: dbPath, shared: true });
    const reader = new MongoLite({ filePath: dbPath, shared: true });
    await writer.connect();
    await reader.connect();

    await writer.collection<TestDoc>('docs').insertOne({ _id: '1', name: 'written' });
    const found = await reader.collection<TestDoc>('docs').findOne({ _id: '1' });

    assert.strictEqual(found?.name, 'written');

    await writer.close();
    await reader.close();
  });

  it('keeps the connection usable after a sibling closes', async () => {
    const a = new MongoLite({ filePath: dbPath, shared: true });
    const b = new MongoLite({ filePath: dbPath, shared: true });
    await a.connect();
    await b.connect();

    await a.collection<TestDoc>('docs').insertOne({ _id: '1', name: 'first' });

    // Without reference counting this would close the handle out from under b.
    await a.close();

    const stillWorks = await b.collection<TestDoc>('docs').findOne({ _id: '1' });
    assert.strictEqual(stillWorks?.name, 'first');

    await b.close();
  });

  it('releases the handle once the last holder closes', async () => {
    const before = sharedConnectionCount();

    const a = new MongoLite({ filePath: dbPath, shared: true });
    const b = new MongoLite({ filePath: dbPath, shared: true });
    await a.connect();
    await b.connect();

    await a.close();
    assert.strictEqual(sharedConnectionCount(), before + 1, 'still held by b');

    await b.close();
    assert.strictEqual(sharedConnectionCount(), before, 'fully released');
  });

  it('does not share unless asked', async () => {
    const before = sharedConnectionCount();

    const a = new MongoLite({ filePath: dbPath });
    const b = new MongoLite({ filePath: dbPath });
    await a.connect();
    await b.connect();

    assert.strictEqual(sharedConnectionCount(), before, 'sharing is opt-in');

    await a.close();
    await b.close();
  });

  it('never shares :memory: databases', async () => {
    const before = sharedConnectionCount();

    // Two :memory: opens are two unrelated databases; sharing them would merge
    // state that callers expect to be isolated.
    const a = new MongoLite({ filePath: ':memory:', shared: true });
    const b = new MongoLite({ filePath: ':memory:', shared: true });
    await a.connect();
    await b.connect();

    assert.strictEqual(sharedConnectionCount(), before);

    await a.collection<TestDoc>('docs').insertOne({ _id: '1', name: 'only-in-a' });
    assert.strictEqual(await b.collection<TestDoc>('docs').countDocuments({}), 0);

    await a.close();
    await b.close();
  });

  it('does not share across differing connection settings', async () => {
    const seed = new MongoLite({ filePath: dbPath });
    await seed.connect();
    await seed.collection<TestDoc>('docs').insertOne({ _id: '1', name: 'seed' });
    await seed.close();

    const before = sharedConnectionCount();
    const rw = new MongoLite({ filePath: dbPath, shared: true });
    const ro = new MongoLite({ filePath: dbPath, shared: true, readOnly: true });
    await rw.connect();
    await ro.connect();

    // readOnly changes how the handle behaves, so it must not be shared with a
    // read-write holder.
    assert.strictEqual(sharedConnectionCount(), before + 2);

    await rw.close();
    await ro.close();
  });
});

describe('connection pragmas', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolite-pragma-'));
    dbPath = path.join(tempDir, 'pragma.sqlite');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies a default busy_timeout', async () => {
    const client = new MongoLite({ filePath: dbPath });
    await client.connect();

    const row = await client.database.get<{ timeout: number }>('PRAGMA busy_timeout');
    assert.strictEqual(row?.timeout, 5000);

    await client.close();
  });

  it('honours an explicit busyTimeout', async () => {
    const client = new MongoLite({ filePath: dbPath, busyTimeout: 250 });
    await client.connect();

    const row = await client.database.get<{ timeout: number }>('PRAGMA busy_timeout');
    assert.strictEqual(row?.timeout, 250);

    await client.close();
  });

  it('enables WAL by default, including for the string constructor', async () => {
    // The string form previously left WAL off while the docs advertised it as a
    // default, so file-backed databases silently ran in rollback-journal mode.
    const client = new MongoLite(dbPath);
    await client.connect();

    const row = await client.database.get<{ journal_mode: string }>('PRAGMA journal_mode');
    assert.strictEqual(row?.journal_mode.toLowerCase(), 'wal');

    await client.close();
  });

  it('allows WAL to be turned off', async () => {
    // `WAL: false` was previously impossible to express: `options.WAL || true`
    // collapsed it back to true.
    const client = new MongoLite({ filePath: dbPath, WAL: false });
    await client.connect();

    const row = await client.database.get<{ journal_mode: string }>('PRAGMA journal_mode');
    assert.notStrictEqual(row?.journal_mode.toLowerCase(), 'wal');

    await client.close();
  });
});
