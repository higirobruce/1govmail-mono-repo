import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useAskStore } from '@/stores/ask.store';
import { api } from '@/lib/api';

// Same network-only mocking as AskPanel.routing.test.tsx: the panel itself is
// mounted for real, so what these assert is AskPanel's own resume wiring.
const { streamAgent } = vi.hoisted(() => ({
  streamAgent: vi.fn(async (..._a: any[]) => 'agent answer'),
}));
vi.mock('@/lib/ai/agent', async (orig) => ({ ...(await orig() as any), streamAgent }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/mail',
}));

import AskPanel from './AskPanel';

const TRANSCRIPT = {
  id: 'conv-7',
  title: 'Where does the RHEMIS report stand?',
  scopeKind: 'app',
  scopeId: null,
  scopeLabel: null,
  model: 'llama3',
  turns: [
    { role: 'user', content: 'RESTORED QUESTION', sources: [], steps: null, proposals: null },
    { role: 'assistant', content: 'RESTORED ANSWER', sources: [], steps: null, proposals: null },
  ],
};

async function ask(text: string) {
  const box = screen.getByPlaceholderText(/^ask about/i);
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  });
}

describe('AskPanel — resuming a saved conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAskStore.setState({
      open: true, collapsed: false, prefill: null, scope: null,
      handlers: null, openTarget: null, resumeId: null,
    });
    vi.spyOn(api.aiHistory, 'create').mockResolvedValue({ id: 'mock-conv' });
    vi.spyOn(api.aiHistory, 'append').mockResolvedValue(undefined as any);
  });
  afterEach(() => { vi.clearAllMocks(); });

  /**
   * F1. The panel is rendered from the (app) route-group layout, which Next
   * preserves across in-group navigation, so it mounts ONCE — long before the
   * user can reach /ai/history and click Resume. A mount-only (`[]`) resume
   * effect therefore reads `null` and never runs again: resume was dead on
   * every scope. The handoff must be keyed on the VALUE.
   */
  it('resumes a conversation requested after the panel has already mounted', async () => {
    const get = vi.spyOn(api.aiHistory, 'get').mockResolvedValue(TRANSCRIPT as any);
    render(<AskPanel />);
    expect(get).not.toHaveBeenCalled();

    await act(async () => { useAskStore.getState().resumeConversation('conv-7'); });

    await waitFor(() => expect(get).toHaveBeenCalledWith('conv-7'));
    expect(await screen.findByText('RESTORED QUESTION')).toBeTruthy();
    expect(screen.getByText('RESTORED ANSWER')).toBeTruthy();
    // Consumed and cleared, so a later unrelated render cannot re-resume it.
    expect(useAskStore.getState().resumeId).toBeNull();
  });

  /**
   * F1, part 2. The abandon guard used to be a sticky boolean latch set on the
   * first ask() and never reset. Harmless for a mount-only effect; fatal for a
   * value-keyed one — after the user's first question of the session EVERY
   * resume would abandon silently. The guard must be snapshot-relative: "did
   * the user start a turn WHILE MY FETCH WAS IN FLIGHT", not "ever".
   */
  it('still resumes after the user has already asked something earlier in the session', async () => {
    const get = vi.spyOn(api.aiHistory, 'get').mockResolvedValue(TRANSCRIPT as any);
    render(<AskPanel />);
    await ask('a question of my own');
    await waitFor(() => expect(streamAgent).toHaveBeenCalled());

    await act(async () => { useAskStore.getState().resumeConversation('conv-7'); });

    await waitFor(() => expect(get).toHaveBeenCalledWith('conv-7'));
    expect(await screen.findByText('RESTORED QUESTION')).toBeTruthy();
  });

  /**
   * The round-3 rule this fix must preserve: a turn the user starts while the
   * resume fetch is still in flight wins outright — the restore is abandoned
   * rather than clobbering the question and answer they just watched arrive.
   */
  it('abandons the restore if the user asks while the fetch is in flight', async () => {
    let resolveGet: (v: any) => void = () => {};
    vi.spyOn(api.aiHistory, 'get').mockReturnValue(
      new Promise((res) => { resolveGet = res; }) as any,
    );
    render(<AskPanel />);
    await act(async () => { useAskStore.getState().resumeConversation('conv-7'); });

    await ask('my own live turn');
    await waitFor(() => expect(streamAgent).toHaveBeenCalled());
    await act(async () => { resolveGet(TRANSCRIPT); });

    expect(screen.queryByText('RESTORED QUESTION')).toBeNull();
    expect(screen.getByText('my own live turn')).toBeTruthy();
  });
});

describe('AskPanel — saving a turn to history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAskStore.setState({
      open: true, collapsed: false, prefill: null, scope: null,
      handlers: null, openTarget: null, resumeId: null,
    });
    vi.spyOn(api.aiHistory, 'append').mockResolvedValue(undefined as any);
  });
  afterEach(() => { vi.clearAllMocks(); });

  /**
   * F3. The persist's catch swallowed everything with no log, no toast and no
   * console warning. On the Exchange VM a thread scopeId (a 200+ char EWS
   * ItemId) 400'd against the DTO cap, so thread-scoped history silently
   * never saved while app-scoped history looked perfect — the worst
   * diagnostic shape this feature could have on a live server. The write
   * still must not cost the answer; it must just leave a trace.
   */
  it('warns instead of failing silently when the history write is rejected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(api.aiHistory, 'create').mockRejectedValue(new Error('Request failed'));
    render(<AskPanel />);

    await ask('who is waiting on me?');

    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('history'), expect.anything(),
    ));
    // ...and the answer the user is reading is untouched.
    expect(screen.getByText('agent answer')).toBeTruthy();
    warn.mockRestore();
  });
});
