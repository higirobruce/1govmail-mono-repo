import { BadRequestException } from '@nestjs/common';
import { ChatController } from './chat.controller';

function fakeRes() {
  const writes: string[] = [];
  const res: any = {
    writableEnded: false,
    headers: {} as Record<string, string>,
    on: jest.fn(),
    setHeader: jest.fn((k: string, v: string) => { res.headers[k] = v; }),
    flushHeaders: jest.fn(),
    status: jest.fn().mockReturnThis(),
    write: jest.fn((chunk: any) => { writes.push(String(chunk)); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
    once: jest.fn(),
  };
  return { res, writes };
}

const req: any = { user: { sub: 'u1' } };

function sseUpstream(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true, value: undefined },
      }),
    },
  };
}

describe('ChatController.inboxChat', () => {
  it('rejects when the last turn is not from the user', async () => {
    const controller = new ChatController({} as any, {} as any);
    await expect(
      controller.inboxChat(req, fakeRes().res, { messages: [{ role: 'assistant', content: 'hi' }] } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('writes the sources event first, then pipes upstream bytes, on the SSE headers', async () => {
    const prepared = {
      sources: [{ alias: 's1', messageId: 'm1' }],
      degraded: { vector: false, keyword: false },
      upstreamBody: { model: 'x', messages: [], stream: true },
      noSourcesReply: null,
    };
    const inboxChat = { prepare: jest.fn().mockResolvedValue(prepared), chatModel: 'x' };
    const aiService = {
      upstream: jest.fn().mockResolvedValue(sseUpstream([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: [DONE]\n\n',
      ])),
    };
    const controller = new ChatController(inboxChat as any, aiService as any);
    const { res, writes } = fakeRes();

    await controller.inboxChat(req, res, { messages: [{ role: 'user', content: 'q' }] } as any);

    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(writes[0]).toContain('event: sources');
    expect(writes[0]).toContain('"alias":"s1"');
    expect(writes.join('')).toContain('"content":"Hello"');
    expect(writes.join('')).toContain('[DONE]');
    expect(res.end).toHaveBeenCalled();
  });

  it('does not write an error delta when the upstream failure is the client\'s own abort', async () => {
    const prepared = {
      sources: [{ alias: 's1', messageId: 'm1' }],
      degraded: { vector: false, keyword: false },
      upstreamBody: { model: 'x', messages: [], stream: true },
      noSourcesReply: null,
    };
    const inboxChat = { prepare: jest.fn().mockResolvedValue(prepared), chatModel: 'x' };
    let closeCb: (() => void) | undefined;
    const aiService = {
      upstream: jest.fn(async () => {
        closeCb?.(); // simulate the client disconnecting, which aborts the controller's signal
        throw new Error('The operation was aborted');
      }),
    };
    const controller = new ChatController(inboxChat as any, aiService as any);
    const { res, writes } = fakeRes();
    res.on = jest.fn((event: string, cb: () => void) => { if (event === 'close') closeCb = cb; });

    await controller.inboxChat(req, res, { messages: [{ role: 'user', content: 'q' }] } as any);

    const all = writes.join('');
    expect(all).not.toContain('AI backend error');
    expect(all).not.toContain('⚠');
    expect(res.end).toHaveBeenCalled();
  });

  it('emits the canned no-sources reply as a delta and [DONE] without calling the model', async () => {
    const prepared = {
      sources: [], degraded: { vector: false, keyword: false },
      upstreamBody: null, noSourcesReply: 'Nothing found.',
    };
    const inboxChat = { prepare: jest.fn().mockResolvedValue(prepared), chatModel: 'x' };
    const aiService = { upstream: jest.fn() };
    const controller = new ChatController(inboxChat as any, aiService as any);
    const { res, writes } = fakeRes();

    await controller.inboxChat(req, res, { messages: [{ role: 'user', content: 'q' }] } as any);

    expect(aiService.upstream).not.toHaveBeenCalled();
    const all = writes.join('');
    expect(all).toContain('Nothing found.');
    expect(all).toContain('[DONE]');
  });
});
