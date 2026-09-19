import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { NotificationsBell } from './NotificationsBell';
import { api } from '@/lib/api';

// jsdom has no ResizeObserver; Radix's Tooltip.Arrow measures itself with one
// via @radix-ui/react-use-size, which throws as soon as an OPEN tooltip
// mounts. This stub only satisfies that call — it asserts no geometry — and
// is scoped to this file rather than the global setup, since nothing else
// in the suite opens a Tooltip today.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver ??= ResizeObserverStub;

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <NotificationsBell />
      </TooltipProvider>
    </QueryClientProvider>,
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

  it('surfaces a "Notifications" tooltip on keyboard focus, for sighted mouse users with no other affordance', async () => {
    // The trigger has no visible text and no title attribute now — the
    // Radix Tooltip is the only way a sighted, non-screen-reader user learns
    // what the icon does. Radix opens tooltips on focus as well as hover,
    // and focus is the one open-path jsdom can drive without pointer/hover
    // event plumbing (see ThreadHeader.test.tsx for the same constraint).
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([]);

    renderBell();

    const trigger = await screen.findByRole('button', { name: 'Notifications' });
    fireEvent.focus(trigger);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Notifications');
  });
});
