/**
 * A {@link SyncSink} that writes to a MongoDB deployment using the official
 * `mongodb` driver.
 *
 * The driver is an **optional peer dependency**, imported dynamically the first
 * time a connection is opened. Projects that never replicate upstream do not
 * need it installed, and bundlers that never reach this module do not pull it in.
 */

import type {
  MongoBulkWriteResultLike,
  MongoClientLike,
  MongoDbLike,
  MongoDriverLike,
  SyncApplyConflict,
  SyncApplyFailure,
  SyncApplyResult,
  SyncIdMapping,
  SyncOperation,
  SyncSink,
} from './types.js';

/** Field carrying the optimistic-concurrency version on upstream documents. */
export const VERSION_FIELD = '_v';

/** Field carrying the server-stamped last-write time on upstream documents. */
export const UPDATED_AT_FIELD = '_updatedAt';

/**
 * Authentication and transport settings for the upstream connection.
 *
 * Most deployments need nothing beyond the connection string — it already
 * carries username, password, `authSource`, `replicaSet` and `tls`. These
 * options cover the cases a URI cannot express, chiefly the certificate-file
 * based mechanisms (X.509, mTLS, a private CA).
 */
export interface MongoUpstreamAuth {
  /** Database to authenticate against, when it differs from the target database. */
  authSource?: string;

  /**
   * SASL/auth mechanism, e.g. `'SCRAM-SHA-256'`, `'MONGODB-X509'`,
   * `'MONGODB-AWS'`, `'MONGODB-OIDC'`, `'GSSAPI'`, `'PLAIN'`.
   * Omit to let the driver negotiate.
   */
  authMechanism?: string;

  /** Mechanism-specific properties, e.g. `{ AWS_SESSION_TOKEN: '…' }`. */
  authMechanismProperties?: Record<string, unknown>;

  /** Username, when not embedded in the connection string. */
  username?: string;

  /** Password, when not embedded in the connection string. */
  password?: string;

  /** Force TLS on or off. Usually inferred from the connection string. */
  tls?: boolean;

  /** Path to a PEM file with the certificate authority chain, for a private CA. */
  tlsCAFile?: string;

  /**
   * Path to a PEM file holding the client certificate **and** its private key —
   * required for mutual TLS and for `MONGODB-X509` authentication.
   */
  tlsCertificateKeyFile?: string;

  /** Passphrase for an encrypted `tlsCertificateKeyFile`. */
  tlsCertificateKeyFilePassword?: string;

  /** Path to a PEM file listing revoked certificates. */
  tlsCRLFile?: string;

  /**
   * Skip hostname verification. Never enable this against a production
   * deployment — it removes the protection TLS is there to provide.
   */
  tlsAllowInvalidHostnames?: boolean;

  /**
   * Accept certificates that fail validation. Never enable this against a
   * production deployment.
   */
  tlsAllowInvalidCertificates?: boolean;
}

export interface MongoSinkOptions extends MongoUpstreamAuth {
  /** Upstream connection string, e.g. `mongodb+srv://host/db`. */
  connectionString: string;

  /** Target database. Defaults to the one in the connection string's path. */
  database?: string;

  /** See {@link SyncIdMapping}. Defaults to `'auto'`. */
  idMapping?: SyncIdMapping;

  /**
   * Guard writes with a conditional update against each document's last-known `_v`.
   * Defaults to `true`. See {@link SyncOptions.versioning}.
   */
  versioning?: boolean;

  /**
   * Write concern for replicated batches. Defaults to `{ w: 'majority' }` so an
   * acknowledged batch has actually survived upstream before it is checkpointed
   * locally.
   */
  writeConcern?: Record<string, unknown>;

  /**
   * Extra options passed straight through to `new MongoClient(...)`. Anything
   * the driver supports — `serverApi`, `proxyHost`, `compressors`,
   * `autoEncryption`, connection-pool tuning — belongs here.
   */
  driverOptions?: Record<string, unknown>;

  /**
   * Supply the `mongodb` module yourself instead of having it imported
   * dynamically. Useful for bundlers that cannot resolve dynamic imports, and
   * for tests.
   */
  driver?: MongoDriverLike;
}

/**
 * MongoDB server error codes that mean "this write will never succeed" —
 * retrying them would stall the stream behind one bad document forever, so
 * they are dead-lettered instead.
 */
const PERMANENT_ERROR_CODES = new Set([
  2, // BadValue
  9, // FailedToParse
  10334, // BSONObjectTooLarge
  14, // TypeMismatch
  52, // DollarPrefixedFieldName
  56, // EmptyFieldName
  121, // DocumentValidationFailure
  17280, // KeyTooLong
]);

