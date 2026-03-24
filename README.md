# MongoLite

[![CI](https://github.com/semics-tech/mongolite/actions/workflows/ci.yml/badge.svg)](https://github.com/semics-tech/mongolite/actions/workflows/ci.yml)
[![NPM version](https://img.shields.io/npm/v/mongolite-ts.svg)](https://www.npmjs.com/package/mongolite-ts)
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
npm install mongolite-ts
```

## Quick Start

```typescript
import { MongoLite } from 'mongolite-ts';

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

## Documentation

| Topic | Description |
|-------|-------------|
| [API Reference](./docs/API.md) | Full API docs: methods, query operators, update operators |
| [Change Streams](./docs/CHANGE_STREAMS.md) | Real-time change tracking with `collection.watch()` |
| [JSON Safety](./docs/JSON_SAFETY.md) | Document validation and corrupted data recovery |
| [Query Debugger](./docs/DEBUGGER.md) | Interactive CLI for debugging queries and inspecting SQL |
| [Benchmarks](./docs/BENCHMARKS.md) | Performance benchmarks and storage characteristics |
| [Cloudflare Durable Objects](./docs/CLOUDFLARE.md) | Using MongoLite inside a Cloudflare Durable Object |

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
