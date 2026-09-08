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

// Non-streamed JSON completion, the shape iteration 1 consumes (the llama.cpp
// host ignores tool_choice:'required' under streaming, so iteration 1 is a
// plain completion).
function jsonResponse(message: any, finish = 'stop'): any {
  return { json: async () => ({ choices: [{ message, finish_reason: finish }] }) };
}
const jsonText = (s: string) => jsonResponse({ content: s });
const jsonToolCall = (name: string, args: string, id = 'c1') =>
  jsonResponse(
    { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] },
    'tool_calls',
  );

describe('AgentService.run', () => {
  it('a zero-tool first response is held back, nudged once, and the retried tool call proceeds', async () => {
    const { svc, ai, frames, emit } = makeService(
      [jsonText('Which document do you mean?'), jsonToolCall('echo', '{"message":"hi"}'), sseResponse([text('Done')])],
      [echoTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'summarize the document' }], emit, new AbortController().signal);

    // The withheld prose must never reach the client.
    const deltas = frames.filter((f) => f.event === null).map((f) => f.data.choices[0].delta.content);
    expect(deltas.join('')).not.toContain('Which document do you mean?');
    expect(deltas.join('')).toContain('Done');
    // The retry request carries the nudge and runs non-streamed like the first
    // probe. (messages is the live transcript array — shared by reference
    // across calls — so assert membership, not position.)
    const retryBody = ai.upstream.mock.calls[1][0];
    expect(retryBody.stream).toBe(false);
    const nudge = retryBody.messages.find((m: any) => m.role === 'user' && /ask_user/.test(m.content));
    expect(nudge).toBeTruthy();
    const withheld = retryBody.messages.find((m: any) => m.role === 'assistant' && m.content === 'Which document do you mean?');
    expect(withheld).toBeTruthy();
    expect(frames.some((f) => f.event === 'tool_start')).toBe(true);
  });

  it('a second zero-tool response is accepted and its text streamed', async () => {
    const { svc, ai, frames, emit } = makeService([jsonText('First try'), jsonText('You are welcome!')]);
    await svc.run('u1', [{ role: 'user', content: 'thanks' }], emit, new AbortController().signal);

    expect(ai.upstream).toHaveBeenCalledTimes(2);
    const deltas = frames.filter((f) => f.event === null).map((f) => f.data.choices[0].delta.content);
    expect(deltas).toEqual(['You are welcome!']);
  });

  it('runs iteration 1 non-streamed with tool_choice required, later iterations streamed with auto', async () => {
    const { svc, ai, emit } = makeService(
      [jsonToolCall('echo', '{"message":"hi"}'), sseResponse([text('Done')])],
      [echoTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);

    const first = ai.upstream.mock.calls[0][0];
    expect(first.stream).toBe(false);
    expect(first.tool_choice).toBe('required');
    const second = ai.upstream.mock.calls[1][0];
    expect(second.stream).toBe(true);
    expect(second.tool_choice).toBe('auto');
  });

  it('executes a read tool, fences the result, then answers', async () => {
    const { svc, ai, prisma, frames, emit } = makeService(
      [jsonToolCall('echo', '{"message":"hi"}'), sseResponse([text('Done')])],
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
        jsonResponse({ content: 'Let me check that.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"message":"hi"}' } }] }, 'tool_calls'),
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
      [jsonToolCall('send_email', '{"to":["a@b.rw"],"subject":"S","body":"B"}'), sseResponse([text('Ready.')])],
      [gated],
    );
    await svc.run('u1', [{ role: 'user', content: 'send it' }], emit, new AbortController().signal);
    const proposal = frames.find((f) => f.event === 'proposal');
    expect(proposal!.data).toMatchObject({ tool: 'send_email', args: { to: ['a@b.rw'], subject: 'S', body: 'B' } });
    expect(typeof proposal!.data.proposalId).toBe('string');
    expect(gated.execute).not.toHaveBeenCalled();
  });

  it('rejects citation-alias ids with a corrective error instead of executing the tool', async () => {
    const readTool: ToolDef = {
      name: 'read_document', description: 'read', mode: 'read', resultBudget: 100,
      schema: z.object({ docId: z.string() }),
      execute: jest.fn(),
    };
    const { svc, ai, frames, emit } = makeService(
      [jsonToolCall('read_document', '{"docId":"s2"}'), sseResponse([text('Recovered')])],
      [readTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);

    expect(readTool.execute).not.toHaveBeenCalled();
    expect(frames.find((f) => f.event === 'tool_result')!.data.ok).toBe(false);
    const toolMsg = ai.upstream.mock.calls[1][0].messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toMatch(/citation alias/);
    expect(toolMsg.content).toMatch(/search/i);
  });

  it('invalid args become a tool error message, loop continues', async () => {
    const { svc, ai, frames, emit } = makeService(
      [jsonToolCall('echo', '{"message":5}'), sseResponse([text('Recovered')])],
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
      [jsonToolCall('boom', '{}'), sseResponse([text('Recovered')])],
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
      [jsonResponse({ content: '', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) }, 'tool_calls'), sseResponse([text('Done')])],
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
    const loopy = Array.from({ length: 8 }, (_, i) =>
      i === 0 ? jsonToolCall('big', '{}', 'c0') : sseResponse([toolCall('big', '{}', `c${i}`)]),
    );
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
      [jsonToolCall('ask_user', '{"question":"Which document?","options":["Docs","Email attachment"]}')],
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

  it('strips [sN] citation aliases from clarify questions and options', async () => {
    const clarify: ToolDef = {
      name: 'ask_user', description: 'clarify', mode: 'clarify', resultBudget: 0,
      schema: z.object({ question: z.string(), options: z.array(z.string()).min(2).max(4) }),
      execute: jest.fn(),
    };
    const { svc, frames, emit } = makeService(
      [jsonToolCall('ask_user', '{"question":"Which doc [s1]?","options":["Untitled [s1]","Charter Test Notes [s2]"]}')],
      [clarify],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);

    const frame = frames.find((f) => f.event === 'clarify');
    expect(frame!.data.question).toBe('Which doc?');
    expect(frame!.data.options).toEqual(['Untitled', 'Charter Test Notes']);
  });

  it('only the first clarify in an iteration is emitted; the turn still ends', async () => {
    const clarify: ToolDef = {
      name: 'ask_user', description: 'clarify', mode: 'clarify', resultBudget: 0,
      schema: z.object({ question: z.string(), options: z.array(z.string()).min(2).max(4) }),
      execute: jest.fn(),
    };
    const { svc, ai, frames, emit } = makeService(
      [jsonResponse({ content: '', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'ask_user', arguments: '{"question":"Q1?","options":["a","b"]}' } },
        { id: 'c2', type: 'function', function: { name: 'ask_user', arguments: '{"question":"Q2?","options":["c","d"]}' } },
      ] }, 'tool_calls')],
      [clarify],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);

    const clarifies = frames.filter((f) => f.event === 'clarify');
    expect(clarifies).toHaveLength(1);
    expect(clarifies[0].data.question).toBe('Q1?');
    expect(ai.upstream).toHaveBeenCalledTimes(1);
  });

  const clarifyTool: ToolDef = {
    name: 'ask_user', description: 'clarify', mode: 'clarify', resultBudget: 0,
    schema: z.object({ question: z.string(), options: z.array(z.string()).min(2).max(4) }),
    execute: jest.fn(),
  };

  it('converts a question-shaped final answer after tool use into a clarify card', async () => {
    const { svc, ai, frames, emit } = makeService(
      [
        jsonToolCall('echo', '{"message":"hi"}'),
        sseResponse([text('I found A and B. Which one do you want?')]),
        jsonToolCall('ask_user', '{"question":"Which one do you want?","options":["A","B"]}', 'c9'),
      ],
      [echoTool, clarifyTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'summarize the document' }], emit, new AbortController().signal);

    const clarify = frames.find((f) => f.event === 'clarify');
    expect(clarify!.data).toMatchObject({ question: 'Which one do you want?', options: ['A', 'B'] });
    expect(ai.upstream).toHaveBeenCalledTimes(3);
    const convBody = ai.upstream.mock.calls[2][0];
    expect(convBody.stream).toBe(false);
    expect(convBody.tools).toHaveLength(1);
    expect(convBody.tools[0].function.name).toBe('ask_user');
  });

  it('converts a choose-one imperative ending (no question mark) into a clarify card', async () => {
    const { svc, frames, emit } = makeService(
      [
        jsonToolCall('echo', '{"message":"hi"}'),
        sseResponse([text('I found three documents. Please choose one.')]),
        jsonToolCall('ask_user', '{"question":"Which one?","options":["A","B"]}', 'c9'),
      ],
      [echoTool, clarifyTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'summarize the document' }], emit, new AbortController().signal);
    expect(frames.some((f) => f.event === 'clarify')).toBe(true);
  });

  it('strips (id …) tokens from clarify options alongside [sN] aliases', async () => {
    const { svc, frames, emit } = makeService(
      [jsonToolCall('ask_user', '{"question":"Which doc?","options":["Charter Test Notes (id cmtq41mi600hjz2eh0ukl3jxn)","Untitled [s1]"]}')],
      [clarifyTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);
    const frame = frames.find((f) => f.event === 'clarify');
    expect(frame!.data.options).toEqual(['Charter Test Notes', 'Untitled']);
  });

  it('coerces sloppy conversion args (extra options, overlong labels) into a valid clarify', async () => {
    const longLabel = 'Project Charter for Joint Technical Workshop on ILPD MIS-E-learning as LMS Integration Document';
    const { svc, frames, emit } = makeService(
      [
        jsonToolCall('echo', '{"message":"hi"}'),
        sseResponse([text('Please choose one.')]),
        jsonToolCall('ask_user', JSON.stringify({
          question: 'Which document?',
          options: ['A', 'B', 'C', 'D', 'E'].map((s, i) => (i === 0 ? longLabel : s)),
        }), 'c9'),
      ],
      [echoTool, clarifyTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'summarize the document' }], emit, new AbortController().signal);

    const frame = frames.find((f) => f.event === 'clarify');
    expect(frame).toBeTruthy();
    expect(frame!.data.options).toHaveLength(4);
    expect(frame!.data.options[0].length).toBeLessThanOrEqual(60);
  });

  it('does not convert a statement final answer', async () => {
    const { svc, ai, frames, emit } = makeService(
      [jsonToolCall('echo', '{"message":"hi"}'), sseResponse([text('Here is the summary.')])],
      [echoTool, clarifyTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);
    expect(ai.upstream).toHaveBeenCalledTimes(2);
    expect(frames.some((f) => f.event === 'clarify')).toBe(false);
  });

  it('a failed conversion is harmless — no clarify frame, no extra text emitted', async () => {
    const { svc, frames, emit } = makeService(
      [
        jsonToolCall('echo', '{"message":"hi"}'),
        sseResponse([text('Which one?')]),
        jsonText('I cannot call tools right now.'),
      ],
      [echoTool, clarifyTool],
    );
    await svc.run('u1', [{ role: 'user', content: 'go' }], emit, new AbortController().signal);
    expect(frames.some((f) => f.event === 'clarify')).toBe(false);
    const deltas = frames.filter((f) => f.event === null).map((f) => f.data.choices[0].delta.content);
    expect(deltas.join('')).not.toContain('I cannot call tools');
  });

  it('forces a final answer after MAX_ITERATIONS', async () => {
    const loopy = Array.from({ length: 8 }, (_, i) =>
      i === 0 ? jsonToolCall('echo', '{"message":"again"}', 'c0') : sseResponse([toolCall('echo', '{"message":"again"}', `c${i}`)]),
    );
    const { svc, ai, emit } = makeService([...loopy, sseResponse([text('Forced final')])], [echoTool]);
    await svc.run('u1', [{ role: 'user', content: 'loop' }], emit, new AbortController().signal);
    // 8 tool iterations + 1 forced-final call
    expect(ai.upstream).toHaveBeenCalledTimes(9);
    const lastBody = ai.upstream.mock.calls[8][0];
    expect(lastBody.tools).toBeUndefined();
  });
});
