import type { DocumentWithId } from '../../../src/types.js';
import type { ParityOperation } from './types.js';

export interface ParityBackend {
  readonly name: 'mongolite' | 'mongodb';
  seed(collectionName: string, docs: DocumentWithId[]): Promise<void>;
  run(collectionName: string, op: ParityOperation<DocumentWithId>): Promise<Record<string, unknown>[]>;
  dropCollection(collectionName: string): Promise<void>;
  close(): Promise<void>;
}
