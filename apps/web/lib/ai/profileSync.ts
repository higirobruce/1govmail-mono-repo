'use client';

import { useEffect } from 'react';
import { api } from '@/lib/api';
import { useAIStore } from '@/stores/ai.store';
import { useAuthStore } from '@/stores/auth.store';

/**
 * One-time-per-account reconciliation between the account-level AI profile
 * (server, cross-device) and the local store's custom instructions
 * (device-level, predates the account profile) — plus a continuous mirror of
 * the identity-card fields (job title/institution/department/language) used
 * by suggestReply/rewrite/docs tasks.
 *
 * The store is user-agnostic storage on a shared device, so every sync is
 * keyed against the CURRENTLY authenticated user (`useAuthStore`), never
 * just "whatever's in the store":
 *
 *  - No authenticated user            → no-op (nothing to key the sync to).
 *  - `profileSyncedFor` names a DIFFERENT user than the one signed in now →
 *    a previous account's local instructions may still be sitting in this
 *    device's store. They are cleared FIRST and NEVER upward-migrated —
 *    only the true legacy (pre-account, `profileSyncedFor === null`) value
 *    is eligible for the one-time upward migration below.
 *  - Server has instructions            → server wins; store is overwritten.
 *  - Server is empty, local is non-empty, AND `profileSyncedFor === null`
 *    (first-ever sync on this device) → one-time upward migration: PATCH
 *    the local value to the server, and keep using the local value.
 *  - Both empty                         → nothing to migrate.
 *  - GET failure                        → silent no-op (offline-safe).
 *
 * After any successful sync, `profileSyncedFor` is set to the current
 * user's email so a later sync can tell a resurrection/cross-user case from
 * a true first-ever sync.
 */
export async function syncAiProfile(): Promise<void> {
  const email = useAuthStore.getState().user?.email;
  if (!email) return;

  let profile;
  try {
    profile = await api.settings.getAiProfile();
  } catch {
    return;
  }

  const store = useAIStore.getState();

  // Mirror the identity-card fields on every successful GET, independent of
  // the instructions migration logic below.
  store.setProfileCard({
    jobTitle: profile.jobTitle,
    institution: profile.institution,
    department: profile.department,
    language: profile.language,
  });

  const syncedFor = store.profileSyncedFor;

  if (syncedFor !== null && syncedFor !== email) {
    // A different user's data may be sitting in this device's store — reset
    // it locally FIRST, before any migration decision, so it can never be
    // read below as "local instructions to migrate up".
    useAIStore.getState().setCustomInstructions('');
  }

  const serverInstructions = profile.instructions ?? '';
  const localInstructions = useAIStore.getState().customInstructions;

  if (syncedFor === null && !serverInstructions && localInstructions) {
    // First-ever sync on this device: the local value predates any account
    // — it's the true legacy value, migrate it up once.
    try {
      await api.settings.updateAiProfile({ instructions: localInstructions });
    } catch {
      // Migration PATCH failing is non-fatal — the local value is already in use.
    }
    useAIStore.getState().setProfileSyncedFor(email);
    return;
  }

  useAIStore.getState().setCustomInstructions(serverInstructions);
  useAIStore.getState().setProfileSyncedFor(email);
}

// Guards against re-syncing the SAME user twice per mount (e.g. React
// StrictMode's dev double-invoke of effects) while still allowing a resync
// when a different user signs in without a full page reload — logout then
// login as someone else on the same device unmounts/remounts the mount
// point (see AiProfileSyncMount's JSDoc), so keying this by email (rather
// than a plain once-ever boolean) lets that resync happen.
let syncedForEmail: string | null = null;

/** Mounts the account↔device AI-profile sync once per signed-in user per app load. */
export function useAiProfileSync(): void {
  useEffect(() => {
    const email = useAuthStore.getState().user?.email ?? null;
    if (!email || syncedForEmail === email) return;
    syncedForEmail = email;
    void syncAiProfile();
  }, []);
}
