/**
 * Tracks which saved Ask 1Gov conversation the panel is currently appending
 * to, and serializes the async writes that decide it. Pulled out of
 * AskPanel.tsx — which cannot be mounted in jsdom (see its header comment),
 * so this is the part of that bookkeeping a test can actually exercise —
 * rather than left inline as a handful of refs.
 *
 * Two hazards this exists to close, both the same shape: a later,
 * authoritative action getting undone by an earlier async response that
 * resolves out of order.
 *
 *  1. Two turns completing close together both see no conversation yet, so
 *     each fires its own `create()` — one saved conversation ends up split
 *     into two rows instead of one appended pair. `enqueue` serializes
 *     every persist through a single promise chain, so the second turn's
 *     "do we already have a conversation" check runs only after the first
 *     turn's create() has already resolved (and, if it succeeded, recorded
 *     the id) — correct by construction rather than by timing.
 *  2. "New conversation" clears the id while an older turn's create() is
 *     still in flight. That create() resolving afterwards must not
 *     silently resurrect the conversation the user just walked away from —
 *     the next question would then append to it instead of starting fresh,
 *     with no sign of that having happened. `clear()` bumps a generation
 *     counter; `setIfCurrent` only writes an id if the generation it was
 *     issued under (captured by the caller via `generation()` before the
 *     async call) is still the current one. A late write lands nowhere.
 */
export interface ConversationSession {
  id: () => string | null;
  generation: () => number;
  /** Unconditional write — for a value that didn't take a round trip to arrive (e.g. resuming a chosen conversation on mount). */
  set: (id: string | null) => void;
  /** Writes `id` only if `expectedGeneration` still matches the current one — for a value that DID take a round trip (see hazard 2 above). */
  setIfCurrent: (id: string, expectedGeneration: number) => void;
  /** Forgets the current conversation and bumps the generation, so a still-in-flight write issued before this call cannot land after it. */
  clear: () => void;
  /**
   * Runs `fn` only after every previously enqueued run has settled — never
   * concurrently with another enqueued run, and never skipped because an
   * earlier one failed. `fn`'s own errors are the caller's to swallow (a
   * failed history write must never surface to the user); this also
   * catches defensively so one bad `fn` can never stall what comes next.
   */
  enqueue: (fn: () => Promise<void>) => Promise<void>;
}

export function createConversationSession(): ConversationSession {
  let id: string | null = null;
  let generation = 0;
  let chain: Promise<void> = Promise.resolve();

  return {
    id: () => id,
    generation: () => generation,
    set: (newId) => { id = newId; },
    setIfCurrent: (newId, expectedGeneration) => {
      if (expectedGeneration === generation) id = newId;
    },
    clear: () => { id = null; generation += 1; },
    enqueue: (fn) => {
      chain = chain.then(fn).catch(() => {});
      return chain;
    },
  };
}
