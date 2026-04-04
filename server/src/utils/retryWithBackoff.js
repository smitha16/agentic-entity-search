// Retries an async function with exponential backoff when it receives a
// 429 (rate limited) response. Gives up after the configured number of
// retries and re-throws the original error.

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 2000;

export async function retryWithBackoff(fn, {
  maxRetries = DEFAULT_MAX_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  label = 'request'
} = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error?.status || error?.statusCode;
      const isRateLimited = status === 429;

      if (!isRateLimited || attempt === maxRetries) {
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
      console.warn(`[retry] ${label} got 429, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
