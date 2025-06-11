import { describe, it, beforeEach, afterEach } from 'node:test';
import { MongoLite } from '../src';
import { expect } from 'expect';

describe('MongoLite List Collections', () => {
  let client: MongoLite;

  beforeEach(() => {
    // Use in-memory database for testing
    client = new MongoLite(':memory:');
  });

  afterEach(async () => {
    await client.close();
  });

  it('should list all collections in the database', async () => {
    // Initially there should be no collections
    let collections = await client.listCollections().toArray();
    expect(collections).toEqual([]);

    // Create a few collections by getting references and inserting data
    const usersCollection = client.collection('users');
    await usersCollection.insertOne({ _id: '1', name: 'Test User' });

    const productsCollection = client.collection('products');
    await productsCollection.insertOne({ _id: '1', name: 'Test Product' });

    const ordersCollection = client.collection('orders');
    await ordersCollection.insertOne({ _id: '1', orderId: 'ORD001' });

    // Now list collections should return the three collections we created
    collections = await client.listCollections().toArray();
    expect(collections).toContain('users');
    expect(collections).toContain('products');
    expect(collections).toContain('orders');
    expect(collections.length).toEqual(3);
  });

  it('should return an empty array if database has no collections', async () => {
    // Connect to a fresh in-memory database
    const emptyClient = new MongoLite(':memory:');

    try {
      const collections = await emptyClient.listCollections().toArray();
      expect(collections).toEqual([]);
      expect(collections.length).toEqual(0);
    } finally {
      await emptyClient.close();
    }
  });
});
