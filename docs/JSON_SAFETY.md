# JSON Safety & Data Integrity

MongoLite includes robust safeguards to prevent and handle malformed JSON data that could cause application failures or data corruption.

## Document Validation

- **Pre-storage validation**: Automatically validates documents before insertion to prevent storing invalid data
- **Type safety**: Rejects non-JSON-serializable data (functions, symbols, BigInt, RegExp, circular references)
- **Round-trip verification**: Ensures all data can be safely stored and retrieved

## Malformed JSON Recovery

- **Graceful degradation**: Handles corrupted JSON data without crashing your application
- **Automatic recovery**: Attempts to fix common JSON corruption issues (escaped quotes, backslashes)
- **Fallback objects**: Returns special marker objects for unrecoverable data with debugging information
- **Error logging**: Detailed logging for debugging and monitoring data integrity issues

## Example Usage

### Preventing Invalid Inserts

```typescript
// Document validation prevents invalid data
try {
  await collection.insertOne({
    name: 'user',
    invalidFunction: () => 'not allowed' // This will be rejected
  });
} catch (error) {
  console.log('Validation error:', error.message);
  // "Cannot insert document: Document validation failed: Functions are not allowed in documents"
}
```

### Handling Corrupted Data

```typescript
// Corrupted data recovery
const doc = await collection.findOne({ _id: 'some-id' });
if (doc && '__mongoLiteCorrupted' in doc) {
  console.log('Found corrupted document');
  console.log('Original data:', doc.__originalData);
  console.log('Error details:', doc.__error);
  // Handle corruption appropriately
}
```

## Types That Are Rejected

| Type | Example | Reason |
|------|---------|--------|
| Functions | `() => {}` | Not JSON-serializable |
| Symbols | `Symbol('foo')` | Not JSON-serializable |
| BigInt | `BigInt(9007199254740991)` | Not JSON-serializable |
| RegExp | `/pattern/gi` | Not JSON-serializable |
| Circular references | `obj.self = obj` | Cannot be stringified |

## Corrupted Document Marker

When a stored document cannot be parsed, MongoLite returns a special marker object instead of crashing:

```typescript
interface CorruptedDocument {
  __mongoLiteCorrupted: true;
  __originalData: string;   // Raw data from the database
  __error: string;          // Description of the parse error
}
```

This allows your application to detect and handle data integrity issues gracefully rather than throwing unexpected exceptions.
