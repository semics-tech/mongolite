/**
 * The wire format shared by the HTTP sink and the receiver that applies its messages.
 *
 * Both halves live in this package on purpose: a client and a receiver that disagree
 * about the protocol lose data quietly, so they are versioned and released together.
 *
 * Bodies are **relaxed Extended JSON**, not plain JSON. Plain JSON would flatten
 * `ObjectId` to a string and `Date` to an ISO string in transit — degrading exactly the
 * BSON types the sync design goes to some trouble to preserve, and doing it invisibly.
 *
 * Relaxed rather than canonical, because canonical encodes every number as `$numberInt`
 * or `$numberDouble` and revives it as a BSON wrapper object. A local `age: 31` would
 * then be written upstream as an `Int32` over HTTP but as a double over a direct
 * connection — the same change producing different stored types depending on transport.
 * Relaxed keeps plain numbers plain while still preserving `Date`, `ObjectId`, `Binary`
 * and `Decimal128`. The cost is that 64-bit integers beyond 2^53 lose precision, which
 * the local store could not represent anyway.
 */
import { EJSON } from 'bson';
import type { MongoWriteCommand } from './commands.js';
import type { SyncApplyConflict, SyncApplyFailure, SyncOperation } from './types.js';

/**
 * Protocol version, sent with every request.
 *
 * A receiver rejects a version it does not understand rather than guessing, so an
 * upgraded client talking to an old server fails loudly instead of silently writing
 * something unintended.
 */
export const SYNC_PROTOCOL_VERSION = 1;

/** Content type used for request and response bodies. */
export const SYNC_CONTENT_TYPE = 'application/json';

/** One operation as it crosses the wire. */
export interface WireOperation {
  /** Upstream collection name, after any renaming. */
  collection: string;
  documentId: string;
  type: 'upsert' | 'delete';
  /** Upstream `_v` this operation asserts against; `null` when the document is new. */
  baseVersion?: number | null;
  /** Field-level change, when a shadow existed to diff against. */
  diff?: { set: Record<string, unknown>; unset: string[] };
  /** Full document, for creates and for the unversioned mode. */
  document?: Record<string, unknown>;
  /**
   * The MongoDB command this operation resolves to.
   *
   * Sent so a forwarding API can inspect or pass it straight through. The receiver
   * **rebuilds it** from the fields above rather than executing it, unless explicitly
   * configured to trust the client — see `createSyncReceiver`.
   */
  command?: MongoWriteCommand;
}

/** Body of a write request. */
export interface SyncApplyRequest {
  protocol: number;
  /** Replicator name, for server-side logging and rate limiting. */
  replicator?: string;
  operations: WireOperation[];
}

/** Body of a write response — mirrors `SyncApplyResult`. */
export interface SyncApplyResponse {
  protocol: number;
  applied: number;
  failures?: SyncApplyFailure[];
  conflicts?: SyncApplyConflict[];
}

/** Body of a read-back request, used to refresh a shadow after a conflict. */
export interface SyncFetchRequest {
  protocol: number;
  collection: string;
  documentIds: string[];
}

/** Body of a read-back response. */
export interface SyncFetchResponse {
  protocol: number;
  documents: Record<string, unknown>[];
}

/** Raised when a payload is malformed or speaks a version we do not implement. */
export class SyncProtocolError extends Error {
  constructor(
    message: string,
    /** Suggested HTTP status for a receiver to return. */
    readonly status = 400
  ) {
    super(message);
    this.name = 'SyncProtocolError';
  }
}

/** Serialises a body to relaxed Extended JSON. */
export function encodeBody(value: unknown): string {
  return EJSON.stringify(value, { relaxed: true });
}

