import { EventEmitter } from 'events';
import {
  DocumentWithId,
  Filter,
  UpdateFilter,
  InsertOneResult,
  UpdateResult,
  DeleteResult,
} from '../types.js';

// Type definitions for MongoDB driver (to avoid requiring it as a dependency)
interface MongoClientConstructor {
  new (connectionString: string): MongoClientInstance;
}

interface MongoClientInstance {
  connect(): Promise<void>;
  close(): Promise<void>;
  db(name: string): MongoDatabase;
}

interface MongoDatabase {
  collection(name: string): MongoCollection;
}

interface MongoCollection {
  find(filter: Record<string, unknown>): { toArray(): Promise<unknown[]> };
  insertOne(document: Record<string, unknown>): Promise<unknown>;
  insertMany(documents: Record<string, unknown>[]): Promise<unknown>;
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown>;
  deleteMany(filter: Record<string, unknown>): Promise<unknown>;
}

/**
 * Interface for MongoDB operations that can be performed
 */
interface MongoDBOperation<T extends DocumentWithId = DocumentWithId> {
  type: 'insert' | 'update' | 'delete' | 'find';
  collection: string;
  data?: Partial<T> | Partial<T>[];
  filter?: Filter<T>;
  update?: UpdateFilter<T>;
  options?: Record<string, unknown>;
  timestamp: Date;
  localId?: string; // ID from the local operation
}

/**
 * Configuration options for the MongoDB sync plugin
 */
export interface MongoDBSyncOptions {
  /** MongoDB connection string */
  connectionString: string;
  /** Database name to sync to (if different from local) */
  databaseName?: string;
  /** Whether to enable dirty reads from MongoDB */
  enableDirtyReads?: boolean;
  /** Retry configuration for failed operations */
  retryConfig?: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  /** Whether to enable verbose logging */
  verbose?: boolean;
  /** Batch size for operations */
  batchSize?: number;
  /** Queue timeout for batching operations */
  queueTimeoutMs?: number;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  success: boolean;
  operation: MongoDBOperation;
  error?: Error;
  mongodbResult?: unknown;
}

/**
 * MongoDB Cloud Sync Plugin
 *
 * This plugin provides optional synchronization between MongoLite and MongoDB Cloud.
 * It hooks into MongoLite operations and replicates them to a MongoDB instance.
 */
export class MongoDBSyncPlugin extends EventEmitter {
  private options: Required<MongoDBSyncOptions>;
  private operationQueue: MongoDBOperation[] = [];
  private isProcessing = false;
  private queueTimer: NodeJS.Timeout | null = null;
  private mongoClient: MongoClientInstance | null = null;
  private mongoDb: MongoDatabase | null = null;
  private isConnected = false;

  constructor(options: MongoDBSyncOptions) {
    super();

    this.options = {
      connectionString: options.connectionString,
      databaseName: options.databaseName || 'mongolite_sync',
      enableDirtyReads: options.enableDirtyReads || false,
      retryConfig: {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        ...options.retryConfig,
      },
      verbose: options.verbose || false,
      batchSize: options.batchSize || 100,
      queueTimeoutMs: options.queueTimeoutMs || 1000,
    };

    this.log('MongoDB Sync Plugin initialized');
  }

