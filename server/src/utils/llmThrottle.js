// server/src/utils/llmThrottle.js
// Shared throttle for all LLM calls to stay under free-tier rate limits

const THROTTLE_MS = 4000; // ~15 RPM — safe for all free tiers
let lastLlmCallTime = 0;

export async function throttleLlm() {
  const elapsed = Date.now() - lastLlmCallTime;
  if (elapsed < THROTTLE_MS) {
    await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS - elapsed));
  }
  lastLlmCallTime = Date.now();
}
