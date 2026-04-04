import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import dotenv from 'dotenv';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '../..');
const candidateEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(repoRoot, '.env')
];

for (const envPath of candidateEnvPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

function resolveSearchProvider() {
  if (process.env.SEARCH_PROVIDER) {
    return process.env.SEARCH_PROVIDER;
  }

  if (process.env.TAVILY_API_KEY) {
    return 'tavily';
  }

  return 'brave';
}

function resolveLlmProvider() {
  if (process.env.LLM_PROVIDER) {
    return process.env.LLM_PROVIDER;
  }

  if (process.env.OPENAI_API_KEY && !process.env.LLM_API_KEY) {
    return 'openai';
  }

  return 'openai-compatible';
}

export const config = {
  port: Number(process.env.PORT || 4000),
  searchProvider: resolveSearchProvider(),
  braveApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
  tavilyApiKey: process.env.TAVILY_API_KEY || process.env.SEARCH_API_KEY || '',
  llmProvider: resolveLlmProvider(),
  llmApiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
  llmModel: process.env.LLM_MODEL || process.env.OPENAI_MODEL || 'qwen/qwen-2.5-72b-instruct',
  llmBaseUrl: process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1',
  openRouterSiteUrl: process.env.OPENROUTER_SITE_URL || '',
  openRouterAppName: process.env.OPENROUTER_APP_NAME || 'agentic-entity-search'
};

export function getSearchApiKey() {
  if (config.searchProvider === 'tavily') {
    return config.tavilyApiKey;
  }

  if (config.searchProvider === 'brave') {
    return config.braveApiKey;
  }

  return '';
}

export function hasSearchConfig() {
  return Boolean(getSearchApiKey());
}

export function hasLlmConfig() {
  return Boolean(config.llmApiKey);
}
