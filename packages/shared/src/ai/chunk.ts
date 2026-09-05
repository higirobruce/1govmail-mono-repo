import { extractEmailText } from './extract';

export const EMBED_CHUNK_MAX_CHARS = 1500;
export const EMBED_MAX_CHUNKS = 4;

/**
 * Split one email into embedding-sized chunks. Paragraph boundaries are kept
 * whole where they fit (they carry meaning for dense retrieval); a paragraph
 * longer than the budget is split into consecutive hard-cut slices. Chunk 0
 * carries the subject line so a subject-only match ("the budget memo") still
 * retrieves the message.
 */
export function chunkForEmbedding(
  input: { bodyText?: string | null; bodyHtml?: string | null },
  subject: string | null,
): string[] {
  const text = extractEmailText(input, { maxChars: EMBED_CHUNK_MAX_CHARS * EMBED_MAX_CHUNKS });
  if (!text) return [];

  const chunks: string[] = [];
  let current = '';
  for (const para of text.split(/\n{2,}/)) {
    if (chunks.length >= EMBED_MAX_CHUNKS) break;
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= EMBED_CHUNK_MAX_CHARS) {
      current = candidate;
      continue;
    }
    // Candidate doesn't fit
    if (current) {
      chunks.push(current);
      if (chunks.length >= EMBED_MAX_CHUNKS) break;
    }

    // If the paragraph itself exceeds budget, hard-split it into multiple chunks
    if (para.length > EMBED_CHUNK_MAX_CHARS) {
      let offset = 0;
      while (offset < para.length && chunks.length < EMBED_MAX_CHUNKS) {
        chunks.push(para.slice(offset, offset + EMBED_CHUNK_MAX_CHARS));
        offset += EMBED_CHUNK_MAX_CHARS;
      }
      current = '';
    } else {
      // Paragraph fits, make it current
      current = para;
    }
  }
  if (current && chunks.length < EMBED_MAX_CHUNKS) chunks.push(current);

  const prefix = subject ? `Subject: ${subject}\n` : '';
  return chunks.slice(0, EMBED_MAX_CHUNKS).map((c, i) => {
    if (i !== 0 || !prefix) return c;
    return (prefix + c).slice(0, EMBED_CHUNK_MAX_CHARS + prefix.length);
  });
}
