# MongoLite on Cloudflare Durable Objects

MongoLite supports [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
via the `CloudflareDurableObjectAdapter`.  Each Durable Object instance gets its own private
SQLite database (`ctx.storage.sql`); the adapter bridges that runtime API to the standard
MongoLite interface so you can use the same MongoDB-like API you already know.

## Prerequisites

- A Cloudflare Workers project with **SQLite-backed** Durable Objects enabled.
- `mongolite-ts` installed as a dependency.

```jsonc
// wrangler.jsonc
{
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MyDurableObject"]
    }
  ]
}
```

## Installation

```bash
npm install mongolite-ts
```

## Basic Usage

```typescript
import { DurableObject } from 'cloudflare:workers';
import { MongoLite, CloudflareDurableObjectAdapter } from 'mongolite-ts';

interface User {
  _id?: string;
  name: string;
  age: number;
}

export class UserStore extends DurableObject {
  private client: MongoLite;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Pass ctx.storage.sql to the adapter, then use it like any MongoLite client.
    const adapter = new CloudflareDurableObjectAdapter(ctx.storage.sql);
    this.client = new MongoLite(adapter);
  }

  async fetch(request: Request): Promise<Response> {
    await this.client.connect(); // no-op for the CF adapter, safe to call every time

    const users = this.client.collection<User>('users');

    const url = new URL(request.url);

    if (request.method === 'POST') {
      const body = await request.json<User>();
      const result = await users.insertOne(body);
      return Response.json({ insertedId: result.insertedId });
    }

    if (request.method === 'GET') {
      const name = url.searchParams.get('name');
      const user = name ? await users.findOne({ name }) : null;
      return Response.json(user);
    }

    return new Response('Not found', { status: 404 });
  }
}
```

## Schema Initialization

Use `ctx.blockConcurrencyWhile` to ensure the collection table is created before any
requests are handled — this is the recommended Cloudflare pattern for one-time setup:

```typescript
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);

  const adapter = new CloudflareDurableObjectAdapter(ctx.storage.sql);
  this.client = new MongoLite(adapter);

  ctx.blockConcurrencyWhile(async () => {
    // Ensures the table exists before the first request arrives.
    await this.client.collection('users').ensureTable();
  });
}
```

## Supported Operations

All core MongoLite CRUD operations are supported:

| Method | Supported |
|--------|-----------|
| `insertOne()` | ✅ |
| `insertMany()` | ✅ |
| `findOne()` | ✅ |
| `find()` | ✅ |
| `updateOne()` | ✅ |
| `updateMany()` | ✅ |
| `deleteOne()` | ✅ |
| `deleteMany()` | ✅ |
| `countDocuments()` | ✅ |
| `estimatedDocumentCount()` | ✅ |
| `distinct()` | ✅ |
| `findOneAndUpdate()` | ✅ |
| `findOneAndDelete()` | ✅ |
| `findOneAndReplace()` | ✅ |
| `replaceOne()` | ✅ |
| `aggregate()` | ✅ |
| `createIndex()` | ✅ |
| `listIndexes()` | ✅ |
| `dropIndex()` | ✅ |
| `drop()` | ✅ |
| `watch()` (Change Streams) | ✅ (see note below) |
| `$regex` queries | ❌ (see Limitations) |

## Limitations

### `$regex` queries are not supported

The default `SQLiteDB` adapter registers a custom `regexp()` SQL function to support
`$regex` query operators.  Cloudflare Durable Objects do not allow registering custom
SQL functions, so any query that uses `$regex` will throw a SQL error at runtime.

Use JavaScript-side filtering as a workaround:

```typescript
// ❌ Not supported on Cloudflare
const docs = await col.find({ name: { $regex: '^Ali' } }).toArray();

// ✅ Workaround — fetch candidates and filter in JS
const docs = (await col.find({}).toArray()).filter(d => /^Ali/.test(d.name));
```

### WAL mode and PRAGMA statements

Cloudflare Durable Objects manage journaling and concurrency internally; `WAL` mode and
most `PRAGMA` statements are not available.  The adapter simply omits them.

### Change Streams

Change Streams (`collection.watch()`) use SQL triggers and a polling mechanism based on
`setInterval`.  Both are supported in the Cloudflare Workers runtime.  Be aware that very
high-frequency polling on a Durable Object may increase CPU usage.

### `connect()` and `close()`

Both methods are **no-ops** for the Cloudflare adapter.  The `SqlStorage` instance is
managed by the Durable Object runtime and does not need to be explicitly opened or closed.

## API Reference

### `CloudflareDurableObjectAdapter`

```typescript
import { CloudflareDurableObjectAdapter } from 'mongolite-ts';

const adapter = new CloudflareDurableObjectAdapter(ctx.storage.sql);
```

The constructor accepts a single argument: the `SqlStorage` instance exposed by the
Durable Object context (`ctx.storage.sql`).

### `IDatabaseAdapter`

`CloudflareDurableObjectAdapter` implements the `IDatabaseAdapter` interface that is also
implemented by the built-in `SQLiteDB` class.  You can use this interface to write code
that works with both backends:

```typescript
import { IDatabaseAdapter, MongoLite } from 'mongolite-ts';

function createClient(adapter: IDatabaseAdapter): MongoLite {
  return new MongoLite(adapter);
}
```

## Environment Compatibility

| Environment | Adapter to use |
|---|---|
| Node.js / Bun / CLI | Default (`new MongoLite('./my.db')`) |
| Cloudflare Durable Objects | `CloudflareDurableObjectAdapter` |
| Testing / CI | `':memory:'` path with default adapter, or `MockSqlStorage` (see tests) |
