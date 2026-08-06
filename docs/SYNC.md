# Syncing to MongoDB

MongoLite can replicate every insert, update and delete to an upstream MongoDB
deployment. Point it at a connection string and the local database becomes a
local-first write layer that converges upstream — including across process
restarts, network outages and offline periods.

Replication is **one-way**: local → upstream. Upstream changes are not streamed back
down — but the upstream is still treated as authoritative. Every push is a conditional
write against the version it last saw, so a concurrent edit by another writer is
detected and wins rather than being silently overwritten.

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
   transaction as the write, a change is either committed locally _and_ queued
   for replication, or neither. There is no window where a write is durable but
   unrecorded.
2. **Coalesce.** A run of changes to one document collapses into the single
   operation that realises its final state. Ten updates to the same document
   become one upstream write.
3. **Apply.** Each batch goes upstream as one `bulkWrite` per collection, as
   conditional updates keyed by `_id` and the version last seen — see
   [Conflict detection](#conflict-detection).
4. **Acknowledge.** Only after the upstream accepts the batch is the checkpoint
   advanced, in a single atomic statement. Rows every replicator has passed are
   then pruned.

### Delivery guarantees

Delivery is **at-least-once**, and every operation is idempotent by `_id`.
Replaying a batch reproduces exactly the same upstream state, which is what makes
it safe to acknowledge _after_ the upstream write instead of before: a crash in
the window between the two costs a duplicate write, never a lost one. (A replayed
conditional update whose version already advanced simply reports a conflict, and
the replicator reconciles it.)

The practical guarantee is **convergence**: once the outbox drains, upstream
matches local. Ordering is preserved across batches, and within a batch every
operation touches a distinct document, so unordered application is safe.

### Conflict detection

Every upstream document carries two fields replication maintains:

| Field        | Purpose                                             |
| ------------ | --------------------------------------------------- |
| `_v`         | Monotonic version. Every push is conditional on it. |
| `_updatedAt` | Server-stamped write time, via `$currentDate`.      |

A push is a compare-and-swap:

```js
updateOne(
  { _id, _v: 7 },                                   // the revision we last saw
  { $set: …, $unset: …, $inc: { _v: 1 }, $currentDate: { _updatedAt: true } }
)
```

If another writer has moved the document on, the predicate matches nothing and the
push is reported as a **conflict** rather than landing. Note that a lost
compare-and-swap raises no error — it is a silent zero-match — which is why sinks must
report conflicts explicitly rather than relying on exceptions.

A **version**, not a timestamp, is what makes this correct. Consider: client A reads
v1, client B writes v2, then A writes based on its stale v1. A's write is _later_, so
any timestamp comparison hands it the win and B's change is lost. Only a version can
detect that A never saw v2. `_updatedAt` exists for change discovery and observability,
never as the arbiter — which also means device clock skew cannot affect correctness.

Set `versioning: false` to opt out and restore unconditional whole-document
replacement. Only appropriate when nothing else writes to the upstream.

### Why field-level diffs

Pushes carry `$set`/`$unset` of only what changed, computed against a **shadow copy** of
the last-known server document held locally.

This is not an optimisation — it is what keeps the upstream intact. MongoLite stores
documents as plain JSON, so a `Date` becomes an ISO string, an `ObjectId` becomes hex,
and `Binary`/`Decimal128` degrade into unusable structural objects. Pushing whole
documents would write that degraded form back over the real one. Diffing against the
shadow means a field the application never touched is _absent from the push_, so its
upstream BSON value is never rewritten.

It also means a local edit to one field no longer clobbers fields another writer
changed.

Two consequences worth knowing:

- **Arrays are atomic.** Any change to an array replaces the whole array. Positional
  array diffing goes wrong as soon as elements are inserted or reordered, and a wrong
  answer silently corrupts data.
- **The shadow roughly doubles local database size**, since each replicated document is
  stored twice: once as the local document, once as the last-known server state.

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
per document. Compaction is lossless because only the newest local state is ever
pushed — a hot document rewritten a million times offline still costs one row.

## Options

```typescript
const sync = client.syncToMongo({
  // — Upstream —
  connectionString: 'mongodb+srv://cluster.example.com',
  database: 'app', // Defaults to the connection string's path
  writeConcern: { w: 'majority' }, // Default; a batch is checkpointed only once it survives upstream

  // — What to replicate —
  collections: ['users', 'orders'], // Omit for every collection, including ones created later
  exclude: ['sessions'],
  collectionMap: { users: 'app_users' },
  transform: (doc) => ({ ...doc, syncedFrom: 'edge-1' }),

  // — Behaviour —
  name: 'default', // Checkpoint identity; distinct names for multiple upstreams
  initial: 'backfill', // Or 'changes-only' to ignore pre-existing documents
  idMapping: 'auto', // Or 'string' to keep `_id` values as strings
  batchSize: 500,
  pollIntervalMs: 250,

  // — Concurrency —
  versioning: true, // Conditional writes against `_v`. Default
  onConflict: (ctx) => 'server', // Or 'local' to force, 'skip' to abandon

  // — Failure handling —
  retryDelayMs: 500,
  maxRetryDelayMs: 30_000,
  maxRetries: Infinity,
  maxOutboxSize: 100_000,
  overflowStrategy: 'compact', // Or 'warn' to leave the backlog alone
});
```

### `_id` mapping

MongoLite stores `_id` as a string; MongoDB conventionally uses `ObjectId`. With
the default `idMapping: 'auto'`, a 24-character hex id is written upstream as a
real `ObjectId` and anything else stays a string, so replicated documents are
indistinguishable from natively written ones. Use `'string'` when ids that merely
_look_ like ObjectIds should stay strings.

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

## Handling conflicts

When a push loses a race, the shadow is refreshed from the upstream first, so the
decision is made against current state rather than the version that already lost.

```typescript
const sync = client.syncToMongo({
  connectionString: process.env.MONGO_URL!,
  onConflict: ({ documentId, localDocument, serverDocument, serverVersion }) => {
    console.warn(`${documentId} changed upstream (now v${serverVersion})`);
    return 'server'; // discard the local edit — the default
  },
});

sync.on('conflict', ({ documentId, reason, resolution }) => {
  metrics.increment('sync.conflict', { reason, resolution });
});
```

| Resolution             | Effect                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `'server'` _(default)_ | The upstream version wins **and is written into the local collection**, so the next local edit starts from it. |
| `'local'`              | The change is re-queued against the refreshed version and pushed again, overwriting the other writer.          |
| `'skip'`               | Both sides are left alone; the local change is dropped without retrying.                                       |

`'server'` updating the local document is deliberate. Without it the local row would
keep the value that just lost, and the next local edit would push it straight back
up — the conflict would only ever be deferred, never resolved.

Conflicts are counted in `status().conflicts` and are **never dead-lettered** — a
conflict is a normal outcome to reconcile, not a poison document.

### What versioning cannot protect against

`_v` only guards against writers that participate in the protocol. An application that
writes to the collection directly without incrementing `_v` will not be detected, and
its change can be overwritten. If every writer goes through this library — or through
the same compare-and-swap convention — that gap does not arise.

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
sync.on('batch', ({ applied, deadLettered, checkpoint }) => {
  /* … */
});
sync.on('retry', ({ attempt, retryInMs, error }) => {
  /* upstream degraded */
});
sync.on('deadLetter', (entry) => {
  /* needs a human */
});
sync.on('overflow', ({ pending, compacted }) => {
  /* long outage */
});
sync.on('drained', ({ checkpoint }) => {
  /* fully caught up */
});
sync.on('error', (err) => {
  /* replication stopped */
});

const status = await sync.status();
// { running, connected, checkpoint, pending, applied, retries, deadLettered, … }
```

Register an `error` listener if you rely on `maxRetries`: without one, a
replicator that gives up logs to the console instead.

`await sync.waitForDrain()` resolves once everything written _before the call_
has reached the upstream — useful in tests and before a controlled shutdown.

## Latency

The replicator polls the outbox every `pollIntervalMs` (250ms by default), so
that bounds worst-case replication latency. Two ways to tighten it:

```typescript
sync.notify(); // Check now — call after a write that matters
client.syncToMongo({ pollIntervalMs: 50 });
```

`notify()` is the cheaper option: it wakes the current poll immediately rather
than making every idle cycle busier.

## Multiple upstreams

Replicators sharing one database each keep their own checkpoint, and outbox rows
are pruned only once _every_ registered replicator has passed them.

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

| Table                           | Purpose                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `__mongolite_sync_outbox__`     | Captured changes awaiting replication                                      |
| `__mongolite_sync_state__`      | Per-replicator checkpoint and backfill progress                            |
| `__mongolite_sync_deadletter__` | Permanently rejected changes, kept for inspection                          |
| `__mongolite_sync_shadow__`     | Last-known upstream state per document, for diffing and conflict detection |

## Limitations

- **One-way.** Upstream changes are not streamed back down. A document is pulled down
  only when a push to it conflicts, so a local copy can be stale until something tries
  to write to it.
- **Cooperative versioning.** `_v` detects concurrent writers that use the same
  protocol. A foreign application writing directly without incrementing `_v` is not
  detected.
- **Arrays are replaced whole**, never diffed positionally.
- **The shadow doubles local storage** for replicated documents.
- **Document-level granularity.** Whole documents are replicated, not field
  deltas. Very large documents cost proportionally more bandwidth.
- **Deletes need triggers installed.** A document deleted while its collection
  had no capture triggers is not replicated. Triggers stay installed once
  created, so this only affects the window before the first `start()` — which
  the initial backfill covers for inserts but cannot for deletes.
