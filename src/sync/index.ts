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
