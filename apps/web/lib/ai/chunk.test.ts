import { describe, expect, it } from 'vitest';
import { chunkForEmbedding, EMBED_CHUNK_MAX_CHARS, EMBED_MAX_CHUNKS } from '@email-client/shared';

describe('chunkForEmbedding', () => {
  it('returns [] for an empty body', () => {
    expect(chunkForEmbedding({ bodyText: '', bodyHtml: null }, 'Subj')).toEqual([]);
  });

  it('produces one chunk for a short email, prefixed with the subject', () => {
    const chunks = chunkForEmbedding({ bodyText: 'Short update on the budget.', bodyHtml: null }, 'Budget');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Subject: Budget\nShort update on the budget.');
  });

  it('omits the subject prefix when subject is null', () => {
    const chunks = chunkForEmbedding({ bodyText: 'Hello there.', bodyHtml: null }, null);
    expect(chunks[0]).toBe('Hello there.');
  });

  it('splits on paragraph boundaries and respects the max chunk size', () => {
    const para = 'x'.repeat(900);
    // Three 900-char paragraphs: no two fit together under 1500, so each
    // paragraph becomes its own chunk — never split mid-paragraph.
    const body = [para, para, para].join('\n\n');
    const chunks = chunkForEmbedding({ bodyText: body, bodyHtml: null }, null);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(EMBED_CHUNK_MAX_CHARS);
    expect(chunks[0]).toBe(para); // paragraphs that fit are kept whole
  });

  it('packs consecutive paragraphs into one chunk while they fit', () => {
    const a = 'a'.repeat(400);
    const b = 'b'.repeat(400);
    const chunks = chunkForEmbedding({ bodyText: `${a}\n\n${b}`, bodyHtml: null }, null);
    expect(chunks).toEqual([`${a}\n\n${b}`]);
  });

  it('hard-splits a single paragraph longer than the chunk size into multiple chunks, respecting the cap', () => {
    // 2000 chars: should produce 2 chunks (1500 + 500)
    const chunks2k = chunkForEmbedding({ bodyText: 'y'.repeat(2000), bodyHtml: null }, null);
    expect(chunks2k.length).toBe(2);
    expect(chunks2k[0].length).toBe(EMBED_CHUNK_MAX_CHARS);
    expect(chunks2k[1].length).toBe(500);
    expect(chunks2k.join('')).toBe('y'.repeat(2000));

    // Exactly 6000 chars (no spaces): should produce exactly 4 chunks of 1500 each
    const chunks6k = chunkForEmbedding({ bodyText: 'x'.repeat(6000), bodyHtml: null }, null);
    expect(chunks6k.length).toBe(EMBED_MAX_CHUNKS);
    for (let i = 0; i < EMBED_MAX_CHUNKS; i++) {
      expect(chunks6k[i].length).toBe(EMBED_CHUNK_MAX_CHARS);
    }
    expect(chunks6k.join('')).toBe('x'.repeat(6000));
  });

  it(`never returns more than ${EMBED_MAX_CHUNKS} chunks`, () => {
    const body = Array.from({ length: 20 }, () => 'z'.repeat(1400)).join('\n\n');
    expect(chunkForEmbedding({ bodyText: body, bodyHtml: null }, null).length).toBeLessThanOrEqual(EMBED_MAX_CHUNKS);
  });

  it('strips quoted history via extractEmailText (spends budget on the new message)', () => {
    const body = `The new content is here.\n\nOn Mon, Jan 5, 2026 at 9:00 AM Someone <s@x.rw> wrote:\n> old quoted text`;
    const chunks = chunkForEmbedding({ bodyText: body, bodyHtml: null }, null);
    expect(chunks.join(' ')).not.toContain('old quoted text');
  });
});
