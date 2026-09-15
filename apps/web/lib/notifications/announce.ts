'use client';

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

/**
 * The only two types worth interrupting someone for.
 *
 * This array is the single source of truth and the union below is DERIVED from
 * it, because the two used to be declared independently — and drift between
 * them degrades to silence: a type in the union with no entry here is never
 * announced, and a tone lookup for a type the store has no tone for throws
 * inside `playTone`, which swallows it. Silence is the one failure direction
 * this feature must never take.
 */
export const AUDIBLE_TYPES = ['NEW_MAIL', 'EVENT_SOON'] as const;

/** A notification type that makes a sound. Derived from AUDIBLE_TYPES. */
export type AudibleType = (typeof AUDIBLE_TYPES)[number];

export function isAudible(type: string): type is AudibleType {
  return (AUDIBLE_TYPES as readonly string[]).includes(type);
}

/**
 * The rows this device has not announced yet, oldest first.
 *
 * With no marker there are two different situations, and conflating them cost
 * a real alert:
 *
 * - `initialized === false` — this device has never completed a poll. Whatever
 *   the feed holds is a BACKLOG (up to 50 rows), and replaying it as a burst of
 *   chimes at login is the first thing a user would disable, so nothing is
 *   returned and the caller records the marker instead.
 * - `initialized === true` — this device polled and recorded no marker, which
 *   only the build that had the empty-poll bug could leave behind: it marked
 *   the device initialized and skipped the marker, because
 *   `newestCreatedAt([])` is null. An empty poll now records the client's own
 *   ISO time (see NotificationAlerts), so a store written by THIS build never
 *   reaches here. The branch stays for the stores that build left behind, and
 *   announces rather than suppresses for the same reason as everywhere else:
 *   silence is the one failure direction this feature must never take.
 */
export function selectNewNotifications(
  feed: NotificationRow[],
  lastAnnouncedAt: string | null,
  initialized = false,
): NotificationRow[] {
  if (!lastAnnouncedAt) {
    if (!initialized) return [];
    return [...feed].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
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
 * this is a plain key rather than a coordination protocol. Returns true when
 * storage is unavailable — see the catch below for what that costs.
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
    // Private mode or a full quota: announce rather than stay silent. Note the
    // real cost when storage is broken for the whole session rather than for
    // one call — no claim can ever be written, so EVERY tab announces EVERY
    // row and a user with three tabs open hears three chimes per arrival.
    // Still the right trade: the alternative is hearing nothing at all.
    return true;
  }
}
