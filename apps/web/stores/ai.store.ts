'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * AI feature settings. The endpoint and credentials live on the server —
 * the browser only chooses whether AI is on and which model name to send.
 */
export interface AIState {
  enabled: boolean;
  model: string;
  setEnabled: (v: boolean) => void;
  setModel: (v: string) => void;
}

export const useAIStore = create<AIState>()(
  persist(
    (set) => ({
      enabled: false,
      model: 'gemma2:2b',
      setEnabled: (enabled) => set({ enabled }),
      setModel: (model) => set({ model }),
    }),
    { name: '1gov-ai' },
  ),
);
