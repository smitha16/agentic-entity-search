const defaultSchemas = {
  company: ['name', 'website', 'description', 'location', 'category'],
  restaurant: ['name', 'website', 'description', 'location', 'category'],
  tool: ['name', 'website', 'description', 'license', 'category']
};

export function inferEntityType(topic, providedType) {
  if (providedType) {
    return providedType.toLowerCase();
  }

  const text = topic.toLowerCase();

  if (text.includes('pizza') || text.includes('restaurant') || text.includes('food')) {
    return 'restaurant';
  }

  if (text.includes('tool') || text.includes('open source') || text.includes('database')) {
    return 'tool';
  }

  return 'company';
}

export function getColumnsForEntityType(entityType) {
  return defaultSchemas[entityType] || ['name', 'website', 'description', 'location', 'category'];
}
