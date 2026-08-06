/**
 * The durable change log ("outbox") that backs MongoDB replication.
 *
 * SQLite triggers append a row here inside the very same transaction as the
 * write that caused it, so a change is either committed locally *and* queued for
 * replication, or neither. Replicators then drain the log at their own pace and
 * record a checkpoint; nothing is dropped because the process crashed or the
 * upstream was unreachable.
 */
import type { IDatabaseAdapter } from '../db.js';
import type { SyncDeadLetter, SyncOperationType, SyncOutboxRecord } from './types.js';

export const OUTBOX_TABLE = '__mongolite_sync_outbox__';
export const STATE_TABLE = '__mongolite_sync_state__';
export const DEAD_LETTER_TABLE = '__mongolite_sync_deadletter__';

/** Prefix shared by every table and trigger this module creates. */
export const SYNC_OBJECT_PREFIX = '__mongolite_sync';

/** Quotes a SQL identifier, escaping any embedded double quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quotes a SQL string literal, escaping any embedded single quotes. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Millisecond epoch as a SQL expression — portable across SQLite builds. */
const NOW_MS_SQL = `CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)`;

function triggerName(collection: string, operation: SyncOperationType): string {
  return `${SYNC_OBJECT_PREFIX}_${operation}__${collection}`;
}

interface OutboxRow {
  id: number;
  collection_name: string;
  document_id: string;
  operation: SyncOperationType;
  full_document: string | null;
  captured_at: number;
}

/**
 * Owns the outbox tables, the capture triggers, and every replicator's
 * checkpoint. A single outbox serves any number of replicators: each keeps its
 * own checkpoint row, and rows are pruned only once *every* replicator has
 * passed them.
 */
export class SyncOutbox {
  private schemaReady: Promise<void> | null = null;
  private readonly installedTriggers = new Set<string>();

  constructor(private readonly db: IDatabaseAdapter) {}

