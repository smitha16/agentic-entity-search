// Shared throttle for all LLM calls. Enforces a minimum delay between
// consecutive requests to stay within free-tier rate limits.

const THROTTLE_MS = 2000;
let lastLlmCallTime = 0;

// Waits until at least THROTTLE_MS has elapsed since the last LLM call.
export async function throttleLlm() {
  const elapsed = Date.now() - lastLlmCallTime;
  if (elapsed < THROTTLE_MS) {
    await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS - elapsed));
  }
  lastLlmCallTime = Date.now();
}
