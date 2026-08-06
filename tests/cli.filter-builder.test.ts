import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  combineConditions,
  compileCondition,
  describeCondition,
  escapeRegex,
  operatorsFor,
  parseValue,
  parseValueList,
  type Condition,
} from '../src/cli/filter-builder';

const condition = (partial: Partial<Condition> & Pick<Condition, 'field' | 'operator'>): Condition => ({
  values: [],
  fieldType: 'string',
  ...partial,
});

describe('CLI filter builder', () => {
  describe('operatorsFor', () => {
    it('offers text conditions for string fields', () => {
      const ids = operatorsFor({ primaryType: 'string', types: ['string'] }).map((op) => op.id);
      assert.ok(ids.includes('contains'));
      assert.ok(ids.includes('startsWith'));
      assert.ok(!ids.includes('gte'), 'ordering operators are not offered for text');
    });

    it('offers comparisons for number fields', () => {
      const ids = operatorsFor({ primaryType: 'number', types: ['number'] }).map((op) => op.id);
      assert.ok(ids.includes('gte'));
      assert.ok(ids.includes('between'));
    });

    it('offers containment for array fields', () => {
      const ids = operatorsFor({ primaryType: 'array', types: ['array'] }).map((op) => op.id);
      assert.ok(ids.includes('arrayContains'));
      assert.ok(ids.includes('arrayContainsAll'));
      assert.ok(ids.includes('size'));
    });

    it('always offers existence checks', () => {
      for (const type of ['string', 'number', 'boolean', 'date', 'array', 'object'] as const) {
        const ids = operatorsFor({ primaryType: type, types: [type] }).map((op) => op.id);
        assert.ok(ids.includes('exists'), `${type} should offer "has a value"`);
        assert.ok(ids.includes('notExists'), `${type} should offer "is missing"`);
      }
    });

    it('adds text conditions to mixed-type fields without duplicating ids', () => {
      const operators = operatorsFor({ primaryType: 'number', types: ['number', 'string'] });
      const ids = operators.map((op) => op.id);

      assert.ok(ids.includes('contains'), 'mixed fields can still be searched as text');
      assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate operator ids');
    });
  });

  describe('parseValue', () => {
    it('parses numbers', () => {
      assert.strictEqual(parseValue('42', 'number'), 42);
      assert.strictEqual(parseValue(' -3.5 ', 'number'), -3.5);
    });

    it('rejects text that is not a number', () => {
      assert.throws(() => parseValue('twelve', 'number'), /not a number/);
      assert.throws(() => parseValue('', 'number'), /not a number/);
    });

    it('accepts everyday spellings of true and false', () => {
      for (const input of ['true', 'TRUE', 'yes', 'y', '1']) {
        assert.strictEqual(parseValue(input, 'boolean'), true, input);
      }
      for (const input of ['false', 'No', 'n', '0']) {
        assert.strictEqual(parseValue(input, 'boolean'), false, input);
      }
      assert.throws(() => parseValue('maybe', 'boolean'), /not true or false/);
    });

    it('normalises dates to ISO strings, as stored in documents', () => {
      assert.strictEqual(parseValue('2024-01-31', 'date'), '2024-01-31T00:00:00.000Z');
      assert.strictEqual(
        parseValue('2024-01-31T12:30:00.000Z', 'date'),
        '2024-01-31T12:30:00.000Z'
      );
      assert.throws(() => parseValue('sometime', 'date'), /not a date/);
    });

    it('leaves strings alone apart from trimming', () => {
      assert.strictEqual(parseValue('  hello  ', 'string'), 'hello');
      assert.strictEqual(parseValue('42', 'string'), '42');
    });

    it('parses JSON for object fields but tolerates plain text', () => {
      assert.deepStrictEqual(parseValue('{"a":1}', 'object'), { a: 1 });
      assert.strictEqual(parseValue('plain', 'array'), 'plain');
    });
  });

  describe('parseValueList', () => {
    it('splits and parses comma separated values', () => {
      assert.deepStrictEqual(parseValueList('1, 2,3', 'number'), [1, 2, 3]);
      assert.deepStrictEqual(parseValueList('a, b', 'string'), ['a', 'b']);
    });

    it('ignores empty entries and rejects an empty list', () => {
      assert.deepStrictEqual(parseValueList('a,,b,', 'string'), ['a', 'b']);
      assert.throws(() => parseValueList('  ', 'string'), /at least one value/);
    });
  });

  describe('compileCondition', () => {
    it('compiles comparisons', () => {
      assert.deepStrictEqual(
        compileCondition(condition({ field: 'age', operator: 'gte', values: [30], fieldType: 'number' })),
        { age: { $gte: 30 } }
      );
      assert.deepStrictEqual(
        compileCondition(
          condition({ field: 'age', operator: 'between', values: [20, 30], fieldType: 'number' })
        ),
        { age: { $gte: 20, $lte: 30 } }
      );
    });

    it('compiles text matching to anchored, escaped regexes', () => {
      assert.deepStrictEqual(
        compileCondition(condition({ field: 'name', operator: 'contains', values: ['a.b'] })),
        { name: { $regex: 'a\\.b', $options: 'i' } }
      );
      assert.deepStrictEqual(
        compileCondition(condition({ field: 'name', operator: 'startsWith', values: ['Al'] })),
        { name: { $regex: '^Al', $options: 'i' } }
      );
      assert.deepStrictEqual(
        compileCondition(condition({ field: 'name', operator: 'endsWith', values: ['son'] })),
        { name: { $regex: 'son$', $options: 'i' } }
      );
    });

    it('passes a raw pattern straight through for the advanced regex option', () => {
      assert.deepStrictEqual(
        compileCondition(condition({ field: 'name', operator: 'regex', values: ['^A.*e$'] })),
        { name: { $regex: '^A.*e$' } }
      );
    });

    it('compiles booleans and existence', () => {
      assert.deepStrictEqual(
        compileCondition(condition({ field: 'isActive', operator: 'isTrue', fieldType: 'boolean' })),
        { isActive: { $eq: true } }
      );
      assert.deepStrictEqual(compileCondition(condition({ field: 'x', operator: 'notExists' })), {
        x: { $exists: false },
      });
    });

    it('compiles array containment through $in and $all', () => {
      assert.deepStrictEqual(
        compileCondition(condition({ field: 'tags', operator: 'arrayContains', values: ['a'] })),
        { tags: { $in: ['a'] } }
      );
      assert.deepStrictEqual(
        compileCondition(
          condition({ field: 'tags', operator: 'arrayContainsAll', values: ['a', 'b'] })
        ),
        { tags: { $all: ['a', 'b'] } }
      );
    });

    it('rejects an unknown operator rather than building a silent no-op', () => {
      assert.throws(
        () => compileCondition(condition({ field: 'x', operator: 'wat' })),
        /Unknown condition/
      );
    });
  });

  describe('combineConditions', () => {
    it('returns an empty filter for no conditions', () => {
      assert.deepStrictEqual(combineConditions([]), {});
    });

    it('merges distinct fields into a flat filter', () => {
      const filter = combineConditions([
        condition({ field: 'department', operator: 'eq', values: ['Sales'] }),
        condition({ field: 'age', operator: 'gt', values: [30], fieldType: 'number' }),
      ]);

      assert.deepStrictEqual(filter, { department: { $eq: 'Sales' }, age: { $gt: 30 } });
    });

    it('uses $and when the same field is constrained twice', () => {
      const filter = combineConditions([
        condition({ field: 'age', operator: 'gt', values: [20], fieldType: 'number' }),
        condition({ field: 'age', operator: 'lt', values: [40], fieldType: 'number' }),
      ]);

      assert.deepStrictEqual(filter, { $and: [{ age: { $gt: 20 } }, { age: { $lt: 40 } }] });
    });

    it('uses $or for "any of these"', () => {
      const filter = combineConditions(
        [
          condition({ field: 'department', operator: 'eq', values: ['Sales'] }),
          condition({ field: 'department', operator: 'eq', values: ['Marketing'] }),
        ],
        'any'
      );

      assert.deepStrictEqual(filter, {
        $or: [{ department: { $eq: 'Sales' } }, { department: { $eq: 'Marketing' } }],
      });
    });
  });

  describe('describeCondition', () => {
    it('reads back the plain-English phrasing', () => {
      assert.strictEqual(
        describeCondition(
          condition({ field: 'age', operator: 'gte', values: [30], fieldType: 'number' })
        ),
        'age is at least 30'
      );
      assert.strictEqual(
        describeCondition(
          condition({ field: 'age', operator: 'between', values: [20, 30], fieldType: 'number' })
        ),
        'age is between 20 and 30'
      );
      assert.strictEqual(
        describeCondition(condition({ field: 'email', operator: 'exists' })),
        'email has a value'
      );
    });

    it('labels array conditions even though values are element-typed', () => {
      assert.strictEqual(
        describeCondition(
          condition({ field: 'skills', operator: 'arrayContains', values: ['SQL'] })
        ),
        'skills contains "SQL"'
      );
    });
  });

  describe('escapeRegex', () => {
    it('escapes characters that would otherwise be pattern syntax', () => {
      assert.strictEqual(escapeRegex('a.b*c'), 'a\\.b\\*c');
      assert.strictEqual(escapeRegex('plain'), 'plain');
    });
  });
});