  /** Creates the outbox, checkpoint and dead-letter tables. Idempotent. */
  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.createSchema().catch((err) => {
        // Let a later call retry rather than caching the failure forever.
        this.schemaReady = null;
        throw err;
      });
    }
    return this.schemaReady;
  }

  private async createSchema(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        full_document TEXT,
        captured_at INTEGER NOT NULL
      );
    `);
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS ${SYNC_OBJECT_PREFIX}_outbox_key
      ON ${OUTBOX_TABLE} (collection_name, document_id, id);
    `);
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
        name TEXT PRIMARY KEY,
        checkpoint INTEGER NOT NULL DEFAULT 0,
        backfilled TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${DEAD_LETTER_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        replicator TEXT NOT NULL,
        collection_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        full_document TEXT,
        error TEXT NOT NULL,
        failed_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Installs the insert/update/delete capture triggers for a collection.
   *
   * Triggers deliberately outlive the replicator that created them: changes made
   * while replication is stopped still need to be captured, or restarting would
   * silently skip them. Use {@link SyncOutbox.removeTriggers} to opt out.
   */
  async ensureTriggers(collection: string): Promise<void> {
    if (this.installedTriggers.has(collection)) return;
    await this.ensureSchema();

    const table = quoteIdent(collection);
    const literal = quoteLiteral(collection);

    const insert = (op: SyncOperationType, row: 'NEW' | 'OLD', doc: string): string => `
      CREATE TRIGGER IF NOT EXISTS ${quoteIdent(triggerName(collection, op))}
      AFTER ${op === 'insert' ? 'INSERT' : op === 'update' ? 'UPDATE' : 'DELETE'} ON ${table}
      FOR EACH ROW
      BEGIN
        INSERT INTO ${OUTBOX_TABLE}
          (collection_name, document_id, operation, full_document, captured_at)
        VALUES
          (${literal}, ${row}._id, ${quoteLiteral(op)}, ${doc}, ${NOW_MS_SQL});
      END;
    `;

    await this.db.exec(insert('insert', 'NEW', 'NEW.data'));
    await this.db.exec(insert('update', 'NEW', 'NEW.data'));
    await this.db.exec(insert('delete', 'OLD', 'NULL'));

    this.installedTriggers.add(collection);
  }

  /**
   * Removes the capture triggers for a collection. Changes to it stop being
   * recorded — existing queued rows are untouched.
   */
  async removeTriggers(collection: string): Promise<void> {
    for (const op of ['insert', 'update', 'delete'] as const) {
      await this.db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(triggerName(collection, op))}`);
    }
    this.installedTriggers.delete(collection);
  }

  /** Lists user collections, excluding MongoLite's own bookkeeping tables. */
  async listCollections(): Promise<string[]> {
    const rows = await this.db.all<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__mongolite%'
       ORDER BY name`
    );
    return rows.map((row) => row.name);
  }

  /**
   * Reconciles the in-memory "already installed" cache with what is actually in
   * the schema.
   *
   * Dropping a table drops its triggers with it, so a collection that was
   * dropped and recreated would otherwise be silently uncaptured — the cache
   * would insist its triggers were still there.
   */
  async refreshTriggerCache(): Promise<void> {
    const rows = await this.db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '${SYNC_OBJECT_PREFIX}\\_%' ESCAPE '\\'`
    );
    const present = new Set(rows.map((row) => row.name));

    for (const collection of [...this.installedTriggers]) {
      const complete = (['insert', 'update', 'delete'] as const).every((op) =>
        present.has(triggerName(collection, op))
      );
      if (!complete) this.installedTriggers.delete(collection);
    }
  }

  /** The newest outbox id, or 0 when the log is empty. */
  async currentSequence(): Promise<number> {
    const row = await this.db.get<{ seq: number | null }>(
      `SELECT MAX(id) AS seq FROM ${OUTBOX_TABLE}`
    );
    return row?.seq ?? 0;
  }

  /** Reads the persisted checkpoint for a replicator, creating its state row if absent. */
  async loadState(name: string): Promise<{ checkpoint: number; backfilled: string[] }> {
    await this.ensureSchema();
    const row = await this.db.get<{ checkpoint: number; backfilled: string }>(
      `SELECT checkpoint, backfilled FROM ${STATE_TABLE} WHERE name = ?`,
      [name]
    );

    if (row) {
      let backfilled: string[] = [];
      try {
        const parsed: unknown = JSON.parse(row.backfilled);
        if (Array.isArray(parsed))
          backfilled = parsed.filter((v): v is string => typeof v === 'string');
      } catch {
        // Corrupt bookkeeping should not wedge replication; treat as "nothing backfilled".
      }
      return { checkpoint: Number(row.checkpoint) || 0, backfilled };
    }

    // A brand new replicator starts from the current tail. Anything already in
    // the collections is handled by the backfill, not by replaying the log.
    const checkpoint = await this.currentSequence();
    await this.db.run(
      `INSERT INTO ${STATE_TABLE} (name, checkpoint, backfilled, updated_at)
       VALUES (?, ?, '[]', ${NOW_MS_SQL})`,
      [name, checkpoint]
    );
    return { checkpoint, backfilled: [] };
  }

  /**
   * Advances a replicator's checkpoint.
   *
   * This is the acknowledgement, and it is a single atomic statement: a crash
   * either leaves the old checkpoint (the batch is replayed, which is safe
   * because upstream writes are idempotent) or the new one.
   */
  async saveCheckpoint(name: string, checkpoint: number): Promise<void> {
    await this.db.run(
      `UPDATE ${STATE_TABLE} SET checkpoint = ?, updated_at = ${NOW_MS_SQL} WHERE name = ?`,
      [checkpoint, name]
    );
  }

  /** Records that a collection's existing contents have been backfilled. */
  async markBackfilled(name: string, collections: string[]): Promise<void> {
    await this.db.run(
      `UPDATE ${STATE_TABLE} SET backfilled = ?, updated_at = ${NOW_MS_SQL} WHERE name = ?`,
      [JSON.stringify(collections), name]
    );
  }

  /** Forgets a replicator, releasing the outbox rows its checkpoint was pinning. */
  async unregister(name: string): Promise<void> {
    await this.ensureSchema();
    await this.db.run(`DELETE FROM ${STATE_TABLE} WHERE name = ?`, [name]);
  }

  /** Reads the next batch of changes after `checkpoint`, oldest first. */
  async readBatch(
    checkpoint: number,
    limit: number,
    collections: string[] | null
  ): Promise<SyncOutboxRecord[]> {
    const params: unknown[] = [checkpoint];
    let filter = '';

    if (collections) {
      if (collections.length === 0) return [];
      filter = ` AND collection_name IN (${collections.map(() => '?').join(', ')})`;
      params.push(...collections);
    }
    params.push(limit);

    const rows = await this.db.all<OutboxRow>(
      `SELECT id, collection_name, document_id, operation, full_document, captured_at
       FROM ${OUTBOX_TABLE}
       WHERE id > ?${filter}
       ORDER BY id ASC
       LIMIT ?`,
      params
    );

    return rows.map((row) => ({
      id: Number(row.id),
      collection: row.collection_name,
      documentId: row.document_id,
      operation: row.operation,
      document: parseDocument(row.full_document, row.document_id),
      capturedAt: Number(row.captured_at),
    }));
  }

  /** Count of rows a replicator still has to apply. */
  async pendingCount(checkpoint: number, collections: string[] | null): Promise<number> {
    const params: unknown[] = [checkpoint];
    let filter = '';

    if (collections) {
      if (collections.length === 0) return 0;
      filter = ` AND collection_name IN (${collections.map(() => '?').join(', ')})`;
      params.push(...collections);
    }

    const row = await this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${OUTBOX_TABLE} WHERE id > ?${filter}`,
      params
    );
    return Number(row?.total ?? 0);
  }

  /**
   * Deletes rows every registered replicator has already applied.
   * @returns Number of rows removed.
   */
  async prune(): Promise<number> {
    const row = await this.db.get<{ floor: number | null }>(
      `SELECT MIN(checkpoint) AS floor FROM ${STATE_TABLE}`
    );
    const floor = row?.floor;
    if (floor === null || floor === undefined) return 0;

    const result = await this.db.run(`DELETE FROM ${OUTBOX_TABLE} WHERE id <= ?`, [floor]);
    return result.changes;
  }

  /**
   * Drops superseded revisions, keeping only the newest row per document.
   *
   * Safe because replication carries whole documents rather than deltas: the
   * newest row alone reproduces the same upstream state. Rows at or below the
   * slowest replicator's checkpoint are left to {@link SyncOutbox.prune}.
   *
   * @returns Number of rows removed.
   */
  async compact(): Promise<number> {
    const result = await this.db.run(
      `DELETE FROM ${OUTBOX_TABLE}
       WHERE id NOT IN (
         SELECT MAX(id) FROM ${OUTBOX_TABLE} GROUP BY collection_name, document_id
       )
       AND id > COALESCE((SELECT MIN(checkpoint) FROM ${STATE_TABLE}), 0)`
    );
    return result.changes;
  }

  /** Moves a permanently-rejected change out of the stream so it cannot stall replication. */
  async deadLetter(
    replicator: string,
    record: { collection: string; documentId: string; operation: string; document: unknown },
    error: string
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO ${DEAD_LETTER_TABLE}
         (replicator, collection_name, document_id, operation, full_document, error, failed_at)
       VALUES (?, ?, ?, ?, ?, ?, ${NOW_MS_SQL})`,
      [
        replicator,
        record.collection,
        record.documentId,
        record.operation,
        record.document === null || record.document === undefined
          ? null
          : JSON.stringify(record.document),
        error,
      ]
    );
  }

  /** Reads dead-lettered changes, newest first. */
  async listDeadLetters(replicator?: string, limit = 100): Promise<SyncDeadLetter[]> {
    await this.ensureSchema();
    const where = replicator ? 'WHERE replicator = ?' : '';
    const params: unknown[] = replicator ? [replicator, limit] : [limit];

    const rows = await this.db.all<{
      id: number;
      collection_name: string;
      document_id: string;
      operation: string;
      full_document: string | null;
      error: string;
      failed_at: number;
    }>(
      `SELECT id, collection_name, document_id, operation, full_document, error, failed_at
       FROM ${DEAD_LETTER_TABLE} ${where} ORDER BY id DESC LIMIT ?`,
      params
    );

    return rows.map((row) => ({
      id: Number(row.id),
      collection: row.collection_name,
      documentId: row.document_id,
      operation: row.operation,
      document: parseDocument(row.full_document, row.document_id),
      error: row.error,
      failedAt: Number(row.failed_at),
    }));
  }

  /** Removes dead-lettered rows, e.g. after replaying them by hand. */
  async clearDeadLetters(replicator?: string): Promise<number> {
    await this.ensureSchema();
    const result = replicator
      ? await this.db.run(`DELETE FROM ${DEAD_LETTER_TABLE} WHERE replicator = ?`, [replicator])
      : await this.db.run(`DELETE FROM ${DEAD_LETTER_TABLE}`);
    return result.changes;
  }

  /**
   * Streams a collection's current contents in `_id` order, for the initial
   * backfill. Keyset pagination keeps memory flat on large collections.
   */
  async *scanCollection(
    collection: string,
    chunkSize: number
  ): AsyncGenerator<Array<{ documentId: string; document: Record<string, unknown> | null }>> {
    // `null` on the first pass so an empty-string `_id` is not skipped.
    let after: string | null = null;

    for (;;) {
      const rows: Array<{ _id: string; data: string | null }> = await this.db.all(
        `SELECT _id, data FROM ${quoteIdent(collection)}
         ${after === null ? '' : 'WHERE _id > ?'}
         ORDER BY _id ASC LIMIT ?`,
        after === null ? [chunkSize] : [after, chunkSize]
      );
      if (rows.length === 0) return;

      yield rows.map((row) => ({
        documentId: row._id,
        document: parseDocument(row.data, row._id),
      }));

      after = rows[rows.length - 1]._id;
    }
  }
}

/**
 * Parses a stored document, re-attaching the `_id` that lives in its own column.
 * Returns `null` for deletes and for rows whose JSON is unreadable — the caller
 * dead-letters the latter rather than crashing the replicator.
 */
function parseDocument(json: string | null, documentId: string): Record<string, unknown> | null {
  if (json === null || json === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return { _id: documentId, ...(parsed as Record<string, unknown>) };
  } catch {
    return null;
  }
}
