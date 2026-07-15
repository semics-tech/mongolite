import type { DocumentWithId } from '../../../src/types.js';
import type { ParityScenario } from '../harness/types.js';

interface ProjectionDoc extends DocumentWithId {
  name: string;
  age: number;
  email: string;
  address: { city: string; country: string };
  tags: string[];
}

const seedDocs: ProjectionDoc[] = [
  {
    _id: '1',
    name: 'Ada Lovelace',
    age: 30,
    email: 'ada@example.com',
    address: { city: 'London', country: 'UK' },
    tags: ['math', 'computing'],
  },
  {
    _id: '2',
    name: 'Grace Hopper',
    age: 40,
    email: 'grace@example.com',
    address: { city: 'New York', country: 'US' },
    tags: ['compilers'],
  },
];

export const projectionScenarios: ParityScenario<ProjectionDoc>[] = [
  {
    // The exact bug this whole harness exists to catch: an empty projection object must mean
    // "no restriction," not "only _id."
    description: 'empty {} projection returns the full document, not just _id',
    seedDocs,
    operation: { kind: 'find', filter: { _id: '1' }, projection: {} },
  },
  {
    description: 'findOne with empty {} projection returns the full document',
    seedDocs,
    operation: { kind: 'findOne', filter: { _id: '1' }, projection: {} },
  },
  {
    description: 'inclusion projection returns only listed fields plus _id',
    seedDocs,
    operation: { kind: 'find', filter: {}, projection: { name: 1, age: 1 } },
  },
  {
    description: 'exclusion projection returns everything except listed fields',
    seedDocs,
    operation: { kind: 'find', filter: {}, projection: { age: 0, email: 0 } },
  },
  {
    description: '_id: 0 combined with inclusion excludes only _id',
    seedDocs,
    operation: { kind: 'find', filter: {}, projection: { _id: 0, name: 1 } },
  },
  {
    description: '_id: 0 alone is an exclusion projection (everything but _id)',
    seedDocs,
    operation: { kind: 'find', filter: {}, projection: { _id: 0 } },
  },
  {
    description: 'nested dot-notation inclusion reconstructs the nested structure',
    seedDocs,
    operation: { kind: 'find', filter: { _id: '1' }, projection: { name: 1, 'address.city': 1 } },
  },
  {
    description: 'nested dot-notation exclusion removes only the nested field',
    seedDocs,
    operation: { kind: 'find', filter: { _id: '1' }, projection: { 'address.country': 0 } },
  },
  {
    description: 'boolean true projection values behave like 1 (inclusion)',
    seedDocs,
    operation: { kind: 'find', filter: { _id: '1' }, projection: { name: true, age: true } },
  },
  {
    description: 'boolean false projection values behave like 0 (exclusion)',
    seedDocs,
    operation: { kind: 'find', filter: { _id: '1' }, projection: { age: false, email: false } },
  },
];
