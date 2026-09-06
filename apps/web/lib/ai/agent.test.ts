import { describe, expect, it, vi } from 'vitest';
import { readEventSse } from './sse';

// NOTE: `new Response(new Blob([raw]))` doesn't work in this repo's Vitest
// jsdom environment — the global `Response` (undici) and global `Blob`
// (jsdom) come from different realms, so Response fails its internal
// instanceof check on the body and falls back to `String(blob)`
// ("[object Blob]") instead of the blob's actual bytes. A plain string body
// exercises the same ReadableStream/reader path without that mismatch.
function sseResponse(raw: string): Response {
  return new Response(raw, { status: 200 });
}

describe('readEventSse', () => {
  it('dispatches named events and accumulates default deltas', async () => {
    const events: Array<[string, any]> = [];
    const chunks: string[] = [];
    const raw = [
      'event: tool_start',
      'data: {"id":"c1","tool":"search_emails","argsSummary":"\\"mou\\""}',
      '',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      '',
      'event: proposal',
      'data: {"proposalId":"p1","tool":"send_email","args":{"to":["a@b.rw"]},"summary":"to a@b.rw"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const text = await readEventSse(sseResponse(raw), {
      onChunk: (d) => chunks.push(d),
      onEvent: (name, data) => events.push([name, data]),
    });
    expect(text).toBe('Hi');
    expect(events).toEqual([
      ['tool_start', { id: 'c1', tool: 'search_emails', argsSummary: '"mou"' }],
      ['proposal', { proposalId: 'p1', tool: 'send_email', args: { to: ['a@b.rw'] }, summary: 'to a@b.rw' }],
    ]);
    expect(chunks).toEqual(['Hi']);
  });
});

describe('streamAgent', () => {
  it('routes frames to the right callbacks', async () => {
    const raw = [
      'event: tool_start',
      'data: {"id":"c1","tool":"echo","argsSummary":"x"}',
      '',
      'event: tool_result',
      'data: {"id":"c1","ok":true,"summary":"done","refs":[]}',
      '',
      'event: chart',
      'data: {"type":"bar","title":"T","labels":["a"],"series":[{"name":"s","data":[1]}]}',
      '',
      'data: {"choices":[{"delta":{"content":"Answer"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.doMock('../authed-fetch', () => ({ authedFetch: vi.fn().mockResolvedValue(sseResponse(raw)) }));
    const { streamAgent } = await import('./agent');

    const onStep = vi.fn();
    const onStepResult = vi.fn();
    const onProposal = vi.fn();
    const onChart = vi.fn();
    const text = await streamAgent([{ role: 'user', content: 'go' }], {
      onStep, onStepResult, onProposal, onChart, onChunk: () => {},
    });
    expect(text).toBe('Answer');
    expect(onStep).toHaveBeenCalledWith(expect.objectContaining({ tool: 'echo' }));
    expect(onStepResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(onChart).toHaveBeenCalledWith(expect.objectContaining({ type: 'bar' }));
    expect(onProposal).not.toHaveBeenCalled();
    vi.doUnmock('../authed-fetch');
  });
});
