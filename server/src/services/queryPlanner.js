// server/services/queryPlanner.js — NEW VERSION

import OpenAI from 'openai';
import { config } from '../config.js';

const llmClient = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
  timeout: 10000
});

const PLANNER_PROMPT = `You are a search query strategist. Given a user's research topic, generate 4-5 diverse search queries that would collectively surface the most relevant entities and data.

Strategy:
- Include one broad overview query (e.g., listicle, comparison, "best X 2024")
- Include one specific/niche query targeting deeper sources
- Include one query aimed at recent/updated content
- Vary phrasing to avoid search engine deduplication

Return valid JSON only: {"queries": ["query1", "query2", ...]}
No markdown fences.`;

export async function buildQueryPlan(topic, entityType) {
  try {
    const completion = await llmClient.chat.completions.create({
      model: config.llmModel,
      messages: [
        { role: 'system', content: PLANNER_PROMPT },
        { role: 'user', content: `Topic: ${topic}\nEntity type: ${entityType}` }
      ],
      temperature: 0.3
    });

    const text = completion.choices[0]?.message?.content || '';
    const parsed = JSON.parse(text.replace(/```json?\s*|\s*```/g, ''));

    if (Array.isArray(parsed.queries) && parsed.queries.length > 0) {
      return parsed.queries.slice(0, 5);
    }
  } catch {
    // fall through
  }

  // Fallback to basic approach
  return [topic, `best ${topic} 2024`, `${topic} comparison`, `top ${topic} list`];
}