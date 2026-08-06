import { NodeSqliteAdapter } from './adapters/node-sqlite.js';
import type { IDatabaseAdapter, MongoLiteOptions as DBMongoLiteOptions } from './db.js';
import { MongoLite as MongoLiteBase, MongoLiteBaseOptions } from './mongo-client.js';

export { MongoLiteCollection } from './collection.js';
export * from './types.js';
export { ChangeStream } from './changeStream.js';
export type {
  ChangeStreamDocument,
  ChangeStreamOptions,
  ChangeOperationType,
} from './changeStream.js';
export type { IDatabaseAdapter } from './db.js';
export { CloudflareDurableObjectAdapter } from './adapters/cloudflare.js';
export type { SqlStorage, SqlStorageCursor, SqlStorageValue } from './adapters/cloudflare.js';
export { BrowserSqliteAdapter } from './adapters/browser.js';
export type { SqlJsDatabase, SqlJsStatement } from './adapters/browser.js';
export { NodeSqliteAdapter } from './adapters/node-sqlite.js';

import { MongoUpstreamSink, SyncReplicator } from './sync/index.js';
import type { MongoSinkOptions, SyncOptions } from './sync/index.js';

export { SyncReplicator, SyncOutbox, MongoUpstreamSink } from './sync/index.js';
export type {
  MongoSinkOptions,
  MongoUpstreamAuth,
  SyncApplyFailure,
  SyncApplyResult,
  SyncDeadLetter,
  SyncEvents,
  SyncIdMapping,
  SyncInitialMode,
  SyncOperation,
  SyncOperationType,
  SyncOptions,
  SyncOutboxRecord,
  SyncOverflowStrategy,
  SyncSink,
  SyncStatus,
} from './sync/index.js';

export interface MongoLiteClientOptions extends DBMongoLiteOptions {}

/**
 * Options for {@link MongoLite.syncToMongo} — replication settings plus the
 * upstream connection details.
 */
export interface MongoSyncOptions extends SyncOptions, Omit<MongoSinkOptions, 'idMapping'> {}

/**
 * MongoLite class is the main entry point for interacting with the SQLite-backed database.
 *
 * You can construct it with:
 * - A file path string — uses the built-in `node:sqlite` adapter (`NodeSqliteAdapter`).
 *   Requires Node.js 22.5.0+; for older runtimes, import `MongoLite` from
 *   `@semics-tech/mongolite/better-sqlite3` instead.
 * - A `MongoLiteClientOptions` object — uses the built-in adapter with options.
 * - An `IDatabaseAdapter` instance — use a custom adapter such as
 *   `CloudflareDurableObjectAdapter` for Cloudflare Durable Objects.
 */
export class MongoLite extends MongoLiteBase {
  /**
   * Creates a new MongoLite client instance.
   * @param dbPathOrOptions Path to the SQLite database file, an options object,
   *                        or an `IDatabaseAdapter` for custom backends.
   */
  constructor(
    dbPathOrOptions: string | MongoLiteClientOptions | IDatabaseAdapter,
    options: MongoLiteBaseOptions = {}
  ) {
    if (
      dbPathOrOptions &&
      typeof dbPathOrOptions === 'object' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).connect === 'function' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).run === 'function' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).get === 'function' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).all === 'function' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).exec === 'function' &&
      typeof (dbPathOrOptions as IDatabaseAdapter).close === 'function'
    ) {
      // Custom adapter (e.g. CloudflareDurableObjectAdapter)
      super(dbPathOrOptions as IDatabaseAdapter, options);
    } else {
      super(new NodeSqliteAdapter(dbPathOrOptions as string | MongoLiteClientOptions), options);
    }
  }

  /**
   * Replicates every insert, update and delete in this database to an upstream
   * MongoDB deployment.
   *
   * Changes are captured by SQLite triggers into a durable outbox inside this
   * database, in the same transaction as the write itself, then streamed
   * upstream in batches. Replication survives process restarts and upstream
   * outages: the outbox holds the backlog and a checkpoint records exactly how
   * far it got.
   *
   * Requires the optional `mongodb` peer dependency.
   *
   * @example
   * ```typescript
   * const sync = client.syncToMongo({
   *   connectionString: 'mongodb+srv://user:pass@cluster.example.com/app',
   *   collections: ['users', 'orders'],
   * });
   *
   * sync.on('error', (err) => console.error('replication degraded:', err));
   * await sync.start();
   *
   * // …later, on shutdown
   * await sync.stop({ flush: true });
   * ```
   */
  syncToMongo(options: MongoSyncOptions): SyncReplicator {
    const {
      connectionString,
      database,
      writeConcern,
      driverOptions,
      driver,
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
      ...syncOptions
    } = options;

    const sink = new MongoUpstreamSink({
      connectionString,
      database,
      writeConcern,
      driverOptions,
      driver,
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
      idMapping: syncOptions.idMapping,
    });

    return this.createSync(sink, syncOptions);
  }
}
