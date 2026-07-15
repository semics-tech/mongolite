import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { DocumentWithId } from '../../../src/types.js';
import type { ParityBackend } from './backend.js';
import type { ParityOperation } from './types.js';

export async function startMongoMemoryServer(): Promise<{ uri: string; stop: () => Promise<void> }> {
  const version = process.env.MONGOMS_VERSION;
  const mongod = await MongoMemoryServer.create(version ? { binary: { version } } : undefined);
  return {
    uri: mongod.getUri(),
    stop: () => mongod.stop(),
  };
}

export function createMongoBackend(uri: string, dbName: string): ParityBackend {
  const client = new MongoClient(uri);
  let db: Db | null = null;

  const ensureConnected = async (): Promise<Db> => {
    if (!db) {
      await client.connect();
      db = client.db(dbName);
    }
    return db;
  };

  return {
    name: 'mongodb',

    async seed(collectionName, docs) {
      if (docs.length === 0) return;
      const database = await ensureConnected();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await database.collection(collectionName).insertMany(docs as any[]);
    },

    async run(collectionName, op: ParityOperation<DocumentWithId>) {
      const database = await ensureConnected();
      const coll = database.collection(collectionName);

      switch (op.kind) {
        case 'find': {
          let cursor = coll.find(op.filter ?? {}, { projection: op.projection });
          if (op.sort) cursor = cursor.sort(op.sort);
          if (op.skip !== undefined) cursor = cursor.skip(op.skip);
          if (op.limit !== undefined) cursor = cursor.limit(op.limit);
          return (await cursor.toArray()) as unknown as Record<string, unknown>[];
        }
        case 'findOne': {
          const doc = await coll.findOne(op.filter ?? {}, { projection: op.projection });
          return doc ? [doc as unknown as Record<string, unknown>] : [];
        }
        case 'updateOne': {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await coll.updateOne(op.filter as any, op.update as any);
          return [];
        }
        case 'updateMany': {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await coll.updateMany(op.filter as any, op.update as any);
          return [];
        }
        case 'aggregate': {
          return coll.aggregate(op.pipeline).toArray() as Promise<Record<string, unknown>[]>;
        }
      }
    },

    async dropCollection(collectionName) {
      const database = await ensureConnected();
      const exists = await database.listCollections({ name: collectionName }).hasNext();
      if (exists) await database.collection(collectionName).drop();
    },

    async close() {
      await client.close();
    },
  };
}
