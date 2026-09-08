/**
 * Client for POST /ai/agent — the agentic tool-use layer. Protocol: named SSE
 * frames (tool_start / tool_result / proposal / chart / clarify) interleaved
 * with normal OpenAI-shaped delta chunks, ending in `data: [DONE]`. See
 * sse.ts's readEventSse for the frame parser.
 */
import { authedFetch } from '../authed-fetch';
import { AIHttpError } from './client';
import { readEventSse } from './sse';
import type { AskSource, AskTurn } from './ask';

export interface AgentStep {
  id: string;
  tool: string;
  argsSummary: string;
  ok?: boolean;
  summary?: string;
  refs?: AskSource[];
  injectionSuspected?: boolean;
  /** Client-enriched: the narration streamed before this tool call ("Let me
   *  search…"). Folded out of the answer into the step timeline. */
  preamble?: string;
}

export interface AgentProposal {
  proposalId: string;
  tool: 'send_email' | 'create_calendar_event';
  args: any;
  summary: string;
}

/** A clarifying question from the ask_user tool — ends the agent's turn;
 *  the user's pick (or any typed reply) becomes the next user message. */
export interface AgentClarify {
  clarifyId: string;
  question: string;
  options: string[];
}

export interface AgentChartSpec {
  type: 'bar' | 'line' | 'pie';
  title: string;
  labels: string[];
  series: Array<{ name: string; data: number[] }>;
}

export async function streamAgent(
  turns: AskTurn[],
  opts: {
    onStep: (step: AgentStep) => void;
    onStepResult: (step: AgentStep) => void;
    onProposal: (p: AgentProposal) => void;
    onChart: (c: AgentChartSpec) => void;
    onClarify: (c: AgentClarify) => void;
    onChunk: (delta: string) => void;
    signal?: AbortSignal;
  },
): Promise<string> {
  const res = await authedFetch('/ai/agent', {
    method: 'POST',
    body: JSON.stringify({ messages: turns.map(({ role, content }) => ({ role, content })) }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new AIHttpError(`agent request failed (${res.status})`, res.status);
  }
  return readEventSse(res, {
    onChunk: opts.onChunk,
    onEvent: (name, data) => {
      if (name === 'tool_start') opts.onStep(data as AgentStep);
      else if (name === 'tool_result') opts.onStepResult(data as AgentStep);
      else if (name === 'proposal') opts.onProposal(data as AgentProposal);
      else if (name === 'chart') opts.onChart(data as AgentChartSpec);
      else if (name === 'clarify') opts.onClarify(data as AgentClarify);
    },
  });
}
