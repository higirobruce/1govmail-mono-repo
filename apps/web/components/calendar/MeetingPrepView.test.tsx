import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const getCachedMeetingPrep = vi.fn();
const streamMeetingPrep = vi.fn();
vi.mock('@/lib/ai/generation', () => ({
  getCachedMeetingPrep: (...a: unknown[]) => getCachedMeetingPrep(...(a as [])),
  streamMeetingPrep: (...a: unknown[]) => streamMeetingPrep(...(a as [])),
}));

const push = vi.fn();
const replace = vi.fn();
let mockPathname = '/calendar';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (...a: unknown[]) => push(...a), replace: (...a: unknown[]) => replace(...a) }),
  usePathname: () => mockPathname,
}));

import { MeetingPrepView } from './MeetingPrepView';
import { useAskStore } from '@/stores/ask.store';

beforeEach(() => {
  getCachedMeetingPrep.mockReset();
  streamMeetingPrep.mockReset();
  push.mockReset();
  replace.mockReset();
  mockPathname = '/calendar';
  getCachedMeetingPrep.mockResolvedValue(null);
  streamMeetingPrep.mockResolvedValue('Generated prep');
  act(() => {
    useAskStore.setState({ open: false, collapsed: false, prefill: null, scope: null, handlers: null, openTarget: null });
  });
});

describe('MeetingPrepView', () => {
  it('renders cached content immediately with a Regenerate button and no generate button', async () => {
    getCachedMeetingPrep.mockResolvedValue({
      content: 'Fresh prep pack.',
      sources: [],
      generatedAt: '2026-09-06T00:00:00Z',
      stale: false,
    });

    render(<MeetingPrepView eventId="e1" />);

    await waitFor(() => expect(screen.getByText(/Fresh prep pack/)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Regenerate/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Prepare me for this meeting/i })).toBeNull();
  });

  it('shows a stale badge and Regenerate when the cached pack is stale', async () => {
    getCachedMeetingPrep.mockResolvedValue({
      content: 'Old prep pack.',
      sources: [],
      generatedAt: '2026-09-01T00:00:00Z',
      stale: true,
    });

    render(<MeetingPrepView eventId="e1" />);

    await waitFor(() => expect(screen.getByText(/Old prep pack/)).toBeTruthy());
    expect(screen.getByText(/stale/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Regenerate/i })).toBeTruthy();
  });

  it('shows the generate button when there is no cache, and clicking it streams chunks', async () => {
    getCachedMeetingPrep.mockResolvedValue(null);
    streamMeetingPrep.mockImplementation((eventId: string, opts: any) => {
      opts.onChunk('Hello ');
      opts.onChunk('there');
      return Promise.resolve('Hello there');
    });

    render(<MeetingPrepView eventId="e1" />);

    const btn = await screen.findByRole('button', { name: /Prepare me for this meeting/i });
    fireEvent.click(btn);

    await waitFor(() => expect(streamMeetingPrep).toHaveBeenCalledWith('e1', expect.anything()));
    await waitFor(() => expect(screen.getByText(/Hello there/)).toBeTruthy());
  });

  it('resets state and refetches the cache when eventId changes', async () => {
    getCachedMeetingPrep.mockImplementation((eventId: string) => {
      if (eventId === 'e1') {
        return Promise.resolve({ content: 'Prep for e1', sources: [], generatedAt: '2026-09-06T00:00:00Z', stale: false });
      }
      return Promise.resolve({ content: 'Prep for e2', sources: [], generatedAt: '2026-09-06T00:00:00Z', stale: false });
    });

    const { rerender } = render(<MeetingPrepView eventId="e1" />);
    await waitFor(() => expect(getCachedMeetingPrep).toHaveBeenCalledWith('e1'));
    await waitFor(() => expect(screen.getByText(/Prep for e1/)).toBeTruthy());

    rerender(<MeetingPrepView eventId="e2" />);

    await waitFor(() => expect(getCachedMeetingPrep).toHaveBeenCalledWith('e2'));
    await waitFor(() => expect(screen.getByText(/Prep for e2/)).toBeTruthy());
    expect(screen.queryByText(/Prep for e1/)).toBeNull();
  });

  it('shows a readable error line and brings the generate button back when the stream rejects', async () => {
    getCachedMeetingPrep.mockResolvedValue(null);
    streamMeetingPrep.mockRejectedValue(new Error('AI request failed (500): boom'));

    render(<MeetingPrepView eventId="e1" />);

    const btn = await screen.findByRole('button', { name: /Prepare me for this meeting/i });
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByText(/AI request failed/)).toBeTruthy());
    expect(await screen.findByRole('button', { name: /Prepare me for this meeting/i })).toBeTruthy();
  });
});
