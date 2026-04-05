// Orchestrates the full search pipeline. Infers the entity type first, then
// generates search queries, searches the web, scrapes result pages, infers
// table columns from the actual page content, extracts structured entities,
// deduplicates them, and optionally reflects to decide if a follow-up
// iteration is needed.

import { buildQueryPlan } from './queryPlanner.js';
import { extractEntities } from './entityExtractor.js';
import { resolveEntities } from './entityResolver.js';
import { inferEntityType, inferColumns } from './schemaBuilder.js';
import { searchWeb } from './searchProvider.js';
import { scrapeSearchResults } from './webScraper.js';
import { reflectOnResults } from './reflector.js';
import { HttpError } from '../utils/httpError.js';

const MAX_AGENT_ITERATIONS = 2;
const NULL_COLUMN_THRESHOLD = 0.5;

// Removes columns where more than 50% of rows have null/missing values.
function pruneEmptyColumns(columns, rows) {
  return columns.filter((col) => {
    if (col === 'name') return true;
    const nullCount = rows.filter((row) => !row.cells[col]?.value).length;
    return nullCount / Math.max(rows.length, 1) <= NULL_COLUMN_THRESHOLD;
  });
}

// Runs the search pipeline as a single batch, returning the final result object.
export async function runSearchPipeline({ topic, entityType, maxEntities = 10 }) {
  const startedAt = Date.now();

  // Step 1: Validate topic and determine entity type in one LLM call
  const inference = entityType
    ? { valid: true, entityType }
    : await inferEntityType(topic);

  if (!inference.valid) {
    throw new HttpError(400, 'Please enter a research topic to search for, e.g. "AI startups in healthcare" or "best pizza places in NYC".');
  }

  const resolvedEntityType = inference.entityType;
  const resolvedMaxEntities = inference.requestedCount || maxEntities;

  let columns = null;
  let allExtracted = [];
  let allSearchResults = [];
  let allPages = [];
  let iterationQueries = [];

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
    // Step 2: Query planning (LLM-driven on first pass, reflection-driven on subsequent)
    const queries = iteration === 0
      ? await buildQueryPlan(topic, resolvedEntityType)
      : iterationQueries;

    // Step 3: Search
    const searchResults = await searchWeb(queries, 5);
    allSearchResults.push(...searchResults);

    // Step 4: Scrape
    const newUrls = searchResults
      .filter((r) => !allPages.some((p) => p.url === r.url))
      .slice(0, 5);
    const pages = await scrapeSearchResults(newUrls);
    allPages.push(...pages);

    // Step 5: Infer columns from actual page content (only on first iteration)
    if (!columns) {
      columns = await inferColumns(topic, resolvedEntityType, allPages);
    }

    // Step 6: Extract from chunks
    const extracted = await extractEntities({
      topic,
      entityType: resolvedEntityType,
      columns,
      pages
    });
    allExtracted.push(...extracted);

    // Step 7: Merge and dedupe
    const rows = resolveEntities(allExtracted, columns).slice(0, resolvedMaxEntities);

    // Step 8: Reflect, only if results are very sparse
    if (iteration < MAX_AGENT_ITERATIONS - 1) {
      const filledRatio = rows.reduce((sum, row) => {
        const filled = columns.filter((col) => row.cells[col]?.value).length;
        return sum + filled / columns.length;
      }, 0) / Math.max(rows.length, 1);

      if (rows.length >= 3 && filledRatio > 0.3) {
        break;
      }

      const reflection = await reflectOnResults({
        topic,
        entityType: resolvedEntityType,
        columns,
        rows,
        maxEntities: resolvedMaxEntities
      });

      if (reflection.satisfied) {
        break;
      }

      if (Array.isArray(reflection.followUpQueries) && reflection.followUpQueries.length > 0) {
        iterationQueries = reflection.followUpQueries.slice(0, 3);
        continue;
      }

      break;
    }
  }

  const rows = resolveEntities(allExtracted, columns).slice(0, resolvedMaxEntities);

  // Prune columns that are mostly empty (>50% null)
  const prunedColumns = pruneEmptyColumns(columns, rows);

  return {
    topic,
    entityType: resolvedEntityType,
    columns: prunedColumns,
    rows,
    meta: {
      queryVariants: [...new Set(allSearchResults.map((r) => r.query))],
      searchedResults: allSearchResults.length,
      processedPages: allPages.length,
      extractedCandidates: allExtracted.length,
      deduplicatedEntities: rows.length,
      latencyMs: Date.now() - startedAt
    }
  };
}

