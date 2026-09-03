import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamInboxChat } from './inboxChat';

vi.mock('../authed-fetch', () => ({ authedFetch: vi.fn() }));
import { authedFetch } from '../authed-fetch';

function sseResponse(frames: string[], status = 200) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: status === 200,
    status,
    json: async () => ({ message: 'err' }),
    statusText: 'x',
    body: {
      getReader: () => ({
        read: async () =>
          i < frames.length ? { done: false, value: encoder.encode(frames[i++]) } : { done: true, value: undefined },
      }),
    },
  };
}

// EXACT frames the API controller writes (see chat.controller.ts) — the contract fixture.
const FRAMES = [
  'event: sources\ndata: {"sources":[{"alias":"s1","messageId":"m1","subject":"Budget","fromEmail":"f@x.rw","fromName":"Fin","receivedAt":"2026-09-01T08:00:00.000Z","injectionSuspected":false,"snippet":"Finance approved"}],"degraded":{"vector":false,"keyword":false}}\n\n',
  'data: {"choices":[{"delta":{"content":"Finance approved it "}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"[s1]."}}]}\n\n',
  'data: [DONE]\n\n',
];

describe('streamInboxChat', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs /ai/inbox-chat with exactly {messages:[{role,content}]} — the DTO contract', async () => {
    (authedFetch as any).mockResolvedValue(sseResponse(FRAMES));
    const turns = [{ role: 'user' as const, content: 'What about the budget?' }];
    await streamInboxChat(turns, { onSources: () => {}, onChunk: () => {} });

    const [path, init] = (authedFetch as any).mock.calls[0];
    expect(path).toBe('/ai/inbox-chat');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ messages: [{ role: 'user', content: 'What about the budget?' }] });
  });

  it('delivers the sources event before any chunk, then streams deltas and resolves the full text', async () => {
    (authedFetch as any).mockResolvedValue(sseResponse(FRAMES));
    const order: string[] = [];
    const full = await streamInboxChat([{ role: 'user', content: 'q' }], {
      onSources: (sources, degraded) => {
        order.push('sources');
        expect(sources[0]).toMatchObject({ alias: 's1', messageId: 'm1' });
        expect(degraded).toEqual({ vector: false, keyword: false });
      },
      onChunk: () => order.push('chunk'),
    });
    expect(order[0]).toBe('sources');
    expect(full).toBe('Finance approved it [s1].');
  });

  it('handles a sources event and deltas split across reads mid-frame', async () => {
    const joined = FRAMES.join('');
    const parts = [joined.slice(0, 60), joined.slice(60, 200), joined.slice(200)];
    (authedFetch as any).mockResolvedValue(sseResponse(parts));
    const full = await streamInboxChat([{ role: 'user', content: 'q' }], {
      onSources: () => {}, onChunk: () => {},
    });
    expect(full).toBe('Finance approved it [s1].');
  });

  it('throws AIHttpError carrying the status on a non-OK response', async () => {
    (authedFetch as any).mockResolvedValue(sseResponse([], 429));
    await expect(
      streamInboxChat([{ role: 'user', content: 'q' }], { onSources: () => {}, onChunk: () => {} }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
