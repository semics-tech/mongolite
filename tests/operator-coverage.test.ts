import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MongoLite } from '../src/index';
import { MongoLiteCollection, DocumentWithId } from '../src/index';
import { SUPPORTED_QUERY_OPERATORS } from '../src/utils/queryOperators';

/**
 * Guards against the exact class of bug this suite exists to catch: mongolite-ts evaluates
 * query operators in (at least) three independent places — find()'s SQL builder
 * (buildComparisonCondition), aggregation's first-stage $match (also pushed down to SQL), and
 * aggregation's later-stage $match (in-memory, via evaluateOperator). If one of these silently
 * stops supporting an operator (or starts supporting it differently), the other two keep
 * passing their own hand-written tests while quietly disagreeing with each other — exactly how
 * the $all/$not/$type/$mod gap in aggregation $match went unnoticed. This test runs the same
 * filter through all three code paths and asserts they agree.
 */

interface OpDoc extends DocumentWithId {
  n: number;
  tags: string[];
  s: string;
  opt?: string;
  mixed: unknown;
}

const fixture: OpDoc[] = [
  { _id: '1', n: 10, tags: ['a', 'b', 'c'], s: 'hello', opt: 'present', mixed: 42 },
  { _id: '2', n: 11, tags: ['a'], s: 'world', mixed: 'str' },
  { _id: '3', n: 15, tags: [], s: 'Hello', mixed: null },
];

interface OperatorCase {
  op: (typeof SUPPORTED_QUERY_OPERATORS)[number];
  description: string;
  filter: Record<string, unknown>;
  expectedIds: string[];
}

const cases: OperatorCase[] = [
  { op: '$eq', description: '$eq matches an exact value', filter: { n: { $eq: 10 } }, expectedIds: ['1'] },
  { op: '$ne', description: '$ne excludes an exact value', filter: { n: { $ne: 10 } }, expectedIds: ['2', '3'] },
  { op: '$gt', description: '$gt matches greater values', filter: { n: { $gt: 10 } }, expectedIds: ['2', '3'] },
  { op: '$gte', description: '$gte matches greater-or-equal values', filter: { n: { $gte: 11 } }, expectedIds: ['2', '3'] },
  { op: '$lt', description: '$lt matches lesser values', filter: { n: { $lt: 11 } }, expectedIds: ['1'] },
  { op: '$lte', description: '$lte matches lesser-or-equal values', filter: { n: { $lte: 10 } }, expectedIds: ['1'] },
  { op: '$in', description: '$in matches any listed value', filter: { n: { $in: [10, 15] } }, expectedIds: ['1', '3'] },
  { op: '$nin', description: '$nin excludes listed values', filter: { n: { $nin: [10, 15] } }, expectedIds: ['2'] },
  { op: '$all', description: '$all requires every listed element present', filter: { tags: { $all: ['a', 'b'] } }, expectedIds: ['1'] },
  { op: '$exists', description: '$exists matches documents with the field present', filter: { opt: { $exists: true } }, expectedIds: ['1'] },
  { op: '$not', description: '$not negates a nested operator', filter: { n: { $not: { $gt: 10 } } }, expectedIds: ['1'] },
  { op: '$regex', description: '$regex matches with case-insensitive flag', filter: { s: { $regex: 'hello', $options: 'i' } }, expectedIds: ['1', '3'] },
  { op: '$size', description: '$size matches array length', filter: { tags: { $size: 1 } }, expectedIds: ['2'] },
  { op: '$type', description: '$type matches BSON type', filter: { mixed: { $type: 'string' } }, expectedIds: ['2'] },
  { op: '$mod', description: '$mod matches divisor/remainder pairs', filter: { n: { $mod: [5, 0] } }, expectedIds: ['1', '3'] },
];

function sortedIds(docs: { _id?: string }[]): string[] {
  return docs.map((d) => d._id as string).sort();
}

describe('Operator coverage — find() vs aggregation $match must agree', () => {
  let client: MongoLite;
  let collection: MongoLiteCollection<OpDoc>;

  beforeEach(async () => {
    client = new MongoLite(':memory:');
    await client.connect();
    collection = client.collection<OpDoc>('opCoverage');
    await collection.insertMany(fixture);
  });

  afterEach(async () => {
    await client.close();
  });

  it('the registry covers every operator exercised below', () => {
    const coveredOps = new Set(cases.map((c) => c.op));
    for (const op of SUPPORTED_QUERY_OPERATORS) {
      assert.ok(coveredOps.has(op), `No coverage case for operator ${op}`);
    }
  });

  for (const { description, filter, expectedIds } of cases) {
    describe(description, () => {
      it('find() matches the expected documents', async () => {
        const result = await collection.find(filter).toArray();
        assert.deepStrictEqual(sortedIds(result), expectedIds);
      });

      it('aggregation $match as the first stage (SQL path) matches the expected documents', async () => {
        const result = await collection.aggregate([{ $match: filter }]).toArray();
        assert.deepStrictEqual(sortedIds(result), expectedIds);
      });

      it('aggregation $match after another stage (in-memory path) matches the expected documents', async () => {
        const result = await collection.aggregate([{ $addFields: {} }, { $match: filter }]).toArray();
        assert.deepStrictEqual(sortedIds(result), expectedIds);
      });
    });
  }
});