/** Parses a relaxed Extended JSON body back into BSON-typed values. */
export function decodeBody<T>(raw: string | Record<string, unknown>): T {
  if (typeof raw !== 'string') {
    // Some frameworks parse JSON before we see it. Re-encoding is the only way to get
    // Extended JSON revived into real BSON types.
    return EJSON.parse(JSON.stringify(raw), { relaxed: true }) as T;
  }
  try {
    return EJSON.parse(raw, { relaxed: true }) as T;
  } catch (err) {
    throw new SyncProtocolError(
      `Malformed sync payload: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Converts an internal operation into its wire form. */
export function toWireOperation(op: SyncOperation, command?: MongoWriteCommand): WireOperation {
  const wire: WireOperation = {
    collection: op.collection,
    documentId: op.documentId,
    type: op.type,
  };

  if (op.baseVersion !== undefined) wire.baseVersion = op.baseVersion;
  if (op.diff) wire.diff = op.diff;
  if (op.document) wire.document = op.document;
  if (command) wire.command = command;

  return wire;
}

/**
 * Validates a wire operation and converts it back into an internal one.
 *
 * Everything reaching a receiver is untrusted input, so this checks shape rather than
 * assuming it. `index` and `sourceCollection` are reconstructed locally — a client does
 * not get to choose them.
 */
export function fromWireOperation(value: unknown, index: number): SyncOperation {
  if (typeof value !== 'object' || value === null) {
    throw new SyncProtocolError(`operations[${index}] is not an object`);
  }

  const wire = value as Record<string, unknown>;

  if (typeof wire.collection !== 'string' || wire.collection.length === 0) {
    throw new SyncProtocolError(`operations[${index}].collection must be a non-empty string`);
  }
  if (typeof wire.documentId !== 'string' || wire.documentId.length === 0) {
    throw new SyncProtocolError(`operations[${index}].documentId must be a non-empty string`);
  }
  if (wire.type !== 'upsert' && wire.type !== 'delete') {
    throw new SyncProtocolError(`operations[${index}].type must be "upsert" or "delete"`);
  }
  if (
    wire.baseVersion !== undefined &&
    wire.baseVersion !== null &&
    typeof wire.baseVersion !== 'number'
  ) {
    throw new SyncProtocolError(`operations[${index}].baseVersion must be a number or null`);
  }

  const op: SyncOperation = {
    collection: wire.collection,
    sourceCollection: wire.collection,
    documentId: wire.documentId,
    type: wire.type,
    outboxId: index,
    baseVersion: (wire.baseVersion as number | null | undefined) ?? null,
  };

  if (isPlainRecord(wire.document)) op.document = wire.document;

  if (wire.diff !== undefined) {
    if (!isPlainRecord(wire.diff)) {
      throw new SyncProtocolError(`operations[${index}].diff must be an object`);
    }
    const set = wire.diff.set;
    const unset = wire.diff.unset;
    if (!isPlainRecord(set) || !Array.isArray(unset) || unset.some((p) => typeof p !== 'string')) {
      throw new SyncProtocolError(
        `operations[${index}].diff must be { set: object, unset: string[] }`
      );
    }
    op.diff = { set, unset: unset as string[] };
  }

  if (op.type === 'upsert' && !op.diff && !op.document) {
    throw new SyncProtocolError(`operations[${index}] must carry a diff or a document`);
  }

  return op;
}

/** Validates the envelope of an apply request and returns its operations. */
export function parseApplyRequest(body: unknown): {
  replicator: string;
  operations: SyncOperation[];
} {
  const request = requireEnvelope(body);
  const operations = request.operations;

  if (!Array.isArray(operations)) {
    throw new SyncProtocolError('`operations` must be an array');
  }

  return {
    replicator: typeof request.replicator === 'string' ? request.replicator : 'unknown',
    operations: operations.map((value, index) => fromWireOperation(value, index)),
  };
}

/** Validates the envelope of a fetch request. */
export function parseFetchRequest(body: unknown): { collection: string; documentIds: string[] } {
  const request = requireEnvelope(body);

  if (typeof request.collection !== 'string' || request.collection.length === 0) {
    throw new SyncProtocolError('`collection` must be a non-empty string');
  }
  if (
    !Array.isArray(request.documentIds) ||
    request.documentIds.some((id) => typeof id !== 'string')
  ) {
    throw new SyncProtocolError('`documentIds` must be an array of strings');
  }

  return { collection: request.collection, documentIds: request.documentIds as string[] };
}

function requireEnvelope(body: unknown): Record<string, unknown> {
  if (!isPlainRecord(body)) {
    throw new SyncProtocolError('Request body must be an object');
  }
  // Coerced rather than compared strictly: a proxy that re-encodes the body could hand
  // us the version as a string or a BSON number wrapper, and refusing on that would be
  // a confusing failure for something entirely cosmetic.
  if (Number(body.protocol) !== SYNC_PROTOCOL_VERSION) {
    throw new SyncProtocolError(
      `Unsupported sync protocol ${String(body.protocol)}; this receiver implements ${SYNC_PROTOCOL_VERSION}`,
      // 426 tells the client the fix is to upgrade, not to retry.
      426
    );
  }
  return body;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
