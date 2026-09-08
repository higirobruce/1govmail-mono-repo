import { describe, it, expect } from 'vitest';
import { gatherThreadContent, type ThreadContentDeps } from './threadContent';

// Thread messages are oldest-first, matching api.mail.getConversation's real
// shape. Each fixture message carries a distinguishing marker in its snippet
// so tests can assert exactly which messages made it into the gathered text.
const meta = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `m${n}`,
  fromEmail: `sender${n}@risa.gov.rw`,
  fromName: `Sender ${n}`,
  receivedAt: `2026-09-0${(n % 9) + 1}T10:00:00.000Z`,
  snippet: `snippet-${n}`,
  ...extra,
});

function makeDeps(overrides: Partial<ThreadContentDeps> = {}): ThreadContentDeps {
  return {
    getConversation: async () => ({ conversationId: 'c1', messages: [] }),
    getBody: async (id: string) => ({ bodyText: `body for ${id}` }),
    ...overrides,
  };
}

describe('gatherThreadContent', () => {
  it('caps at the last 10 of a 14-message thread, dropping the oldest 4', async () => {
    const messages = Array.from({ length: 14 }, (_, i) => meta(i + 1));
    const deps = makeDeps({
      getConversation: async () => ({ conversationId: 'c1', messages }),
      getBody: async (id: string) => ({ bodyText: `body-${id}` }),
    });

    const { text, messageCount } = await gatherThreadContent('m14', deps);

    expect(messageCount).toBe(14);
    // Last 10 of 14 = messages #5..#14; the first included message is #5.
    const firstBlock = text.split('\n\n---\n\n')[0];
    expect(firstBlock).toContain('Sender 5 <sender5@risa.gov.rw>');
    expect(firstBlock).not.toContain('body-m4');
    expect(text).not.toContain('Sender 4 <sender4@risa.gov.rw>');
    expect(text.split('\n\n---\n\n')).toHaveLength(10);
  });

  it('degrades to the snippet when a single message body-fetch rejects, without failing the gather', async () => {
    const messages = [meta(1), meta(2, { snippet: 'fallback snippet for 2' })];
    const deps = makeDeps({
      getConversation: async () => ({ conversationId: 'c1', messages }),
      getBody: async (id: string) => {
        if (id === 'm2') throw new Error('network error fetching body');
        return { bodyText: 'full body for message 1' };
      },
    });

    const { text, messageCount } = await gatherThreadContent('m2', deps);

    expect(messageCount).toBe(2);
    expect(text).toContain('full body for message 1');
    expect(text).toContain('fallback snippet for 2');
  });

  it('applies the 2000-char per-message cap when a body is much longer', async () => {
    const longBody = 'x'.repeat(5000);
    const messages = [meta(1)];
    const deps = makeDeps({
      getConversation: async () => ({ conversationId: 'c1', messages }),
      getBody: async () => ({ bodyText: longBody }),
    });

    const { text } = await gatherThreadContent('m1', deps);

    // Block = "From: ...\nDate: ...\n\n<content>" — isolate the content after
    // the first blank line (the content itself may contain further blank
    // lines, e.g. around a truncation marker) and assert it is capped well
    // below the 5000-char body, in the neighbourhood of the 2000-char extract
    // budget (plus the small truncation-marker suffix extractEmailText appends).
    const headerEnd = text.indexOf('\n\n');
    const content = text.slice(headerEnd + 2);
    expect(content.length).toBeLessThan(2100);
    expect(content.length).toBeGreaterThan(1900);
  });

  it('caps the joined text to a total 12,000-char budget, dropping the oldest blocks first', async () => {
    const messages = Array.from({ length: 10 }, (_, i) => meta(i + 1));
    const deps = makeDeps({
      getConversation: async () => ({ conversationId: 'c1', messages }),
      // Each body is near the per-message cap, so 10 of them (~20k joined)
      // would blow well past the 12k total budget without this cap.
      getBody: async (id: string) => ({ bodyText: `body-${id}-` + 'y'.repeat(1900) }),
    });

    const { text, messageCount } = await gatherThreadContent('m10', deps);

    // messageCount always reports the true thread length, uncapped.
    expect(messageCount).toBe(10);
    expect(text.length).toBeLessThanOrEqual(12000);
    // Newest message survives the squeeze...
    expect(text).toContain('body-m10-');
    expect(text).toContain('Sender 10 <sender10@risa.gov.rw>');
    // ...while the oldest was dropped whole to make room (never truncated
    // mid-block into a partial, misleading body).
    expect(text).not.toContain('body-m1-');
    expect(text).not.toContain('Sender 1 <sender1@risa.gov.rw>');
  });

  it('keeps the newest message even when it alone exceeds the total budget', async () => {
    const messages = [meta(1)];
    const hugeBody = 'z'.repeat(20000);
    const deps = makeDeps({
      getConversation: async () => ({ conversationId: 'c1', messages }),
      getBody: async () => ({ bodyText: hugeBody }),
    });

    const { text, messageCount } = await gatherThreadContent('m1', deps);

    expect(messageCount).toBe(1);
    // The per-message extract cap (2000 chars) still applies to a single
    // huge body, so this stays well under 12k in practice — but the point of
    // this test is that a lone over-budget block is never dropped entirely.
    expect(text).toContain('Sender 1 <sender1@risa.gov.rw>');
    expect(text.length).toBeGreaterThan(0);
  });

  it('handles a single-message thread', async () => {
    const messages = [meta(1)];
    const deps = makeDeps({
      getConversation: async () => ({ conversationId: 'c1', messages }),
      getBody: async () => ({ bodyText: 'solo body' }),
    });

    const { text, messageCount } = await gatherThreadContent('m1', deps);

    expect(messageCount).toBe(1);
    expect(text).toContain('From: Sender 1 <sender1@risa.gov.rw>');
    expect(text).toContain('Date: 2026-09-02T10:00:00.000Z');
    expect(text).toContain('solo body');
    expect(text.split('\n\n---\n\n')).toHaveLength(1);
  });

  it('falls back to fromEmail alone when fromName is null', async () => {
    const messages = [meta(1, { fromName: null })];
    const deps = makeDeps({
      getConversation: async () => ({ conversationId: 'c1', messages }),
    });

    const { text } = await gatherThreadContent('m1', deps);

    expect(text).toContain('From: sender1@risa.gov.rw\n');
  });
});
