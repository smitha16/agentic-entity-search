// server/src/config.js

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

// ─── CHANGED: now detects Gemini and Groq as well ───

function resolveLlmProvider() {
  if (process.env.LLM_PROVIDER) {
    return process.env.LLM_PROVIDER;
  }

  // Auto-detect based on which API key is present (order = priority)
  if (process.env.GEMINI_API_KEY) {
    return 'gemini';
  }

  if (process.env.GROQ_API_KEY) {
    return 'groq';
  }

  if (process.env.OPENAI_API_KEY && !process.env.LLM_API_KEY) {
    return 'openai';
  }

  return 'openai-compatible';
}

// ─── CHANGED: resolves the correct base URL per provider ───

function resolveLlmBaseUrl(provider) {
  // Explicit env var always wins
  if (process.env.LLM_BASE_URL) {
    return process.env.LLM_BASE_URL;
  }

  switch (provider) {
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta/openai/';
    case 'groq':
      return 'https://api.groq.com/openai/v1';
    case 'openai':
      return 'https://api.openai.com/v1';
    default:
      return 'https://openrouter.ai/api/v1';
  }
}

// ─── CHANGED: resolves the correct API key per provider ───

function resolveLlmApiKey(provider) {
  // Explicit LLM_API_KEY always wins
  if (process.env.LLM_API_KEY) {
    return process.env.LLM_API_KEY;
  }

  switch (provider) {
    case 'gemini':
      return process.env.GEMINI_API_KEY || '';
    case 'groq':
      return process.env.GROQ_API_KEY || '';
    case 'openai':
      return process.env.OPENAI_API_KEY || '';
    default:
      return process.env.OPENAI_API_KEY || '';
  }
}

// ─── CHANGED: resolves the correct default model per provider ───

function resolveLlmModel(provider) {
  // Explicit env var always wins
  if (process.env.LLM_MODEL) {
    return process.env.LLM_MODEL;
  }

  if (process.env.OPENAI_MODEL) {
    return process.env.OPENAI_MODEL;
  }

  switch (provider) {
    case 'gemini':
      return 'gemini-2.0-flash';
    case 'groq':
      return 'llama-3.3-70b-versatile';
    case 'openai':
      return 'gpt-4.1-mini';
    default:
      return 'qwen/qwen-2.5-72b-instruct';
  }
}

const llmProvider = resolveLlmProvider();

export const config = {
  port: Number(process.env.PORT || 4000),

  // Search
  searchProvider: resolveSearchProvider(),
  braveApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
  tavilyApiKey: process.env.TAVILY_API_KEY || process.env.SEARCH_API_KEY || '',

  // LLM — all resolved from the detected provider
  llmProvider,
  llmApiKey: resolveLlmApiKey(llmProvider),
  llmModel: resolveLlmModel(llmProvider),
  llmBaseUrl: resolveLlmBaseUrl(llmProvider),

  // ─── NEW: individual keys stored for multi-provider fallback ───
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  groqApiKey: process.env.GROQ_API_KEY || '',

  // OpenRouter-specific headers (kept for backward compat)
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