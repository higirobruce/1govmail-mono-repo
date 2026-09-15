'use client';

import { useEffect, useRef } from 'react';
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
  const announcing = useRef(false);

  const { data: feed = [] } = useQuery<NotificationRow[]>({
    queryKey: ['notifications'],
    queryFn: () => api.notifications.getAll(50) as Promise<NotificationRow[]>,
    refetchInterval: 30_000,
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
    if (!feed.length || announcing.current) return;
    announcing.current = true;

    const marker = useNotificationsStore.getState().lastAnnouncedAt;
    const fresh = selectNewNotifications(feed, marker);

    for (const row of fresh) {
      // One tab announces; the others see the claim and stay quiet.
      if (!claimAnnouncement(row.id)) continue;

      toast(row.title, { description: row.body ?? undefined });

      if (soundEnabled && isAudible(row.type)) {
        void playTone(tones[row.type], volume);
      }

      // An OS notification is for when the user is looking somewhere else.
      // Raising one over a window they are already reading is just noise.
      if (document.visibilityState === 'hidden' && typeof Notification !== 'undefined'
          && Notification.permission === 'granted') {
        try {
          new Notification(row.title, { body: row.body ?? undefined, tag: row.id });
        } catch {
          // Notification can throw on platforms that require a service worker;
          // the toast and chime have already done the job.
        }
      }
    }

    // Move the marker even when nothing was announced (first run, or another
    // tab claimed everything) so the same rows are never reconsidered.
    const newest = newestCreatedAt(feed);
    if (newest) setLastAnnouncedAt(newest);
    announcing.current = false;
  }, [feed, soundEnabled, volume, tones, setLastAnnouncedAt]);

  return null;
}
