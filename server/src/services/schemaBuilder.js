// Schema builder service. Split into two phases:
//   1. inferEntityType() - quick LLM call before search to determine entity type
//   2. inferColumns()    - data-driven LLM call after scraping to pick columns
//                          based on what content is actually available
// Both use in-memory caches to avoid duplicate LLM calls.

import OpenAI from 'openai';
import { config } from '../config.js';
import { retryWithBackoff } from '../utils/retryWithBackoff.js';
import { throttleLlm } from '../utils/llmThrottle.js';

const llmClient = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
  timeout: 10000
});

const ENTITY_TYPE_PROMPT = `You classify whether a user's input can be answered by searching the web for a list of entities (places, companies, tools, people, products, etc.).

Accept inputs that have a searchable intent, even if phrased conversationally. Examples:
- "AI startups in healthcare" -> valid, entityType: "company"
- "I'm in Bangalore, what are popular spots to visit?" -> valid, entityType: "tourist_attraction"
- "best project management tools" -> valid, entityType: "software_tool"
- "cheap flights to Tokyo" -> valid, entityType: "flight_deal"

Only reject inputs that have NO searchable intent:
- Pure greetings with no topic (e.g., "hello", "hi there", "thanks")
- Random characters or gibberish (e.g., "asdfgh", "!!!???")
- Meta questions about this system (e.g., "what can you do", "help")

If valid, return: {"valid": true, "entityType": "...", "requestedCount": N}
where requestedCount is the number of entities the user asked for (e.g., "top 3 books" -> 3, "best 5 restaurants" -> 5).
If the user did not specify a count, omit requestedCount.
If not valid, return: {"valid": false}

Return valid JSON only. Do not include markdown fences.`;

const COLUMNS_PROMPT = `You are a schema designer for a structured search system.
Given a user's topic, entity type, and snippets from actual web pages found for this topic,
choose 5-8 column names that would form a useful comparison table.

Rules:
- Always include "name" as the first column.
- Include "website" when relevant.
- Only pick columns whose values are actually present in the provided page snippets.
- Prefer concrete, data-rich columns over vague ones.

Return valid JSON only: {"columns": ["name", ...]}
Do not include markdown fences.`;

const entityTypeCache = new Map();
const columnsCache = new Map();

// Quick LLM call that validates the topic and determines the entity type.
// Returns { valid: true, entityType: string } or { valid: false, reason: string }.
export async function inferEntityType(topic) {
  if (entityTypeCache.has(topic)) {
    return entityTypeCache.get(topic);
  }

  try {
    await throttleLlm();
    const completion = await retryWithBackoff(
      () => llmClient.chat.completions.create({
        model: config.llmModel,
        messages: [
          { role: 'system', content: ENTITY_TYPE_PROMPT },
          { role: 'user', content: topic }
        ],
        temperature: 0
      }),
      { label: 'entityTypeInference' }
    );

    const text = completion.choices[0]?.message?.content || '';
    const parsed = JSON.parse(text.replace(/```json?\s*|\s*```/g, ''));

    if (parsed.valid === false) {
      const result = { valid: false, reason: parsed.reason || 'Not a valid research topic' };
      entityTypeCache.set(topic, result);
      return result;
    }

    if (parsed.entityType) {
      const result = { valid: true, entityType: parsed.entityType };
      if (typeof parsed.requestedCount === 'number' && parsed.requestedCount > 0) {
        result.requestedCount = Math.min(parsed.requestedCount, 25);
      }
      entityTypeCache.set(topic, result);
      return result;
    }
  } catch (error) {
    console.warn(`[schemaBuilder] Entity type inference failed, using fallback: ${error.message}`);
  }

  return { valid: true, entityType: 'entity' };
}

// Data-driven LLM call to pick table columns based on actual scraped content.
// Called after scraping so columns reflect what data is available on the pages.
// Returns string[] of column names.
export async function inferColumns(topic, entityType, pages) {
  const cacheKey = `${topic}::${entityType}`;
  if (columnsCache.has(cacheKey)) {
    return columnsCache.get(cacheKey);
  }

  const snippets = pages
    .slice(0, 5)
    .map((p) => `[${p.title}] ${p.content.slice(0, 600)}`)
    .join('\n---\n');

  try {
    await throttleLlm();
    const completion = await retryWithBackoff(
      () => llmClient.chat.completions.create({
        model: config.llmModel,
        messages: [
          { role: 'system', content: COLUMNS_PROMPT },
          {
            role: 'user',
            content: `Topic: ${topic}\nEntity type: ${entityType}\n\nPage snippets:\n${snippets}`
          }
        ],
        temperature: 0
      }),
      { label: 'columnInference' }
    );

    const text = completion.choices[0]?.message?.content || '';
    const parsed = JSON.parse(text.replace(/```json?\s*|\s*```/g, ''));

    if (Array.isArray(parsed.columns) && parsed.columns.includes('name') && parsed.columns.length >= 3) {
      columnsCache.set(cacheKey, parsed.columns);
      return parsed.columns;
    }
  } catch (error) {
    console.warn(`[schemaBuilder] Column inference failed, using fallback: ${error.message}`);
  }

  const fallback = ['name', 'website', 'description', 'category', 'location', 'notable_detail'];
  columnsCache.set(cacheKey, fallback);
  return fallback;
}