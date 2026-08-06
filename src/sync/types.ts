/**
 * Public types for one-way replication from a local MongoLite database to an
 * upstream MongoDB deployment.
 *
 * The design is a **transactional outbox**: SQLite triggers record every row
 * change into a durable log inside the same database (and the same transaction)
 * as the write itself, and a background replicator drains that log into the
 * upstream. Nothing is lost if the process dies or the network is down — the log
 * simply grows until it can be drained.
 */
import type { DocumentDiff } from './diff.js';

export type { DocumentDiff };

/** The kind of change captured for a document. */
export type SyncOperationType = 'insert' | 'update' | 'delete';

/**
 * A single change waiting to be replicated, as stored in the outbox.
 */
export interface SyncOutboxRecord {
  /** Monotonic outbox sequence number. Doubles as the replication checkpoint. */
  id: number;
  /** Local collection the change happened in. */
  collection: string;
  /** `_id` of the affected document. */
  documentId: string;
  operation: SyncOperationType;
  /**
   * Document state after the change, including `_id`. `null` for deletes.
   * Undefined only if the stored JSON was unparseable (such rows are dead-lettered).
   */
  document: Record<string, unknown> | null;
  /** Millisecond epoch when the change was captured locally. */
  capturedAt: number;
}

/**
 * A change coalesced into the single upstream operation that realises it.
 *
 * Replication is full-document last-write-wins, so a run of changes to one
 * document collapses to whatever its final state was: an upsert of the latest
 * document, or a delete.
 */
export interface SyncOperation {
  /** Upstream collection name (after any `collectionMap` renaming). */
  collection: string;
  /** Local collection the change originated in. */
  sourceCollection: string;
  documentId: string;
  type: 'upsert' | 'delete';
  /** Full document to write upstream. Always present for `upsert`. */
  document?: Record<string, unknown>;
  /** Outbox id this operation was derived from — the newest row for the document. */
  outboxId: number;

  /**
   * The upstream `_v` this operation asserts against — the version last seen for this
   * document. `null` means the document has never been upstream, so the write must
   * create it rather than replace a known revision.
   *
   * A sink turns this into a conditional write; that is what makes a lost race
   * detectable instead of silently overwriting a concurrent edit.
   */
  baseVersion?: number | null;

  /**
   * The minimal change to apply upstream, relative to the last-known server state.
   *
   * Present for `upsert` whenever a shadow exists. Applying this rather than
   * {@link SyncOperation.document} leaves untouched fields — including BSON values the
   * local store cannot represent — exactly as they are upstream.
   */
  diff?: DocumentDiff;
}

/** Outcome of applying one batch of operations to the upstream. */
export interface SyncApplyResult {
  /** Number of operations the upstream accepted. */
  applied: number;
  /**
   * Operations the upstream rejected permanently (schema validation, document
   * too large, …). These are dead-lettered rather than retried forever.
   * Indexes refer to positions in the `operations` array passed to `apply`.
   */
  failures?: SyncApplyFailure[];
  /**
   * Operations whose conditional write did not match — someone else changed the
   * document upstream since it was last seen.
   *
   * This is a distinct outcome from {@link SyncApplyResult.failures}: a conflict is a
   * normal thing to reconcile, not a poison document, so it is never dead-lettered.
   */
  conflicts?: SyncApplyConflict[];
}

/** Why a conditional write did not land. */
export type SyncConflictReason =
  /** The upstream `_v` had moved on — a concurrent writer got there first. */
  | 'version-mismatch'
  /** A document believed to be new already existed upstream. */
  | 'already-exists'
  /** A document expected upstream was not there. */
  | 'missing';

/** An operation that lost a race against another writer. */
export interface SyncApplyConflict {
  /** Index into the `operations` array passed to `apply`. */
  index: number;
  reason: SyncConflictReason;
  /** The current upstream document, when the sink was able to read it back. */
  serverDocument?: Record<string, unknown>;
  /** The current upstream `_v`, when known. */
  serverVersion?: number | null;
}

/** What to do about a document that changed upstream and locally at the same time. */
export type SyncConflictResolution =
  /** Keep the upstream version and discard the local change. The default. */
  | 'server'
  /** Force the local version upstream, overwriting the other writer's change. */
  | 'local'
  /** Leave both sides alone; the local change is dropped without being retried. */
  | 'skip';

/** Everything known about a conflict, passed to {@link SyncOptions.onConflict}. */
export interface SyncConflictContext {
  /** Upstream collection name. */
  collection: string;
  /** Local collection the change originated in. */
  sourceCollection: string;
  documentId: string;
  operation: 'upsert' | 'delete';
  reason: SyncConflictReason;
  /** The local document that failed to push. `null` for a delete. */
  localDocument: Record<string, unknown> | null;
  /** The current upstream document, if it could be read. */
  serverDocument: Record<string, unknown> | null;
  /** The version the push asserted against. */
  baseVersion: number | null;
  /** The version actually found upstream. */
  serverVersion: number | null;
}

