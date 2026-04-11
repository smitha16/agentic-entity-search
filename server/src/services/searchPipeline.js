// Orchestrates the full search pipeline. Infers the entity type first, then
// generates search queries, searches the web, scrapes result pages, infers
// table columns from the actual page content, extracts structured entities,
// deduplicates them, filters by entity type, checks requirements, and
// optionally reflects to decide if a follow-up iteration is needed.

import { buildQueryPlan } from './queryPlanner.js';
import { extractEntities } from './entityExtractor.js';
import { resolveEntities } from './entityResolver.js';
import { inferEntityType, inferColumns } from './schemaBuilder.js';
import { searchWeb } from './searchProvider.js';
import { scrapeSearchResults } from './webScraper.js';
import { reflectOnResults } from './reflector.js';
import { HttpError } from '../utils/httpError.js';
import { extractRequirements, checkRequirements } from './requirementChecker.js';

const MAX_AGENT_ITERATIONS = 2;
const NULL_COLUMN_THRESHOLD = 0.5;

// Removes columns where more than 50% of rows have null/missing values.
// Never prunes 'name' or columns that requirements reference.
function pruneEmptyColumns(columns, rows, requirements = []) {
  const requiredFields = new Set(requirements.map((r) => r.field?.toLowerCase()).filter(Boolean));

  return columns.filter((col) => {
    if (col === 'name') return true;

    // Don't prune columns that requirements depend on
    const colLower = col.toLowerCase();
    if (requiredFields.has(colLower)) return true;
    // Also check partial matches (e.g. requirement "location" matches column "headquarters")
    for (const field of requiredFields) {
      if (colLower.includes(field) || field.includes(colLower)) return true;
    }

    const nullCount = rows.filter((row) => !row.cells[col]?.value).length;
    return nullCount / Math.max(rows.length, 1) <= NULL_COLUMN_THRESHOLD;
  });
}

// Strips explicit constraints from the topic to create a broader search.
function broadenTopic(topic, requirements) {
  if (requirements.length === 0) return null;

  let broad = topic;

  const patterns = [
    /\bwith\s+(more|greater|less|fewer)\s+than\s+[\d$.,]+\s*(?:million|billion|[MBKmk])?\s*(?:in\s+)?\w*/gi,
    /\bwith\s+(?:at\s+least|over|under|above|below)\s+[\d$.,]+\s*(?:million|billion|[MBKmk])?\s*\w*/gi,
    /\bbased\s+in\s+(?:the\s+)?[\w\s]+$/gi,
    /\bin\s+the\s+(?:US|USA|United\s+States|UK|EU|Europe)\b/gi,
    /\bgreater\s+than\s+[\d$.,]+\s*(?:million|billion|[MBKmk])?\s*(?:funding|revenue|valuation)?\b/gi,
    /\bmore\s+than\s+[\d$.,]+\s*(?:million|billion|[MBKmk])?\s*(?:funding|revenue|valuation)?\b/gi,
  ];

  for (const pattern of patterns) {
    broad = broad.replace(pattern, '');
  }

  broad = broad.replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();

  if (broad.length < 5) return null;

  return broad;
}

