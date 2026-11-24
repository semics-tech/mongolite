import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getPath,
  isOperatorExpression,
  evaluateExpression,
  evaluateExprFilter,
  filterUsesExpr,
} from '../src/utils/aggregation';

const ev = (expr: unknown, doc: Record<string, unknown> = {}) => evaluateExpression(doc, expr);

describe('aggregation getPath / isOperatorExpression', () => {
  it('reads dotted paths, array indexes and maps over arrays', () => {
    const doc = { a: { b: 1 }, arr: [{ x: 1 }, { y: 2 }, { x: 3 }], n: null };
    assert.strictEqual(getPath(doc, 'a.b'), 1);
    assert.strictEqual(getPath(doc, 'a.zz.q'), undefined);
    assert.strictEqual(getPath(doc, 'n.q'), undefined);
    assert.strictEqual(getPath(doc, 'a.b.c'), undefined);
    assert.strictEqual(getPath(doc, 'arr.1.y'), 2);
    assert.deepStrictEqual(getPath(doc, 'arr.x'), [1, 3]);
  });

  it('recognises single-key operator objects only', () => {
    assert.strictEqual(isOperatorExpression({ $add: [1, 2] }), true);
    assert.strictEqual(isOperatorExpression({ $add: 1, b: 2 }), false);
    assert.strictEqual(isOperatorExpression({ a: 1 }), false);
    assert.strictEqual(isOperatorExpression([1]), false);
    assert.strictEqual(isOperatorExpression(new Date()), false);
    assert.strictEqual(isOperatorExpression('$a'), false);
  });
});

describe('evaluateExpression basics', () => {
  it('resolves field paths, $$ROOT, literals, arrays and nested objects', () => {
    const doc = { a: 5, s: { t: 'x' } };
    assert.strictEqual(ev('$a', doc), 5);
    assert.strictEqual(ev('plain', doc), 'plain');
    assert.strictEqual(ev('$$ROOT', doc), doc);
    assert.strictEqual(ev('$$CURRENT', doc), doc);
    assert.deepStrictEqual(ev(['$a', 2], doc), [5, 2]);
    assert.deepStrictEqual(ev({ k: '$s.t', gone: '$missing' }, doc), { k: 'x' });
    assert.strictEqual(ev(7), 7);
    const d = new Date(0);
    assert.strictEqual(ev(d), d);
    assert.deepStrictEqual(ev({ $literal: '$a' }, doc), '$a');
  });

  it('throws on unsupported variables, operators and multi-key operator objects', () => {
    assert.throws(() => ev('$$NOW'), /Unsupported aggregation variable/);
    assert.throws(() => ev({ $nope: 1 }), /Unsupported aggregation expression operator/);
    assert.throws(() => ev({ a: 1, $add: [1] }), /exactly one field/);
  });
});

