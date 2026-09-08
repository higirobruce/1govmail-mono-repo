import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const dossier = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    people: {
      dossier: (...a: unknown[]) => dossier(...(a as [])),
    },
  },
}));

const getCachedDossier = vi.fn();
const streamDossier = vi.fn();
vi.mock('@/lib/ai/generation', () => ({
  getCachedDossier: (...a: unknown[]) => getCachedDossier(...(a as [])),
  streamDossier: (...a: unknown[]) => streamDossier(...(a as [])),
}));

const push = vi.fn();
const replace = vi.fn();
let mockPathname = '/docs';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (...a: unknown[]) => push(...a), replace: (...a: unknown[]) => replace(...a) }),
  usePathname: () => mockPathname,
}));

import PersonDossierPanel from './PersonDossierPanel';
import { usePeopleStore } from '@/stores/people.store';
import { useAskStore } from '@/stores/ask.store';
import { useAIStore } from '@/stores/ai.store';

const FACTS = {
  profile: {
    email: 'jd@gov.rw',
    name: 'J D',
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-09-01T00:00:00Z',
    received90d: 10,
    sent90d: 4,
  },
  recentConversations: [
    {
      messageId: 'm123',
      conversationId: 'c1',
      subject: 'Budget review',
      snippet: 'Please see attached',
      direction: 'in' as const,
      at: '2026-09-01T00:00:00Z',
    },
  ],
  commitments: [
    { id: 'p1', type: 'promised' as const, text: 'Send the report', dueHint: 'Friday', messageId: 'm123', lastActivityAt: '2026-09-01T00:00:00Z' },
    { id: 'w1', type: 'waiting' as const, text: 'Their reply on scope', dueHint: null, messageId: 'm123', lastActivityAt: '2026-09-01T00:00:00Z' },
  ],
  sharedEvents: [
    { id: 'e1', title: 'Kickoff meeting', startAt: '2026-09-10T09:00:00Z', endAt: '2026-09-10T10:00:00Z', upcoming: true },
  ],
  sharedDocs: [
    { id: 'd1', title: 'Project charter', emoji: '📄', direction: 'i-shared' as const },
  ],
};

function resetStores() {
  act(() => {
    usePeopleStore.setState({ open: false, target: null });
    useAskStore.setState({ open: false, collapsed: false, prefill: null, scope: null, handlers: null, openTarget: null });
  });
}

beforeEach(() => {
  dossier.mockReset();
  getCachedDossier.mockReset();
  streamDossier.mockReset();
  push.mockReset();
  replace.mockReset();
  mockPathname = '/docs';
  dossier.mockResolvedValue(FACTS);
  getCachedDossier.mockResolvedValue(null);
  streamDossier.mockResolvedValue('Generated summary');
  useAIStore.setState({ enabled: true });
  resetStores();
});

describe('PersonDossierPanel', () => {
  it('renders nothing when store.open is false', () => {
    const { container } = render(<PersonDossierPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('fetches facts on open and renders profile + section content', async () => {
    render(<PersonDossierPanel />);
    act(() => usePeopleStore.getState().openDossier({ email: 'JD@gov.rw', name: 'J D' }));

    await waitFor(() => expect(dossier).toHaveBeenCalledWith('jd@gov.rw'));
    await waitFor(() => expect(screen.getByText('J D')).toBeTruthy());

    expect(screen.getByText('Recent conversations')).toBeTruthy();
    expect(screen.getByText('Budget review')).toBeTruthy();
    expect(screen.getByText('Open loops')).toBeTruthy();
    expect(screen.getByText('Send the report')).toBeTruthy();
    expect(screen.getByText('Their reply on scope')).toBeTruthy();
    expect(screen.getByText('Shared events')).toBeTruthy();
    expect(screen.getByText('Kickoff meeting')).toBeTruthy();
    expect(screen.getByText('Shared docs')).toBeTruthy();
    expect(screen.getByText('Project charter')).toBeTruthy();
  });

  it('renders the cached narrative with a stale badge and Regenerate button, no Summarize button', async () => {
    getCachedDossier.mockResolvedValue({
      content: 'Prior summary of the relationship.',
      sources: [],
      generatedAt: '2026-09-01T00:00:00Z',
      stale: true,
    });
    render(<PersonDossierPanel />);
    act(() => usePeopleStore.getState().openDossier({ email: 'jd@gov.rw' }));

    await waitFor(() => expect(screen.getByText(/Prior summary of the relationship/)).toBeTruthy());
    expect(screen.getByText(/stale/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Regenerate/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Summarize relationship/i })).toBeNull();
  });

  it('shows the Summarize relationship button when there is no cached narrative, and clicking it streams', async () => {
    getCachedDossier.mockResolvedValue(null);
    render(<PersonDossierPanel />);
    act(() => usePeopleStore.getState().openDossier({ email: 'jd@gov.rw' }));

    const btn = await screen.findByRole('button', { name: /Summarize relationship/i });
    fireEvent.click(btn);

    await waitFor(() => expect(streamDossier).toHaveBeenCalledWith('jd@gov.rw', expect.anything()));
  });

  it('closes the dossier when Ask 1Gov opens (mutual exclusion, ask side)', async () => {
    render(<PersonDossierPanel />);
    act(() => usePeopleStore.getState().openDossier({ email: 'jd@gov.rw' }));
    await waitFor(() => expect(usePeopleStore.getState().open).toBe(true));

    act(() => useAskStore.getState().openAsk());

    await waitFor(() => expect(usePeopleStore.getState().open).toBe(false));
  });

  it('routes a conversation-row click to /mail?open=<messageId> on a non-mail route', async () => {
    mockPathname = '/docs';
    render(<PersonDossierPanel />);
    act(() => usePeopleStore.getState().openDossier({ email: 'jd@gov.rw' }));

    const row = await screen.findByText('Budget review');
    fireEvent.click(row);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/mail?open=m123'));
  });

  it('hides the AI narrative block (no Summarize button) when the app-wide AI switch is off', async () => {
    useAIStore.setState({ enabled: false });
    render(<PersonDossierPanel />);
    act(() => usePeopleStore.getState().openDossier({ email: 'jd@gov.rw' }));

    await waitFor(() => expect(dossier).toHaveBeenCalledWith('jd@gov.rw'));
    // Facts still render — only the AI block is gated.
    expect(await screen.findByText('Recent conversations')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Summarize relationship/i })).toBeNull();
  });
});
