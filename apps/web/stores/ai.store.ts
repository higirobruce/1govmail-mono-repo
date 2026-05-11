'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AIState {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  setEnabled: (v: boolean) => void;
  setBaseUrl: (v: string) => void;
  setModel: (v: string) => void;
  setApiKey: (v: string) => void;
}

export const useAIStore = create<AIState>()(
  persist(
    (set) => ({
      enabled: false,
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
      apiKey: '',
      setEnabled: (enabled) => set({ enabled }),
      setBaseUrl: (baseUrl) => set({ baseUrl }),
      setModel: (model) => set({ model }),
      setApiKey: (apiKey) => set({ apiKey }),
    }),
    { name: '1gov-ai' },
  ),
);
