// Entity extraction service. Sends page text chunks to the LLM and parses
// structured entity rows from the JSON response. Each entity cell includes
// source attribution (URL, title, snippet). Chunks are processed sequentially
// and capped at a configurable maximum to stay within free-tier rate limits.

import OpenAI from 'openai';
import pLimit from 'p-limit';

import { config, hasLlmConfig } from '../config.js';
import { HttpError } from '../utils/httpError.js';
import { retryWithBackoff } from '../utils/retryWithBackoff.js';
import { throttleLlm } from '../utils/llmThrottle.js';
import { chunkPage } from './chunker.js';

const EXTRACTION_TIMEOUT_MS = 25000;
const extractionLimit = pLimit(1);

// Creates an OpenAI-compatible client configured for the selected LLM provider.
function buildLlmClient() {
  if (!hasLlmConfig()) {
    return null;
  }

  const clientOptions = {
    apiKey: config.llmApiKey,
    timeout: EXTRACTION_TIMEOUT_MS
  };

  if (config.llmProvider !== 'openai' && config.llmBaseUrl) {
    clientOptions.baseURL = config.llmBaseUrl;
  }

  if (config.llmBaseUrl.includes('openrouter.ai')) {
    clientOptions.defaultHeaders = {
      'X-Title': config.openRouterAppName
    };

    if (config.openRouterSiteUrl) {
      clientOptions.defaultHeaders['HTTP-Referer'] = config.openRouterSiteUrl;
    }
  }

  return new OpenAI(clientOptions);
}

const llmClient = buildLlmClient();

// Parses a JSON string, stripping markdown code fences if present.
function safeJsonParse(text) {
  const normalized = String(text || '').trim();

  if (!normalized) {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    const fencedMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

    if (!fencedMatch) {
      return null;
    }

    try {
      return JSON.parse(fencedMatch[1]);
    } catch {
      return null;
    }
  }
}

// Normalizes a raw cell value into the { value, sources } format.
// The LLM returns simple values; source metadata is attached here from the page.
function ensureCell(cell, fallbackSource) {
  if (cell == null) {
    return null;
  }

  const value = String(typeof cell === 'object' ? cell.value : cell).trim();
  if (!value || value.toLowerCase() === 'null' || value.toLowerCase() === 'n/a' || value.toLowerCase() === 'unknown') return null;

  return {
    value,
    sources: [fallbackSource]
  };
}

// Maps a raw LLM entity object to a normalized row with validated cells.
function normalizeEntity(rawEntity, columns, fallbackSource) {
  const cells = {};

  for (const column of columns) {
    cells[column] = ensureCell(rawEntity[column], fallbackSource);
  }

  if (!cells.name) {
    return null;
  }

  return {
    cells,
    confidence: typeof rawEntity.confidence === 'number' ? rawEntity.confidence : 0.8
  };
}

// Builds the extraction prompt instructing the LLM to return structured entities.
// Output is kept minimal (plain values) to reduce token count and latency.
function buildPrompt({ topic, entityType, columns, page }) {
  return `Extract entities from the page text below.\nReturn JSON: {"entities": [{"name": "...", ${columns.filter(c => c !== 'name').map(c => `"${c}": "..."`).join(', ')}, "confidence": 0.9}]}\n\nRules:\n- Only entities relevant to the topic.\n- Use facts from the text only. If unknown, use null.\n- Each field value is a plain string (not an object).\n- confidence: 0-1 based on relevance and support.\n- Order by relevance (most relevant first).\n- No markdown fences.\n\nTopic: ${topic}\nEntity type: ${entityType}\nColumns: ${columns.join(', ')}\n\nPage text:\n${page.content}`;
}

// Sends a single page chunk to the LLM and returns an array of normalized entities.
async function extractFromPageWithOpenAi({ topic, entityType, columns, page }) {
  if (!llmClient) {
    throw new HttpError(500, 'Missing LLM_API_KEY or OPENAI_API_KEY in environment');
  }

  let completion;
  const llmStart = Date.now();
  console.log(`[entityExtractor] Sending chunk to LLM: ${page.chunk_id || page.url} (${page.content.length} chars)`);

  // Use shared throttle to coordinate with all other LLM calls
  await throttleLlm();

  try {
    completion = await retryWithBackoff(
      () => llmClient.chat.completions.create({
        model: config.llmModel,
        messages: [
          {
            role: 'system',
            content: 'You are a precise information extraction system.'
          },
          {
            role: 'user',
            content: buildPrompt({ topic, entityType, columns, page })
          }
        ],
        temperature: 0,
        max_tokens: 2048
      }),
      { label: `extract:${page.url}` }
    );
  } catch (error) {
    console.warn(`[entityExtractor] LLM call failed after ${Date.now() - llmStart}ms: ${error.message}`);
    const isTimeout = error?.name === 'AbortError' || error?.status === 408 || /timeout/i.test(error?.message || '');

    if (isTimeout) {
      throw new HttpError(504, `LLM extraction timed out for ${page.url}`);
    }

    throw new HttpError(error?.status || 502, error?.message || 'LLM extraction failed');
  }

  console.log(`[entityExtractor] LLM responded in ${Date.now() - llmStart}ms for ${page.chunk_id || page.url}`);
  const content = completion.choices[0]?.message?.content || '{}';
  const parsed = safeJsonParse(content);

  if (!parsed || !Array.isArray(parsed.entities)) {
    console.warn(`[entityExtractor] No entities parsed from ${page.chunk_id || page.url}`);
    return [];
  }

  const fallbackSource = {
    url: page.url,
    title: page.title,
    snippet: page.content.slice(0, 220),
    chunk_id: `${page.url}#page`,
    confidence: 0.8
  };

  const entities = parsed.entities
    .map((entity) => normalizeEntity(entity, columns, fallbackSource))
    .filter(Boolean);

  console.log(`[entityExtractor] Extracted ${entities.length} entities from ${page.chunk_id || page.url}`);
  return entities;
}

// Splits all pages into chunks, caps to MAX_CHUNKS, and extracts entities
// sequentially from each chunk via the LLM.
export async function extractEntities({ topic, entityType, columns, pages }) {
  // Flatten pages into chunks, cap at 3 to keep latency under 1 minute
  const MAX_CHUNKS = 3;
  const allChunks = pages.flatMap((page) => chunkPage(page)).slice(0, MAX_CHUNKS);
  console.log(`[entityExtractor] Processing ${allChunks.length} chunks from ${pages.length} pages (capped at ${MAX_CHUNKS})`);

  let completed = 0;
  const settledExtractions = await Promise.all(
    allChunks.map((chunk) =>
      extractionLimit(async () => {
        try {
          const result = await extractFromPageWithOpenAi({
            topic, entityType, columns, page: chunk
          });
          completed++;
          console.log(`[entityExtractor] Progress: ${completed}/${allChunks.length} chunks done`);
          return result;
        } catch (error) {
          completed++;
          console.warn(`[entityExtractor] Chunk ${completed}/${allChunks.length} failed for ${chunk.url}: ${error.message}`);
          return [];
        }
      })
    )
  );

  const total = settledExtractions.flat();
  console.log(`[entityExtractor] Finished: ${total.length} entities from ${allChunks.length} chunks`);
  return total;
}
