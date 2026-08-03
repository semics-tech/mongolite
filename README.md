# MongoLite

[![CI](https://github.com/semics-tech/mongolite/actions/workflows/ci.yml/badge.svg)](https://github.com/semics-tech/mongolite/actions/workflows/ci.yml)
[![NPM version](https://img.shields.io/npm/v/@semics-tech/mongolite.svg)](https://www.npmjs.com/package/@semics-tech/mongolite)
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
- **TypeScript** — fully typed with strict mode

## Installation

```bash
npm install @semics-tech/mongolite
```

Requires **Node.js 22.5.0+** by default — the main entry point is backed by
Node's built-in `node:sqlite` module, so there's no native addon to install or
build. On an older Node.js runtime, use the `better-sqlite3`-backed adapter
instead; see [Native `node:sqlite` vs. `better-sqlite3`](#native-nodesqlite-vs-better-sqlite3) below.

## Quick Start

```typescript
import { MongoLite } from '@semics-tech/mongolite';

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

## How does it compare?

| | MongoLite | lowdb | better-sqlite3 (raw) | NeDB | PouchDB | MongoDB |
|---|---|---|---|---|---|---|
| MongoDB query API (`$set`, `$elemMatch`, aggregation...) | ✅ | ❌ (plain object access) | ❌ (raw SQL) | ✅ | ❌ (Mango/CouchDB-style) | ✅ |
| Runs in the browser | ✅ (sql.js) | ✅ | ❌ (native binding) | ✅ | ✅ (IndexedDB) | ❌ |
| Runs on the edge (Cloudflare Durable Objects) | ✅ | ❌ | ❌ (native binding) | ❌ | ❌ | ❌ |
| Zero infrastructure (no server process) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| TypeScript, strict mode | ✅ | ✅ | ✅ | ⚠️ (community types) | ⚠️ (community types) | ✅ |
| Actively maintained | ✅ | ✅ | ✅ | ❌ (unmaintained) | ⚠️ (slow-moving) | ✅ |

MongoLite's niche: the MongoDB query API you already know, running anywhere SQLite runs — a local file, an in-memory test database, the browser, or a Cloudflare Durable Object — without standing up a MongoDB server.

## Documentation

| Topic | Description |
|-------|-------------|
| [API Reference](./docs/API.md) | Full API docs: methods, query operators, update operators |
| [Change Streams](./docs/CHANGE_STREAMS.md) | Real-time change tracking with `collection.watch()` |
| [JSON Safety](./docs/JSON_SAFETY.md) | Document validation and corrupted data recovery |
| [Query Debugger](./docs/DEBUGGER.md) | Interactive CLI for debugging queries and inspecting SQL |
| [Benchmarks](./docs/BENCHMARKS.md) | Performance benchmarks and storage characteristics |
| [Cloudflare Durable Objects](./docs/CLOUDFLARE.md) | Using MongoLite inside a Cloudflare Durable Object |

## Backend Examples

### SQLite file (Node.js / Bun)

```typescript
import { MongoLite } from '@semics-tech/mongolite';

const client = new MongoLite('./myapp.sqlite');
await client.connect();
const users = client.collection('users');
await users.insertOne({ name: 'Alice', age: 30 });
await client.close();
```

### In-memory (tests / ephemeral)

```typescript
import { MongoLite } from '@semics-tech/mongolite';

const client = new MongoLite(':memory:');
await client.connect();
const users = client.collection('users');
await users.insertOne({ name: 'Alice', age: 30 });
// Data is discarded when the process exits
await client.close();
```

### `better-sqlite3` (optional, for Node.js <22.5 or Bun)

The default backend above uses Node's built-in `node:sqlite` module, which
requires Node.js 22.5.0+. If you're on an older Node.js runtime, or you
simply prefer the more battle-tested native addon, import from the
`mongolite-ts/better-sqlite3` entry point instead. `better-sqlite3` is an
**optional dependency** — install it yourself if it wasn't already pulled in:

```bash
npm install better-sqlite3
```

```typescript
import { MongoLite } from 'mongolite-ts/better-sqlite3';

const client = new MongoLite('./myapp.sqlite');
await client.connect();
const users = client.collection('users');
await users.insertOne({ name: 'Alice', age: 30 });
await client.close();
```

<a id="native-nodesqlite-vs-better-sqlite3"></a>
> **Which one should I use?** `node:sqlite` (the default) is still marked
> experimental upstream but requires no native build step, which is why it's
> the default here. `better-sqlite3` is the older, more battle-tested native
> addon — reach for it if you're stuck on Node.js <22.5, targeting Bun without
> a `node:sqlite` polyfill, or want to avoid depending on an experimental
> Node.js API in production. Both implement the same `IDatabaseAdapter`
> interface, so switching between them is a one-line import change.

### Browser (via sql.js)

Requires [sql.js](https://www.npmjs.com/package/sql.js) (`npm install sql.js`).

```typescript
import initSqlJs from 'sql.js';
import { MongoLite, BrowserSqliteAdapter } from '@semics-tech/mongolite';

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
import { MongoLite, CloudflareDurableObjectAdapter } from '@semics-tech/mongolite/cloudflare';

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
