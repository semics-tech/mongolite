import type { DocumentWithId } from '../../../src/types.js';
import type { ParityScenario } from '../harness/types.js';

interface FindDoc extends DocumentWithId {
  name: string;
  age: number;
  active: boolean;
  address: { city: string };
  tags: string[];
}

const seedDocs: FindDoc[] = [
  { _id: '1', name: 'Ada', age: 30, active: true, address: { city: 'London' }, tags: ['a', 'b'] },
  { _id: '2', name: 'Grace', age: 40, active: false, address: { city: 'New York' }, tags: ['b'] },
  { _id: '3', name: 'Alan', age: 50, active: true, address: { city: 'London' }, tags: [] },
];

export const findScenarios: ParityScenario<FindDoc>[] = [
  {
    description: 'find({}) returns every seeded document',
    seedDocs,
    operation: { kind: 'find', filter: {} },
  },
  {
    description: 'find with a simple equality filter',
    seedDocs,
    operation: { kind: 'find', filter: { active: true } },
  },
  {
    description: 'find with a nested dot-notation filter',
    seedDocs,
    operation: { kind: 'find', filter: { 'address.city': 'London' } },
  },
  {
    description: 'find with an implicit array-contains equality filter',
    seedDocs,
    operation: { kind: 'find', filter: { tags: 'b' } },
  },
  {
    description: 'find with $and combining two conditions',
    seedDocs,
    operation: { kind: 'find', filter: { $and: [{ active: true }, { age: { $gte: 40 } }] } },
  },
  {
    description: 'find with $or combining two conditions',
    seedDocs,
    operation: { kind: 'find', filter: { $or: [{ name: 'Ada' }, { name: 'Grace' }] } },
  },
  {
    description: 'find with $nor excluding matching conditions',
    seedDocs,
    operation: { kind: 'find', filter: { $nor: [{ name: 'Ada' }, { name: 'Grace' }] } },
  },
  {
    description: 'find with limit',
    seedDocs,
    operation: { kind: 'find', filter: {}, sort: { _id: 1 }, limit: 2 },
  },
  {
    description: 'find with skip',
    seedDocs,
    operation: { kind: 'find', filter: {}, sort: { _id: 1 }, skip: 1 },
  },
  {
    description: 'find with skip and limit combined',
    seedDocs,
    operation: { kind: 'find', filter: {}, sort: { _id: 1 }, skip: 1, limit: 1 },
  },
  {
    description: 'findOne returns a single matching document',
    seedDocs,
    operation: { kind: 'findOne', filter: { name: 'Grace' } },
  },
  {
    description: 'findOne returns null when nothing matches',
    seedDocs,
    operation: { kind: 'findOne', filter: { name: 'Nobody' } },
  },
  {
    description: 'find matches nothing when the filter excludes every document',
    seedDocs,
    operation: { kind: 'find', filter: { age: { $gt: 1000 } } },
  },
];
