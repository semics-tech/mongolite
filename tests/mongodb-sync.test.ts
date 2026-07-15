import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index.js';
import { MongoDBSyncPlugin, createMongoDBSyncPlugin } from '../src/plugins/mongodbSync.js';
import type { MongoDBSyncOptions } from '../src/plugins/mongodbSync.js';

// Mock MongoDB client for testing
const mockMongoDb = {
  collection: (name: string) => ({
    insertOne: async (doc: any) => ({ insertedId: doc._id }),
    insertMany: async (docs: any[]) => ({ insertedIds: docs.map((d) => d._id) }),
    updateMany: async (filter: any, update: any) => ({ modifiedCount: 1 }),
    deleteMany: async (filter: any) => ({ deletedCount: 1 }),
    find: (filter: any) => ({
      toArray: async () => [{ _id: 'test-id', name: 'test' }],
    }),
  }),
};

const mockMongoClient = {
  connect: async () => {},
  close: async () => {},
  db: (name: string) => mockMongoDb,
};

// Mock the mongodb module
const originalImport = global.import;

describe('MongoDB Sync Plugin', () => {
  let client: MongoLite;
  let syncPlugin: MongoDBSyncPlugin;
  let mockOperations: any[] = [];

  beforeEach(async () => {
    // Mock dynamic import of mongodb
    global.import = async (module: string) => {
      if (module === 'mongodb') {
        return {
          MongoClient: class MockMongoClient {
            constructor(connectionString: string) {
              return mockMongoClient;
            }
            static connect = mockMongoClient.connect;
            static close = mockMongoClient.close;
            static db = mockMongoClient.db;
          },
        };
      }
      return originalImport(module);
    };

    mockOperations = [];

    // Create mock collection methods that track operations
    const originalCollection = mockMongoDb.collection;
    mockMongoDb.collection = (name: string) => {
      const collection = originalCollection(name);
      return {
        ...collection,
        insertOne: async (doc: any) => {
          mockOperations.push({ type: 'insertOne', collection: name, doc });
          return { insertedId: doc._id };
        },
        insertMany: async (docs: any[]) => {
          mockOperations.push({ type: 'insertMany', collection: name, docs });
          return { insertedIds: docs.map((d) => d._id) };
        },
        updateMany: async (filter: any, update: any) => {
          mockOperations.push({ type: 'updateMany', collection: name, filter, update });
          return { modifiedCount: 1 };
        },
        deleteMany: async (filter: any) => {
          mockOperations.push({ type: 'deleteMany', collection: name, filter });
          return { deletedCount: 1 };
        },
        find: (filter: any) => ({
          toArray: async () => [{ _id: 'test-id', name: 'test' }],
        }),
      };
    };
  });

  afterEach(async () => {
    global.import = originalImport;
    if (client) {
      await client.close();
    }
    if (syncPlugin) {
      await syncPlugin.disconnect();
    }
  });

  test('should create sync plugin with minimal options', async () => {
    const options: MongoDBSyncOptions = {
      connectionString: 'mongodb://localhost:27017/test',
    };

    syncPlugin = await createMongoDBSyncPlugin(options);
    assert.ok(syncPlugin instanceof MongoDBSyncPlugin);
    assert.strictEqual(syncPlugin.connected, true);
  });

  test('should create sync plugin with all options', async () => {
    const options: MongoDBSyncOptions = {
      connectionString: 'mongodb://localhost:27017/test',
      databaseName: 'custom_db',
      enableDirtyReads: true,
      verbose: true,
      batchSize: 50,
      queueTimeoutMs: 500,
      retryConfig: {
        maxRetries: 5,
        initialDelayMs: 500,
        maxDelayMs: 5000,
      },
    };

    syncPlugin = await createMongoDBSyncPlugin(options);
    assert.ok(syncPlugin instanceof MongoDBSyncPlugin);
    assert.strictEqual(syncPlugin.connected, true);
  });

  test('should integrate with MongoLite client', async () => {
    client = new MongoLite({
      filePath: ':memory:',
      mongodbSync: {
        connectionString: 'mongodb://localhost:27017/test',
        verbose: true,
      },
    });

    await client.connect();
    assert.ok(client.mongodbSync);
  });

  test('should sync insert operations', async () => {
    client = new MongoLite({
      filePath: ':memory:',
      mongodbSync: {
        connectionString: 'mongodb://localhost:27017/test',
        verbose: false,
      },
    });

    await client.connect();
    const collection = client.collection('users');

    const result = await collection.insertOne({ name: 'Alice', age: 30 });

    // Wait for sync to process
    await client.mongodbSync?.flush();

    assert.strictEqual(result.acknowledged, true);
    assert.ok(result.insertedId);
    assert.strictEqual(mockOperations.length, 1);
    assert.strictEqual(mockOperations[0].type, 'insertOne');
    assert.strictEqual(mockOperations[0].collection, 'users');
    assert.strictEqual(mockOperations[0].doc.name, 'Alice');
  });

  test('should sync update operations', async () => {
    client = new MongoLite({
      filePath: ':memory:',
      mongodbSync: {
        connectionString: 'mongodb://localhost:27017/test',
        verbose: false,
      },
    });

    await client.connect();
    const collection = client.collection('users');

    // Insert first
    await collection.insertOne({ name: 'Bob', age: 25 });

    // Update
    const updateResult = await collection.updateOne({ name: 'Bob' }, { $set: { age: 26 } });

    // Wait for sync to process
    await client.mongodbSync?.flush();

    assert.strictEqual(updateResult.modifiedCount, 1);

    // Should have both insert and update operations
    const updateOps = mockOperations.filter((op) => op.type === 'updateMany');
    assert.strictEqual(updateOps.length, 1);
    assert.strictEqual(updateOps[0].collection, 'users');
  });

  test('should sync delete operations', async () => {
    client = new MongoLite({
      filePath: ':memory:',
      mongodbSync: {
        connectionString: 'mongodb://localhost:27017/test',
        verbose: false,
      },
    });

    await client.connect();
    const collection = client.collection('users');

    // Insert first
    await collection.insertOne({ name: 'Charlie', age: 35 });

    // Delete
    const deleteResult = await collection.deleteOne({ name: 'Charlie' });

    // Wait for sync to process
    await client.mongodbSync?.flush();

    assert.strictEqual(deleteResult.deletedCount, 1);

    // Should have both insert and delete operations
    const deleteOps = mockOperations.filter((op) => op.type === 'deleteMany');
    assert.strictEqual(deleteOps.length, 1);
    assert.strictEqual(deleteOps[0].collection, 'users');
  });

  test('should sync insertMany operations', async () => {
    client = new MongoLite({
      filePath: ':memory:',
      mongodbSync: {
        connectionString: 'mongodb://localhost:27017/test',
        verbose: false,
      },
    });

    await client.connect();
    const collection = client.collection('users');

    const docs = [
      { name: 'User1', age: 20 },
      { name: 'User2', age: 25 },
      { name: 'User3', age: 30 },
    ];

    const results = await collection.insertMany(docs);

    // Wait for sync to process
    await client.mongodbSync?.flush();

    assert.strictEqual(results.insertedCount, 3);

    // Should have 3 individual insert operations
    const insertOps = mockOperations.filter((op) => op.type === 'insertOne');
    assert.strictEqual(insertOps.length, 3);
  });

  test('should support dirty reads', async () => {
    const options: MongoDBSyncOptions = {
      connectionString: 'mongodb://localhost:27017/test',
      enableDirtyReads: true,
    };

    syncPlugin = await createMongoDBSyncPlugin(options);

    const results = await syncPlugin.dirtyRead('users', { name: 'test' });
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'test');
  });

  test('should reject dirty reads when disabled', async () => {
    const options: MongoDBSyncOptions = {
      connectionString: 'mongodb://localhost:27017/test',
      enableDirtyReads: false,
    };

    syncPlugin = await createMongoDBSyncPlugin(options);

    await assert.rejects(
      () => syncPlugin.dirtyRead('users', { name: 'test' }),
      /Dirty reads are not enabled/
    );
  });

  test('should handle sync errors gracefully', async () => {
    // Mock a failing MongoDB operation
    const originalCollection = mockMongoDb.collection;
    mockMongoDb.collection = (name: string) => ({
      insertOne: async () => {
        throw new Error('MongoDB connection failed');
      },
      insertMany: async () => {
        throw new Error('MongoDB connection failed');
      },
      updateMany: async () => {
        throw new Error('MongoDB connection failed');
      },
      deleteMany: async () => {
        throw new Error('MongoDB connection failed');
      },
      find: () => ({ toArray: async () => [] }),
    });

    client = new MongoLite({
      filePath: ':memory:',
      mongodbSync: {
        connectionString: 'mongodb://localhost:27017/test',
        verbose: false,
      },
    });

    await client.connect();
    const collection = client.collection('users');

    // Operations should still succeed locally even if sync fails
    const result = await collection.insertOne({ name: 'Alice', age: 30 });
    assert.strictEqual(result.acknowledged, true);

    // Restore original collection for cleanup
    mockMongoDb.collection = originalCollection;
  });

  test('should provide queue status', async () => {
    syncPlugin = await createMongoDBSyncPlugin({
      connectionString: 'mongodb://localhost:27017/test',
    });

    const status = syncPlugin.getQueueStatus();
    assert.strictEqual(typeof status.queueLength, 'number');
    assert.strictEqual(typeof status.isProcessing, 'boolean');
    assert.strictEqual(typeof status.isConnected, 'boolean');
    assert.strictEqual(status.isConnected, true);
  });

  test('should emit events', async () => {
    syncPlugin = await createMongoDBSyncPlugin({
      connectionString: 'mongodb://localhost:27017/test',
    });

    let connectedEmitted = false;
    let syncedEmitted = false;

    syncPlugin.on('connected', () => {
      connectedEmitted = true;
    });

    syncPlugin.on('synced', () => {
      syncedEmitted = true;
    });

    // Manually trigger an insert operation to test sync event
    await syncPlugin.onInsert('test', { name: 'test' }, { acknowledged: true, insertedId: 'test' });
    await syncPlugin.flush();

    // Note: connected event was already emitted during initialization
    assert.strictEqual(syncedEmitted, true);
  });

  test('should disconnect cleanly', async () => {
    syncPlugin = await createMongoDBSyncPlugin({
      connectionString: 'mongodb://localhost:27017/test',
    });

    assert.strictEqual(syncPlugin.connected, true);

    await syncPlugin.disconnect();

    assert.strictEqual(syncPlugin.connected, false);
  });
});
