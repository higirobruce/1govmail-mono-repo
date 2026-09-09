import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useAskStore } from '@/stores/ask.store';
import { api } from '@/lib/api';

// The panel is mounted for real — these mocks stand in for the network only,
// so what the tests assert is AskPanel's own routing, not a stubbed panel.
// vi.hoisted because vi.mock's factories are lifted above these declarations.
const { streamAsk, streamAgent, gatherThreadContent } = vi.hoisted(() => ({
  streamAsk: vi.fn(async (..._a: any[]) => 'ask answer'),
  streamAgent: vi.fn(async (..._a: any[]) => 'agent answer'),
  gatherThreadContent: vi.fn(async (..._a: any[]) => ({ text: 'THREAD TEXT', messageCount: 6 })),
}));

vi.mock('@/lib/ai/ask', async (orig) => ({ ...(await orig() as any), streamAsk }));
vi.mock('@/lib/ai/agent', async (orig) => ({ ...(await orig() as any), streamAgent }));
vi.mock('@/lib/ai/threadContent', async (orig) => ({
  ...(await orig() as any), gatherThreadContent,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/mail',
}));

import AskPanel from './AskPanel';

const THREAD = {
  kind: 'thread' as const, conversationId: 'c1', seedMessageId: 'm9',
  subject: 'Re: RHEMIS inception report', messageCount: 6, locked: false,
};

const DOC = { kind: 'doc' as const, docId: 'd1', docTitle: 'Budget Memo' };

/**
 * The composer is a textarea + Send button, not a <form>, so drive the real
 * affordance. `act` wraps the whole async send so the post-await state writes
 * (streaming off, the completed turn) land inside it — otherwise React logs
 * an act() warning for every turn.
 */
async function ask(text: string) {
  const box = screen.getByPlaceholderText(/^ask about/i);
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  });
}

describe('AskPanel routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAskStore.setState({ open: true, collapsed: false, prefill: null, scope: null, handlers: null, openTarget: null });
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('a doc scope goes to streamAsk with docId', async () => {
    useAskStore.setState({ scope: { ...DOC } });
    render(<AskPanel />);
    await ask('what does it say?');
    await waitFor(() => expect(streamAsk).toHaveBeenCalled());
    expect(streamAgent).not.toHaveBeenCalled();
    expect(streamAsk.mock.calls[0][1].scope).toEqual({ docId: 'd1' });
    expect(gatherThreadContent).not.toHaveBeenCalled();
  });

  it('an unscoped ask goes to streamAgent with nothing pinned', async () => {
    render(<AskPanel />);
    await ask('who is waiting on me?');
    await waitFor(() => expect(streamAgent).toHaveBeenCalled());
    expect(streamAsk).not.toHaveBeenCalled();
    expect(streamAgent.mock.calls[0][1].pinned).toBeNull();
    expect(gatherThreadContent).not.toHaveBeenCalled();
  });

  it('a thread scope goes to streamAgent with the pinned block', async () => {
    useAskStore.setState({ scope: { ...THREAD } });
    render(<AskPanel />);
    await ask('where does this stand?');
    await waitFor(() => expect(streamAgent).toHaveBeenCalled());
    expect(streamAsk).not.toHaveBeenCalled();
    const pinned = streamAgent.mock.calls[0][1].pinned;
    expect(pinned.text).toBe('THREAD TEXT');
    expect(pinned.label).toBe('Re: RHEMIS inception report');
    expect('toolScope' in pinned).toBe(false);
  });

  it('locked thread scope sends toolScope: thread', async () => {
    useAskStore.setState({ scope: { ...THREAD, locked: true } });
    render(<AskPanel />);
    await ask('summarize');
    await waitFor(() => expect(streamAgent).toHaveBeenCalled());
    expect(streamAgent.mock.calls[0][1].pinned.toolScope).toBe('thread');
  });

  it('gathers under the pinned character budget', async () => {
    useAskStore.setState({ scope: { ...THREAD } });
    render(<AskPanel />);
    await ask('one');
    await waitFor(() => expect(gatherThreadContent).toHaveBeenCalled());
    expect(gatherThreadContent.mock.calls[0][0]).toBe('m9');
    expect(gatherThreadContent.mock.calls[0][2]).toEqual({ totalCharBudget: 6000 });
  });

  it('does not gather on open — only on the first send', async () => {
    useAskStore.setState({ scope: { ...THREAD } });
    render(<AskPanel />);
    expect(gatherThreadContent).not.toHaveBeenCalled();
    await ask('one');
    await waitFor(() => expect(gatherThreadContent).toHaveBeenCalledTimes(1));
  });

  it('reuses the gathered text for a second turn on the same thread', async () => {
    useAskStore.setState({ scope: { ...THREAD } });
    render(<AskPanel />);
    await ask('one');
    await waitFor(() => expect(streamAgent).toHaveBeenCalledTimes(1));
    await ask('two');
    await waitFor(() => expect(streamAgent).toHaveBeenCalledTimes(2));
    expect(gatherThreadContent).toHaveBeenCalledTimes(1);
    expect(streamAgent.mock.calls[1][1].pinned.text).toBe('THREAD TEXT');
  });

  it('re-gathers when the scope moves to a different thread', async () => {
    useAskStore.setState({ scope: { ...THREAD } });
    render(<AskPanel />);
    await ask('one');
    await waitFor(() => expect(gatherThreadContent).toHaveBeenCalledTimes(1));
    await act(async () => {
      useAskStore.setState({ scope: { ...THREAD, seedMessageId: 'm42', conversationId: 'c2' } });
    });
    await ask('two');
    await waitFor(() => expect(gatherThreadContent).toHaveBeenCalledTimes(2));
    expect(gatherThreadContent.mock.calls[1][0]).toBe('m42');
  });

  it('still sends unpinned when the gather throws, and says so', async () => {
    gatherThreadContent.mockRejectedValueOnce(new Error('network'));
    useAskStore.setState({ scope: { ...THREAD } });
    render(<AskPanel />);
    await ask('one');
    await waitFor(() => expect(streamAgent).toHaveBeenCalled());
    expect(streamAgent.mock.calls[0][1].pinned).toBeFalsy();
    expect(screen.getByText(/answering without it pinned/i)).toBeTruthy();
  });

  /**
   * The other cases mock the gatherer, so `messageIds` is [] in all of them.
   * This one runs the REAL gatherThreadContent through ensurePinned's deps,
   * because that array is the lock's bound on id-addressed reads server-side:
   * if the ids stopped being captured, "this thread only" would silently
   * widen to the whole mailbox and nothing else here would fail.
   */
  it('pins the conversation’s message ids, gathering for real', async () => {
    const real = await vi.importActual<typeof import('@/lib/ai/threadContent')>('@/lib/ai/threadContent');
    gatherThreadContent.mockImplementationOnce(real.gatherThreadContent as any);
    const messages = [
      { id: 'p1', fromEmail: 'a@gov.rw', fromName: 'A', receivedAt: '2026-09-01T08:00:00Z', snippet: 'first' },
      { id: 'p2', fromEmail: 'b@gov.rw', fromName: 'B', receivedAt: '2026-09-02T08:00:00Z', snippet: 'second' },
    ];
    const getConversation = vi.spyOn(api.mail, 'getConversation')
      .mockResolvedValue({ conversationId: 'c1', messages } as any);
    const getMessage = vi.spyOn(api.mail, 'getMessage')
      .mockImplementation(async (id: string) => ({ id, bodyText: `body of ${id}` }) as any);

    useAskStore.setState({ scope: { ...THREAD, seedMessageId: 'p2' } });
    render(<AskPanel />);
    await ask('who owns this?');
    await waitFor(() => expect(streamAgent).toHaveBeenCalled());

    expect(getConversation).toHaveBeenCalledWith('p2');
    const pinned = streamAgent.mock.calls[0][1].pinned;
    expect(pinned.messageIds).toEqual(['p1', 'p2']);
    expect(pinned.text).toContain('body of p1');
    expect(pinned.text).toContain('body of p2');

    getConversation.mockRestore();
    getMessage.mockRestore();
  });

  it('slices history to 6 turns on a thread scope', async () => {
    useAskStore.setState({ scope: { ...THREAD } });
    render(<AskPanel />);
    for (const q of ['a', 'b', 'c', 'd']) await ask(q);
    await waitFor(() => expect(streamAgent).toHaveBeenCalledTimes(4));
    // 3 prior exchanges (6 turns) + this question = 7, so the oldest is dropped.
    const sent = streamAgent.mock.calls[3][0];
    expect(sent.length).toBe(6);
    expect(sent[sent.length - 1].content).toBe('d');
  });

  it('keeps the 12-turn history on a doc scope', async () => {
    useAskStore.setState({ scope: { ...DOC } });
    render(<AskPanel />);
    for (const q of ['a', 'b', 'c', 'd']) await ask(q);
    await waitFor(() => expect(streamAsk).toHaveBeenCalledTimes(4));
    // Same 7 turns as above — under 12, so nothing is dropped.
    expect(streamAsk.mock.calls[3][0].length).toBe(7);
  });
});

