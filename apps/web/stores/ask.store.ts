'use client';

import { create } from 'zustand';

export interface AskDocScope { kind: 'doc'; docId: string; docTitle: string }

/**
 * "Ask about this thread" — the thread is pinned as guaranteed context while
 * the rest of the mailbox stays reachable, unless `locked`. Unlike a doc
 * scope this rides the AGENT path, not retrieval: see threadPin.ts.
 */
export interface AskThreadScope {
  kind: 'thread';
  /** Thread identity. Null for a message that is not part of a conversation — seedMessageId is then the identity. */
  conversationId: string | null;
  /** The message the ask started from; gatherThreadContent resolves the thread through it. */
  seedMessageId: string;
  subject: string | null;
  /** True thread length. May exceed what actually gets pinned once budgeted. */
  messageCount: number;
  /** "this thread only" — narrows the agent's tools server-side. */
  locked: boolean;
}

export type AskScope = AskDocScope | AskThreadScope;

/**
 * A "open this source here" signal for the page the user is already on.
 * Cross-route chip clicks navigate (`/docs?open=…`, `/calendar?event=…`) and
 * the target page's deep-link effect consumes the param. Those effects are
 * consume-once and mount-gated, though, so a same-route `router.push` of the
 * same URL shape never re-fires them — the panel publishes this instead, and
 * the docs/calendar pages consume-and-clear it whenever the type is theirs.
 */
export interface AskOpenTarget { type: 'mail' | 'doc' | 'event'; id: string }

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
  /** Pending same-route "open this source" signal; the owning page consumes and clears it. */
  openTarget: AskOpenTarget | null;
  /** Opens + un-collapses; sets whichever of prefill/scope are passed, leaving the other untouched. */
  openAsk: (opts?: { prefill?: string; scope?: AskScope }) => void;
  collapse: () => void;
  /** Sets open:false (leaving collapsed:false) and clears BOTH scope and prefill — pair with openAsk() for a fresh unscoped open. */
  close: () => void;
  /** Clears scope only — keeps the panel open. */
  clearScope: () => void;
  /** Flips "this thread only". No-op unless the current scope is a thread scope. */
  toggleScopeLock: () => void;
  /** Registers (or clears, with null) the mail page's in-page handlers. */
  setHandlers: (handlers: AskHandlers | null) => void;
  /** Publishes a same-route open request; replaces any unconsumed one. */
  setOpenTarget: (target: AskOpenTarget) => void;
  /** Consumes the signal — called by the page that acted on it. */
  clearOpenTarget: () => void;
}

export const useAskStore = create<AskState>((set) => ({
  open: false,
  collapsed: false,
  prefill: null,
  scope: null,
  handlers: null,
  openTarget: null,
  openAsk: (opts) => set((s) => ({
    open: true,
    collapsed: false,
    prefill: opts?.prefill !== undefined ? opts.prefill : s.prefill,
    scope: opts?.scope !== undefined ? opts.scope : s.scope,
  })),
  collapse: () => set({ collapsed: true }),
  close: () => set({ open: false, collapsed: false, scope: null, prefill: null }),
  clearScope: () => set({ scope: null }),
  toggleScopeLock: () => set((s) => (
    s.scope?.kind === 'thread' ? { scope: { ...s.scope, locked: !s.scope.locked } } : {}
  )),
  setHandlers: (handlers) => set({ handlers }),
  setOpenTarget: (target) => set({ openTarget: target }),
  clearOpenTarget: () => set({ openTarget: null }),
}));
