import { describe, it, expect } from 'vitest';
import {
  usesRetrievalPath, historyLimitFor, buildPinned,
  MAX_SENT_TURNS, MAX_AGENT_TURNS,
} from './threadPin';
import type { AskDocScope, AskThreadScope } from '@/stores/ask.store';

const doc: AskDocScope = { kind: 'doc', docId: 'd1', docTitle: 'Budget Memo' };
const thread: AskThreadScope = {
  kind: 'thread', conversationId: 'c1', seedMessageId: 'm9',
  subject: 'Re: RHEMIS inception report', messageCount: 6, locked: false,
};

describe('usesRetrievalPath', () => {
  it('is true only for a doc scope', () => {
    expect(usesRetrievalPath(doc)).toBe(true);
    expect(usesRetrievalPath(thread)).toBe(false);
    expect(usesRetrievalPath(null)).toBe(false);
  });
});

describe('historyLimitFor', () => {
  // The regression this guards: a thread scope rides the agent path, and a
  // 12-turn agent transcript is what pushed qwen3 into answering without
  // tools (observed 2026-09-06). Only a DOC scope may take the wider budget.
  it('gives a doc scope 12 turns and a thread scope 6', () => {
    expect(historyLimitFor(doc)).toBe(MAX_SENT_TURNS);
    expect(historyLimitFor(doc)).toBe(12);
    expect(historyLimitFor(thread)).toBe(MAX_AGENT_TURNS);
    expect(historyLimitFor(thread)).toBe(6);
  });

  it('gives an unscoped ask 6 turns', () => {
    expect(historyLimitFor(null)).toBe(6);
  });
});

describe('buildPinned', () => {
  const gathered = { text: 'thread text', messageIds: ['m7', 'm8', 'm9'] };

  it('labels with the subject and always carries the message ids', () => {
    const p = buildPinned(thread, gathered);
    expect(p.label).toBe('Re: RHEMIS inception report');
    expect(p.text).toBe('thread text');
    expect(p.messageIds).toEqual(['m7', 'm8', 'm9']);
  });

  it('omits toolScope when unlocked and sets it to "thread" when locked', () => {
    expect(buildPinned(thread, gathered).toolScope).toBeUndefined();
    expect(buildPinned({ ...thread, locked: true }, gathered).toolScope).toBe('thread');
  });

  it('falls back to a readable label when the subject is null', () => {
    const p = buildPinned({ ...thread, subject: null }, gathered);
    expect(p.label).toBe('(no subject)');
  });
});
