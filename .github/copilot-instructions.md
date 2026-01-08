# Copilot Instructions for MongoLite

MongoLite is a MongoDB-like client that uses SQLite as its underlying persistent store, written entirely in TypeScript. This file provides guidelines for Copilot when assisting with development on this project.

## Project Overview

**MongoLite** provides a familiar MongoDB API with SQLite persistence, offering developers:
- MongoDB-like CRUD operations (`insertOne`, `findOne`, `updateOne`, `deleteOne`, etc.)
- SQLite file-based persistence
- Automatic UUID generation and indexing
- Write-Ahead Logging (WAL) mode for better concurrency
- JSON field querying capabilities
- Interactive query debugger
- Change streams for real-time change tracking
- Comprehensive JSON safety and data integrity protection

**Technology Stack:**
- **Language:** TypeScript 5.8+
- **Node:** 18.0.0 or higher
- **Database:** SQLite (better-sqlite3)
- **Testing:** Node.js native test runner with c8 coverage
- **Code Style:** ESLint + Prettier (2-space indentation)

## Project Structure

```
src/
├── index.ts              # Main entry point
├── db.ts                 # Database client class
├── collection.ts         # Collection class (MongoDB-like operations)
├── types.ts              # TypeScript type definitions
├── changeStream.ts       # Change stream implementation
├── bin/
│   └── mongolite-debug.ts # CLI debugger tool
├── cursors/
│   └── findCursor.ts     # Cursor implementation for queries
├── debugger/
│   └── query-debugger.ts # Query debugging utilities
├── plugins/
│   └── mongodbSync.ts    # MongoDB sync plugin
└── utils/
    └── indexing.ts       # Indexing utilities

tests/                    # Test suite (native Node.js test runner)
├── collection.*.test.ts  # Collection operation tests
├── index.test.ts         # Main export tests
└── mongodb-sync.test.ts  # Sync plugin tests

examples/
├── basic-usage.ts        # Basic CRUD example
├── advanced-usage.ts     # Advanced features example
├── indexing.ts           # Indexing example
└── change-stream.ts      # Change stream example
```

## Development Commands

**Build & Compilation:**
- `npm run build` - Compile TypeScript to JavaScript (dist/)
- `npm run verify-build` - Verify build integrity

**Testing:**
- `npm test` - Run all tests
- `npm run test:coverage` - Run tests with coverage report (generates lcov.info)
- `npm run test-third-party` - Test third-party usage
- `npm run test:all` - Run lint, tests, build verification, and third-party tests

**Code Quality:**
- `npm run lint` - Run ESLint to check code style
- `npm run lint:fix` - Auto-fix ESLint issues

**Debugging & Analysis:**
- `npm run benchmark` - Run performance benchmarks
- `npm run debug-queries` - Interactive query debugger
- `npx mongolite-debug` - CLI debugger tool

**Examples:**
- `npx ts-node examples/basic-usage.ts` - Run basic usage example
- `npx ts-node examples/advanced-usage.ts` - Run advanced features example

## Code Style Guidelines

### TypeScript Configuration
- **Target:** ES2020
- **Module System:** NodeNext
- **Strict Mode:** Enabled
- **Source Maps:** Enabled for debugging
- **Decorator Support:** Enabled

### Code Formatting Standards
- **Indentation:** 2 spaces (never tabs)
- **Line Length:** Consider readability (no hard limit, but keep reasonable)
- **Quotes:** Single quotes for strings
- **Semicolons:** Always required
- **Trailing Commas:** Use where applicable (ES5+)

**Run these before committing:**
```bash
npm run lint:fix  # Auto-fix style issues
npm run build     # Ensure TypeScript compiles cleanly
npm test          # Ensure all tests pass
```

## Type System & Interfaces

### Key Types (from types.ts)
- **Document:** Any JSON-serializable object with optional `_id` field
- **Query:** MongoDB-style query object for filtering
- **Update:** Update operators for modifying documents
- **Projection:** Field selection for query results
- **Filter/Sort/Limit:** Chainable cursor operations

### Document Validation
- Automatically validates documents before storage
- Rejects non-JSON-serializable data (functions, symbols, BigInt, RegExp, circular references)
- Performs round-trip verification to ensure data integrity
- Returns special `__mongoLiteCorrupted` objects for unrecoverable data

