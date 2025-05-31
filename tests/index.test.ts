import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection } from '../src/collection';

describe('MongoLite', () => {
  let client: MongoLite;

  beforeEach(async () => {
    // Use :memory: for an in-memory database for each test
    client = new MongoLite(':memory:');
    await client.connect();
  });

  afterEach(async () => {
    await client.close();
  });

  it('should connect to and close the database', async () => {
    // Connection is handled in beforeEach, close in afterEach
    // If those don't throw, this test implicitly passes for basic connect/close
    assert.ok(true, 'Connected and closed without errors');
  });

  it('should create a new MongoLite client with dbPath', () => {
    const localClient = new MongoLite('test.db');
    assert.ok(localClient instanceof MongoLite, 'Client should be an instance of MongoLite');
  });

  it('should create a new MongoLite client with options object', () => {
    const localClient = new MongoLite({ dbPath: ':memory:', verbose: console.log });
    assert.ok(localClient instanceof MongoLite, 'Client should be an instance of MongoLite');
  });

  it('should get a collection', () => {
    const collection = client.collection('testCollection');
    assert.ok(
      collection instanceof MongoLiteCollection,
      'Should return a MongoLiteCollection instance'
    );
    assert.strictEqual(
      collection.name,
      'testCollection',
      'Collection name should be set correctly'
    );
  });

  it('should get a collection with a specific type', () => {
    interface TestDoc {
      _id: string;
      name: string;
      value: number;
    }
    const collection = client.collection<TestDoc>('typedCollection');
    assert.ok(
      collection instanceof MongoLiteCollection,
      'Should return a MongoLiteCollection instance'
    );
    assert.strictEqual(
      collection.name,
      'typedCollection',
      'Collection name should be set correctly'
    );
    // Further tests for typed collection would go into collection.test.ts
  });

  it('should allow multiple collections', () => {
    const collection1 = client.collection('collection1');
    const collection2 = client.collection('collection2');
    assert.ok(
      collection1 instanceof MongoLiteCollection,
      'Collection1 should be a MongoLiteCollection instance'
    );
    assert.strictEqual(collection1.name, 'collection1', 'Collection1 name should be set correctly');
    assert.ok(
      collection2 instanceof MongoLiteCollection,
      'Collection2 should be a MongoLiteCollection instance'
    );
    assert.strictEqual(collection2.name, 'collection2', 'Collection2 name should be set correctly');
  });
});
