/**
 * Server-side entry point: receives sync messages from a MongoLite client and applies
 * them to MongoDB.
 *
 * Install this on the API that sits in front of your database, for deployments where
 * the local instance cannot reach MongoDB directly.
 *
 * ```ts
 * import { MongoClient } from 'mongodb';
 * import { createSyncReceiver } from '@semics-tech/mongolite/server';
 *
 * const mongo = await new MongoClient(process.env.MONGO_URL!).connect();
 * const receiver = createSyncReceiver({
 *   client: mongo,
 *   database: 'app',
 *   allowedCollections: ['users', 'orders'],
 * });
 *
 * app.post('/sync/app/_sync', async (req, res) => {
 *   const result = await receiver.apply(req.body);
 *   res.status(result.status).type('application/json').send(result.body);
 * });
 * ```
 *
 * This module imports nothing SQLite-related, so it is safe to install on a server that
 * has no local database of its own.
 */
import { buildWriteCommand } from './sync/commands.js';
import type { MongoWriteCommand } from './sync/commands.js';
import { executeWrites, fetchDocuments } from './sync/mongoExecutor.js';
import type { PreparedWrite } from './sync/mongoExecutor.js';
import {
  SYNC_PROTOCOL_VERSION,
  SyncProtocolError,
  decodeBody,
  encodeBody,
  parseApplyRequest,
  parseFetchRequest,
} from './sync/protocol.js';
import type { MongoClientLike, MongoDbLike, SyncIdMapping, SyncOperation } from './sync/types.js';

export { SYNC_PROTOCOL_VERSION, SyncProtocolError } from './sync/protocol.js';
export type {
  SyncApplyRequest,
  SyncApplyResponse,
  SyncFetchRequest,
  SyncFetchResponse,
  WireOperation,
} from './sync/protocol.js';
export type { SyncApplyConflict, SyncApplyFailure, SyncOperation } from './sync/types.js';

/** Context handed to {@link SyncReceiverOptions.verifyRequest}. */
export interface SyncRequestContext {
  /** Replicator name the client reported. Advisory — clients choose it themselves. */
  replicator: string;
  /** Collections this batch touches, after validation. */
  collections: string[];
  /** Number of operations in the batch. */
  operationCount: number;
}

export interface SyncReceiverOptions {
  /** A connected MongoDB client. The receiver never opens or closes it. */
  client: MongoClientLike;

  /** Target database. Defaults to the client's default database. */
  database?: string;

  /**
   * Collections a client is permitted to write.
   *
   * Strongly recommended. Without it, any client that can reach this endpoint can write
   * to **every** collection in the database, including ones sync was never meant to
   * touch.
   */
  allowedCollections?: string[];

  /**
   * Authorise a request before anything is applied. Throw, or return `false`, to reject
   * it with 403.
   *
   * This is the receiver's own hook; it does not replace whatever authentication the
   * surrounding API already performs.
   */
  verifyRequest?: (context: SyncRequestContext) => Promise<boolean | void> | boolean | void;

  /**
   * Execute the command the client sent rather than rebuilding it locally.
   * Defaults to `false`, and should stay that way on any endpoint reachable by a
   * client you do not fully control.
   *
   * A receiver that forwards client-supplied command documents to MongoDB will execute
   * whatever it is given — an update with arbitrary operators, a filter matching far
   * more than one document. Rebuilding from the operation's fields produces an identical
   * command for well-behaved clients while making the abusive case unrepresentable.
   */
  trustClientCommands?: boolean;

  /** Maximum operations accepted in one batch. Defaults to `1000`. */
  maxOperations?: number;

  /** See {@link SyncIdMapping}. Must match the client. Defaults to `'auto'`. */
  idMapping?: SyncIdMapping;

  /** Conditional writes against `_v`. Must match the client. Defaults to `true`. */
  versioning?: boolean;

  /** Write concern for applied batches. Defaults to `{ w: 'majority' }`. */
  writeConcern?: Record<string, unknown>;

  /**
   * `ObjectId` implementation, normally the one from the `mongodb` driver you are
   * already using so BSON instances match the connection. Defaults to `bson`'s.
   */
  ObjectId?: { new (id: string): unknown; isValid(id: string): boolean };
}

