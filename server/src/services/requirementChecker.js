// Requirement checker service. Extracts structured requirements from the
// user's query, evaluates each entity against them, and re-ranks results
// by how many requirements each entity satisfies.
//
// Hybrid approach:
//   - Numeric comparisons (greater_than, less_than) → programmatic (LLM can't do math)
//   - Text checks (contains, equals) → LLM (understands geography, semantics, etc.)

import OpenAI from 'openai';
import { config } from '../config.js';
import { throttleLlm } from '../utils/llmThrottle.js';
import { retryWithBackoff } from '../utils/retryWithBackoff.js';

const llmClient = new OpenAI({
  apiKey: config.llmApiKey,
  baseURL: config.llmBaseUrl,
  timeout: 15000
});

// ─── Number parsing ───

// Parses money/number strings into raw numbers.
// "$1.1B" → 1100000000, "$946.4 million" → 946400000, "$10M" → 10000000
function parseNumber(str) {
  if (str == null) return null;

  const cleaned = String(str).replace(/[,$]/g, '').trim().toLowerCase();

  const match = cleaned.match(/([\d.]+)\s*(billion|million|trillion|b|m|k|t)?/i);
  if (!match) return null;

  let num = parseFloat(match[1]);
  if (isNaN(num)) return null;

  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'b' || suffix === 'billion') num *= 1_000_000_000;
  else if (suffix === 'm' || suffix === 'million') num *= 1_000_000;
  else if (suffix === 'k' || suffix === 'thousand') num *= 1_000;
  else if (suffix === 't' || suffix === 'trillion') num *= 1_000_000_000_000;

  return num;
}

// ─── JSON parsing ───

