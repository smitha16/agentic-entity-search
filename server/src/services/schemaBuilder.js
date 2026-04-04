// server/services/schemaBuilder.js — NEW VERSION

import OpenAI from 'openai';
import { config } from '../config.js';
import { retryWithBackoff } from '../utils/retryWithBackoff.js';
import { throttleLlm } from '../utils/llmThrottle.js';

const llmClient = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
  timeout: 10000
});

const SCHEMA_PROMPT = `You are a schema designer for a structured search system.
Given a user's topic query, determine:
1. entityType: what kind of thing the user is looking for (e.g., "company", "restaurant", "software_tool", "person", "product")
2. columns: 5-8 attribute names that would form a useful comparison table for these entities. Always include "name" as the first column. Include "website" when relevant.

Return valid JSON only: {"entityType": "...", "columns": ["name", ...]}
Do not include markdown fences.`;

// Fast in-memory cache so identical topics don't re-call the LLM
const schemaCache = new Map();

export async function inferSchema(topic) {
  if (schemaCache.has(topic)) {
    return schemaCache.get(topic);
  }

  try {
    await throttleLlm();
    const completion = await retryWithBackoff(
      () => llmClient.chat.completions.create({
        model: config.llmModel,
        messages: [
          { role: 'system', content: SCHEMA_PROMPT },
          { role: 'user', content: topic }
        ],
        temperature: 0
      }),
      { label: 'schemaInference' }
    );

    const text = completion.choices[0]?.message?.content || '';
    const parsed = JSON.parse(text.replace(/```json?\s*|\s*```/g, ''));

    if (parsed.entityType && Array.isArray(parsed.columns) && parsed.columns.includes('name')) {
      schemaCache.set(topic, parsed);
      return parsed;
    }
  } catch (error) {
    console.warn(`[schemaBuilder] Schema inference failed, using fallback: ${error.message}`);
  }

  const fallback = {
    entityType: 'entity',
    columns: ['name', 'website', 'description', 'category', 'location', 'notable_detail']
  };
  schemaCache.set(topic, fallback);
  return fallback;
}