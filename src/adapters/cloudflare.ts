import { IDatabaseAdapter } from '../db.js';

/**
 * Allowed scalar binding values accepted by Cloudflare's SqlStorage.exec().
 */
export type SqlStorageValue = string | number | boolean | null | ArrayBuffer;

/**
 * Minimal interface for the cursor returned by SqlStorage.exec().
 * This matches the Cloudflare Durable Objects SqlStorage API.
 */
export interface SqlStorageCursor<T = Record<string, SqlStorageValue>> {
  toArray(): T[];
  one(): T;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly columnNames: readonly string[];
}

/**
 * Minimal interface for the Cloudflare Durable Objects SqlStorage API.
 * Pass `ctx.storage.sql` from your Durable Object to the adapter constructor.
 *
 * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
 */
export interface SqlStorage {
  exec<T = Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlStorageCursor<T>;
}

/**
 * The one method of the Durable Object `ctx.storage` API the adapter can use.
 * Pass `ctx.storage` as the second constructor argument to make transaction
 * commit, rollback and crash recovery run inside `transactionSync`.
 */
export interface DurableObjectStorageLike {
  transactionSync<T>(closure: () => T): T;
}

const UNDO_TABLE = '__mongolite_undo__';
const UNDO_TRIGGER_PREFIX = '__mongolite_undo_';

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteLit = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Database adapter that wraps the Cloudflare Durable Objects `SqlStorage` API,
 * allowing MongoLite to be used inside a Cloudflare Durable Object.
 *
 * ## Usage
 *
 * ```ts
 * import { DurableObject } from 'cloudflare:workers';
 * import { MongoLite, CloudflareDurableObjectAdapter } from '@semics-tech/mongolite/cloudflare';
 *
 * export class MyDurableObject extends DurableObject {
 *   private client: MongoLite;
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     const adapter = new CloudflareDurableObjectAdapter(ctx.storage.sql);
 *     this.client = new MongoLite(adapter);
 *   }
 *
 *   async fetch(request: Request) {
 *     await this.client.connect();
 *     const users = this.client.collection('users');
 *     await users.insertOne({ name: 'Alice', age: 30 });
 *     const user = await users.findOne({ name: 'Alice' });
 *     return Response.json(user);
 *   }
 * }
 * ```
 *
 * ## Limitations
 *
 * - **`$regex` queries are not supported.** Cloudflare's SQLite does not allow custom
 *   SQL functions, so the `regexp()` UDF registered by the default Node.js adapter is
 *   unavailable. Queries using `$regex` will throw a SQL error at runtime.
 * - `WAL` mode and most `PRAGMA` statements are not available in Cloudflare Durable
 *   Objects (Cloudflare manages this internally).
 * - **Transactions** (`client.startSession()` / `session.withTransaction()`) are emulated,
 *   see "Transactions" below.
 * - Change Streams (`collection.watch()`) use SQL triggers and a change-log table.
 *   They work in Cloudflare Durable Objects, but the polling mechanism relies on
 *   `setInterval`, which is supported in the Workers runtime.
 */
export class CloudflareDurableObjectAdapter implements IDatabaseAdapter {
  /** Transactions are emulated with an undo log; see the class docs. */
  readonly supportsTransactions = true;
  private readonly sql: SqlStorage;
  private readonly storage?: DurableObjectStorageLike;
  private txActive = false;
  private savepoints: { name: string; seq: number }[] = [];
  private recovered = false;

  /**
   * @param sql The `SqlStorage` instance from a Cloudflare Durable Object context
   *            (i.e. `ctx.storage.sql`).
   * @param storage Optional `ctx.storage`. When given, transaction commit, rollback and
   *            crash recovery run inside `storage.transactionSync()`.
   */
  constructor(sql: SqlStorage, storage?: DurableObjectStorageLike) {
    this.sql = sql;
    this.storage = storage;
  }

  /**
   * Rolls back a transaction left half-done by a previous eviction or crash, if any.
   * Otherwise a no-op: Durable Objects manage the storage lifecycle automatically.
   */
  async connect(): Promise<void> {
    if (this.recovered) return;
    this.recovered = true;
    this.atomically(() => this.recover());
  }

  /**
   * No-op: Cloudflare Durable Objects manage the storage lifecycle automatically.
   */
  async close(): Promise<void> {
    // Nothing to do — storage is managed by the Durable Object runtime.
  }

