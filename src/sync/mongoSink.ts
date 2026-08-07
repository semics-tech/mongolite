/**
 * A {@link SyncSink} that writes to a MongoDB deployment using the official
 * `mongodb` driver.
 *
 * The driver is an **optional peer dependency**, imported dynamically the first
 * time a connection is opened. Projects that never replicate upstream do not
 * need it installed, and bundlers that never reach this module do not pull it in.
 */

import { buildWriteCommand } from './commands.js';
import type { BuildCommandOptions } from './commands.js';
import { executeWrites, fetchDocuments } from './mongoExecutor.js';
import type { PreparedWrite } from './mongoExecutor.js';
import type {
  MongoClientLike,
  MongoDbLike,
  MongoDriverLike,
  SyncApplyResult,
  SyncIdMapping,
  SyncOperation,
  SyncSink,
} from './types.js';

export { VERSION_FIELD, UPDATED_AT_FIELD } from './commands.js';

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

    const writes: PreparedWrite[] = operations.map((op, index) => ({
      index,
      op,
      command: buildWriteCommand(op, this.commandOptions()),
    }));

    return executeWrites(db, writes, {
      writeConcern: this.options.writeConcern ?? { w: 'majority' },
      versioning: this.versioning,
      idMapping: this.idMapping,
      ObjectId: this.driver?.ObjectId,
    });
  }

  /**
   * Command-building settings. The driver's own `ObjectId` is used when available so
   * BSON instances match the connection that will serialise them.
   */
  private commandOptions(): BuildCommandOptions {
    return {
      idMapping: this.idMapping,
      versioning: this.versioning,
      ObjectId: this.driver?.ObjectId,
    };
  }

  async fetch(collection: string, documentIds: string[]): Promise<Record<string, unknown>[]> {
    if (documentIds.length === 0) return [];
    if (!this.db) await this.connect();
    const db = this.db;
    if (!db) throw new Error('MongoUpstreamSink is not connected.');

    return fetchDocuments(db, collection, documentIds, this.idMapping, this.driver?.ObjectId);
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
}

/** Drops unset keys so they never override what the connection string specified. */
function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
