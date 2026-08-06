import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MongoLite } from '../src/index';
import type { DocumentWithId, Filter } from '../src/types';
import {
  findDatabaseFiles,
  formatBytes,
  formatRelativeTime,
  listCollectionInfo,
  resolveDatabasePath,
  databaseExists,
} from '../src/cli/discover';
import { inferSchema, defaultColumns } from '../src/cli/schema';
import { combineConditions, type Condition } from '../src/cli/filter-builder';
import { renderTable, formatCell, renderSchema } from '../src/cli/format';

interface Employee extends DocumentWithId {
  name: string;
  age: number;
  department: string;
  isActive: boolean;
  salary: number;
  skills: string[];
  address: { city: string; country: string };
  joinDate: string;
}

const employees: Omit<Employee, '_id'>[] = [
  {
    name: 'Alice',
    age: 30,
    department: 'Engineering',
    isActive: true,
    salary: 90000,
    skills: ['TypeScript', 'SQL'],
    address: { city: 'London', country: 'UK' },
    joinDate: '2021-03-01T00:00:00.000Z',
  },
  {
    name: 'Bob',
    age: 45,
    department: 'Sales',
    isActive: false,
    salary: 60000,
    skills: ['Negotiation'],
    address: { city: 'Bristol', country: 'UK' },
    joinDate: '2019-07-15T00:00:00.000Z',
  },
  {
    name: 'Carla',
    age: 27,
    department: 'Engineering',
    isActive: true,
    salary: 75000,
    skills: ['Python', 'SQL'],
    address: { city: 'London', country: 'UK' },
    joinDate: '2023-01-20T00:00:00.000Z',
  },
];