export interface SyncApplyFailure {
  /** Index into the `operations` array passed to `apply`. */
  index: number;
  message: string;
  /** Upstream error code, when the sink can determine one. */
  code?: number | string;
}

/**
 * The destination a {@link SyncReplicator} writes to.
 *
 * Implement this to replicate somewhere other than a MongoDB deployment
 * reachable by the official driver — an HTTP data API, a queue, or a test
 * double. The replicator owns retries and checkpointing; a sink only has to
 * apply a batch or throw.
 */
export interface SyncSink {
  /** Human-readable name, used in log and event output. */
  readonly name: string;

  /** Establish the upstream connection. Called before the first `apply`, and again after a reconnect. */
  connect?(): Promise<void>;

  /**
   * Apply a batch of coalesced operations.
   *
   * Throw to signal a **transient** failure — the replicator backs off and
   * retries the same batch, so this must be safe to re-run. Return
   * {@link SyncApplyResult.failures} to signal **permanent** per-operation
   * failures, which are dead-lettered so one poison document cannot stall the
   * whole stream.
   */
  apply(operations: SyncOperation[]): Promise<SyncApplyResult>;

  /**
   * Reads documents back from the upstream by `_id`.
   *
   * Used to refresh the local shadow after a conflict, so the next push diffs against
   * current upstream state instead of losing the race again. A sink that cannot read
   * may omit this — conflict resolution then falls back to dropping the local change.
   *
   * Ids that do not exist upstream are simply absent from the result.
   */
  fetch?(collection: string, documentIds: string[]): Promise<Record<string, unknown>[]>;

  /** Release the upstream connection. */
  close?(): Promise<void>;
}

/**
 * How to translate MongoLite's string `_id` values into upstream `_id` values.
 *
 * - `auto` (default) — a 24-character hex string becomes an `ObjectId`, anything
 *   else stays a string. MongoLite generates ObjectId-shaped ids, so this makes
 *   replicated documents look native upstream.
 * - `string` — always write `_id` as a string. Use this when the upstream is
 *   already populated with string ids, or when ids that merely *look* like
 *   ObjectIds should stay strings.
 */
export type SyncIdMapping = 'auto' | 'string';

/** What to do when the outbox exceeds {@link SyncOptions.maxOutboxSize}. */
export type SyncOverflowStrategy =
  /** Drop superseded revisions, keeping the newest row per document. Lossless — replication is last-write-wins. */
  | 'compact'
  /** Leave the outbox alone and only emit an `overflow` event. */
  | 'warn';

/** Seeding behaviour for documents that already existed before sync was set up. */
export type SyncInitialMode =
  /** Replicate the existing contents of each collection on first start. Default. */
  | 'backfill'
  /** Replicate only changes made from now on. */
  | 'changes-only';

export interface SyncCollectionOptions {
  /**
   * Collections to replicate. Omit to replicate every collection in the
   * database, including ones created later.
   */
  collections?: string[];
  /** Collections to exclude. Applied after `collections`. */
  exclude?: string[];
  /** Rename collections upstream: `{ localName: 'upstreamName' }`. */
  collectionMap?: Record<string, string>;
}

export interface SyncOptions extends SyncCollectionOptions {
  /**
   * Replicator name. Persisted with the checkpoint, so restarting resumes where
   * it left off. Use distinct names when replicating one database to several
   * upstreams. Defaults to `'default'`.
   */
  name?: string;

  /** Maximum operations per upstream round trip. Defaults to `500`. */
  batchSize?: number;

  /**
   * How long to wait before re-checking an empty outbox, in ms. Defaults to
   * `250`. Writes made through this process wake the replicator immediately, so
   * this only bounds the latency of changes made by *other* processes sharing
   * the database file.
   */
  pollIntervalMs?: number;

  /** Initial delay before retrying a failed batch, in ms. Defaults to `500`. */
  retryDelayMs?: number;

  /** Ceiling for the exponential retry backoff, in ms. Defaults to `30_000`. */
  maxRetryDelayMs?: number;

  /**
   * Give up on a batch after this many consecutive failures, stopping the
   * replicator and emitting `error`. Defaults to `Infinity` — keep retrying, so
   * a long outage is survived rather than dropped.
   */
  maxRetries?: number;

  /** See {@link SyncIdMapping}. Defaults to `'auto'`. */
  idMapping?: SyncIdMapping;

  /** See {@link SyncInitialMode}. Defaults to `'backfill'`. */
  initial?: SyncInitialMode;

  /**
   * Soft cap on pending outbox rows. Exceeding it emits `overflow` and applies
   * {@link SyncOptions.overflowStrategy}. Defaults to `100_000`.
   */
  maxOutboxSize?: number;

  /** See {@link SyncOverflowStrategy}. Defaults to `'compact'`. */
  overflowStrategy?: SyncOverflowStrategy;

