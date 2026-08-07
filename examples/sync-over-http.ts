/**
 * Replicating through a remote HTTP API instead of connecting to MongoDB directly.
 *
 * Both halves are shown in one file for readability. In practice the client runs on the
 * device or edge node, and the receiver runs on the API in front of your database.
 *
 * Run with:
 *   MONGO_URL='mongodb://localhost:27017' npx tsx examples/sync-over-http.ts
 *
 * Requires the optional `mongodb` peer dependency on the *server* side only.
 */
import { createServer } from 'node:http';
import { MongoClient } from 'mongodb';
import { MongoLite } from '../src/index.js';
import { createSyncReceiver } from '../src/server.js';

const DATABASE = 'mongolite_http_demo';

/** The remote API: receives sync messages and applies them to MongoDB. */
async function startApi(mongoUrl: string): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const mongo = await new MongoClient(mongoUrl).connect();

  const receiver = createSyncReceiver({
    client: mongo as never,
    database: DATABASE,

    // Without this, any client that can reach the endpoint can write to every
    // collection in the database.
    allowedCollections: ['users', 'orders'],

    // Your own authorisation, on top of whatever the API already enforces.
    verifyRequest: ({ replicator, collections, operationCount }) => {
      console.log(`[api] ${replicator}: ${operationCount} op(s) on ${collections.join(', ')}`);
      return true;
    },
  });

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      void (async () => {
        const isFetch = (req.url ?? '').endsWith('/_sync/fetch');
        const result = isFetch ? await receiver.fetch(body) : await receiver.apply(body);
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(3999, resolve));

  return {
    baseUrl: 'http://127.0.0.1:3999',
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mongo.close();
    },
  };
}

async function main(): Promise<void> {
  const mongoUrl = process.env.MONGO_URL;
  if (!mongoUrl) {
    console.error('Set MONGO_URL to a MongoDB connection string first.');
    process.exit(1);
  }

  const api = await startApi(mongoUrl);

  const client = new MongoLite('./sync-http-demo.sqlite');
  await client.connect();

  const sync = client.syncToHttp({
    baseUrl: api.baseUrl,
    database: DATABASE,
    collections: ['users', 'orders'],

    // Static headers the API expects on every request.
    headers: { 'x-environment': 'demo' },

    // Resolved per request, so a short-lived token is refreshed rather than reused.
    // With Azure this would wrap DefaultAzureCredential — see docs/SYNC.md.
    getAuthHeaders: async () => ({ Authorization: `Bearer ${process.env.API_TOKEN ?? 'demo'}` }),

    verbose: true,
  });

  sync.on('retry', ({ attempt, error }) => {
    console.warn(`[client] API unreachable (attempt ${attempt}): ${error.message}`);
  });
  sync.on('conflict', ({ documentId, reason, resolution }) => {
    console.warn(`[client] conflict on ${documentId} (${reason}) resolved as "${resolution}"`);
  });

  await sync.start();

  const users = client.collection('users');
  const { insertedId } = await users.insertOne({ name: 'Alice', age: 30 });
  await users.updateOne({ _id: insertedId }, { $set: { age: 31 } });
  await client.collection('orders').insertOne({ userId: insertedId, total: 42.5 });

  await sync.waitForDrain();
  console.log('[client] status:', await sync.status());

  await sync.stop({ flush: true });
  await client.close();
  await api.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
