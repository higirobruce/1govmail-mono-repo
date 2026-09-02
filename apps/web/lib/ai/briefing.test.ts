import { describe, it, expect } from 'vitest';
import { windowStart, selectWindowMessages, BRIEFING_MESSAGE_CAP } from './briefing';

const NOW = new Date('2026-09-02T14:00:00Z');
const msg = (id: string, hoursAgo: number, extra: Record<string, unknown> = {}) => ({
  id,
  conversationId: null,
  fromEmail: `${id}@x.rw`,
  fromName: null,
  subject: `s-${id}`,
  receivedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
  attachments: [],
  ...extra,
});

describe('windowStart', () => {
  it('24h is exactly one day back', () => {
    expect(windowStart('24h', NOW).toISOString()).toBe('2026-09-01T14:00:00.000Z');
  });
  it('week is seven days back', () => {
    expect(windowStart('week', NOW).toISOString()).toBe('2026-08-26T14:00:00.000Z');
  });
  it('today is local midnight', () => {
    const start = windowStart('today', NOW);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start <= NOW).toBe(true);
  });
});

describe('selectWindowMessages', () => {
  it('merges inbox and sent, tags direction, filters to window, sorts newest first', () => {
    const { selected, totalInWindow } = selectWindowMessages(
      [msg('in-old', 30), msg('in-new', 1)], [msg('sent-a', 2)], '24h', NOW,
    );
    expect(totalInWindow).toBe(2);
    expect(selected.map((m) => m.id)).toEqual(['in-new', 'sent-a']);
    expect(selected[0].direction).toBe('received');
    expect(selected[1].direction).toBe('sent');
  });

  it('caps at the limit but reports the true window total', () => {
    const many = Array.from({ length: 60 }, (_, i) => msg(`m${i}`, i / 10));
    const { selected, totalInWindow } = selectWindowMessages(many, [], '24h', NOW);
    expect(selected).toHaveLength(BRIEFING_MESSAGE_CAP);
    expect(totalInWindow).toBe(60);
  });

  it('formats attachment metadata strings', () => {
    const { selected } = selectWindowMessages(
      [msg('a', 1, { attachments: [{ id: '1', filename: 'memo.pdf', mimeType: 'application/pdf', size: 2_202_009 }] })],
      [], '24h', NOW,
    );
    expect(selected[0].attachments).toEqual(['memo.pdf (2.1MB)']);
  });

  it('tolerates malformed rows without throwing', () => {
    const { selected } = selectWindowMessages([{ junk: true }, msg('ok', 1)], [], '24h', NOW);
    expect(selected.map((m) => m.id)).toEqual(['ok']);
  });
});
