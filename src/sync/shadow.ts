/**
 * The shadow store: the last-known **server** state of each replicated document.
 *
 * It exists because the local store cannot represent MongoDB's type system. Documents
 * are persisted as plain `JSON.stringify`, so a `Date` becomes an ISO string, an
 * `ObjectId` becomes hex, and `Binary`/`Decimal128` degrade to unusable structural
 * objects. Pushing a whole local document back would therefore rewrite the upstream
 * document in that degraded form.
 *
 * Keeping a verbatim copy of the server document solves three problems at once:
 *
 * 1. **Conflict base** — the `_v` a compare-and-swap asserts against.
 * 2. **Type preservation** — fields the application never touched locally are simply
 *    absent from the diff, so the upstream values survive intact.
 * 3. **Minimal writes** — pushes become `$set`/`$unset` of what actually changed,
 *    so a local edit stops clobbering fields other writers changed.
 *
 * Documents are stored as canonical Extended JSON. That encoding is safe **only**
 * because it lives here and never in a collection table: the query, sort and index
 * layer reads collection data with `json_extract` and assumes bare scalars, so
 * encoding values there would break range queries and indexes wholesale.
 */
import { EJSON } from 'bson';
import type { IDatabaseAdapter } from '../db.js';

export const SHADOW_TABLE = '__mongolite_sync_shadow__';

/**
 * Bookkeeping fields replication maintains on upstream documents. They are stripped
 * from the projection so they never reach local documents and never show up as a
 * spurious change to push back.
 */
const SYNC_FIELDS = new Set(['_v', '_updatedAt']);

/** Millisecond epoch as a SQL expression — portable across SQLite builds. */
const NOW_MS_SQL = `CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER)`;

/** The last-known server state of one document. */
export interface ShadowEntry {
  collection: string;
  documentId: string;
  /** Server `_v` when this was captured. `null` when the document predates versioning. */
  baseVersion: number | null;
  /** The server document with its BSON types intact. */
  serverDocument: Record<string, unknown>;
  /**
   * The same document flattened to the shape the local store would hold, minus
   * replication's bookkeeping fields — the side of the comparison a local document can
   * meaningfully be diffed against.
   */
  projection: Record<string, unknown>;
}

/**
 * Flattens a document to exactly the representation the local store would produce.
 *
 * This is deliberately the *same* lossy transform the collection tables apply
 * (`JSON.stringify`), rather than an approximation of it: a server `Date` projects to
 * the identical ISO string the local row holds, so the two compare equal and the field
 * stays out of the diff. Any drift between this and the storage encoding would show up
 * as phantom changes pushed on every sync.
 */
export function projectToLocalShape(document: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
}

/**
 * The projection a local document is compared against: the server document flattened
 * to local shape, with replication's own bookkeeping fields removed.
 */
export function projectForComparison(document: Record<string, unknown>): Record<string, unknown> {
  const projected = projectToLocalShape(document);
  for (const field of SYNC_FIELDS) delete projected[field];
  return projected;
}

export class SyncShadow {
  private schemaReady: Promise<void> | null = null;

  constructor(
    private readonly db: IDatabaseAdapter,
    private readonly replicator: string
  ) {}

  /** Creates the shadow table. Idempotent. */
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
      CREATE TABLE IF NOT EXISTS ${SHADOW_TABLE} (
        replicator      TEXT    NOT NULL,
        collection_name TEXT    NOT NULL,
        document_id     TEXT    NOT NULL,
        base_version    INTEGER,
        server_document TEXT,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (replicator, collection_name, document_id)
      );
    `);
  }

  /**
   * Loads the shadow entries for a set of documents in one collection.
   * Missing ids simply do not appear — those documents have never been upstream.
   */
  async load(collection: string, documentIds: string[]): Promise<Map<string, ShadowEntry>> {
    await this.ensureSchema();
    const found = new Map<string, ShadowEntry>();
    if (documentIds.length === 0) return found;

    // Chunked to stay well clear of SQLite's bound-parameter limit.
    const chunkSize = 400;

    for (let i = 0; i < documentIds.length; i += chunkSize) {
      const chunk = documentIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');

      const rows = await this.db.all<{
        document_id: string;
        base_version: number | null;
        server_document: string | null;
      }>(
        `SELECT document_id, base_version, server_document
         FROM ${SHADOW_TABLE}
         WHERE replicator = ? AND collection_name = ? AND document_id IN (${placeholders})`,
        [this.replicator, collection, ...chunk]
      );

      for (const row of rows) {
        const serverDocument = decodeServerDocument(row.server_document);
        if (!serverDocument) continue;

        found.set(row.document_id, {
          collection,
          documentId: row.document_id,
          baseVersion: row.base_version === null ? null : Number(row.base_version),
          serverDocument,
          projection: projectForComparison(serverDocument),
        });
      }
    }

    return found;
  }

  /** Records the server state of a document after a successful write or a re-read. */
  async put(
    collection: string,
    documentId: string,
    baseVersion: number | null,
    serverDocument: Record<string, unknown>
  ): Promise<void> {
    await this.ensureSchema();
    await this.db.run(
      `INSERT INTO ${SHADOW_TABLE}
         (replicator, collection_name, document_id, base_version, server_document, updated_at)
       VALUES (?, ?, ?, ?, ?, ${NOW_MS_SQL})
       ON CONFLICT (replicator, collection_name, document_id) DO UPDATE SET
         base_version = excluded.base_version,
         server_document = excluded.server_document,
         updated_at = excluded.updated_at`,
      [
        this.replicator,
        collection,
        documentId,
        baseVersion,
        EJSON.stringify(serverDocument, { relaxed: false }),
      ]
    );
  }

  /** Drops a document's shadow — it no longer exists upstream. */
  async remove(collection: string, documentId: string): Promise<void> {
    await this.ensureSchema();
    await this.db.run(
      `DELETE FROM ${SHADOW_TABLE}
       WHERE replicator = ? AND collection_name = ? AND document_id = ?`,
      [this.replicator, collection, documentId]
    );
  }

  /** Number of shadowed documents, for diagnostics. */
  async size(): Promise<number> {
    await this.ensureSchema();
    const row = await this.db.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM ${SHADOW_TABLE} WHERE replicator = ?`,
      [this.replicator]
    );
    return Number(row?.total ?? 0);
  }

  /** Forgets every shadow for this replicator, forcing the next push to re-seed. */
  async clear(): Promise<number> {
    await this.ensureSchema();
    const result = await this.db.run(`DELETE FROM ${SHADOW_TABLE} WHERE replicator = ?`, [
      this.replicator,
    ]);
    return result.changes;
  }
}

/**
 * Decodes a stored server document. Returns `null` if the row is unreadable, so a
 * corrupt shadow degrades to "never seen upstream" — the document is re-seeded rather
 * than crashing replication.
 */
function decodeServerDocument(encoded: string | null): Record<string, unknown> | null {
  if (encoded === null || encoded === undefined) return null;
  try {
    const parsed: unknown = EJSON.parse(encoded, { relaxed: false });
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
