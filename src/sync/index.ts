export { SyncReplicator } from './replicator.js';
export {
  SyncOutbox,
  OUTBOX_TABLE,
  STATE_TABLE,
  DEAD_LETTER_TABLE,
  SYNC_OBJECT_PREFIX,
} from './outbox.js';
export { MongoUpstreamSink, VERSION_FIELD, UPDATED_AT_FIELD } from './mongoSink.js';
export type { MongoSinkOptions, MongoUpstreamAuth } from './mongoSink.js';
export { HttpUpstreamSink, SyncRequestRejected } from './httpSink.js';
export type { HttpSinkOptions, FetchLike } from './httpSink.js';
export { buildWriteCommand, toUpstreamId } from './commands.js';
export type { MongoWriteCommand, BuildCommandOptions, ObjectIdFactory } from './commands.js';
export { executeWrites, fetchDocuments } from './mongoExecutor.js';
export type { PreparedWrite, ExecuteOptions } from './mongoExecutor.js';
export {
  SYNC_PROTOCOL_VERSION,
  SyncProtocolError,
  encodeBody,
  decodeBody,
  toWireOperation,
  fromWireOperation,
} from './protocol.js';
export type {
  SyncApplyRequest,
  SyncApplyResponse,
  SyncFetchRequest,
  SyncFetchResponse,
  WireOperation,
} from './protocol.js';
export { SyncShadow, SHADOW_TABLE, projectToLocalShape } from './shadow.js';
export type { ShadowEntry } from './shadow.js';
export { computeDiff, applyDiff, isEmptyDiff, deepEqual } from './diff.js';
export type { DocumentDiff } from './diff.js';
export type {
  MongoBulkWriteResultLike,
  SyncApplyConflict,
  SyncApplyFailure,
  SyncApplyResult,
  SyncConflictContext,
  SyncConflictReason,
  SyncConflictResolution,
  SyncCollectionOptions,
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
} from './types.js';
