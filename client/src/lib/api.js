// API client. Calls the SSE streaming search endpoint and dispatches
// per-step progress, result, and error events via callbacks.

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const REQUEST_TIMEOUT_MS = 600000; // 10 minutes for free-tier LLM pipelines

// Opens an SSE stream to the search endpoint and dispatches events to the
// provided callbacks: onStep for progress, onResult for the final data,
// and onError for server-side errors.
export async function searchEntitiesStream(payload, { onStep, onResult, onError }) {
  const response = await fetch(`${API_URL}/api/search/stream`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const json = await response.json().catch(() => null);
    throw new Error(json?.error || 'Request failed');
  }

  // Read the SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double newlines
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';  // Keep incomplete chunk in buffer

    for (const part of parts) {
      // Each SSE line starts with "data: "
      const line = part.trim();
      if (!line.startsWith('data: ')) continue;

      const data = line.slice(6);  // Remove "data: " prefix
      if (data === '[DONE]') return;

      try {
        const event = JSON.parse(data);

        if (event.type === 'step') {
          onStep(event);
        } else if (event.type === 'result') {
          onResult(event.data);
        } else if (event.type === 'error') {
          onError(new Error(event.message));
        }
      } catch {
        // Skip malformed events
      }
    }
  }
}