## Testing Standards

### Test File Organization
- One test file per feature/operation
- Naming: `collection.<feature>.test.ts`
- Use Node.js native test runner with `test()` and `describe()` functions
- Import `test` from `node:test` and use `assert` for assertions

### Coverage Requirements
- Target 100% code coverage (or as close as practical)
- Coverage reports generated in `coverage/` directory
- Use `c8` for coverage collection

### Example Test Structure
```typescript
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index.js';

describe('Feature Name', () => {
  test('should do something', async () => {
    const db = new MongoLite(':memory:');
    const collection = db.collection('test');
    // ... test implementation
    assert.strictEqual(result, expected);
  });
});
```

## Contributing Guidelines

### Before Making Changes
1. Check existing test coverage - add tests for new features
2. Update documentation if APIs change
3. Ensure code follows style guidelines
4. Create focused, atomic commits

### Pull Request Checklist
- [ ] Tests pass (`npm test`)
- [ ] Linting passes (`npm run lint`)
- [ ] Build succeeds (`npm run build`)
- [ ] Code coverage is maintained/improved
- [ ] Documentation updated if needed
- [ ] Commit messages are clear and descriptive

### Code Review Expectations
- TypeScript strict mode must be satisfied
- All tests must pass
- No console.log() statements in production code
- Error handling should be comprehensive
- Performance impact should be considered

## Architecture Patterns

### Collection Class (`src/collection.ts`)
- Implements MongoDB-like CRUD operations
- Each operation returns Promises for async handling
- Uses SQLite for persistence
- Supports indexing for performance

### Cursor Class (`src/cursors/findCursor.ts`)
- Chainable API for query building
- Methods: `skip()`, `limit()`, `sort()`, `project()`
- Lazy evaluation - queries only execute on `.toArray()` or `.next()`

### Change Streams (`src/changeStream.ts`)
- Real-time change tracking
- Watch collections for insert, update, delete operations
- Similar to MongoDB change streams API

### Query Debugger (`src/bin/mongolite-debug.ts`)
- Interactive tool for debugging complex queries
- Shows query execution details
- Accessible via CLI: `npx mongolite-debug`

## Common Tasks

### Adding a New Feature
1. Create/update source file in `src/`
2. Add TypeScript types in `src/types.ts`
3. Write comprehensive tests in `tests/`
4. Update examples if relevant
5. Run `npm run lint:fix` and `npm test`

### Fixing a Bug
1. Write a test that reproduces the bug
2. Implement the fix
3. Ensure all tests pass including the new one
4. Update CHANGELOG.md if significant

### Updating Documentation
1. Update README.md for user-facing changes
2. Update docs/ directory for detailed guides
3. Update example files if API changes
4. Run `npm run lint` to check markdown if applicable

## Known Constraints & Considerations

- **SQLite Limitations:** Single-file database, not suitable for highly concurrent write-heavy scenarios
- **WAL Mode:** Recommended for better concurrency but adds file complexity
- **JSON Fields:** Queryable but with SQLite JSON1 extension limitations
- **Data Types:** All data must be JSON-serializable - no custom types
- **Node.js Only:** Built for Node.js, not browser-compatible

## Debugging Tips

### Using the Query Debugger
```bash
npm run debug-queries
# or
npx mongolite-debug
```

### Enabling Coverage Reports
```bash
npm run test:coverage
# Open coverage/lcov-report/index.html in browser
```

### Testing in Memory
- Use `:memory:` as database path for fast in-memory testing
- Useful for unit tests to avoid file I/O

### Common Error Patterns
- **Validation Errors:** Check document structure and data types
- **Type Errors:** Ensure strict TypeScript types are satisfied
- **Concurrency Issues:** Consider WAL mode for multiple connections
- **JSON Corruption:** Check for circular references or non-serializable data

## Performance Considerations

- Index frequently queried fields with `createIndex()`
- Use projections to limit returned fields
- Batch operations when possible
- Consider WAL mode for concurrent read access
- Monitor database file size for long-running processes

## References

- **README.md** - User guide and feature overview
- **CONTRIBUTING.md** - Contribution guidelines
- **CHANGELOG.md** - Version history and breaking changes
- **docs/DEBUGGER.md** - Query debugger documentation
- **docs/JSON_SAFETY.md** - JSON safety and data integrity features
