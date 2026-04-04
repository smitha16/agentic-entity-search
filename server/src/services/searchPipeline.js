import { buildQueryPlan } from './queryPlanner.js';
import { extractEntities } from './entityExtractor.js';
import { resolveEntities } from './entityResolver.js';
import { inferEntityType, getColumnsForEntityType } from './schemaBuilder.js';
import { searchWeb } from './searchProvider.js';
import { scrapeSearchResults } from './webScraper.js';

export async function runSearchPipeline({ topic, entityType, maxEntities = 10 }) {
  const startedAt = Date.now();
  const resolvedEntityType = inferEntityType(topic, entityType);
  const columns = getColumnsForEntityType(resolvedEntityType);
  const queries = buildQueryPlan(topic, resolvedEntityType);
  const searchResults = await searchWeb(queries, 5);
  const pages = await scrapeSearchResults(searchResults.slice(0, 10));
  const extracted = await extractEntities({
    topic,
    entityType: resolvedEntityType,
    columns,
    pages: pages.slice(0, 4)
  });
  const rows = resolveEntities(extracted, columns).slice(0, maxEntities);

  return {
    topic,
    entityType: resolvedEntityType,
    columns,
    rows,
    meta: {
      queryVariants: queries,
      searchedResults: searchResults.length,
      processedPages: pages.length,
      extractedCandidates: extracted.length,
      deduplicatedEntities: rows.length,
      latencyMs: Date.now() - startedAt
    }
  };
}