// Filters out entities that are clearly not the expected type.
// Uses multiple signals: entity_type column, name vs location similarity, missing key data.
function filterByEntityType(rows, expectedType, columns) {
  const expected = expectedType.toLowerCase().trim();

  // Location-like entity types we want to filter when looking for companies etc.
  const locationTypes = ['location', 'city', 'state', 'country', 'region', 'area', 'place', 'neighborhood'];
  const isLookingForLocations = locationTypes.includes(expected);

  const filtered = rows.filter((row) => {
    const name = row.cells.name?.value || '';
    const nameLower = name.toLowerCase().trim();

    // Check 1: If entity_type column exists and is clearly wrong
    const entityTypeCell = row.cells.entity_type || row.cells.entityType || row.cells.type;
    if (entityTypeCell?.value) {
      const rowType = entityTypeCell.value.toLowerCase().trim();
      if (locationTypes.includes(rowType) && !isLookingForLocations) {
        console.log(`[searchPipeline] Filtering "${name}" — entity_type is "${rowType}"`);
        return false;
      }
    }

    // Check 2: Name matches a known location pattern (only when NOT looking for locations)
    if (!isLookingForLocations) {
      // Find location-related columns
      const locationCol = columns.find((c) =>
        c.toLowerCase().includes('location') || c.toLowerCase().includes('headquarters') ||
        c.toLowerCase().includes('city') || c.toLowerCase().includes('address')
      );
      const locationValue = locationCol ? (row.cells[locationCol]?.value || '') : '';
      const locationLower = locationValue.toLowerCase().trim();

      // If name IS the location (or very similar), it's probably a location entity
      if (locationLower && (
        locationLower.includes(nameLower) ||
        nameLower.includes(locationLower.split(',')[0].trim())
      )) {
        // Check: does this entity have ANY non-location data?
        // If it has funding, industry, description etc., it's probably real
        const hasSubstantiveData = columns.some((col) => {
          const colLower = col.toLowerCase();
          if (colLower === 'name' || colLower.includes('location') || colLower.includes('headquarters') ||
              colLower.includes('requirements') || colLower.includes('entity_type') || colLower.includes('type')) {
            return false;
          }
          return row.cells[col]?.value != null;
        });

        if (!hasSubstantiveData) {
          console.log(`[searchPipeline] Filtering "${name}" — name matches location, no other data`);
          return false;
        }
      }

      // Check 3: Known location patterns in name
      const locationPatterns = [
        /^(new york|los angeles|san francisco|chicago|boston|seattle|austin|miami|denver|atlanta)/i,
        /\b(bay area|metro area|metropolitan|county|district|borough)\b/i,
        /^(north|south|east|west|central)\s+(america|europe|asia|africa)/i
      ];

      const nameMatchesLocationPattern = locationPatterns.some((p) => p.test(name));
      if (nameMatchesLocationPattern) {
        // Double check — does it have funding or industry data?
        const fundingCol = columns.find((c) => c.toLowerCase().includes('funding') || c.toLowerCase().includes('amount') || c.toLowerCase().includes('raised'));
        const industryCol = columns.find((c) => c.toLowerCase().includes('industry') || c.toLowerCase().includes('sector') || c.toLowerCase().includes('category'));
        const hasFunding = fundingCol && row.cells[fundingCol]?.value;
        const hasIndustry = industryCol && row.cells[industryCol]?.value;

        // "San Francisco Bay Area" with industry "Tech" and funding "$11B" is suspicious
        // Real companies have specific industry names, not just "Tech"
        const genericIndustry = hasIndustry && ['tech', 'technology'].includes(row.cells[industryCol].value.toLowerCase().trim());

        if (!hasFunding || genericIndustry) {
          console.log(`[searchPipeline] Filtering "${name}" — looks like a location, not a ${expected}`);
          return false;
        }
      }
    }

    return true;
  });

  console.log(`[searchPipeline] Entity type filter: ${rows.length} → ${filtered.length} (removed ${rows.length - filtered.length})`);
  return filtered;
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

  // Step 1b: Extract requirements from the query
  emitStep('extracting_requirements', { message: 'Identifying requirements in query...' });
  const requirements = await extractRequirements(topic);
  emitStep('requirements_ready', {
    requirementCount: requirements.length,
    requirements: requirements.map((r) => r.description)
  });

  // Create a broader version of the topic for diverse search results
  const broadTopic = broadenTopic(topic, requirements);
  if (broadTopic) {
    console.log(`[searchPipeline] Broad topic: "${broadTopic}"`);
  }

  const resolvedMaxEntities = inference.requestedCount || maxEntities;

  let columns = null;
  let allExtracted = [];
  let allSearchResults = [];
  let allPages = [];
  let iterationQueries = [];

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration++) {
    emitStep('iteration_start', { iteration, maxIterations: MAX_AGENT_ITERATIONS });

    // Step 2: Query planning
    emitStep('planning_queries', { iteration, message: 'Planning search queries...' });
    let queries;

    if (iteration === 0) {
      const specificQueries = await buildQueryPlan(topic, resolvedEntityType);

      if (broadTopic) {
        const broadQueries = await buildQueryPlan(broadTopic, resolvedEntityType);
        queries = [
          ...specificQueries.slice(0, 4),
          ...broadQueries.slice(0, 1)
        ];
      } else {
        queries = specificQueries;
      }
    } else {
      queries = iterationQueries;
    }

    emitStep('queries_ready', { queries: queries.slice(0, 5) });

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

      // Ensure columns include fields referenced by requirements
      for (const req of requirements) {
        const field = req.field?.toLowerCase();
        if (!field) continue;
        const alreadyHas = columns.some((col) =>
          col.toLowerCase().includes(field) || field.includes(col.toLowerCase())
        );
        if (!alreadyHas) {
          columns.push(req.field);
          console.log(`[searchPipeline] Added requirement field "${req.field}" to columns`);
        }
      }

      emitStep('columns_ready', { columns });
    }

    // Step 6: Extract from chunks (use original topic so LLM extracts all relevant fields)
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

  // Use a higher internal limit to ensure diversity, trim to requested count at the end
  const internalMaxEntities = Math.max(resolvedMaxEntities * 2, 20);

  let rows = resolveEntities(allExtracted, columns).slice(0, internalMaxEntities);

  // Filter out entities with wrong type (e.g. locations when looking for companies)
  rows = filterByEntityType(rows, resolvedEntityType, columns);

  // Prune columns that are mostly empty (>50% null)
  let prunedColumns = pruneEmptyColumns(columns, rows, requirements);

  // Step 9: Check requirements and re-rank
  let rankedRows = rows;
  if (requirements.length > 0) {
    prunedColumns.push('requirements_met', 'requirement_details');

    emitStep('checking_requirements', {
      message: `Checking ${requirements.length} requirements against ${rows.length} entities...`
    });
    rankedRows = await checkRequirements(rows, prunedColumns, requirements);
    emitStep('requirements_checked', {
      message: 'Entities re-ranked by requirement satisfaction'
    });
  }

  const result = {
    topic,
    entityType: resolvedEntityType,
    columns: prunedColumns,
    rows: rankedRows,
    requirements,
    meta: {
      queryVariants: [...new Set(allSearchResults.map((r) => r.query))],
      searchedResults: allSearchResults.length,
      processedPages: allPages.length,
      extractedCandidates: allExtracted.length,
      deduplicatedEntities: rankedRows.length,
      requirementCount: requirements.length,
      latencyMs: Date.now() - startedAt
    }
  };

  emitStep('complete', { message: 'Pipeline complete', meta: result.meta });
  return result;
}