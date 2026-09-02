import { describe, it, expect, beforeEach } from 'vitest';
import { getCachedCard, putCachedCard, CARD_CACHE_MAX } from './briefingCache';
import type { BriefingCard } from './briefing';

const card = (id: string): BriefingCard => ({
  messageId: id, conversationId: null, direction: 'received', from: 'a@x.rw',
  subject: null, receivedAt: '2026-09-02T08:00:00Z', gist: `gist-${id}`,
  asksOfMe: [], deadlines: [], commitmentsIMade: [], waitingOn: null,
  importance: 'normal', attachments: [], injectionSuspected: false,
});

beforeEach(() => localStorage.clear());

describe('briefing card cache', () => {
  it('round-trips a card keyed by message and model', () => {
    putCachedCard('m1', 'model-a', card('m1'));
    expect(getCachedCard('m1', 'model-a')?.gist).toBe('gist-m1');
  });
  it('misses on a different model', () => {
    putCachedCard('m1', 'model-a', card('m1'));
    expect(getCachedCard('m1', 'model-b')).toBeNull();
  });
  it('evicts the oldest entries beyond the cap', () => {
    for (let i = 0; i <= CARD_CACHE_MAX; i++) putCachedCard(`m${i}`, 'model-a', card(`m${i}`));
    expect(getCachedCard('m0', 'model-a')).toBeNull();
    expect(getCachedCard(`m${CARD_CACHE_MAX}`, 'model-a')).not.toBeNull();
  });
  it('survives corrupted storage', () => {
    localStorage.setItem('1gov-brief-cards-v1', '{corrupt');
    expect(getCachedCard('m1', 'model-a')).toBeNull();
    putCachedCard('m1', 'model-a', card('m1'));   // must not throw
    expect(getCachedCard('m1', 'model-a')).not.toBeNull();
  });
});