export class MongoUpstreamSink implements SyncSink {
  readonly name = 'mongodb';

  private client: MongoClientLike | null = null;
  private db: MongoDbLike | null = null;
  private driver: MongoDriverLike | null = null;
  private readonly idMapping: SyncIdMapping;
  private readonly versioning: boolean;

  constructor(private readonly options: MongoSinkOptions) {
    if (!options.connectionString) {
      throw new Error('MongoUpstreamSink requires a `connectionString`.');
    }
    this.idMapping = options.idMapping ?? 'auto';
    this.versioning = options.versioning ?? true;
    this.driver = options.driver ?? null;
  }

  async connect(): Promise<void> {
    if (this.client && this.db) return;

    const driver = await this.loadDriver();
    const client = new driver.MongoClient(this.options.connectionString, this.clientOptions());
    await client.connect();

    this.client = client;
    this.db = client.db(this.options.database);
  }

  async apply(operations: SyncOperation[]): Promise<SyncApplyResult> {
    if (!this.db) await this.connect();
    const db = this.db;
    if (!db) throw new Error('MongoUpstreamSink is not connected.');

    // Group by collection: bulkWrite is per-collection, and one round trip per
    // collection beats one per document.
    const byCollection = new Map<string, Array<{ index: number; op: SyncOperation }>>();
    operations.forEach((op, index) => {
      const bucket = byCollection.get(op.collection);
      if (bucket) bucket.push({ index, op });
      else byCollection.set(op.collection, [{ index, op }]);
    });

    const failures: SyncApplyFailure[] = [];
    const conflicts: SyncApplyConflict[] = [];
    let applied = 0;

    for (const [collectionName, entries] of byCollection) {
      const writes = entries.map(({ op }) => this.toBulkOperation(op));
      let result: MongoBulkWriteResultLike | null = null;
      let rejected = 0;

      try {
        result = await db.collection(collectionName).bulkWrite(writes, {
          // Operations within a batch touch distinct documents, so ordering buys
          // nothing and unordered lets the server parallelise.
          ordered: false,
          writeConcern: this.options.writeConcern ?? { w: 'majority' },
        });
      } catch (err) {
        const bulkFailures = classifyBulkError(err, entries.length);

        // A transient failure (network, election, timeout) means the whole batch
        // is unknown — throw so the replicator retries it without checkpointing.
        if (bulkFailures === null) throw err;

        for (const failure of bulkFailures) {
          const entry = entries[failure.index];
          if (!entry) continue;
          // A duplicate key on an insert-if-absent means someone created the
          // document first — a conflict to reconcile, not a poison document.
          if (failure.code === 11000) {
            conflicts.push({ index: entry.index, reason: 'already-exists' });
          } else {
            failures.push({ index: entry.index, message: failure.message, code: failure.code });
          }
        }
        rejected = bulkFailures.length;
        result = (err as { result?: MongoBulkWriteResultLike }).result ?? null;
      }

      const landed = entries.length - rejected;

      // A conditional write that matches nothing raises no error at all — the only
      // evidence is the count. Without this check a lost race looks like success.
      const missed = this.countMisses(entries, result, rejected);
      if (missed.length > 0) {
        await this.describeConflicts(db, collectionName, missed, conflicts);
      }

      applied += landed - missed.length;
    }

    return {
      applied,
      failures: failures.length > 0 ? failures : undefined,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  }

  /**
   * Identifies operations whose conditional write did not match.
   *
   * `bulkWrite` reports only aggregate counts, so this compares what the batch expected
   * to change against what the server says changed. When the numbers agree, nothing was
   * missed and no per-document work is needed.
   */
  private countMisses(
    entries: Array<{ index: number; op: SyncOperation }>,
    result: MongoBulkWriteResultLike | null,
    rejected: number
  ): Array<{ index: number; op: SyncOperation }> {
    if (!this.versioning || result === null || rejected === entries.length) return [];

    const candidates = entries.filter(({ op }) => isConditional(op));
    if (candidates.length === 0) return [];

    const writes = candidates.filter(({ op }) => op.type !== 'delete');
    const deletes = candidates.filter(({ op }) => op.type === 'delete');

    const acknowledgedWrites = (result.matchedCount ?? 0) + (result.upsertedCount ?? 0);
    const acknowledgedDeletes = result.deletedCount ?? 0;

    const missed: Array<{ index: number; op: SyncOperation }> = [];

    // The counts are aggregate, so which specific documents missed is unknown; the
    // caller re-reads the candidates and decides per document.
    if (acknowledgedWrites < writes.length) missed.push(...writes);
    if (acknowledgedDeletes < deletes.length) missed.push(...deletes);

    return missed;
  }

  /**
   * Re-reads the upstream state of operations that may have missed, and records a
   * conflict for each one whose version really has moved on.
   *
   * The re-read is what turns an aggregate "something didn't match" into a precise,
   * per-document answer, and it supplies the current server document the replicator
   * needs to refresh its shadow.
   */
  private async describeConflicts(
    db: MongoDbLike,
    collectionName: string,
    candidates: Array<{ index: number; op: SyncOperation }>,
    conflicts: SyncApplyConflict[]
  ): Promise<void> {
    const ids = candidates.map(({ op }) => this.toUpstreamId(op.documentId));
    const current = await db
      .collection(collectionName)
      .find({ _id: { $in: ids } })
      .toArray();

    const byId = new Map(current.map((doc) => [String(doc._id), doc]));

    for (const { index, op } of candidates) {
      const serverDocument = byId.get(op.documentId);
      const serverVersion = readVersion(serverDocument);

      if (op.type === 'delete') {
        // Already gone upstream is the outcome we wanted, however it happened.
        if (!serverDocument) continue;
        conflicts.push({ index, reason: 'version-mismatch', serverDocument, serverVersion });
        continue;
      }

      if (!serverDocument) {
        conflicts.push({ index, reason: 'missing' });
        continue;
      }

      // The write did land after all — another operation in the batch was the one
      // that missed, and this document is already at the version we wrote.
      if (op.baseVersion !== null && op.baseVersion !== undefined) {
        if (serverVersion === op.baseVersion + 1) continue;
      }

      conflicts.push({ index, reason: 'version-mismatch', serverDocument, serverVersion });
    }
  }

  async fetch(collection: string, documentIds: string[]): Promise<Record<string, unknown>[]> {
    if (documentIds.length === 0) return [];
    if (!this.db) await this.connect();
    const db = this.db;
    if (!db) throw new Error('MongoUpstreamSink is not connected.');

    const ids = documentIds.map((id) => this.toUpstreamId(id));
    return db
      .collection(collection)
      .find({ _id: { $in: ids } })
      .toArray();
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.db = null;
    if (client) await client.close();
  }

  // ---------------------------------------------------------------- internals

  private async loadDriver(): Promise<MongoDriverLike> {
    if (this.driver) return this.driver;

    try {
      // Indirect specifier: `mongodb` is optional, and a literal import would
      // make it a hard build-time dependency for everyone compiling this package.
      const specifier = 'mongodb';
      const mod = (await import(specifier)) as unknown as MongoDriverLike;
      this.driver = mod;
      return mod;
    } catch (err) {
      throw new Error(
        'MongoDB sync requires the `mongodb` driver. Install it with `npm install mongodb`, ' +
          `or pass a \`driver\` explicitly. Original error: ${
            err instanceof Error ? err.message : String(err)
          }`
      );
    }
  }

  private clientOptions(): Record<string, unknown> {
    const {
      authSource,
      authMechanism,
      authMechanismProperties,
      username,
      password,
      tls,
      tlsCAFile,
      tlsCertificateKeyFile,
      tlsCertificateKeyFilePassword,
      tlsCRLFile,
      tlsAllowInvalidHostnames,
      tlsAllowInvalidCertificates,
      driverOptions,
    } = this.options;

    const auth =
      username !== undefined || password !== undefined ? { username, password } : undefined;

    // Undefined keys are stripped so they never override a setting that the
    // connection string already specified.
    return stripUndefined({
      authSource,
      authMechanism,
      authMechanismProperties,
      auth,
      tls,
      tlsCAFile,
      tlsCertificateKeyFile,
      tlsCertificateKeyFilePassword,
      tlsCRLFile,
      tlsAllowInvalidHostnames,
      tlsAllowInvalidCertificates,
      ...driverOptions,
    });
  }

  /**
   * Builds the upstream write for one operation.
   *
   * Every form is idempotent by `_id`, which is what makes at-least-once delivery safe:
   * replaying a batch reproduces the same upstream state.
   *
   * With versioning on, writes are additionally *conditional* on the document still
   * being at the version we last saw. That is the difference between "my change is
   * newer, so it wins" — which cannot detect a lost update — and "I am replacing
   * exactly the revision I read", which can.
   */
  private toBulkOperation(op: SyncOperation): unknown {
    const _id = this.toUpstreamId(op.documentId);

    if (op.type === 'delete') {
      const filter = isConditional(op) ? { _id, [VERSION_FIELD]: op.baseVersion } : { _id };
      return { deleteOne: { filter } };
    }

    if (!this.versioning) {
      // The local database is treated as authoritative: replace wholesale, so a field
      // deleted locally disappears upstream too.
      return {
        replaceOne: { filter: { _id }, replacement: { ...(op.document ?? {}), _id }, upsert: true },
      };
    }

    // Never been upstream: create it, and let a duplicate key tell us we lost the race
    // to create. `$setOnInsert` alone means an existing document is left untouched.
    if (op.baseVersion === null || op.baseVersion === undefined) {
      const document = stripReservedFields(op.document ?? {});
      return {
        updateOne: {
          filter: { _id },
          update: {
            $setOnInsert: { ...document, [VERSION_FIELD]: 1 },
            $currentDate: { [UPDATED_AT_FIELD]: true },
          },
          upsert: true,
        },
      };
    }

    // Known revision: apply only what changed, conditional on that revision.
    const update: Record<string, unknown> = {
      $inc: { [VERSION_FIELD]: 1 },
      $currentDate: { [UPDATED_AT_FIELD]: true },
    };

    const diff = op.diff;
    if (diff) {
      const set = stripReservedFields(diff.set);
      const unset = diff.unset.filter((path) => !isReservedPath(path));
      if (Object.keys(set).length > 0) update.$set = set;
      if (unset.length > 0) {
        update.$unset = Object.fromEntries(unset.map((path) => [path, '']));
      }
    } else {
      // No shadow to diff against — fall back to writing the whole document, minus the
      // bookkeeping fields the update itself manages.
      update.$set = stripReservedFields(op.document ?? {});
    }

    return {
      updateOne: {
        filter: { _id, [VERSION_FIELD]: op.baseVersion },
        update,
      },
    };
  }

  /**
   * MongoLite stores `_id` as a string. Converting ObjectId-shaped ids back to
   * real `ObjectId`s keeps replicated documents indistinguishable from ones
   * written by a native MongoDB client.
   */
  private toUpstreamId(documentId: string): unknown {
    if (this.idMapping === 'string' || !this.driver) return documentId;
    try {
      return this.driver.ObjectId.isValid(documentId) && /^[0-9a-fA-F]{24}$/.test(documentId)
        ? new this.driver.ObjectId(documentId)
        : documentId;
    } catch {
      return documentId;
    }
  }
}

/**
 * Splits a driver error into per-operation permanent failures.
 *
 * @returns The failures to dead-letter, or `null` when the error is transient
 * and the whole batch should be retried.
 */
function classifyBulkError(
  err: unknown,
  operationCount: number
): Array<{ index: number; message: string; code?: number | string }> | null {
  const error = err as {
    name?: string;
    code?: number | string;
    writeErrors?: Array<{ index?: number; errmsg?: string; message?: string; code?: number }>;
    result?: {
      writeErrors?: Array<{ index?: number; errmsg?: string; message?: string; code?: number }>;
    };
    hasErrorLabel?: (label: string) => boolean;
    message?: string;
  };

  // The driver retried and still could not reach a writable primary.
  if (error.hasErrorLabel?.('RetryableWriteError')) return null;

  const writeErrors = error.writeErrors ?? error.result?.writeErrors;

  if (Array.isArray(writeErrors) && writeErrors.length > 0) {
    const failures: Array<{ index: number; message: string; code?: number | string }> = [];

    for (const writeError of writeErrors) {
      const code = writeError.code;
      // A write error that isn't a known-permanent one (a transient duplicate
      // key during failover, say) means the batch is worth retrying whole.
      if (code === undefined || !PERMANENT_ERROR_CODES.has(code)) return null;

      const index = writeError.index ?? 0;
      if (index >= operationCount) return null;

      failures.push({
        index,
        message: writeError.errmsg ?? writeError.message ?? `write error ${code}`,
        code,
      });
    }

    return failures;
  }

  // No per-write detail: a connection, timeout or auth error. Retry it.
  return null;
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

/** True when this operation asserts a specific upstream revision. */
function isConditional(op: SyncOperation): boolean {
  return op.baseVersion !== null && op.baseVersion !== undefined;
}

/** `_id` is the identity; `_v`/`_updatedAt` are managed by the update itself. */
function isReservedPath(path: string): boolean {
  const root = path.split('.')[0];
  return root === '_id' || root === VERSION_FIELD || root === UPDATED_AT_FIELD;
}

function stripReservedFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isReservedPath(key)));
}

/** Reads `_v` off an upstream document, tolerating its absence. */
function readVersion(document: Record<string, unknown> | undefined): number | null {
  if (!document) return null;
  const raw = document[VERSION_FIELD];
  return typeof raw === 'number' ? raw : null;
}