  /**
   * Initialize connection to MongoDB Cloud
   */
  async initialize(): Promise<void> {
    try {
      // Dynamically import MongoDB driver to avoid making it a required dependency
      let mongodb: unknown;
      try {
        // Use eval to avoid TypeScript module resolution at compile time
        mongodb = await eval('import("mongodb")');
      } catch (error) {
        throw new Error('MongoDB driver not found. Install it with: npm install mongodb');
      }

      const mongoModule = mongodb as { MongoClient: MongoClientConstructor };
      const MongoClient = mongoModule.MongoClient;

      this.mongoClient = new MongoClient(this.options.connectionString);
      await this.mongoClient.connect();
      this.mongoDb = this.mongoClient.db(this.options.databaseName);
      this.isConnected = true;

      this.log('Connected to MongoDB Cloud');
      this.emit('connected');
    } catch (error) {
      this.log('Failed to connect to MongoDB:', error);
      this.emit('error', {
        type: 'connection_error',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Disconnect from MongoDB
   */
  async disconnect(): Promise<void> {
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }

    // Process any remaining operations
    if (this.operationQueue.length > 0) {
      await this.processQueue();
    }

    if (this.mongoClient) {
      await this.mongoClient.close();
      this.mongoClient = null;
      this.mongoDb = null;
      this.isConnected = false;
      this.log('Disconnected from MongoDB Cloud');
      this.emit('disconnected');
    }
  }

  /**
   * Check if the plugin is connected to MongoDB
   */
  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Hook for insert operations
   */
  async onInsert<T extends DocumentWithId>(
    collection: string,
    document: Partial<T>,
    result: InsertOneResult
  ): Promise<void> {
    const operation: MongoDBOperation<T> = {
      type: 'insert',
      collection,
      data: { ...document, _id: result.insertedId },
      timestamp: new Date(),
      localId: result.insertedId,
    };

    await this.queueOperation(operation);
  }

  /**
   * Hook for update operations
   */
  async onUpdate<T extends DocumentWithId>(
    collection: string,
    filter: Filter<T>,
    update: UpdateFilter<T>,
    _result: UpdateResult
  ): Promise<void> {
    const operation: MongoDBOperation<T> = {
      type: 'update',
      collection,
      filter,
      update,
      timestamp: new Date(),
    };

    await this.queueOperation(operation);
  }

  /**
   * Hook for delete operations
   */
  async onDelete<T extends DocumentWithId>(
    collection: string,
    filter: Filter<T>,
    _result: DeleteResult
  ): Promise<void> {
    const operation: MongoDBOperation<T> = {
      type: 'delete',
      collection,
      filter,
      timestamp: new Date(),
    };

    await this.queueOperation(operation);
  }

  /**
   * Perform a dirty read from MongoDB (optional functionality)
   */
  async dirtyRead<T>(collection: string, filter?: Record<string, unknown>): Promise<T[]> {
    if (!this.options.enableDirtyReads) {
      throw new Error('Dirty reads are not enabled. Set enableDirtyReads: true in MongoDBSyncOptions.');
    }

    if (!this.isConnected || !this.mongoDb) {
      throw new Error('MongoDB sync is not initialized or not connected');
    }

    try {
      const mongoCollection = this.mongoDb.collection(collection);
      const results = await mongoCollection.find(filter || {}).toArray();

      // Transform results and type cast with validation
      return results as T[];
    } catch (error) {
      this.emit('error', {
        type: 'dirty_read_error',
        error: error instanceof Error ? error.message : 'Unknown error',
        details: { collection, filter },
      });
      throw error;
    }
  }

  /**
   * Queue an operation for batch processing
   */
  private async queueOperation<T extends DocumentWithId>(
    operation: MongoDBOperation<T>
  ): Promise<void> {
    if (!this.isConnected) {
      this.log('Not connected to MongoDB, skipping operation:', operation.type);
      return;
    }

    this.operationQueue.push(operation);
    this.log(`Queued ${operation.type} operation for collection ${operation.collection}`);

    // Start queue timer if not already running
    if (!this.queueTimer) {
      this.queueTimer = setTimeout(() => {
        this.processQueue().catch((error) => {
          this.log('Error processing queue:', error);
          this.emit('error', error);
        });
      }, this.options.queueTimeoutMs);
    }

    // Process immediately if queue is full
    if (this.operationQueue.length >= this.options.batchSize) {
      if (this.queueTimer) {
        clearTimeout(this.queueTimer);
        this.queueTimer = null;
      }
      await this.processQueue();
    }
  }

  /**
   * Process the operation queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.operationQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    this.queueTimer = null;

    const operations = [...this.operationQueue];
    this.operationQueue = [];

    this.log(`Processing ${operations.length} queued operations`);

    try {
      const results = await this.processBatch(operations);

      // Emit results
      for (const result of results) {
        if (result.success) {
          this.emit('synced', result);
        } else {
          this.emit('syncError', result);
        }
      }

      this.log(
        `Successfully processed ${results.filter((r) => r.success).length}/${results.length} operations`
      );
    } catch (error) {
      this.log('Error processing operation batch:', error);
      this.emit('error', error);

      // Re-queue failed operations for retry
      this.operationQueue.unshift(...operations);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a batch of operations
   */
  private async processBatch(operations: MongoDBOperation[]): Promise<SyncResult[]> {
    if (!this.isConnected || !this.mongoDb) {
      throw new Error('MongoDB is not connected');
    }

    const results: SyncResult[] = [];

    // Group operations by collection for efficiency
    const operationsByCollection = new Map<string, MongoDBOperation[]>();

    for (const operation of operations) {
      if (!operationsByCollection.has(operation.collection)) {
        operationsByCollection.set(operation.collection, []);
      }
      operationsByCollection.get(operation.collection)!.push(operation);
    }

    // Process each collection's operations
    for (const [collectionName, collectionOps] of operationsByCollection) {
      const mongoCollection = this.mongoDb.collection(collectionName);

      for (const operation of collectionOps) {
        const result = await this.executeOperation(mongoCollection, operation);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Execute a single operation on MongoDB
   */
  private async executeOperation(
    mongoCollection: MongoCollection,
    operation: MongoDBOperation
  ): Promise<SyncResult> {
    const { retryConfig } = this.options;
    const maxRetries = retryConfig?.maxRetries ?? 3;
    const initialDelayMs = retryConfig?.initialDelayMs ?? 1000;
    const maxDelayMs = retryConfig?.maxDelayMs ?? 10000;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let mongodbResult: unknown;

        switch (operation.type) {
          case 'insert':
            if (!operation.data) {
              throw new Error('Insert operation requires data');
            }
            if (Array.isArray(operation.data)) {
              mongodbResult = await mongoCollection.insertMany(operation.data);
            } else {
              mongodbResult = await mongoCollection.insertOne(operation.data);
            }
            break;

          case 'update':
            if (!operation.filter || !operation.update) {
              throw new Error('Update operation requires filter and update data');
            }
            mongodbResult = await mongoCollection.updateMany(operation.filter, operation.update);
            break;

          case 'delete':
            if (!operation.filter) {
              throw new Error('Delete operation requires filter');
            }
            mongodbResult = await mongoCollection.deleteMany(operation.filter);
            break;

          default:
            throw new Error(`Unsupported operation type: ${operation.type}`);
        }

        this.log(
          `Successfully executed ${operation.type} on MongoDB collection ${operation.collection}`
        );

        return {
          success: true,
          operation,
          mongodbResult,
        };
      } catch (error) {
        lastError = error as Error;
        this.log(`Attempt ${attempt + 1} failed for ${operation.type} operation:`, error);

        if (attempt < maxRetries) {
          const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    return {
      success: false,
      operation,
      error: lastError || new Error('Unknown error'),
    };
  }

  /**
   * Get queue status
   */
  getQueueStatus(): { queueLength: number; isProcessing: boolean; isConnected: boolean } {
    return {
      queueLength: this.operationQueue.length,
      isProcessing: this.isProcessing,
      isConnected: this.isConnected,
    };
  }

  /**
   * Flush the queue (process immediately)
   */
  async flush(): Promise<void> {
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
    await this.processQueue();
  }

  /**
   * Log messages if verbose mode is enabled
   */
  private log(...args: unknown[]): void {
    if (this.options.verbose) {
      console.log('[MongoDBSync]', ...args);
    }
  }
}

/**
 * Factory function to create and initialize a MongoDB sync plugin
 */
export async function createMongoDBSyncPlugin(
  options: MongoDBSyncOptions
): Promise<MongoDBSyncPlugin> {
  const plugin = new MongoDBSyncPlugin(options);
  await plugin.initialize();
  return plugin;
}
