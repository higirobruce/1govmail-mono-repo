'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { AI_LOCKED, LOCKED_AI_MODEL } from '@/lib/ai/config';

/**
 * The account owner's identity-card fields, mirrored locally from the
 * account-level AI profile so suggestReply/rewrite/docs tasks can render
 * them without an async fetch on every call (see lib/ai/profileSync.ts).
 */
export interface AIProfileCard {
  jobTitle: string | null;
  institution: string | null;
  department: string | null;
  language: string | null;
}

const EMPTY_PROFILE_CARD: AIProfileCard = {
  jobTitle: null,
  institution: null,
  department: null,
  language: null,
};

/**
 * AI feature settings. The endpoint and credentials live on the server —
 * the browser only chooses whether AI is on and which model name to send.
 */
export interface AIState {
  enabled: boolean;
  model: string;
  /** Free-form style preferences appended to every AI task's system prompt. */
  customInstructions: string;
  /** Identity-card fields mirrored from the account-level AI profile. */
  profileCard: AIProfileCard;
  /**
   * The email of the user whose account this device's store last synced
   * with (see lib/ai/profileSync.ts). `null` means this device has never
   * completed an account sync — the legacy pre-account state.
   */
  profileSyncedFor: string | null;
  setEnabled: (v: boolean) => void;
  setModel: (v: string) => void;
  setCustomInstructions: (v: string) => void;
  setProfileCard: (v: AIProfileCard) => void;
  setProfileSyncedFor: (v: string | null) => void;
}

export const useAIStore = create<AIState>()(
  persist(
    (set) => ({
      enabled: AI_LOCKED ? true : false,
      model: LOCKED_AI_MODEL ?? 'gemma2:2b',
      customInstructions: '',
      profileCard: EMPTY_PROFILE_CARD,
      profileSyncedFor: null,
      setEnabled: (enabled) => { if (!AI_LOCKED) set({ enabled }); },
      setModel: (model) => { if (!AI_LOCKED) set({ model }); },
      setCustomInstructions: (customInstructions) => set({ customInstructions }),
      setProfileCard: (profileCard) => set({ profileCard }),
      setProfileSyncedFor: (profileSyncedFor) => set({ profileSyncedFor }),
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
