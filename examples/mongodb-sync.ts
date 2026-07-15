import { MongoLite } from '../src/index.js';

interface User {
  _id?: string;
  name: string;
  age: number;
  email: string;
  createdAt?: Date;
  [key: string]: unknown; // Index signature for DocumentWithId compatibility
}

async function main() {
  // Initialize MongoLite with MongoDB Cloud sync
  const client = new MongoLite({
    filePath: './example-sync.sqlite',
    mongodbSync: {
      connectionString: 'mongodb://localhost:27017/example',
      databaseName: 'mongolite_sync_example',
      enableDirtyReads: true,
      verbose: true,
      batchSize: 10,
      queueTimeoutMs: 2000,
      retryConfig: {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 5000,
      },
    },
  });

  try {
    await client.connect();
    console.log('Connected to MongoLite with MongoDB sync enabled');

    const usersCollection = client.collection<User>('users');

    // Insert operations - will sync to MongoDB Cloud
    console.log('\n--- Insert Operations ---');
    const insertResult = await usersCollection.insertOne({
      name: 'Alice Johnson',
      age: 28,
      email: 'alice@example.com',
      createdAt: new Date(),
    });
    console.log('Inserted user:', insertResult.insertedId);

    // Batch insert
    const batchInsertResult = await usersCollection.insertMany([
      { name: 'Bob Smith', age: 32, email: 'bob@example.com', createdAt: new Date() },
      { name: 'Carol Wilson', age: 25, email: 'carol@example.com', createdAt: new Date() },
      { name: 'David Brown', age: 35, email: 'david@example.com', createdAt: new Date() },
    ]);
    console.log('Batch inserted:', batchInsertResult.insertedCount, 'users');

    // Update operations - will sync to MongoDB Cloud
    console.log('\n--- Update Operations ---');
    const updateResult = await usersCollection.updateOne(
      { name: 'Alice Johnson' },
      { $set: { age: 29, email: 'alice.johnson@example.com' } }
    );
    console.log('Updated users:', updateResult.modifiedCount);

    const updateManyResult = await usersCollection.updateMany(
      { age: { $gte: 30 } },
      { $set: { senior: true } }
    );
    console.log('Updated senior users:', updateManyResult.modifiedCount);

    // Local queries (fast, from SQLite)
    console.log('\n--- Local Queries (SQLite) ---');
    const localUsers = await usersCollection.find({ age: { $gte: 25 } }).toArray();
    console.log('Local users (age >= 25):', localUsers.length);

    const youngUser = await usersCollection.findOne({ age: { $lt: 30 } });
    console.log('Young user:', youngUser?.name);

    // Dirty reads from MongoDB Cloud (when you need latest data from other sources)
    console.log('\n--- Dirty Reads (MongoDB Cloud) ---');
    if (client.mongodbSync) {
      try {
        const cloudUsers = await client.mongodbSync.dirtyRead<User>('users', { age: { $gte: 30 } });
        console.log('Cloud users (age >= 30):', cloudUsers.length);
      } catch (error) {
        console.log('Dirty read failed:', (error as Error).message);
      }
    }

    // Delete operations - will sync to MongoDB Cloud
    console.log('\n--- Delete Operations ---');
    const deleteResult = await usersCollection.deleteOne({ name: 'Carol Wilson' });
    console.log('Deleted users:', deleteResult.deletedCount);

    const deleteManyResult = await usersCollection.deleteMany({ age: { $lt: 26 } });
    console.log('Deleted young users:', deleteManyResult.deletedCount);

    // Check sync queue status
    console.log('\n--- Sync Status ---');
    if (client.mongodbSync) {
      const status = client.mongodbSync.getQueueStatus();
      console.log('Queue status:', status);

      // Manually flush the queue to ensure all operations are synced
      console.log('Flushing sync queue...');
      await client.mongodbSync.flush();

      const statusAfterFlush = client.mongodbSync.getQueueStatus();
      console.log('Status after flush:', statusAfterFlush);
    }

    // Listen to sync events
    console.log('\n--- Sync Events ---');
    if (client.mongodbSync) {
      client.mongodbSync.on('synced', (result) => {
        console.log(
          `✓ Synced ${result.operation.type} to collection ${result.operation.collection}`
        );
      });

      client.mongodbSync.on('syncError', (result) => {
        console.error(`✗ Sync failed for ${result.operation.type}:`, result.error?.message);
      });

      // Perform one more operation to demonstrate events
      await usersCollection.insertOne({
        name: 'Event Test User',
        age: 40,
        email: 'event@example.com',
        createdAt: new Date(),
      });

      // Wait a moment for sync to complete
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Final count
    console.log('\n--- Final State ---');
    const finalCount = await usersCollection.countDocuments({});
    console.log('Total users in local database:', finalCount);

    const allUsers = await usersCollection.find({}).toArray();
    console.log('All users:');
    allUsers.forEach((user) => {
      console.log(`  - ${user.name} (${user.age}) - ${user.email}`);
    });
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Clean shutdown - this will flush any remaining sync operations
    await client.close();
    console.log('\nDatabase connection closed');
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  process.exit(0);
});

main().catch(console.error);
