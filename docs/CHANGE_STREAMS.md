# Change Streams

MongoLite supports real-time change tracking through change streams, similar to MongoDB's `collection.watch()` feature. Change streams allow you to monitor and react to data changes (inserts, updates, deletes) in real-time.

## Basic Usage

```typescript
import { MongoLite } from 'mongolite-ts';

const client = new MongoLite('./mydatabase.sqlite');
const collection = client.collection('users');

// Create a change stream
const changeStream = collection.watch({
  fullDocument: 'updateLookup',              // Include full document on updates
  fullDocumentBeforeChange: 'whenAvailable'  // Include document before change
});

// Listen for changes
changeStream.on('change', (change) => {
  console.log('Change detected:', {
    operation: change.operationType,        // 'insert', 'update', 'delete'
    documentId: change.documentKey._id,
    collection: change.ns.coll,
    timestamp: change.clusterTime
  });

  if (change.fullDocument) {
    console.log('New document state:', change.fullDocument);
  }

  if (change.updateDescription) {
    console.log('Updated fields:', change.updateDescription.updatedFields);
    console.log('Removed fields:', change.updateDescription.removedFields);
  }
});

// Handle errors
changeStream.on('error', (error) => {
  console.error('Change stream error:', error);
});

// Perform operations — changes will be captured
await collection.insertOne({ name: 'Alice', age: 30 });
await collection.updateOne({ name: 'Alice' }, { $set: { age: 31 } });
await collection.deleteOne({ name: 'Alice' });

// Close the change stream when done
changeStream.close();
```

## Async Iteration

Change streams support async iteration for a more declarative approach:

```typescript
const changeStream = collection.watch();

for await (const change of changeStream) {
  console.log('Change detected:', change.operationType);

  // Break after processing some changes
  if (someCondition) {
    changeStream.close();
    break;
  }
}
```

## Options

```typescript
interface ChangeStreamOptions {
  // Filter to apply to change events
  filter?: Filter<ChangeStreamDocument>;

  // Whether to include the full document in insert and update operations
  fullDocument?: 'default' | 'updateLookup' | 'whenAvailable' | 'required';

  // Whether to include the full document before the change
  fullDocumentBeforeChange?: 'off' | 'whenAvailable' | 'required';

  // Maximum number of events to buffer
  maxBufferSize?: number;
}

// Example with options
const changeStream = collection.watch({
  fullDocument: 'updateLookup',
  fullDocumentBeforeChange: 'whenAvailable',
  maxBufferSize: 500
});
```

## Change Document Structure

Each change event contains detailed information about the operation:

```typescript
interface ChangeStreamDocument {
  _id: string;                    // Unique change event ID
  operationType: 'insert' | 'update' | 'delete' | 'replace';
  clusterTime?: Date;             // Timestamp of the change
  fullDocument?: T;               // Full document (based on options)
  fullDocumentBeforeChange?: T;   // Document before change (based on options)
  documentKey: { _id: string };   // ID of the affected document
  ns: {                           // Namespace information
    db: string;                   // Database name
    coll: string;                 // Collection name
  };
  updateDescription?: {           // Update details (for update operations)
    updatedFields: Record<string, unknown>;
    removedFields: string[];
  };
}
```

## Implementation Details

- **SQLite Triggers**: Uses SQLite triggers to capture changes automatically
- **Change Log Table**: Stores change events in a dedicated `__mongolite_changes__` table
- **Polling**: Efficiently polls for new changes every 100ms
- **Cleanup**: Automatically cleans up triggers when change streams are closed
- **Error Handling**: Robust error handling for database operations and malformed data

## Best Practices

1. **Close Change Streams**: Always close change streams when done to free resources
2. **Error Handling**: Implement proper error handling for change stream events
3. **Buffer Management**: Consider the `maxBufferSize` option for high-volume scenarios
4. **Cleanup**: Call `changeStream.cleanup()` to remove triggers if needed

```typescript
// Proper cleanup
let changeStream;

try {
  changeStream = collection.watch();

  // ... use change stream

} finally {
  if (changeStream) {
    changeStream.close();
    await changeStream.cleanup(); // Remove triggers if needed
  }
}
```
