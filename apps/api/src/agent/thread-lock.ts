import { ToolValidationError } from './tool-registry';

/**
 * "This thread only": the reads that cannot reach outside one thread, plus the
 * utilities that do not widen scope. draft_email stays because "draft a reply"
 * must still work under the lock and a draft is reviewed by a human before it
 * goes anywhere. Every mailbox-wide search and every gated write is withheld —
 * filtering what is advertised (agent.service.ts's openAiTools call) is half
 * of the lock; see assertIdInThread below for the other half.
 */
export const THREAD_LOCK_TOOLS: ReadonlySet<string> = new Set([
  'get_thread',
  'read_email',
  'read_attachment',
  'ask_user',
  'draft_email',
]);

/**
 * read_email, read_attachment AND get_thread are all addressed by id, not by
 * search — so withholding the search tools alone would still let the model
 * reach outside the pinned thread by guessing/reusing an id from earlier in
 * the conversation. get_thread belongs here too, not just the two reads: its
 * schema is `{ messageId }` and it returns the WHOLE conversation for that
 * id (subject, date, a snippet per message) — an out-of-thread id there
 * leaks another conversation's content just as surely as read_email would.
 * That would make "this thread only" a label rather than a guarantee. Bound
 * here, in one place, rather than edited into each tool, so these
 * id-addressed calls can't drift out of sync with the allowlist above.
 * Every pinned id belongs to the pinned thread, so get_thread on any
 * *allowed* id still returns exactly the thread the model is entitled to —
 * this costs nothing legitimate.
 *
 * Reuses ToolValidationError deliberately: the dispatch site's existing catch
 * for that type turns the throw into a tool_result the model sees and can
 * recover from (pick a different id, or fall back to the pinned text) —
 * this must not kill the turn.
 */
const ID_ADDRESSED: ReadonlySet<string> = new Set(['read_email', 'read_attachment', 'get_thread']);

export function assertIdInThread(toolName: string, args: unknown, messageIds: string[]): void {
  if (!ID_ADDRESSED.has(toolName)) return;
  const id = (args as { messageId?: unknown } | null)?.messageId;
  if (typeof id !== 'string' || !messageIds.includes(id)) {
    throw new ToolValidationError(
      `${toolName}: that message is not part of this thread. Only the pinned thread's messages can be read while "this thread only" is on.`,
    );
  }
}
