/**
 * Pure decisions for a thread-scoped ask. Kept out of AskPanel so the
 * routing rule and the history budget are directly testable — both are
 * load-bearing: a thread scope rides the AGENT path (unlike a doc scope,
 * which rides retrieval), and it must inherit the agent's shorter history.
 */
import type { AskScope, AskThreadScope } from '@/stores/ask.store';

/** Mirror of the API's ArrayMaxSize — last 6 exchanges. Doc-scoped asks only. */
export const MAX_SENT_TURNS = 12;
/**
 * Agent turns get a shorter history: long transcripts are what push qwen3 into
 * answering from context without calling tools (observed live 2026-09-06 —
 * fabricated docs/ids/addresses). 6 turns = 3 exchanges is plenty for follow-ups.
 */
export const MAX_AGENT_TURNS = 6;

export interface PinnedPayload {
  label: string;
  text: string;
  /** Ids of the messages the pin was gathered FROM — the whole thread. Bounds
   *  the locked reads and feeds the injection-card lookup. */
  messageIds: string[];
  /** How many of them actually reached the model after budgeting. May be lower
   *  than messageIds.length on a long thread; never higher. */
  includedCount: number;
  toolScope?: 'thread';
}

/** Only a doc scope goes to /ai/ask. Thread scope and unscoped go to /ai/agent. */
export function usesRetrievalPath(scope: AskScope | null): boolean {
  return scope?.kind === 'doc';
}

export function historyLimitFor(scope: AskScope | null): number {
  return usesRetrievalPath(scope) ? MAX_SENT_TURNS : MAX_AGENT_TURNS;
}

export function buildPinned(
  scope: AskThreadScope,
  gathered: { text: string; messageIds: string[]; includedCount: number },
): PinnedPayload {
  return {
    label: scope.subject ?? '(no subject)',
    text: gathered.text,
    messageIds: gathered.messageIds,
    includedCount: gathered.includedCount,
    ...(scope.locked ? { toolScope: 'thread' as const } : {}),
  };
}
