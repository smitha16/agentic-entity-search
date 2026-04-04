// Text chunking utility. Splits long page content into overlapping chunks so
// that each fits within the LLM context window. Tries to break at sentence or
// paragraph boundaries to keep chunks coherent.

const DEFAULT_CHUNK_SIZE = 3000;  // characters (~750 tokens)
const DEFAULT_OVERLAP = 400;

// Splits a text string into overlapping chunks of roughly chunkSize characters.
export function chunkText(text, { chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP } = {}) {
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;

    // Try to break at a sentence or paragraph boundary
    if (end < text.length) {
      const slice = text.slice(end - 200, end + 200);
      const breakMatch = slice.match(/[.!?\n]\s/);
      if (breakMatch) {
        end = end - 200 + breakMatch.index + 1;
      }
    }

    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
  }

  return chunks;
}

// Chunks a page object and returns an array of page-like objects, each with
// its own chunk_id, chunkIndex, and totalChunks metadata.
export function chunkPage(page) {
  const chunks = chunkText(page.content);

  return chunks.map((text, index) => ({
    ...page,
    content: text,
    chunk_id: `${page.url}#chunk-${index}`,
    chunkIndex: index,
    totalChunks: chunks.length
  }));
}