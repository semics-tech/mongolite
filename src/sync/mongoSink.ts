/**
 * A {@link SyncSink} that writes to a MongoDB deployment using the official
 * `mongodb` driver.
 *
 * The driver is an **optional peer dependency**, imported dynamically the first
 * time a connection is opened. Projects that never replicate upstream do not
 * need it installed, and bundlers that never reach this module do not pull it in.
 */
import type {
  MongoClientLike,
  MongoDbLike,
  MongoDriverLike,
  SyncApplyFailure,
  SyncApplyResult,
  SyncIdMapping,
  SyncOperation,
  SyncSink,
} from './types.js';

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

  constructor(private readonly options: MongoSinkOptions) {
    if (!options.connectionString) {
      throw new Error('MongoUpstreamSink requires a `connectionString`.');
    }
    this.idMapping = options.idMapping ?? 'auto';
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
    let applied = 0;

    for (const [collectionName, entries] of byCollection) {
      const writes = entries.map(({ op }) => this.toBulkOperation(op));

      try {
        await db.collection(collectionName).bulkWrite(writes, {
          // Operations within a batch touch distinct documents, so ordering buys
          // nothing and unordered lets the server parallelise.
          ordered: false,
          writeConcern: this.options.writeConcern ?? { w: 'majority' },
        });
        applied += entries.length;
      } catch (err) {
        const bulkFailures = classifyBulkError(err, entries.length);

        // A transient failure (network, election, timeout) means the whole batch
        // is unknown — throw so the replicator retries it without checkpointing.
        if (bulkFailures === null) throw err;

        for (const failure of bulkFailures) {
          const entry = entries[failure.index];
          if (!entry) continue;
          failures.push({ index: entry.index, message: failure.message, code: failure.code });
        }
        applied += entries.length - bulkFailures.length;
      }
    }

    return { applied, failures: failures.length > 0 ? failures : undefined };
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
   * Both forms are idempotent by `_id`, which is what makes at-least-once
   * delivery safe: replaying a batch reproduces the same upstream state.
   */
  private toBulkOperation(op: SyncOperation): unknown {
    const _id = this.toUpstreamId(op.documentId);

    if (op.type === 'delete') {
      return { deleteOne: { filter: { _id } } };
    }

    // The local document is the source of truth, so replace wholesale rather
    // than merging — that is what makes a field deleted locally disappear upstream.
    const document = { ...(op.document ?? {}), _id };
    return { replaceOne: { filter: { _id }, replacement: document, upsert: true } };
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
