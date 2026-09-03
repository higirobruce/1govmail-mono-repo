import { extractEmailText } from './extract';

export const EMBED_CHUNK_MAX_CHARS = 1500;
export const EMBED_MAX_CHUNKS = 4;

/**
 * Split one email into embedding-sized chunks. Paragraph boundaries are kept
 * whole where they fit (they carry meaning for dense retrieval); a paragraph
 * longer than the budget is hard-cut. Chunk 0 carries the subject line so a
 * subject-only match ("the budget memo") still retrieves the message.
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
    if (current) chunks.push(current);
    // A single paragraph over budget gets hard-cut; the remainder is dropped
    // (extractEmailText already clamped the total, so loss here is bounded).
    current = para.length > EMBED_CHUNK_MAX_CHARS ? para.slice(0, EMBED_CHUNK_MAX_CHARS) : para;
  }
  if (current && chunks.length < EMBED_MAX_CHUNKS) chunks.push(current);

  const prefix = subject ? `Subject: ${subject}\n` : '';
  return chunks.slice(0, EMBED_MAX_CHUNKS).map((c, i) => {
    if (i !== 0 || !prefix) return c;
    return (prefix + c).slice(0, EMBED_CHUNK_MAX_CHARS + prefix.length);
  });
}