  /**
   * Rewrite or drop documents on their way upstream. Return `null` to skip the
   * document entirely (the change is still acknowledged, not retried).
   * Deletes are passed through with `document === null` and cannot be rewritten.
   */
  transform?: (
    document: Record<string, unknown>,
    context: { collection: string; sourceCollection: string; operation: SyncOperationType }
  ) => Record<string, unknown> | null;

  /** How often to re-scan for newly created collections, in ms. Defaults to `5_000`. */
  collectionScanIntervalMs?: number;

  /**
   * Let the Node.js process exit while replication is still running. Defaults to
   * `false`: a running replicator keeps the process alive, so a script cannot
   * exit with changes still queued. Set to `true` for short-lived processes that
   * manage their own lifetime.
   */
  unref?: boolean;

  /**
   * Guard every push with a conditional write against the document's last-known
   * upstream `_v`, so a concurrent edit by another writer is detected instead of
   * silently overwritten. Defaults to `true`.
   *
   * Turning this off restores unconditional whole-document replacement: faster and
   * free of the `_v`/`_updatedAt` fields, but the local database becomes the effective
   * source of truth. Only appropriate when nothing else writes to the upstream.
   */
  versioning?: boolean;

  /**
   * Called when a push loses a race against another writer.
   *
   * Return `'server'` (the default) to keep the upstream version and discard the local
   * change, `'local'` to force the local version through anyway, or `'skip'` to leave
   * both sides alone. Either way the local shadow is refreshed from the upstream first,
   * so the decision is made against current state.
   */
  onConflict?: (context: SyncConflictContext) => SyncConflictResolution;

  /** Log replicator activity to the console. Defaults to `false`. */
  verbose?: boolean;
}

/** Point-in-time view of replication progress. */
export interface SyncStatus {
  name: string;
  running: boolean;
  /** True once the sink is connected and batches are flowing. */
  connected: boolean;
  /** Highest outbox id known to be applied upstream. */
  checkpoint: number;
  /** Outbox rows not yet applied. */
  pending: number;
  /** Operations successfully applied since `start()`. */
  applied: number;
  /** Batches that failed and were retried since `start()`. */
  retries: number;
  /** Operations permanently rejected upstream and moved to the dead-letter table. */
  deadLettered: number;
  /** Pushes that lost a race against another writer since `start()`. */
  conflicts: number;
  /** Collections currently being watched. */
  collections: string[];
  /** Last error seen, if replication is currently degraded. */
  lastError?: string;
}

/** A permanently-rejected operation, retained for inspection and replay. */
export interface SyncDeadLetter {
  id: number;
  collection: string;
  documentId: string;
  operation: string;
  document: Record<string, unknown> | null;
  error: string;
  failedAt: number;
}

/** Events emitted by {@link SyncReplicator}. */
export interface SyncEvents {
  /** The sink connected (on start, and after recovering from an outage). */
  connected: [];
  /** A batch was applied upstream. */
  batch: [{ applied: number; deadLettered: number; checkpoint: number }];
  /** The outbox drained — everything local is upstream. */
  drained: [{ checkpoint: number }];
  /** A batch failed and will be retried after `retryInMs`. */
  retry: [{ attempt: number; retryInMs: number; error: Error }];
  /** An operation was permanently rejected and moved to the dead-letter table. */
  deadLetter: [SyncDeadLetter];
  /** A push lost a race against another writer; `resolution` is what was done about it. */
  conflict: [SyncConflictContext & { resolution: SyncConflictResolution }];
  /** The outbox exceeded `maxOutboxSize`. */
  overflow: [{ pending: number; limit: number; compacted: number }];
  /** Replication stopped because of an unrecoverable error. */
  error: [Error];
  /** The replicator stopped. */
  stopped: [];
}

/** Counts returned by a bulk write, used to detect conditional writes that did not match. */
export interface MongoBulkWriteResultLike {
  matchedCount?: number;
  modifiedCount?: number;
  upsertedCount?: number;
  deletedCount?: number;
  /** Present on `MongoBulkWriteError`, mapping input index → generated `_id`. */
  upsertedIds?: Record<number, unknown>;
}

/** Minimal shape of the pieces of the `mongodb` driver the sink uses. */
export interface MongoDriverLike {
  MongoClient: new (uri: string, options?: Record<string, unknown>) => MongoClientLike;
  ObjectId: { new (id: string): unknown; isValid(id: string): boolean };
}

export interface MongoClientLike {
  connect(): Promise<unknown>;
  close(force?: boolean): Promise<void>;
  db(name?: string): MongoDbLike;
}

export interface MongoDbLike {
  collection(name: string): MongoCollectionLike;
}

export interface MongoCollectionLike {
  bulkWrite(
    operations: unknown[],
    options?: Record<string, unknown>
  ): Promise<MongoBulkWriteResultLike>;
  find(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>
  ): { toArray(): Promise<Record<string, unknown>[]> };
}
