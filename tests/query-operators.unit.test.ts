import { describe, it } from 'node:test';
import assert from 'node:assert';
import { evaluateOperator, evaluateOperators } from '../src/utils/queryOperators';

describe('evaluateOperators (pure in-memory matcher)', () => {
  it('$in / $nin handle scalars and array fields', () => {
    assert.strictEqual(evaluateOperators(2, { $in: [1, 2] }), true);
    assert.strictEqual(evaluateOperators([5, 6], { $in: [6] }), true);
    assert.strictEqual(evaluateOperators(3, { $in: [1, 2] }), false);
    assert.strictEqual(evaluateOperators(3, { $in: 'x' }), false);
    assert.strictEqual(evaluateOperators(3, { $nin: [1, 2] }), true);
    assert.strictEqual(evaluateOperators([1, 9], { $nin: [9] }), false);
    assert.strictEqual(evaluateOperators(2, { $nin: [2] }), false);
    assert.strictEqual(evaluateOperators(2, { $nin: 'x' }), false);
  });

  it('$all requires an array field containing every value', () => {
    assert.strictEqual(evaluateOperators(['a', 'b', 'c'], { $all: ['a', 'c'] }), true);
    assert.strictEqual(evaluateOperators(['a'], { $all: ['a', 'c'] }), false);
    assert.strictEqual(evaluateOperators('a', { $all: ['a'] }), false);
  });

  it('$exists, $not and $size', () => {
    assert.strictEqual(evaluateOperators(undefined, { $exists: false }), true);
    assert.strictEqual(evaluateOperators(1, { $exists: false }), false);
    assert.strictEqual(evaluateOperators(1, { $exists: true }), true);
    assert.strictEqual(evaluateOperators(5, { $not: { $gt: 10 } }), true);
    assert.strictEqual(evaluateOperators(50, { $not: { $gt: 10 } }), false);
    assert.strictEqual(evaluateOperators([1, 2], { $size: 2 }), true);
    assert.strictEqual(evaluateOperators([1, 2], { $size: 3 }), false);
    assert.strictEqual(evaluateOperators('ab', { $size: 2 }), false);
  });

  it('$regex accepts strings with $options and RegExp objects', () => {
    assert.strictEqual(evaluateOperators('Hello', { $regex: '^hello$', $options: 'i' }), true);
    assert.strictEqual(evaluateOperators('Hello', { $regex: '^hello$' }), false);
    assert.strictEqual(evaluateOperators('abc', { $regex: /b/ }), true);
  });

  it('$type accepts a name, a list of names, and numeric codes', () => {
    assert.strictEqual(evaluateOperators('x', { $type: 'string' }), true);
    assert.strictEqual(evaluateOperators(1, { $type: ['string', 'number'] }), true);
    assert.strictEqual(evaluateOperators(null, { $type: 'null' }), true);
    assert.strictEqual(evaluateOperators([1], { $type: 'array' }), true);
    assert.strictEqual(evaluateOperators(1, { $type: 'string' }), false);
  });

  it('$mod requires a [divisor, remainder] pair and a numeric field', () => {
    assert.strictEqual(evaluateOperators(10, { $mod: [4, 2] }), true);
    assert.strictEqual(evaluateOperators(10, { $mod: [4, 1] }), false);
    assert.strictEqual(evaluateOperators(10, { $mod: [4] }), false);
    assert.strictEqual(evaluateOperators('10', { $mod: [4, 2] }), false);
  });

  it('$elemMatch supports operator form, object form and logical operators', () => {
    assert.strictEqual(evaluateOperators([1, 5, 9], { $elemMatch: { $gt: 8 } }), true);
    assert.strictEqual(evaluateOperators([1, 5], { $elemMatch: { $gt: 8 } }), false);
    const docs = [{ a: 1, b: { c: 2 } }, { a: 3 }];
    assert.strictEqual(evaluateOperators(docs, { $elemMatch: { a: 1, 'b.c': 2 } }), true);
    assert.strictEqual(evaluateOperators(docs, { $elemMatch: { a: { $gt: 2 } } }), true);
    assert.strictEqual(evaluateOperators(docs, { $elemMatch: { a: 9 } }), false);
    assert.strictEqual(
      evaluateOperators(docs, { $elemMatch: { $or: [{ a: 9 }, { a: 3 }] } }),
      true
    );
    assert.strictEqual(
      evaluateOperators(docs, { $elemMatch: { $and: [{ a: 1 }, { a: 3 }] } }),
      false
    );
    assert.strictEqual(evaluateOperators(docs, { $elemMatch: { $nor: [{ a: 1 }] } }), true);
    assert.strictEqual(evaluateOperators('x', { $elemMatch: { a: 1 } }), false);
    assert.strictEqual(evaluateOperators([1], { $elemMatch: null }), false);
  });

  it('unsupported operators never match; $options alone is a no-op', () => {
    assert.strictEqual(evaluateOperator('$bogus', 1, 1), false);
    assert.strictEqual(evaluateOperator('$options', 1, 'i'), true);
    assert.strictEqual(evaluateOperators(1, { $bogus: 1 }), false);
  });
});
