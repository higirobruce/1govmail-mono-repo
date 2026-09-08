import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamAsk } from './ask';

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
  'event: sources\ndata: {"sources":[{"alias":"s1","type":"mail","id":"m1","title":"Budget","fromEmail":"f@x.rw","fromName":"Fin","date":"2026-09-01T08:00:00.000Z","injectionSuspected":false,"snippet":"Finance approved"}],"degraded":{"vector":false,"keyword":false,"docs":false,"calendar":false}}\n\n',
  'data: {"choices":[{"delta":{"content":"Finance approved it "}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"[s1]."}}]}\n\n',
  'data: [DONE]\n\n',
];

describe('streamAsk', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs /ai/ask with exactly {messages:[{role,content}]} and no scope key when scope is omitted', async () => {
    (authedFetch as any).mockResolvedValue(sseResponse(FRAMES));
    const turns = [{ role: 'user' as const, content: 'What about the budget?' }];
    await streamAsk(turns, { onSources: () => {}, onChunk: () => {} });

    const [path, init] = (authedFetch as any).mock.calls[0];
    expect(path).toBe('/ai/ask');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ messages: [{ role: 'user', content: 'What about the budget?' }] });
    expect(body.scope).toBeUndefined();
  });

  it('includes scope.docId in the body when a docId scope is passed', async () => {
    (authedFetch as any).mockResolvedValue(sseResponse(FRAMES));
    const turns = [{ role: 'user' as const, content: 'Summarize this doc' }];
    await streamAsk(turns, { scope: { docId: 'doc-42' }, onSources: () => {}, onChunk: () => {} });

    const [, init] = (authedFetch as any).mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.scope).toEqual({ docId: 'doc-42' });
  });

  it('omits the scope key when scope is explicitly null', async () => {
    (authedFetch as any).mockResolvedValue(sseResponse(FRAMES));
    await streamAsk([{ role: 'user', content: 'q' }], { scope: null, onSources: () => {}, onChunk: () => {} });

    const [, init] = (authedFetch as any).mock.calls[0];
    expect(JSON.parse(init.body).scope).toBeUndefined();
  });

  it('delivers typed sources from the sources event before any chunk, then streams deltas and resolves the full text', async () => {
    (authedFetch as any).mockResolvedValue(sseResponse(FRAMES));
    const order: string[] = [];
    const full = await streamAsk([{ role: 'user', content: 'q' }], {
      onSources: (sources, degraded) => {
        order.push('sources');
        expect(sources[0]).toMatchObject({ alias: 's1', type: 'mail', id: 'm1', title: 'Budget' });
        expect(degraded).toEqual({ vector: false, keyword: false, docs: false, calendar: false });
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
    const full = await streamAsk([{ role: 'user', content: 'q' }], {
      onSources: () => {}, onChunk: () => {},
    });
    expect(full).toBe('Finance approved it [s1].');
  });

  it('throws AIHttpError carrying the status on a non-OK response', async () => {
    (authedFetch as any).mockResolvedValue(sseResponse([], 429));
    await expect(
      streamAsk([{ role: 'user', content: 'q' }], { onSources: () => {}, onChunk: () => {} }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
