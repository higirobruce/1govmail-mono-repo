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
import { consumeAgentJson, consumeAgentStream, type UpstreamToolCall } from './upstream-stream';
import { summarizeArgs } from './summarize-args';
import { ToolRegistry, ToolValidationError, type ToolContext } from './tool-registry';
import type { AgentPinnedDto } from './dto/agent.dto';
import { buildPinnedMessage, includedIn, pinnedIsSuspect, PINNED_FRAME } from './pinned-context';

const MAX_ITERATIONS = 8;
const MAX_CALLS_PER_ITERATION = 3;
const WALL_CLOCK_MS = 60_000;
// Injected when the first iteration answers without calling any tool. The
// Ollama host ignores tool_choice:'required' (verified live 2026-09-07 — even
// a single-tool request enforces nothing), so probe-first is enforced by this
// one-shot corrective retry instead. Conditional wording keeps greetings and
// meta questions answerable without a junk tool call.
const PROBE_NUDGE =
  'Do not answer yet. If this request needs anything from the user\'s mail, documents, calendar, tasks or people, call the right search/read tool NOW. If it is ambiguous, call ask_user with 2-4 options — never ask in plain text. Only if it truly needs none of that (a greeting or a question about this conversation) answer directly.';
// Cumulative transcript size (sum of all message content lengths) above which
// we force a final answer. A tool-heavy turn can otherwise exceed the 16k
// model context, and Ollama truncates oldest-first — silently dropping the
// system prompt's security mandates rather than erroring.
const MAX_TRANSCRIPT_CHARS = 35_000;

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

  // pinned is fenced into the transcript below (Task 9). Tool-scope
  // restriction from pinned.toolScope is not yet wired — that's Task 10.
  // Kept optional/defaulted so the controller's 5-arg call compiles without
  // every existing caller needing an update.
  async run(userId: string, turns: ChatTurn[], emit: EmitFn, signal: AbortSignal, pinned: AgentPinnedDto | null = null): Promise<void> {
    // The User model has no `name` field — it has `displayName String?` —
    // select that and pass it through as userName (null when unset).
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        displayName: true,
        aiProfile: { select: { instructions: true, jobTitle: true, institution: true, department: true, language: true } },
      },
    });
    const turnId = randomUUID();
    const startedAt = Date.now();
    let aliasCount = 0;
    const aliasByKey = new Map<string, string>();
    const ctx: ToolContext = {
      userId,
      userEmail: user?.email ?? '',
      aliasFor: (type, id) => {
        const k = `${type}:${id}`;
        const hit = aliasByKey.get(k);
        if (hit) return hit;
        const alias = `s${++aliasCount}`;
        aliasByKey.set(k, alias);
        return alias;
      },
      emitChart: (spec) => emit('chart', spec),
    };

    // A pinned thread becomes one extra user message between the system
    // prompt and the conversation turns (below). The injection flag combines
    // MessageCard rows already computed for these messages (cheap — no
    // re-extraction) with a live detector pass over the label AND the pinned
    // text — the label is the mail Subject, just as attacker-controlled as
    // the body, so a subject-only injection attempt ("Ignore all previous
    // instructions") must still flag even when the body is clean. Unlike
    // retrieval.service.ts:414, this query is NOT wrapped in a try/catch: a
    // failed lookup here fails the whole turn instead of silently degrading
    // to detector-only, so a DB error can never let an unflagged pin through.
    let pinnedMessage: string | null = null;
    if (pinned) {
      const ids = pinned.messageIds ?? [];
      const cardFlags = new Map<string, boolean>();
      if (ids.length) {
        const cards = await this.prisma.messageCard.findMany({
          where: { messageId: { in: ids } },
          select: { messageId: true, injectionSuspected: true },
        });
        for (const c of cards) cardFlags.set(c.messageId, c.injectionSuspected);
      }
      const flagged = pinnedIsSuspect(`${pinned.label}\n${pinned.text}`, cardFlags, ids);
      pinnedMessage = buildPinnedMessage(pinned, flagged);
      // `includedIn`, never ids.length — the frame's `included` is what the
      // chip renders as "N of M messages", and deriving it from the full
      // thread would make that branch dead code.
      emit(PINNED_FRAME, { included: includedIn(pinned), injectionSuspected: flagged });
    }

    const transcript: AgentMessage[] = [
      {
        role: 'system',
        content: buildAgentPrompt({
          userEmail: user?.email ?? '',
          userName: user?.displayName ?? null,
          nowIso: new Date().toISOString(),
          // Identity (name/email) is already stated in this prompt's own
          // "acting for" line — omit displayName/email here so the profile
          // block doesn't render a duplicate identity line.
          profile: user?.aiProfile ? { ...user.aiProfile } : null,
        }),
      },
      // The pin is a USER message, never a system one — the server owns
      // exactly one system message and buildAgentPrompt's security posture
      // depends on that being the only place instructions live.
      ...(pinnedMessage ? [{ role: 'user', content: pinnedMessage } as AgentMessage] : []),
      ...turns.slice(-12).map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }) as AgentMessage),
    ];
    let transcriptChars = transcript.reduce((sum, m) => sum + m.content.length, 0);
    let probeNudged = false;
    let usedTools = false;
    const pushMessage = (msg: AgentMessage): void => {
      transcript.push(msg);
      transcriptChars += msg.content.length;
    };

    for (let iter = 1; iter <= MAX_ITERATIONS + 1; iter++) {
      if (signal.aborted) return;
      const finalIteration =
        iter > MAX_ITERATIONS ||
        Date.now() - startedAt > WALL_CLOCK_MS ||
        transcriptChars > MAX_TRANSCRIPT_CHARS;
      if (finalIteration) {
        pushMessage({ role: 'user', content: 'Answer now with what you have. Do not call any more tools.' });
      }

      // Iteration 1 forces a tool call (probe-first: search or ask_user before
      // answering — qwen3 otherwise skips tools and fabricates "not found").
      // It must run NON-streamed: the llama.cpp host honors tool_choice:
      // 'required' only for plain completions and silently ignores it under
      // streaming (verified live 2026-09-07). Later iterations stream as usual.
      const firstProbe = iter === 1 && !finalIteration;
      const body: UpstreamChatBody = {
        model: this.chatModel,
        messages: transcript as unknown as Array<Record<string, unknown>>,
        stream: !firstProbe,
        temperature: 0.2,
        max_tokens: 1024,
        ...(finalIteration
          ? {}
          : { tools: this.registry.openAiTools(), tool_choice: firstProbe ? ('required' as const) : ('auto' as const) }),
      } as UpstreamChatBody;

      const upstream = await this.ai.upstream(body, signal);
      const onDelta = (delta: string) => emit(null, { choices: [{ delta: { content: delta } }] });
      let result;
      if (firstProbe) {
        // Buffer the probe's text: a zero-tool answer is withheld, corrected
        // with PROBE_NUDGE, and retried once before anything reaches the
        // client. The retry re-enters this branch (iter stays 1) but the
        // probeNudged guard makes its outcome final either way.
        result = await consumeAgentJson(upstream, () => {});
        if (!result.toolCalls.length && !probeNudged) {
          probeNudged = true;
          pushMessage({ role: 'assistant', content: result.text });
          pushMessage({ role: 'user', content: PROBE_NUDGE });
          iter--;
          continue;
        }
        if (result.text) onDelta(result.text);
      } else {
        result = await consumeAgentStream(upstream, onDelta);
      }

      if (!result.toolCalls.length || finalIteration) {
        // qwen3 reliably ignores mandate 8's "questions go through ask_user"
        // once it is composing prose. If this turn's final answer asks the
        // user something after tool use, one cheap extra call converts that
        // question into a real clarify card (chips) under the answer.
        await this.convertQuestionToClarify(result.text, usedTools, transcript, ctx, turnId, emit, signal);
        return;
      }

      // This iteration produced both a preamble ("Let me look that up.") and
      // tool calls. Both the preamble and the next iteration's text stream to
      // the client as raw deltas with no separator, so without this they glue
      // together into one run-on string. Emit a paragraph break between them.
      if (result.text) {
        emit(null, { choices: [{ delta: { content: '\n\n' } }] });
      }

      // Cap BEFORE building the assistant message: an OpenAI-compat server
      // rejects an assistant message whose tool_calls lack a matching
      // tool reply for every id, so the assistant message's tool_calls and
      // the role:'tool' replies below must be derived from the same
      // (already-capped) list of calls, using the same ids for both.
      const calls = result.toolCalls.slice(0, MAX_CALLS_PER_ITERATION);
      const callIds = calls.map((c, i) => c.id || `call_${iter}_${i}`);

      pushMessage({
        role: 'assistant',
        content: result.text,
        tool_calls: calls.map((c, i) => ({
          id: callIds[i],
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      for (const [i, call] of calls.entries()) {
        const callId = callIds[i];
        const { content, endTurn } = await this.dispatch(call, callId, ctx, turnId, emit);
        pushMessage({ role: 'tool', tool_call_id: callId, content });
        // A clarifying question ends the turn: the user's pick arrives as the
        // next user message. Returning here also caps ask_user at one per
        // turn — any further calls in this batch are simply never dispatched.
        if (endTurn) return;
      }
      usedTools = true;
    }
  }

  /**
   * Post-answer conversion pass: when a turn that used tools ends with a
   * question to the user, ask the model — with ask_user as the ONLY tool — to
   * restate that question as a clarify call, and dispatch it so the panel
   * renders quick-reply chips under the already-streamed answer. Best-effort:
   * any failure or non-compliance is silently dropped.
   */
  private async convertQuestionToClarify(
    finalText: string,
    usedTools: boolean,
    transcript: AgentMessage[],
    ctx: ToolContext,
    turnId: string,
    emit: EmitFn,
    signal: AbortSignal,
  ): Promise<void> {
    if (!usedTools || signal.aborted) return;
    // A clarification isn't always a question mark — qwen also closes with
    // imperatives like "Please choose one." Look at the answer's tail for
    // either shape.
    const tail = finalText.trimEnd().slice(-300);
    const asksUser =
      /[?？]/.test(tail) ||
      /\b(please (choose|specify|select|confirm|clarify)|which (one|of these|document|email|event|file)|let me know which)\b/i.test(tail);
    if (!asksUser) return;
    const askDef = this.registry.get('ask_user');
    if (!askDef || askDef.mode !== 'clarify') return;

    try {
      const body: UpstreamChatBody = {
        model: this.chatModel,
        messages: [
          ...transcript,
          { role: 'assistant', content: finalText },
          {
            role: 'user',
            content:
              'Convert the choice you just asked the user to make into ONE ask_user tool call: a short question plus 2-4 short options grounded in what you found. Options are plain human-readable labels — no [sN] aliases, no ids. Call the tool only — write no text.',
          },
        ] as unknown as Array<Record<string, unknown>>,
        stream: false,
        temperature: 0.2,
        max_tokens: 300,
        tools: this.registry.openAiTools().filter((t) => t.function.name === 'ask_user'),
        tool_choice: 'auto',
      } as UpstreamChatBody;
      const upstream = await this.ai.upstream(body, signal);
      const result = await consumeAgentJson(upstream, () => {});
      const call = result.toolCalls.find((c) => c.name === 'ask_user');
      if (!call) return;

      // Coerce sloppy args into the schema instead of dropping them — the
      // model routinely returns 5 options or 70-char labels here (observed
      // live: strict validation rejected the whole conversion). Re-dispatch
      // the cleaned args so the normal clarify frames/logging apply.
      let parsed: any;
      try {
        parsed = JSON.parse(call.arguments || '{}');
      } catch {
        return;
      }
      const question = String(parsed?.question ?? '').trim().slice(0, 300);
      const options = (Array.isArray(parsed?.options) ? parsed.options : [])
        .map((o: unknown) => String(o).trim())
        .filter((o: string) => o.length > 0)
        .map((o: string) => (o.length > 60 ? `${o.slice(0, 59)}…` : o))
        .slice(0, 4);
      if (question.length < 5 || options.length < 2) return;
      await this.dispatch(
        { id: call.id, name: 'ask_user', arguments: JSON.stringify({ question, options }) },
        call.id || 'clarify_conv',
        ctx,
        turnId,
        emit,
      );
    } catch {
      // best-effort — the prose question already reached the user
    }
  }

  private async dispatch(
    call: UpstreamToolCall,
    callId: string,
    ctx: ToolContext,
    turnId: string,
    emit: EmitFn,
  ): Promise<{ content: string; endTurn: boolean }> {
    const content = await this.dispatchContent(call, callId, ctx, turnId, emit);
    return typeof content === 'string' ? { content, endTurn: false } : content;
  }

  private async dispatchContent(
    call: UpstreamToolCall,
    callId: string,
    ctx: ToolContext,
    turnId: string,
    emit: EmitFn,
  ): Promise<string | { content: string; endTurn: boolean }> {
    const def = this.registry.get(call.name);
    if (!def) {
      emit('tool_start', { id: callId, tool: call.name, argsSummary: '(unknown tool)' });
      emit('tool_result', {
        id: callId, ok: false, summary: `Unknown tool ${call.name}`, refs: [], injectionSuspected: false,
      });
      await this.log(ctx.userId, turnId, call.name, { raw: call.arguments.slice(0, 500) }, false, 0);
      // NOTE: this error string is pushed verbatim into the transcript as a
      // role:'tool' message content — it is NOT passed through fenceUntrusted.
      // Never interpolate untrusted content (subjects, filenames, titles,
      // tool output) into an error thrown/returned from here or below —
      // only static, developer-controlled text belongs in these messages.
      return `Error: unknown tool "${call.name}".`;
    }

    let args: unknown;
    try {
      args = this.registry.parseArgs(call.name, call.arguments);
    } catch (err: any) {
      emit('tool_start', { id: callId, tool: call.name, argsSummary: '(invalid arguments)' });
      emit('tool_result', {
        id: callId, ok: false, summary: 'Invalid arguments', refs: [], injectionSuspected: false,
      });
      const argsMessage = err instanceof ToolValidationError ? err.message : 'invalid arguments';
      return fenceUntrusted('TOOL_ERROR', `Error: ${argsMessage}`);
    }

    emit('tool_start', { id: callId, tool: call.name, argsSummary: summarizeArgs(call.name, args) });
    const started = Date.now();

    // Citation aliases ("s2", "[s2]") leak out of conversation history into
    // id arguments (observed live: read_document {docId:"s2"} after a chip
    // pick). Reject them with a corrective error so the model re-searches
    // within the same turn instead of reporting "could not be retrieved".
    const aliasArg = Object.entries((args ?? {}) as Record<string, unknown>).find(
      ([key, value]) =>
        /Id[AB]?$/.test(key) && typeof value === 'string' && /^\[?s\d+\]?$/.test(value.trim()),
    );
    if (aliasArg) {
      emit('tool_result', {
        id: callId, ok: false, summary: 'Citation alias passed as id', refs: [], injectionSuspected: false,
      });
      await this.log(ctx.userId, turnId, call.name, args, false, Date.now() - started);
      return `Error: "${String(aliasArg[1]).trim()}" is a citation alias from the conversation, not a real id. Call the matching search tool with the item's title or keywords, then use the id from that fresh result.`;
    }

    if (def.mode === 'clarify') {
      const clarifyId = randomUUID();
      const { question, options } = args as { question: string; options: string[] };
      // Strip [sN] citation aliases: a chip's text becomes the user's next
      // message, and an alias in it sends the model chasing "[s2]" as a
      // document id (observed live 2026-09-07) instead of re-searching.
      const stripAliases = (s: string) =>
        s
          .replace(/\s*\[s\d+\]/g, '')
          .replace(/\s*\(id\s+[A-Za-z0-9_-]+\)/gi, '')
          .replace(/\s+([?!.])/g, '$1')
          .trim();
      emit('clarify', { clarifyId, question: stripAliases(question), options: options.map(stripAliases) });
      emit('tool_result', {
        id: callId, ok: true, summary: 'Clarifying question shown', refs: [], injectionSuspected: false,
      });
      await this.log(ctx.userId, turnId, call.name, args, true, Date.now() - started);
      return {
        content:
          'Your clarifying question was shown to the user with quick-reply options. The turn is over; their answer arrives as the next user message.',
        endTurn: true,
      };
    }

    if (def.mode === 'write-gated') {
      const proposalId = randomUUID();
      emit('proposal', { proposalId, tool: call.name, args, summary: summarizeArgs(call.name, args) });
      emit('tool_result', {
        id: callId, ok: true, summary: 'Proposal shown for approval', refs: [], injectionSuspected: false,
      });
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
      emit('tool_result', {
        id: callId, ok: false, summary: message, refs: [], injectionSuspected: false,
      });
      await this.log(ctx.userId, turnId, call.name, args, false, Date.now() - started);
      return fenceUntrusted('TOOL_ERROR', `Error executing ${call.name}: ${message}`);
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
