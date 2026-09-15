import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
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

let queryClient: QueryClient;

function renderAlerts() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}><NotificationAlerts /></QueryClientProvider>,
  );
}

/** Force the next poll now, instead of waiting 30 real seconds for it. */
const refetchNotifications = () => queryClient.refetchQueries({ queryKey: ['notifications'] });

describe('NotificationAlerts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useNotificationsStore.setState({
      soundEnabled: true, volume: 0.6,
      tones: { NEW_MAIL: 'soft', EVENT_SOON: 'double' },
      lastAnnouncedAt: MARKER, initialized: true,
    });
  });

  // vi.spyOn(document, 'visibilityState', 'get') and the Notification stub both
  // survive clearAllMocks(), so without this a test added after a hidden-window
  // case silently inherits a hidden document and a granted permission.
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as any).Notification;
    delete (window as any).electronAPI;
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

  it('keeps announcing rows behind a throwing one, and still advances the marker', async () => {
    // The cheapest way to drive a mid-loop throw: make the already-mocked
    // `toast` blow up on its first call only, then behave normally.
    const badRow = { id: 'n3', type: 'NEW_MAIL', title: 'Bad row', createdAt: '2026-09-15T10:03:00.000Z' };
    const goodRow = { id: 'n4', type: 'NEW_MAIL', title: 'Good row', body: 'fine', createdAt: '2026-09-15T10:04:00.000Z' };
    vi.mocked(toast).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([badRow, goodRow] as any);

    renderAlerts();

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Good row', expect.anything()));
    expect(useNotificationsStore.getState().lastAnnouncedAt).toBe(goodRow.createdAt);
  });

  it('announces nothing on a first run, but records where the feed had got to', async () => {
    useNotificationsStore.setState({ lastAnnouncedAt: null, initialized: false });
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);

    renderAlerts();

    await waitFor(() => expect(useNotificationsStore.getState().lastAnnouncedAt).toBe(mailRow.createdAt));
    expect(toast).not.toHaveBeenCalled();
    expect(useNotificationsStore.getState().initialized).toBe(true);
  });

  it('announces the first arrival on a device whose first poll was EMPTY', async () => {
    // An empty first feed has no backlog to suppress, so the documented
    // trade-off does not apply — but a null marker used to mean "stay silent"
    // regardless, and the marker was recorded inside an effect that returned
    // early on an empty feed. The device therefore swallowed its first real
    // alert as well as the backlog it never had.
    useNotificationsStore.setState({ lastAnnouncedAt: null, initialized: false });
    const getAll = vi.spyOn(api.notifications, 'getAll')
      .mockResolvedValueOnce([] as any)
      .mockResolvedValue([mailRow] as any);
    const play = vi.mocked(playTone);

    renderAlerts();
    await waitFor(() => expect(useNotificationsStore.getState().initialized).toBe(true));
    expect(toast).not.toHaveBeenCalled();
    expect(useNotificationsStore.getState().lastAnnouncedAt).toBeNull();

    // The mail arrives on the next poll.
    await act(async () => { await refetchNotifications(); });

    await waitFor(() => expect(toast).toHaveBeenCalledWith('2 new messages', expect.anything()));
    expect(play).toHaveBeenCalledWith('soft', 0.6);
    expect(getAll).toHaveBeenCalledTimes(2);
  });

  it('keeps polling while the window is HIDDEN — the whole background tier depends on it', async () => {
    // react-query gates a refetchInterval on
    // `refetchIntervalInBackground || focusManager.isFocused()`, and the focus
    // manager reads document.visibilityState: a hidden document is unfocused,
    // so without refetchIntervalInBackground the poll and the hidden-window
    // branch are mutually exclusive and the OS-notification tier is dead code.
    // Mocking visibilityState alone cannot catch that — react-query's own
    // interval has to run, which is what this drives.
    vi.useFakeTimers();
    const NotificationMock = vi.fn();
    (globalThis as any).Notification = Object.assign(NotificationMock, { permission: 'granted' });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const getAll = vi.spyOn(api.notifications, 'getAll')
      .mockResolvedValueOnce([] as any)
      .mockResolvedValue([mailRow] as any);

    renderAlerts();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(NotificationMock).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    // One more turn of the clock: the fetch resolves inside the first one, and
    // the re-render plus announce effect it schedules land in the next.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(getAll).toHaveBeenCalledTimes(2);
    expect(NotificationMock).toHaveBeenCalledWith(
      '2 new messages', expect.objectContaining({ body: 'Inbox now has 5 unread', tag: 'n1' }),
    );
  });

  it('asks Electron for the native notification when it is available, and does not raise two', async () => {
    // The desktop build lost native notifications (and click-to-focus-window)
    // when the mail page's sendNotification call was removed; the IPC handler is
    // still there, so the shell uses it in preference to the web API.
    const sendNotification = vi.fn();
    (window as any).electronAPI = { isElectron: true, platform: 'darwin', sendNotification, setBadgeCount: vi.fn() };
    const NotificationMock = vi.fn();
    (globalThis as any).Notification = Object.assign(NotificationMock, { permission: 'granted' });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);

    renderAlerts();

    await waitFor(() => expect(sendNotification).toHaveBeenCalledWith('2 new messages', 'Inbox now has 5 unread'));
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('leaves Electron alone in a browser, and leaves a visible window alone in Electron', async () => {
    const sendNotification = vi.fn();
    (window as any).electronAPI = { isElectron: true, platform: 'win32', sendNotification, setBadgeCount: vi.fn() };
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);

    renderAlerts();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
