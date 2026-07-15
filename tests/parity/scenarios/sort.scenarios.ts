import type { DocumentWithId } from '../../../src/types.js';
import type { ParityScenario } from '../harness/types.js';

interface SortDoc extends DocumentWithId {
  name: string;
  age: number;
  group: string;
}

const seedDocs: SortDoc[] = [
  { _id: '1', name: 'Charlie', age: 30, group: 'b' },
  { _id: '2', name: 'Alice', age: 40, group: 'a' },
  { _id: '3', name: 'Bob', age: 40, group: 'a' },
];

export const sortScenarios: ParityScenario<SortDoc>[] = [
  {
    description: 'sort ascending by a numeric field',
    seedDocs,
    operation: { kind: 'find', filter: {}, sort: { age: 1 } },
  },
  {
    description: 'sort descending by a numeric field',
    seedDocs,
    operation: { kind: 'find', filter: {}, sort: { age: -1 } },
  },
  {
    description: 'sort ascending by a string field',
    seedDocs,
    operation: { kind: 'find', filter: {}, sort: { name: 1 } },
  },
  {
    description: 'multi-field sort breaks ties with a second key',
    seedDocs,
    operation: { kind: 'find', filter: {}, sort: { group: 1, name: 1 } },
  },
  {
    description: 'sort by _id ascending',
    seedDocs,
    operation: { kind: 'find', filter: {}, sort: { _id: -1 } },
  },
];
