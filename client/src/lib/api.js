const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const REQUEST_TIMEOUT_MS = 60000;

export async function searchEntities(payload) {
  const response = await fetch(`${API_URL}/api/search`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(json?.error || 'Request failed');
  }

  return json;
}
