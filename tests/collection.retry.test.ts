import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MongoLiteCollection, DocumentWithId } from '../src/index';

interface TestDoc extends DocumentWithId {
  name: string;
  value: number;
  tags?: string[];
}

describe('MongoLiteCollection - Retry Mechanism', () => {
  it('should retry on SQLITE_BUSY errors with exponential backoff', async () => {
    // Create a collection directly with mocked retryWithBackoff method
    const collection = new MongoLiteCollection<TestDoc>(
      {} as any, // Mock db, won't be used directly
      'testRetryCollection'
    );

    // Track retry attempts
    let retryCount = 0;
    const maxRetries = 3;
    const startTime = Date.now();
    const retryTimes: number[] = [];

    // Mock the retryWithBackoff method to track attempts and timing
    const originalRetryMethod = (collection as any).retryWithBackoff;
    (collection as any).retryWithBackoff = async function (
      operation: () => Promise<any>,
      operationDescription: string,
      _maxRetries = 5,
      initialDelayMs = 50, // Use smaller delays for faster tests
      maxDelayMs = 500
    ) {
      // Override the retry parameters for testing
      return originalRetryMethod.call(
        this,
        async () => {
          retryCount++;
          retryTimes.push(Date.now() - startTime);

          // Fail for the first maxRetries attempts
          if (retryCount <= maxRetries) {
            const error = new Error('Database is busy');
            (error as NodeJS.ErrnoException).code = 'SQLITE_BUSY';
            throw error;
          }

          // Succeed on attempt maxRetries + 1
          return { acknowledged: true, insertedId: 'test-id' };
        },
        operationDescription,
        maxRetries,
        initialDelayMs,
        maxDelayMs
      );
    };

    // Call the method that should trigger retries
    const result = await (collection as any).retryWithBackoff(
      async () => ({ acknowledged: true, insertedId: 'test-id' }),
      'test operation',
      maxRetries
    );

    // Verify retry count and result
    assert.strictEqual(retryCount, maxRetries + 1, `Should retry ${maxRetries} times then succeed`);
    assert.strictEqual(result.acknowledged, true);
    assert.strictEqual(result.insertedId, 'test-id');

    // Verify exponential backoff - each retry should take longer
    console.log('Retry times:', retryTimes);
    for (let i = 1; i < retryTimes.length; i++) {
      const delay = retryTimes[i] - retryTimes[i - 1];
      console.log(`Delay between attempts ${i} and ${i + 1}: ${delay}ms`);

      if (i > 1) {
        // Each delay should be approximately double the previous (with some jitter)
        const ratio = delay / (retryTimes[i - 1] - retryTimes[i - 2]);
        assert.ok(
          ratio > 1.5 || delay > 200,
          `Delay should increase exponentially, but ratio was ${ratio}`
        );
      }
    }
  });

  it('should fail after maximum retries', async () => {
    // Create a collection directly with mocked retryWithBackoff method
    const collection = new MongoLiteCollection<TestDoc>(
      {} as any, // Mock db, won't be used directly
      'testRetryCollection'
    );

    // Track retry attempts
    let retryCount = 0;
    const maxRetries = 3;

    // Mock the retryWithBackoff method to always fail
    const originalRetryMethod = (collection as any).retryWithBackoff;
    (collection as any).retryWithBackoff = async function (
      operation: () => Promise<any>,
      operationDescription: string,
      _maxRetries = 5,
      initialDelayMs = 50, // Use smaller delays for faster tests
      maxDelayMs = 500
    ) {
      return originalRetryMethod.call(
        this,
        async () => {
          retryCount++;
          // Always fail
          const error = new Error('Database is busy');
          (error as NodeJS.ErrnoException).code = 'SQLITE_BUSY';
          throw error;
        },
        operationDescription,
        maxRetries,
        initialDelayMs,
        maxDelayMs
      );
    };

    try {
      // Should fail after maxRetries
      await (collection as any).retryWithBackoff(async () => ({}), 'test operation', maxRetries);
      assert.fail('Should have thrown an error after maximum retries');
    } catch (error) {
      assert.strictEqual((error as NodeJS.ErrnoException).code, 'SQLITE_BUSY');
      assert.strictEqual(
        retryCount,
        maxRetries + 1,
        `Should have attempted ${maxRetries + 1} times before giving up`
      );
    }
  });
});
