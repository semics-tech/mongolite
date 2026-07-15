import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { DocumentWithId } from '../../../src/types.js';
import type { ParityBackend } from './backend.js';
import type { ParityScenario } from './types.js';
import { normalizeResultSet } from './normalize.js';

export interface ParitySuiteContext {
  mongolite: ParityBackend;
  mongo: ParityBackend;
}

/**
 * Runs each scenario against both backends and asserts the results match — an oracle-based
 * check against the real `mongodb` driver, rather than a hand-written expected value that can
 * silently encode the same wrong assumption as the implementation being tested.
 */
export function runParitySuite<T extends DocumentWithId>(
  suiteName: string,
  scenarios: ParityScenario<T>[],
  ctx: () => ParitySuiteContext
): void {
  describe(suiteName, () => {
    scenarios.forEach((scenario, index) => {
      it(scenario.description, async () => {
        const { mongolite, mongo } = ctx();
        const collectionName = `${suiteName}_${index}`;

        await mongolite.dropCollection(collectionName);
        await mongo.dropCollection(collectionName);
        await mongolite.seed(collectionName, scenario.seedDocs);
        await mongo.seed(collectionName, scenario.seedDocs);

        const op = scenario.operation;
        const isWrite = op.kind === 'updateOne' || op.kind === 'updateMany';
        const verifyVia = scenario.verifyVia ?? (isWrite ? 'refetchAll' : 'operationResult');

        const mongoliteOpResult = await mongolite.run(collectionName, op);
        const mongoOpResult = await mongo.run(collectionName, op);

        const mongoliteResult =
          verifyVia === 'refetchAll'
            ? await mongolite.run(collectionName, { kind: 'find', filter: {} })
            : mongoliteOpResult;
        const mongoResult =
          verifyVia === 'refetchAll' ? await mongo.run(collectionName, { kind: 'find', filter: {} }) : mongoOpResult;

        const orderMatters = op.kind === 'find' && op.sort !== undefined;
        const normalizedMongolite = normalizeResultSet(mongoliteResult, { orderMatters });
        const normalizedMongo = normalizeResultSet(mongoResult, { orderMatters });

        if (scenario.knownDivergence) {
          assert.notDeepStrictEqual(
            normalizedMongolite,
            normalizedMongo,
            `Expected a known divergence from real MongoDB (${scenario.knownDivergence.reason}), ` +
              `but results now match — update or remove this knownDivergence.`
          );
        } else {
          assert.deepStrictEqual(
            normalizedMongolite,
            normalizedMongo,
            'mongolite-ts result diverged from real MongoDB'
          );
        }
      });
    });
  });
}
