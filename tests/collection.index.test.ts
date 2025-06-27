import { describe, it, beforeEach, afterEach } from 'node:test';
import { MongoLite } from '../src/index.js';
import { DocumentWithId } from '../src/types.js';
import expect from 'expect';

interface User extends DocumentWithId {
  name: string;
  email: string;
  age: number;
  address: {
    city: string;
    country: string;
  };
  tags: string[];
}

describe('Collection Indexing', async () => {
  let client: MongoLite;
  let usersCollection: ReturnType<typeof client.collection<User>>;

  beforeEach(async () => {
    // Use in-memory database for tests
    client = new MongoLite(':memory:');
    await client.connect();
    usersCollection = client.collection<User>('users');
  });

  afterEach(async () => {
    // Clean up after each test by dropping all indexes
    await usersCollection.dropIndexes();
    await client.close();
  });

  // Sample data for testing
  const sampleUsers = [
    {
      name: 'Alice Smith',
      email: 'alice@example.com',
      age: 30,
      address: { city: 'New York', country: 'USA' },
      tags: ['customer', 'premium'],
    },
    {
      name: 'Bob Johnson',
      email: 'bob@example.com',
      age: 25,
      address: { city: 'London', country: 'UK' },
      tags: ['customer'],
    },
    {
      name: 'Charlie Brown',
      email: 'charlie@example.com',
      age: 35,
      address: { city: 'Paris', country: 'France' },
      tags: ['customer', 'premium', 'beta'],
    },
    {
      name: 'Diana Prince',
      email: 'diana@example.com',
      age: 28,
      address: { city: 'Berlin', country: 'Germany' },
      tags: ['customer', 'beta'],
    },
  ];

  const insertSampleData = async () => {
    await usersCollection.insertMany(sampleUsers);
  };

  it('should create a simple index', async () => {
    // Create a simple index on the name field
    const result = await usersCollection.createIndex({ name: 1 });

    // Verify the result
    expect(result.acknowledged).toBe(true);
    expect(result.name).toMatch(/users_name_1/);

    // Verify the index exists in the list
    const indexes = await usersCollection.listIndexes().toArray();
    expect(indexes.length).toBe(1);
    expect(indexes[0].name).toBe(result.name);
    expect(indexes[0].key).toEqual({ name: 1 });
    expect(indexes[0].unique).toBeFalsy();
  });

  it('should create a unique index', async () => {
    await insertSampleData();

    // Create a unique index on email
    const result = await usersCollection.createIndex(
      { email: 1 },
      { unique: true, name: 'idx_email_unique' }
    );

    // Verify the result
    expect(result.acknowledged).toBe(true);
    expect(result.name).toBe('idx_email_unique');

    // Verify the index exists in the list
    const indexes = await usersCollection.listIndexes().toArray();
    expect(indexes.length).toBe(1);
    expect(indexes[0].name).toBe('idx_email_unique');
    expect(indexes[0].key).toEqual({ email: 1 });
    expect(indexes[0].unique).toBe(true);

    // Test that the unique constraint works by attempting to insert a duplicate
    await expect(
      usersCollection.insertOne({
        name: 'Alice Clone',
        email: 'alice@example.com', // Already exists
        age: 31,
        address: { city: 'Chicago', country: 'USA' },
        tags: ['customer'],
      })
    ).rejects.toThrow();
  });

  it('should create a compound index', async () => {
    // Create a compound index on age (descending) and name (ascending)
    const result = await usersCollection.createIndex({ age: -1, name: 1 });

    // Verify the result
    expect(result.acknowledged).toBe(true);
    expect(result.name).toMatch(/users_age_-1_name_1/);

    // Verify the index exists in the list
    const indexes = await usersCollection.listIndexes().toArray();
    expect(indexes.length).toBe(1);
    expect(indexes[0].key).toEqual({ age: -1, name: 1 });
  });

  it('should create an index on a nested field', async () => {
    // Create an index on the nested address.city field
    const result = await usersCollection.createIndex({ 'address.city': 1 });

    // Verify the result
    expect(result.acknowledged).toBe(true);
    expect(result.name).toMatch(/users_address_city_1/);

    // Verify the index exists in the list
    const indexes = await usersCollection.listIndexes().toArray();
    expect(indexes.length).toBe(1);
    expect(indexes[0].key).toEqual({ 'address.city': 1 });
  });

  it('should drop a specific index', async () => {
    // Create two indexes
    const index1 = await usersCollection.createIndex({ name: 1 });
    const index2 = await usersCollection.createIndex({ age: -1 });

    // Verify both indexes exist
    let indexes = await usersCollection.listIndexes().toArray();
    expect(indexes.length).toBe(2);

    // Drop one index
    const dropResult = await usersCollection.dropIndex(index1.name);
    expect(dropResult.acknowledged).toBe(true);
    expect(dropResult.name).toBe(index1.name);

    // Verify only one index remains
    indexes = await usersCollection.listIndexes().toArray();
    expect(indexes.length).toBe(1);
    expect(indexes[0].name).toBe(index2.name);
  });

  it('should drop all indexes', async () => {
    // Create multiple indexes
    await usersCollection.createIndex({ name: 1 });
    await usersCollection.createIndex({ age: -1 });
    await usersCollection.createIndex({ 'address.city': 1 });

    // Verify indexes exist
    const indexes = await usersCollection.listIndexes().toArray();
    expect(indexes.length).toBe(3);
    expect(indexes[2].key).toEqual({ 'address.city': 1 });

    // Drop all indexes
    const dropResult = await usersCollection.dropIndexes();
    expect(dropResult.acknowledged).toBe(true);
    expect(dropResult.droppedCount).toBe(3);

    // Verify no indexes remain
    const remainingIndexes = await usersCollection.listIndexes().toArray();
    expect(remainingIndexes.length).toBe(0);
  });

  it('should handle index names correctly', async () => {
    // Create index with auto-generated name
    const index1 = await usersCollection.createIndex({ name: 1 });
    expect(index1.name).toMatch(/users_name_1/);

    // Create index with custom name
    const index2 = await usersCollection.createIndex({ age: -1 }, { name: 'custom_age_index' });
    expect(index2.name).toBe('custom_age_index');

    // Verify both indexes
    const indexes = await usersCollection.listIndexes().toArray();
    expect(indexes.length).toBe(2);
    expect(indexes.some((idx) => idx.name === index1.name)).toBe(true);
    expect(indexes.some((idx) => idx.name === 'custom_age_index')).toBe(true);
  });

  it('should reject creating a duplicate unique index value', async () => {
    await insertSampleData();

    // Create unique index
    await usersCollection.createIndex({ email: 1 }, { unique: true });

    // Try to insert a document with a duplicate email
    await expect(
      usersCollection.insertOne({
        name: 'Duplicate Email',
        email: 'alice@example.com', // Already exists
        age: 40,
        address: { city: 'Tokyo', country: 'Japan' },
        tags: ['customer'],
      })
    ).rejects.toThrow();
  });

  it('should allow non-unique indexed values when not set as unique', async () => {
    // Create non-unique index
    await usersCollection.createIndex({ age: 1 });

    // Insert documents with the same age
    await usersCollection.insertOne({
      name: 'Person 1',
      email: 'person1@example.com',
      age: 30,
      address: { city: 'City 1', country: 'Country 1' },
      tags: [],
    });

    // This should not throw since the index is not unique
    await usersCollection.insertOne({
      name: 'Person 2',
      email: 'person2@example.com',
      age: 30, // Same age
      address: { city: 'City 2', country: 'Country 2' },
      tags: [],
    });

    // Verify both documents exist
    const count = await usersCollection.find({ age: 30 }).count();
    expect(count).toBe(2);
  });
});
