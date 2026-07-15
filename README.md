# MongoLite

[![CI](https://github.com/semics-tech/mongolite/actions/workflows/ci.yml/badge.svg)](https://github.com/semics-tech/mongolite/actions/workflows/ci.yml)
[![NPM version](https://img.shields.io/npm/v/mongolite-ts.svg)](https://www.npmjs.com/package/mongolite-ts)
[![Codecov](https://codecov.io/gh/semics-tech/mongolite/branch/master/graph/badge.svg)](https://codecov.io/gh/semics-tech/mongolite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A MongoDB-like client backed by SQLite. Use a familiar MongoDB API with the simplicity of a local file-based database — no server required.

## Why MongoLite?

- You want a MongoDB-style API without running a MongoDB server
- You need a lightweight, embedded database for local apps, CLIs, or testing
- You want simple file-based persistence with zero infrastructure overhead

## Features

- **MongoDB-compatible API** — `insertOne`, `findOne`, `updateOne`, `deleteOne`, `find`, `aggregate`, and more
- **SQLite persistence** — single file, zero configuration, works offline
- **Automatic `_id` generation** — UUID assigned on insert if not provided
- **WAL mode** — Write-Ahead Logging for better concurrent read access
- **Rich query operators** — `$eq`, `$gt`, `$in`, `$and`, `$or`, `$elemMatch`, `$regex`, and more
- **Update operators** — `$set`, `$inc`, `$push`, `$pull`, `$addToSet`, `$mul`, and more
- **Indexing** — create, list, and drop indexes including unique and compound indexes
- **Change streams** — real-time change tracking via `collection.watch()`
- **JSON safety** — validates documents before insert and recovers from corrupted data
- **MongoDB Cloud Sync Plugin** — optional background synchronization with MongoDB Cloud for hybrid deployments
- **TypeScript** — fully typed with strict mode

## Installation

```bash
npm install mongolite-ts
```

## Quick Start

```typescript
import { MongoLite } from 'mongolite-ts';

async function main() {
  const client = new MongoLite('./myapp.sqlite');
  // Use ':memory:' for an ephemeral in-memory database

  const users = client.collection('users');

  // Insert
  const result = await users.insertOne({ name: 'Alice', age: 30 });

  // Find
  const user = await users.findOne({ name: 'Alice' });

  // Update
  await users.updateOne({ name: 'Alice' }, { $set: { age: 31 } });

  // Delete
  await users.deleteOne({ name: 'Alice' });

  await client.close();
}

main();
```

## Documentation

| Topic | Description |
|-------|-------------|
| [API Reference](./docs/API.md) | Full API docs: methods, query operators, update operators |
| [Change Streams](./docs/CHANGE_STREAMS.md) | Real-time change tracking with `collection.watch()` |
| [JSON Safety](./docs/JSON_SAFETY.md) | Document validation and corrupted data recovery |
| [Query Debugger](./docs/DEBUGGER.md) | Interactive CLI for debugging queries and inspecting SQL |
| [Benchmarks](./docs/BENCHMARKS.md) | Performance benchmarks and storage characteristics |
| [Cloudflare Durable Objects](./docs/CLOUDFLARE.md) | Using MongoLite inside a Cloudflare Durable Object |
| [MongoDB Cloud Sync Plugin](#mongodb-cloud-sync-plugin) | Optional hybrid sync between local SQLite and MongoDB Cloud |

## Backend Examples

### SQLite file (Node.js / Bun)

```typescript
import { MongoLite } from 'mongolite-ts';

const client = new MongoLite('./myapp.sqlite');
await client.connect();
const users = client.collection('users');
await users.insertOne({ name: 'Alice', age: 30 });
await client.close();
```

### In-memory (tests / ephemeral)

```typescript
import { MongoLite } from 'mongolite-ts';

const client = new MongoLite(':memory:');
await client.connect();
const users = client.collection('users');
await users.insertOne({ name: 'Alice', age: 30 });
// Data is discarded when the process exits
await client.close();
```

### Browser (via sql.js)

Requires [sql.js](https://www.npmjs.com/package/sql.js) (`npm install sql.js`).

```typescript
import initSqlJs from 'sql.js';
import { MongoLite, BrowserSqliteAdapter } from 'mongolite-ts';

const SQL = await initSqlJs({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/sql.js/dist/${file}`,
});
const sqlJsDb = new SQL.Database(); // in-memory; use OPFS/IndexedDB for persistence

const client = new MongoLite(new BrowserSqliteAdapter(sqlJsDb));
await client.connect();
const users = client.collection('users');
await users.insertOne({ name: 'Alice', age: 30 });
console.log(await users.findOne({ name: 'Alice' }));
await client.close();
```

### Cloudflare Durable Objects

```typescript
import { DurableObject } from 'cloudflare:workers';
import { MongoLite, CloudflareDurableObjectAdapter } from 'mongolite-ts/cloudflare';

export class MyDurableObject extends DurableObject {
  private client: MongoLite;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Pass ctx.storage.sql — no file path needed
    this.client = new MongoLite(new CloudflareDurableObjectAdapter(ctx.storage.sql));
    ctx.blockConcurrencyWhile(() => this.client.collection('users').ensureTable());
  }

  async fetch(request: Request) {
    const users = this.client.collection('users');
    await users.insertOne({ name: 'Alice', age: 30 });
    return Response.json(await users.findOne({ name: 'Alice' }));
  }
}
```

> See [docs/CLOUDFLARE.md](./docs/CLOUDFLARE.md) for the full guide, supported operations, and limitations.

## MongoDB Cloud Sync Plugin

MongoLite includes an optional MongoDB Cloud sync plugin that enables hybrid deployments where you can leverage the fast local performance of SQLite while keeping data synchronized with MongoDB Cloud. This is perfect for applications that need fast local reads/writes but also want cloud backup, collaboration, or data analytics capabilities.

### Key Features

- **Asynchronous Sync**: Operations are performed locally first (fast), then synced to MongoDB Cloud in the background
- **Fault Tolerance**: Local operations continue working even if MongoDB Cloud is unavailable
- **Batching & Queuing**: Efficient batching of operations to minimize network overhead
- **Retry Logic**: Automatic retry with exponential backoff for failed sync operations
- **Dirty Reads**: Optional ability to read latest data directly from MongoDB Cloud
- **Event System**: Real-time events for sync status and error handling
- **No Dependencies**: MongoDB driver is loaded dynamically only when sync is enabled

### Installation

The sync plugin requires the MongoDB driver as an optional dependency:

```bash
npm install mongolite-ts mongodb
# or
yarn add mongolite-ts mongodb
```

Note: MongoLite works perfectly without the MongoDB driver installed. The sync functionality simply won't be available.

### Basic Usage

```typescript
import { MongoLite } from 'mongolite-ts';

// Initialize with MongoDB sync enabled
const client = new MongoLite({
  filePath: './local-database.sqlite',
  mongodbSync: {
    connectionString: 'mongodb://localhost:27017/myapp',
    databaseName: 'myapp_sync',
    verbose: true
  }
});

await client.connect();
const collection = client.collection('users');

// All operations work normally and sync automatically
await collection.insertOne({ name: 'Alice', age: 30 });
await collection.updateOne({ name: 'Alice' }, { $set: { age: 31 } });
await collection.deleteOne({ name: 'Alice' });
```

### Configuration Options

```typescript
interface MongoDBSyncOptions {
  /** MongoDB connection string (required) */
  connectionString: string;
  
  /** Database name to sync to (default: 'mongolite_sync') */
  databaseName?: string;
  
  /** Enable dirty reads from MongoDB (default: false) */
  enableDirtyReads?: boolean;
  
  /** Retry configuration for failed operations */
  retryConfig?: {
    maxRetries?: number;        // default: 3
    initialDelayMs?: number;    // default: 1000
    maxDelayMs?: number;        // default: 10000
  };
  
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
  
  /** Batch size for operations (default: 100) */
  batchSize?: number;
  
  /** Queue timeout for batching (default: 1000ms) */
  queueTimeoutMs?: number;
}
```

### Advanced Usage

#### Dirty Reads from MongoDB Cloud

When you need the absolute latest data (e.g., from other applications writing to MongoDB), you can perform dirty reads:

```typescript
const client = new MongoLite({
  filePath: './local.sqlite',
  mongodbSync: {
    connectionString: 'mongodb://localhost:27017/myapp',
    enableDirtyReads: true  // Enable dirty reads
  }
});

// Fast local read (from SQLite)
const localUsers = await collection.find({ active: true }).toArray();

// Latest data from MongoDB Cloud (bypasses local cache)
const cloudUsers = await client.mongodbSync.dirtyRead('users', { active: true });
```

#### Monitoring Sync Status

```typescript
// Check queue status
const status = client.mongodbSync.getQueueStatus();
console.log(`Queue: ${status.queueLength} operations, Processing: ${status.isProcessing}`);

// Manually flush the queue
await client.mongodbSync.flush();

// Listen to sync events
client.mongodbSync.on('synced', (result) => {
  console.log(`✓ Synced ${result.operation.type} operation`);
});

client.mongodbSync.on('syncError', (result) => {
  console.error(`✗ Sync failed:`, result.error.message);
});

client.mongodbSync.on('connected', () => {
  console.log('Connected to MongoDB Cloud');
});

client.mongodbSync.on('disconnected', () => {
  console.log('Disconnected from MongoDB Cloud');
});
```

#### Error Handling

The sync plugin is designed to never interfere with local operations:

```typescript
// This will always succeed locally, even if MongoDB is down
const result = await collection.insertOne({ name: 'Alice' });
console.log('Local insert completed:', result.insertedId);

// Sync happens asynchronously in the background
// If sync fails, it will retry automatically
// Local operations continue normally
```

### Use Cases

#### Hybrid Applications
- **Local Performance**: Fast reads/writes from SQLite for responsive UI
- **Cloud Backup**: Automatic backup of all data to MongoDB Cloud
- **Data Analytics**: Use MongoDB's analytics capabilities on synced data

#### Offline-First Applications
- **Offline Work**: Application works completely offline with SQLite
- **Sync on Reconnect**: Automatic sync when internet connection is restored
- **Conflict Resolution**: Handle conflicts with custom logic

#### Multi-Region Deployments
- **Edge Computing**: Fast local database at edge locations
- **Central Cloud**: Centralized data in MongoDB Cloud for global access
- **Data Replication**: Each region syncs to central cloud database

#### Development & Testing
- **Local Development**: Use SQLite for fast local development
- **Production Sync**: Same codebase syncs to MongoDB Cloud in production
- **Testing**: Easy to test with in-memory SQLite, sync in integration tests

### Performance Characteristics

- **Local Operations**: SQLite performance (microseconds for simple operations)
- **Sync Overhead**: Minimal impact on application performance due to background processing
- **Batching**: Efficient network usage through operation batching
- **Memory Usage**: Configurable queue size to control memory usage

### Best Practices

#### 1. Configure Appropriate Batch Sizes
```typescript
// For high-volume applications
mongodbSync: {
  connectionString: 'mongodb://...',
  batchSize: 500,           // Larger batches for efficiency
  queueTimeoutMs: 5000,     // Wait longer to fill batches
}

// For low-latency applications
mongodbSync: {
  connectionString: 'mongodb://...',
  batchSize: 10,            // Smaller batches for faster sync
  queueTimeoutMs: 100,      // Sync more frequently
}
```

#### 2. Handle Network Issues Gracefully
```typescript
client.mongodbSync.on('error', (error) => {
  // Log error but don't crash the application
  console.error('MongoDB sync error:', error);
  
  // Optional: Implement custom retry logic
  // Optional: Store failed operations for manual retry
});
```

#### 3. Monitor Sync Health
```typescript
// Periodic health check
setInterval(() => {
  const status = client.mongodbSync.getQueueStatus();
  if (status.queueLength > 1000) {
    console.warn('Sync queue is getting large:', status.queueLength);
  }
}, 30000);
```

#### 4. Graceful Shutdown
```typescript
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  
  // Flush remaining operations before shutdown
  if (client.mongodbSync) {
    await client.mongodbSync.flush();
  }
  
  await client.close();
  process.exit(0);
});
```

### Troubleshooting

#### Common Issues

**1. MongoDB Connection Failed**
- Check connection string format
- Verify network connectivity
- Ensure MongoDB server is running
- Check authentication credentials

**2. Sync Queue Growing**
- Monitor with `getQueueStatus()`
- Check MongoDB server performance
- Verify network stability
- Consider increasing batch size

**3. Local vs Cloud Data Inconsistency**
- Use dirty reads when you need latest data
- Implement proper error handling
- Monitor sync events for failures

**Example with Full Error Handling:**

```typescript
const client = new MongoLite({
  filePath: './app.sqlite',
  mongodbSync: {
    connectionString: process.env.MONGODB_URL!,
    databaseName: 'myapp',
    verbose: process.env.NODE_ENV === 'development',
    retryConfig: {
      maxRetries: 5,
      initialDelayMs: 1000,
      maxDelayMs: 30000
    }
  }
});

// Comprehensive error handling
client.mongodbSync?.on('error', (error) => {
  console.error('MongoDB sync plugin error:', error);
  // Could integrate with error reporting service
});

client.mongodbSync?.on('syncError', (result) => {
  console.error(`Failed to sync ${result.operation.type}:`, result.error);
  // Could store failed operations for later retry
});

// Health monitoring
setInterval(async () => {
  if (client.mongodbSync) {
    const status = client.mongodbSync.getQueueStatus();
    console.log(`Sync status: ${status.queueLength} queued, processing: ${status.isProcessing}`);
  }
}, 60000);
```

## Development

```bash
git clone https://github.com/semics-tech/mongolite.git
cd mongolite
npm install
npm test          # Run tests
npm run build     # Compile TypeScript
npm run lint      # Lint code
```

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting a pull request.

## License

[MIT](./LICENSE)
