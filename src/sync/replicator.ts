/**
 * Drains the {@link SyncOutbox} into an upstream {@link SyncSink}.
 *
 * ## Delivery guarantees
 *
 * Delivery is **at-least-once**, and every operation the replicator emits is
 * idempotent (`replaceOne` with `upsert`, or `deleteOne` by `_id`). Replaying a
 * batch therefore converges on the same upstream state, which is what makes it
 * safe to acknowledge *after* the upstream write rather than before: a crash in
 * the window between the two costs a duplicate write, never a lost one.
 *
 * ## Ordering
 *
 * Changes are read in outbox order and coalesced per document, so the newest
 * revision wins. Within a batch, operations touch distinct documents and are
 * applied unordered for throughput; across batches, order is preserved.
 */
import { EventEmitter } from 'events';
import type { IDatabaseAdapter } from '../db.js';
import { SyncOutbox } from './outbox.js';
import type {
  SyncApplyFailure,
  SyncDeadLetter,
  SyncOperation,
  SyncOptions,
  SyncOutboxRecord,
  SyncSink,
  SyncStatus,
} from './types.js';

const DEFAULTS = {
  name: 'default',
  batchSize: 500,
  pollIntervalMs: 250,
  retryDelayMs: 500,
  maxRetryDelayMs: 30_000,
  maxRetries: Number.POSITIVE_INFINITY,
  idMapping: 'auto' as const,
  initial: 'backfill' as const,
  maxOutboxSize: 100_000,
  overflowStrategy: 'compact' as const,
  collectionScanIntervalMs: 5_000,
  unref: false,
  verbose: false,
};

/** Rows scanned per query during the initial backfill. */
const BACKFILL_CHUNK_SIZE = 500;

export class SyncReplicator extends EventEmitter {
  private readonly outbox: SyncOutbox;
  private readonly opts: Required<
    Omit<SyncOptions, 'collections' | 'exclude' | 'collectionMap' | 'transform'>
  > &
    Pick<SyncOptions, 'collections' | 'exclude' | 'collectionMap' | 'transform'>;

  private running = false;
  private connected = false;
  private loop: Promise<void> | null = null;
  private checkpoint = 0;
  private backfilled: string[] = [];
  private watched: string[] = [];
  private lastCollectionScan = 0;
  private appliedCount = 0;
  private retryCount = 0;
  private deadLetterCount = 0;
  private lastError: string | undefined;

  /** Resolves the current sleep early when a local write arrives or `stop()` is called. */
  private wake: (() => void) | null = null;

  constructor(
    db: IDatabaseAdapter,
    private readonly sink: SyncSink,
    options: SyncOptions = {}
  ) {
    super();
    this.opts = { ...DEFAULTS, ...stripUndefined(options) };
    this.outbox = new SyncOutbox(db);
  }

  /** The outbox backing this replicator — for dead-letter inspection and manual maintenance. */
  get log(): SyncOutbox {
    return this.outbox;
  }

  /**
   * Installs capture triggers, backfills existing documents if this replicator
   * has never run, and starts streaming changes upstream.
   *
   * Resolves once replication is *running*, not once it has caught up — use
   * {@link SyncReplicator.waitForDrain} for that.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.outbox.ensureSchema();

    const state = await this.outbox.loadState(this.opts.name);
    this.checkpoint = state.checkpoint;
    this.backfilled = state.backfilled;

    await this.refreshCollections();

    this.loop = this.run().catch((err: unknown) => {
      this.fail(err);
    });
  }

  /**
   * Stops replication. Capture triggers stay installed, so changes made while
   * stopped are still recorded and picked up on the next `start()`.
   *
   * @param options.flush Drain everything pending before stopping. Defaults to `false`.
   */
  async stop(options: { flush?: boolean } = {}): Promise<void> {
    if (!this.running) return;

    if (options.flush) {
      await this.waitForDrain();
    }

    this.running = false;
    this.wake?.();

    if (this.loop) {
      await this.loop.catch(() => undefined);
      this.loop = null;
    }

    if (this.sink.close) {
      try {
        await this.sink.close();
      } catch (err) {
        this.log_(`error closing sink: ${describeError(err)}`);
      }
    }

    this.connected = false;
    // Unblock anyone parked in waitForDrain() rather than leaving them hanging.
    this.emit('drained', { checkpoint: this.checkpoint });
    this.emit('stopped');
  }

  /**
   * Nudges the replicator to check the outbox now instead of waiting for the
   * next poll. Called by the client after local writes so replication latency
   * is bounded by the upstream round trip, not the poll interval.
   */
  notify(): void {
    this.wake?.();
  }

