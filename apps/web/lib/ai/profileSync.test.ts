import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncAiProfile } from './profileSync';
import { useAIStore } from '@/stores/ai.store';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    settings: {
      getAiProfile: vi.fn(),
      updateAiProfile: vi.fn(),
    },
  },
}));

const NULL_PROFILE = {
  instructions: null,
  jobTitle: null,
  institution: null,
  department: null,
  language: null,
};

function setUser(email: string | null) {
  useAuthStore.setState({
    user: email ? { id: 'u1', email, displayName: 'Test User', zimbraHost: 'z.example.com' } : null,
  });
}

describe('syncAiProfile', () => {
  beforeEach(() => {
    vi.mocked(api.settings.getAiProfile).mockReset();
    vi.mocked(api.settings.updateAiProfile).mockReset();
    useAIStore.getState().setCustomInstructions('');
    useAIStore.getState().setProfileSyncedFor(null);
    setUser('alice@x.rw');
  });

  it('no authenticated user → no-op, no GET called', async () => {
    setUser(null);
    await syncAiProfile();
    expect(api.settings.getAiProfile).not.toHaveBeenCalled();
  });

  it('server value present → store updated to server value', async () => {
    useAIStore.getState().setCustomInstructions('');
    vi.mocked(api.settings.getAiProfile).mockResolvedValue({
      ...NULL_PROFILE,
      instructions: 'Always cite sources.',
    });

    await syncAiProfile();

    expect(useAIStore.getState().customInstructions).toBe('Always cite sources.');
    expect(api.settings.updateAiProfile).not.toHaveBeenCalled();
  });

  it('legacy first-sync: server empty + local set → updateAiProfile called with local value; store unchanged; marker set', async () => {
    useAIStore.getState().setCustomInstructions('Keep replies short.');
    vi.mocked(api.settings.getAiProfile).mockResolvedValue({ ...NULL_PROFILE });
    vi.mocked(api.settings.updateAiProfile).mockResolvedValue({ ...NULL_PROFILE });

    await syncAiProfile();

    expect(api.settings.updateAiProfile).toHaveBeenCalledWith({ instructions: 'Keep replies short.' });
    expect(useAIStore.getState().customInstructions).toBe('Keep replies short.');
    expect(useAIStore.getState().profileSyncedFor).toBe('alice@x.rw');
  });

  it('both empty → nothing called beyond the GET', async () => {
    useAIStore.getState().setCustomInstructions('');
    vi.mocked(api.settings.getAiProfile).mockResolvedValue({ ...NULL_PROFILE });

    await syncAiProfile();

    expect(api.settings.updateAiProfile).not.toHaveBeenCalled();
    expect(useAIStore.getState().customInstructions).toBe('');
  });

  it('GET rejects → store unchanged, no throw', async () => {
    useAIStore.getState().setCustomInstructions('Keep replies short.');
    vi.mocked(api.settings.getAiProfile).mockRejectedValue(new Error('network down'));

    await expect(syncAiProfile()).resolves.toBeUndefined();

    expect(api.settings.updateAiProfile).not.toHaveBeenCalled();
    expect(useAIStore.getState().customInstructions).toBe('Keep replies short.');
  });

  it('resurrection: profileSyncedFor already this user, server empty, local non-empty → NO upward PATCH, store cleared to server value', async () => {
    useAIStore.getState().setProfileSyncedFor('alice@x.rw');
    useAIStore.getState().setCustomInstructions('Old device-only text that should not resurrect.');
    vi.mocked(api.settings.getAiProfile).mockResolvedValue({ ...NULL_PROFILE });

    await syncAiProfile();

    expect(api.settings.updateAiProfile).not.toHaveBeenCalled();
    expect(useAIStore.getState().customInstructions).toBe('');
  });

  it('cross-user: profileSyncedFor is a different user, local non-empty → local cleared first, no PATCH of the other user\'s text, ends with current server value', async () => {
    useAIStore.getState().setProfileSyncedFor('a@x.rw');
    useAIStore.getState().setCustomInstructions("A's private instructions.");
    setUser('b@x.rw');
    vi.mocked(api.settings.getAiProfile).mockResolvedValue({
      ...NULL_PROFILE,
      instructions: "B's server instructions.",
    });

    await syncAiProfile();

    expect(api.settings.updateAiProfile).not.toHaveBeenCalled();
    expect(useAIStore.getState().customInstructions).toBe("B's server instructions.");
    expect(useAIStore.getState().profileSyncedFor).toBe('b@x.rw');
  });

  it('cross-user with server empty → local cleared, never upward-migrated, marker updated', async () => {
    useAIStore.getState().setProfileSyncedFor('a@x.rw');
    useAIStore.getState().setCustomInstructions("A's private instructions.");
    setUser('b@x.rw');
    vi.mocked(api.settings.getAiProfile).mockResolvedValue({ ...NULL_PROFILE });

    await syncAiProfile();

    expect(api.settings.updateAiProfile).not.toHaveBeenCalled();
    expect(useAIStore.getState().customInstructions).toBe('');
    expect(useAIStore.getState().profileSyncedFor).toBe('b@x.rw');
  });

  it('syncs the profile card (jobTitle/institution/department/language) into the store on every successful GET', async () => {
    vi.mocked(api.settings.getAiProfile).mockResolvedValue({
      instructions: null,
      jobTitle: 'Director',
      institution: 'RISA',
      department: 'ICT',
      language: 'en',
    });

    await syncAiProfile();

    expect(useAIStore.getState().profileCard).toEqual({
      jobTitle: 'Director',
      institution: 'RISA',
      department: 'ICT',
      language: 'en',
    });
  });
});
