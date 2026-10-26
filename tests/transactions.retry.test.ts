/**
 * Opt-in retry for `session.withTransaction` (experimental): `maxRetries`,
 * `retryDelayMs` and `TransactionBusyError`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteDB } from '../src/db.js';
import { MongoLite as MongoLiteClient } from '../src/mongo-client.js';
import {
  MongoLite,
  SyncOutbox,
  TransactionBusyError,
  type IDatabaseAdapter,
} from '../src/index.js';

interface Item {
  _id?: string;
  name: string;
}

/** Wraps an adapter and injects SQLITE_BUSY: on `BEGIN IMMEDIATE`, or on the next statement. */
class BusyAdapter implements IDatabaseAdapter {
  readonly supportsTransactions = true;
  readonly transactionGate: IDatabaseAdapter['transactionGate'];
  beginFailures = 0;
  beginCalls = 0;
  failNextStatement = false;
  constructor(
    readonly inner: SQLiteDB,
    private readonly style: 'better-sqlite3' | 'node:sqlite' | 'sql.js' = 'better-sqlite3'
  ) {
    this.transactionGate = inner.transactionGate;
  }
  private busy(): Error {
    if (this.style === 'node:sqlite') {
      return Object.assign(new Error('database is locked'), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 5,
      });
    }
    if (this.style === 'sql.js') return new Error('database is locked');
    return Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  }
  private check(sql?: string): void {
    if (sql?.trim().toUpperCase().startsWith('BEGIN IMMEDIATE')) {
      this.beginCalls++;
      if (this.beginFailures > 0) {
        this.beginFailures--;
        throw this.busy();
      }
      return;
    }
    if (this.failNextStatement && !/^\s*(ROLLBACK|COMMIT|SAVEPOINT|RELEASE)/i.test(sql ?? '')) {
      this.failNextStatement = false;
      throw this.busy();
    }
  }
  connect() {
    return this.inner.connect();
  }
  close() {
    return this.inner.close();
  }
  async run(sql: string, params?: unknown[]) {
    this.check(sql);
    return this.inner.run(sql, params);
  }
  async get<T>(sql: string, params?: unknown[]) {
    this.check(sql);
    return this.inner.get<T>(sql, params);
  }
  async all<T>(sql: string, params?: unknown[]) {
    this.check(sql);
    return this.inner.all<T>(sql, params);
  }
  async exec(sql: string) {
    this.check(sql);
    return this.inner.exec(sql);
  }
}

async function setup(style: 'better-sqlite3' | 'node:sqlite' | 'sql.js' = 'better-sqlite3') {
  const adapter = new BusyAdapter(new SQLiteDB(':memory:'), style);
  const client = new MongoLiteClient(adapter, { transactionLockTimeoutMs: 400 });
  await client.connect();
  const items = client.collection<Item>('items');
  await items.ensureTable();
  return { adapter, client, items, session: client.startSession() };
}

const FAST = { retryDelayMs: 1 };

