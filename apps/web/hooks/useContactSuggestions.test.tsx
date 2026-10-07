import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useContactSuggestions } from './useContactSuggestions';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { contacts: { autocomplete: vi.fn() } },
}));

const autocomplete = api.contacts.autocomplete as unknown as ReturnType<typeof vi.fn>;

const GROUP = {
  kind: 'group' as const,
  groupId: 'g1',
  display: 'Finance Team',
  memberCount: 2,
  members: [{ email: 'a@risa.gov.rw' }, { email: 'b@risa.gov.rw' }],
};
const ADDRESS = { email: 'alice@risa.gov.rw', display: 'Alice' };

describe('useContactSuggestions', () => {
  beforeEach(() => {
    autocomplete.mockReset();
    autocomplete.mockResolvedValue([GROUP, ADDRESS]);
  });

  // Review Focus #4 — Advanced Search's existing test asserts the client is
  // called with exactly one argument. The default path must not change arity.
  it('calls the client with only the query when groups are not requested', async () => {
    renderHook(() => useContactSuggestions('fin'));
    await waitFor(() => expect(autocomplete).toHaveBeenCalled(), { timeout: 2000 });
    expect(autocomplete.mock.calls[0]).toEqual(['fin']);
  });

  it('asks for groups when includeGroups is set', async () => {
    renderHook(() => useContactSuggestions('fin', { includeGroups: true }));
    await waitFor(() => expect(autocomplete).toHaveBeenCalled(), { timeout: 2000 });
    expect(autocomplete.mock.calls[0]).toEqual(['fin', { includeGroups: true }]);
  });

  // Review Focus #3 — a group suggestion has no `email`; the exclude filter
  // must neither crash nor drop it.
  it('never excludes a group, even when its members are already chips', async () => {
    const { result } = renderHook(() =>
      useContactSuggestions('fin', {
        includeGroups: true,
        exclude: ['alice@risa.gov.rw', 'a@risa.gov.rw'],
      }),
    );
    await waitFor(() => expect(result.current.suggestions.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(result.current.suggestions).toEqual([GROUP]);
  });
});