describe('CLI end to end against a real database', () => {
  let dir: string;
  let dbPath: string;
  let client: MongoLite;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'mongolite-cli-'));
    dbPath = path.join(dir, 'people.db');
    client = new MongoLite(dbPath);
    await client.connect();

    const collection = client.collection<Employee>('employees');
    for (const employee of employees) await collection.insertOne(employee);

    // A second collection, so collection listing has something to choose between.
    await client.collection('orders').insertOne({ total: 10 });
  });

  after(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('discovery', () => {
    it('finds database files on disk', () => {
      const found = findDatabaseFiles(dir);
      assert.ok(
        found.some((candidate) => candidate.path === dbPath),
        'the database we just wrote should be listed'
      );
      const entry = found.find((candidate) => candidate.path === dbPath)!;
      assert.ok(entry.sizeBytes > 0);
      assert.strictEqual(entry.relativePath, 'people.db');
    });

    it('ignores WAL and SHM sidecar files', () => {
      // Sidecars for a database nothing has open - writing junk next to the
      // live one would corrupt it.
      writeFileSync(path.join(dir, 'archive.db'), '');
      writeFileSync(path.join(dir, 'archive.db-wal'), '');
      writeFileSync(path.join(dir, 'archive.db-shm'), '');

      const names = findDatabaseFiles(dir).map((candidate) => candidate.relativePath);
      assert.ok(names.includes('archive.db'));
      assert.ok(!names.some((name) => name.endsWith('-wal')));
      assert.ok(!names.some((name) => name.endsWith('-shm')));
    });

    it('skips node_modules and other noise directories', () => {
      const noisy = path.join(dir, 'node_modules', 'pkg');
      mkdirSync(noisy, { recursive: true });
      writeFileSync(path.join(noisy, 'bundled.sqlite'), 'x');

      const names = findDatabaseFiles(dir).map((candidate) => candidate.relativePath);
      assert.ok(!names.some((name) => name.includes('node_modules')));
    });

    it('lists collections with their document counts', async () => {
      const collections = await listCollectionInfo(client.database);
      const employeesInfo = collections.find((info) => info.name === 'employees');

      assert.strictEqual(employeesInfo?.count, 3);
      assert.strictEqual(employeesInfo?.isMongoLite, true);
      assert.ok(collections.some((info) => info.name === 'orders'));
    });

    it('flags tables that are not MongoLite collections', async () => {
      await client.database.exec('CREATE TABLE IF NOT EXISTS legacy (id INTEGER, label TEXT)');
      const collections = await listCollectionInfo(client.database);
      const legacy = collections.find((info) => info.name === 'legacy');

      assert.strictEqual(legacy?.isMongoLite, false);
    });

    it('resolves paths, including ~ and :memory:', () => {
      assert.strictEqual(resolveDatabasePath(':memory:'), ':memory:');
      assert.strictEqual(resolveDatabasePath(dbPath), dbPath);
      assert.ok(path.isAbsolute(resolveDatabasePath('relative.db')));
    });

    it('reports whether a database exists', () => {
      assert.strictEqual(databaseExists(dbPath), true);
      assert.strictEqual(databaseExists(path.join(dir, 'nope.db')), false);
      assert.strictEqual(databaseExists(':memory:'), true);
    });

    it('formats sizes and times for the picker', () => {
      assert.strictEqual(formatBytes(512), '512 B');
      assert.strictEqual(formatBytes(2048), '2.0 KB');
      assert.strictEqual(formatBytes(5 * 1024 * 1024), '5.0 MB');

      const now = new Date('2024-05-01T12:00:00.000Z');
      assert.strictEqual(formatRelativeTime(new Date('2024-05-01T11:59:30.000Z'), now), 'just now');
      assert.strictEqual(formatRelativeTime(new Date('2024-05-01T11:30:00.000Z'), now), '30m ago');
      assert.strictEqual(formatRelativeTime(new Date('2024-04-30T14:00:00.000Z'), now), '22h ago');
      assert.strictEqual(formatRelativeTime(new Date('2024-04-30T12:00:00.000Z'), now), '1d ago');
      assert.strictEqual(
        formatRelativeTime(new Date('2023-01-05T12:00:00.000Z'), now),
        '2023-01-05'
      );
    });
  });

  describe('inferring a collection without being told its shape', () => {
    it('derives the fields from the stored documents', async () => {
      const sample = await client.collection<Employee>('employees').find({}).limit(50).toArray();
      const schema = inferSchema(sample as unknown as Record<string, unknown>[]);
      const paths = schema.fields.map((field) => field.path);

      assert.ok(paths.includes('name'));
      assert.ok(paths.includes('address.city'));
      assert.strictEqual(
        schema.fields.find((field) => field.path === 'department')?.lowCardinality,
        true
      );
      assert.deepStrictEqual(
        schema.fields.find((field) => field.path === 'department')?.distinctValues,
        ['Engineering', 'Sales']
      );
    });

    it('suggests usable default columns', async () => {
      const sample = await client.collection<Employee>('employees').find({}).limit(50).toArray();
      const columns = defaultColumns(inferSchema(sample as unknown as Record<string, unknown>[]));

      assert.strictEqual(columns[0], '_id');
      assert.ok(columns.includes('name'));
    });
  });

  describe('guided conditions run correctly as queries', () => {
    const run = async (conditions: Condition[], mode: 'all' | 'any' = 'all') => {
      const filter = combineConditions(conditions, mode) as Filter<Employee>;
      const docs = await client.collection<Employee>('employees').find(filter).toArray();
      return docs.map((doc) => doc.name).sort();
    };

    it('matches on equality', async () => {
      const names = await run([
        { field: 'department', operator: 'eq', values: ['Sales'], fieldType: 'string' },
      ]);
      assert.deepStrictEqual(names, ['Bob']);
    });

    it('matches numeric ranges', async () => {
      assert.deepStrictEqual(
        await run([{ field: 'age', operator: 'gte', values: [30], fieldType: 'number' }]),
        ['Alice', 'Bob']
      );
      assert.deepStrictEqual(
        await run([{ field: 'age', operator: 'between', values: [28, 40], fieldType: 'number' }]),
        ['Alice']
      );
    });

    it('matches "contains the text" case-insensitively', async () => {
      assert.deepStrictEqual(
        await run([{ field: 'name', operator: 'contains', values: ['ar'], fieldType: 'string' }]),
        ['Carla']
      );
      assert.deepStrictEqual(
        await run([{ field: 'name', operator: 'contains', values: ['ALI'], fieldType: 'string' }]),
        ['Alice']
      );
    });

    it('matches "starts with" and "ends with"', async () => {
      assert.deepStrictEqual(
        await run([{ field: 'name', operator: 'startsWith', values: ['A'], fieldType: 'string' }]),
        ['Alice']
      );
      assert.deepStrictEqual(
        await run([{ field: 'name', operator: 'endsWith', values: ['b'], fieldType: 'string' }]),
        ['Bob']
      );
    });

    it('matches booleans', async () => {
      assert.deepStrictEqual(
        await run([{ field: 'isActive', operator: 'isFalse', values: [], fieldType: 'boolean' }]),
        ['Bob']
      );
    });

    it('matches values inside arrays', async () => {
      assert.deepStrictEqual(
        await run([
          { field: 'skills', operator: 'arrayContains', values: ['SQL'], fieldType: 'string' },
        ]),
        ['Alice', 'Carla']
      );
      assert.deepStrictEqual(
        await run([
          {
            field: 'skills',
            operator: 'arrayContainsAll',
            values: ['Python', 'SQL'],
            fieldType: 'string',
          },
        ]),
        ['Carla']
      );
    });

    it('matches nested fields chosen from the inferred list', async () => {
      assert.deepStrictEqual(
        await run([
          { field: 'address.city', operator: 'eq', values: ['London'], fieldType: 'string' },
        ]),
        ['Alice', 'Carla']
      );
    });

    it('matches dates entered as plain days', async () => {
      assert.deepStrictEqual(
        await run([
          {
            field: 'joinDate',
            operator: 'gte',
            values: ['2021-01-01T00:00:00.000Z'],
            fieldType: 'date',
          },
        ]),
        ['Alice', 'Carla']
      );
    });

    it('combines several conditions with AND', async () => {
      assert.deepStrictEqual(
        await run([
          { field: 'department', operator: 'eq', values: ['Engineering'], fieldType: 'string' },
          { field: 'age', operator: 'lt', values: [29], fieldType: 'number' },
        ]),
        ['Carla']
      );
    });

    it('combines several conditions with OR', async () => {
      assert.deepStrictEqual(
        await run(
          [
            { field: 'department', operator: 'eq', values: ['Sales'], fieldType: 'string' },
            { field: 'age', operator: 'lt', values: [28], fieldType: 'number' },
          ],
          'any'
        ),
        ['Bob', 'Carla']
      );
    });

    it('finds documents where a field is missing', async () => {
      await client.collection('employees').insertOne({
        name: 'Dan',
        age: 50,
        department: 'Ops',
        isActive: true,
        salary: 1,
        skills: [],
        address: { city: 'Leeds', country: 'UK' },
        joinDate: '2020-01-01T00:00:00.000Z',
        // no `nickname` on any other document either
      } as unknown as Omit<Employee, '_id'>);

      const withNickname = await run([
        { field: 'nickname', operator: 'exists', values: [], fieldType: 'string' },
      ]);
      assert.deepStrictEqual(withNickname, []);

      const withoutNickname = await run([
        { field: 'nickname', operator: 'notExists', values: [], fieldType: 'string' },
      ]);
      assert.strictEqual(withoutNickname.length, 4);

      await client.collection('employees').deleteMany({ name: 'Dan' } as Filter<DocumentWithId>);
    });
  });

  describe('SQL preview', () => {
    it('exposes the SQL a query will run, including sort and limit', () => {
      const cursor = client
        .collection<Employee>('employees')
        .find({ age: { $gt: 30 } })
        .sort({ name: 1 })
        .limit(10);

      const { sql, params } = cursor.toSQL();

      assert.ok(sql.includes('FROM "employees"'));
      assert.ok(sql.includes('ORDER BY'));
      assert.ok(sql.includes('LIMIT'));
      assert.ok(params.includes(30));
    });

    it('returns the same results the previewed SQL describes', async () => {
      const cursor = client.collection<Employee>('employees').find({ department: 'Sales' });
      const { sql, params } = cursor.toSQL();
      const rows = await client.database.all<{ _id: string }>(sql, params);
      const docs = await cursor.toArray();

      assert.strictEqual(rows.length, docs.length);
    });
  });
});

