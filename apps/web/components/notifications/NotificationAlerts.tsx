'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useNotificationsStore } from '@/stores/notifications.store';
import { playTone, unlockAudio } from '@/lib/notifications/chime';
import {
  claimAnnouncement, isAudible, newestCreatedAt, selectNewNotifications,
  type NotificationRow,
} from '@/lib/notifications/announce';

/**
 * Raise ONE operating-system notification for a row.
 *
 * Electron first, when it is there: the desktop build shows it from the main
 * process, which also focuses the window when the user clicks it — something
 * the web API cannot do from a page that is in the background. That IPC lost
 * its only caller when the mail page's own alerting was removed, so the
 * desktop build had quietly given up native notifications altogether.
 *
 * Never both: two notifications for one arrival is worse than one. A browser
 * is unaffected — `window.electronAPI` is undefined there and the web
 * `Notification` API is used, still only with permission already granted
 * (permission is requested in Settings, never from here).
 */
function raiseOsNotification(row: NotificationRow): void {
  const electron = typeof window === 'undefined' ? undefined : window.electronAPI;
  if (electron?.sendNotification) {
    electron.sendNotification(row.title, row.body ?? '');
    return;
  }

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(row.title, { body: row.body ?? undefined, tag: row.id });
  } catch {
    // Notification can throw on platforms that require a service worker; the
    // toast and chime have already done the job.
  }
}

/**
 * Turns the notification feed into things a person can notice: a toast, a
 * chime, and — only when the window is hidden — an operating-system
 * notification.
 *
 * Mounted ONCE in the (app) layout, so every page alerts, not just Mail. It
 * shares the query key 'notifications' with the bell, so the two ride one
 * request and can never disagree about what has arrived.
 */
export function NotificationAlerts() {
  const soundEnabled = useNotificationsStore((s) => s.soundEnabled);
  const volume = useNotificationsStore((s) => s.volume);
  const tones = useNotificationsStore((s) => s.tones);
  const setLastAnnouncedAt = useNotificationsStore((s) => s.setLastAnnouncedAt);

  const { data: feed = [], isSuccess } = useQuery<NotificationRow[]>({
    queryKey: ['notifications'],
    queryFn: () => api.notifications.getAll(50) as Promise<NotificationRow[]>,
    refetchInterval: 30_000,
    // react-query gates a refetchInterval on
    // `refetchIntervalInBackground || focusManager.isFocused()`, and its focus
    // manager counts a hidden document as unfocused. Without this flag the
    // poll stops the moment the window goes to the background — which is
    // exactly when the OS-notification branch below is the only way to reach
    // the user, so the two conditions would be mutually exclusive and that
    // whole delivery tier dead code.
    //
    // Timers are per-observer in query-core (QueryObserver holds its own
    // options and its own interval id), so this turns background polling on
    // for THIS mount only — the bell's identical query keeps its
    // focus-gated interval and simply reads whatever this fetch put in the
    // shared cache.
    refetchIntervalInBackground: true,
    staleTime: 20_000,
  });

  // Browsers refuse audio until the user has interacted with the page. The
  // first gesture after mount is enough, and costs nothing if audio is already
  // allowed.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    // Gate on a COMPLETED poll rather than on a non-empty feed: an empty feed
    // is a poll too, and it still has to leave a marker behind (see the
    // `finally` below). Treating it as "nothing happened" is what left a
    // device with no marker at all, and it then swallowed its first real alert
    // as well as the backlog it never had.
    if (!isSuccess) return;

    const marker = useNotificationsStore.getState().lastAnnouncedAt;
    const fresh = selectNewNotifications(feed, marker);

    try {
      for (const row of fresh) {
        // One tab announces; the others see the claim and stay quiet.
        if (!claimAnnouncement(row.id)) continue;

        try {
          toast(row.title, { description: row.body ?? undefined });

          if (soundEnabled && isAudible(row.type)) {
            void playTone(tones[row.type], volume);
          }

          // An OS notification is for when the user is looking somewhere else.
          // Raising one over a window they are already reading is just noise.
          if (document.visibilityState === 'hidden') raiseOsNotification(row);
        } catch {
          // One bad row must not stop the rows behind it. The marker still
          // advances past it in the `finally` below, so a row that keeps
          // throwing gets skipped forever rather than jamming every row
          // behind it.
        }
      }
    } finally {
      // Move the marker even when nothing was announced (first run, another
      // tab claimed everything, or a row threw) so the same rows are never
      // reconsidered and a failure here can never strand it.
      const newest = newestCreatedAt(feed);
      if (newest) {
        setLastAnnouncedAt(newest);
      } else if (!marker) {
        // An EMPTY first poll still has to leave a marker behind. Left null it
        // meant one of two things and the code could not tell which: "never
        // polled, suppress the backlog" or "polled, nothing was there". The
        // flag that used to disambiguate it replayed whole backlogs of its own
        // — a device closed on an empty poll, rows piling up server-side, and
        // fifty toasts plus a chime per audible row on its return. Recording a
        // marker here means a null marker only ever means "never polled".
        //
        // Backdated by a minute, deliberately. An empty feed proves ZERO
        // notification rows exist for this user (the feed filters on userId
        // alone), so nothing can predate this marker and it suppresses nothing
        // real — which makes a minute of slack free, and makes recording `now`
        // the expensive option. The marker is monotonic and persisted, so a
        // device whose clock runs fast would otherwise install a suppression
        // floor in the FUTURE that never rewinds, and hear nothing for the
        // whole skew. The minute also covers a row created while this response
        // was in flight, which even a perfect clock would have lost.
        setLastAnnouncedAt(new Date(Date.now() - 60_000).toISOString());
      }
    }
  }, [feed, isSuccess, soundEnabled, volume, tones, setLastAnnouncedAt]);

  return null;
}