describe('AskPanel scope chip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAskStore.setState({ open: true, collapsed: false, prefill: null, scope: null, handlers: null, openTarget: null });
  });

  it('renders the document chip for a doc scope', () => {
    useAskStore.setState({ scope: { ...DOC } });
    render(<AskPanel />);
    expect(screen.getByText('This document: Budget Memo')).toBeTruthy();
    expect(screen.getByRole('button', { name: /clear document scope/i })).toBeTruthy();
  });

  it('renders the thread chip for a thread scope, with the lock wired to the store', () => {
    useAskStore.setState({ scope: { ...THREAD } });
    render(<AskPanel />);
    expect(screen.getByText('Re: RHEMIS inception report')).toBeTruthy();
    expect(screen.getByText('6 messages')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /only this thread/i }));
    expect((useAskStore.getState().scope as any).locked).toBe(true);
  });

  it('the thread chip clears the scope', () => {
    useAskStore.setState({ scope: { ...THREAD } });
    render(<AskPanel />);
    fireEvent.click(screen.getByRole('button', { name: /remove thread context/i }));
    expect(useAskStore.getState().scope).toBeNull();
  });

  it('shows the included count once the server acks the pin', async () => {
    streamAgent.mockImplementationOnce(async (_turns: any, opts: any) => {
      opts.onPinned({ included: 4, injectionSuspected: true });
      return 'agent answer';
    });
    useAskStore.setState({ scope: { ...THREAD } });
    render(<AskPanel />);
    await ask('one');
    await waitFor(() => expect(screen.getByText('4 of 6 messages')).toBeTruthy());
    expect(screen.getByLabelText(/suspicious content/i)).toBeTruthy();
  });

  it('offers thread starters instead of the document ones', () => {
    useAskStore.setState({ scope: { ...THREAD } });
    render(<AskPanel />);
    expect(screen.getByRole('button', { name: 'Summarize where this stands' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Summarize the key decisions' })).toBeNull();
  });
});
