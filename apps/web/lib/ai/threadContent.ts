/**
 * Full-body thread gathering for AI features that need more than the single
 * open message — e.g. "draft a doc from this thread". A conversation's
 * message list only carries snippets; this fans out to each message's real
 * body (fetched through the caller's cache) and stitches them into one block
 * of text, oldest-included first.
 *
 * A single message's body fetch failing (network blip, deleted message, …)
 * must never sink the whole gather — it just degrades that one block to its
 * snippet, same as a body that fetched but extracted to nothing.
 */

import { extractEmailText } from './extract';

export interface ThreadMessageMeta {
  id: string;
  fromEmail: string;
  fromName: string | null;
  receivedAt: string;
  snippet: string | null;
}

export interface ThreadContentDeps {
  getConversation: (id: string) => Promise<{ conversationId: string | null; messages: ThreadMessageMeta[] }>;
  // caller passes (id) => fetchBodyCached(id, api.mail.getMessage)
  getBody: (id: string) => Promise<{ bodyText?: string | null; bodyHtml?: string | null }>;
}

/** Only the last N messages are hydrated with full bodies — enough context
 *  for a draft without fanning out to dozens of bodies on a long thread. */
const DEFAULT_MAX_MESSAGES = 10;
/** Per-message character budget handed to extractEmailText. */
const PER_MESSAGE_MAX_CHARS = 2000;
/**
 * Total character budget for the joined text handed to the model. Per-message
 * caps alone allow up to DEFAULT_MAX_MESSAGES * PER_MESSAGE_MAX_CHARS (~20k) — enough
 * to risk context overflow / silent front-truncation on small local models —
 * so the joined result is additionally capped here by dropping the oldest
 * blocks first, same "newest survives" bias as the DEFAULT_MAX_MESSAGES cap above.
 */
const DEFAULT_TOTAL_CHAR_BUDGET = 12000;
/**
 * Budget for a thread pinned into an Ask 1Gov conversation. Lower than the
 * draft-a-doc default because a pinned block re-rides EVERY turn against a
 * 6-turn agent history — the agent can call get_thread or read_email when it
 * needs more than this digest.
 */
export const PINNED_THREAD_CHAR_BUDGET = 6000;
const BLOCK_SEPARATOR = '\n\n---\n\n';

function formatFrom(meta: Pick<ThreadMessageMeta, 'fromEmail' | 'fromName'>): string {
  return meta.fromName ? `${meta.fromName} <${meta.fromEmail}>` : meta.fromEmail;
}

/**
 * A single gathered message: its id kept alongside the formatted block so
 * capToBudget's oldest-first drop can report which ids actually survived —
 * the id is otherwise unrecoverable once blocks are joined into one string.
 */
interface GatheredBlock {
  id: string;
  block: string;
}

/**
 * Drop the oldest blocks until the joined text fits the budget. Never
 * truncates a block's own text (a block is From/Date/body, dropped whole),
 * and always keeps at least the newest block even if it alone exceeds the
 * budget — some context beats none.
 */
function capToBudget(blocks: GatheredBlock[], budget: number): GatheredBlock[] {
  let kept = blocks;
  while (kept.length > 1 && kept.map((b) => b.block).join(BLOCK_SEPARATOR).length > budget) {
    kept = kept.slice(1);
  }
  return kept;
}

async function gatherOne(meta: ThreadMessageMeta, getBody: ThreadContentDeps['getBody']): Promise<GatheredBlock> {
  let content = '';
  try {
    const body = await getBody(meta.id);
    content = extractEmailText(body, { maxChars: PER_MESSAGE_MAX_CHARS, keepQuoted: false });
  } catch {
    // Fall through to the snippet fallback below.
  }
  if (!content) content = meta.snippet ?? '';
  return { id: meta.id, block: `From: ${formatFrom(meta)}\nDate: ${meta.receivedAt}\n\n${content}` };
}

/**
 * Gather up to the last 10 messages of a thread as full-body text blocks,
 * newest of the kept window last (thread order is preserved). `messageCount`
 * reports the true thread length, not the capped count, so callers can tell
 * the user when older history was left out.
 */
export async function gatherThreadContent(
  messageId: string,
  deps: ThreadContentDeps,
  opts: { totalCharBudget?: number; maxMessages?: number } = {},
): Promise<{ text: string; messageCount: number; includedIds: string[] }> {
  const { messages } = await deps.getConversation(messageId);
  const capped = messages.slice(-(opts.maxMessages ?? DEFAULT_MAX_MESSAGES));
  const blocks = await Promise.all(capped.map((meta) => gatherOne(meta, deps.getBody)));
  const budgeted = capToBudget(blocks, opts.totalCharBudget ?? DEFAULT_TOTAL_CHAR_BUDGET);
  return {
    text: budgeted.map((b) => b.block).join(BLOCK_SEPARATOR),
    messageCount: messages.length,
    /** Ids whose blocks actually survived the budget — NOT the whole thread. The
     *  honest answer to "how many messages reached the model". */
    includedIds: budgeted.map((b) => b.id),
  };
}
