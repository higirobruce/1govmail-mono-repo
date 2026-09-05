import { describe, it, expect, beforeEach } from 'vitest';
import { useAskStore } from './ask.store';

const SCOPE = { docId: 'doc-1', docTitle: 'Budget Memo' };

describe('useAskStore', () => {
  beforeEach(() => {
    useAskStore.setState({ open: false, collapsed: false, prefill: null, scope: null, handlers: null, openTarget: null });
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
});
