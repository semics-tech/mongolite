/**
 * Builds the MongoDB write commands that realise a {@link SyncOperation}.
 *
 * This lives on its own because three places must agree on it byte for byte: the
 * direct MongoDB sink, the HTTP sink that ships commands to a remote API, and the
 * receiver on the far side that applies them. If any of the three built its own
 * commands they would drift, and the drift would show up as data loss rather than as a
 * test failure.
 */
import { ObjectId as BsonObjectId } from 'bson';
import type { SyncIdMapping, SyncOperation } from './types.js';

/** Field carrying the optimistic-concurrency version on upstream documents. */
export const VERSION_FIELD = '_v';

/** Field carrying the server-stamped last-write time on upstream documents. */
export const UPDATED_AT_FIELD = '_updatedAt';

/** A single entry in a `bulkWrite` array. */
export type MongoWriteCommand = Record<string, unknown>;

/** Constructs an upstream `_id` value from MongoLite's string id. */
export interface ObjectIdFactory {
  new (id: string): unknown;
  isValid(id: string): boolean;
}

export interface BuildCommandOptions {
  /** See {@link SyncIdMapping}. Defaults to `'auto'`. */
  idMapping?: SyncIdMapping;
  /** Guard writes with a conditional update against `_v`. Defaults to `true`. */
  versioning?: boolean;
  /**
   * `ObjectId` implementation to use. The direct sink passes the driver's so BSON
   * instances match the connection that will serialise them; the HTTP sink uses the
   * one from `bson`, which Extended JSON encodes as `{"$oid": …}` for the wire.
   */
  ObjectId?: ObjectIdFactory;
}

/** True when this operation asserts a specific upstream revision. */
export function isConditional(op: SyncOperation): boolean {
  return op.baseVersion !== null && op.baseVersion !== undefined;
}

/** `_id` is the identity; `_v`/`_updatedAt` are managed by the update itself. */
export function isReservedPath(path: string): boolean {
  const root = path.split('.')[0];
  return root === '_id' || root === VERSION_FIELD || root === UPDATED_AT_FIELD;
}

export function stripReservedFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isReservedPath(key)));
}

/** Reads `_v` off an upstream document, tolerating its absence. */
export function readVersion(document: Record<string, unknown> | undefined): number | null {
  if (!document) return null;
  const raw = document[VERSION_FIELD];
  return typeof raw === 'number' ? raw : null;
}

/**
 * MongoLite stores `_id` as a string. Converting ObjectId-shaped ids back to real
 * `ObjectId`s keeps replicated documents indistinguishable from ones written by a
 * native MongoDB client.
 */
export function toUpstreamId(
  documentId: string,
  idMapping: SyncIdMapping = 'auto',
  ObjectId: ObjectIdFactory = BsonObjectId as unknown as ObjectIdFactory
): unknown {
  if (idMapping === 'string') return documentId;
  try {
    return ObjectId.isValid(documentId) && /^[0-9a-fA-F]{24}$/.test(documentId)
      ? new ObjectId(documentId)
      : documentId;
  } catch {
    return documentId;
  }
}

/**
 * Builds the upstream write for one operation.
 *
 * Every form is idempotent by `_id`, which is what makes at-least-once delivery safe:
 * replaying a batch reproduces the same upstream state.
 *
 * With versioning on, writes are additionally *conditional* on the document still being
 * at the version we last saw. That is the difference between "my change is newer, so it
 * wins" — which cannot detect a lost update — and "I am replacing exactly the revision
 * I read", which can.
 */
export function buildWriteCommand(
  op: SyncOperation,
  options: BuildCommandOptions = {}
): MongoWriteCommand {
  const { idMapping = 'auto', versioning = true, ObjectId } = options;
  const _id = toUpstreamId(op.documentId, idMapping, ObjectId);

  if (op.type === 'delete') {
    const filter = isConditional(op) ? { _id, [VERSION_FIELD]: op.baseVersion } : { _id };
    return { deleteOne: { filter } };
  }

  if (!versioning) {
    // The local database is treated as authoritative: replace wholesale, so a field
    // deleted locally disappears upstream too.
    return {
      replaceOne: { filter: { _id }, replacement: { ...(op.document ?? {}), _id }, upsert: true },
    };
  }

  // Never been upstream: create it, and let a duplicate key tell us we lost the race to
  // create. `$setOnInsert` alone means an existing document is left untouched.
  if (!isConditional(op)) {
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
