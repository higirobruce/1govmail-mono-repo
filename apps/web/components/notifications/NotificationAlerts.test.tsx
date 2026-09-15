import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationAlerts } from './NotificationAlerts';
import { useNotificationsStore } from '@/stores/notifications.store';
import { api } from '@/lib/api';
import { playTone } from '@/lib/notifications/chime';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

// Vitest cannot spy on a plain ESM named export — the binding the component
// imported is not the one vi.spyOn would replace. Mock the module instead.
vi.mock('@/lib/notifications/chime', () => ({
  playTone: vi.fn().mockResolvedValue(true),
  unlockAudio: vi.fn(),
}));

const MARKER = '2026-09-15T10:00:00.000Z';
const mailRow = { id: 'n1', type: 'NEW_MAIL', title: '2 new messages', body: 'Inbox now has 5 unread', actionUrl: '/mail', createdAt: '2026-09-15T10:01:00.000Z' };
const taskRow = { id: 'n2', type: 'TASK_DUE', title: 'Task due', createdAt: '2026-09-15T10:02:00.000Z' };

function renderAlerts() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><NotificationAlerts /></QueryClientProvider>,
  );
}

describe('NotificationAlerts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useNotificationsStore.setState({
      soundEnabled: true, volume: 0.6,
      tones: { NEW_MAIL: 'soft', EVENT_SOON: 'double' },
      lastAnnouncedAt: MARKER,
    });
  });

  it('toasts and chimes for an audible notification', async () => {
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);
    const play = vi.mocked(playTone);

    renderAlerts();

    await waitFor(() => expect(toast).toHaveBeenCalledWith('2 new messages', expect.anything()));
    expect(play).toHaveBeenCalledWith('soft', 0.6);
  });

  it('toasts a silent type without playing anything', async () => {
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([taskRow] as any);
    const play = vi.mocked(playTone);

    renderAlerts();

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Task due', expect.anything()));
    expect(play).not.toHaveBeenCalled();
  });

  it('stays silent when the user has turned sound off', async () => {
    useNotificationsStore.setState({ soundEnabled: false });
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);
    const play = vi.mocked(playTone);

    renderAlerts();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(play).not.toHaveBeenCalled();
  });

  it('says nothing at all when another tab has already claimed the row', async () => {
    localStorage.setItem('1gov-announced:n1', String(Date.now()));
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);
    const play = vi.mocked(playTone);

    renderAlerts();

    await waitFor(() => expect(useNotificationsStore.getState().lastAnnouncedAt).toBe(mailRow.createdAt));
    expect(toast).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('raises an OS notification only when the window is hidden', async () => {
    // An OS notification over a window the user is already reading is noise;
    // the whole point of it is reaching them when they are looking elsewhere.
    const NotificationMock = vi.fn();
    (globalThis as any).Notification = Object.assign(NotificationMock, { permission: 'granted' });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);

    renderAlerts();

    await waitFor(() => expect(NotificationMock).toHaveBeenCalledWith(
      '2 new messages', expect.objectContaining({ body: 'Inbox now has 5 unread', tag: 'n1' }),
    ));
  });

  it('raises no OS notification while the window is visible', async () => {
    const NotificationMock = vi.fn();
    (globalThis as any).Notification = Object.assign(NotificationMock, { permission: 'granted' });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);

    renderAlerts();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('announces nothing on a first run, but records where the feed had got to', async () => {
    useNotificationsStore.setState({ lastAnnouncedAt: null });
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);

    renderAlerts();

    await waitFor(() => expect(useNotificationsStore.getState().lastAnnouncedAt).toBe(mailRow.createdAt));
    expect(toast).not.toHaveBeenCalled();
  });
});
