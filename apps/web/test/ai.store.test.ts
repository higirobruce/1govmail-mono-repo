import { describe, it, expect } from 'vitest';
import { useAIStore } from '@/stores/ai.store';

describe('ai store custom instructions', () => {
  it('defaults to empty and round-trips a value', () => {
    expect(useAIStore.getState().customInstructions).toBe('');
    useAIStore.getState().setCustomInstructions('Keep replies short.');
    expect(useAIStore.getState().customInstructions).toBe('Keep replies short.');
  });
});
