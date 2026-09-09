import { describe, expect, it, vi, beforeAll } from 'vitest';
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
      onStep, onStepResult, onProposal, onChart, onClarify: () => {}, onChunk: () => {},
    });
    expect(text).toBe('Answer');
    expect(onStep).toHaveBeenCalledWith(expect.objectContaining({ tool: 'echo' }));
    expect(onStepResult).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(onChart).toHaveBeenCalledWith(expect.objectContaining({ type: 'bar' }));
    expect(onProposal).not.toHaveBeenCalled();
    vi.doUnmock('../authed-fetch');
  });

  it('routes a clarify frame to onClarify', async () => {
    // The previous test cached ./agent with its own (already-consumed) mock —
    // reset the module graph so this test's mock is the one imported.
    vi.resetModules();
    const raw = [
      'event: clarify',
      'data: {"clarifyId":"q1","question":"Which document?","options":["Docs","Email attachment"]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    vi.doMock('../authed-fetch', () => ({ authedFetch: vi.fn().mockResolvedValue(sseResponse(raw)) }));
    const { streamAgent } = await import('./agent');

    const onClarify = vi.fn();
    await streamAgent([{ role: 'user', content: 'open the doc' }], {
      onStep: () => {}, onStepResult: () => {}, onProposal: () => {}, onChart: () => {},
      onClarify, onChunk: () => {},
    });
    expect(onClarify).toHaveBeenCalledWith({
      clarifyId: 'q1',
      question: 'Which document?',
      options: ['Docs', 'Email attachment'],
    });
    vi.doUnmock('../authed-fetch');
  });
});

describe('readEventSse robustness', () => {
  it('handles a data line split across two stream chunks', async () => {
    const encoder = new TextEncoder();
    const part1 = 'data: {"choices":[{"delta":{"con';
    const part2 = 'tent":"Hi"}}]}\n\ndata: [DONE]\n\n';
    const res = new Response(new ReadableStream({
      start(c) { c.enqueue(encoder.encode(part1)); c.enqueue(encoder.encode(part2)); c.close(); },
    }));
    const chunks: string[] = [];
    const text = await readEventSse(res, { onChunk: (d) => chunks.push(d) });
    expect(text).toBe('Hi');
  });

  it('does not misroute the next delta after an unparseable named-event payload', async () => {
    const raw = 'event: tool_start\ndata: {broken\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
    const events: string[] = [];
    const text = await readEventSse(new Response(raw), {
      onChunk: () => {},
      onEvent: (name) => events.push(name),
    });
    expect(text).toBe('ok');
    expect(events).toEqual([]);
  });
});

describe('streamAgent pinned context', () => {
  // Mirrors the vi.doMock('../authed-fetch') + dynamic import('./agent')
  // idiom from the 'streamAgent' describe block above, rather than
  // vi.stubGlobal('fetch', ...): streamAgent calls authedFetch (not bare
  // fetch), and this file already has a working seam for that call.
  const noopHandlers = {
    onStep: () => {},
    onStepResult: () => {},
    onProposal: () => {},
    onChart: () => {},
    onClarify: () => {},
    onChunk: () => {},
  };

  it('sends the pinned payload in the request body', async () => {
    vi.resetModules();
    let sentBody: any = null;
    vi.doMock('../authed-fetch', () => ({
      authedFetch: vi.fn(async (_path: string, init: any) => {
        sentBody = JSON.parse(init.body);
        return sseResponse('data: [DONE]\n\n');
      }),
    }));
    const { streamAgent } = await import('./agent');

    const pinned = { label: 'Re: RHEMIS', text: 'thread text', messageIds: ['m1'], toolScope: 'thread' as const };
    await streamAgent([{ role: 'user', content: 'hi' }], { ...noopHandlers, pinned });

    expect(sentBody.pinned).toEqual(pinned);
    expect(sentBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
    vi.doUnmock('../authed-fetch');
  });

  it('omits pinned from the body when not given', async () => {
    vi.resetModules();
    let sentBody: any = null;
    vi.doMock('../authed-fetch', () => ({
      authedFetch: vi.fn(async (_path: string, init: any) => {
        sentBody = JSON.parse(init.body);
        return sseResponse('data: [DONE]\n\n');
      }),
    }));
    const { streamAgent } = await import('./agent');

    await streamAgent([{ role: 'user', content: 'hi' }], { ...noopHandlers });

    expect('pinned' in sentBody).toBe(false);
    vi.doUnmock('../authed-fetch');
  });

  it('routes the pinned frame to onPinned', async () => {
    vi.resetModules();
    const onPinned = vi.fn();
    vi.doMock('../authed-fetch', () => ({
      authedFetch: vi.fn().mockResolvedValue(sseResponse(
        'event: pinned\ndata: {"included":6,"injectionSuspected":true}\n\ndata: [DONE]\n\n',
      )),
    }));
    const { streamAgent } = await import('./agent');

    await streamAgent([{ role: 'user', content: 'hi' }], { ...noopHandlers, onPinned });

    expect(onPinned).toHaveBeenCalledWith({ included: 6, injectionSuspected: true });
    vi.doUnmock('../authed-fetch');
  });
});

const src = (alias: string, flagged = false) =>
  ({ alias, type: 'mail', id: `id-${alias}`, title: 't', date: '2026-09-08', snippet: '', injectionSuspected: flagged }) as any;

describe('mergeSources', () => {
  // Dynamic import (not a static top-level import) so this module isn't
  // pulled into the registry ahead of the streamAgent tests above — those
  // rely on vi.doMock('../authed-fetch') being installed *before* './agent'
  // is first imported, or the mock never takes and a real fetch fires.
  let mergeSources: (prev: any[], incoming: any[]) => any[];
  beforeAll(async () => {
    ({ mergeSources } = await import('./agent'));
  });

  it('appends unseen aliases only', () => {
    const out = mergeSources([src('s1')], [src('s1'), src('s2')]);
    expect(out.map((s) => s.alias)).toEqual(['s1', 's2']);
  });
  it('upgrades the injection flag on a flagged repeat', () => {
    const out = mergeSources([src('s1')], [src('s1', true)]);
    expect(out[0].injectionSuspected).toBe(true);
  });
  it('returns the same reference when nothing changes', () => {
    const prev = [src('s1')];
    expect(mergeSources(prev, [src('s1')])).toBe(prev);
  });
  it('upgrades once when the same alias appears flagged twice in one incoming batch, without corrupting the array (no out[-1])', () => {
    const out = mergeSources([src('s1')], [src('s1', true), src('s1', true)]);
    expect(out.map((s) => s.alias)).toEqual(['s1']);
    expect(out[0].injectionSuspected).toBe(true);
    expect(out.length).toBe(1);
    expect(Object.keys(out)).toEqual(['0']);
    expect('-1' in out).toBe(false);
  });
});
