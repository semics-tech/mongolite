/**
 * Replicating a local MongoLite database to an upstream MongoDB deployment.
 *
 * Run with:
 *   MONGO_URL='mongodb://localhost:27017/mongolite_demo' npx tsx examples/sync-to-mongodb.ts
 *
 * Requires the optional `mongodb` peer dependency: `npm install mongodb`.
 */
import { MongoLite } from '../src/index.js';

interface User {
  _id?: string;
  name: string;
  email: string;
  age: number;
  passwordHash?: string;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  const connectionString = process.env.MONGO_URL;
  if (!connectionString) {
    console.error('Set MONGO_URL to a MongoDB connection string first.');
    process.exit(1);
  }

  const client = new MongoLite('./sync-demo.sqlite');
  await client.connect();

  const sync = client.syncToMongo({
    connectionString,

    // Replicate these collections; anything else stays local.
    collections: ['users', 'orders'],

    // Rename on the way upstream.
    collectionMap: { users: 'app_users' },

    // Never let password hashes leave the device.
    transform: (doc) => {
      const { passwordHash: _passwordHash, ...safe } = doc;
      return safe;
    },

    // The upstream is the source of truth: if another writer got there first, keep
    // their version and let the application know rather than overwriting it.
    onConflict: ({ documentId, serverVersion }) => {
      console.warn(`${documentId} changed upstream (now v${serverVersion}) — keeping theirs`);
      return 'server';
    },

    verbose: true,
  });

  // Replication is best-effort by design: it retries through outages rather
  // than failing the writes that feed it. Observe it rather than awaiting it.
  sync.on('retry', ({ attempt, retryInMs, error }) => {
    console.warn(`upstream unreachable (attempt ${attempt}): ${error.message}`);
    console.warn(`  retrying in ${Math.round(retryInMs)}ms — changes are queued locally`);
  });
  sync.on('deadLetter', (entry) => {
    console.error(`rejected upstream: ${entry.collection}/${entry.documentId} — ${entry.error}`);
  });
  sync.on('conflict', ({ collection, documentId, reason, resolution }) => {
    console.warn(`conflict on ${collection}/${documentId} (${reason}) resolved as "${resolution}"`);
  });
  sync.on('error', (err) => {
    console.error('replication stopped:', err.message);
  });

  await sync.start();

  const users = client.collection<User>('users');
  const orders = client.collection('orders');

  // Ordinary writes — the triggers capture them automatically.
  const { insertedId } = await users.insertOne({
    name: 'Alice',
    email: 'alice@example.com',
    age: 30,
    passwordHash: 'never-replicated',
  });

  await users.updateOne({ _id: insertedId }, { $set: { age: 31 } });
  await orders.insertOne({ userId: insertedId, total: 42.5 });

  // Only needed when you want to observe the result immediately; in a running
  // service replication just happens in the background.
  await sync.waitForDrain();

  console.log('replication status:', await sync.status());

  // A clean shutdown pushes anything still queued.
  await sync.stop({ flush: true });
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
