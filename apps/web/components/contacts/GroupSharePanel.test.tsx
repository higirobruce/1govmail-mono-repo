import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GroupSharePanel } from './GroupSharePanel';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: { contacts: { groups: { shares: { list: vi.fn(), add: vi.fn(), remove: vi.fn() } } } },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const shares = api.contacts.groups.shares as any;

describe('GroupSharePanel', () => {
  beforeEach(() => {
    shares.list.mockReset(); shares.add.mockReset(); shares.remove.mockReset();
    shares.list.mockResolvedValue([{ id: 'i1', invitedEmail: 'alice@risa.gov.rw', role: 'VIEWER' }]);
    shares.add.mockResolvedValue({ id: 'i2', invitedEmail: 'bob@risa.gov.rw', role: 'VIEWER' });
    shares.remove.mockResolvedValue({ success: true });
  });

  it('lists who the group is shared with', async () => {
    render(<GroupSharePanel groupId="g1" isOwner />);
    expect(await screen.findByText('alice@risa.gov.rw')).toBeInTheDocument();
    expect(shares.list).toHaveBeenCalledWith('g1');
  });

  it('invites someone', async () => {
    render(<GroupSharePanel groupId="g1" isOwner />);
    await screen.findByText('alice@risa.gov.rw');
    fireEvent.change(screen.getByPlaceholderText(/colleague@/i), { target: { value: 'bob@risa.gov.rw' } });
    fireEvent.click(screen.getByRole('button', { name: /share/i }));
    await waitFor(() =>
      expect(shares.add).toHaveBeenCalledWith('g1', { email: 'bob@risa.gov.rw', role: 'VIEWER' }),
    );
    expect(await screen.findByText('bob@risa.gov.rw')).toBeInTheDocument();
    // Both the pre-existing share and the newly-added one must remain — a
    // buggy handler that replaces the whole list with just the new entry
    // would still satisfy a looser assertion.
    expect(screen.getByText('alice@risa.gov.rw')).toBeInTheDocument();
  });

  it('invites an EDITOR when that role is selected', async () => {
    render(<GroupSharePanel groupId="g1" isOwner />);
    await screen.findByText('alice@risa.gov.rw');
    fireEvent.change(screen.getByPlaceholderText(/colleague@/i), { target: { value: 'carol@risa.gov.rw' } });
    fireEvent.change(screen.getByLabelText(/permission/i), { target: { value: 'EDITOR' } });
    fireEvent.click(screen.getByRole('button', { name: /share/i }));
    await waitFor(() =>
      expect(shares.add).toHaveBeenCalledWith('g1', { email: 'carol@risa.gov.rw', role: 'EDITOR' }),
    );
  });

  it('revokes a share', async () => {
    render(<GroupSharePanel groupId="g1" isOwner />);
    await screen.findByText('alice@risa.gov.rw');
    fireEvent.click(screen.getByRole('button', { name: /revoke alice@risa.gov.rw/i }));
    await waitFor(() => expect(shares.remove).toHaveBeenCalledWith('g1', 'i1'));
    await waitFor(() => expect(screen.queryByText('alice@risa.gov.rw')).not.toBeInTheDocument());
  });

  it('hides the invite form from a non-owner but still lists shares', async () => {
    render(<GroupSharePanel groupId="g1" isOwner={false} />);
    // Half 1: the share list still renders for a non-owner.
    expect(await screen.findByText('alice@risa.gov.rw')).toBeInTheDocument();
    expect(screen.getByText(/can send/i)).toBeInTheDocument();
    // Half 2: owner-only controls are absent — invite input, role select, share button, revoke button.
    expect(screen.queryByPlaceholderText(/colleague@/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/permission/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^share$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
  });
});
