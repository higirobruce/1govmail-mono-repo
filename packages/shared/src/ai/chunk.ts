import { extractEmailText } from './extract';

export const EMBED_CHUNK_MAX_CHARS = 1500;
export const EMBED_MAX_CHUNKS = 4;
export const DOC_EMBED_MAX_CHUNKS = 12;

/**
 * Pack plain text into embedding-sized chunks. Paragraph boundaries (blank-line
 * separated) are kept whole where they fit (they carry meaning for dense
 * retrieval); a paragraph longer than the budget is split into consecutive
 * hard-cut slices. When `headerLine` is given, it's prefixed to chunk 0 as
 * `<headerLine>\n` so a header-only match (subject, title) still retrieves
 * the source. Output is capped at `maxChunks` chunks of at most
 * `EMBED_CHUNK_MAX_CHARS` characters each.
 */
export function chunkPlainText(text: string, headerLine: string | null, maxChunks: number): string[] {
  if (!text || !text.trim()) return [];

  const chunks: string[] = [];
  let current = '';
  for (const para of text.split(/\n{2,}/)) {
    if (chunks.length >= maxChunks) break;
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= EMBED_CHUNK_MAX_CHARS) {
      current = candidate;
      continue;
    }
    // Candidate doesn't fit
    if (current) {
      chunks.push(current);
      if (chunks.length >= maxChunks) break;
    }

    // If the paragraph itself exceeds budget, hard-split it into multiple chunks
    if (para.length > EMBED_CHUNK_MAX_CHARS) {
      let offset = 0;
      while (offset < para.length && chunks.length < maxChunks) {
        chunks.push(para.slice(offset, offset + EMBED_CHUNK_MAX_CHARS));
        offset += EMBED_CHUNK_MAX_CHARS;
      }
      current = '';
    } else {
      // Paragraph fits, make it current
      current = para;
    }
  }
  if (current && chunks.length < maxChunks) chunks.push(current);

  const prefix = headerLine ? `${headerLine}\n` : '';
  return chunks.slice(0, maxChunks).map((c, i) => {
    if (i !== 0 || !prefix) return c;
    return (prefix + c).slice(0, EMBED_CHUNK_MAX_CHARS + prefix.length);
  });
}

/**
 * Split one email into embedding-sized chunks. Chunk 0 carries the subject
 * line so a subject-only match ("the budget memo") still retrieves the message.
 */
export function chunkForEmbedding(
  input: { bodyText?: string | null; bodyHtml?: string | null },
  subject: string | null,
): string[] {
  const text = extractEmailText(input, { maxChars: EMBED_CHUNK_MAX_CHARS * EMBED_MAX_CHUNKS });
  if (!text) return [];
  return chunkPlainText(text, subject ? `Subject: ${subject}` : null, EMBED_MAX_CHUNKS);
}

/**
 * Split one document's plain text into embedding-sized chunks. Chunk 0 carries
 * the title so a title-only match still retrieves the document.
 */
export function chunkDocForEmbedding(text: string, title: string | null): string[] {
  return chunkPlainText(text, title ? `Title: ${title}` : null, DOC_EMBED_MAX_CHUNKS);
}
