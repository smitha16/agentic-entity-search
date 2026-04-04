// server/services/chunker.js — NEW FILE

const DEFAULT_CHUNK_SIZE = 3000;  // characters (~750 tokens)
const DEFAULT_OVERLAP = 400;

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