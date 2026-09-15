'use client';

import { useEffect } from 'react';
import { api } from '@/lib/api';

/** First sync after mount, late enough to let the initial folder load finish. */
export const INBOX_SYNC_FIRST_DELAY_MS = 10_000;
/** The documented cadence: a chime can lag the mail by up to two minutes. */
export const INBOX_SYNC_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Keep re-syncing folders while the mail page is open.
 *
 * This poll is what makes new mail audible AT ALL, in every environment. The
 * server detects an arrival only during a folder sync — that is the one moment
 * it holds both the stored unread count and the one the provider just reported
 * — and the sidebar switches its own 60-second poll off while the mail page
 * supplies folders. Gate this on Electron and a browser user sitting in the
 * inbox never calls getFolders again after mount: no NEW_MAIL row, no toast, no
 * sound. It used to be gated, which made the feature's headline promise
 * unreachable for exactly the user it was written for.
 *
 * The Electron-only extras stay Electron-only, and stay optional-chained: the
 * dock badge has no browser equivalent, so it simply does not happen there.
 *
 * `onFolders` is expected to be a stable setter (a `useState` setter or a store
 * action) — it is in the effect's dependency list, so an inline closure would
 * restart the interval on every render.
 */
export function useInboxSync(enabled: boolean, onFolders: (folders: any[]) => void): void {
  useEffect(() => {
    if (!enabled) return;

    const checkInbox = async () => {
      try {
        const data: any[] = await api.mail.getFolders();
        const inbox = data.find((f) => f.path === '/Inbox');
        if (!inbox) return;

        const currentUnread: number = inbox.unreadCount ?? 0;

        // New-mail alerting lives in NotificationAlerts (app shell) now, driven
        // by the server-side NEW_MAIL notification this very sync creates.
        // Announcing here too would make the desktop build alert twice.

        // Update the Dock badge on macOS — Electron only, hence the optional call.
        window.electronAPI?.setBadgeCount(currentUnread);

        // Refresh the sidebar folder list if unread counts shifted.
        onFolders(data);
      } catch {
        // Polling is best-effort — a silent failure keeps the app stable and
        // the next tick tries again.
      }
    };

    const initial = setTimeout(checkInbox, INBOX_SYNC_FIRST_DELAY_MS);
    const interval = setInterval(checkInbox, INBOX_SYNC_INTERVAL_MS);

    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [enabled, onFolders]);
}
