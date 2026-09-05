'use client';

import { create } from 'zustand';

export interface AskScope { docId: string; docTitle: string }

export interface LinkedCommitment { id: string; messageId: string; text: string }

/**
 * Mail-page-only wiring: when set, AskPanel docks as an xl split-pane and
 * routes mail-source clicks through these in-page callbacks instead of a
 * router navigation. The mail page registers/clears this in an effect —
 * it's the only page with in-place message viewing, and it's the only
 * consumer of AskLauncher's single <AskPanel/> mount that needs it.
 */
export interface AskHandlers {
  onOpenMessage: (messageId: string) => void;
  onReplyToMessage: (messageId: string) => void;
  /** Open commitments to cross-reference against sources ("Linked commitment: …") — mail-only enrichment. */
  linkedCommitments?: LinkedCommitment[];
}

interface AskState {
  open: boolean;
  collapsed: boolean;
  prefill: string | null;
  scope: AskScope | null;
  handlers: AskHandlers | null;
  /** Opens + un-collapses; sets whichever of prefill/scope are passed, leaving the other untouched. */
  openAsk: (opts?: { prefill?: string; scope?: AskScope }) => void;
  collapse: () => void;
  /** Clears BOTH scope and prefill; keeps the panel closed/open as it was — pair with openAsk() for a fresh unscoped open. */
  close: () => void;
  /** Clears scope only — keeps the panel open. */
  clearScope: () => void;
  /** Registers (or clears, with null) the mail page's in-page handlers. */
  setHandlers: (handlers: AskHandlers | null) => void;
}

export const useAskStore = create<AskState>((set) => ({
  open: false,
  collapsed: false,
  prefill: null,
  scope: null,
  handlers: null,
  openAsk: (opts) => set((s) => ({
    open: true,
    collapsed: false,
    prefill: opts?.prefill !== undefined ? opts.prefill : s.prefill,
    scope: opts?.scope !== undefined ? opts.scope : s.scope,
  })),
  collapse: () => set({ collapsed: true }),
  close: () => set({ open: false, collapsed: false, scope: null, prefill: null }),
  clearScope: () => set({ scope: null }),
  setHandlers: (handlers) => set({ handlers }),
}));
