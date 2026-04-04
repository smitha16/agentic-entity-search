export function buildQueryPlan(topic, entityType) {
  const normalizedTopic = topic.trim();
  const queries = new Set([normalizedTopic]);

  if (entityType) {
    queries.add(`${normalizedTopic} ${entityType}`.trim());
  }

  queries.add(`best ${normalizedTopic}`);
  queries.add(`${normalizedTopic} companies`);
  queries.add(`${normalizedTopic} list`);

  return Array.from(queries).slice(0, 4);
}
