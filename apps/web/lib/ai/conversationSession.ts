/**
 * Tracks which saved Ask 1Gov conversation the panel is currently appending
 * to, and serializes the async writes that decide it. Pulled out of
 * AskPanel.tsx — which cannot be mounted in jsdom (see its header comment),
 * so this is the part of that bookkeeping a test can actually exercise —
 * rather than left inline as a handful of refs.
 *
 * The id is stored PER GENERATION (a `Map<number, string>`), not as one
 * mutable cell. That is what lets a turn's target survive a later
 * generation bump: it always addresses the slot for the generation it was
 * captured under, never "whatever generation happens to be current by the
 * time it actually runs".
 *
 * Three hazards this exists to close, all the same shape: a later,
 * authoritative action getting undone by an earlier async response that
 * resolves out of order.
 *
 *  1. Two turns completing close together both see no conversation yet
 *     under their shared generation, so each fires its own `create()` —
 *     one saved conversation ends up split into two rows instead of one
 *     appended pair. `enqueue` serializes every persist through a single
 *     promise chain, so the second turn's "do we already have a
 *     conversation" check runs only after the first turn's create() has
 *     already resolved (and, if it succeeded, recorded the id) — correct
 *     by construction rather than by timing.
 *  2. "New conversation" starts a new generation while an older turn's
 *     create() is still in flight, captured under the OLD generation. That
 *     create() resolving afterwards must not silently resurrect the
 *     conversation the user just walked away from — the next question
 *     would then append to it instead of starting fresh, with no sign of
 *     that having happened. `setIfCurrent` only writes an id into the
 *     generation it was issued under if that generation is STILL the
 *     current one; a late write lands in neither its own (superseded) slot
 *     nor the new one.
 *  3. A turn asked (and enqueued) just BEFORE "New conversation" is
 *     clicked can still be sitting in the queue, behind an earlier turn's
 *     still-pending persist, when the click happens. Because it addresses
 *     its OWN captured generation's slot rather than asking "what's current
 *     right now", it still finds — and correctly appends to — the
 *     conversation it actually belongs to, even though by the time it
 *     finally runs, "New conversation" has already moved on to the next
 *     generation. A single global mutable id could not do this: reading it
 *     live (needed to fix hazard 1) would misroute this turn into a brand
 *     new conversation instead.
 */
export interface ConversationSession {
  /** The generation currently accepting new turns. Bumped only by clear(). */
  generation: () => number;
  /**
   * The conversation id `generation` is writing to — null if nothing has
   * been created under it yet. Always looked up by the CALLER's own
   * captured generation, never implicitly "whatever is current now" (see
   * hazard 3 above).
   */
  id: (generation: number) => string | null;
  /**
   * Writes `id` into `expectedGeneration`'s slot, but only if that
   * generation is still the current one. Every write in this module goes
   * through this one gate — a create()'s result, and a resumed
   * conversation's id — so "does this write still apply" is answered the
   * same way everywhere an id gets set (see hazard 2 above).
   */
  setIfCurrent: (id: string, expectedGeneration: number) => void;
  /**
   * Starts a fresh, empty generation. The OLD generation's slot is left
   * exactly as it was — never wiped — which is what hazard 3 depends on: a
   * turn captured under it can still find its conversation after this
   * call, because nothing here ever clears an old slot, only advances
   * which one is current.
   */
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
  let generation = 0;
  const idsByGeneration = new Map<number, string>();
  let chain: Promise<void> = Promise.resolve();

  return {
    generation: () => generation,
    id: (gen) => idsByGeneration.get(gen) ?? null,
    setIfCurrent: (newId, expectedGeneration) => {
      if (expectedGeneration === generation) idsByGeneration.set(expectedGeneration, newId);
    },
    clear: () => { generation += 1; },
    enqueue: (fn) => {
      chain = chain.then(fn).catch(() => {});
      return chain;
    },
  };
}
