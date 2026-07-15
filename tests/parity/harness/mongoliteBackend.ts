import { MongoLite } from '../../../src/index.js';
import type { DocumentWithId } from '../../../src/types.js';
import type { ParityBackend } from './backend.js';
import type { ParityOperation } from './types.js';

export function createMongoliteBackend(): ParityBackend {
  const client = new MongoLite(':memory:');
  let connected = false;

  const ensureConnected = async (): Promise<void> => {
    if (!connected) {
      await client.connect();
      connected = true;
    }
  };

  return {
    name: 'mongolite',

    async seed(collectionName, docs) {
      await ensureConnected();
      if (docs.length === 0) return;
      await client.collection(collectionName).insertMany(docs as (Omit<DocumentWithId, '_id'> & { _id?: string })[]);
    },

    async run(collectionName, op: ParityOperation<DocumentWithId>) {
      await ensureConnected();
      const coll = client.collection(collectionName);

      switch (op.kind) {
        case 'find': {
          let cursor = coll.find(op.filter ?? {});
          if (op.projection) cursor = cursor.project(op.projection);
          if (op.sort) cursor = cursor.sort(op.sort);
          if (op.skip !== undefined) cursor = cursor.skip(op.skip);
          if (op.limit !== undefined) cursor = cursor.limit(op.limit);
          return (await cursor.toArray()) as Record<string, unknown>[];
        }
        case 'findOne': {
          const doc = await coll.findOne(op.filter ?? {}, op.projection);
          return doc ? [doc as unknown as Record<string, unknown>] : [];
        }
        case 'updateOne': {
          await coll.updateOne(op.filter, op.update);
          return [];
        }
        case 'updateMany': {
          await coll.updateMany(op.filter, op.update);
          return [];
        }
        case 'aggregate': {
          return coll.aggregate(op.pipeline).toArray();
        }
      }
    },

    async dropCollection(collectionName) {
      await ensureConnected();
      await client.collection(collectionName).drop();
    },

    async close() {
      if (connected) await client.close();
    },
  };
}
