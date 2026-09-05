'use client';

import { create } from 'zustand';

export interface AskScope { docId: string; docTitle: string }

interface AskState {
  open: boolean;
  collapsed: boolean;
  prefill: string | null;
  scope: AskScope | null;
  /** Opens + un-collapses; sets whichever of prefill/scope are passed, leaving the other untouched. */
  openAsk: (opts?: { prefill?: string; scope?: AskScope }) => void;
  collapse: () => void;
  /** Clears BOTH scope and prefill; keeps the panel closed/open as it was — pair with openAsk() for a fresh unscoped open. */
  close: () => void;
  /** Clears scope only — keeps the panel open. */
  clearScope: () => void;
}

export const useAskStore = create<AskState>((set) => ({
  open: false,
  collapsed: false,
  prefill: null,
  scope: null,
  openAsk: (opts) => set((s) => ({
    open: true,
    collapsed: false,
    prefill: opts?.prefill !== undefined ? opts.prefill : s.prefill,
    scope: opts?.scope !== undefined ? opts.scope : s.scope,
  })),
  collapse: () => set({ collapsed: true }),
  close: () => set({ open: false, collapsed: false, scope: null, prefill: null }),
  clearScope: () => set({ scope: null }),
}));
