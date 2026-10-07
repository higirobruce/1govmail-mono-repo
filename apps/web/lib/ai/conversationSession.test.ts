import { describe, expect, it } from 'vitest';
import { createConversationSession } from './conversationSession';

describe('createConversationSession', () => {
  it('starts at generation 0 with no id recorded for it', () => {
    const s = createConversationSession();
    expect(s.generation()).toBe(0);
    expect(s.id(0)).toBeNull();
  });

  it('setForGeneration writes into the generation it is given', () => {
    const s = createConversationSession();
    const gen = s.generation();
    s.setForGeneration('c1', gen);
    expect(s.id(gen)).toBe('c1');
  });

  it('clear() bumps the generation', () => {
    const s = createConversationSession();
    s.clear();
    expect(s.generation()).toBe(1);
  });

  /**
   * Catches: `setForGeneration` writing to a single shared cell instead of
   * `idsByGeneration.set(expectedGeneration, ...)` — e.g. a regression back
   * to one mutable `id` variable. If two generations' ids were not kept
   * separately, writing under generation 1 would leak into generation 0's
   * slot (or vice versa).
   */
  it('a generation\'s id is independent of another generation\'s', () => {
    const s = createConversationSession();
    s.setForGeneration('conv-a', 0);
    s.clear(); // now at generation 1
    s.setForGeneration('conv-b', 1);
    expect(s.id(0)).toBe('conv-a');
    expect(s.id(1)).toBe('conv-b');
  });

  /**
   * The exact hazard #2 this module exists for: a create() captures the
   * generation before its network round trip; "New conversation" clears —
   * bumps the generation — while that round trip is still in flight; the
   * response then arrives claiming an id under a generation that is no
   * longer current. It must not resurrect the conversation the user walked
   * away from: the CURRENT generation must still be empty afterwards, so
   * their next question starts fresh. The id lands in its own (superseded)
   * generation's slot, where only a turn captured under that generation can
   * ever read it — see the F6 case below for why that matters. Catches: a
   * regression to one shared cell, or writing into `generation` instead of
   * the generation the write was issued under.
   */
  it('a late write cannot resurrect a cleared conversation — the current generation stays empty', () => {
    const s = createConversationSession();
    const genAtRequestTime = s.generation(); // captured before the "network call"
    s.clear(); // "New conversation", clicked while that call is still in flight
    s.setForGeneration('late-id', genAtRequestTime); // the call finally resolves
    expect(s.id(s.generation())).toBeNull();
    expect(s.id(genAtRequestTime)).toBe('late-id');
  });

  it('a stale write does not consume the new generation — the next legitimate write still succeeds', () => {
    const s = createConversationSession();
    const staleGen = s.generation();
    s.clear();
    s.setForGeneration('late-id', staleGen);
    s.setForGeneration('fresh-id', s.generation());
    expect(s.id(s.generation())).toBe('fresh-id');
  });

  /**
   * Hazard #3 — the race this round's fix closes. A turn asked BEFORE "New
   * conversation" is clicked, still queued behind an earlier turn's persist
   * when the click happens, must still find (and be able to append to) its
   * own conversation once it finally runs — even though the CURRENT
   * generation has already moved on. Catches: `clear()` wiping the id map
   * (e.g. an accidental `idsByGeneration.clear()` — the same method name on
   * the underlying Map — instead of only bumping the counter), or `id()`
   * reading the current generation instead of the one it's asked about.
   */
  it('an old generation\'s slot survives clear() untouched — a turn queued before the click still finds its own conversation after it', () => {
    const s = createConversationSession();
    const gen = s.generation();
    s.setForGeneration('conv-c', gen); // an earlier turn under this generation already has a conversation
    s.clear(); // "New conversation" clicked — moves on to the next generation
    // The turn that was already asked (and queued) before the click still
    // addresses ITS OWN captured generation, not whatever is current now.
    expect(s.id(gen)).toBe('conv-c');
    // The new generation starts genuinely empty — a turn asked AFTER the
    // click will correctly start its own conversation instead of finding C.
    expect(s.id(s.generation())).toBeNull();
  });

  /**
   * Catches: `clear()` forgetting to bump `generation` at all — in which
   * case the "new" generation would collide with the old one, and this
   * would (incorrectly) come back non-null.
   */
  it('the generation after clear() genuinely starts empty', () => {
    const s = createConversationSession();
    s.setForGeneration('conv-a', s.generation());
    s.clear();
    expect(s.id(s.generation())).toBeNull();
  });

  it('enqueue runs jobs strictly in the order they were enqueued, even when the first is slower', async () => {
    const s = createConversationSession();
    const order: number[] = [];
    const slow = () => new Promise<void>((resolve) => {
      setTimeout(() => { order.push(1); resolve(); }, 20);
    });
    const fast = () => new Promise<void>((resolve) => { order.push(2); resolve(); });
    const p1 = s.enqueue(slow);
    const p2 = s.enqueue(fast);
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('a job that throws does not stall the next enqueued job', async () => {
    const s = createConversationSession();
    const order: string[] = [];
    await s.enqueue(async () => { order.push('a'); throw new Error('boom'); });
    await s.enqueue(async () => { order.push('b'); });
    expect(order).toEqual(['a', 'b']);
  });

  /**
   * Hazard #1 (round 1), reaffirmed under the generation-scoped store: two
   * turns racing under the SAME generation must append rather than
   * double-create. Catches a regression that reintroduces the split — e.g.
   * scoping `id()` so a second, concurrently-queued turn can't see the
   * first turn's freshly written id.
   */
  it('two turns under the same generation, racing, end up as one create + one append — not two creates', async () => {
    const s = createConversationSession();
    const gen = s.generation();
    const creates: string[] = [];

    const turn = (label: string) => async () => {
      if (s.id(gen)) {
        // would append here in the real caller — nothing to write
        return;
      }
      creates.push(label);
      s.setForGeneration(`conv-from-${label}`, gen);
    };

    await Promise.all([s.enqueue(turn('A')), s.enqueue(turn('B'))]);
    expect(creates).toEqual(['A']); // only the first job to run actually created one
    expect(s.id(gen)).toBe('conv-from-A');
  });

  /**
   * F6 — the residual split the `expectedGeneration === generation` guard
   * left open. "New conversation" lands between turn 1's create() being
   * issued and it resolving. Turn 2 was asked (and queued) BEFORE the click,
   * so it belongs to turn 1's conversation. If the late create() is dropped
   * instead of recorded under its own generation, turn 2 finds null and
   * creates a SECOND conversation — the same user-visible split hazard #1
   * exists to prevent, in a narrower window. Catches a reintroduction of the
   * conditional write.
   */
  it('a create() that resolves after New conversation still records its id under its OWN generation, so a turn queued under it appends', async () => {
    const s = createConversationSession();
    const gen = s.generation();
    const creates: string[] = [];
    const appends: string[] = [];

    const turn = (label: string) => async () => {
      const existing = s.id(gen);
      if (existing) { appends.push(`${label}->${existing}`); return; }
      creates.push(label);
      s.clear(); // "New conversation" clicked while this create() was in flight
      s.setForGeneration(`conv-from-${label}`, gen);
    };

    await Promise.all([s.enqueue(turn('A')), s.enqueue(turn('B'))]);

    expect(creates).toEqual(['A']);
    expect(appends).toEqual(['B->conv-from-A']);
    // ...and the conversation the user walked away to is still empty, so
    // their next question starts fresh (hazard #2, provided by the keying).
    expect(s.id(s.generation())).toBeNull();
  });

  /**
   * Hazard #3 end to end: a superseded create() (turn under the OLD
   * generation) stays confined to that generation, and the next turn —
   * enqueued under the NEW generation, asked right after "New conversation"
   * — still gets its own id, unaffected by the turn still resolving behind
   * it in the chain. The two generations never see each other's id.
   */
  it('a superseded create() stays confined to its own generation, and the next turn after New conversation still gets its own id', async () => {
    const s = createConversationSession();
    const genForTurn1 = s.generation();
    s.clear(); // New conversation, clicked before turn 1's create() resolved
    const genForTurn2 = s.generation();

    await s.enqueue(async () => { s.setForGeneration('turn-1-id', genForTurn1); });
    await s.enqueue(async () => { s.setForGeneration('turn-2-id', genForTurn2); });

    expect(s.id(genForTurn1)).toBe('turn-1-id');
    expect(s.id(genForTurn2)).toBe('turn-2-id');
  });
});
