/**
 * Child process for the WAL retry test: opens the database, starts a transaction,
 * writes a row, prints READY, holds the write lock for HOLD_MS, then commits.
 * Usage: txn-holder.ts <dbPath> <holdMs>
 */
import { MongoLite } from '../../src/index.js';

const [dbPath, holdMs] = process.argv.slice(2);
const client = new MongoLite({ filePath: dbPath, WAL: true });
await client.connect();
const col = client.collection<{ _id: string; who: string }>('items');
const session = client.startSession();
await session.withTransaction(async () => {
  await col.insertOne({ _id: 'from-a', who: 'A' }, { session });
  console.log('READY');
  await new Promise((r) => setTimeout(r, Number(holdMs)));
});
await client.close();
console.log('COMMITTED');
