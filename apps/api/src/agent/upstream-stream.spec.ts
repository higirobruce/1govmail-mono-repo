import { consumeAgentJson, consumeAgentStream } from './upstream-stream';

function fakeSse(lines: string[]): any {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(encoder.encode(l + '\n'));
      c.close();
    },
  });
  return { body: stream };
}

const chunk = (obj: unknown) => `data: ${JSON.stringify({ choices: [obj] })}`;

describe('consumeAgentStream', () => {
  it('accumulates text and forwards deltas', async () => {
    const deltas: string[] = [];
    const res = await consumeAgentStream(
      fakeSse([chunk({ delta: { content: 'Hel' } }), chunk({ delta: { content: 'lo' } }), 'data: [DONE]']),
      (d) => deltas.push(d),
    );
    expect(res.text).toBe('Hello');
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(res.toolCalls).toEqual([]);
  });

  it('assembles fragmented tool calls by index', async () => {
    const res = await consumeAgentStream(
      fakeSse([
        chunk({ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search_emails', arguments: '{"que' } }] } }),
        chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"mou"}' } }] } }),
        chunk({ delta: {}, finish_reason: 'tool_calls' }),
        'data: [DONE]',
      ]),
      () => {},
    );
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'search_emails', arguments: '{"query":"mou"}' }]);
    expect(res.finishReason).toBe('tool_calls');
  });

  it('ignores malformed lines without throwing', async () => {
    const res = await consumeAgentStream(
      fakeSse(['data: {broken', ': keepalive comment', chunk({ delta: { content: 'ok' } }), 'data: [DONE]']),
      () => {},
    );
    expect(res.text).toBe('ok');
  });
});

describe('consumeAgentJson', () => {
  const jsonResponse = (body: unknown): any => ({ json: async () => body });

  it('maps a non-streamed completion with tool calls to the stream result shape', async () => {
    const res = await consumeAgentJson(
      jsonResponse({
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_documents', arguments: '{"query":"contract"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
      () => {},
    );
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'search_documents', arguments: '{"query":"contract"}' }]);
    expect(res.finishReason).toBe('tool_calls');
    expect(res.text).toBe('');
  });

  it('emits a content-only completion as one text delta', async () => {
    const deltas: string[] = [];
    const res = await consumeAgentJson(
      jsonResponse({ choices: [{ message: { content: 'Hello there' }, finish_reason: 'stop' }] }),
      (d) => deltas.push(d),
    );
    expect(res.text).toBe('Hello there');
    expect(deltas).toEqual(['Hello there']);
    expect(res.toolCalls).toEqual([]);
  });

  it('tolerates a malformed body without throwing', async () => {
    const res = await consumeAgentJson({ json: async () => { throw new Error('bad json'); } } as any, () => {});
    expect(res).toEqual({ text: '', toolCalls: [], finishReason: null });
  });
});
