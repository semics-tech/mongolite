import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index';

interface ComplexTestDoc extends DocumentWithId {
  name: string;
  age: number | null;
  email?: string;
  active: boolean;
  score?: number;
  tags?: string[];
  location?: {
    city: string;
    country: string;
    coordinates?: {
      lat: number;
      lng: number;
    };
    visited?: boolean;
  };
  dates?: {
    created: string;
    updated?: string;
  };
  friends?: {
    name: string;
    age: number;
    mutual?: boolean;
  }[];
  hobbies?: string[];
  skills?: {
    name: string;
    level: number;
    certified?: boolean;
  }[];
  stats?: {
    views: number;
    likes: number;
    shares?: number;
  };
  settings?: {
    notifications: {
      email: boolean;
      sms?: boolean;
      frequency?: 'daily' | 'weekly' | 'monthly';
    };
    privacy?: {
      public: boolean;
      showEmail?: boolean;
    };
  };
  lastLogin?: Date | null;
  metadata?: Record<string, unknown>;
}

describe('MongoLiteCollection - Complex Find Operations (Fixed)', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<ComplexTestDoc>;

  // Create a diverse set of test documents that covers various data types and structures
  const complexTestDocs: ComplexTestDoc[] = [
    {
      _id: '1',
      name: 'Alice Johnson',
      age: 32,
      email: 'alice@example.com',
      active: true,
      score: 85,
      tags: ['developer', 'javascript', 'mongodb'],
      location: {
        city: 'New York',
        country: 'USA',
        coordinates: {
          lat: 40.7128,
          lng: -74.006,
        },
        visited: true,
      },
      dates: {
        created: '2023-01-15',
        updated: '2023-05-20',
      },
      friends: [{ name: 'Bob Smith', age: 34, mutual: true }],
      hobbies: ['reading', 'hiking', 'photography'],
      skills: [
        { name: 'JavaScript', level: 5, certified: true },
        { name: 'Python', level: 4, certified: false },
        { name: 'MongoDB', level: 4, certified: true },
      ],
      stats: {
        views: 1250,
        likes: 78,
        shares: 25,
      },
      settings: {
        notifications: {
          email: true,
          sms: false,
          frequency: 'weekly',
        },
        privacy: {
          public: true,
          showEmail: false,
        },
      },
      lastLogin: new Date('2023-06-10'),
      metadata: {
        lastModifiedBy: 'system',
        version: 3,
      },
    },
    {
      _id: '2',
      name: 'Bob Smith',
      age: 34,
      email: 'bob@example.com',
      active: true,
      tags: ['manager', 'leadership'],
      location: {
        city: 'San Francisco',
        country: 'USA',
      },
      friends: [{ name: 'Alice Johnson', age: 32, mutual: true }],
      settings: {
        notifications: {
          email: true,
          frequency: 'daily',
        },
      },
      lastLogin: new Date('2023-06-15'),
    },
    {
      _id: '3',
      name: 'Carol Davis',
      age: 29,
      email: 'carol@example.com',
      active: false,
      tags: ['designer', 'ui/ux'],
      location: {
        city: 'London',
        country: 'UK',
      },
      skills: [{ name: 'UI Design', level: 5, certified: true }],
      stats: {
        views: 1875,
        likes: 124,
      },
      settings: {
        notifications: {
          email: false,
          frequency: 'monthly',
        },
      },
    },
  ];

  beforeEach(async () => {
    client = new MongoLite(':memory:', { verbose: false });
    await client.connect();
    collection = client.collection<ComplexTestDoc>('complexTestCollection');

    // Insert test data
    for (const doc of complexTestDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  describe('Basic Query Tests', () => {
    it('should find documents by exact match on array element', async () => {
      // We can't use direct string match on array, need to use array indexes
      const docs = await collection.find({ 'tags[0]': 'developer' }).toArray();
      assert.ok(docs.length > 0);
      assert.ok(docs.every((d) => d.tags && d.tags[0] === 'developer'));
    });

    it('should find documents with array elements using array indexes', async () => {
      // Use array index access for tags
      const results = await collection
        .find({
          $or: [{ 'tags[0]': 'mongodb' }, { 'tags[1]': 'mongodb' }, { 'tags[2]': 'mongodb' }],
        })
        .toArray();

      assert.ok(results.length > 0);
      // Verify results contain documents with 'mongodb' in their tags
      assert.ok(results.every((d) => d.tags && d.tags.includes('mongodb')));
    });

    it('should query fields with dot notation', async () => {
      const docs = await collection.find({ 'location.city': 'New York' }).toArray();
      assert.ok(docs.length > 0);
      assert.ok(docs.every((d) => d.location && d.location.city === 'New York'));
    });

    it('should query nested array objects', async () => {
      // For object matching in arrays, use direct index and property access
      const docs = await collection
        .find({
          'friends[0].name': 'Bob Smith',
          'friends[0].mutual': true,
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(
        docs.every(
          (d) =>
            d.friends &&
            d.friends[0] &&
            d.friends[0].name === 'Bob Smith' &&
            d.friends[0].mutual === true
        )
      );
    });

    it('should find documents with matching array elements', async () => {
      // Instead of using $elemMatch, match specific indexes and properties
      const docs = await collection
        .find({
          'skills[0].name': 'JavaScript',
          'skills[0].level': 5,
          'skills[0].certified': true,
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(
        docs.every(
          (d) =>
            d.skills &&
            d.skills[0] &&
            d.skills[0].name === 'JavaScript' &&
            d.skills[0].level === 5 &&
            d.skills[0].certified === true
        )
      );
    });

    it('should query for high skill levels', async () => {
      const docs = await collection
        .find({
          'skills[0].level': { $gte: 5 },
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(docs.every((d) => d.skills && d.skills[0] && d.skills[0].level >= 5));
    });

    it('should query deeply nested document fields', async () => {
      const docs = await collection
        .find({
          'settings.notifications.frequency': 'daily',
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(
        docs.every(
          (d) =>
            d.settings && d.settings.notifications && d.settings.notifications.frequency === 'daily'
        )
      );
    });
  });

  describe('Complex Query Combinations', () => {
    it('should combine multiple conditions with $and', async () => {
      const docs = await collection
        .find({
          $and: [{ active: true }, { age: { $gt: 30 } }, { 'stats.views': { $gt: 1000 } }],
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(
        docs.every(
          (d) =>
            d.active === true &&
            d.age !== null &&
            d.age !== undefined &&
            d.age > 30 &&
            d.stats &&
            d.stats.views > 1000
        )
      );
    });

    it('should query with $or conditions', async () => {
      const docs = await collection
        .find({
          $or: [
            { 'location.country': 'UK' },
            { 'location.country': 'Germany' },
            { 'location.country': 'Japan' },
          ],
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(
        docs.every((d) => d.location && ['UK', 'Germany', 'Japan'].includes(d.location.country))
      );
    });

    it('should work with date string comparisons', async () => {
      const docs = await collection
        .find({
          'dates.created': { $gte: '2023-01-01' },
        })
        .toArray();

      assert.ok(docs.length > 0);
      assert.ok(docs.every((d) => d.dates && d.dates.created >= '2023-01-01'));
    });

    it('should support projection to limit returned fields', async () => {
      const docs = await collection
        .find({ active: true })
        .project({ name: 1, age: 1, 'stats.views': 1 })
        .toArray();

      docs.forEach((doc) => {
        assert.ok(doc.name !== undefined);
        assert.ok(doc.age !== undefined);
        assert.ok(doc._id !== undefined); // _id is included by default
        // Other fields should be excluded or null
        if (doc.stats) {
          assert.ok(doc.stats.views !== undefined);
        }
        assert.strictEqual(doc.email, undefined);
        assert.strictEqual(doc.score, undefined);
      });
    });

    it('should support excluding fields in projection', async () => {
      const docs = await collection
        .find({ active: true })
        .project({ email: 0, 'location.coordinates': 0, 'stats.shares': 0 })
        .toArray();

      docs.forEach((doc) => {
        assert.strictEqual(doc.email, undefined);
        if (doc.location) {
          assert.strictEqual(doc.location.coordinates, undefined);
        }
        if (doc.stats) {
          assert.strictEqual(doc.stats.shares, undefined);
        }
        // Other fields should be included
        assert.ok(doc.name !== undefined);
        assert.ok(doc.age !== undefined);
      });
    });
  });

  describe('Sort, Skip, and Limit Tests', () => {
    it('should sort documents by age in ascending order', async () => {
      const docs = await collection.find({ active: true }).sort({ age: 1 }).toArray();

      const ages = docs.map((d) => d.age);
      // Check that ages are in ascending order, ignoring nulls
      for (let i = 1; i < ages.length; i++) {
        if (
          ages[i - 1] !== null &&
          ages[i] !== null &&
          ages[i - 1] !== undefined &&
          ages[i] !== undefined
        ) {
          assert.ok(ages[i - 1] <= ages[i]);
        }
      }
    });

    it('should paginate results with skip and limit', async () => {
      // Get two pages of 2 items each
      const page1 = await collection.find({}).sort({ age: 1 }).limit(2).toArray();
      const page2 = await collection.find({}).sort({ age: 1 }).skip(2).limit(2).toArray();

      assert.strictEqual(page1.length, 2);
      assert.strictEqual(page2.length, 1); // We only have 3 docs total

      // Verify the pages don't overlap
      const page1Ids = page1.map((d) => d._id);
      const page2Ids = page2.map((d) => d._id);
      assert.ok(!page1Ids.some((id) => page2Ids.includes(id)));
    });
  });

  describe('Raw SQL Queries for Complex Operations', () => {
    it('should support full-text search using SQLite LIKE', async () => {
      // Use SQLite LIKE operator for text search
      const rows = await client.db.all(
        `
        SELECT _id 
        FROM "complexTestCollection" 
        WHERE json_extract(data, '$.name') LIKE ?`,
        ['%Alice%']
      );

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]._id, '1');
    });

    it('should search across multiple fields using SQLite', async () => {
      // Search across name and email fields
      const rows = await client.db.all(
        `
        SELECT _id 
        FROM "complexTestCollection" 
        WHERE json_extract(data, '$.name') LIKE ? 
           OR json_extract(data, '$.email') LIKE ?`,
        ['%Bob%', '%bob%']
      );

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]._id, '2');
    });

    it('should filter based on array length using SQLite', async () => {
      // Find documents where skills array has at least 2 elements
      const rows = await client.db.all(`
        SELECT _id 
        FROM "complexTestCollection" 
        WHERE json_array_length(json_extract(data, '$.skills')) >= 2`);

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]._id, '1');
    });

    it('should calculate aggregated values using SQLite', async () => {
      // Calculate average age of active users
      const result = await client.db.get(`
        SELECT AVG(json_extract(data, '$.age')) as avg_age
        FROM "complexTestCollection"
        WHERE json_extract(data, '$.active') = 1`);

      assert.ok(result);
      assert.strictEqual(result.avg_age, 33); // (32 + 34) / 2 = 33
    });
  });
});
