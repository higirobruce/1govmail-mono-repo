import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { api } from '@/lib/api';
import {
  useInboxSync,
  INBOX_SYNC_FIRST_DELAY_MS,
  INBOX_SYNC_INTERVAL_MS,
} from './useInboxSync';

const inbox = { id: 'f1', path: '/Inbox', unreadCount: 4 };

/** Advance the clock and let the promises the timer started settle. */
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('useInboxSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete (window as any).electronAPI;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (window as any).electronAPI;
  });

  it('syncs folders in a plain browser, not only in Electron', async () => {
    // The server notices new mail ONLY during a folder sync, and the sidebar
    // stops its own poll while the mail page supplies folders. If this poll is
    // gated on Electron, a browser user sitting in the inbox never syncs again
    // after mount, so no NEW_MAIL row is ever created and nothing ever chimes.
    const getFolders = vi.spyOn(api.mail, 'getFolders').mockResolvedValue([inbox] as any);
    const onFolders = vi.fn();

    renderHook(() => useInboxSync(true, onFolders));
    expect(getFolders).not.toHaveBeenCalled();

    await tick(INBOX_SYNC_FIRST_DELAY_MS);
    expect(getFolders).toHaveBeenCalledTimes(1);
    expect(onFolders).toHaveBeenCalledWith([inbox]);
  });

  it('keeps syncing on the two-minute cadence the spec documents', async () => {
    const getFolders = vi.spyOn(api.mail, 'getFolders').mockResolvedValue([inbox] as any);

    renderHook(() => useInboxSync(true, vi.fn()));

    await tick(INBOX_SYNC_FIRST_DELAY_MS);
    expect(getFolders).toHaveBeenCalledTimes(1);
    await tick(INBOX_SYNC_INTERVAL_MS);
    expect(getFolders).toHaveBeenCalledTimes(2);
    await tick(INBOX_SYNC_INTERVAL_MS);
    expect(getFolders).toHaveBeenCalledTimes(3);
    expect(INBOX_SYNC_INTERVAL_MS).toBe(2 * 60 * 1000);
  });

  it('updates the dock badge when it runs inside Electron', async () => {
    // The badge and the tray are still Electron-only; only the folder sync
    // became universal.
    const setBadgeCount = vi.fn();
    (window as any).electronAPI = { isElectron: true, platform: 'darwin', setBadgeCount, sendNotification: vi.fn() };
    vi.spyOn(api.mail, 'getFolders').mockResolvedValue([inbox] as any);

    renderHook(() => useInboxSync(true, vi.fn()));
    await tick(INBOX_SYNC_FIRST_DELAY_MS);

    expect(setBadgeCount).toHaveBeenCalledWith(4);
  });

  it('still delivers the folder list in a browser, where there is no badge to set', async () => {
    vi.spyOn(api.mail, 'getFolders').mockResolvedValue([inbox] as any);
    const onFolders = vi.fn();

    renderHook(() => useInboxSync(true, onFolders));
    await tick(INBOX_SYNC_FIRST_DELAY_MS);

    expect((window as any).electronAPI).toBeUndefined();
    expect(onFolders).toHaveBeenCalledWith([inbox]);
  });

  it('does nothing at all until the user is authenticated', async () => {
    const getFolders = vi.spyOn(api.mail, 'getFolders').mockResolvedValue([inbox] as any);

    renderHook(() => useInboxSync(false, vi.fn()));
    await tick(INBOX_SYNC_FIRST_DELAY_MS + INBOX_SYNC_INTERVAL_MS);

    expect(getFolders).not.toHaveBeenCalled();
  });

  it('stops polling once the page unmounts', async () => {
    const getFolders = vi.spyOn(api.mail, 'getFolders').mockResolvedValue([inbox] as any);

    const { unmount } = renderHook(() => useInboxSync(true, vi.fn()));
    unmount();
    await tick(INBOX_SYNC_FIRST_DELAY_MS + INBOX_SYNC_INTERVAL_MS * 2);

    expect(getFolders).not.toHaveBeenCalled();
  });

  it('keeps polling after a failed sync — a flaky network must not end the feature', async () => {
    const getFolders = vi.spyOn(api.mail, 'getFolders')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([inbox] as any);
    const onFolders = vi.fn();

    renderHook(() => useInboxSync(true, onFolders));

    await tick(INBOX_SYNC_FIRST_DELAY_MS);
    expect(onFolders).not.toHaveBeenCalled();
    await tick(INBOX_SYNC_INTERVAL_MS);
    expect(getFolders).toHaveBeenCalledTimes(2);
    expect(onFolders).toHaveBeenCalledWith([inbox]);
  });

  it('ignores a folder list with no Inbox rather than guessing', async () => {
    const setBadgeCount = vi.fn();
    (window as any).electronAPI = { isElectron: true, platform: 'linux', setBadgeCount, sendNotification: vi.fn() };
    vi.spyOn(api.mail, 'getFolders').mockResolvedValue([{ id: 'f2', path: '/Sent', unreadCount: 0 }] as any);
    const onFolders = vi.fn();

    renderHook(() => useInboxSync(true, onFolders));
    await tick(INBOX_SYNC_FIRST_DELAY_MS);

    expect(setBadgeCount).not.toHaveBeenCalled();
    expect(onFolders).not.toHaveBeenCalled();
  });
});