function robustJsonParse(text) {
  const cleaned = String(text || '').trim();

  try { return JSON.parse(cleaned); } catch { /* */ }

  const fenced = cleaned.replace(/```(?:json|python|js)?\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(fenced); } catch { /* */ }

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { /* */ }
  }

  return null;
}

// ─── Find cell value for a requirement field ───

// Tries to find the relevant cell value for a requirement field.
// Uses fuzzy matching: "funding" matches "Funding Amount", "location" matches "headquarters", etc.
function findCellValue(field, entityData, columns) {
  // Direct match
  if (entityData[field]) return entityData[field];

  const fieldLower = field.toLowerCase();

  for (const col of columns) {
    if (!entityData[col]) continue;
    const colLower = col.toLowerCase();

    // Funding-related
    if ((fieldLower.includes('funding') || fieldLower.includes('amount') || fieldLower.includes('raised') || fieldLower.includes('revenue') || fieldLower.includes('valuation')) &&
        (colLower.includes('funding') || colLower.includes('amount') || colLower.includes('raised') || colLower.includes('revenue') || colLower.includes('valuation') || colLower.includes('price'))) {
      return entityData[col];
    }

    // Location-related
    if ((fieldLower.includes('location') || fieldLower.includes('headquarters') || fieldLower.includes('based') || fieldLower.includes('city') || fieldLower.includes('country')) &&
        (colLower.includes('location') || colLower.includes('headquarters') || colLower.includes('city') || colLower.includes('address') || colLower.includes('country') || colLower.includes('region'))) {
      return entityData[col];
    }

    // Category/type-related
    if ((fieldLower.includes('type') || fieldLower.includes('cuisine') || fieldLower.includes('category') || fieldLower.includes('genre') || fieldLower.includes('industry')) &&
        (colLower.includes('type') || colLower.includes('cuisine') || colLower.includes('category') || colLower.includes('genre') || colLower.includes('industry') || colLower.includes('sector'))) {
      return entityData[col];
    }

    // Features/amenities-related
    if ((fieldLower.includes('feature') || fieldLower.includes('amenity') || fieldLower.includes('service')) &&
        (colLower.includes('feature') || colLower.includes('amenity') || colLower.includes('service') || colLower.includes('description'))) {
      return entityData[col];
    }
  }

  return null;
}

// ─── Programmatic check for numeric requirements ───

function checkNumericRequirement(operator, cellValue, thresholdValue) {
  const entityNum = parseNumber(cellValue);
  const thresholdNum = parseNumber(thresholdValue);

  if (entityNum === null || thresholdNum === null) {
    return null; // can't parse
  }

  let satisfied, closeness;

  if (operator === 'greater_than') {
    satisfied = entityNum > thresholdNum;
    closeness = satisfied ? 1.0 : (thresholdNum > 0 ? Math.min(entityNum / thresholdNum, 0.99) : 0);
  } else {
    satisfied = entityNum < thresholdNum;
    closeness = satisfied ? 1.0 : (entityNum > 0 ? Math.min(thresholdNum / entityNum, 0.99) : 0);
  }

  return {
    satisfied,
    closeness: Math.round(closeness * 100) / 100,
    reason: `${cellValue} (${entityNum.toLocaleString()}) ${operator === 'greater_than' ? '>' : '<'} ${thresholdValue} (${thresholdNum.toLocaleString()}): ${satisfied ? 'yes' : 'no'}`
  };
}

// ─── LLM check for text-based requirements ───

const TEXT_CHECK_PROMPT = `You check whether entities satisfy text-based requirements.

For each entity and requirement, determine:
- "satisfied": true or false
- "closeness": 0.0 to 1.0 (1.0 = clearly satisfies, 0.5 = somewhat, 0.0 = clearly not)
- "reason": brief explanation

Be STRICT and ACCURATE. Look at the actual numbers and values:
- If you have data that goes years back, it is still valid. Treat it as a known fact.
- Always cross-reference multiple columns when the requirement involves "only", "none", "all", etc.
- Use real-world knowledge for geography: "Boston" is in the US, "Amherst" is in Massachusetts, etc.
- When checking location/nationality requirements, treat these as equivalent:
  country adjectives and country names (e.g. "Swiss" = "Switzerland", 
  "French" = "France", "Spanish" = "Spain" etc.)
- When checking if someone has done/won/achieved something, look at ALL columns in the entity data for relevant evidence. If any column contains a numeric value >= 1 or descriptive text related to the requirement, that counts as evidence.
- Do NOT overthink simple checks. If the data clearly supports the requirement, mark it satisfied.
- Match requirements semantically, not just by exact field names. "Won grand slams" should match a column called "Grand Slam Titles" or "Major Wins". "Scored goals" should match "Goals" or "Career Goals".

Use your knowledge. For example:
- "Boston" IS in the US (it's in Massachusetts)
- "Amherst" IS in Massachusetts
- A "sushi restaurant" IS NOT vegetarian
- "Mountain View, California" IS in the US
- "London" is NOT in the US (unless specified as London, Ohio etc.)
- "Pad Thai" CAN be vegetarian depending on ingredients

Be accurate. Use real-world knowledge about geography, categories, and semantics.

CRITICAL: Return ONLY valid JSON. No Python. No markdown. No explanations.
Format:
{"results": [{"entity_index": 0, "requirement_index": 0, "satisfied": true, "closeness": 1.0, "reason": "Boston is in Massachusetts, US"}]}`;

async function checkTextRequirementsWithLlm(entitiesToCheck) {
  if (entitiesToCheck.length === 0) return [];

  const BATCH_SIZE = 12;
  const allResults = [];

  for (let i = 0; i < entitiesToCheck.length; i += BATCH_SIZE) {
    const batch = entitiesToCheck.slice(i, i + BATCH_SIZE);

    // Renumber to 0-based within this batch
    const renumbered = batch.map((check, localIdx) => ({
      ...check,
      entity_index: localIdx,
      requirement_index: check.requirement_index
    }));

    try {
      await throttleLlm();
      const completion = await retryWithBackoff(
        () => llmClient.chat.completions.create({
          model: config.llmModel,
          messages: [
            { role: 'system', content: TEXT_CHECK_PROMPT },
            {
              role: 'user',
              content: `Check these:\n${JSON.stringify(renumbered, null, 2)}`
            }
          ],
          temperature: 0,
          top_p: 0.01
        }),
        { label: `textRequirementCheck-batch-${i}` }
      );

      const text = completion.choices[0]?.message?.content || '';
      console.log(`[requirementChecker] LLM text check batch ${Math.floor(i / BATCH_SIZE) + 1} response: ${text.slice(0, 300)}`);

      const parsed = robustJsonParse(text);
      if (parsed && Array.isArray(parsed.results)) {
        // Map local indices back to original
        for (const result of parsed.results) {
          const localIdx = result.entity_index;
          if (localIdx != null && localIdx < batch.length) {
            result.entity_index = batch[localIdx].entity_index;
            result.requirement_index = batch[localIdx].requirement_index;
          }
        }
        allResults.push(...parsed.results);
      }
    } catch (error) {
      console.warn(`[requirementChecker] LLM text check batch failed: ${error.message}`);
    }
  }

  return allResults;
}

// ─── Step 1: Extract requirements from the query ───

const EXTRACT_REQUIREMENTS_PROMPT = `You extract specific, testable requirements from a user's search query.

A requirement is any constraint the user specified about the entities they want.
Only extract requirements that are explicitly stated or clearly implied.

Examples:
- "AI startups in the US with more than 10M funding"
  → {"requirements": [{"field": "location", "operator": "contains", "value": "US", "description": "Based in the US"}, {"field": "funding", "operator": "greater_than", "value": "10000000", "description": "Funding greater than $10M"}]}

- "vegetarian restaurants in Amherst"
  → {"requirements": [{"field": "cuisine", "operator": "contains", "value": "vegetarian", "description": "Serves vegetarian food"}, {"field": "location", "operator": "contains", "value": "Amherst", "description": "Located in Amherst"}]}

- "open source database tools that support SQL"
  → {"requirements": [{"field": "license", "operator": "equals", "value": "open source", "description": "Must be open source"}, {"field": "features", "operator": "contains", "value": "SQL", "description": "Supports SQL"}]}

IMPORTANT: A number indicating how many results the user wants (e.g., "50 startups", "top 10 restaurants", "5 best tools") is NOT a requirement. It is a count of desired results, not a filter condition. Do NOT extract it as a requirement.

Operators:
- equals: exact match
- contains: text/semantic match (use for location, cuisine, features, etc.)
- greater_than: numeric comparison
- less_than: numeric comparison

CRITICAL: Return ONLY a JSON object. No Python. No markdown. No explanations.
Your ENTIRE response must be valid JSON starting with { and ending with }`;

export async function extractRequirements(topic) {
  try {
    await throttleLlm();
    const completion = await retryWithBackoff(
      () => llmClient.chat.completions.create({
        model: config.llmModel,
        messages: [
          { role: 'system', content: EXTRACT_REQUIREMENTS_PROMPT },
          { role: 'user', content: `Extract requirements from: "${topic}"` }
        ],
        temperature: 0,
        top_p: 0.01
      }),
      { label: 'extractRequirements' }
    );

    const text = completion.choices[0]?.message?.content || '';
    console.log(`[requirementChecker] Raw extractRequirements response: ${text.slice(0, 500)}`);

    const parsed = robustJsonParse(text);

    if (parsed && Array.isArray(parsed.requirements) && parsed.requirements.length > 0) {
      console.log(`[requirementChecker] Extracted ${parsed.requirements.length} requirements`);
      return parsed.requirements;
    }

    console.warn(`[requirementChecker] No requirements parsed`);
  } catch (error) {
    console.warn(`[requirementChecker] Failed to extract requirements: ${error.message}`);
  }

  return [];
}

// ─── Step 2: Check entities against requirements (hybrid) ───

export async function checkRequirements(rows, columns, requirements) {
  if (requirements.length === 0) {
    return rows;
  }

  // Build entity data summaries
  const entitiesSummary = rows.map((row) => {
    const obj = {};
    for (const col of columns) {
      obj[col] = row.cells[col]?.value || null;
    }
    return obj;
  });

  // Phase 1: Check numeric requirements programmatically
  // Phase 2: Collect text requirements for LLM batch check
  const resultGrid = rows.map(() => new Array(requirements.length).fill(null));
  const textChecks = []; // items that need LLM

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const entityData = entitiesSummary[rowIdx];

    for (let reqIdx = 0; reqIdx < requirements.length; reqIdx++) {
      const req = requirements[reqIdx];
      const cellValue = findCellValue(req.field, entityData, columns);

      // Numeric: try programmatic check (needs a specific cell value)
      if (req.operator === 'greater_than' || req.operator === 'less_than') {
        if (!cellValue) {
          resultGrid[rowIdx][reqIdx] = {
            satisfied: false,
            closeness: 0.3,
            reason: `No data available for ${req.field}`
          };
          continue;
        }

        const result = checkNumericRequirement(req.operator, cellValue, req.value);
        if (result) {
          resultGrid[rowIdx][reqIdx] = result;
          continue;
        }
        // If parsing failed, fall through to LLM
      }

      // Text-based: ALWAYS send to LLM with full entity data
      textChecks.push({
        entity_index: rowIdx,
        requirement_index: reqIdx,
        entity_name: entityData.name || `Entity ${rowIdx}`,
        entity_data: entityData,
        requirement: req.description,
        check: `Given this entity's data: ${JSON.stringify(entityData)}, does it satisfy: "${req.description}"?`
      });
    }
  }

  // Phase 2: Send all text checks to LLM in one call
  if (textChecks.length > 0) {
    console.log(`[requirementChecker] Sending ${textChecks.length} text checks to LLM`);
    const llmResults = await checkTextRequirementsWithLlm(textChecks);

    for (const result of llmResults) {
      const rowIdx = result.entity_index;
      const reqIdx = result.requirement_index;
      if (rowIdx != null && reqIdx != null && resultGrid[rowIdx]) {
        resultGrid[rowIdx][reqIdx] = {
          satisfied: result.satisfied === true,
          closeness: typeof result.closeness === 'number' ? result.closeness : (result.satisfied ? 1.0 : 0.0),
          reason: result.reason || ''
        };
      }
    }
  }

  // Fill any remaining nulls (LLM didn't return a result for some)
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    for (let reqIdx = 0; reqIdx < requirements.length; reqIdx++) {
      if (!resultGrid[rowIdx][reqIdx]) {
        resultGrid[rowIdx][reqIdx] = {
          satisfied: false,
          closeness: 0.3,
          reason: `Could not verify: ${requirements[reqIdx].description}`
        };
      }
    }
  }

  // Build scored rows
  const scoredRows = rows.map((row, rowIdx) => {
    const results = resultGrid[rowIdx];
    const satisfiedCount = results.filter((r) => r.satisfied).length;
    const closenessAvg = results.reduce((sum, r) => sum + r.closeness, 0) / Math.max(results.length, 1);

    const detailSummary = results
      .map((d, i) => `${d.satisfied ? '✅' : '❌'} ${requirements[i]?.description || `Req ${i + 1}`}`)
      .join('; ');

    return {
      ...row,
      requirementScore: satisfiedCount,
      closenessScore: Math.round(closenessAvg * 100) / 100,
      totalRequirements: requirements.length,
      requirementDetails: results,
      cells: {
        ...row.cells,
        requirements_met: {
          value: `${satisfiedCount}/${requirements.length}`,
          sources: []
        },
        requirement_details: {
          value: detailSummary || 'No evaluation available',
          sources: []
        }
      }
    };
  });

  // ─── Tiered sorting ───
  const fullMatch = [];
  const partialMatch = [];
  const noMatch = [];

  for (const row of scoredRows) {
    if (row.requirementScore === requirements.length) {
      row.matchTier = 'full';
      fullMatch.push(row);
    } else if (row.requirementScore > 0) {
      row.matchTier = 'partial';
      partialMatch.push(row);
    } else {
      row.matchTier = 'none';
      noMatch.push(row);
    }
  }

  const sortWithinTier = (arr) => arr.sort((a, b) => {
    if (b.requirementScore !== a.requirementScore) {
      return b.requirementScore - a.requirementScore;
    }
    if (b.closenessScore !== a.closenessScore) {
      return b.closenessScore - a.closenessScore;
    }
    return b.confidence - a.confidence;
  });

  sortWithinTier(fullMatch);
  sortWithinTier(partialMatch);
  sortWithinTier(noMatch);

  const ranked = [
    ...fullMatch,
    ...partialMatch,
    ...noMatch
  ];

  console.log(`[requirementChecker] Ranked: ${fullMatch.length} full, ${partialMatch.length} partial, ${noMatch.length} none`);
  return ranked;
}