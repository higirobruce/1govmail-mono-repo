import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const authedFetch = vi.fn();
vi.mock('@/lib/authed-fetch', () => ({ authedFetch: (...a: any[]) => authedFetch(...a) }));

import ProposalCard from './ProposalCard';

const sendProposal = {
  proposalId: 'p1',
  tool: 'send_email' as const,
  args: { to: ['a@b.rw'], subject: 'Hello', body: 'Body text' },
  summary: 'to a@b.rw — "Hello"',
};

describe('ProposalCard', () => {
  beforeEach(() => authedFetch.mockReset());

  it('renders the email preview and approve/draft/dismiss actions', () => {
    render(<ProposalCard proposal={sendProposal} />);
    expect(screen.getByText(/a@b\.rw/)).toBeTruthy();
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByRole('button', { name: /approve & send/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /save as draft/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeTruthy();
  });

  it('approve posts the exact payload to /mail/send and shows sent state', async () => {
    authedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    render(<ProposalCard proposal={sendProposal} />);
    fireEvent.click(screen.getByRole('button', { name: /approve & send/i }));
    await waitFor(() => expect(screen.getByText(/sent/i)).toBeTruthy());
    expect(authedFetch).toHaveBeenCalledWith('/mail/send', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(authedFetch.mock.calls[0][1].body)).toEqual(sendProposal.args);
  });

  it('failed approval surfaces the error and re-enables actions', async () => {
    authedFetch.mockResolvedValue({ ok: false, status: 502 });
    render(<ProposalCard proposal={sendProposal} />);
    fireEvent.click(screen.getByRole('button', { name: /approve & send/i }));
    await waitFor(() => expect(screen.getByText(/failed/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /approve & send/i })).toBeTruthy();
  });

  it('dismiss collapses the card', () => {
    render(<ProposalCard proposal={sendProposal} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.getByText(/dismissed/i)).toBeTruthy();
  });
});
