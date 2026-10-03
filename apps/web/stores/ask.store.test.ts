import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAskStore } from './ask.store';

// Captured before any test's beforeEach can reset it, so this reflects the
// store's real default from create() rather than the fixture's forced reset.
const DEFAULT_RESUME_ID = useAskStore.getState().resumeId;

const SCOPE = { kind: 'doc', docId: 'doc-1', docTitle: 'Budget Memo' } as const;

const THREAD_SCOPE = {
  kind: 'thread',
  conversationId: 'c-1',
  seedMessageId: 'm-9',
  subject: 'Re: RHEMIS inception report',
  messageCount: 6,
  locked: false,
} as const;

describe('useAskStore', () => {
  beforeEach(() => {
    useAskStore.setState({ open: false, collapsed: false, prefill: null, scope: null, handlers: null, openTarget: null, resumeId: null });
  });

  it('starts closed, expanded, unscoped, unprefilled', () => {
    const s = useAskStore.getState();
    expect(s.open).toBe(false);
    expect(s.collapsed).toBe(false);
    expect(s.prefill).toBeNull();
    expect(s.scope).toBeNull();
  });

  it('openAsk() with no opts opens and un-collapses, leaving prefill/scope untouched', () => {
    useAskStore.setState({ collapsed: true });
    useAskStore.getState().openAsk();
    const s = useAskStore.getState();
    expect(s.open).toBe(true);
    expect(s.collapsed).toBe(false);
    expect(s.prefill).toBeNull();
    expect(s.scope).toBeNull();
  });

  it('openAsk({scope}) sets scope + open, leaving prefill untouched', () => {
    useAskStore.getState().openAsk({ scope: SCOPE });
    const s = useAskStore.getState();
    expect(s.open).toBe(true);
    expect(s.collapsed).toBe(false);
    expect(s.scope).toEqual(SCOPE);
    expect(s.prefill).toBeNull();
  });

  it('openAsk({prefill}) sets prefill + open, leaving scope untouched', () => {
    useAskStore.getState().openAsk({ scope: SCOPE });
    useAskStore.getState().openAsk({ prefill: 'summarize this' });
    const s = useAskStore.getState();
    expect(s.open).toBe(true);
    expect(s.prefill).toBe('summarize this');
    // scope from the earlier openAsk call is untouched by this call
    expect(s.scope).toEqual(SCOPE);
  });

  it('openAsk re-opening un-collapses even when scope/prefill are already set', () => {
    useAskStore.getState().openAsk({ scope: SCOPE, prefill: 'x' });
    useAskStore.getState().collapse();
    expect(useAskStore.getState().collapsed).toBe(true);
    useAskStore.getState().openAsk();
    const s = useAskStore.getState();
    expect(s.collapsed).toBe(false);
    expect(s.open).toBe(true);
    expect(s.scope).toEqual(SCOPE);
    expect(s.prefill).toBe('x');
  });

  it('collapse() collapses without closing', () => {
    useAskStore.getState().openAsk();
    useAskStore.getState().collapse();
    const s = useAskStore.getState();
    expect(s.open).toBe(true);
    expect(s.collapsed).toBe(true);
  });

  it('clearScope() clears scope but keeps the panel open', () => {
    useAskStore.getState().openAsk({ scope: SCOPE, prefill: 'x' });
    useAskStore.getState().clearScope();
    const s = useAskStore.getState();
    expect(s.scope).toBeNull();
    expect(s.open).toBe(true);
    expect(s.prefill).toBe('x'); // clearScope only touches scope
  });

  it('close() clears BOTH scope and prefill — a fresh open is unscoped unless asked', () => {
    useAskStore.getState().openAsk({ scope: SCOPE, prefill: 'x' });
    useAskStore.getState().close();
    const s = useAskStore.getState();
    expect(s.open).toBe(false);
    expect(s.scope).toBeNull();
    expect(s.prefill).toBeNull();

    // a subsequent unscoped open really is unscoped
    useAskStore.getState().openAsk();
    expect(useAskStore.getState().scope).toBeNull();
    expect(useAskStore.getState().prefill).toBeNull();
  });

  describe('openTarget — the same-route "open this source here" signal', () => {
    it('starts null', () => {
      expect(useAskStore.getState().openTarget).toBeNull();
    });

    it('setOpenTarget() publishes a typed target the owning page can consume', () => {
      useAskStore.getState().setOpenTarget({ type: 'doc', id: 'doc-9' });
      expect(useAskStore.getState().openTarget).toEqual({ type: 'doc', id: 'doc-9' });
    });

    it('clearOpenTarget() consumes it', () => {
      useAskStore.getState().setOpenTarget({ type: 'event', id: 'ev-1' });
      useAskStore.getState().clearOpenTarget();
      expect(useAskStore.getState().openTarget).toBeNull();
    });

    it('a second setOpenTarget replaces an unconsumed one', () => {
      useAskStore.getState().setOpenTarget({ type: 'doc', id: 'doc-1' });
      useAskStore.getState().setOpenTarget({ type: 'doc', id: 'doc-2' });
      expect(useAskStore.getState().openTarget).toEqual({ type: 'doc', id: 'doc-2' });
    });

    it('re-publishing the SAME target is a new object identity, so a subscribing effect re-fires', () => {
      useAskStore.getState().setOpenTarget({ type: 'doc', id: 'doc-1' });
      const first = useAskStore.getState().openTarget;
      useAskStore.getState().clearOpenTarget();
      useAskStore.getState().setOpenTarget({ type: 'doc', id: 'doc-1' });
      expect(useAskStore.getState().openTarget).not.toBe(first);
      expect(useAskStore.getState().openTarget).toEqual({ type: 'doc', id: 'doc-1' });
    });

    it('close() leaves a pending openTarget alone — it is a navigation signal, not panel state', () => {
      useAskStore.getState().setOpenTarget({ type: 'event', id: 'ev-2' });
      useAskStore.getState().close();
      expect(useAskStore.getState().openTarget).toEqual({ type: 'event', id: 'ev-2' });
    });
  });

  it('setHandlers() registers and clears the mail page\'s in-page handlers', () => {
    expect(useAskStore.getState().handlers).toBeNull();
    const handlers = { onOpenMessage: () => {}, onReplyToMessage: () => {} };
    useAskStore.getState().setHandlers(handlers);
    expect(useAskStore.getState().handlers).toBe(handlers);
    useAskStore.getState().setHandlers(null);
    expect(useAskStore.getState().handlers).toBeNull();
  });

  describe('resumeId — the history page\'s handoff to AskPanel', () => {
    it('starts null', () => {
      // Asserts the store's actual default (captured pre-beforeEach), not the
      // fixture's forced reset — the latter would pass even if create() never
      // set resumeId at all.
      expect(DEFAULT_RESUME_ID).toBeNull();
    });

    it('resumeConversation() sets resumeId and opens + un-collapses the panel', () => {
      useAskStore.setState({ collapsed: true });
      useAskStore.getState().resumeConversation('conv-1');
      const s = useAskStore.getState();
      expect(s.resumeId).toBe('conv-1');
      expect(s.open).toBe(true);
      expect(s.collapsed).toBe(false);
    });

    it('takeResumeId() reads and clears the pending id', () => {
      useAskStore.getState().resumeConversation('conv-2');
      expect(useAskStore.getState().takeResumeId()).toBe('conv-2');
      expect(useAskStore.getState().resumeId).toBeNull();
    });

    it('takeResumeId() returns null and is a no-op when nothing is pending', () => {
      // "No-op" means the store never notifies of a state change, not merely
      // that resumeId ends up null (it would be null either way). Subscribing
      // catches an unconditional clear that would still leave resumeId at
      // null but would still call set() internally.
      // (vi.spyOn(useAskStore, 'setState') would NOT catch this: the store
      // creator's `set` closure is bound to the internal setState directly,
      // not looked up through the api object's property each call.)
      const listener = vi.fn();
      const unsub = useAskStore.subscribe(listener);
      expect(useAskStore.getState().takeResumeId()).toBeNull();
      expect(listener).not.toHaveBeenCalled();
      expect(useAskStore.getState().resumeId).toBeNull();
      unsub();
    });
  });
});

