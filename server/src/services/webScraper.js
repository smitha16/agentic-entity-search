// Web scraper service. Fetches HTML from search result URLs, extracts the
// readable article text using Mozilla Readability (with a Cheerio fallback),
// and returns the cleaned text content for downstream entity extraction.

import * as cheerio from 'cheerio';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import pLimit from 'p-limit';

const scrapeLimit = pLimit(4);
const PAGE_FETCH_TIMEOUT_MS = 12000;

// Collapses whitespace sequences into a single space.
function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// Attempts to extract the main article text from HTML using Readability.
// Falls back to stripping scripts/styles and reading the full body text.
function extractReadableContent(html, url) {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();

  if (article?.textContent) {
    return {
      title: article.title || dom.window.document.title || url,
      content: cleanText(article.textContent)
    };
  }

  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  return {
    title: $('title').text().trim() || url,
    content: cleanText($('body').text())
  };
}

// Fetches a single page, extracts readable content, and truncates to 12k chars.
async function fetchPage(result) {
  const response = await fetch(result.url, {
    signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AgenticEntitySearch/1.0)'
    }
  });

  if (!response.ok) {
    throw new Error(`Fetch failed with status ${response.status}`);
  }

  const html = await response.text();
  const extracted = extractReadableContent(html, result.url);

  return {
    ...result,
    title: extracted.title || result.title,
    content: extracted.content.slice(0, 12000)
  };
}

// Scrapes all search results concurrently (up to 4 at a time), dropping pages
// that fail to load or have fewer than 300 characters of content.
export async function scrapeSearchResults(results) {
  const pages = await Promise.all(
    results.map((result) =>
      scrapeLimit(async () => {
        try {
          const page = await fetchPage(result);
          if (!page.content || page.content.length < 300) {
            return null;
          }
          return page;
        } catch {
          return null;
        }
      })
    )
  );

  return pages.filter(Boolean);
}
