import { EventEmitter } from 'events';
import { SQLiteDB } from './db.js';
import { DocumentWithId, Filter } from './types.js';

export type ChangeOperationType = 'insert' | 'update' | 'delete' | 'replace';

export interface ChangeStreamDocument<T extends DocumentWithId = DocumentWithId> {
  _id: string;
  operationType: ChangeOperationType;
  clusterTime?: Date;
  fullDocument?: T;
  fullDocumentBeforeChange?: T;
  documentKey: { _id: string };
  ns: {
    db: string;
    coll: string;
  };
  updateDescription?: {
    updatedFields: Record<string, unknown>;
    removedFields: string[];
  };
}

export interface ChangeStreamOptions<T extends DocumentWithId = DocumentWithId> {
  /**
   * Filter to apply to change events
   */
  filter?: Filter<ChangeStreamDocument<T>>;

  /**
   * Whether to include the full document in insert and update operations
   */
  fullDocument?: 'default' | 'updateLookup' | 'whenAvailable' | 'required';

  /**
   * Whether to include the full document before the change for update operations
   */
  fullDocumentBeforeChange?: 'off' | 'whenAvailable' | 'required';

  /**
   * Resume token for resuming change streams (not implemented in this version)
   */
  resumeAfter?: string;

  /**
   * Maximum number of events to buffer
   */
  maxBufferSize?: number;
}

export class ChangeStream<T extends DocumentWithId = DocumentWithId> extends EventEmitter {
  private closed = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private lastProcessedId = 0;
  private buffer: ChangeStreamDocument<T>[] = [];
  private readonly maxBufferSize: number;

  constructor(
    private readonly db: SQLiteDB,
    private readonly collectionName: string,
    private readonly options: ChangeStreamOptions<T> = {}
  ) {
    super();
    this.maxBufferSize = options.maxBufferSize || 1000;
    this.setupChangeTracking();
    this.startPolling();
  }

  /**
   * Sets up the change tracking infrastructure
   */
  private async setupChangeTracking(): Promise<void> {
    await this.ensureChangeLogTable();
    await this.setupTriggers();
  }

