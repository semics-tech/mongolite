/**
 * Applies prepared write commands to MongoDB and classifies the outcome.
 *
 * Shared by the direct sink and by the HTTP receiver, so the subtle part has exactly
 * one implementation: **a lost compare-and-swap raises no error.** It is a silent
 * zero-match in an aggregate count, which means detecting it takes deliberate work —
 * comparing what the batch expected to change against what the server says changed, and
 * then re-reading the candidates to find out which document actually lost.
 */
import {
  isConditional,
  isReservedPath,
  readVersion,
  stripReservedFields,
  toUpstreamId,
} from './commands.js';
import { deepEqual } from './diff.js';
import type { MongoWriteCommand, ObjectIdFactory } from './commands.js';
import type {
  MongoBulkWriteResultLike,
  MongoDbLike,
  SyncApplyConflict,
  SyncApplyFailure,
  SyncApplyResult,
  SyncIdMapping,
  SyncOperation,
} from './types.js';

/**
 * MongoDB server error codes that mean "this write will never succeed" — retrying them
 * would stall the stream behind one bad document forever, so they are dead-lettered.
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

/** MongoDB's duplicate-key code. On an insert-if-absent it means we lost a create race. */
const DUPLICATE_KEY = 11000;

/** One operation paired with the command that realises it. */
export interface PreparedWrite {
  /** Index into the caller's original operations array, echoed back in results. */
  index: number;
  op: SyncOperation;
  command: MongoWriteCommand;
}

export interface ExecuteOptions {
  writeConcern?: Record<string, unknown>;
  versioning?: boolean;
  idMapping?: SyncIdMapping;
  ObjectId?: ObjectIdFactory;
}

/**
 * Runs prepared writes against a database, one `bulkWrite` per collection.
 *
 * Throws on transient failure (network, election, timeout) so the caller retries the
 * whole batch without checkpointing. Returns per-operation failures and conflicts for
 * everything it could classify.
 */
export async function executeWrites(
  db: MongoDbLike,
  writes: PreparedWrite[],
  options: ExecuteOptions = {}
): Promise<SyncApplyResult> {
  const { writeConcern = { w: 'majority' }, versioning = true, idMapping, ObjectId } = options;

  const byCollection = new Map<string, PreparedWrite[]>();
  for (const write of writes) {
    const bucket = byCollection.get(write.op.collection);
    if (bucket) bucket.push(write);
    else byCollection.set(write.op.collection, [write]);
  }

  const failures: SyncApplyFailure[] = [];
  const conflicts: SyncApplyConflict[] = [];
  let applied = 0;

  for (const [collectionName, entries] of byCollection) {
    let result: MongoBulkWriteResultLike | null = null;
    let rejected = 0;

    try {
      result = await db.collection(collectionName).bulkWrite(
        entries.map((entry) => entry.command),
        {
          // Operations within a batch touch distinct documents, so ordering buys
          // nothing and unordered lets the server parallelise.
          ordered: false,
          writeConcern,
        }
      );
    } catch (err) {
      const bulkFailures = classifyBulkError(err, entries.length);

      // A transient failure means the whole batch's fate is unknown — throw so the
      // caller retries it rather than checkpointing work that may not have landed.
      if (bulkFailures === null) throw err;

      for (const failure of bulkFailures) {
        const entry = entries[failure.index];
        if (!entry) continue;
        // A duplicate `_id` on an insert-if-absent means someone created the document
        // first — a conflict to reconcile, not a poison document. A duplicate on any
        // *other* unique index is a real constraint violation and must be dead-lettered,
        // or it would be retried forever as a phantom conflict.
        if (failure.code === DUPLICATE_KEY && isIdIndexViolation(failure)) {
          conflicts.push({ index: entry.index, reason: 'already-exists' });
        } else {
          failures.push({ index: entry.index, message: failure.message, code: failure.code });
        }
      }
      rejected = bulkFailures.length;
      result = (err as { result?: MongoBulkWriteResultLike }).result ?? null;
    }

    const landed = entries.length - rejected;
    const suspects = findMisses(entries, result, rejected, versioning);

    // `suspects` are candidates to investigate, not confirmed misses: the counts are
    // aggregate, so one short count implicates every conditional write in the batch.
    // Only the re-read says which of them actually lost, and `applied` must be reduced
    // by that number rather than by the number investigated.
    const confirmed = suspects.length
      ? await describeConflicts(db, collectionName, suspects, conflicts, idMapping, ObjectId)
      : 0;

    applied += landed - confirmed;
  }

  return {
    applied,
    failures: failures.length > 0 ? failures : undefined,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
  };
}

