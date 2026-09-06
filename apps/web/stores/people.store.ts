'use client';

import { create } from 'zustand';
import { useAskStore } from './ask.store';

export interface DossierTarget {
  email: string;
  /** Display-name hint from the click site (fromName / attendee name) — the facts fetch refines it. */
  name?: string | null;
}

/**
 * Person dossier panel state — single mount in the app layout, same pattern
 * as ask.store. The dossier and Ask panels are MUTUALLY EXCLUSIVE when
 * docked (Bruce, 2026-09-06): opening one closes the other. This side closes
 * Ask directly; the reverse direction lives in PersonDossierPanel's effect
 * (watching ask.open) to avoid a store import cycle.
 */
interface PeopleState {
  open: boolean;
  target: DossierTarget | null;
  openDossier: (t: DossierTarget) => void;
  close: () => void;
}

export const usePeopleStore = create<PeopleState>((set) => ({
  open: false,
  target: null,
  openDossier: (t) => {
    useAskStore.getState().close();
    set({ open: true, target: { ...t, email: t.email.trim().toLowerCase() } });
  },
  close: () => set({ open: false, target: null }),
}));