describe('CLI rendering', () => {
  const docs = [
    { _id: '1', name: 'Alice', age: 30, tags: ['a', 'b'], meta: { x: 1 } },
    { _id: '2', name: 'Bob', age: 45, tags: [], meta: null },
  ];

  it('formats values as single-line cells', () => {
    assert.strictEqual(formatCell('text'), 'text');
    assert.strictEqual(formatCell(42), '42');
    assert.strictEqual(formatCell(null), 'null');
    assert.strictEqual(formatCell(undefined), '');
    assert.strictEqual(formatCell([]), '[]');
    assert.strictEqual(formatCell(['a', 'b']), '[a, b]');
    assert.strictEqual(formatCell([{ a: 1 }]), '[{…}]');
    assert.strictEqual(formatCell({ a: 1 }), '{"a":1}');
    assert.strictEqual(formatCell(new Date('2024-01-01T00:00:00.000Z')), '2024-01-01T00:00:00.000Z');
  });

  it('renders a table with the requested columns', () => {
    const table = renderTable(docs, { columns: ['_id', 'name', 'age'] });
    const lines = table.split('\n');

    assert.ok(lines[0].includes('name'));
    assert.ok(lines[0].includes('age'));
    assert.ok(table.includes('Alice'));
    assert.ok(table.includes('Bob'));
    assert.strictEqual(lines.length, 4, 'header, rule and one line per document');
  });

  it('numbers rows from the page offset', () => {
    const table = renderTable(docs, { columns: ['name'], startIndex: 20 });
    assert.ok(table.includes('21'));
    assert.ok(table.includes('22'));
  });

  it('leaves blanks for fields a document does not have', () => {
    const table = renderTable([{ _id: '1' }], { columns: ['_id', 'missing'] });
    assert.ok(table.includes('missing'), 'the column header still shows');
  });

  it('renders the inferred schema as a field list', () => {
    const rendered = renderSchema(inferSchema(docs));
    assert.ok(rendered.includes('name'));
    assert.ok(rendered.includes('present'));
  });

  it('says something useful when there are no columns', () => {
    assert.match(renderTable(docs, { columns: [] }), /No columns/);
  });
});
