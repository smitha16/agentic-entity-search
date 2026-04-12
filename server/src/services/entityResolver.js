// Entity resolver service. Deduplicates extracted entities by matching on
// normalized website hostname or company name, merging their cells and sources.

// Strips common suffixes (Inc, LLC, etc.) and non-alphanumeric characters
// so that minor name variations map to the same key.
function normalizeName(value) {
  return value
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|company|co)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Extracts the hostname from a URL, removing the www prefix, for dedup matching.
function normalizeWebsite(value) {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return value.toLowerCase().trim();
  }
}

// Combines two source arrays, dropping duplicates by URL + snippet.
function mergeSources(existing = [], incoming = []) {
  const seen = new Set();
  const merged = [];

  for (const source of [...existing, ...incoming]) {
    const key = `${source.url}|${source.snippet}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(source);
  }

  return merged;
}

// Merges two cells, keeping the one with more sources and combining all sources.
function mergeCells(left, right) {
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  const leftSourceCount = left.sources?.length || 0;
  const rightSourceCount = right.sources?.length || 0;
  const preferred = rightSourceCount > leftSourceCount ? right : left;

  return {
    value: preferred.value,
    sources: mergeSources(left.sources, right.sources)
  };
}

// Groups entities by normalized key (website or name), merges duplicate rows,
// and returns the result sorted by confidence descending.
export function resolveEntities(entities, columns) {
  const buckets = new Map();

  for (const entity of entities) {
    const name = entity.cells.name?.value || '';
    const website = entity.cells.website?.value || '';
    const websiteKey = normalizeWebsite(website);
    const nameKey = normalizeName(name);

    // Check both keys so entities are merged even if one extraction
    // has a website and another doesn't
    const existingKey = (websiteKey && buckets.has(websiteKey)) ? websiteKey
      : (nameKey && buckets.has(nameKey)) ? nameKey
      : null;

    const key = existingKey || websiteKey || nameKey;

    if (!key) {
      continue;
    }

if (!existingKey) {
  const initialCells = {};
  for (const column of columns) {
    initialCells[column] = entity.cells[column] || null;
  }

  const bucket = {
    entity_id: (websiteKey || nameKey).replace(/[^a-z0-9]+/g, '-'),
    confidence: entity.confidence || 0.8,
    cells: initialCells
  };

  // Store under both keys so future extractions find it
  // regardless of whether they have a website or just a name
  if (websiteKey) buckets.set(websiteKey, bucket);
  if (nameKey) buckets.set(nameKey, bucket);
  continue;
}

    const current = buckets.get(key);
    current.confidence = Math.max(current.confidence, entity.confidence || 0.8);

    for (const column of columns) {
      current.cells[column] = mergeCells(current.cells[column], entity.cells[column] || null);
    }
  }

  return Array.from(new Set(buckets.values())).sort((a, b) => b.confidence - a.confidence);
}
