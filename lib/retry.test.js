import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableModelError, withRetry, RETRY_ATTEMPTS } from './retry.js';

const geminiError = (status, text) =>
  new Error(
    `[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/x:generateContent: [${status} ${text}] something`
  );

test('isRetryableModelError matches the overload statuses the SDK reports in its message', () => {
  assert.equal(isRetryableModelError(geminiError(503, 'Service Unavailable')), true);
  assert.equal(isRetryableModelError(geminiError(429, 'Too Many Requests')), true);
  assert.equal(isRetryableModelError(geminiError(500, 'Internal Server Error')), true);
});

test('isRetryableModelError reads a status property when the SDK attaches one', () => {
  const error = new Error('overloaded');
  error.status = 503;
  assert.equal(isRetryableModelError(error), true);
});

test('isRetryableModelError refuses permanent failures', () => {
  assert.equal(isRetryableModelError(geminiError(400, 'Bad Request')), false);
  assert.equal(isRetryableModelError(geminiError(404, 'Not Found')), false);
  // An API key problem retried three times is three times the latency and the
  // same failure.
  assert.equal(isRetryableModelError(geminiError(403, 'Forbidden')), false);
  assert.equal(isRetryableModelError(new SyntaxError('Unexpected token')), false);
});

test('isRetryableModelError retries a dropped connection', () => {
  const error = new Error('fetch failed');
  error.cause = { code: 'ECONNRESET' };
  assert.equal(isRetryableModelError(error), true);
});

test('withRetry returns the first success without sleeping', async () => {
  const slept = [];
  const result = await withRetry(async () => 'ok', { sleep: async (ms) => slept.push(ms) });
  assert.equal(result, 'ok');
  assert.deepEqual(slept, []);
});

test('withRetry rides out a transient 503 and backs off between attempts', async () => {
  const slept = [];
  let calls = 0;

  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw geminiError(503, 'Service Unavailable');
      return 'recovered';
    },
    { sleep: async (ms) => slept.push(ms) }
  );

  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
  assert.equal(slept.length, 2);
  assert.ok(slept[1] > slept[0], 'backoff must grow, not hammer a model that is already overloaded');
});

test('withRetry rethrows the last error once attempts run out', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw geminiError(503, 'Service Unavailable');
      },
      { sleep: async () => {} }
    ),
    /503 Service Unavailable/
  );
  assert.equal(calls, RETRY_ATTEMPTS);
});

test('withRetry gives up immediately on a permanent error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw geminiError(400, 'Bad Request');
      },
      { sleep: async () => {} }
    ),
    /400 Bad Request/
  );
  assert.equal(calls, 1);
});
