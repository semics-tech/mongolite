import type { DocumentWithId } from '../../../src/types.js';
import type { ParityScenario } from './types.js';

interface SmokeDoc extends DocumentWithId {
  name: string;
  age: number;
}

export const smokeScenarios: ParityScenario<SmokeDoc>[] = [
  {
    description: 'find({}) returns all seeded documents',
    seedDocs: [
      { _id: '1', name: 'Alice', age: 30 },
      { _id: '2', name: 'Bob', age: 40 },
    ],
    operation: { kind: 'find', filter: {} },
  },
];