  /**
   * Executes a SQL statement that does not return rows (INSERT, UPDATE, DELETE, DDL).
   */
  async run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
    const cursor = this.sql.exec(sql, ...(params as SqlStorageValue[]));
    let changes = cursor.rowsWritten;
    if (this.txActive) {
      // Undo triggers write extra rows, which inflate rowsWritten; changes() ignores trigger writes.
      try {
        changes = Number(this.sql.exec<{ c: number }>('SELECT changes() AS c').toArray()[0]?.c);
      } catch {
        changes = cursor.rowsWritten;
      }
    }
    return { lastID: 0, changes };
  }

  /**
   * Executes a SQL query and returns the first matching row, or `undefined`.
   */
  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = this.sql.exec<T>(sql, ...(params as SqlStorageValue[])).toArray();
    return rows[0];
  }

  /**
   * Executes a SQL query and returns all matching rows.
   */
  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.sql.exec<T>(sql, ...(params as SqlStorageValue[])).toArray();
  }

  /**
   * Executes a single SQL statement (DDL, transactions, etc.).
   *
   * Cloudflare's `SqlStorage.exec` only supports one statement at a time, and
   * some valid statements (e.g. `CREATE TRIGGER ... BEGIN ...; ...; END;`)
   * contain internal semicolons. Callers must therefore pass exactly one
   * statement per call; this method will not attempt to split multi-statement
   * SQL strings.
   */
  async exec(sql: string): Promise<void> {
    if (await this.handleTransactionStatement(sql)) return;
    this.sql.exec(sql);
    if (this.txActive && /^\s*CREATE\s+TABLE\b/i.test(sql)) this.installUndoTriggers();
  }

  // ---------------------------------------------------------------------------
  // Transaction emulation
  //
  // Durable Object SQL rejects raw BEGIN/SAVEPOINT, and `transactionSync` takes only a
  // synchronous callback, so it cannot hold a transaction open across `await`s the way
  // MongoDB's `withTransaction(async ...)` needs. Instead, `BEGIN` installs AFTER
  // INSERT/UPDATE/DELETE triggers on every table; each trigger appends the SQL that
  // reverses its change to an undo table. COMMIT drops the log, ROLLBACK replays it
  // backwards. Writes are visible to everyone as they happen, which is safe because
  // the client's transaction gate holds all other statements back until the end.
  // ---------------------------------------------------------------------------

  private atomically<T>(fn: () => T): T {
    return this.storage ? this.storage.transactionSync(fn) : fn();
  }

  private rows<T>(query: string, ...b: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(query, ...b).toArray();
  }

  /** Handles BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE; returns false for ordinary SQL. */
  private async handleTransactionStatement(sql: string): Promise<boolean> {
    const text = sql.trim().replace(/;+\s*$/, '');
    if (/^BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?$/i.test(text)) {
      if (this.txActive) throw new Error('cannot start a transaction within a transaction');
      await this.connect();
      this.atomically(() => {
        this.sql.exec(
          `CREATE TABLE IF NOT EXISTS ${UNDO_TABLE} (seq INTEGER PRIMARY KEY AUTOINCREMENT, undo_sql TEXT NOT NULL)`
        );
        this.installUndoTriggers();
      });
      this.txActive = true;
      this.savepoints = [];
      return true;
    }
    if (/^(COMMIT|END)(\s+TRANSACTION)?$/i.test(text)) {
      if (!this.txActive) throw new Error('cannot commit - no transaction is active');
      this.atomically(() => this.endTransaction(false));
      return true;
    }
    if (/^ROLLBACK(\s+TRANSACTION)?$/i.test(text)) {
      if (!this.txActive) throw new Error('cannot rollback - no transaction is active');
      this.atomically(() => this.endTransaction(true));
      return true;
    }
    let m = /^SAVEPOINT\s+("?)([\w$]+)\1$/i.exec(text);
    if (m) {
      if (!this.txActive) throw new Error('SAVEPOINT outside a transaction is not supported');
      this.savepoints.push({ name: m[2], seq: this.currentSeq() });
      return true;
    }
    m = /^RELEASE(\s+SAVEPOINT)?\s+("?)([\w$]+)\2$/i.exec(text);
    if (m) {
      const i = this.findSavepoint(m[3]);
      this.savepoints.length = i; // releasing drops it and everything opened after it
      return true;
    }
    m = /^ROLLBACK\s+(TRANSACTION\s+)?TO(\s+SAVEPOINT)?\s+("?)([\w$]+)\3$/i.exec(text);
    if (m) {
      const i = this.findSavepoint(m[4]);
      const { seq } = this.savepoints[i];
      this.atomically(() => this.undoTo(seq));
      this.savepoints.length = i + 1; // the named savepoint stays open, as in SQLite
      return true;
    }
    return false;
  }

  private findSavepoint(name: string): number {
    for (let i = this.savepoints.length - 1; i >= 0; i--) {
      if (this.savepoints[i].name.toLowerCase() === name.toLowerCase()) return i;
    }
    throw new Error(`no such savepoint: ${name}`);
  }

  private currentSeq(): number {
    return Number(
      this.rows<{ s: number }>(`SELECT COALESCE(MAX(seq), 0) AS s FROM ${UNDO_TABLE}`)[0]?.s ?? 0
    );
  }

  /** Replays the undo log backwards down to (not including) `seq`, then trims it. */
  private undoTo(seq: number): void {
    const entries = this.rows<{ undo_sql: string }>(
      `SELECT undo_sql FROM ${UNDO_TABLE} WHERE seq > ? ORDER BY seq DESC`,
      seq
    );
    // Replaying undo statements must not fire the app's own triggers (change streams, the sync
    // outbox), or the rollback would emit new events. Park them and restore them afterwards.
    const parked = this.rows<{ name: string; sql: string }>(
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL`
    ).filter((t) => !t.name.startsWith(UNDO_TRIGGER_PREFIX));
    for (const t of parked) this.sql.exec(`DROP TRIGGER ${quoteIdent(t.name)}`);
    for (const e of entries) this.sql.exec(e.undo_sql);
    for (const t of parked) this.sql.exec(t.sql);
    this.sql.exec(`DELETE FROM ${UNDO_TABLE} WHERE seq > ?`, seq);
  }

  private endTransaction(rollback: boolean): void {
    // Drop the triggers first so replayed undo statements are not logged again.
    this.dropUndoTriggers();
    if (rollback) this.undoTo(0);
    this.sql.exec(`DELETE FROM ${UNDO_TABLE}`);
    this.txActive = false;
    this.savepoints = [];
  }

  private dropUndoTriggers(): void {
    const triggers = this.rows<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'trigger'`
    );
    for (const t of triggers) {
      if (t.name.startsWith(UNDO_TRIGGER_PREFIX)) {
        this.sql.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(t.name)}`);
      }
    }
  }

  /** Finishes a transaction that never reached COMMIT/ROLLBACK (eviction, crash). */
  private recover(): void {
    const hasUndo = this.rows(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
      UNDO_TABLE
    );
    this.dropUndoTriggers();
    if (hasUndo.length > 0) {
      this.undoTo(0);
      this.sql.exec(`DELETE FROM ${UNDO_TABLE}`);
    }
  }

  /** Adds undo triggers to every user table that lacks them. */
  private installUndoTriggers(): void {
    const tables = this.rows<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`
    ).map((t) => t.name);
    const existing = new Set(
      this.rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).map(
        (t) => t.name
      )
    );
    for (const table of tables) {
      if (table === UNDO_TABLE || table.startsWith('_cf_') /* Cloudflare internal */) continue;
      const cols = this.rows<{ name: string }>(
        `SELECT name FROM pragma_table_info(${quoteLit(table)})`
      ).map((c) => c.name);
      if (cols.length === 0) continue;
      const t = quoteIdent(table);
      const colList = cols.map(quoteIdent).join(', ');
      // SQL text that, when run later, reverses the change; built with quote() at trigger time.
      const q = (ref: string) =>
        cols.map((c) => `quote(${ref}.${quoteIdent(c)})`).join(` || ',' || `);
      const sets = (ref: string) =>
        cols
          .map((c) => `${quoteLit(quoteIdent(c) + ' = ')} || quote(${ref}.${quoteIdent(c)})`)
          .join(` || ', ' || `);
      const defs: [string, string, string][] = [
        ['i', 'INSERT', `${quoteLit(`DELETE FROM ${t} WHERE rowid = `)} || NEW.rowid`],
        [
          'u',
          'UPDATE',
          `${quoteLit(`UPDATE ${t} SET `)} || ${sets('OLD')} || ${quoteLit(' WHERE rowid = ')} || NEW.rowid`,
        ],
        [
          'd',
          'DELETE',
          `${quoteLit(`INSERT INTO ${t} (rowid, ${colList}) VALUES (`)} || OLD.rowid || ',' || ${q('OLD')} || ')'`,
        ],
      ];
      for (const [suffix, event, expr] of defs) {
        const name = `${UNDO_TRIGGER_PREFIX}${table}_${suffix}`;
        if (existing.has(name)) continue;
        this.sql.exec(
          `CREATE TRIGGER ${quoteIdent(name)} AFTER ${event} ON ${t} FOR EACH ROW ` +
            `BEGIN INSERT INTO ${UNDO_TABLE} (undo_sql) VALUES (${expr}); END`
        );
      }
    }
  }
}
