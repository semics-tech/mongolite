import type { DocumentWithId } from '../../../src/types.js';
import type { ParityScenario } from '../harness/types.js';

interface AggDoc extends DocumentWithId {
  name: string;
  cat: string;
  price: number;
  qty: number;
  tags?: string[];
  meta?: { a: number };
}

const seedDocs: AggDoc[] = [
  { _id: '1', name: 'a', cat: 'x', price: 10, qty: 2, tags: ['t1', 't2'], meta: { a: 1 } },
  { _id: '2', name: 'b', cat: 'x', price: 5, qty: 10, tags: [], meta: { a: 2 } },
  { _id: '3', name: 'c', cat: 'y', price: 7, qty: 1, meta: { a: 3 } },
  { _id: '4', name: 'd', cat: 'y', price: 3, qty: 3, tags: ['t1'], meta: { a: 4 } },
];

export const aggregateScenarios: ParityScenario<AggDoc>[] = [
  {
    description: '$addFields evaluates expression objects',
    seedDocs,
    operation: {
      kind: 'aggregate',
      pipeline: [
        { $addFields: { total: { $multiply: ['$price', '$qty'] }, alias: '$name' } },
        { $sort: { _id: 1 } },
      ],
    },
  },
  {
    description: '$project keeps computed fields',
    seedDocs,
    operation: {
      kind: 'aggregate',
      pipeline: [
        { $project: { name: 1, total: { $multiply: ['$price', '$qty'] } } },
        { $sort: { _id: 1 } },
      ],
    },
  },
  {
    description: '$match with $expr',
    seedDocs,
    operation: {
      kind: 'aggregate',
      pipeline: [{ $match: { $expr: { $gt: ['$price', '$qty'] } } }, { $sort: { _id: 1 } }],
    },
  },
  {
    description: 'scalar $elemMatch in $match',
    seedDocs,
    operation: {
      kind: 'aggregate',
      pipeline: [{ $match: { tags: { $elemMatch: { $eq: 't1' } } } }, { $sort: { _id: 1 } }],
    },
  },
  {
    description: '$unwind with preserveNullAndEmptyArrays',
    seedDocs,
    operation: {
      kind: 'aggregate',
      pipeline: [
        { $unwind: { path: '$tags', preserveNullAndEmptyArrays: true } },
        { $sort: { _id: 1, tags: 1 } },
      ],
    },
  },
  {
    description: '$group $addToSet (sorted via $unwind for determinism)',
    seedDocs,
    operation: {
      kind: 'aggregate',
      pipeline: [
        { $group: { _id: '$cat', names: { $addToSet: '$name' } } },
        { $unwind: '$names' },
        { $sort: { _id: 1, names: 1 } },
      ],
    },
  },
  {
    description: '$group $sum of an expression',
    seedDocs,
    operation: {
      kind: 'aggregate',
      pipeline: [
        { $group: { _id: '$cat', revenue: { $sum: { $multiply: ['$price', '$qty'] } } } },
        { $sort: { _id: 1 } },
      ],
    },
  },
  {
    description: '$replaceRoot promotes a nested document',
    seedDocs,
    operation: {
      kind: 'aggregate',
      pipeline: [{ $replaceRoot: { newRoot: '$meta' } }, { $sort: { a: 1 } }],
    },
  },
];
