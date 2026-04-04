// Reflection service. After the first extraction pass, this asks the LLM
// whether the current results are satisfactory or if additional follow-up
// queries should be run to find missing entities or fill empty columns.

import OpenAI from 'openai';
import { config } from '../config.js';

const llmClient = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
  timeout: 12000
});

const REFLECT_PROMPT = `You are evaluating the quality of a structured entity search result.

Given:
- The original user topic
- The current table of entities (as JSON)
- The number of entities found

Assess:
1. Are there enough entities? (at least 5 for most topics)
2. Are there too many empty/null cells that could be filled?
3. Are there obvious well-known entities that are missing?

If improvements are needed, return:
{"satisfied": false, "followUpQueries": ["specific query 1", "specific query 2"], "reason": "..."}

If the results are good enough, return:
{"satisfied": true, "reason": "..."}

Return valid JSON only. No markdown fences.`;

// Evaluates the current set of extracted entities. If coverage is below
// threshold, asks the LLM for follow-up queries to improve results.
export async function reflectOnResults({ topic, entityType, columns, rows, maxEntities }) {
  // Skip reflection if results already meet both quantity and quality thresholds.
  const filledRatio = rows.reduce((sum, row) => {
    const filled = columns.filter((col) => row.cells[col]?.value).length;
    return sum + filled / columns.length;
  }, 0) / Math.max(rows.length, 1);

  if (rows.length >= maxEntities && filledRatio > 0.7) {
    return { satisfied: true, reason: 'Sufficient entities with good coverage' };
  }

  // Build a summary of current results for the LLM
  const summary = rows.slice(0, 10).map((row) => {
    const obj = {};
    for (const col of columns) {
      obj[col] = row.cells[col]?.value || null;
    }
    return obj;
  });

  try {
    const completion = await llmClient.chat.completions.create({
      model: config.llmModel,
      messages: [
        { role: 'system', content: REFLECT_PROMPT },
        {
          role: 'user',
          content: `Topic: ${topic}\nEntity type: ${entityType}\nColumns: ${columns.join(', ')}\nEntities found: ${rows.length}/${maxEntities}\n\nCurrent results:\n${JSON.stringify(summary, null, 2)}`
        }
      ],
      temperature: 0.2
    });

    const text = completion.choices[0]?.message?.content || '';
    return JSON.parse(text.replace(/```json?\s*|\s*```/g, ''));
  } catch {
    return { satisfied: true, reason: 'Reflection failed, accepting current results' };
  }
}