/**
 * Retry for the one call in this API that fails for reasons the user cannot act
 * on: generateContent against a preview model. `gemini-3.1-flash-lite-preview`
 * answers 503 "This model is currently experiencing high demand" during spikes,
 * and the handler turned that straight into a 500 the UI showed as a flat
 * "Translation failed" — indistinguishable, from the user's side, from a bug.
 */

/** Statuses worth a second look. 429 here is the MODEL rate-limiting us, not the user's daily quota. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Transport faults: the request never reached a model, so nothing was spent. */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET']);

export const RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 400;

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const isRetryableModelError = (error) => {
  if (!error) return false;

  if (typeof error.status === 'number') return RETRYABLE_STATUSES.has(error.status);

  const code = (error.cause || {}).code || error.code;
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) return true;

  // @google/generative-ai throws a plain Error whose only machine-readable part
  // is the "[503 Service Unavailable]" it splices into the message.
  const match = /\[(\d{3}) /.exec(error.message || '');
  return match ? RETRYABLE_STATUSES.has(Number(match[1])) : false;
};

/**
 * Runs `fn`, retrying only errors that a retry could plausibly fix. Exponential
 * backoff, because the failure being retried is usually "too much load" and a
 * tight loop is the wrong answer to that. `sleep` is injected so tests do not
 * pay the delay.
 */
export const withRetry = async (fn, { attempts = RETRY_ATTEMPTS, baseDelayMs = RETRY_BASE_DELAY_MS, sleep = sleepReal } = {}) => {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableModelError(error)) throw error;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
};
