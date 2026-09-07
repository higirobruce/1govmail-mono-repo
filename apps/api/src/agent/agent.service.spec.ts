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
const multiToolCall = (calls: Array<{ name: string; args: string; id: string }>) => ({
  choices: [{
    delta: {
      tool_calls: calls.map((c, index) => ({ index, id: c.id, function: { name: c.name, arguments: c.args } })),
    },
    finish_reason: null,
  }],
});

function makeService(upstreamResponses: any[], tools: ToolDef[] = []) {
  const ai = { upstream: jest.fn() } as any;
  upstreamResponses.forEach((r) => ai.upstream.mockResolvedValueOnce(r));
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'u1@x.rw', displayName: 'Bruce' }) },
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

  it('emits a separator delta between an iteration preamble and the next iteration text', async () => {
    const { svc, frames, emit } = makeService(
      [
        sseResponse([text('Let me check that.'), toolCall('echo', '{"message":"hi"}')]),
        sseResponse([text('Here you go.')]),
      ],
      [echoTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);

    const contentDeltas = frames
      .filter((f) => f.event === null)
      .map((f) => f.data.choices[0].delta.content);
    expect(contentDeltas).toEqual(['Let me check that.', '\n\n', 'Here you go.']);
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
    expect(toolMsg.content).toContain('<<<'); // fenced, not raw
  });

  it('fences a tool execution error before it enters the transcript', async () => {
    const throwingTool: ToolDef = {
      name: 'boom', description: 'boom', mode: 'read', resultBudget: 100,
      schema: z.object({}),
      execute: jest.fn().mockRejectedValue(new Error('backend exploded')),
    };
    const { svc, ai, emit } = makeService(
      [sseResponse([toolCall('boom', '{}')]), sseResponse([text('Recovered')])],
      [throwingTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);
    const toolMsg = ai.upstream.mock.calls[1][0].messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toContain('<<<'); // fenced
    expect(toolMsg.content).toContain('Error executing boom');
    expect(toolMsg.content).toContain('backend exploded');
  });

  it('caps tool_calls at MAX_CALLS_PER_ITERATION so the assistant message and tool replies match', async () => {
    const calls = [
      { name: 'echo', args: '{"message":"a"}', id: 'c1' },
      { name: 'echo', args: '{"message":"b"}', id: 'c2' },
      { name: 'echo', args: '{"message":"c"}', id: 'c3' },
      { name: 'echo', args: '{"message":"d"}', id: 'c4' },
    ];
    const { svc, ai, emit } = makeService(
      [sseResponse([multiToolCall(calls)]), sseResponse([text('Done')])],
      [echoTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);

    const secondBody = ai.upstream.mock.calls[1][0];
    const assistantMsg = secondBody.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    const toolMsgs = secondBody.messages.filter((m: any) => m.role === 'tool');

    expect(assistantMsg.tool_calls).toHaveLength(3);
    expect(toolMsgs).toHaveLength(3);
    const assistantIds = assistantMsg.tool_calls.map((c: any) => c.id);
    const toolReplyIds = toolMsgs.map((m: any) => m.tool_call_id);
    expect(assistantIds).toEqual(['c1', 'c2', 'c3']);
    expect(toolReplyIds).toEqual(['c1', 'c2', 'c3']);
  });

  it('forces a final answer once the cumulative transcript budget is exceeded', async () => {
    const bigTool: ToolDef = {
      name: 'big', description: 'big', mode: 'read', resultBudget: 20_000,
      schema: z.object({}),
      execute: jest.fn().mockResolvedValue({ summary: 'big', content: 'x'.repeat(15_000), refs: [] }),
    };
    // Provide enough tool-call frames to exhaust MAX_ITERATIONS if the budget
    // never kicked in, plus one final text frame. Three ~15k-char tool
    // results (45k) blow past MAX_TRANSCRIPT_CHARS (35k) well before
    // iteration 8, so the budget — not the iteration cap — must be what
    // forces the final answer.
    const loopy = Array.from({ length: 8 }, (_, i) => sseResponse([toolCall('big', '{}', `c${i}`)]));
    const { svc, ai, emit } = makeService([...loopy, sseResponse([text('Forced by budget')])], [bigTool]);
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);

    expect(ai.upstream.mock.calls.length).toBeLessThan(9);
    const lastCallIndex = ai.upstream.mock.calls.length - 1;
    const lastBody = ai.upstream.mock.calls[lastCallIndex][0];
    expect(lastBody.tools).toBeUndefined();
    const nudge = lastBody.messages.find((m: any) => m.content === 'Answer now with what you have. Do not call any more tools.');
    expect(nudge).toBeTruthy();
  });

  it('clarify tool emits a clarify frame and ends the turn without another model call', async () => {
    const clarify: ToolDef = {
      name: 'ask_user', description: 'clarify', mode: 'clarify', resultBudget: 0,
      schema: z.object({ question: z.string(), options: z.array(z.string()).min(2).max(4) }),
      execute: jest.fn(),
    };
    const { svc, ai, frames, emit } = makeService(
      [sseResponse([toolCall('ask_user', '{"question":"Which document?","options":["Docs","Email attachment"]}')])],
      [clarify],
    );
    await svc.run('u1', [{ role: 'user', content: 'open the doc' }], emit, new AbortController().signal);

    const frame = frames.find((f) => f.event === 'clarify');
    expect(frame!.data).toMatchObject({
      question: 'Which document?',
      options: ['Docs', 'Email attachment'],
    });
    expect(typeof frame!.data.clarifyId).toBe('string');
    expect(ai.upstream).toHaveBeenCalledTimes(1);
    expect(clarify.execute).not.toHaveBeenCalled();
  });

  it('only the first clarify in an iteration is emitted; the turn still ends', async () => {
    const clarify: ToolDef = {
      name: 'ask_user', description: 'clarify', mode: 'clarify', resultBudget: 0,
      schema: z.object({ question: z.string(), options: z.array(z.string()).min(2).max(4) }),
      execute: jest.fn(),
    };
    const { svc, ai, frames, emit } = makeService(
      [sseResponse([multiToolCall([
        { name: 'ask_user', args: '{"question":"Q1?","options":["a","b"]}', id: 'c1' },
        { name: 'ask_user', args: '{"question":"Q2?","options":["c","d"]}', id: 'c2' },
      ])])],
      [clarify],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);

    const clarifies = frames.filter((f) => f.event === 'clarify');
    expect(clarifies).toHaveLength(1);
    expect(clarifies[0].data.question).toBe('Q1?');
    expect(ai.upstream).toHaveBeenCalledTimes(1);
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
