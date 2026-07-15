import type { DocumentWithId } from '../../../src/types.js';
import type { ParityScenario } from '../harness/types.js';

interface OpDoc extends DocumentWithId {
  n: number;
  tags: string[];
  s: string;
  opt?: string;
  mixed: unknown;
}

const seedDocs: OpDoc[] = [
  { _id: '1', n: 10, tags: ['a', 'b', 'c'], s: 'hello', opt: 'present', mixed: 42 },
  { _id: '2', n: 11, tags: ['a'], s: 'world', mixed: 'str' },
  { _id: '3', n: 15, tags: [], s: 'Hello', mixed: null },
];

export const queryOperatorScenarios: ParityScenario<OpDoc>[] = [
  { description: '$eq matches an exact value', seedDocs, operation: { kind: 'find', filter: { n: { $eq: 10 } } } },
  { description: '$ne excludes an exact value', seedDocs, operation: { kind: 'find', filter: { n: { $ne: 10 } } } },
  { description: '$gt matches greater values', seedDocs, operation: { kind: 'find', filter: { n: { $gt: 10 } } } },
  { description: '$gte matches greater-or-equal values', seedDocs, operation: { kind: 'find', filter: { n: { $gte: 11 } } } },
  { description: '$lt matches lesser values', seedDocs, operation: { kind: 'find', filter: { n: { $lt: 11 } } } },
  { description: '$lte matches lesser-or-equal values', seedDocs, operation: { kind: 'find', filter: { n: { $lte: 10 } } } },
  { description: '$in matches any listed value', seedDocs, operation: { kind: 'find', filter: { n: { $in: [10, 15] } } } },
  { description: '$nin excludes listed values', seedDocs, operation: { kind: 'find', filter: { n: { $nin: [10, 15] } } } },
  { description: '$all requires every listed array element present', seedDocs, operation: { kind: 'find', filter: { tags: { $all: ['a', 'b'] } } } },
  { description: '$exists: true matches documents with the field present', seedDocs, operation: { kind: 'find', filter: { opt: { $exists: true } } } },
  { description: '$exists: false matches documents missing the field', seedDocs, operation: { kind: 'find', filter: { opt: { $exists: false } } } },
  { description: '$not negates a nested operator', seedDocs, operation: { kind: 'find', filter: { n: { $not: { $gt: 10 } } } } },
  { description: '$regex with $options matches case-insensitively', seedDocs, operation: { kind: 'find', filter: { s: { $regex: 'hello', $options: 'i' } } } },
  { description: '$size matches array length', seedDocs, operation: { kind: 'find', filter: { tags: { $size: 1 } } } },
  { description: '$type matches BSON type by string alias', seedDocs, operation: { kind: 'find', filter: { mixed: { $type: 'string' } } } },
  { description: '$mod matches divisor/remainder pairs', seedDocs, operation: { kind: 'find', filter: { n: { $mod: [5, 0] } } } },
  { description: '$and combines two operator conditions', seedDocs, operation: { kind: 'find', filter: { $and: [{ n: { $gte: 10 } }, { n: { $lte: 11 } }] } } },
  { description: '$or combines two operator conditions', seedDocs, operation: { kind: 'find', filter: { $or: [{ n: 10 }, { n: 15 }] } } },
];
