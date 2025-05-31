import { MongoLite } from '../src';
import { DocumentWithId } from '../src/types';

interface TestUser extends DocumentWithId {
  name: string;
  age: number;
  email: string;
  tags?: string[];
}

describe('MongoLite', () => {
  let client: MongoLite;

  beforeAll(async () => {
    // Use in-memory database for testing
    client = new MongoLite(':memory:');
    await client.connect();
  });

  afterAll(async () => {
    await client.close();
  });

  describe('Basic CRUD operations', () => {
    const usersCollection = () => client.collection<TestUser>('users');

    beforeEach(async () => {
      // Clean up the collection before each test
      await usersCollection().deleteMany({});
    });

    it('should insert a document and generate an _id if not provided', async () => {
      const result = await usersCollection().insertOne({
        name: 'John Doe',
        age: 30,
        email: 'john@example.com',
      });

      expect(result.acknowledged).toBe(true);
      expect(result.insertedId).toBeDefined();
      expect(typeof result.insertedId).toBe('string');

      // Verify the document was inserted
      const insertedUser = await usersCollection().findOne({ _id: result.insertedId });
      expect(insertedUser).toBeDefined();
      expect(insertedUser?.name).toBe('John Doe');
      expect(insertedUser?.age).toBe(30);
      expect(insertedUser?.email).toBe('john@example.com');
    });

    it('should insert a document with a provided _id', async () => {
      const customId = 'custom-id-123';
      const result = await usersCollection().insertOne({
        _id: customId,
        name: 'Jane Doe',
        age: 25,
        email: 'jane@example.com',
      });

      expect(result.acknowledged).toBe(true);
      expect(result.insertedId).toBe(customId);

      // Verify the document was inserted with the custom ID
      const insertedUser = await usersCollection().findOne({ _id: customId });
      expect(insertedUser).toBeDefined();
      expect(insertedUser?._id).toBe(customId);
    });

    it('should find a document by a specific field', async () => {
      // Insert a test document
      await usersCollection().insertOne({
        name: 'Alice',
        age: 28,
        email: 'alice@example.com',
      });

      const user = await usersCollection().findOne({ email: 'alice@example.com' });
      expect(user).toBeDefined();
      expect(user?.name).toBe('Alice');
    });

    it('should update a document', async () => {
      // Insert a test document
      const result = await usersCollection().insertOne({
        name: 'Bob',
        age: 35,
        email: 'bob@example.com',
        tags: ['developer', 'javascript'],
      });

      // Update the document
      const updateResult = await usersCollection().updateOne(
        { _id: result.insertedId },
        {
          $set: { age: 36, email: 'bob.updated@example.com' },
          $push: { tags: 'typescript' },
        }
      );

      expect(updateResult.acknowledged).toBe(true);
      expect(updateResult.matchedCount).toBe(1);
      expect(updateResult.modifiedCount).toBe(1);

      // Verify the update
      const updatedUser = await usersCollection().findOne({ _id: result.insertedId });
      expect(updatedUser?.age).toBe(36);
      expect(updatedUser?.email).toBe('bob.updated@example.com');
      expect(updatedUser?.tags).toContain('typescript');
      expect(updatedUser?.tags?.length).toBe(3);
    });

    it('should delete a document', async () => {
      // Insert a test document
      const result = await usersCollection().insertOne({
        name: 'Charlie',
        age: 40,
        email: 'charlie@example.com',
      });

      // Delete the document
      const deleteResult = await usersCollection().deleteOne({ _id: result.insertedId });

      expect(deleteResult.acknowledged).toBe(true);
      expect(deleteResult.deletedCount).toBe(1);

      // Verify the document was deleted
      const deletedUser = await usersCollection().findOne({ _id: result.insertedId });
      expect(deletedUser).toBeNull();
    });

    it('should use find with query operators', async () => {
      // Insert test documents
      await Promise.all([
        usersCollection().insertOne({ name: 'User1', age: 20, email: 'user1@example.com' }),
        usersCollection().insertOne({ name: 'User2', age: 25, email: 'user2@example.com' }),
        usersCollection().insertOne({ name: 'User3', age: 30, email: 'user3@example.com' }),
        usersCollection().insertOne({ name: 'User4', age: 35, email: 'user4@example.com' }),
        usersCollection().insertOne({ name: 'User5', age: 40, email: 'user5@example.com' }),
      ]);

      // Test $gt operator
      const olderThan30 = await usersCollection()
        .find({ age: { $gt: 30 } })
        .toArray();
      expect(olderThan30.length).toBe(2);

      // Test $lte operator
      const youngerOrEqual30 = await usersCollection()
        .find({ age: { $lte: 30 } })
        .toArray();
      expect(youngerOrEqual30.length).toBe(3);

      // Test $in operator
      const specificAges = await usersCollection()
        .find({ age: { $in: [25, 35] } })
        .toArray();
      expect(specificAges.length).toBe(2);

      // Test combined operators
      const complexQuery = await usersCollection()
        .find({
          age: { $gte: 25, $lt: 40 },
        })
        .toArray();
      expect(complexQuery.length).toBe(3);
    });

    it('should use cursor methods like limit, skip, and sort', async () => {
      // Insert test documents
      await Promise.all([
        usersCollection().insertOne({ name: 'User1', age: 20, email: 'user1@example.com' }),
        usersCollection().insertOne({ name: 'User2', age: 25, email: 'user2@example.com' }),
        usersCollection().insertOne({ name: 'User3', age: 30, email: 'user3@example.com' }),
        usersCollection().insertOne({ name: 'User4', age: 35, email: 'user4@example.com' }),
        usersCollection().insertOne({ name: 'User5', age: 40, email: 'user5@example.com' }),
      ]);

      // Test limit
      const limitedResults = await usersCollection().find({}).limit(2).toArray();
      expect(limitedResults.length).toBe(2);

      // Test skip
      const skippedResults = await usersCollection().find({}).skip(2).toArray();
      expect(skippedResults.length).toBe(3);

      // Test sort (ascending)
      const ascendingResults = await usersCollection().find({}).sort({ age: 1 }).toArray();
      expect(ascendingResults[0].age).toBe(20);
      expect(ascendingResults[4].age).toBe(40);

      // Test sort (descending)
      const descendingResults = await usersCollection().find({}).sort({ age: -1 }).toArray();
      expect(descendingResults[0].age).toBe(40);
      expect(descendingResults[4].age).toBe(20);

      // Test combination
      const combinedQuery = await usersCollection()
        .find({})
        .sort({ age: -1 })
        .skip(1)
        .limit(2)
        .toArray();

      expect(combinedQuery.length).toBe(2);
      expect(combinedQuery[0].age).toBe(35);
      expect(combinedQuery[1].age).toBe(30);
    });
  });
});
