import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  buildAgentPrompt,
  detectInjectionAttempt,
  fenceUntrusted,
  type ChatTurn,
} from '@email-client/shared';
import { AiService, type UpstreamChatBody } from '../ai/ai.service';
import { PrismaService } from '../prisma/prisma.service';
import { consumeAgentStream, type UpstreamToolCall } from './upstream-stream';
import { summarizeArgs } from './summarize-args';
import { ToolRegistry, ToolValidationError, type ToolContext } from './tool-registry';

const MAX_ITERATIONS = 8;
const MAX_CALLS_PER_ITERATION = 3;
const WALL_CLOCK_MS = 60_000;

export type EmitFn = (event: string | null, data: unknown) => void;

interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

@Injectable()
export class AgentService {
  private readonly chatModel = process.env.CHAT_MODEL ?? 'qwen3-30b-16k:latest';

  constructor(
    private readonly ai: AiService,
    private readonly registry: ToolRegistry,
    private readonly prisma: PrismaService,
  ) {}

  async run(userId: string, turns: ChatTurn[], emit: EmitFn, signal: AbortSignal): Promise<void> {
    // The User model has no `name` field (only `email` + `displayName`, and
    // AskService's precedent selects `email` only) — select just `email`
    // and pass `userName: null` into buildAgentPrompt.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const turnId = randomUUID();
    const startedAt = Date.now();
    let aliasCount = 0;
    const ctx: ToolContext = {
      userId,
      userEmail: user?.email ?? '',
      nextAlias: () => `s${++aliasCount}`,
      emitChart: (spec) => emit('chart', spec),
    };

    const transcript: AgentMessage[] = [
      {
        role: 'system',
        content: buildAgentPrompt({
          userEmail: user?.email ?? '',
          userName: null,
          nowIso: new Date().toISOString(),
        }),
      },
      ...turns.slice(-12).map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }) as AgentMessage),
    ];

    for (let iter = 1; iter <= MAX_ITERATIONS + 1; iter++) {
      if (signal.aborted) return;
      const finalIteration = iter > MAX_ITERATIONS || Date.now() - startedAt > WALL_CLOCK_MS;
      if (finalIteration) {
        transcript.push({ role: 'user', content: 'Answer now with what you have. Do not call any more tools.' });
      }

      const body: UpstreamChatBody = {
        model: this.chatModel,
        messages: transcript as unknown as Array<Record<string, unknown>>,
        stream: true,
        temperature: 0.2,
        max_tokens: 1024,
        ...(finalIteration ? {} : { tools: this.registry.openAiTools(), tool_choice: 'auto' as const }),
      } as UpstreamChatBody;

      const upstream = await this.ai.upstream(body, signal);
      const result = await consumeAgentStream(upstream, (delta) =>
        emit(null, { choices: [{ delta: { content: delta } }] }),
      );

      if (!result.toolCalls.length || finalIteration) return;

      transcript.push({
        role: 'assistant',
        content: result.text,
        tool_calls: result.toolCalls.map((c, i) => ({
          id: c.id || `call_${iter}_${i}`,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      const calls = result.toolCalls.slice(0, MAX_CALLS_PER_ITERATION);
      for (const [i, call] of calls.entries()) {
        const callId = call.id || `call_${iter}_${i}`;
        const content = await this.dispatch(call, callId, ctx, turnId, emit);
        transcript.push({ role: 'tool', tool_call_id: callId, content });
      }
    }
  }

  private async dispatch(
    call: UpstreamToolCall,
    callId: string,
    ctx: ToolContext,
    turnId: string,
    emit: EmitFn,
  ): Promise<string> {
    const def = this.registry.get(call.name);
    if (!def) {
      emit('tool_result', { id: callId, ok: false, summary: `Unknown tool ${call.name}`, refs: [] });
      return `Error: unknown tool "${call.name}".`;
    }

    let args: unknown;
    try {
      args = this.registry.parseArgs(call.name, call.arguments);
    } catch (err: any) {
      emit('tool_start', { id: callId, tool: call.name, argsSummary: '(invalid arguments)' });
      emit('tool_result', { id: callId, ok: false, summary: 'Invalid arguments', refs: [] });
      return `Error: ${err instanceof ToolValidationError ? err.message : 'invalid arguments'}`;
    }

    emit('tool_start', { id: callId, tool: call.name, argsSummary: summarizeArgs(call.name, args) });
    const started = Date.now();

    if (def.mode === 'write-gated') {
      const proposalId = randomUUID();
      emit('proposal', { proposalId, tool: call.name, args, summary: summarizeArgs(call.name, args) });
      emit('tool_result', { id: callId, ok: true, summary: 'Proposal shown for approval', refs: [] });
      await this.log(ctx.userId, turnId, call.name, args, true, Date.now() - started);
      return 'A proposal card for this action has been shown to the user; it executes only if they approve. Do not call this tool again for the same action. Tell the user it is ready for their approval.';
    }

    try {
      const res = await def.execute(args as any, ctx);
      const clipped =
        res.content.length > def.resultBudget
          ? `${res.content.slice(0, def.resultBudget)}\n[truncated]`
          : res.content;
      const injectionSuspected = detectInjectionAttempt(clipped);
      emit('tool_result', {
        id: callId, ok: true, summary: res.summary, refs: res.refs ?? [], injectionSuspected,
      });
      await this.log(ctx.userId, turnId, call.name, args, true, Date.now() - started);
      return fenceUntrusted(`TOOL_${call.name.toUpperCase()}`, clipped);
    } catch (err: any) {
      const message = String(err?.message ?? 'tool failed').slice(0, 200);
      emit('tool_result', { id: callId, ok: false, summary: message, refs: [] });
      await this.log(ctx.userId, turnId, call.name, args, false, Date.now() - started);
      return `Error executing ${call.name}: ${message}`;
    }
  }

  private async log(
    userId: string,
    turnId: string,
    tool: string,
    args: unknown,
    ok: boolean,
    durationMs: number,
  ): Promise<void> {
    try {
      await this.prisma.agentToolLog.create({
        data: { userId, turnId, tool, argsJson: args as any, ok, durationMs },
      });
    } catch {
      // the audit log must never break the stream
    }
  }
}
