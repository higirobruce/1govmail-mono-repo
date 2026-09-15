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
 * A null marker means this device has never completed a poll, and returns
 * NOTHING: whatever the feed holds is a BACKLOG (up to 50 rows), and replaying
 * it as a burst of chimes at login is the first thing a user would disable.
 * The caller records a marker in the same pass — the newest row's `createdAt`,
 * or its own clock when the feed came back empty — so a null marker cannot
 * survive a poll and this branch only ever suppresses a genuine backlog.
 *
 * It suppresses ONLY that one. Rows stamped after a device's marker are all
 * announced, however long it was away and however many there are — see spec
 * §8. Nothing here dates a row as "too old to be worth saying".
 *
 * That marker-on-an-empty-poll is what makes a single condition enough here.
 * An earlier build left the marker null on an empty poll and needed an
 * `initialized` flag to tell "never polled" from "polled, nothing to record";
 * the two then disagreed on a device that came back to a full feed and it
 * announced all fifty rows.
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
