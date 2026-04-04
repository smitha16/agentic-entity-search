import OpenAI from 'openai';
import pLimit from 'p-limit';

import { config, hasLlmConfig } from '../config.js';
import { HttpError } from '../utils/httpError.js';
import { retryWithBackoff } from '../utils/retryWithBackoff.js';
import { throttleLlm } from '../utils/llmThrottle.js';
import { chunkPage } from './chunker.js';

const EXTRACTION_TIMEOUT_MS = 25000;
const extractionLimit = pLimit(1);

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

function ensureCell(cell, fallbackSource) {
  if (cell == null) {
    return null;
  }

  // Handle plain string/number values from LLMs that don't follow the nested format
  if (typeof cell !== 'object') {
    const value = String(cell).trim();
    if (!value) return null;
    return {
      value,
      sources: [fallbackSource]
    };
  }

  if (!cell.value) {
    return null;
  }

  const sources = Array.isArray(cell.sources) && cell.sources.length > 0 ? cell.sources : [fallbackSource];

  return {
    value: String(cell.value).trim(),
    sources: sources.map((source) => ({
      url: source.url || fallbackSource.url,
      title: source.title || fallbackSource.title,
      snippet: String(source.snippet || fallbackSource.snippet || '').trim(),
      chunk_id: source.chunk_id || fallbackSource.chunk_id,
      confidence: typeof source.confidence === 'number' ? source.confidence : 0.8
    }))
  };
}

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

function buildPrompt({ topic, entityType, columns, page }) {
  return `You extract structured entities from web page text.\nReturn valid JSON with exactly this shape: {\"entities\": Array<object>}\n\nRules:\n- Only extract entities relevant to the topic.\n- Use only facts explicitly supported by the page text.\n- If a field is unknown, use null.\n- Every non-null field must be an object with { value, sources }.\n- Each sources array item must include url, title, snippet, chunk_id, confidence.\n- Keep snippets short and copied from the page text when possible.\n- Do not add markdown fences.\n\nTopic: ${topic}\nEntity type: ${entityType}\nColumns: ${columns.join(', ')}\nPage URL: ${page.url}\nPage Title: ${page.title}\nChunk Id: ${page.url}#page\n\nPage text:\n${page.content}`;
}

async function extractFromPageWithOpenAi({ topic, entityType, columns, page }) {
  if (!llmClient) {
    throw new HttpError(500, 'Missing LLM_API_KEY or OPENAI_API_KEY in environment');
  }

  let completion;
  const llmStart = Date.now();
  console.log(`[entityExtractor] Sending chunk to LLM: ${page.chunk_id || page.url} (${page.content.length} chars)`);

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
        temperature: 0.1
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

export async function extractEntities({ topic, entityType, columns, pages }) {
  // Flatten pages into chunks, cap at 6 to keep total time reasonable on free-tier LLMs
  const MAX_CHUNKS = 6;
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
