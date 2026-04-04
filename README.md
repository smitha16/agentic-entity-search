# Agentic Entity Search

A small full-stack project for the Agentic Search Challenge.

The app accepts a topic query such as `AI startups in healthcare`, searches the web, scrapes result pages, uses an LLM to extract structured entities, and returns a table where every value includes source evidence.

## Stack

- Server: Node.js, Express
- Client: React, Vite
- Search: Tavily API by default, Brave Search as an optional fallback
- Extraction: Qwen through an OpenAI-compatible API by default

## Why this version is simple

- Plain JavaScript instead of TypeScript
- One API route for the core workflow
- Minimal service split on the backend
- Basic frontend focused on table output and source traceability
- Clear environment requirements with no hidden setup

## Project structure

- `server/`: Express API and search pipeline
- `client/`: React frontend
- `.env.example`: template for local environment variables

## Environment variables

Create a local `.env` file from `.env.example`, then set these values:

- `SEARCH_PROVIDER` defaults to `tavily`
- `TAVILY_API_KEY` for the default free-tier search provider
- `LLM_PROVIDER` defaults to `openai-compatible`
- `LLM_API_KEY` for the default Qwen setup
- `LLM_BASE_URL` defaults to `https://openrouter.ai/api/v1`
- `LLM_MODEL` optional, defaults to `qwen/qwen-2.5-72b-instruct`
- `OPENROUTER_SITE_URL` optional, used as a header for OpenRouter
- `OPENROUTER_APP_NAME` optional, used as a header for OpenRouter
- `BRAVE_SEARCH_API_KEY` optional legacy fallback if you switch `SEARCH_PROVIDER=brave`
- `OPENAI_API_KEY` optional legacy fallback if you switch `LLM_PROVIDER=openai`
- `OPENAI_MODEL` optional legacy fallback, defaults to `gpt-4.1-mini`
- `PORT` optional, defaults to `4000`
- `VITE_API_URL` optional, defaults to `http://localhost:4000`

## API key setup

### Qwen via OpenRouter

1. Create an account at OpenRouter.
2. Open the Keys page and create a new API key.
3. Copy that key into `LLM_API_KEY`.
4. Keep `LLM_BASE_URL=https://openrouter.ai/api/v1`.
5. Start with `LLM_MODEL=qwen/qwen-2.5-72b-instruct`.

Example:

```bash
LLM_PROVIDER=openai-compatible
LLM_API_KEY=your_openrouter_key
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=qwen/qwen-2.5-72b-instruct
```

### Free search via Tavily

1. Create an account at Tavily.
2. Open the dashboard and generate an API key.
3. Copy that key into `TAVILY_API_KEY`.
4. Keep `SEARCH_PROVIDER=tavily`.

Example:

```bash
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=your_tavily_key
```

### Optional alternative: direct Qwen key

If you want to call Qwen directly instead of routing through OpenRouter, use an OpenAI-compatible Qwen endpoint such as DashScope and set:

```bash
LLM_PROVIDER=openai-compatible
LLM_API_KEY=your_qwen_provider_key
LLM_BASE_URL=your_qwen_openai_compatible_base_url
LLM_MODEL=qwen-turbo
```

## Install

```bash
npm install
```

## Run

```bash
npm run dev
```

This starts:

- Express API on `http://localhost:4000`
- React app on `http://localhost:5173`

## API

### `POST /api/search`

Request:

```json
{
  "topic": "AI startups in healthcare",
  "maxEntities": 10
}
```

Response shape:

```json
{
  "topic": "AI startups in healthcare",
  "entityType": "company",
  "columns": ["name", "website", "description", "location", "category"],
  "rows": [
    {
      "entity_id": "example-entity",
      "confidence": 0.91,
      "cells": {
        "name": {
          "value": "Example Entity",
          "sources": [
            {
              "url": "https://example.com",
              "title": "Example",
              "snippet": "Example Entity is ...",
              "chunk_id": "https://example.com#page",
              "confidence": 0.92
            }
          ]
        }
      }
    }
  ],
  "meta": {
    "queryVariants": [],
    "searchedResults": 0,
    "processedPages": 0,
    "extractedCandidates": 0,
    "deduplicatedEntities": 0,
    "latencyMs": 0
  }
}
```

## Design choices

- Search provider and extraction provider are isolated behind small service files.
- Every cell is returned as `{ value, sources }` to preserve traceability.
- The backend keeps processing conservative: it prefers empty values over unsupported facts.
- Deduplication is simple and readable: normalized website first, normalized name second.
- The LLM client is now configurable through OpenAI-compatible settings so Qwen and OpenAI can share the same integration path.

## Known limitations

- Free-tier providers can rate limit or rotate model availability.
- Some websites block scraping or return thin content.
- The dedupe logic is intentionally simple and may miss aliases.
- There is no database or cache in this first pass.

## Next improvements

- Add caching for search and page fetches
- Add retries and provider fallbacks
- Add chunk-level extraction instead of page-level extraction
- Add tests for merge rules and response schema