describe('withTransaction retry (experimental)', () => {
  for (const style of ['better-sqlite3', 'node:sqlite', 'sql.js'] as const) {
    it(`succeeds on attempt 3 after two busy BEGINs (${style} error shape)`, async () => {
      const { adapter, client, items, session } = await setup(style);
      adapter.beginFailures = 2;
      let runs = 0;
      const result = await session.withTransaction(
        async () => {
          runs++;
          await items.insertOne({ name: 'a' }, { session });
          return 'ok';
        },
        { maxRetries: 2, ...FAST }
      );
      assert.strictEqual(result, 'ok');
      assert.strictEqual(runs, 3); // BEGIN is lazy, so the callback re-runs each attempt
      assert.strictEqual(adapter.beginCalls, 3);
      assert.strictEqual(await items.countDocuments({}), 1);
      await client.close();
    });
  }

  it('throws the last TransactionBusyError after maxRetries', async () => {
    const { adapter, client, items, session } = await setup();
    adapter.beginFailures = 10;
    await assert.rejects(
      session.withTransaction(
        async () => {
          await items.insertOne({ name: 'a' }, { session });
        },
        { maxRetries: 2, ...FAST }
      ),
      (err) => {
        assert.ok(err instanceof TransactionBusyError);
        assert.strictEqual(err.code, 'SQLITE_BUSY');
        assert.deepStrictEqual(err.errorLabels, ['TransientTransactionError']);
        assert.strictEqual(err.hasErrorLabel('TransientTransactionError'), true);
        assert.strictEqual(err.hasErrorLabel('Other'), false);
        return true;
      }
    );
    assert.strictEqual(adapter.beginCalls, 3);
    assert.strictEqual(session.inTransaction(), false);
    await client.close();
  });

  it('default (no maxRetries) makes one attempt and throws the labelled error', async () => {
    const { adapter, client, items, session } = await setup();
    adapter.beginFailures = 1;
    await assert.rejects(
      session.withTransaction(async () => {
        await items.insertOne({ name: 'a' }, { session });
      }),
      (err) => err instanceof TransactionBusyError && err.hasErrorLabel('TransientTransactionError')
    );
    assert.strictEqual(adapter.beginCalls, 1);
    await client.close();
  });

  it('startTransaction() is not retried and the error is labelled', async () => {
    const { adapter, client, items, session } = await setup();
    adapter.beginFailures = 1;
    session.startTransaction();
    await assert.rejects(
      items.insertOne({ name: 'a' }, { session }),
      (err) => err instanceof TransactionBusyError
    );
    assert.strictEqual(adapter.beginCalls, 1);
    await client.close();
  });

  it('never retries errors thrown by the callback', async () => {
    const { client, items, session } = await setup();
    let runs = 0;
    const boom = new Error('boom');
    await assert.rejects(
      session.withTransaction(
        async () => {
          runs++;
          await items.insertOne({ name: 'a' }, { session });
          throw boom;
        },
        { maxRetries: 5, ...FAST }
      ),
      (err) => err === boom
    );
    assert.strictEqual(runs, 1);
    assert.strictEqual(await items.countDocuments({}), 0);
    await client.close();
  });

  it('never retries a non-busy failure of a statement (duplicate _id)', async () => {
    const { client, items, session } = await setup();
    await items.insertOne({ _id: 'x', name: 'a' });
    let runs = 0;
    await assert.rejects(
      session.withTransaction(
        async () => {
          runs++;
          await items.insertOne({ _id: 'x', name: 'b' }, { session });
        },
        { maxRetries: 5, ...FAST }
      ),
      (err) => !(err instanceof TransactionBusyError)
    );
    assert.strictEqual(runs, 1);
    await client.close();
  });

  it('retries a busy statement mid-callback, rolling back the failed attempt', async () => {
    const { adapter, client, items, session } = await setup();
    let runs = 0;
    await session.withTransaction(
      async () => {
        runs++;
        await items.insertOne({ name: 'first' }, { session });
        if (runs === 1) adapter.failNextStatement = true;
        await items.insertOne({ name: 'second' }, { session });
      },
      { maxRetries: 3, ...FAST }
    );
    assert.strictEqual(runs, 2);
    const docs = await items.find({}).toArray();
    assert.deepStrictEqual(docs.map((d) => d.name).sort(), ['first', 'second']);
    await client.close();
  });

  it('leaves exactly one outbox row per document after a retry', async () => {
    const { adapter, client, items, session } = await setup();
    const outbox = new SyncOutbox(client.database);
    await outbox.ensureSchema();
    await outbox.ensureTriggers('items');
    let runs = 0;
    await session.withTransaction(
      async () => {
        runs++;
        await items.insertOne({ _id: 'd1', name: 'one' }, { session });
        if (runs === 1) adapter.failNextStatement = true;
        await items.insertOne({ _id: 'd2', name: 'two' }, { session });
      },
      { maxRetries: 3, ...FAST }
    );
    assert.strictEqual(runs, 2);
    const records = await outbox.readBatch(0, 100, null);
    assert.deepStrictEqual(records.map((r) => r.documentId).sort(), ['d1', 'd2']);
    await client.close();
  });

  it('validates the options', async () => {
    const { client, session } = await setup();
    for (const bad of [
      { maxRetries: 11 },
      { maxRetries: -1 },
      { maxRetries: 1.5 },
      { retryDelayMs: -5 },
    ]) {
      await assert.rejects(session.withTransaction(async () => {}, bad));
    }
    await client.close();
  });

  it('still accepts the existing transaction options', async () => {
    const { client, session } = await setup();
    await session.withTransaction(async () => {}, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });
    await client.close();
  });
});

/** Multi-process contention on a WAL file: sql.js has no file locking, so only the file adapters. */
describe('withTransaction retry across processes (WAL)', () => {
  async function run(maxRetries: number | undefined): Promise<{ ok: boolean; error?: unknown }> {
    const dir = mkdtempSync(join(tmpdir(), 'mongolite-retry-'));
    const dbPath = join(dir, 'retry.sqlite');
    const holder = spawn(
      process.execPath,
      ['--import', 'tsx', join(import.meta.dirname, 'helpers', 'txn-holder.ts'), dbPath, '700'],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    let out = '';
    let isReady = false;
    const exited = new Promise<void>((r) => holder.on('exit', () => r()));
    const ready = new Promise<void>((resolve, reject) => {
      holder.stdout.on('data', (d) => {
        out += d;
        if (out.includes('READY')) {
          isReady = true;
          resolve();
        }
      });
      holder.on('exit', (code) => {
        if (!isReady) reject(new Error(`holder exited early (${code})`));
      });
    });
    const client = new MongoLite({ filePath: dbPath, WAL: true, busyTimeout: 50 });
    try {
      await ready;
      await client.connect();
      const col = client.collection<Item>('items');
      const session = client.startSession();
      try {
        await session.withTransaction(
          async () => {
            await col.insertOne({ _id: 'from-b', name: 'B' }, { session });
          },
          maxRetries === undefined ? undefined : { maxRetries, retryDelayMs: 50 }
        );
        const ids = (await col.find({}).toArray()).map((d) => d._id).sort();
        assert.deepStrictEqual(ids, ['from-a', 'from-b']); // B waited for A's commit
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      } finally {
        await client.close();
        await exited; // A commits before the directory is removed
      }
    } finally {
      holder.kill();
      await exited.catch(() => undefined);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }

  it('B succeeds after A commits when maxRetries is set', async () => {
    const r = await run(10);
    assert.ok(r.ok, String(r.error));
  });

  it('B fails with a labelled TransactionBusyError without maxRetries', async () => {
    const r = await run(undefined);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error instanceof TransactionBusyError, String(r.error));
    assert.ok((r.error as TransactionBusyError).hasErrorLabel('TransientTransactionError'));
  });
});
