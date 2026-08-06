# Syncing to MongoDB

MongoLite can replicate every insert, update and delete to an upstream MongoDB
deployment. Point it at a connection string and the local database becomes a
local-first write layer that converges upstream — including across process
restarts, network outages and offline periods.

Replication is **one-way**: local → upstream. Nothing is read back down.

```typescript
import { MongoLite } from '@semics-tech/mongolite';

const client = new MongoLite('./app.sqlite');
await client.connect();

const sync = client.syncToMongo({
  connectionString: 'mongodb+srv://user:pass@cluster.example.com/app',
});

await sync.start();

// Ordinary writes — replication is automatic.
await client.collection('users').insertOne({ name: 'Alice', age: 30 });

// On shutdown, push anything still queued.
await sync.stop({ flush: true });
await client.close();
```

The `mongodb` driver is an optional peer dependency, loaded only when you
actually replicate:

```bash
npm install mongodb
```

## How it works

The mechanism is a **transactional outbox**, the same shape as SQLite's own
replication tooling but targeting a document store rather than another SQLite
file.

```
   write                    trigger                  batch
  ────────►  collection  ──────────►  outbox  ──────────────►  MongoDB
             table                    table    (coalesce,
                                                retry, ack)
                                        │
                                        └── checkpoint per replicator
```

1. **Capture.** SQLite `AFTER INSERT/UPDATE/DELETE` triggers append a row to
   `__mongolite_sync_outbox__`. Because a trigger runs inside the same
   transaction as the write, a change is either committed locally *and* queued
   for replication, or neither. There is no window where a write is durable but
   unrecorded.
2. **Coalesce.** A run of changes to one document collapses into the single
   operation that realises its final state. Ten updates to the same document
   become one upstream write.
3. **Apply.** Each batch goes upstream as one `bulkWrite` per collection —
   `replaceOne` with `upsert` for live documents, `deleteOne` for removed ones.
4. **Acknowledge.** Only after the upstream accepts the batch is the checkpoint
   advanced, in a single atomic statement. Rows every replicator has passed are
   then pruned.

### Delivery guarantees

Delivery is **at-least-once**, and every operation is idempotent — `replaceOne`
by `_id` with `upsert`, or `deleteOne` by `_id`. Replaying a batch reproduces
exactly the same upstream state, which is what makes it safe to acknowledge
*after* the upstream write instead of before: a crash in the window between the
two costs a duplicate write, never a lost one.

The practical guarantee is **convergence**: once the outbox drains, upstream
matches local. Ordering is preserved across batches, and within a batch every
operation touches a distinct document, so unordered application is safe.

### Why full documents, not update operators

Each replicated write carries the whole document rather than replaying the
`$set`/`$unset` that produced it. That makes replication idempotent and lets a
backlog be compacted, and it means a field you delete locally also disappears
upstream. The cost is that the local database is treated as authoritative:
**concurrent edits to the same document upstream will be overwritten.**

## Resilience

**Outages are absorbed, not dropped.** While the upstream is unreachable the
replicator retries with exponential backoff and jitter, and the checkpoint stays
put — so the outbox simply accumulates. When connectivity returns it drains from
exactly where it stopped. `maxRetries` defaults to `Infinity`, on the grounds
that surviving a long outage is more useful than failing fast.

**Restarts resume.** The checkpoint lives in the database, so a new process
picks up where the last one left off. Triggers deliberately outlive the
replicator that installed them: changes made while replication is stopped are
still captured.

**A poison document cannot stall the stream.** Failures the upstream will never
accept — document validation, `BSONObjectTooLarge`, malformed field names — are
moved to `__mongolite_sync_deadletter__` and the batch proceeds. Everything else
is treated as transient and retried.

```typescript
const failed = await sync.deadLetters();
for (const entry of failed) {
  console.error(`${entry.collection}/${entry.documentId}: ${entry.error}`);
}
```

**The outbox is bounded.** If a long outage pushes it past `maxOutboxSize`
(default 100,000 rows), superseded revisions are dropped, keeping the newest row
per document. Compaction is lossless here precisely because replication is
full-document last-write-wins — a hot document rewritten a million times offline
still costs one row.

## Options

```typescript
const sync = client.syncToMongo({
  // — Upstream —
  connectionString: 'mongodb+srv://cluster.example.com',
  database: 'app',                    // Defaults to the connection string's path
  writeConcern: { w: 'majority' },    // Default; a batch is checkpointed only once it survives upstream

  // — What to replicate —
  collections: ['users', 'orders'],   // Omit for every collection, including ones created later
  exclude: ['sessions'],
  collectionMap: { users: 'app_users' },
  transform: (doc) => ({ ...doc, syncedFrom: 'edge-1' }),

  // — Behaviour —
  name: 'default',                    // Checkpoint identity; distinct names for multiple upstreams
  initial: 'backfill',                // Or 'changes-only' to ignore pre-existing documents
  idMapping: 'auto',                  // Or 'string' to keep `_id` values as strings
  batchSize: 500,
  pollIntervalMs: 250,

  // — Failure handling —
  retryDelayMs: 500,
  maxRetryDelayMs: 30_000,
  maxRetries: Infinity,
  maxOutboxSize: 100_000,
  overflowStrategy: 'compact',        // Or 'warn' to leave the backlog alone
});
```

### `_id` mapping

MongoLite stores `_id` as a string; MongoDB conventionally uses `ObjectId`. With
the default `idMapping: 'auto'`, a 24-character hex id is written upstream as a
real `ObjectId` and anything else stays a string, so replicated documents are
indistinguishable from natively written ones. Use `'string'` when ids that merely
*look* like ObjectIds should stay strings.

### Filtering and reshaping