describe('evaluateExpression operators', () => {
  it('arithmetic, including null propagation and dates', () => {
    assert.strictEqual(ev({ $add: [1, 2, 3] }), 6);
    assert.strictEqual(ev({ $add: [1, null] }), null);
    const d = ev({ $add: [new Date(1000), 500] });
    assert.ok(d instanceof Date);
    assert.strictEqual((d as Date).getTime(), 1500);
    assert.strictEqual(ev({ $subtract: [5, 2] }), 3);
    assert.strictEqual(ev({ $subtract: [5, null] }), null);
    assert.strictEqual(ev({ $subtract: [new Date(2000), new Date(500)] }), 1500);
    assert.strictEqual((ev({ $subtract: [new Date(2000), 500] }) as Date).getTime(), 1500);
    assert.strictEqual(ev({ $multiply: [2, 3, 4] }), 24);
    assert.strictEqual(ev({ $multiply: [2, 'x'] }), null);
    assert.strictEqual(ev({ $divide: [9, 3] }), 3);
    assert.strictEqual(ev({ $divide: [9, 'x'] }), null);
    assert.strictEqual(ev({ $mod: [10, 4] }), 2);
    assert.strictEqual(ev({ $mod: ['a', 4] }), null);
  });

  it('string operators', () => {
    assert.strictEqual(ev({ $concat: ['a', '$b'] }, { b: 'c' }), 'ac');
    assert.strictEqual(ev({ $concat: ['a', '$missing'] }), null);
    assert.strictEqual(ev({ $toUpper: 'ab' }), 'AB');
    assert.strictEqual(ev({ $toUpper: null }), '');
    assert.strictEqual(ev({ $toLower: 'AB' }), 'ab');
    assert.strictEqual(ev({ $toLower: '$missing' }), '');
  });

  it('comparisons, including dates and objects', () => {
    assert.strictEqual(ev({ $eq: [1, 1] }), true);
    assert.strictEqual(ev({ $eq: [new Date(5), new Date(5)] }), true);
    assert.strictEqual(ev({ $eq: [{ a: 1 }, { a: 1 }] }), true);
    assert.strictEqual(ev({ $ne: [1, 2] }), true);
    assert.strictEqual(ev({ $gt: [2, 1] }), true);
    assert.strictEqual(ev({ $gt: [1, 1] }), false);
    assert.strictEqual(ev({ $gte: [1, 1] }), true);
    assert.strictEqual(ev({ $lt: [1, 2] }), true);
    assert.strictEqual(ev({ $lte: [2, 2] }), true);
    assert.strictEqual(ev({ $lt: [new Date(1), new Date(2)] }), true);
    assert.strictEqual(ev({ $gt: ['b', 'a'] }), true);
  });

  it('logic and conditionals', () => {
    assert.strictEqual(ev({ $and: [1, true] }), true);
    assert.strictEqual(ev({ $and: [1, 0] }), false);
    assert.strictEqual(ev({ $and: true }), true);
    assert.strictEqual(ev({ $or: [0, null, 'x'] }), true);
    assert.strictEqual(ev({ $or: [0, null] }), false);
    assert.strictEqual(ev({ $not: [0] }), true);
    assert.strictEqual(ev({ $not: [1] }), false);
    assert.strictEqual(ev({ $cond: [true, 'y', 'n'] }), 'y');
    assert.strictEqual(ev({ $cond: { if: 0, then: 'y', else: 'n' } }), 'n');
    assert.strictEqual(ev({ $ifNull: ['$missing', null, 'fallback'] }), 'fallback');
    assert.strictEqual(ev({ $ifNull: ['$a', 'fallback'] }, { a: 0 }), 0);
  });

  it('array operators', () => {
    const doc = { arr: [10, 20, 30] };
    assert.strictEqual(ev({ $size: '$arr' }, doc), 3);
    assert.throws(() => ev({ $size: 'nope' }), /must be an array/);
    assert.strictEqual(ev({ $arrayElemAt: ['$arr', 1] }, doc), 20);
    assert.strictEqual(ev({ $arrayElemAt: ['$arr', -1] }, doc), 30);
    assert.strictEqual(ev({ $arrayElemAt: ['nope', 0] }), null);
    assert.strictEqual(ev({ $first: '$arr' }, doc), 10);
    assert.strictEqual(ev({ $first: 'nope' }), null);
    assert.strictEqual(ev({ $last: '$arr' }, doc), 30);
    assert.strictEqual(ev({ $last: 'nope' }), null);
  });
});

describe('$expr helpers', () => {
  it('evaluateExprFilter coerces to boolean', () => {
    assert.strictEqual(evaluateExprFilter({ a: 2 }, { $gt: ['$a', 1] }), true);
    assert.strictEqual(evaluateExprFilter({ a: 0 }, '$a'), false);
  });

  it('filterUsesExpr finds $expr in logical trees only', () => {
    assert.strictEqual(filterUsesExpr({ $expr: {} }), true);
    assert.strictEqual(filterUsesExpr({ $or: [{ a: 1 }, { $and: [{ $expr: {} }] }] }), true);
    assert.strictEqual(filterUsesExpr({ $nor: [{ $expr: {} }] }), true);
    assert.strictEqual(filterUsesExpr({ a: { $expr: 1 } }), false);
    assert.strictEqual(filterUsesExpr({ a: 1 }), false);
    assert.strictEqual(filterUsesExpr(null), false);
  });
});
