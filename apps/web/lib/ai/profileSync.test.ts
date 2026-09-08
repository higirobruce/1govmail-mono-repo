import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncAiProfile } from './profileSync';
import { useAIStore } from '@/stores/ai.store';
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

describe('syncAiProfile', () => {
  beforeEach(() => {
    vi.mocked(api.settings.getAiProfile).mockReset();
    vi.mocked(api.settings.updateAiProfile).mockReset();
    useAIStore.getState().setCustomInstructions('');
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

  it('server empty + local set → updateAiProfile called with local value; store unchanged', async () => {
    useAIStore.getState().setCustomInstructions('Keep replies short.');
    vi.mocked(api.settings.getAiProfile).mockResolvedValue({ ...NULL_PROFILE });
    vi.mocked(api.settings.updateAiProfile).mockResolvedValue({ ...NULL_PROFILE });

    await syncAiProfile();

    expect(api.settings.updateAiProfile).toHaveBeenCalledWith({ instructions: 'Keep replies short.' });
    expect(useAIStore.getState().customInstructions).toBe('Keep replies short.');
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
});
