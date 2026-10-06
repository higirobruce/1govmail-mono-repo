import { MEETING_MIN_ATTENDEES, type OrgItem } from './org.types';

interface Range {
  aheadFrom: Date; aheadTo: Date; pastFrom: Date; pastTo: Date;
}

const EVENT_SELECT = {
  id: true, title: true, startAt: true, icalUid: true, attendees: true,
} as const;

/** The provider fills `attendees` on the organiser's row; other shapes have
 *  been seen in the wild, so anything that is not an array counts as zero. */
function attendeeCount(attendees: unknown): number {
  return Array.isArray(attendees) ? attendees.length : 0;
}

/**
 * Identity for de-duplication. `icalUid` is the real key, but it is absent on
 * most rows synced before it was introduced, so fall back to the pair that
 * actually identifies a meeting to a reader.
 */
function dedupeKey(row: { icalUid: string | null; title: string; startAt: Date }): string {
  return row.icalUid ?? `${row.title.trim().toLowerCase()}|${row.startAt.toISOString()}`;
}

function toItems(rows: Array<{
  id: string; title: string; startAt: Date; icalUid: string | null; attendees: unknown;
}>): OrgItem[] {
  const seen = new Set<string>();
  const out: OrgItem[] = [];
  for (const r of rows) {
    const count = attendeeCount(r.attendees);
    if (count < MEETING_MIN_ATTENDEES) continue;
    const key = dedupeKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'meeting',
      id: r.id,
      title: r.title,
      at: r.startAt.toISOString(),
      participantCount: count,
      // No href: `/calendar?event=${r.id}` resolves the ORGANISER's row via
      // findFirst({ where: { id, userId } }) — a 404 for everyone else in the
      // institution. Resolving the caller's own copy by icalUid is the richer
      // fix and is out of scope for this wave; until then, no dead links.
    });
  }
  return out;
}

/**
 * Meetings the institution is collectively having. Selection counts the
 * INVITATION, not how many mailboxes have synced a copy: only a fraction of
 * mailboxes carry an icalUid at all, so counting rows would measure sync
 * coverage rather than what the institution is doing.
 */
export async function selectMeetings(
  prisma: any,
  institutionId: string,
  range: Range,
): Promise<{ ahead: OrgItem[]; concluded: OrgItem[] }> {
  const [aheadRows, pastRows] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { user: { institutionId }, startAt: { gte: range.aheadFrom, lte: range.aheadTo } },
      select: EVENT_SELECT,
      orderBy: { startAt: 'asc' },
    }),
    prisma.calendarEvent.findMany({
      where: { user: { institutionId }, startAt: { gte: range.pastFrom, lt: range.pastTo } },
      select: EVENT_SELECT,
      orderBy: { startAt: 'desc' },
    }),
  ]);
  return { ahead: toItems(aheadRows), concluded: toItems(pastRows) };
}
