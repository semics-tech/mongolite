import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  inferSchema,
  defaultColumns,
  getPath,
  valueType,
  describeField,
} from '../src/cli/schema';

describe('CLI schema inference', () => {
  const docs: Record<string, unknown>[] = [
    {
      _id: '1',
      name: 'Alice',
      age: 30,
      isActive: true,
      department: 'Engineering',
      joinDate: '2023-01-15T00:00:00.000Z',
      address: { city: 'London', country: 'UK' },
      skills: ['TypeScript', 'SQL'],
    },
    {
      _id: '2',
      name: 'Bob',
      age: 41,
      isActive: false,
      department: 'Sales',
      joinDate: '2022-06-01T00:00:00.000Z',
      address: { city: 'Bristol', country: 'UK' },
      skills: ['Python'],
      nickname: 'Bobby',
    },
  ];

  it('classifies values into display types', () => {
    assert.strictEqual(valueType('hello'), 'string');
    assert.strictEqual(valueType(42), 'number');
    assert.strictEqual(valueType(true), 'boolean');
    assert.strictEqual(valueType(null), 'null');
    assert.strictEqual(valueType([1, 2]), 'array');
    assert.strictEqual(valueType({ a: 1 }), 'object');
    assert.strictEqual(valueType(new Date()), 'date');
    assert.strictEqual(valueType('2024-01-31T12:00:00.000Z'), 'date');
    assert.strictEqual(valueType('2024-01-31'), 'date');
    assert.strictEqual(valueType('not-a-date'), 'string');
  });

  it('finds top level and nested field paths', () => {
    const schema = inferSchema(docs);
    const paths = schema.fields.map((field) => field.path);

    assert.ok(paths.includes('name'));
    assert.ok(paths.includes('address'));
    assert.ok(paths.includes('address.city'), 'nested paths are flattened with dots');
    assert.ok(paths.includes('address.country'));
    assert.strictEqual(schema.sampled, 2);
  });

  it('puts _id first so result tables lead with the identifier', () => {
    assert.strictEqual(inferSchema(docs).fields[0].path, '_id');
  });

  it('records the primary type of each field', () => {
    const schema = inferSchema(docs);
    const byPath = new Map(schema.fields.map((field) => [field.path, field]));

    assert.strictEqual(byPath.get('name')?.primaryType, 'string');
    assert.strictEqual(byPath.get('age')?.primaryType, 'number');
    assert.strictEqual(byPath.get('isActive')?.primaryType, 'boolean');
    assert.strictEqual(byPath.get('joinDate')?.primaryType, 'date');
    assert.strictEqual(byPath.get('address')?.primaryType, 'object');
    assert.strictEqual(byPath.get('skills')?.primaryType, 'array');
    assert.deepStrictEqual(byPath.get('skills')?.elementTypes, ['string']);
  });

  it('reports how often a field appears', () => {
    const schema = inferSchema(docs);
    const byPath = new Map(schema.fields.map((field) => [field.path, field]));

    assert.strictEqual(byPath.get('name')?.presence, 1);
    assert.strictEqual(byPath.get('nickname')?.presence, 0.5);
  });

  it('prefers a concrete type over null for sometimes-empty fields', () => {
    const schema = inferSchema([{ note: null }, { note: 'hi' }, { note: 'there' }]);
    const note = schema.fields.find((field) => field.path === 'note');

    assert.strictEqual(note?.primaryType, 'string');
    assert.ok(note?.types.includes('null'));
  });

  it('collects distinct values for low cardinality fields', () => {
    const schema = inferSchema(docs);
    const department = schema.fields.find((field) => field.path === 'department');

    assert.strictEqual(department?.lowCardinality, true);
    assert.deepStrictEqual(department?.distinctValues, ['Engineering', 'Sales']);
  });

  it('stops collecting distinct values once a field has too many', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ id: `value-${index}` }));
    const field = inferSchema(many).fields.find((candidate) => candidate.path === 'id');

    assert.strictEqual(field?.lowCardinality, false);
    assert.strictEqual(field?.distinctValues, undefined);
  });

  it('finds field names inside arrays of objects', () => {
    const schema = inferSchema([
      { reviews: [{ rating: 5, author: 'a' }, { rating: 3, author: 'b' }] },
    ]);
    const reviews = schema.fields.find((field) => field.path === 'reviews');

    assert.deepStrictEqual(reviews?.elementFields, ['author', 'rating']);
  });

  it('respects the maximum nesting depth', () => {
    const deep = [{ a: { b: { c: { d: { e: 1 } } } } }];
    const paths = inferSchema(deep, { maxDepth: 2 }).fields.map((field) => field.path);

    assert.ok(paths.includes('a.b'));
    assert.ok(!paths.includes('a.b.c.d'), 'should not descend past maxDepth');
  });

  it('ignores non-object entries instead of throwing', () => {
    const schema = inferSchema([null, 'nope', 42, { ok: true }] as unknown as Record<
      string,
      unknown
    >[]);
    assert.deepStrictEqual(
      schema.fields.map((field) => field.path),
      ['ok']
    );
  });

  it('returns an empty schema for no documents', () => {
    const schema = inferSchema([]);
    assert.deepStrictEqual(schema.fields, []);
    assert.strictEqual(schema.sampled, 0);
  });

  describe('defaultColumns', () => {
    it('picks shallow, common, scalar fields led by _id', () => {
      const columns = defaultColumns(inferSchema(docs));

      assert.strictEqual(columns[0], '_id');
      assert.ok(!columns.includes('address'), 'objects make poor columns');
      assert.ok(!columns.includes('address.city'), 'nested fields are not defaults');
      assert.ok(columns.length <= 6);
    });

    it('honours the column limit', () => {
      assert.strictEqual(defaultColumns(inferSchema(docs), 3).length, 3);
    });

    it('falls back to whatever exists when nothing is scalar', () => {
      const schema = inferSchema([{ _id: '1', payload: { a: 1 } }]);
      assert.deepStrictEqual(defaultColumns(schema), ['_id', 'payload']);
    });

    it('omits _id when documents do not have one', () => {
      const columns = defaultColumns(inferSchema([{ name: 'x', count: 1 }]));
      assert.ok(!columns.includes('_id'));
      assert.deepStrictEqual(columns.sort(), ['count', 'name']);
    });
  });

  describe('getPath', () => {
    it('reads nested values with dot notation', () => {
      assert.strictEqual(getPath(docs[0], 'address.city'), 'London');
    });

    it('indexes into arrays', () => {
      assert.strictEqual(getPath(docs[0], 'skills.1'), 'SQL');
    });

    it('returns undefined for missing paths rather than throwing', () => {
      assert.strictEqual(getPath(docs[0], 'address.postcode'), undefined);
      assert.strictEqual(getPath(docs[0], 'nothing.here.at.all'), undefined);
      assert.strictEqual(getPath(null, 'a'), undefined);
    });
  });

  describe('describeField', () => {
    it('summarises type and an example', () => {
      const schema = inferSchema(docs);
      const age = schema.fields.find((field) => field.path === 'age');
      const description = describeField(age!);

      assert.ok(description.includes('number'));
      assert.ok(description.includes('e.g. 30'));
    });

    it('mentions partial presence', () => {
      const schema = inferSchema(docs);
      const nickname = schema.fields.find((field) => field.path === 'nickname');

      assert.ok(describeField(nickname!).includes('50%'));
    });

    it('describes arrays by their element type', () => {
      const schema = inferSchema(docs);
      const skills = schema.fields.find((field) => field.path === 'skills');

      assert.ok(describeField(skills!).includes('array of string'));
    });
  });
});
