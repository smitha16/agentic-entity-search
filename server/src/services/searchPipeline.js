// Orchestrates the full search pipeline. Infers the entity type and table
// columns, generates search queries via the LLM, searches the web, scrapes
// result pages, extracts structured entities, deduplicates them, and
// optionally reflects to decide if a follow-up iteration is needed.

import { buildQueryPlan } from './queryPlanner.js';
import { extractEntities } from './entityExtractor.js';
import { resolveEntities } from './entityResolver.js';
import { inferSchema } from './schemaBuilder.js';
import { searchWeb } from './searchProvider.js';
import { scrapeSearchResults } from './webScraper.js';
import { reflectOnResults } from './reflector.js';

const MAX_AGENT_ITERATIONS = 2;

// Runs the search pipeline synchronously, returning the final result object.
export async function runSearchPipeline({ topic, entityType, maxEntities = 10 }) {
  const startedAt = Date.now();

  // Step 1: LLM-driven schema inference
  const schema = await inferSchema(topic);
  const resolvedEntityType = entityType || schema.entityType;
  const columns = schema.columns;

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
      .slice(0, 8);
    const pages = await scrapeSearchResults(newUrls);
    allPages.push(...pages);

    // Step 5: Extract from chunks
    const extracted = await extractEntities({
      topic,
      entityType: resolvedEntityType,
      columns,
      pages
    });
    allExtracted.push(...extracted);

    // Step 6: Merge and dedupe
    const rows = resolveEntities(allExtracted, columns).slice(0, maxEntities);

    // Step 7: Reflect — should we iterate?
    if (iteration < MAX_AGENT_ITERATIONS - 1) {
      const reflection = await reflectOnResults({
        topic,
        entityType: resolvedEntityType,
        columns,
        rows,
        maxEntities
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

  const rows = resolveEntities(allExtracted, columns).slice(0, maxEntities);

  return {
    topic,
    entityType: resolvedEntityType,
    columns,
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

  // Step 1: LLM-driven schema inference
  emitStep('schema_inference', { message: 'Inferring schema...' });
  const schema = await inferSchema(topic);
  const resolvedEntityType = entityType || schema.entityType;
  const columns = schema.columns;
  emitStep('schema_complete', { schema });

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
      .slice(0, 8);
    const pages = await scrapeSearchResults(newUrls);
    allPages.push(...pages);
    emitStep('scrape_complete', { pagesScraped: pages.length });

    // Step 5: Extract from chunks
    emitStep('extracting_entities', { pageCount: pages.length, message: 'Extracting entities...' });
    const extracted = await extractEntities({
      topic,
      entityType: resolvedEntityType,
      columns,
      pages
    });
    allExtracted.push(...extracted);
    emitStep('extraction_complete', { entitiesExtracted: extracted.length });

    // Step 6: Merge and dedupe
    emitStep('deduplicating', { candidateCount: allExtracted.length, message: 'Deduplicating entities...' });
    const rows = resolveEntities(allExtracted, columns).slice(0, maxEntities);
    emitStep('dedup_complete', { uniqueEntities: rows.length });

    // Step 7: Reflect — should we iterate?
    if (iteration < MAX_AGENT_ITERATIONS - 1) {
      emitStep('reflecting', { message: 'Analyzing results for follow-up...' });
      const reflection = await reflectOnResults({
        topic,
        entityType: resolvedEntityType,
        columns,
        rows,
        maxEntities
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

  const rows = resolveEntities(allExtracted, columns).slice(0, maxEntities);

  const result = {
    topic,
    entityType: resolvedEntityType,
    columns,
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