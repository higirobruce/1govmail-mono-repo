'use client';

import type { AudibleType } from '@/stores/notifications.store';

/** One row of GET /notifications. */
export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  actionUrl?: string | null;
  createdAt: string;
  isRead?: boolean;
}

/** The only two types worth interrupting someone for. */
export const AUDIBLE_TYPES = ['NEW_MAIL', 'EVENT_SOON'] as const;

export function isAudible(type: string): type is AudibleType {
  return (AUDIBLE_TYPES as readonly string[]).includes(type);
}

/**
 * The rows this device has not announced yet, oldest first.
 *
 * `lastAnnouncedAt === null` means this device has never announced anything, and
 * returns NOTHING on purpose: the feed holds up to 50 rows and replaying them as
 * a burst of chimes at login would be the first thing a user disables.
 */
export function selectNewNotifications(
  feed: NotificationRow[],
  lastAnnouncedAt: string | null,
): NotificationRow[] {
  if (!lastAnnouncedAt) return [];
  return feed
    // Lexicographic comparison is only correct because createdAt is always the
    // API's JSON serialization of a Prisma DateTime: ISO-8601, UTC, constant
    // precision. A differently-formatted or non-UTC timestamp would sort wrong.
    .filter((n) => n.createdAt > lastAnnouncedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The newest `createdAt` in the feed, or null when it is empty. */
export function newestCreatedAt(feed: NotificationRow[]): string | null {
  return feed.reduce<string | null>(
    (newest, n) => (!newest || n.createdAt > newest ? n.createdAt : newest),
    null,
  );
}

const CLAIM_PREFIX = '1gov-announced:';
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Claim the right to announce `id`, across every tab of this browser.
 *
 * Server-side dedupe yields ONE notification row, but every open tab reads that
 * row and would chime. The first tab to write the claim key announces; the rest
 * see it and stay quiet. A lost race costs one duplicate chime, which is why
 * this is a plain key rather than a coordination protocol.
 */
export function claimAnnouncement(id: string, now: number = Date.now()): boolean {
  try {
    const key = `${CLAIM_PREFIX}${id}`;
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, String(now));

    // Opportunistic sweep: claims are worthless once they are a day old, and
    // nothing else would ever remove them.
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (!k?.startsWith(CLAIM_PREFIX)) continue;
      const at = Number(localStorage.getItem(k));
      if (!Number.isFinite(at) || now - at > CLAIM_TTL_MS) localStorage.removeItem(k);
    }
    return true;
  } catch {
    // Private mode or a full quota: announce rather than stay silent.
    return true;
  }
}
