import test from 'node:test';
import { expect } from 'expect';
import { MongoLite, ChangeStreamDocument } from '../src/index.js';
import { existsSync, unlinkSync } from 'fs';

interface TestUser {
  _id?: string;
  name: string;
  age: number;
  email: string;
  status?: string;
  [key: string]: unknown;
}

test('Change Stream - Basic functionality', async () => {
  const dbPath = './test-change-stream.sqlite';

  // Clean up any existing test database
  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
  }

  const client = new MongoLite(dbPath);
  await client.connect();

  try {
    const usersCollection = client.collection<TestUser>('users');

    // Create change stream
    const changeStream = usersCollection.watch({
      fullDocument: 'updateLookup',
      fullDocumentBeforeChange: 'whenAvailable',
    });

    const changes: ChangeStreamDocument<TestUser>[] = [];

    // Set up event listener
    changeStream.on('change', (change) => {
      changes.push(change);
    });

    // Wait for change stream setup (triggers need to be created)
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Insert operation
    const insertResult = await usersCollection.insertOne({
      name: 'Alice Wonderland',
      age: 30,
      email: 'alice@example.com',
      status: 'active',
    });
    const userId = insertResult.insertedId;

    // Wait for change processing
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Update operation
    await usersCollection.updateOne(
      { _id: userId },
      {
        $set: { age: 31, status: 'premium' },
      }
    );

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Delete operation
    await usersCollection.deleteOne({ _id: userId });

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Close the change stream
    changeStream.close();
    await changeStream.cleanup();

    // Verify that we captured the expected changes
    expect(changes.length).toBe(3);

    // Check insert change
    const insertChange = changes[0];
    expect(insertChange.operationType).toBe('insert');
    expect(insertChange.documentKey._id).toBe(userId);
    expect(insertChange.fullDocument).toBeDefined();
    expect(insertChange.fullDocument?.name).toBe('Alice Wonderland');

    // Check update change
    const updateChange = changes[1];
    expect(updateChange.operationType).toBe('update');
    expect(updateChange.documentKey._id).toBe(userId);
    expect(updateChange.fullDocument).toBeDefined();
    expect(updateChange.fullDocument?.age).toBe(31);
    expect(updateChange.fullDocument?.status).toBe('premium');
    expect(updateChange.updateDescription).toBeDefined();
    expect(updateChange.updateDescription?.updatedFields.age).toBe(31);
    expect(updateChange.updateDescription?.updatedFields.status).toBe('premium');

    // Check delete change
    const deleteChange = changes[2];
    expect(deleteChange.operationType).toBe('delete');
    expect(deleteChange.documentKey._id).toBe(userId);
    expect(deleteChange.fullDocumentBeforeChange).toBeDefined();
    expect(deleteChange.fullDocumentBeforeChange?.name).toBe('Alice Wonderland');
  } finally {
    await client.close();

    // Clean up test database
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  }
});

test('Change Stream - Async iteration', async () => {
  const dbPath = './test-change-stream-async.sqlite';

  // Clean up any existing test database
  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
  }

  const client = new MongoLite(dbPath);
  await client.connect();

  try {
    const usersCollection = client.collection<TestUser>('users');

    // Create change stream
    const changeStream = usersCollection.watch();

    // Wait for change stream setup
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Start async iteration in the background
    const iterationPromise = (async () => {
      const iterationChanges: ChangeStreamDocument<TestUser>[] = [];
      for await (const change of changeStream) {
        iterationChanges.push(change);
        if (iterationChanges.length >= 2) {
          changeStream.close();
          break;
        }
      }
      return iterationChanges;
    })();

    // Perform operations
    await usersCollection.insertOne({
      name: 'Bob Builder',
      age: 25,
      email: 'bob@example.com',
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    await usersCollection.insertOne({
      name: 'Charlie Brown',
      age: 35,
      email: 'charlie@example.com',
    });

    // Wait for iteration to complete
    const changes = await iterationPromise;
    await changeStream.cleanup();

    expect(changes.length).toBe(2);
    expect(changes[0].operationType).toBe('insert');
    expect(changes[1].operationType).toBe('insert');
  } finally {
    await client.close();

    // Clean up test database
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  }
});

test('Change Stream - Change log table creation', async () => {
  const dbPath = './test-change-log.sqlite';

  // Clean up any existing test database
  if (existsSync(dbPath)) {
    unlinkSync(dbPath);
  }

  const client = new MongoLite(dbPath);
  await client.connect();

  try {
    const usersCollection = client.collection<TestUser>('users');

    // Create change stream
    const changeStream = usersCollection.watch();

    // Wait for setup
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Check that the change log table was created
    const tables = await client.database.all(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='__mongolite_changes__'`
    );

    expect(tables.length).toBe(1);
    expect((tables[0] as { name: string }).name).toBe('__mongolite_changes__');

    // Check that triggers were created
    const triggers = await client.database.all(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='users'`
    );

    expect(triggers.length).toBe(3);
    const triggerNames = triggers.map((t) => (t as { name: string }).name);
    expect(triggerNames).toContain('users_insert_trigger');
    expect(triggerNames).toContain('users_update_trigger');
    expect(triggerNames).toContain('users_delete_trigger');

    changeStream.close();
    await changeStream.cleanup();
  } finally {
    await client.close();

    // Clean up test database
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
    }
  }
});
