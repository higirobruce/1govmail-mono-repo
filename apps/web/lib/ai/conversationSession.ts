/**
 * Tracks which saved Ask 1Gov conversation the panel is currently appending
 * to, and serializes the async writes that decide it. Pulled out of
 * AskPanel.tsx, where it is a handful of refs tangled into a 900-line
 * component, so that the ordering rules below can be stated once and tested
 * directly rather than only through the panel.
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
 *     that having happened. The KEYING is what provides this: a late write
 *     goes into the generation it was issued under, and the current
 *     generation reads a different key, so it can never see it. An extra
 *     "only if still current" condition on the write was tried and removed
 *     — it bought nothing here and cost hazard 3 below its narrow-window
 *     case, where a late create()'s id is exactly what a still-queued turn
 *     of the SAME generation needs to find.
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
   * Records `id` as the conversation `generation` is writing to. Writes are
   * ADDRESSED, never conditional on what is current: a write is always for
   * the generation that issued it, and only turns captured under that same
   * generation can read it back (see hazard 2 above for why that is already
   * the whole of the isolation, and hazard 3 for what a "still current"
   * condition would cost).
   */
  setForGeneration: (id: string, generation: number) => void;
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
    setForGeneration: (newId, forGeneration) => { idsByGeneration.set(forGeneration, newId); },
    clear: () => { generation += 1; },
    enqueue: (fn) => {
      chain = chain.then(fn).catch(() => {});
      return chain;
    },
  };
}