/** A response ready to be written to the wire. */
export interface SyncHttpResponse {
  status: number;
  /** Canonical Extended JSON. */
  body: string;
  headers: Record<string, string>;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export class SyncReceiver {
  private readonly db: MongoDbLike;

  constructor(private readonly options: SyncReceiverOptions) {
    if (!options.client) throw new Error('createSyncReceiver requires a connected `client`.');
    this.db = options.client.db(options.database);
  }

  /**
   * Applies a batch of operations.
   *
   * @param body The raw request body — a string, or an already-parsed object.
   * @returns Status and Extended JSON body to send back.
   */
  async apply(body: string | Record<string, unknown>): Promise<SyncHttpResponse> {
    try {
      const decoded = decodeBody<Record<string, unknown>>(body);
      const { replicator, operations } = parseApplyRequest(decoded);

      const maxOperations = this.options.maxOperations ?? 1000;
      if (operations.length > maxOperations) {
        throw new SyncProtocolError(
          `Batch of ${operations.length} exceeds the limit of ${maxOperations}`,
          413
        );
      }

      const collections = [...new Set(operations.map((op) => op.collection))];
      this.assertCollectionsAllowed(collections);

      await this.authorise({ replicator, collections, operationCount: operations.length });

      const writes: PreparedWrite[] = operations.map((op, index) => ({
        index,
        op,
        command: this.commandFor(op, decoded, index),
      }));

      const result = await executeWrites(this.db, writes, {
        writeConcern: this.options.writeConcern ?? { w: 'majority' },
        versioning: this.options.versioning ?? true,
        idMapping: this.options.idMapping,
        ObjectId: this.options.ObjectId,
      });

      return this.ok({
        protocol: SYNC_PROTOCOL_VERSION,
        applied: result.applied,
        failures: result.failures,
        conflicts: result.conflicts,
      });
    } catch (err) {
      return this.error(err);
    }
  }

  /** Reads documents back by `_id`, so a client can refresh its shadow after a conflict. */
  async fetch(body: string | Record<string, unknown>): Promise<SyncHttpResponse> {
    try {
      const { collection, documentIds } = parseFetchRequest(
        decodeBody<Record<string, unknown>>(body)
      );

      this.assertCollectionsAllowed([collection]);
      await this.authorise({
        replicator: 'fetch',
        collections: [collection],
        operationCount: documentIds.length,
      });

      const documents = await fetchDocuments(
        this.db,
        collection,
        documentIds,
        this.options.idMapping,
        this.options.ObjectId
      );

      return this.ok({ protocol: SYNC_PROTOCOL_VERSION, documents });
    } catch (err) {
      return this.error(err);
    }
  }

  // ---------------------------------------------------------------- internals

  /**
   * Produces the command to execute for an operation.
   *
   * By default this **rebuilds** the command from the operation's own fields rather than
   * using whatever the client sent. For a well-behaved client the two are identical;
   * for a hostile one the difference is the whole security boundary.
   */
  private commandFor(
    op: SyncOperation,
    decoded: Record<string, unknown>,
    index: number
  ): MongoWriteCommand {
    if (this.options.trustClientCommands) {
      const wire = (decoded.operations as Array<Record<string, unknown>> | undefined)?.[index];
      const command = wire?.command;
      if (command && typeof command === 'object') return command as MongoWriteCommand;
    }

    return buildWriteCommand(op, {
      idMapping: this.options.idMapping,
      versioning: this.options.versioning ?? true,
      ObjectId: this.options.ObjectId,
    });
  }

  private assertCollectionsAllowed(collections: string[]): void {
    const allowed = this.options.allowedCollections;
    if (!allowed) return;

    const permitted = new Set(allowed);
    for (const collection of collections) {
      if (!permitted.has(collection)) {
        throw new SyncProtocolError(`Collection "${collection}" is not permitted`, 403);
      }
    }
  }

  private async authorise(context: SyncRequestContext): Promise<void> {
    if (!this.options.verifyRequest) return;
    const verdict = await this.options.verifyRequest(context);
    if (verdict === false) {
      throw new SyncProtocolError('Request rejected', 403);
    }
  }

  private ok(payload: unknown): SyncHttpResponse {
    return { status: 200, body: encodeBody(payload), headers: JSON_HEADERS };
  }

  private error(err: unknown): SyncHttpResponse {
    const status = err instanceof SyncProtocolError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);

    return {
      status,
      // 5xx bodies stay vague: an unexpected error can carry connection strings or
      // document contents, and this response goes to a client.
      body: encodeBody({
        protocol: SYNC_PROTOCOL_VERSION,
        error: status >= 500 ? 'Internal error applying sync batch' : message,
      }),
      headers: JSON_HEADERS,
    };
  }
}

/** Creates a receiver for sync messages posted by a MongoLite client. */
export function createSyncReceiver(options: SyncReceiverOptions): SyncReceiver {
  return new SyncReceiver(options);
}
