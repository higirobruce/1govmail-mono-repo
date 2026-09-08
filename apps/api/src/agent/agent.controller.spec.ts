import { BadRequestException } from '@nestjs/common';
import { AgentController } from './agent.controller';

function makeRes() {
  const writes: string[] = [];
  return {
    writes,
    writableEnded: false,
    status: jest.fn(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    write: jest.fn((chunk: any) => {
      writes.push(String(chunk));
      return true;
    }),
    end: jest.fn(function (this: any) {
      this.writableEnded = true;
    }),
  } as any;
}

describe('AgentController', () => {
  it('rejects when last turn is not from the user', async () => {
    const controller = new AgentController({ run: jest.fn() } as any);
    await expect(
      controller.agent({ user: { sub: 'u1' } } as any, makeRes(), {
        messages: [{ role: 'assistant', content: 'x' }],
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('sets SSE headers, delegates to AgentService, terminates with [DONE]', async () => {
    const run = jest.fn(async (_u: string, _t: any, emit: any) => {
      emit('tool_start', { id: 'c1', tool: 'echo', argsSummary: 'x' });
      emit(null, { choices: [{ delta: { content: 'hi' } }] });
    });
    const controller = new AgentController({ run } as any);
    const res = makeRes();
    await controller.agent({ user: { sub: 'u1' } } as any, res, {
      messages: [{ role: 'user', content: 'go' }],
    } as any);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.writes.some((w: string) => w.startsWith('event: tool_start\n'))).toBe(true);
    expect(res.writes.some((w: string) => w.includes('"hi"'))).toBe(true);
    expect(res.writes[res.writes.length - 1]).toBe('data: [DONE]\n\n');
    expect(run).toHaveBeenCalledWith('u1', [{ role: 'user', content: 'go' }], expect.any(Function), expect.anything());
  });

  it('turns a service error into an error delta, still [DONE]', async () => {
    const controller = new AgentController({ run: jest.fn().mockRejectedValue(new Error('boom')) } as any);
    const res = makeRes();
    await controller.agent({ user: { sub: 'u1' } } as any, res, {
      messages: [{ role: 'user', content: 'go' }],
    } as any);
    expect(res.writes.some((w: string) => w.includes('boom'))).toBe(true);
    expect(res.writes[res.writes.length - 1]).toBe('data: [DONE]\n\n');
  });

  it('stays silent on an in-flight abort rejection: no error delta, stream still ends with [DONE]', async () => {
    // AgentService.run rejects with an AbortError when the abort lands mid
    // upstream call (as opposed to returning silently between iterations).
    // The controller must not surface this as an error delta.
    const run = jest.fn((_u: string, _t: any, _emit: any, signal: AbortSignal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const controller = new AgentController({ run } as any);
    const res = makeRes();
    let capturedCloseHandler: (() => void) | undefined;
    res.on = jest.fn((event: string, handler: () => void) => {
      if (event === 'close') capturedCloseHandler = handler;
    });

    const pending = controller.agent({ user: { sub: 'u1' } } as any, res, {
      messages: [{ role: 'user', content: 'go' }],
    } as any);

    // Simulate the client disconnecting mid-flight before the stream has ended.
    expect(capturedCloseHandler).toBeDefined();
    capturedCloseHandler!();

    await pending;

    expect(res.writes.some((w: string) => w.includes('Agent error'))).toBe(false);
    expect(res.writes.some((w: string) => w.includes('aborted'))).toBe(false);
    expect(res.writes[res.writes.length - 1]).toBe('data: [DONE]\n\n');
  });
});
