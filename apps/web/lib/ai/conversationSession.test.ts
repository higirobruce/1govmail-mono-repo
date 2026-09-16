import { describe, expect, it } from 'vitest';
import { createConversationSession } from './conversationSession';

describe('createConversationSession', () => {
  it('starts with no id and generation 0', () => {
    const s = createConversationSession();
    expect(s.id()).toBeNull();
    expect(s.generation()).toBe(0);
  });

  it('set writes unconditionally', () => {
    const s = createConversationSession();
    s.set('c1');
    expect(s.id()).toBe('c1');
  });

  it('clear forgets the id and bumps the generation', () => {
    const s = createConversationSession();
    s.set('c1');
    s.clear();
    expect(s.id()).toBeNull();
    expect(s.generation()).toBe(1);
  });

  it('setIfCurrent writes when the captured generation still matches', () => {
    const s = createConversationSession();
    const gen = s.generation();
    s.setIfCurrent('c1', gen);
    expect(s.id()).toBe('c1');
  });

  /**
   * The exact hazard this module exists for: a create() captures the
   * generation before its network round trip; "New conversation" clears the
   * id and bumps the generation while that round trip is still in flight;
   * the response then arrives claiming an id under a generation that no
   * longer exists. It must land nowhere — not overwrite the clear.
   */
  it('setIfCurrent is a no-op once the generation has moved on — a late response cannot resurrect a cleared conversation', () => {
    const s = createConversationSession();
    const genAtRequestTime = s.generation(); // captured before the "network call"
    s.clear(); // "New conversation", clicked while that call is still in flight
    s.setIfCurrent('late-id', genAtRequestTime); // the call finally resolves
    expect(s.id()).toBeNull();
  });

  it('a stale write does not consume the new generation — the next legitimate write still succeeds', () => {
    const s = createConversationSession();
    const staleGen = s.generation();
    s.clear();
    s.setIfCurrent('late-id', staleGen);
    s.setIfCurrent('fresh-id', s.generation());
    expect(s.id()).toBe('fresh-id');
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
   * The two hazards together: turn 1's create() is still in flight when
   * "New conversation" is clicked; turn 2 is asked and its persist enqueued
   * before turn 1's create() resolves. Turn 1's late response must not land,
   * and turn 2 — enqueued under the NEW generation — must still succeed and
   * become the id going forward.
   */
  it('a superseded create() lands nowhere, and the next turn after New conversation still gets its own id', async () => {
    const s = createConversationSession();
    const genForTurn1 = s.generation();
    s.clear(); // New conversation, clicked before turn 1's create() resolved
    const genForTurn2 = s.generation();

    await s.enqueue(async () => { s.setIfCurrent('turn-1-id', genForTurn1); });
    await s.enqueue(async () => { s.setIfCurrent('turn-2-id', genForTurn2); });

    expect(s.id()).toBe('turn-2-id');
  });
});
