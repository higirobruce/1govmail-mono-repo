import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { OrgDigest } from './OrgDigest';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { org: { digest: vi.fn() } },
}));
const digest = api.org.digest as unknown as ReturnType<typeof vi.fn>;

const payload = (over: Partial<any> = {}) => ({
  window: 'week',
  institutionId: 'risa',
  narrative: 'The institution is focused on network readiness.',
  ahead: [{
    kind: 'meeting', id: 'e1', title: 'Network readiness review',
    at: '2026-10-08T09:00:00.000Z', participantCount: 12, href: '/calendar?event=e1',
  }],
  concluded: [{
    kind: 'document', id: 'd1', title: 'Q4 procurement plan',
    at: '2026-10-02T10:00:00.000Z', participantCount: 3, href: '/docs?open=d1',
  }],
  ...over,
});

describe('OrgDigest', () => {
  beforeEach(() => { digest.mockReset(); digest.mockResolvedValue(payload()); });
  afterEach(() => cleanup());

  it('shows the narrative and both lanes, meetings lane first', async () => {
    render(<OrgDigest />);
    expect(await screen.findByText(/focused on network readiness/i)).toBeInTheDocument();
    expect(screen.getByText('Network readiness review')).toBeInTheDocument();
    expect(screen.getByText('Q4 procurement plan')).toBeInTheDocument();

    // "Ahead" must lead "Concluded" in the DOM — meetings-first is a deliberate
    // editorial order, not something the client is allowed to re-sort away.
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(['Ahead', 'Concluded']);

    // Each item must land in its own lane, not the other one.
    const aheadHeading = screen.getByRole('heading', { name: 'Ahead' });
    const concludedHeading = screen.getByRole('heading', { name: 'Concluded' });
    const aheadSection = aheadHeading.closest('section')!;
    const concludedSection = concludedHeading.closest('section')!;
    expect(within(aheadSection).getByText('Network readiness review')).toBeInTheDocument();
    expect(within(aheadSection).queryByText('Q4 procurement plan')).not.toBeInTheDocument();
    expect(within(concludedSection).getByText('Q4 procurement plan')).toBeInTheDocument();
    expect(within(concludedSection).queryByText('Network readiness review')).not.toBeInTheDocument();
  });

  it('defaults to the week window and can switch', async () => {
    render(<OrgDigest />);
    await waitFor(() => expect(digest).toHaveBeenCalledWith('week'));
    fireEvent.click(screen.getByRole('button', { name: /today/i }));
    await waitFor(() => expect(digest).toHaveBeenCalledWith('day'));
  });

  it('renders the lists when there is no narrative, and renders no narrative paragraph', async () => {
    digest.mockResolvedValue(payload({ narrative: null }));
    render(<OrgDigest />);
    expect(await screen.findByText('Network readiness review')).toBeInTheDocument();
    expect(screen.getByText('Q4 procurement plan')).toBeInTheDocument();
    // A missing narrative is normal, not an error — but it must actually be
    // absent, not just untested for presence.
    expect(screen.queryByText(/focused on network readiness/i)).not.toBeInTheDocument();
  });

  it('says so, kindly, when the institution has nothing to show', async () => {
    digest.mockResolvedValue(payload({ narrative: null, ahead: [], concluded: [] }));
    render(<OrgDigest />);
    expect(await screen.findByText(/nothing shared yet/i)).toBeInTheDocument();
    // The empty state must actually be empty: no stray lane headings or
    // leftover items from the fixture should render alongside the message.
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByText('Network readiness review')).not.toBeInTheDocument();
    expect(screen.queryByText('Q4 procurement plan')).not.toBeInTheDocument();
  });

  it('shows a distinct error state when the request rejects, not the empty-state copy', async () => {
    digest.mockReset();
    digest.mockRejectedValue(new Error('network down'));
    render(<OrgDigest />);
    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument();
    // The failure must be visually/textually distinct from "quiet institution" —
    // a test that only checks the error copy appeared would pass even if the
    // empty-state copy also rendered alongside it.
    expect(screen.queryByText(/nothing shared yet/i)).not.toBeInTheDocument();
  });

  it('clears a stale narrative when a later request fails', async () => {
    render(<OrgDigest />);
    expect(await screen.findByText(/focused on network readiness/i)).toBeInTheDocument();

    digest.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(screen.getByRole('button', { name: /today/i }));

    expect(await screen.findByText(/couldn.t load/i)).toBeInTheDocument();
    expect(screen.queryByText(/focused on network readiness/i)).not.toBeInTheDocument();
  });

  it('retries with the currently selected window when the user clicks Try again', async () => {
    digest.mockReset();
    digest.mockRejectedValueOnce(new Error('network down'));
    digest.mockResolvedValue(payload());
    render(<OrgDigest />);
    await screen.findByText(/couldn.t load/i);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    // Must re-call with the window that was active when retry was pressed
    // (the default, 'week'), not an empty/undefined argument.
    await waitFor(() => expect(digest).toHaveBeenLastCalledWith('week'));
    expect(await screen.findByText('Network readiness review')).toBeInTheDocument();
  });
});