`transform` runs on every document heading upstream. Return `null` to skip it —
the change is acknowledged, not retried, so a filtered document does not
accumulate in the outbox.

```typescript
transform: (doc, { sourceCollection }) => {
  if (doc.internal === true) return null;         // Never leaves the device
  const { passwordHash, ...safe } = doc;          // Strip before it goes upstream
  return { ...safe, origin: sourceCollection };
},
```

Deletes are not passed through `transform` — only an `_id` is needed to remove a
document. A document previously filtered out is simply deleted from a collection
it was never written to, which MongoDB treats as a no-op.

## Authentication

Most deployments need nothing beyond the connection string, which already
carries credentials, `authSource`, `replicaSet` and `tls`. For mechanisms that
need files on disk, pass them explicitly:

```typescript
// X.509 / mutual TLS
client.syncToMongo({
  connectionString: 'mongodb+srv://cluster.example.com/app',
  authMechanism: 'MONGODB-X509',
  tlsCertificateKeyFile: '/etc/ssl/mongo-client.pem',
  tlsCertificateKeyFilePassword: process.env.CLIENT_KEY_PASSPHRASE,
  tlsCAFile: '/etc/ssl/private-ca.pem',
});

// AWS IAM
client.syncToMongo({
  connectionString: 'mongodb+srv://cluster.example.com/app',
  authMechanism: 'MONGODB-AWS',
  authMechanismProperties: { AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN },
});
```

Anything else the driver supports goes through `driverOptions`, which is passed
straight to `new MongoClient(...)`:

```typescript
client.syncToMongo({
  connectionString: process.env.MONGO_URL!,
  driverOptions: {
    serverApi: { version: '1', strict: true },
    compressors: ['zstd'],
    maxPoolSize: 5,
  },
});
```

> Credentials are read from the options you pass and are never written to the
> local database — only checkpoints and queued documents are stored there.

## Monitoring

```typescript
sync.on('batch', ({ applied, deadLettered, checkpoint }) => { /* … */ });
sync.on('retry', ({ attempt, retryInMs, error }) => { /* upstream degraded */ });
sync.on('deadLetter', (entry) => { /* needs a human */ });
sync.on('overflow', ({ pending, compacted }) => { /* long outage */ });
sync.on('drained', ({ checkpoint }) => { /* fully caught up */ });
sync.on('error', (err) => { /* replication stopped */ });

const status = await sync.status();
// { running, connected, checkpoint, pending, applied, retries, deadLettered, … }
```

Register an `error` listener if you rely on `maxRetries`: without one, a
replicator that gives up logs to the console instead.

`await sync.waitForDrain()` resolves once everything written *before the call*
has reached the upstream — useful in tests and before a controlled shutdown.

## Latency

The replicator polls the outbox every `pollIntervalMs` (250ms by default), so
that bounds worst-case replication latency. Two ways to tighten it:

```typescript
sync.notify();                   // Check now — call after a write that matters
client.syncToMongo({ pollIntervalMs: 50 });
```

`notify()` is the cheaper option: it wakes the current poll immediately rather
than making every idle cycle busier.

## Multiple upstreams

Replicators sharing one database each keep their own checkpoint, and outbox rows
are pruned only once *every* registered replicator has passed them.

```typescript
const primary = client.syncToMongo({ name: 'primary', connectionString: PRIMARY });
const analytics = client.syncToMongo({
  name: 'analytics',
  connectionString: WAREHOUSE,
  collections: ['events'],
});
```

Because the slowest replicator pins the log, a name you stop using keeps its
rows forever. Retire it explicitly:

```typescript
import { SyncOutbox } from '@semics-tech/mongolite';
await new SyncOutbox(client.database).unregister('analytics');
```

## Process lifetime

A running replicator keeps the Node.js process alive, the same way an open
server does — exiting with changes still queued would silently lose them. Call
`sync.stop()` to release it, or pass `unref: true` for short-lived scripts that
manage their own lifetime.

```typescript
process.on('SIGTERM', async () => {
  await sync.stop({ flush: true });
  await client.close();
  process.exit(0);
});
```

## Other backends

`syncToMongo` is a convenience over a backend-agnostic core. Implement `SyncSink`
to replicate anywhere — an HTTP API from a Cloudflare Durable Object, a queue, or
a test double — and drive it with `client.createSync(sink, options)`:

```typescript
import type { SyncSink } from '@semics-tech/mongolite';

const httpSink: SyncSink = {
  name: 'http',
  async apply(operations) {
    const res = await fetch('https://api.example.com/replicate', {
      method: 'POST',
      body: JSON.stringify(operations),
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`); // Throw → retried with backoff
    return { applied: operations.length };
  },
};

const sync = client.createSync(httpSink, { collections: ['events'] });
```

Throwing signals a transient failure and the batch is retried. Returning
`failures` marks individual operations as permanently rejected, so they are
dead-lettered instead of blocking the stream.

## Internal tables

Replication adds three tables, all excluded from `listCollections()`:

| Table | Purpose |
| --- | --- |
| `__mongolite_sync_outbox__` | Captured changes awaiting replication |
| `__mongolite_sync_state__` | Per-replicator checkpoint and backfill progress |
| `__mongolite_sync_deadletter__` | Permanently rejected changes, kept for inspection |

## Limitations

- **One-way.** Upstream changes are not pulled back down.
- **Last-write-wins.** The local database is authoritative; concurrent upstream
  edits to the same document are overwritten. There is no conflict resolution.
- **Document-level granularity.** Whole documents are replicated, not field
  deltas. Very large documents cost proportionally more bandwidth.
- **Deletes need triggers installed.** A document deleted while its collection
  had no capture triggers is not replicated. Triggers stay installed once
  created, so this only affects the window before the first `start()` — which
  the initial backfill covers for inserts but cannot for deletes.
