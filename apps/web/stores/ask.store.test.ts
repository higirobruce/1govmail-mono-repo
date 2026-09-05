import { describe, it, expect, beforeEach } from 'vitest';
import { useAskStore } from './ask.store';

const SCOPE = { docId: 'doc-1', docTitle: 'Budget Memo' };

describe('useAskStore', () => {
  beforeEach(() => {
    useAskStore.setState({ open: false, collapsed: false, prefill: null, scope: null, handlers: null });
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

  it('setHandlers() registers and clears the mail page\'s in-page handlers', () => {
    expect(useAskStore.getState().handlers).toBeNull();
    const handlers = { onOpenMessage: () => {}, onReplyToMessage: () => {} };
    useAskStore.getState().setHandlers(handlers);
    expect(useAskStore.getState().handlers).toBe(handlers);
    useAskStore.getState().setHandlers(null);
    expect(useAskStore.getState().handlers).toBeNull();
  });
});
