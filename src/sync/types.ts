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
  /** The outbox exceeded `maxOutboxSize`. */
  overflow: [{ pending: number; limit: number; compacted: number }];
  /** Replication stopped because of an unrecoverable error. */
  error: [Error];
  /** The replicator stopped. */
  stopped: [];
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
  ): Promise<{ upsertedCount?: number; modifiedCount?: number; deletedCount?: number }>;
}
