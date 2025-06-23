import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index';

interface GeoDoc extends DocumentWithId {
  name: string;
  type: string;
  location: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
  };
  address?: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  category?: string[];
  tags?: string[];
  rating?: number;
  priceLevel?: number;
  hours?: {
    day: number;
    open: string;
    close: string;
  }[];
  features?: string[];
  established?: number;
  website?: string;
  phoneNumber?: string;
  reviews?: {
    user: string;
    rating: number;
    comment?: string;
    date: string;
  }[];
}

describe('MongoLiteCollection - Specialized Find Operations (Fixed)', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<GeoDoc>;

  // Define test documents for geospatial queries
  const geoTestDocs: GeoDoc[] = [
    {
      _id: '1',
      name: 'Central Park',
      type: 'park',
      location: {
        type: 'Point',
        coordinates: [-73.9654, 40.7829],
      },
      address: {
        street: '59th to 110th St',
        city: 'New York',
        state: 'NY',
        zip: '10022',
        country: 'USA',
      },
      category: ['park', 'tourist', 'landmark'],
      tags: ['recreation', 'outdoors', 'scenic'],
      rating: 4.8,
      priceLevel: 1,
      features: ['walking paths', 'lake', 'zoo'],
      established: 1857,
      website: 'https://www.centralparknyc.org',
    },
    {
      _id: '2',
      name: 'Empire State Building',
      type: 'building',
      location: {
        type: 'Point',
        coordinates: [-73.9857, 40.7484],
      },
      address: {
        street: '350 Fifth Avenue',
        city: 'New York',
        state: 'NY',
        zip: '10118',
        country: 'USA',
      },
      category: ['landmark', 'tourist', 'historic'],
      tags: ['architecture', 'skyscraper', 'observation deck'],
      rating: 4.7,
      priceLevel: 3,
      established: 1931,
      website: 'https://www.esbnyc.com',
    },
  ];

  beforeEach(async () => {
    client = new MongoLite(':memory:', {
      verbose: false,
    });
    await client.connect();
    collection = client.collection<GeoDoc>('testSpecializedFindCollection');

    // Insert test data
    for (const doc of geoTestDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  describe('Geospatial Query Emulation', () => {
    it('should find points within a specific longitude/latitude range', async () => {
      // Emulate $geoWithin by using coordinate ranges
      // Find locations in North America (rough approximation)
      const docs = await collection
        .find({
          $and: [
            { 'location.coordinates[0]': { $gte: -130, $lte: -60 } }, // Longitude range
            { 'location.coordinates[1]': { $gte: 20, $lte: 50 } }, // Latitude range
          ],
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(docs.every((d) => d.address?.country === 'USA'));
    });
  });

  describe('Array Operations', () => {
    it('should find documents with specific array elements', async () => {
      // Use direct index access for array elements
      const docs = await collection
        .find({
          'tags[0]': 'recreation',
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(docs.some((d) => d._id === '1')); // Central Park
    });

    it('should find documents with multiple array conditions', async () => {
      // Use multiple conditions on array indexes
      const docs = await collection
        .find({
          $and: [{ 'category[0]': 'park' }, { 'category[1]': 'tourist' }],
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(docs.some((d) => d._id === '1')); // Central Park
    });
  });

  describe('Numeric Comparisons', () => {
    it('should find places with high ratings', async () => {
      const docs = await collection
        .find({
          rating: { $gte: 4.7 },
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(docs.some((d) => d._id === '1')); // Central Park
      assert.ok(docs.some((d) => d._id === '2')); // Empire State Building
    });

    it('should find places by price level range', async () => {
      const docs = await collection
        .find({
          priceLevel: { $lte: 2 },
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(docs.some((d) => d._id === '1')); // Central Park (priceLevel: 1)
    });
  });

  describe('Multiple Field Conditions', () => {
    it('should find places by specific type and high rating', async () => {
      const docs = await collection
        .find({
          type: 'building',
          rating: { $gt: 4.5 },
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(docs.some((d) => d._id === '2')); // Empire State Building
    });
  });

  describe('Advanced SQL Operations', () => {
    it('should use SQL functions to handle complex conditions', async () => {
      // Using raw SQL for more complex conditions
      const rows = await client.db.all(`
        SELECT _id 
        FROM "testSpecializedFindCollection"
        WHERE json_extract(data, '$.rating') > 4.5 
        AND json_extract(data, '$.priceLevel') > 2
      `);

      assert.ok(rows.length > 0);
      const ids = rows.map((row) => row._id);
      assert.ok(ids.includes('2')); // Empire State Building
    });

    it('should calculate derived values with SQL expressions', async () => {
      // Calculate a value-for-money score (rating / priceLevel)
      const rows = await client.db.all(`
        SELECT _id, 
          json_extract(data, '$.name') as name,
          json_extract(data, '$.rating') / json_extract(data, '$.priceLevel') as value_score
        FROM "testSpecializedFindCollection"
        ORDER BY value_score DESC
      `);

      assert.ok(rows.length > 0);
      // Central Park should have better value (4.8/1 = 4.8) than Empire State (4.7/3 = ~1.57)
      assert.strictEqual(rows[0]._id, '1');
    });
  });

  describe('String Pattern Matching', () => {
    it('should find documents with name containing substring', async () => {
      // Using SQL LIKE for string pattern matching
      const rows = await client.db.all(
        `
        SELECT _id
        FROM "testSpecializedFindCollection"
        WHERE json_extract(data, '$.name') LIKE ?
      `,
        ['%Park%']
      );

      assert.ok(rows.length > 0);
      const ids = rows.map((row) => row._id);
      assert.ok(ids.includes('1')); // Central Park
    });
  });

  describe('Document Projection', () => {
    it('should return only requested fields', async () => {
      const docs = await collection
        .find({ type: 'park' })
        .project({ name: 1, rating: 1, 'location.coordinates': 1 })
        .toArray();

      assert.ok(docs.length > 0);
      docs.forEach((doc) => {
        assert.ok(doc.name !== undefined);
        assert.ok(doc.rating !== undefined);
        assert.ok(doc.location?.coordinates !== undefined);
        assert.strictEqual(doc.type, undefined);
        assert.strictEqual(doc.priceLevel, undefined);
      });
    });
  });

  describe('Combined Sorting and Filtering', () => {
    it('should sort filtered results by rating', async () => {
      const docs = await collection
        .find({ rating: { $gt: 4.0 } })
        .sort({ rating: -1 })
        .toArray();

      assert.ok(docs.length > 0);
      // Verify sorting is correct
      for (let i = 1; i < docs.length; i++) {
        assert.ok(docs[i - 1].rating! >= docs[i].rating!);
      }

      // Central Park should be first with rating 4.8
      assert.strictEqual(docs[0]._id, '1');
    });
  });
});
