import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationsBell } from './NotificationsBell';
import { api } from '@/lib/api';

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><NotificationsBell /></QueryClientProvider>,
  );
}

function unreadRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i}`, type: 'TASK_DUE', title: `Task ${i}`, isRead: false,
    createdAt: '2026-09-15T10:00:00.000Z',
  }));
}

describe('NotificationsBell', () => {
  it('exposes an accessible name of "Notifications" though its text label is gone', async () => {
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([]);

    renderBell();

    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('badges the trigger with the unread count', async () => {
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue(unreadRows(3) as any);

    renderBell();

    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
  });

  it('caps the badge at 99+ once unread passes 99', async () => {
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue(unreadRows(120) as any);

    renderBell();

    await waitFor(() => expect(screen.getByText('99+')).toBeTruthy());
  });
});