  /**
   * Creates the change log table if it doesn't exist
   */
  private async ensureChangeLogTable(): Promise<void> {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS __mongolite_changes__ (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        operation_type TEXT NOT NULL,
        collection_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        full_document TEXT,
        full_document_before TEXT,
        updated_fields TEXT,
        removed_fields TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `;

    const createIndexSQL = `
      CREATE INDEX IF NOT EXISTS idx_mongolite_changes_collection_timestamp 
      ON __mongolite_changes__ (collection_name, timestamp);
    `;

    await this.db.exec(createTableSQL);
    await this.db.exec(createIndexSQL);
  }

  /**
   * Sets up triggers for tracking changes on the collection
   */
  private async setupTriggers(): Promise<void> {
    const collectionName = this.collectionName;

    // Drop existing triggers for this collection
    await this.db.exec(`DROP TRIGGER IF EXISTS "${collectionName}_insert_trigger"`);
    await this.db.exec(`DROP TRIGGER IF EXISTS "${collectionName}_update_trigger"`);
    await this.db.exec(`DROP TRIGGER IF EXISTS "${collectionName}_delete_trigger"`);

    // Insert trigger
    const insertTriggerSQL = `
      CREATE TRIGGER "${collectionName}_insert_trigger"
      AFTER INSERT ON "${collectionName}"
      FOR EACH ROW
      BEGIN
        INSERT INTO __mongolite_changes__ (
          operation_type, collection_name, document_id, full_document
        ) VALUES (
          'insert', '${collectionName}', NEW._id, NEW.data
        );
      END;
    `;

    // Update trigger
    const updateTriggerSQL = `
      CREATE TRIGGER "${collectionName}_update_trigger"
      AFTER UPDATE ON "${collectionName}"
      FOR EACH ROW
      BEGIN
        INSERT INTO __mongolite_changes__ (
          operation_type, collection_name, document_id, 
          full_document, full_document_before
        ) VALUES (
          'update', '${collectionName}', NEW._id, 
          NEW.data, OLD.data
        );
      END;
    `;

    // Delete trigger
    const deleteTriggerSQL = `
      CREATE TRIGGER "${collectionName}_delete_trigger"
      AFTER DELETE ON "${collectionName}"
      FOR EACH ROW
      BEGIN
        INSERT INTO __mongolite_changes__ (
          operation_type, collection_name, document_id, full_document_before
        ) VALUES (
          'delete', '${collectionName}', OLD._id, OLD.data
        );
      END;
    `;

    await this.db.exec(insertTriggerSQL);
    await this.db.exec(updateTriggerSQL);
    await this.db.exec(deleteTriggerSQL);
  }

  /**
   * Starts polling for new changes
   */
  private startPolling(): void {
    if (this.closed) return;

    this.pollInterval = setInterval(async () => {
      try {
        await this.pollForChanges();
      } catch (error) {
        this.emit('error', error);
      }
    }, 100); // Poll every 100ms
  }

  /**
   * Polls for new changes from the change log
   */
  private async pollForChanges(): Promise<void> {
    if (this.closed) return;

    const changes = await this.db.all<{
      id: number;
      timestamp: string;
      operation_type: ChangeOperationType;
      collection_name: string;
      document_id: string;
      full_document: string | null;
      full_document_before: string | null;
      updated_fields: string | null;
      removed_fields: string | null;
    }>(
      `SELECT * FROM __mongolite_changes__ 
       WHERE collection_name = ? AND id > ? 
       ORDER BY id ASC LIMIT 100`,
      [this.collectionName, this.lastProcessedId]
    );

    for (const change of changes) {
      if (this.closed) break;

      const changeDoc = await this.transformChangeEvent(change);

      if (this.passesFilter(changeDoc)) {
        this.buffer.push(changeDoc);

        // Emit the change event
        this.emit('change', changeDoc);

        // Clean buffer if it gets too large
        if (this.buffer.length > this.maxBufferSize) {
          this.buffer = this.buffer.slice(-this.maxBufferSize);
        }
      }

      this.lastProcessedId = change.id;
    }
  }

  /**
   * Transforms a raw change event from the database into a ChangeStreamDocument
   */
  private async transformChangeEvent(change: {
    id: number;
    timestamp: string;
    operation_type: ChangeOperationType;
    collection_name: string;
    document_id: string;
    full_document: string | null;
    full_document_before: string | null;
    updated_fields: string | null;
    removed_fields: string | null;
  }): Promise<ChangeStreamDocument<T>> {
    const fullDocument = change.full_document ? JSON.parse(change.full_document) : undefined;
    const fullDocumentBefore = change.full_document_before
      ? JSON.parse(change.full_document_before)
      : undefined;

    let updateDescription: ChangeStreamDocument<T>['updateDescription'] | undefined;

    if (change.operation_type === 'update' && fullDocument && fullDocumentBefore) {
      updateDescription = this.computeUpdateDescription(fullDocumentBefore, fullDocument);
    }

    const changeDoc: ChangeStreamDocument<T> = {
      _id: `${change.id}`, // Use the change log ID as the change stream document ID
      operationType: change.operation_type,
      clusterTime: new Date(change.timestamp),
      documentKey: { _id: change.document_id },
      ns: {
        db: 'mongolite', // You could make this configurable
        coll: change.collection_name,
      },
    };

    // Add full document based on options
    if (this.shouldIncludeFullDocument(change.operation_type)) {
      changeDoc.fullDocument = fullDocument
        ? { _id: change.document_id, ...fullDocument }
        : undefined;
    }

    // Add full document before change based on options
    if (this.shouldIncludeFullDocumentBefore(change.operation_type)) {
      changeDoc.fullDocumentBeforeChange = fullDocumentBefore
        ? { _id: change.document_id, ...fullDocumentBefore }
        : undefined;
    }

    if (updateDescription) {
      changeDoc.updateDescription = updateDescription;
    }

    return changeDoc;
  }

  /**
   * Computes the update description by comparing before and after documents
   */
  private computeUpdateDescription(
    before: unknown,
    after: unknown
  ): ChangeStreamDocument<T>['updateDescription'] {
    const updatedFields: Record<string, unknown> = {};
    const removedFields: string[] = [];

    // Type guard to ensure we have objects to compare
    if (
      typeof before !== 'object' ||
      before === null ||
      typeof after !== 'object' ||
      after === null
    ) {
      return { updatedFields, removedFields };
    }

    // Simple comparison - this could be made more sophisticated
    const beforeObj = before as Record<string, unknown>;
    const afterObj = after as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);

    for (const key of allKeys) {
      if (!(key in afterObj)) {
        removedFields.push(key);
      } else if (
        !(key in beforeObj) ||
        JSON.stringify(beforeObj[key]) !== JSON.stringify(afterObj[key])
      ) {
        updatedFields[key] = afterObj[key];
      }
    }

    return { updatedFields, removedFields };
  }

  /**
   * Determines if the full document should be included
   */
  private shouldIncludeFullDocument(operationType: ChangeOperationType): boolean {
    const option = this.options.fullDocument || 'default';

    switch (option) {
      case 'default':
        return operationType === 'insert';
      case 'updateLookup':
      case 'whenAvailable':
      case 'required':
        return (
          operationType === 'insert' || operationType === 'update' || operationType === 'replace'
        );
      default:
        return false;
    }
  }

  /**
   * Determines if the full document before change should be included
   */
  private shouldIncludeFullDocumentBefore(operationType: ChangeOperationType): boolean {
    const option = this.options.fullDocumentBeforeChange || 'off';

    if (option === 'off') return false;

    return operationType === 'update' || operationType === 'replace' || operationType === 'delete';
  }

  /**
   * Checks if a change document passes the filter
   */
  private passesFilter(changeDoc: ChangeStreamDocument<T>): boolean {
    if (!this.options.filter) return true;

    // Simple filter implementation - could be enhanced
    // For now, just check basic equality filters
    for (const [key, value] of Object.entries(this.options.filter)) {
      const docValue = (changeDoc as unknown as Record<string, unknown>)[key];
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Handle operators like $in, $eq, etc.
        // This is a simplified implementation
        continue;
      } else if (docValue !== value) {
        return false;
      }
    }

    return true;
  }

  /**
   * Returns an async iterator for the change stream
   */
  async *[Symbol.asyncIterator](): AsyncIterableIterator<ChangeStreamDocument<T>> {
    while (!this.closed) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      } else {
        // Wait for next change
        await new Promise<void>((resolve) => {
          const onChange = () => {
            this.removeListener('change', onChange);
            this.removeListener('close', onClose);
            resolve();
          };

          const onClose = () => {
            this.removeListener('change', onChange);
            this.removeListener('close', onClose);
            resolve();
          };

          this.once('change', onChange);
          this.once('close', onClose);
        });
      }
    }
  }

  /**
   * Closes the change stream
   */
  close(): void {
    if (this.closed) return;

    this.closed = true;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.emit('close');
    this.removeAllListeners();
  }

  /**
   * Returns the next change document
   */
  async next(): Promise<{ value: ChangeStreamDocument<T>; done: boolean }> {
    if (this.closed) {
      return { value: {} as ChangeStreamDocument<T>, done: true };
    }

    if (this.buffer.length > 0) {
      return { value: this.buffer.shift()!, done: false };
    }

    // Wait for next change
    return new Promise((resolve) => {
      const onChange = (changeDoc: ChangeStreamDocument<T>) => {
        this.removeListener('change', onChange);
        this.removeListener('close', onClose);
        resolve({ value: changeDoc, done: false });
      };

      const onClose = () => {
        this.removeListener('change', onChange);
        this.removeListener('close', onClose);
        resolve({ value: {} as ChangeStreamDocument<T>, done: true });
      };

      this.once('change', onChange);
      this.once('close', onClose);
    });
  }

  /**
   * Cleanup triggers when the change stream is destroyed
   */
  async cleanup(): Promise<void> {
    const collectionName = this.collectionName;

    try {
      await this.db.exec(`DROP TRIGGER IF EXISTS "${collectionName}_insert_trigger"`);
      await this.db.exec(`DROP TRIGGER IF EXISTS "${collectionName}_update_trigger"`);
      await this.db.exec(`DROP TRIGGER IF EXISTS "${collectionName}_delete_trigger"`);
    } catch (error) {
      // Ignore errors during cleanup
      console.warn('Error during change stream cleanup:', error);
    }
  }
}
