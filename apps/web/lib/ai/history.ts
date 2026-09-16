import { sourceHref } from './sourceNav';

export interface HistoryItem {
  id: string;
  title: string;
  scopeKind: string;
  scopeId: string | null;
  scopeLabel: string | null;
  lastTurnAt: string;
  turnCount: number;
}

const DAY = 86_400_000;

/**
 * Bucket a newest-first list by recency. Buckets with nothing in them are
 * dropped, so the page never renders an empty heading.
 */
export function groupByRecency(
  items: HistoryItem[],
  now: Date,
): Array<{ bucket: string; items: HistoryItem[] }> {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();

  const buckets: Array<{ bucket: string; items: HistoryItem[] }> = [
    { bucket: 'Today', items: [] },
    { bucket: 'Yesterday', items: [] },
    { bucket: 'Earlier this week', items: [] },
    { bucket: 'Older', items: [] },
  ];

  for (const it of items) {
    const at = new Date(it.lastTurnAt).getTime();
    if (at >= t0) buckets[0].items.push(it);
    else if (at >= t0 - DAY) buckets[1].items.push(it);
    else if (at >= t0 - 7 * DAY) buckets[2].items.push(it);
    else buckets[3].items.push(it);
  }

  return buckets.filter((b) => b.items.length > 0);
}

/**
 * Where Resume should navigate, or null to open the panel where the user
 * already is.
 *
 * Routes go through sourceHref so there is ONE definition of the mail and docs
 * deep links — two hand-written ones that no page handled were the Critical
 * finding of the meeting-minutes review.
 *
 * A scoped conversation whose target is gone returns null rather than a broken
 * path: the transcript is still worth reading.
 */
export function resumeTarget(c: { scopeKind: string; scopeId: string | null }): string | null {
  if (!c.scopeId) return null;
  if (c.scopeKind === 'thread') return sourceHref({ type: 'mail', id: c.scopeId });
  if (c.scopeKind === 'doc') return sourceHref({ type: 'doc', id: c.scopeId });
  return null;
}

export function scopeChipLabel(c: { scopeKind: string; scopeLabel: string | null }): string {
  if (c.scopeKind === 'thread') return c.scopeLabel ? `Thread: ${c.scopeLabel}` : 'Thread';
  if (c.scopeKind === 'doc') return c.scopeLabel ? `Doc: ${c.scopeLabel}` : 'Doc';
  return 'Anywhere';
}
