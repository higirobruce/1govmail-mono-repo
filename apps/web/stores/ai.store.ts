'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AI_LOCKED, LOCKED_AI_MODEL } from '@/lib/ai/config';

/**
 * AI feature settings. The endpoint and credentials live on the server —
 * the browser only chooses whether AI is on and which model name to send.
 */
export interface AIState {
  enabled: boolean;
  model: string;
  /** Free-form style preferences appended to every AI task's system prompt. */
  customInstructions: string;
  setEnabled: (v: boolean) => void;
  setModel: (v: string) => void;
  setCustomInstructions: (v: string) => void;
}

export const useAIStore = create<AIState>()(
  persist(
    (set) => ({
      enabled: AI_LOCKED ? true : false,
      model: LOCKED_AI_MODEL ?? 'gemma2:2b',
      customInstructions: '',
      setEnabled: (enabled) => { if (!AI_LOCKED) set({ enabled }); },
      setModel: (model) => { if (!AI_LOCKED) set({ model }); },
      setCustomInstructions: (customInstructions) => set({ customInstructions }),
    }),
    {
      name: '1gov-ai',
      // Locked deployments: persisted values may pre-date the lock — the env
      // always wins for enabled/model. Custom instructions still persist.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<AIState>) };
        if (AI_LOCKED) {
          merged.enabled = true;
          merged.model = LOCKED_AI_MODEL as string;
        }
        return merged;
      },
    },
  ),
);
