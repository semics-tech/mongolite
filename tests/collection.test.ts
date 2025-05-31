import { MongoLiteCollection, FindCursor } from '../src/collection';
import { SQLiteDB } from '../src/db';

// Mock the SQLiteDB class
jest.mock('../src/db', () => {
  return {
    SQLiteDB: jest.fn().mockImplementation(() => {
      return {
        connect: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        exec: jest.fn().mockResolvedValue(undefined),
        run: jest.fn().mockResolvedValue({ changes: 1, lastID: 1 }),
        get: jest.fn().mockImplementation((sql, params) => {
          if (sql.includes('SELECT _id, data FROM')) {
            return Promise.resolve({ _id: 'test-id', data: '{"name":"Test User","age":30}' });
          }
          return Promise.resolve(undefined);
        }),
        all: jest.fn().mockImplementation((sql, params) => {
          if (sql.includes('SELECT _id, data FROM')) {
            return Promise.resolve([
              { _id: 'id1', data: '{"name":"User 1","age":25}' },
              { _id: 'id2', data: '{"name":"User 2","age":35}' },
            ]);
          }
          return Promise.resolve([]);
        }),
      };
    }),
  };
});

describe('MongoLiteCollection', () => {
  let db: SQLiteDB;
  let collection: MongoLiteCollection<any>;

  beforeEach(() => {
    db = new SQLiteDB(':memory:');
    collection = new MongoLiteCollection(db, 'test_collection');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should create the collection table if it does not exist', async () => {
    await collection.ensureTable();
    expect(db.exec).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS'));
  });

  it('should insert a document with a generated _id', async () => {
    const result = await collection.insertOne({ name: 'Test', age: 30 });

    expect(result.acknowledged).toBe(true);
    expect(result.insertedId).toBeDefined();
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO'),
      expect.arrayContaining([expect.any(String), expect.any(String)])
    );
  });

  it('should insert a document with a provided _id', async () => {
    const customId = 'custom-id';
    const result = await collection.insertOne({ _id: customId, name: 'Test', age: 30 });

    expect(result.acknowledged).toBe(true);
    expect(result.insertedId).toBe(customId);
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO'),
      expect.arrayContaining([customId, expect.any(String)])
    );
  });

  it('should find a single document', async () => {
    const doc = await collection.findOne({ name: 'Test User' });

    expect(doc).toBeDefined();
    expect(doc?._id).toBe('test-id');
    expect(doc?.name).toBe('Test User');
    expect(doc?.age).toBe(30);
    expect(db.get).toHaveBeenCalled();
  });

  it('should return null if no document is found', async () => {
    // Override the mock for this test
    (db.get as jest.Mock).mockResolvedValueOnce(undefined);

    const doc = await collection.findOne({ name: 'Non-existent User' });

    expect(doc).toBeNull();
    expect(db.get).toHaveBeenCalled();
  });

  it('should create a find cursor', () => {
    const cursor = collection.find({ age: { $gt: 25 } });

    expect(cursor).toBeInstanceOf(FindCursor);
  });

  it('should update a document', async () => {
    const result = await collection.updateOne({ _id: 'test-id' }, { $set: { age: 31 } });

    expect(result.acknowledged).toBe(true);
    expect(result.matchedCount).toBe(1);
    expect(result.modifiedCount).toBe(1);
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE'),
      expect.arrayContaining([expect.any(String), 'test-id'])
    );
  });

  it('should delete a document', async () => {
    const result = await collection.deleteOne({ _id: 'test-id' });

    expect(result.acknowledged).toBe(true);
    expect(result.deletedCount).toBe(1);
    expect(db.run).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), expect.anything());
  });
});

describe('FindCursor', () => {
  let db: SQLiteDB;
  let cursor: FindCursor<any>;

  beforeEach(() => {
    db = new SQLiteDB(':memory:');
    cursor = new FindCursor(db, 'test_collection', { age: { $gt: 25 } });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch documents as an array', async () => {
    const docs = await cursor.toArray();

    expect(docs.length).toBe(2);
    expect(docs[0].name).toBe('User 1');
    expect(docs[1].name).toBe('User 2');
    expect(db.all).toHaveBeenCalledWith(
      expect.stringContaining('SELECT _id, data FROM'),
      expect.anything()
    );
  });

  it('should apply limit', async () => {
    await cursor.limit(10).toArray();

    expect(db.all).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT ?'),
      expect.arrayContaining([10])
    );
  });

  it('should apply skip', async () => {
    await cursor.skip(5).toArray();

    expect(db.all).toHaveBeenCalledWith(
      expect.stringContaining('OFFSET ?'),
      expect.arrayContaining([5])
    );
  });

  it('should apply sort', async () => {
    await cursor.sort({ age: -1 }).toArray();

    expect(db.all).toHaveBeenCalledWith(expect.stringContaining('ORDER BY'), expect.anything());
  });

  it('should chain methods', async () => {
    await cursor.sort({ age: -1 }).skip(2).limit(3).toArray();

    expect(db.all).toHaveBeenCalledWith(
      expect.stringMatching(/ORDER BY.*LIMIT.*OFFSET/s),
      expect.arrayContaining([3, 2])
    );
  });
});
