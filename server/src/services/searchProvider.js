// Search provider abstraction. Supports Brave and Tavily search APIs.
// Runs all generated queries in parallel, deduplicates by URL, and returns
// a flat list of search result objects.

import { config, getSearchApiKey, hasSearchConfig } from '../config.js';
import { HttpError } from '../utils/httpError.js';

const SEARCH_TIMEOUT_MS = 12000;

// Strips the URL hash fragment and returns a canonical string, or null if invalid.
function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

// Wraps a fetch error into a 502 HttpError with a descriptive message.
function toSearchFetchError(providerName, error) {
  const reason = error?.cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
    ? 'connection timed out'
    : error?.message || 'request failed';

  return new HttpError(502, `${providerName} search request failed: ${reason}`);
}

// Calls the Brave Web Search API and returns the raw result array.
async function searchWithBrave(query, limitPerQuery) {
  let response;

  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limitPerQuery));

    response = await fetch(url, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': getSearchApiKey()
      }
    });
  } catch (error) {
    throw toSearchFetchError('Brave', error);
  }

  if (!response.ok) {
    throw new HttpError(502, `Brave search failed with status ${response.status}`);
  }

  const json = await response.json();
  return json.web?.results || [];
}

// Calls the Tavily Search API and returns the raw result array.
async function searchWithTavily(query, limitPerQuery) {
  let response;

  try {
    response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: getSearchApiKey(),
        query,
        search_depth: 'basic',
        max_results: limitPerQuery,
        include_answer: false,
        include_raw_content: false
      })
    });
  } catch (error) {
    throw toSearchFetchError('Tavily', error);
  }

  if (!response.ok) {
    throw new HttpError(502, `Tavily search failed with status ${response.status}`);
  }

  const json = await response.json();
  return json.results || [];
}

// Runs all queries against the configured search provider, deduplicates URLs,
// and returns a flat array of { query, rank, title, url, snippet, sourceType }.
export async function searchWeb(queries, limitPerQuery = 5) {
  if (!hasSearchConfig()) {
    throw new HttpError(500, 'Missing search API key');
  }

  const searchFn = config.searchProvider === 'tavily' ? searchWithTavily : searchWithBrave;

  const allResults = await Promise.allSettled(
    queries.map((query) => searchFn(query, limitPerQuery))
  );

  const results = [];
  const seen = new Set();

  for (let qi = 0; qi < queries.length; qi++) {
    const settled = allResults[qi];
    if (settled.status !== 'fulfilled') continue;

    for (const [index, item] of settled.value.entries()) {
      const normalized = normalizeUrl(item.url);
      if (!normalized || seen.has(normalized)) continue;

      seen.add(normalized);
      results.push({
        query: queries[qi],
        rank: index + 1,
        title: item.title || normalized,
        url: normalized,
        snippet: item.description || item.content || '',
        sourceType: config.searchProvider
      });
    }
  }

  return results;
}