  /**
   * Resolves once every change written *before this call* has reached the
   * upstream. Rejects if replication stops with an error.
   *
   * The target is pinned to the outbox position at call time rather than
   * "outbox is empty" — otherwise a concurrent writer could keep the outbox
   * non-empty forever, and, worse, a `drained` event from a scan that began
   * before the caller's own write would resolve it too early.
   */
  async waitForDrain(): Promise<void> {
    if (!this.running) return;

    const target = await this.outbox.currentSequence();
    if (this.checkpoint >= target) return;

    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.removeListener('drained', check);
        this.removeListener('batch', check);
        this.removeListener('stopped', check);
        this.removeListener('error', onError);
      };
      const check = (): void => {
        if (!this.running || this.checkpoint >= target) {
          cleanup();
          resolve();
        }
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      this.on('drained', check);
      this.on('batch', check);
      this.on('stopped', check);
      this.on('error', onError);
      this.wake?.();
    });
  }

  /** Current replication progress. */
  async status(): Promise<SyncStatus> {
    return {
      name: this.opts.name,
      running: this.running,
      connected: this.connected,
      checkpoint: this.checkpoint,
      pending: await this.pending(),
      applied: this.appliedCount,
      retries: this.retryCount,
      deadLettered: this.deadLetterCount,
      collections: [...this.watched],
      lastError: this.lastError,
    };
  }

  /** Changes permanently rejected upstream. */
  async deadLetters(limit = 100): Promise<SyncDeadLetter[]> {
    return this.outbox.listDeadLetters(this.opts.name, limit);
  }

  // ---------------------------------------------------------------- internals

  private async pending(): Promise<number> {
    return this.outbox.pendingCount(this.checkpoint, this.collectionFilter());
  }

  /** `null` means "every collection"; an array restricts the outbox query. */
  private collectionFilter(): string[] | null {
    return this.opts.collections || this.opts.exclude ? this.watched : null;
  }

  /**
   * Discovers collections to watch and installs their triggers.
   *
   * Re-run periodically so collections created after `start()` join replication
   * without a restart.
   */
  private async refreshCollections(): Promise<void> {
    const existing = await this.outbox.listCollections();
    const exclude = new Set(this.opts.exclude ?? []);

    const selected = (this.opts.collections ?? existing).filter(
      (name) => !exclude.has(name) && existing.includes(name)
    );

    // A table dropped and recreated between scans has lost its triggers.
    await this.outbox.refreshTriggerCache();

    for (const collection of selected) {
      await this.outbox.ensureTriggers(collection);
    }

    this.watched = selected;
    this.lastCollectionScan = Date.now();

    if (this.opts.initial === 'backfill') {
      const pendingBackfill = selected.filter((name) => !this.backfilled.includes(name));
      if (pendingBackfill.length > 0) {
        await this.backfill(pendingBackfill);
      }
    } else if (selected.some((name) => !this.backfilled.includes(name))) {
      // Record them as done so switching to 'backfill' later doesn't replay history.
      this.backfilled = [...new Set([...this.backfilled, ...selected])];
      await this.outbox.markBackfilled(this.opts.name, this.backfilled);
    }
  }

  /**
   * Seeds the upstream with documents that existed before replication started.
   *
   * The checkpoint is pinned *before* the scan begins, so a write racing the
   * scan is either seen by the scan, or captured in the outbox above the
   * checkpoint, or both — and "both" is harmless because upserts are idempotent.
   */
  private async backfill(collections: string[]): Promise<void> {
    await this.ensureConnected();

    for (const collection of collections) {
      let count = 0;

      for await (const chunk of this.outbox.scanCollection(collection, BACKFILL_CHUNK_SIZE)) {
        if (!this.running) return;

        const operations: SyncOperation[] = [];
        for (const row of chunk) {
          if (row.document === null) continue; // Unreadable JSON — skip, the row is already broken locally.
          const op = this.toOperation({
            id: 0,
            collection,
            documentId: row.documentId,
            operation: 'insert',
            document: row.document,
            capturedAt: Date.now(),
          });
          if (op) operations.push(op);
        }

        if (operations.length > 0) {
          const failures = await this.applyWithRetry(operations);
          if (failures === null) return;

          for (const failure of failures) {
            const op = operations[failure.index];
            if (!op) continue;
            await this.recordDeadLetter(
              {
                id: 0,
                collection: op.sourceCollection,
                documentId: op.documentId,
                operation: 'insert',
                document: op.document ?? null,
                capturedAt: Date.now(),
              },
              failure.message
            );
          }

          const applied = operations.length - failures.length;
          this.appliedCount += applied;
          count += applied;
        }
      }

      this.backfilled = [...new Set([...this.backfilled, collection])];
      await this.outbox.markBackfilled(this.opts.name, this.backfilled);
      this.log_(`backfilled ${count} document(s) from "${collection}"`);
    }
  }

  /** The replication loop: read, coalesce, apply, checkpoint, repeat. */
  private async run(): Promise<void> {
    await this.ensureConnected();

    while (this.running) {
      let moved = false;

      try {
        moved = await this.drainOnce();
      } catch (err) {
        if (!this.running) return;
        throw err;
      }

      if (!this.running) return;

      if (!moved) {
        this.emit('drained', { checkpoint: this.checkpoint });
        await this.sleep(this.opts.pollIntervalMs);

        if (
          this.running &&
          Date.now() - this.lastCollectionScan >= this.opts.collectionScanIntervalMs
        ) {
          await this.refreshCollections();
        }
      }
    }
  }

  /**
   * Applies one batch.
   * @returns `true` if there was work to do, `false` if the outbox was empty.
   */
  private async drainOnce(): Promise<boolean> {
    // Read the tail position first: if the batch comes back empty we can safely
    // fast-forward to here without stepping over a row that arrived meanwhile.
    const tail = await this.outbox.currentSequence();
    const records = await this.outbox.readBatch(
      this.checkpoint,
      this.opts.batchSize,
      this.collectionFilter()
    );

    if (records.length === 0) {
      if (tail > this.checkpoint) {
        // Only rows for collections we don't replicate. Skip past them so they
        // become prunable instead of accumulating forever.
        await this.advanceTo(tail);
      }
      await this.enforceOutboxLimit();
      return false;
    }

    const highestId = records[records.length - 1].id;
    const { operations, poison } = this.coalesce(records);

    for (const record of poison) {
      await this.recordDeadLetter(record, 'stored document JSON could not be parsed');
    }

    if (operations.length > 0) {
      const failures = await this.applyWithRetry(operations);
      if (failures === null) return false; // Stopped mid-batch — leave the checkpoint alone.

      for (const failure of failures) {
        const op = operations[failure.index];
        if (!op) continue;
        await this.recordDeadLetter(
          {
            id: op.outboxId,
            collection: op.sourceCollection,
            documentId: op.documentId,
            operation: op.type === 'delete' ? 'delete' : 'update',
            document: op.document ?? null,
            capturedAt: Date.now(),
          },
          failure.message
        );
      }

      this.appliedCount += operations.length - failures.length;

      // Checkpoint before announcing, so a `batch` listener that inspects
      // progress sees the position the batch actually reached.
      await this.advanceTo(highestId);
      this.emit('batch', {
        applied: operations.length - failures.length,
        deadLettered: failures.length,
        checkpoint: highestId,
      });
      return true;
    }

    await this.advanceTo(highestId);
    return true;
  }

  /** Acknowledges up to `id` and prunes rows no replicator needs any more. */
  private async advanceTo(id: number): Promise<void> {
    this.checkpoint = id;
    await this.outbox.saveCheckpoint(this.opts.name, id);
    await this.outbox.prune();
  }

  /**
   * Collapses a run of changes into one operation per document.
   *
   * Records are in ascending outbox order, so the last one seen for a document
   * is its current state — an upsert of the newest revision, or a delete.
   */
  private coalesce(records: SyncOutboxRecord[]): {
    operations: SyncOperation[];
    poison: SyncOutboxRecord[];
  } {
    const latest = new Map<string, SyncOutboxRecord>();
    const poison: SyncOutboxRecord[] = [];

    for (const record of records) {
      latest.set(`${record.collection} ${record.documentId}`, record);
    }

    const operations: SyncOperation[] = [];
    for (const record of latest.values()) {
      if (record.operation !== 'delete' && record.document === null) {
        poison.push(record);
        continue;
      }
      const op = this.toOperation(record);
      if (op) operations.push(op);
    }

    return { operations, poison };
  }

  /** Maps an outbox record to an upstream operation, applying rename and transform. */
  private toOperation(record: SyncOutboxRecord): SyncOperation | null {
    const target = this.opts.collectionMap?.[record.collection] ?? record.collection;

    if (record.operation === 'delete') {
      return {
        collection: target,
        sourceCollection: record.collection,
        documentId: record.documentId,
        type: 'delete',
        outboxId: record.id,
      };
    }

    let document = record.document as Record<string, unknown>;

    if (this.opts.transform) {
      const transformed = this.opts.transform(document, {
        collection: target,
        sourceCollection: record.collection,
        operation: record.operation,
      });
      // `null` means "don't replicate this one" — acknowledged, not retried.
      if (transformed === null) return null;
      document = transformed;
    }

    return {
      collection: target,
      sourceCollection: record.collection,
      documentId: record.documentId,
      type: 'upsert',
      document,
      outboxId: record.id,
    };
  }

  /**
   * Applies a batch, retrying transient failures with exponential backoff and
   * jitter. Returns the operations the upstream rejected permanently, or `null`
   * if the replicator was stopped before the batch landed.
   *
   * The checkpoint is never advanced while this is retrying, so an upstream
   * outage simply parks the batch — the outbox absorbs the backlog.
   */
  private async applyWithRetry(operations: SyncOperation[]): Promise<SyncApplyFailure[] | null> {
    let attempt = 0;
    let delay = this.opts.retryDelayMs;

    for (;;) {
      // Stopping mid-retry must not look like success: returning `null` keeps
      // the caller from checkpointing work that never reached the upstream.
      if (!this.running) return null;

      try {
        await this.ensureConnected();
        const result = await this.sink.apply(operations);
        this.lastError = undefined;
        return result.failures ?? [];
      } catch (err) {
        attempt += 1;
        this.retryCount += 1;
        this.connected = false;
        this.lastError = describeError(err);

        if (attempt > this.opts.maxRetries) {
          throw err instanceof Error ? err : new Error(this.lastError);
        }

        // Jitter keeps several replicators from stampeding a recovering upstream.
        const jitter = 0.85 + Math.random() * 0.3;
        const retryInMs = Math.min(delay * jitter, this.opts.maxRetryDelayMs);
        delay = Math.min(delay * 2, this.opts.maxRetryDelayMs);

        this.emit('retry', {
          attempt,
          retryInMs,
          error: err instanceof Error ? err : new Error(this.lastError),
        });
        this.log_(`batch failed (attempt ${attempt}), retrying in ${Math.round(retryInMs)}ms`);

        // An outage is exactly when the backlog builds, and this loop is where
        // the replicator spends that time — so the size check belongs here too,
        // not only on the idle path.
        await this.enforceOutboxLimit();
        await this.sleep(retryInMs);
      }
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.sink.connect) {
      await this.sink.connect();
    }
    this.connected = true;
    this.emit('connected');
  }

  private async recordDeadLetter(record: SyncOutboxRecord, error: string): Promise<void> {
    this.deadLetterCount += 1;
    await this.outbox.deadLetter(
      this.opts.name,
      {
        collection: record.collection,
        documentId: record.documentId,
        operation: record.operation,
        document: record.document,
      },
      error
    );
    this.emit('deadLetter', {
      id: record.id,
      collection: record.collection,
      documentId: record.documentId,
      operation: record.operation,
      document: record.document,
      error,
      failedAt: Date.now(),
    });
  }

  /**
   * Keeps the outbox from growing without bound during a long outage.
   * Compaction is lossless here because replication is full-document
   * last-write-wins: only superseded revisions are dropped.
   */
  private async enforceOutboxLimit(): Promise<void> {
    const pending = await this.pending();
    if (pending <= this.opts.maxOutboxSize) return;

    const compacted = this.opts.overflowStrategy === 'compact' ? await this.outbox.compact() : 0;

    this.emit('overflow', { pending, limit: this.opts.maxOutboxSize, compacted });
    this.log_(
      `outbox at ${pending} rows (limit ${this.opts.maxOutboxSize}); compacted ${compacted}`
    );
  }

  /** Sleeps, but returns early when `notify()` or `stop()` is called. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };

      const timer = setTimeout(finish, ms);
      // A running replicator holds the process open by default, the same way an
      // open server does: exiting with changes still queued would silently lose
      // them. `unref: true` opts out for short-lived scripts.
      if (this.opts.unref) timer.unref?.();
      this.wake = finish;
    });
  }

  private fail(err: unknown): void {
    this.running = false;
    this.connected = false;
    this.lastError = describeError(err);
    const error = err instanceof Error ? err : new Error(this.lastError);
    // Never throw from the loop's catch: an unhandled 'error' event would crash
    // the host process for what is a recoverable, reportable condition.
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    } else {
      console.error(`[mongolite:sync:${this.opts.name}] replication stopped:`, error);
    }
  }

  private log_(message: string): void {
    if (this.opts.verbose) {
      console.log(`[mongolite:sync:${this.opts.name}] ${message}`);
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Drops explicitly-undefined keys so they don't clobber defaults in a spread. */
function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