/**
 * Identifies operations whose conditional write may not have matched.
 *
 * `bulkWrite` reports only aggregate counts, so this compares what the batch expected
 * to change against what the server says changed. When the numbers agree, nothing was
 * missed and no per-document work is needed.
 */
function findMisses(
  entries: PreparedWrite[],
  result: MongoBulkWriteResultLike | null,
  rejected: number,
  versioning: boolean
): PreparedWrite[] {
  if (!versioning || result === null || rejected === entries.length) return [];

  const candidates = entries.filter((entry) => isConditional(entry.op));
  if (candidates.length === 0) return [];

  const writes = candidates.filter((entry) => entry.op.type !== 'delete');
  const deletes = candidates.filter((entry) => entry.op.type === 'delete');

  const acknowledgedWrites = (result.matchedCount ?? 0) + (result.upsertedCount ?? 0);
  const acknowledgedDeletes = result.deletedCount ?? 0;

  const missed: PreparedWrite[] = [];

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
 * The re-read turns an aggregate "something didn't match" into a precise, per-document
 * answer, and supplies the current server document the caller needs to reconcile.
 *
 * @returns How many candidates genuinely lost.
 */
async function describeConflicts(
  db: MongoDbLike,
  collectionName: string,
  candidates: PreparedWrite[],
  conflicts: SyncApplyConflict[],
  idMapping?: SyncIdMapping,
  ObjectId?: ObjectIdFactory
): Promise<number> {
  const ids = candidates.map((entry) => toUpstreamId(entry.op.documentId, idMapping, ObjectId));
  const current = await db
    .collection(collectionName)
    .find({ _id: { $in: ids } })
    .toArray();

  const byId = new Map(current.map((doc) => [String(doc._id), doc]));
  let confirmed = 0;

  for (const { index, op } of candidates) {
    const serverDocument = byId.get(op.documentId);
    const serverVersion = readVersion(serverDocument);

    if (op.type === 'delete') {
      // Already gone upstream is the outcome we wanted, however it happened.
      if (!serverDocument) continue;
      conflicts.push({ index, reason: 'version-mismatch', serverDocument, serverVersion });
      confirmed += 1;
      continue;
    }

    if (!serverDocument) {
      conflicts.push({ index, reason: 'missing' });
      confirmed += 1;
      continue;
    }

    // The write may have landed after all, with a different operation in the batch
    // being the one that missed.
    //
    // A version one ahead is necessary evidence but nowhere near sufficient: another
    // writer following the same protocol also bumps `_v` by exactly one, so the two
    // cases look identical from the version alone. Confirming that the document
    // actually carries our change is what tells them apart — and getting this wrong
    // silently swallows the very conflicts this machinery exists to catch.
    if (
      isConditional(op) &&
      serverVersion === (op.baseVersion as number) + 1 &&
      reflectsWrite(serverDocument, op)
    ) {
      continue;
    }

    conflicts.push({ index, reason: 'version-mismatch', serverDocument, serverVersion });
    confirmed += 1;
  }

  return confirmed;
}

/**
 * Splits a driver error into per-operation permanent failures.
 *
 * @returns The failures to dead-letter, or `null` when the error is transient and the
 * whole batch should be retried.
 */
export function classifyBulkError(
  err: unknown,
  operationCount: number
): Array<{
  index: number;
  message: string;
  code?: number | string;
  keyPattern?: Record<string, unknown>;
}> | null {
  interface RawWriteError {
    index?: number;
    errmsg?: string;
    message?: string;
    code?: number;
    keyPattern?: Record<string, unknown>;
  }

  const error = err as {
    name?: string;
    code?: number | string;
    writeErrors?: RawWriteError[];
    result?: { writeErrors?: RawWriteError[] };
    hasErrorLabel?: (label: string) => boolean;
    message?: string;
  };

  // The driver retried and still could not reach a writable primary.
  if (error.hasErrorLabel?.('RetryableWriteError')) return null;

  const writeErrors = error.writeErrors ?? error.result?.writeErrors;

  if (Array.isArray(writeErrors) && writeErrors.length > 0) {
    const failures: Array<{
      index: number;
      message: string;
      code?: number | string;
      keyPattern?: Record<string, unknown>;
    }> = [];

    for (const writeError of writeErrors) {
      const code = writeError.code;
      // An unrecognised write error might be transient (a duplicate key during a
      // failover, say), so the batch is worth retrying whole. A duplicate key is
      // handled separately by the caller, as a create race rather than a defect.
      if (code === undefined || (code !== DUPLICATE_KEY && !PERMANENT_ERROR_CODES.has(code))) {
        return null;
      }

      const index = writeError.index ?? 0;
      if (index >= operationCount) return null;

      failures.push({
        index,
        message: writeError.errmsg ?? writeError.message ?? `write error ${code}`,
        code,
        keyPattern: writeError.keyPattern,
      });
    }

    return failures;
  }

  // No per-write detail: a connection, timeout or auth error. Retry it.
  return null;
}

/**
 * True when the upstream document carries the change this operation was making.
 *
 * Only the paths the operation itself wrote are checked. That is deliberate: those are
 * the values we would have written in local JSON form, so comparing them against the
 * server is meaningful, whereas fields we never touched may hold BSON types the local
 * store cannot represent and would not compare equal.
 *
 * A false positive is possible if another writer happened to set the identical value —
 * and is harmless, since the upstream then holds what we wanted anyway.
 */
function reflectsWrite(serverDocument: Record<string, unknown>, op: SyncOperation): boolean {
  if (op.diff) {
    for (const [path, value] of Object.entries(op.diff.set)) {
      if (isReservedPath(path)) continue;
      if (!valueAtPathEquals(serverDocument, path, value)) return false;
    }
    for (const path of op.diff.unset) {
      if (isReservedPath(path)) continue;
      if (readPath(serverDocument, path) !== undefined) return false;
    }
    return true;
  }

  // Whole-document write: every field we sent should be present upstream.
  for (const [key, value] of Object.entries(stripReservedFields(op.document ?? {}))) {
    if (!valueAtPathEquals(serverDocument, key, value)) return false;
  }
  return true;
}

/**
 * Compares a value at a dotted path against what we wrote.
 *
 * The server side is flattened to local JSON shape first, so a `Date` upstream compares
 * equal to the ISO string a local write would have carried.
 */
function valueAtPathEquals(
  document: Record<string, unknown>,
  path: string,
  expected: unknown
): boolean {
  const actual = readPath(document, path);
  if (actual === undefined) return false;
  try {
    return deepEqual(JSON.parse(JSON.stringify(actual)), expected);
  } catch {
    return false;
  }
}

/** Reads a dotted path, returning `undefined` if any segment is missing. */
function readPath(document: Record<string, unknown>, path: string): unknown {
  let current: unknown = document;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * True when a duplicate-key error is about the `_id` index specifically.
 *
 * MongoDB reports the offending index in `keyPattern` (and names it in `errmsg`), which
 * is the only way to tell "someone else created this document" apart from "this document
 * violates a unique constraint on some other field".
 */
function isIdIndexViolation(failure: {
  keyPattern?: Record<string, unknown>;
  message: string;
}): boolean {
  if (failure.keyPattern) {
    const keys = Object.keys(failure.keyPattern);
    return keys.length === 1 && keys[0] === '_id';
  }
  // Older servers and some drivers only give the message; the index name appears in it.
  return /index:\s*_id_/.test(failure.message);
}

/** Reads documents back by `_id`, for refreshing a shadow after a conflict. */
export async function fetchDocuments(
  db: MongoDbLike,
  collection: string,
  documentIds: string[],
  idMapping?: SyncIdMapping,
  ObjectId?: ObjectIdFactory
): Promise<Record<string, unknown>[]> {
  if (documentIds.length === 0) return [];
  const ids = documentIds.map((id) => toUpstreamId(id, idMapping, ObjectId));
  return db
    .collection(collection)
    .find({ _id: { $in: ids } })
    .toArray();
}
