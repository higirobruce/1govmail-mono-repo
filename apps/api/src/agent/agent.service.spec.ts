import { z } from 'zod';
import { AgentService } from './agent.service';
import { ToolRegistry, type ToolDef } from './tool-registry';

function sseResponse(frames: any[]): any {
  const encoder = new TextEncoder();
  const lines = [...frames.map((f) => `data: ${JSON.stringify(f)}`), 'data: [DONE]'];
  return {
    body: new ReadableStream({
      start(c) {
        for (const l of lines) c.enqueue(encoder.encode(l + '\n'));
        c.close();
      },
    }),
  };
}

const text = (s: string) => ({ choices: [{ delta: { content: s } }] });
const toolCall = (name: string, args: string, id = 'c1') => ({
  choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] }, finish_reason: null }],
});

function makeService(upstreamResponses: any[], tools: ToolDef[] = []) {
  const ai = { upstream: jest.fn() } as any;
  upstreamResponses.forEach((r) => ai.upstream.mockResolvedValueOnce(r));
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'u1@x.rw', name: 'Bruce' }) },
    agentToolLog: { create: jest.fn().mockResolvedValue({}) },
  } as any;
  const svc = new AgentService(ai, registry, prisma);
  const frames: Array<{ event: string | null; data: any }> = [];
  const emit = (event: string | null, data: any) => frames.push({ event, data });
  return { svc, ai, prisma, frames, emit };
}

const echoTool: ToolDef = {
  name: 'echo', description: 'echo', mode: 'read', resultBudget: 100,
  schema: z.object({ message: z.string() }),
  execute: jest.fn().mockResolvedValue({ summary: 'echoed', content: 'ECHO RESULT', refs: [] }),
};

describe('AgentService.run', () => {
  it('streams a direct answer when no tools are called', async () => {
    const { svc, frames, emit } = makeService([sseResponse([text('Hello')])]);
    await svc.run('u1', [{ role: 'user', content: 'hi' }], emit, new AbortController().signal);
    expect(frames).toEqual([{ event: null, data: { choices: [{ delta: { content: 'Hello' } }] } }]);
  });

  it('executes a read tool, fences the result, then answers', async () => {
    const { svc, ai, prisma, frames, emit } = makeService(
      [sseResponse([toolCall('echo', '{"message":"hi"}')]), sseResponse([text('Done')])],
      [echoTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);

    const events = frames.map((f) => f.event);
    expect(events).toEqual(['tool_start', 'tool_result', null]);
    expect(frames[1].data).toMatchObject({ ok: true, summary: 'echoed' });

    // second upstream call carries the fenced tool result in a role:'tool' message
    const secondBody = ai.upstream.mock.calls[1][0];
    const toolMsg = secondBody.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toContain('ECHO RESULT');
    expect(toolMsg.content).toContain('<<<'); // fenced
    expect(prisma.agentToolLog.create).toHaveBeenCalledTimes(1);
  });

  it('gated tool emits a proposal and never executes', async () => {
    const gated: ToolDef = {
      name: 'send_email', description: 'g', mode: 'write-gated', resultBudget: 0,
      schema: z.object({ to: z.array(z.string()), subject: z.string(), body: z.string() }),
      execute: jest.fn(),
    };
    const { svc, frames, emit } = makeService(
      [sseResponse([toolCall('send_email', '{"to":["a@b.rw"],"subject":"S","body":"B"}')]), sseResponse([text('Ready.')])],
      [gated],
    );
    await svc.run('u1', [{ role: 'user', content: 'send it' }], emit, new AbortController().signal);
    const proposal = frames.find((f) => f.event === 'proposal');
    expect(proposal!.data).toMatchObject({ tool: 'send_email', args: { to: ['a@b.rw'], subject: 'S', body: 'B' } });
    expect(typeof proposal!.data.proposalId).toBe('string');
    expect(gated.execute).not.toHaveBeenCalled();
  });

  it('invalid args become a tool error message, loop continues', async () => {
    const { svc, ai, frames, emit } = makeService(
      [sseResponse([toolCall('echo', '{"message":5}')]), sseResponse([text('Recovered')])],
      [echoTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);
    expect(frames.find((f) => f.event === 'tool_result')!.data.ok).toBe(false);
    const toolMsg = ai.upstream.mock.calls[1][0].messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toMatch(/invalid arguments/);
  });

  it('forces a final answer after MAX_ITERATIONS', async () => {
    const loopy = Array.from({ length: 8 }, (_, i) =>
      sseResponse([toolCall('echo', '{"message":"again"}', `c${i}`)]),
    );
    const { svc, ai, emit } = makeService([...loopy, sseResponse([text('Forced final')])], [echoTool]);
    await svc.run('u1', [{ role: 'user', content: 'loop' }], emit, new AbortController().signal);
    // 8 tool iterations + 1 forced-final call
    expect(ai.upstream).toHaveBeenCalledTimes(9);
    const lastBody = ai.upstream.mock.calls[8][0];
    expect(lastBody.tools).toBeUndefined();
  });
});
