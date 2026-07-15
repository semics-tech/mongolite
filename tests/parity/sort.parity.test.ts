import { before, after } from 'node:test';
import { createMongoliteBackend } from './harness/mongoliteBackend.js';
import { createMongoBackend } from './harness/mongoBackend.js';
import { getSharedMongoUri, stopSharedMongoMemoryServer } from './harness/setup.js';
import { runParitySuite, type ParitySuiteContext } from './harness/parityRunner.js';
import { sortScenarios } from './scenarios/sort.scenarios.js';

let context: ParitySuiteContext;

before(async () => {
  const uri = await getSharedMongoUri();
  context = {
    mongolite: createMongoliteBackend(),
    mongo: createMongoBackend(uri, 'mongolite_parity_sort'),
  };
});

after(async () => {
  await context.mongolite.close();
  await context.mongo.close();
  await stopSharedMongoMemoryServer();
});

runParitySuite('sort', sortScenarios, () => context);
