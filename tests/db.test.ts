import { SQLiteDB } from '../src/db';
import * as path from 'path';
import * as fs from 'fs';

describe('SQLiteDB', () => {
  const tempDbPath = path.join(__dirname, 'temp-test.db');

  // Clean up any test database files before and after tests
  beforeEach(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  afterEach(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  it('should connect to an in-memory database', async () => {
    const db = new SQLiteDB(':memory:');
    await expect(db.connect()).resolves.not.toThrow();
    await expect(db.close()).resolves.not.toThrow();
  });

  it('should connect to a file database', async () => {
    const db = new SQLiteDB(tempDbPath);
    await expect(db.connect()).resolves.not.toThrow();

    // Verify the file was created
    expect(fs.existsSync(tempDbPath)).toBe(true);

    await expect(db.close()).resolves.not.toThrow();
  });

  it('should handle verbose mode', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    const db = new SQLiteDB({
      filePath: ':memory:',
      verbose: true,
    });

    await db.connect();

    // Check if we get verbose logging
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SQLite database opened'));

    await db.close();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SQLite database closed'));

    consoleSpy.mockRestore();
  });

  it('should execute SQL queries', async () => {
    const db = new SQLiteDB(':memory:');
    await db.connect();

    // Create a test table
    await db.exec('CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT)');

    // Insert data
    const insertResult = await db.run('INSERT INTO test_table (name) VALUES (?)', ['Test Name']);
    expect(insertResult.lastID).toBeDefined();

    // Query single row
    const row = await db.get<{ id: number; name: string }>(
      'SELECT * FROM test_table WHERE id = ?',
      [insertResult.lastID]
    );
    expect(row).toBeDefined();
    expect(row?.name).toBe('Test Name');

    // Query multiple rows
    await db.run('INSERT INTO test_table (name) VALUES (?)', ['Another Test']);
    const rows = await db.all<{ id: number; name: string }>('SELECT * FROM test_table');
    expect(rows.length).toBe(2);

    await db.close();
  });

  it('should handle errors gracefully', async () => {
    const db = new SQLiteDB(':memory:');
    await db.connect();

    // Invalid SQL should throw an error
    await expect(db.exec('INVALID SQL STATEMENT')).rejects.toThrow();

    // Close should still work after an error
    await expect(db.close()).resolves.not.toThrow();
  });

  it('should handle connection state correctly', async () => {
    const db = new SQLiteDB(':memory:');

    // Connect multiple times should be fine
    await db.connect();
    await db.connect(); // This should not throw

    // Run operations
    await db.exec('CREATE TABLE test (id INTEGER)');

    // Close
    await db.close();

    // Operations after close should reconnect automatically
    await db.run('CREATE TABLE IF NOT EXISTS another_test (id INTEGER)');

    // Final close
    await db.close();
  });
});
