import OpenAI from 'openai';
import pLimit from 'p-limit';

import { config, hasLlmConfig } from '../config.js';
import { HttpError } from '../utils/httpError.js';

const EXTRACTION_TIMEOUT_MS = 25000;
const extractionLimit = pLimit(2);

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
  if (!cell || typeof cell !== 'object' || !cell.value) {
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

  try {
    completion = await llmClient.chat.completions.create({
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
    });
  } catch (error) {
    const isTimeout = error?.name === 'AbortError' || error?.status === 408 || /timeout/i.test(error?.message || '');

    if (isTimeout) {
      throw new HttpError(504, `LLM extraction timed out for ${page.url}`);
    }

    throw new HttpError(error?.status || 502, error?.message || 'LLM extraction failed');
  }

  const content = completion.choices[0]?.message?.content || '{}';
  const parsed = safeJsonParse(content);

  if (!parsed || !Array.isArray(parsed.entities)) {
    return [];
  }

  const fallbackSource = {
    url: page.url,
    title: page.title,
    snippet: page.content.slice(0, 220),
    chunk_id: `${page.url}#page`,
    confidence: 0.8
  };

  return parsed.entities
    .map((entity) => normalizeEntity(entity, columns, fallbackSource))
    .filter(Boolean);
}

export async function extractEntities({ topic, entityType, columns, pages }) {
  const settledExtractions = await Promise.all(
    pages.map((page) =>
      extractionLimit(async () => {
        try {
          return await extractFromPageWithOpenAi({ topic, entityType, columns, page });
        } catch {
          return [];
        }
      })
    )
  );

  return settledExtractions.flat();
}
