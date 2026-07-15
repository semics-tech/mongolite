import type {
  DocumentWithId,
  Filter,
  Projection,
  SortCriteria,
  UpdateFilter,
  AggregationPipeline,
} from '../../../src/types.js';

export type ParityOperation<T extends DocumentWithId> =
  | { kind: 'find'; filter?: Filter<T>; projection?: Projection<T>; sort?: SortCriteria<T>; limit?: number; skip?: number }
  | { kind: 'findOne'; filter?: Filter<T>; projection?: Projection<T> }
  | { kind: 'updateOne'; filter: Filter<T>; update: UpdateFilter<T> }
  | { kind: 'updateMany'; filter: Filter<T>; update: UpdateFilter<T> }
  | { kind: 'aggregate'; pipeline: AggregationPipeline };

export interface ParityScenario<T extends DocumentWithId = DocumentWithId> {
  /** Human-readable name, used as the test/describe title. */
  description: string;
  /** Seed documents. Use explicit deterministic `_id`s so result comparison doesn't need ObjectId normalization. */
  seedDocs: T[];
  operation: ParityOperation<T>;
  /**
   * How to compare outcomes for write operations. 'operationResult' compares the operation's
   * own return value (used for find/findOne/aggregate). 'refetchAll' re-reads the whole
   * collection after the write and compares that instead, since ack shapes (e.g. matchedCount
   * vs raw driver result) aren't meaningfully comparable between backends.
   */
  verifyVia?: 'operationResult' | 'refetchAll';
  /**
   * Escape hatch for a documented, intentional divergence from real MongoDB. The scenario still
   * runs and still asserts something — that mongolite's result differs from real Mongo's — so
   * if the divergence disappears (bug fixed) or the real behavior changes, this fails loudly
   * instead of silently rotting.
   */
  knownDivergence?: { reason: string };
}
