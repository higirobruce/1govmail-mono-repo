'use client';

import { useEffect } from 'react';
import { api } from '@/lib/api';
import { useAIStore } from '@/stores/ai.store';

/**
 * One-time reconciliation between the account-level AI profile (server,
 * cross-device) and the local store's custom instructions (device-level,
 * predates the account profile).
 *
 * Rules:
 *  - Server has instructions            → server wins; store is overwritten.
 *  - Server is empty, local is non-empty → one-time upward migration: PATCH
 *    the local value to the server, and keep using the local value.
 *  - Both empty                         → nothing to migrate.
 *  - GET failure                        → silent no-op (offline-safe).
 */
export async function syncAiProfile(): Promise<void> {
  let profile;
  try {
    profile = await api.settings.getAiProfile();
  } catch {
    return;
  }

  const serverInstructions = profile.instructions ?? '';
  const localInstructions = useAIStore.getState().customInstructions;

  if (!serverInstructions && localInstructions) {
    try {
      await api.settings.updateAiProfile({ instructions: localInstructions });
    } catch {
      // Migration PATCH failing is non-fatal — the local value is already in use.
    }
    return;
  }

  useAIStore.getState().setCustomInstructions(serverInstructions);
}

// Guards against firing twice from React StrictMode's dev double-invoke of
// effects — a second run would be harmless (idempotent GET/PATCH) but there's
// no reason to make two network calls per app load.
let hasSyncedThisLoad = false;

/** Mounts the account↔device AI-profile sync once per app load. */
export function useAiProfileSync(): void {
  useEffect(() => {
    if (hasSyncedThisLoad) return;
    hasSyncedThisLoad = true;
    void syncAiProfile();
  }, []);
}