describe('thread scope', () => {
  it('openAsk() accepts a thread scope', () => {
    useAskStore.getState().openAsk({ scope: { ...THREAD_SCOPE } });
    const s = useAskStore.getState();
    expect(s.open).toBe(true);
    expect(s.scope).toEqual(THREAD_SCOPE);
  });

  it('toggleScopeLock() flips locked on a thread scope', () => {
    useAskStore.getState().openAsk({ scope: { ...THREAD_SCOPE } });
    useAskStore.getState().toggleScopeLock();
    expect((useAskStore.getState().scope as any).locked).toBe(true);
    useAskStore.getState().toggleScopeLock();
    expect((useAskStore.getState().scope as any).locked).toBe(false);
  });

  it('toggleScopeLock() is a no-op on a doc scope and on a null scope', () => {
    useAskStore.getState().openAsk({ scope: { ...SCOPE } });
    useAskStore.getState().toggleScopeLock();
    expect(useAskStore.getState().scope).toEqual(SCOPE);

    useAskStore.setState({ scope: null });
    useAskStore.getState().toggleScopeLock();
    expect(useAskStore.getState().scope).toBeNull();
  });

  it('clearScope() drops a thread scope but keeps the panel open', () => {
    useAskStore.getState().openAsk({ scope: { ...THREAD_SCOPE } });
    useAskStore.getState().clearScope();
    const s = useAskStore.getState();
    expect(s.scope).toBeNull();
    expect(s.open).toBe(true);
  });

  it('close() clears a thread scope', () => {
    useAskStore.getState().openAsk({ scope: { ...THREAD_SCOPE } });
    useAskStore.getState().close();
    expect(useAskStore.getState().scope).toBeNull();
  });
});
