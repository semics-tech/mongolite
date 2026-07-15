import { before, after } from 'node:test';
import { createMongoliteBackend } from './harness/mongoliteBackend.js';
import { createMongoBackend } from './harness/mongoBackend.js';
import { getSharedMongoUri, stopSharedMongoMemoryServer } from './harness/setup.js';
import { runParitySuite, type ParitySuiteContext } from './harness/parityRunner.js';
import { projectionScenarios } from './scenarios/projection.scenarios.js';

let context: ParitySuiteContext;

before(async () => {
  const uri = await getSharedMongoUri();
  context = {
    mongolite: createMongoliteBackend(),
    mongo: createMongoBackend(uri, 'mongolite_parity_projection'),
  };
});

after(async () => {
  await context.mongolite.close();
  await context.mongo.close();
  await stopSharedMongoMemoryServer();
});

runParitySuite('projection', projectionScenarios, () => context);
