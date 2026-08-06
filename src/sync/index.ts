export { SyncReplicator } from './replicator.js';
export {
  SyncOutbox,
  OUTBOX_TABLE,
  STATE_TABLE,
  DEAD_LETTER_TABLE,
  SYNC_OBJECT_PREFIX,
} from './outbox.js';
export { MongoUpstreamSink } from './mongoSink.js';
export type { MongoSinkOptions, MongoUpstreamAuth } from './mongoSink.js';
export type {
  SyncApplyFailure,
  SyncApplyResult,
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
