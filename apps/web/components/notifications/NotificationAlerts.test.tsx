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
      lastAnnouncedAt: MARKER,
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
    useNotificationsStore.setState({ lastAnnouncedAt: null });
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);

    renderAlerts();

    await waitFor(() => expect(useNotificationsStore.getState().lastAnnouncedAt).toBe(mailRow.createdAt));
    expect(toast).not.toHaveBeenCalled();
  });

  it('announces the first arrival on a device whose first poll was EMPTY', async () => {
    // An empty first feed has no backlog to suppress, so the documented
    // trade-off does not apply — but a null marker used to mean "stay silent"
    // regardless, and the marker was recorded inside an effect that returned
    // early on an empty feed. The device therefore swallowed its first real
    // alert as well as the backlog it never had.
    useNotificationsStore.setState({ lastAnnouncedAt: null });
    const getAll = vi.spyOn(api.notifications, 'getAll').mockResolvedValue([] as any);
    const play = vi.mocked(playTone);

    renderAlerts();
    // The empty poll records a marker — the client's own clock, there being no
    // server timestamp to borrow — and that marker is the only evidence the
    // poll completed, now that no separate flag records it.
    await waitFor(() => expect(useNotificationsStore.getState().lastAnnouncedAt).not.toBeNull());
    expect(toast).not.toHaveBeenCalled();
    const marker = useNotificationsStore.getState().lastAnnouncedAt;

    // The mail arrives after that poll, so the server stamps it later than the
    // marker the poll recorded.
    const arrival = { ...mailRow, createdAt: new Date(Date.parse(marker!) + 1_000).toISOString() };
    getAll.mockResolvedValue([arrival] as any);
    await act(async () => { await refetchNotifications(); });

    await waitFor(() => expect(toast).toHaveBeenCalledWith('2 new messages', expect.anything()));
    expect(play).toHaveBeenCalledWith('soft', 0.6);
    expect(getAll).toHaveBeenCalledTimes(2);
  });

  it('backdates the EMPTY-poll marker, so a fast device clock cannot silence itself', async () => {
    // An empty feed proves ZERO notification rows exist for this user — the
    // feed filters on userId alone — so nothing can predate the marker and it
    // suppresses nothing real. Recording `now` therefore costs nothing when
    // the clock is right, and costs everything when it is not: the marker is
    // monotonic and persisted, so a device running ten minutes fast installs a
    // suppression floor in the future that never rewinds, and stays silent for
    // the whole skew. A minute back absorbs both the skew and any row created
    // during the response round-trip, and replays nothing, because there is
    // nothing to replay.
    useNotificationsStore.setState({ lastAnnouncedAt: null });
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([] as any);

    const before = Date.now();
    renderAlerts();
    await waitFor(() => expect(useNotificationsStore.getState().lastAnnouncedAt).not.toBeNull());

    const after = Date.now();
    const marker = Date.parse(useNotificationsStore.getState().lastAnnouncedAt!);
    // Exactly one minute behind this device's clock: far enough back to absorb
    // the skew and the round-trip, and no further — a marker in the distant
    // past would start announcing genuine history the moment rows appear.
    expect(marker).toBeGreaterThanOrEqual(before - 60_000);
    expect(marker).toBeLessThanOrEqual(after - 60_000);
  });

  it('announces only rows stamped AFTER the marker, never the ones behind it', async () => {
    // What this actually proves, and no more: rows older than the marker are
    // not announced, however many of them arrive in one feed. It is the fix
    // for the state that used to replay everything — a device whose first poll
    // came back EMPTY recorded no marker (newestCreatedAt([]) is null) while
    // an `initialized` flag said it had polled anyway, and that pair meant
    // "announce everything", so a 50-row feed played oldest-first. The marker
    // the empty poll now records is what dates those rows, and the flag is
    // gone.
    //
    // It is NOT a test that a device announces nothing after an absence, and
    // this test was named that way for a while. Rows that genuinely arrive
    // while a device is away are stamped AFTER its marker and ARE announced,
    // up to all fifty the feed carries. That is pre-existing behaviour and out
    // of scope here; it is recorded in spec §8 rather than papered over.
    const backlog = [0, 1, 2].map((i) => ({
      ...mailRow,
      id: `old-${i}`,
      title: `Backlog ${i}`,
      createdAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
    }));
    useNotificationsStore.setState({ lastAnnouncedAt: null });
    const getAll = vi.spyOn(api.notifications, 'getAll').mockResolvedValue([] as any);
    const play = vi.mocked(playTone);

    renderAlerts();
    // Wait on the QUERY, not on anything the fix writes, so this test measures
    // the announce pass rather than its own setup: the empty poll has landed,
    // and the flush runs the effect it scheduled.
    await waitFor(() => expect(queryClient.getQueryData(['notifications'])).toEqual([]));
    await act(async () => {});

    // Back from being closed. One row genuinely arrived after the marker the
    // empty poll recorded; the three behind it are history, and are here to be
    // ignored. The fresh row is what makes this assertable — it gives the poll
    // an observable effect to wait for, so "nothing else was announced" is
    // measured after the announce pass rather than before it. Its timestamp is
    // a few seconds ahead of this clock instead of derived from the marker, so
    // the assertion below reads the same whether or not a marker was recorded.
    const arrival = {
      ...mailRow, id: 'fresh', title: 'Just arrived',
      createdAt: new Date(Date.now() + 5_000).toISOString(),
    };
    getAll.mockResolvedValue([arrival, ...backlog] as any);
    await act(async () => { await refetchNotifications(); });

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Just arrived', expect.anything()));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
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

  it('leaves no hidden document, granted permission or Electron stub behind', () => {
    // A canary for the teardown above: a spied visibilityState getter and a
    // global Notification stub both survive clearAllMocks(), so a test added
    // after the hidden-window cases would silently inherit a hidden document
    // and announce through a branch it never asked for. Drop the afterEach
    // restore and this fails.
    expect(document.visibilityState).toBe('visible');
    expect(typeof Notification).toBe('undefined');
    expect((window as any).electronAPI).toBeUndefined();
  });
});