// Runs the search pipeline while emitting per-step progress events via the
// provided callback, suitable for SSE streaming to the client.
export async function runSearchPipelineWithEvents({ topic, entityType, maxEntities = 10 }, emitStep) {
  const startedAt = Date.now();

  // Step 1: Validate topic and determine entity type in one LLM call
  emitStep('schema_inference', { message: 'Validating topic and inferring entity type...' });
  const inference = entityType
    ? { valid: true, entityType }
    : await inferEntityType(topic);

  if (!inference.valid) {
    throw new HttpError(400, 'Please enter a research topic to search for, e.g. "AI startups in healthcare" or "best pizza places in NYC".');
  }

  const resolvedEntityType = inference.entityType;
  emitStep('entity_type_ready', { entityType: resolvedEntityType });

  const resolvedMaxEntities = inference.requestedCount || maxEntities;

  let columns = null;
  let allExtracted = [];
  let allSearchResults = [];
  let allPages = [];
  let iterationQueries = [];

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
    emitStep('iteration_start', { iteration, maxIterations: MAX_AGENT_ITERATIONS });

    // Step 2: Query planning (LLM-driven on first pass, reflection-driven on subsequent)
    emitStep('planning_queries', { iteration, message: 'Planning search queries...' });
    const queries = iteration === 0
      ? await buildQueryPlan(topic, resolvedEntityType)
      : iterationQueries;
    emitStep('queries_ready', { queries: queries.slice(0, 3) });

    // Step 3: Search
    emitStep('searching', { queryCount: queries.length, message: 'Searching the web...' });
    const searchResults = await searchWeb(queries, 5);
    allSearchResults.push(...searchResults);
    emitStep('search_complete', { resultsFound: searchResults.length });

    // Step 4: Scrape
    emitStep('scraping', { urlCount: searchResults.length, message: 'Scraping web pages...' });
    const newUrls = searchResults
      .filter((r) => !allPages.some((p) => p.url === r.url))
      .slice(0, 5);
    const pages = await scrapeSearchResults(newUrls);
    allPages.push(...pages);
    emitStep('scrape_complete', { pagesScraped: pages.length });

    // Step 5: Infer columns from actual page content (only on first iteration)
    if (!columns) {
      emitStep('inferring_columns', { message: 'Choosing table columns from page content...' });
      columns = await inferColumns(topic, resolvedEntityType, allPages);
      emitStep('columns_ready', { columns });
    }

    // Step 6: Extract from chunks
    emitStep('extracting_entities', { pageCount: pages.length, message: 'Extracting entities...' });
    const extracted = await extractEntities({
      topic,
      entityType: resolvedEntityType,
      columns,
      pages
    });
    allExtracted.push(...extracted);
    emitStep('extraction_complete', { entitiesExtracted: extracted.length });

    // Step 7: Merge and dedupe
    emitStep('deduplicating', { candidateCount: allExtracted.length, message: 'Deduplicating entities...' });
    const rows = resolveEntities(allExtracted, columns).slice(0, resolvedMaxEntities);
    emitStep('dedup_complete', { uniqueEntities: rows.length });

    // Step 8: Reflect, only if results are very sparse
    if (iteration < MAX_AGENT_ITERATIONS - 1) {
      const filledRatio = rows.reduce((sum, row) => {
        const filled = columns.filter((col) => row.cells[col]?.value).length;
        return sum + filled / columns.length;
      }, 0) / Math.max(rows.length, 1);

      if (rows.length >= 3 && filledRatio > 0.3) {
        emitStep('satisfied', { message: 'Results look good, skipping reflection.' });
        break;
      }

      emitStep('reflecting', { message: 'Analyzing results for follow-up...' });
      const reflection = await reflectOnResults({
        topic,
        entityType: resolvedEntityType,
        columns,
        rows,
        maxEntities: resolvedMaxEntities
      });
      emitStep('reflection_complete', { satisfied: reflection.satisfied });

      if (reflection.satisfied) {
        emitStep('satisfied', { message: 'Results are satisfactory, stopping.' });
        break;
      }

      if (Array.isArray(reflection.followUpQueries) && reflection.followUpQueries.length > 0) {
        iterationQueries = reflection.followUpQueries.slice(0, 3);
        emitStep('followup_queries', { queries: iterationQueries });
        continue;
      }

      break;
    }
  }

  const rows = resolveEntities(allExtracted, columns).slice(0, resolvedMaxEntities);

  // Prune columns that are mostly empty (>50% null)
  const prunedColumns = pruneEmptyColumns(columns, rows);

  const result = {
    topic,
    entityType: resolvedEntityType,
    columns: prunedColumns,
    rows,
    meta: {
      queryVariants: [...new Set(allSearchResults.map((r) => r.query))],
      searchedResults: allSearchResults.length,
      processedPages: allPages.length,
      extractedCandidates: allExtracted.length,
      deduplicatedEntities: rows.length,
      latencyMs: Date.now() - startedAt
    }
  };

  emitStep('complete', { message: 'Pipeline complete', meta: result.meta });
  return result;
}