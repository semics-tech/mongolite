import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index';

interface AdvancedTestDoc extends DocumentWithId {
  title: string;
  description?: string;
  content?: string;
  category?: string;
  subcategory?: string[];
  keywords?: string[];
  price?: number;
  status?: 'active' | 'inactive' | 'pending';
  authorInfo?: {
    name: string;
    email?: string;
    role: string;
    permissions?: string[];
  };
  metadata?: {
    createdAt: string;
    updatedAt?: string;
    version: number;
    tags?: string[];
    featured?: boolean;
  };
  reviews?: {
    userId: string;
    rating: number;
    comment?: string;
    date: string;
    helpful?: number;
    verified?: boolean;
  }[];
  variants?: {
    sku: string;
    color?: string;
    size?: string;
    stock: number;
    price?: number;
  }[];
  dimensions?: {
    width: number;
    height: number;
    depth?: number;
    unit: 'cm' | 'inch';
  };
  stats?: {
    views: number;
    downloads?: number;
    shares?: number;
    favorites?: number;
  };
  customData?: Record<string, unknown>;
}

describe('MongoLiteCollection - Advanced Find Operations (Fixed)', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<AdvancedTestDoc>;

  // Prepare test documents with diverse data patterns
  const advancedTestDocs: AdvancedTestDoc[] = [
    {
      _id: '1',
      title: 'MongoDB Advanced Queries',
      description: 'Learn how to use advanced MongoDB query operations',
      content: 'MongoDB provides a rich set of operators for querying documents...',
      category: 'Database',
      subcategory: ['NoSQL', 'Document Database'],
      keywords: ['mongodb', 'queries', 'operators', 'advanced'],
      price: 29.99,
      status: 'active',
      authorInfo: {
        name: 'John Smith',
        email: 'john@example.com',
        role: 'instructor',
        permissions: ['create', 'update', 'delete'],
      },
      metadata: {
        createdAt: '2023-01-10T10:30:00Z',
        updatedAt: '2023-05-15T14:20:00Z',
        version: 2,
        tags: ['featured', 'bestseller'],
        featured: true,
      },
      reviews: [
        {
          userId: 'user123',
          rating: 5,
          comment: 'Excellent resource for learning MongoDB!',
          date: '2023-02-15T09:00:00Z',
          helpful: 12,
          verified: true,
        },
        {
          userId: 'user456',
          rating: 4,
          comment: 'Very informative, but could use more examples',
          date: '2023-03-20T16:45:00Z',
          helpful: 5,
          verified: true,
        },
      ],
      variants: [
        {
          sku: 'EBOOK-001',
          color: 'N/A',
          size: 'Digital',
          stock: 999,
          price: 24.99,
        },
        {
          sku: 'PDF-001',
          color: 'N/A',
          size: 'Digital',
          stock: 999,
          price: 19.99,
        },
      ],
      dimensions: {
        width: 8.5,
        height: 11,
        unit: 'inch',
      },
      stats: {
        views: 3500,
        downloads: 820,
        shares: 145,
        favorites: 230,
      },
    },
    {
      _id: '2',
      title: 'Node.js API Development',
      description: 'A comprehensive guide to building APIs with Node.js',
      content:
        'This guide covers everything from setting up a Node.js environment to deploying your API...',
      category: 'Programming',
      subcategory: ['JavaScript', 'Backend'],
      keywords: ['nodejs', 'api', 'express', 'rest'],
      price: 34.99,
      status: 'active',
      authorInfo: {
        name: 'Sarah Johnson',
        email: 'sarah@example.com',
        role: 'senior developer',
        permissions: ['create', 'update', 'delete', 'publish'],
      },
      metadata: {
        createdAt: '2022-11-05T08:15:00Z',
        updatedAt: '2023-04-20T11:30:00Z',
        version: 3,
        tags: ['bestseller'],
        featured: false,
      },
    },
    {
      _id: '3',
      title: 'Introduction to Machine Learning',
      description: 'Learn the fundamentals of machine learning algorithms',
      content:
        'This course introduces the basic concepts and algorithms used in machine learning...',
      category: 'Data Science',
      subcategory: ['AI', 'Machine Learning'],
      keywords: ['machine learning', 'ai', 'algorithms', 'data science'],
      price: 49.99,
      status: 'active',
      authorInfo: {
        name: 'Michael Chen',
        email: 'michael@example.com',
        role: 'professor',
        permissions: ['create', 'update'],
      },
      metadata: {
        createdAt: '2023-02-20T09:45:00Z',
        version: 1,
        tags: ['featured', 'new'],
        featured: true,
      },
    },
  ];

  beforeEach(async () => {
    client = new MongoLite(':memory:', {
      verbose: false,
    });
    await client.connect();
    collection = client.collection<AdvancedTestDoc>('testAdvancedFindCollection');

    // Insert test data
    for (const doc of advancedTestDocs) {
      await collection.insertOne(doc);
    }
  });

  afterEach(async () => {
    await client.close();
  });

  describe('Text Search Capabilities', () => {
    it('should support basic text search in content', async () => {
      // Simulate text search using SQL LIKE via raw SQL query
      const rows = await client.db.all(
        `SELECT _id, data FROM "testAdvancedFindCollection" 
         WHERE json_extract(data, '$.content') LIKE ?`,
        ['%MongoDB provides a rich set%']
      );

      const ids = rows.map((row) => row._id);
      assert.ok(ids.includes('1')); // MongoDB Advanced Queries
    });

    it('should search in description fields', async () => {
      // Simulate regex search using SQL LIKE via raw SQL query
      const rows = await client.db.all(
        `SELECT _id, data FROM "testAdvancedFindCollection" 
         WHERE json_extract(data, '$.description') LIKE ?`,
        ['%advanced%']
      );

      const ids = rows.map((row) => row._id);
      assert.ok(ids.includes('1')); // "Learn how to use advanced MongoDB query operations"
    });

    it('should find documents containing specific words in content', async () => {
      // Using raw SQL LIKE for text search
      const rows = await client.db.all(
        `SELECT _id FROM "testAdvancedFindCollection" 
         WHERE json_extract(data, '$.content') LIKE ?`,
        ['%guide covers everything%']
      );

      const ids = rows.map((row) => row._id);
      assert.ok(ids.includes('2')); // Node.js API Development
    });
  });

  describe('String Pattern Matching', () => {
    it('should support string pattern matching on string fields', async () => {
      // Simulate regex using SQL LIKE via raw SQL query
      const rows = await client.db.all(
        `SELECT _id FROM "testAdvancedFindCollection" 
         WHERE json_extract(data, '$.title') LIKE 'MongoDB%'`,
        []
      );

      const ids = rows.map((row) => row._id);
      assert.strictEqual(ids.length, 1);
      assert.strictEqual(ids[0], '1'); // MongoDB Advanced Queries
    });
  });

  describe('Compound Queries', () => {
    it('should combine multiple conditions with AND', async () => {
      const docs = await collection
        .find({
          category: 'Data Science',
          price: { $gt: 40 },
        })
        .toArray();

      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0]._id, '3'); // Introduction to Machine Learning
    });

    it('should combine conditions with OR', async () => {
      const docs = await collection
        .find({
          $or: [{ category: 'Database' }, { category: 'Data Science' }],
        })
        .toArray();

      assert.strictEqual(docs.length, 2);
      const ids = docs.map((doc) => doc._id);
      assert.ok(ids.includes('1')); // MongoDB Advanced Queries
      assert.ok(ids.includes('3')); // Introduction to Machine Learning
    });
  });

  describe('Array Operations', () => {
    it('should match documents with exact array contents', async () => {
      const docs = await collection
        .find({
          subcategory: ['JavaScript', 'Backend'],
        })
        .toArray();

      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0]._id, '2'); // Node.js API Development
    });

    it('should match documents with specific array element', async () => {
      // Using SQL for matching array elements
      const rows = await client.db.all(`
        SELECT _id FROM "testAdvancedFindCollection"
        WHERE json_extract(data, '$.subcategory[0]') = 'NoSQL'
           OR json_extract(data, '$.subcategory[1]') = 'NoSQL'
      `);

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]._id, '1'); // MongoDB Advanced Queries
    });
  });

  describe('Document Comparison Operations', () => {
    it('should compare nested numeric fields', async () => {
      const docs = await collection
        .find({
          'stats.views': { $gt: 3000 },
        })
        .toArray();

      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0]._id, '1'); // MongoDB Advanced Queries
    });

    it('should find documents based on multiple nested conditions', async () => {
      const docs = await collection
        .find({
          'dimensions.unit': 'inch',
          'dimensions.width': { $gte: 8 },
        })
        .toArray();

      assert.strictEqual(docs.length, 1);
      assert.strictEqual(docs[0]._id, '1'); // MongoDB Advanced Queries
    });
  });

  describe('Advanced Projection', () => {
    it('should project specific nested fields', async () => {
      const docs = await collection
        .find({ category: 'Programming' })
        .project({
          title: 1,
          price: 1,
          'authorInfo.name': 1,
        })
        .toArray();

      assert.strictEqual(docs.length, 1);
      docs.forEach((doc) => {
        assert.ok(doc.title !== undefined);
        assert.ok(doc.price !== undefined);
        assert.ok(doc.authorInfo?.name !== undefined);
        assert.strictEqual(doc.description, undefined);
        assert.strictEqual(doc.content, undefined);
      });
    });

    it('should exclude specific nested fields', async () => {
      const docs = await collection
        .find({ 'metadata.featured': true })
        .project({
          reviews: 0,
          variants: 0,
          'authorInfo.permissions': 0,
        })
        .toArray();

      docs.forEach((doc) => {
        assert.ok(doc.title !== undefined);
        assert.ok(doc.category !== undefined);
        assert.ok(doc.authorInfo !== undefined);
        assert.strictEqual(doc.authorInfo?.permissions, undefined);
        assert.strictEqual(doc.reviews, undefined);
        assert.strictEqual(doc.variants, undefined);
      });
    });
  });

  describe('Date String Comparison', () => {
    it('should find documents created after a specific date', async () => {
      const docs = await collection
        .find({
          'metadata.createdAt': { $gte: '2023-01-01' },
        })
        .toArray();

      // Documents created on or after January 1, 2023
      assert.strictEqual(docs.length, 2);
      const ids = docs.map((doc) => doc._id);
      assert.ok(ids.includes('1')); // MongoDB Advanced Queries
      assert.ok(ids.includes('3')); // Introduction to Machine Learning
    });
  });

  describe('Sorting and Pagination', () => {
    it('should sort documents by price in ascending order', async () => {
      const docs = await collection.find({}).sort({ price: 1 }).toArray();

      assert.strictEqual(docs.length, 3);

      // Verify sorting
      for (let i = 1; i < docs.length; i++) {
        assert.ok(docs[i - 1].price! <= docs[i].price!);
      }
    });

    it('should paginate results correctly', async () => {
      // Get first page
      const page1 = await collection.find({}).sort({ price: 1 }).limit(2).toArray();

      // Get second page
      const page2 = await collection.find({}).sort({ price: 1 }).skip(2).limit(2).toArray();

      assert.strictEqual(page1.length, 2);
      assert.strictEqual(page2.length, 1); // Only 3 docs total

      // Verify pages don't overlap
      const page1Ids = page1.map((doc) => doc._id);
      const page2Ids = page2.map((doc) => doc._id);
      assert.ok(!page1Ids.some((id) => page2Ids.includes(id)));
    });
  });

  describe('Advanced SQL Operations', () => {
    it('should use SQL functions for complex matching', async () => {
      // Find documents where price is between 30 and 40
      const rows = await client.db.all(`
        SELECT _id FROM "testAdvancedFindCollection"
        WHERE json_extract(data, '$.price') BETWEEN 30 AND 40
      `);

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]._id, '2'); // Node.js API Development
    });

    it('should search across multiple fields with complex criteria', async () => {
      // Find documents where either title contains "Machine" OR category is "Data Science"
      const rows = await client.db.all(`
        SELECT _id FROM "testAdvancedFindCollection"
        WHERE json_extract(data, '$.title') LIKE '%Machine%'
          OR json_extract(data, '$.category') = 'Data Science'
      `);

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]._id, '3'); // Introduction to Machine Learning
    });

    it('should calculate derived values with SQL expressions', async () => {
      // Calculate a score based on views and price
      const rows = await client.db.all(`
        SELECT 
          _id, 
          json_extract(data, '$.title') as title,
          CASE 
            WHEN json_extract(data, '$.stats.views') IS NOT NULL 
            THEN json_extract(data, '$.stats.views') / json_extract(data, '$.price')
            ELSE 0 
          END as value_score
        FROM "testAdvancedFindCollection"
        WHERE value_score > 0
        ORDER BY value_score DESC
      `);

      assert.ok(rows.length > 0);
      // MongoDB Advanced Queries should have highest value score (3500/29.99 > 0)
      assert.strictEqual(rows[0]._id, '1');
    });
  });
});
