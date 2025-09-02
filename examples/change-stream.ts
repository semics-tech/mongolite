import { MongoLite } from '../src';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface User {
  _id?: string;
  name: string;
  age: number;
  email: string;
  status?: string;
  [key: string]: unknown; // Add index signature to satisfy DocumentWithId constraint
}

async function demonstrateChangeStream() {
  // Initialize the client
  const dbPath = path.join(__dirname, 'change-stream-example.sqlite');
  const client = new MongoLite(dbPath);

  try {
    await client.connect();
    console.log('Connected to SQLite database for change stream demo.');

    // Get a collection
    const usersCollection = client.collection<User>('users');

    // Set up change stream with options
    const changeStream = usersCollection.watch({
      fullDocument: 'updateLookup', // Include full document on updates
      fullDocumentBeforeChange: 'whenAvailable', // Include document before change
    });

    console.log('Starting change stream...\n');

    // Set up event listeners
    changeStream.on('change', (change) => {
      console.log('=== CHANGE DETECTED ===');
      console.log('Operation:', change.operationType);
      console.log('Document ID:', change.documentKey._id);
      console.log('Collection:', change.ns.coll);
      console.log('Timestamp:', change.clusterTime);

      if (change.fullDocument) {
        console.log('Full Document:', JSON.stringify(change.fullDocument, null, 2));
      }

      if (change.fullDocumentBeforeChange) {
        console.log(
          'Document Before Change:',
          JSON.stringify(change.fullDocumentBeforeChange, null, 2)
        );
      }

      if (change.updateDescription) {
        console.log('Updated Fields:', change.updateDescription.updatedFields);
        console.log('Removed Fields:', change.updateDescription.removedFields);
      }

      console.log('========================\n');
    });

    changeStream.on('error', (error) => {
      console.error('Change stream error:', error);
    });

    // Let the change stream set up (triggers need to be created)
    await new Promise((resolve) => setTimeout(resolve, 100));

    console.log('Performing database operations...\n');

    // INSERT operation
    console.log('1. Inserting a new user...');
    const insertResult = await usersCollection.insertOne({
      name: 'Alice Wonderland',
      age: 30,
      email: 'alice@example.com',
      status: 'active',
    });
    const userId = insertResult.insertedId;

    // Wait a bit for the change to be processed
    await new Promise((resolve) => setTimeout(resolve, 200));

    // UPDATE operation
    console.log('2. Updating the user...');
    await usersCollection.updateOne(
      { _id: userId },
      {
        $set: { age: 31, status: 'premium' },
        $unset: { email: '' },
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 200));

    // INSERT another document
    console.log('3. Inserting another user...');
    const insertResult2 = await usersCollection.insertOne({
      name: 'Bob Builder',
      age: 25,
      email: 'bob@example.com',
    });
    const userId2 = insertResult2.insertedId;

    await new Promise((resolve) => setTimeout(resolve, 200));

    // DELETE operation
    console.log('4. Deleting the first user...');
    await usersCollection.deleteOne({ _id: userId });

    await new Promise((resolve) => setTimeout(resolve, 200));

    // UPDATE the second user
    console.log('5. Updating the second user...');
    await usersCollection.updateOne({ _id: userId2 }, { $set: { age: 26 } });

    // Wait for changes to be processed
    await new Promise((resolve) => setTimeout(resolve, 500));

    console.log('6. Demonstrating async iteration...');

    // Create a new change stream for async iteration demo
    const asyncChangeStream = usersCollection.watch();

    // Set up async iteration in the background
    const iterationPromise = (async () => {
      let changeCount = 0;
      for await (const change of asyncChangeStream) {
        console.log(
          `Async iteration change ${++changeCount}:`,
          change.operationType,
          change.documentKey._id
        );
        if (changeCount >= 2) {
          asyncChangeStream.close();
          break;
        }
      }
    })();

    // Wait for the async change stream to set up
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Trigger some changes
    await usersCollection.insertOne({ name: 'Charlie', age: 35, email: 'charlie@example.com' });
    await usersCollection.updateOne({ name: 'Charlie' }, { $set: { age: 36 } });

    // Wait for the async iteration to complete
    await iterationPromise;

    console.log('\nChange stream demonstration completed.');

    // Close the change streams
    changeStream.close();

    // Clean up the change stream triggers
    await changeStream.cleanup();
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    await client.close();
    console.log('Database connection closed.');
  }
}

// Run the demonstration
demonstrateChangeStream().catch(console.error);
