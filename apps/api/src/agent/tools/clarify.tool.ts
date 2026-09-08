import { z } from 'zod';
import type { ToolDef } from '../tool-registry';

/**
 * ask_user — the agent's clarifying-question tool. Like the gated tools it is
 * never executed server-side: AgentService intercepts the call, emits a
 * `clarify` SSE frame (rendered as a quick-reply card in the Ask panel) and
 * ends the turn. The user's pick arrives as the next user message.
 */
export function buildClarifyTool(): ToolDef {
  return {
    name: 'ask_user',
    description:
      'Ask the user ONE short clarifying question with 2-4 quick-reply options, then stop. This is the ' +
      'ONLY way to ask the user anything — never ask questions in your answer text. ' +
      'Use when a request is ambiguous in a way that changes which source or item to use ' +
      '(e.g. "the document" could be a Docs document or an email attachment) AND searching has not ' +
      'resolved it — results split across sources, all weak, or empty. Ground the options in what ' +
      'you actually found (name the candidates); when a search found nothing, offer source/detail options ' +
      'like "It\'s in my email" / "It\'s a Docs document" / "I\'ll give the name". Include a broader option ' +
      'like "Both" or "Show everything" when it fits. Never ask for something a search could answer, ' +
      'and never call this twice in one turn.',
    mode: 'clarify',
    resultBudget: 0,
    schema: z.object({
      question: z.string().min(5).max(300),
      options: z.array(z.string().min(1).max(60)).min(2).max(4),
    }),
    execute: async (): Promise<never> => {
      throw new Error('ask_user is never executed server-side');
    },
  };
}
