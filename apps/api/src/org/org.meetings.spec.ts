import { selectMeetings } from './org.meetings';

const range = {
  aheadFrom: new Date('2026-10-06T00:00:00Z'),
  aheadTo:   new Date('2026-10-13T00:00:00Z'),
  pastFrom:  new Date('2026-09-29T00:00:00Z'),
  pastTo:    new Date('2026-10-06T00:00:00Z'),
};

const ev = (over: Partial<any> = {}) => ({
  id: 'e1',
  title: 'Network readiness review',
  startAt: new Date('2026-10-08T09:00:00Z'),
  icalUid: 'uid-1',
  attendees: [{ email: 'a@risa.gov.rw' }, { email: 'b@risa.gov.rw' }],
  ...over,
});

function makePrisma(rows: any[]) {
  return { calendarEvent: { findMany: jest.fn().mockResolvedValue(rows) } } as any;
}

describe('selectMeetings', () => {
  // Review Focus #2 — a missing institution filter is a cross-institution leak.
  it('scopes every query to the institution', async () => {
    const prisma = makePrisma([]);
    await selectMeetings(prisma, 'risa', range);
    // A for-of over zero calls would vacuously pass every assertion below,
    // so pin down that both the ahead and past queries actually ran.
    expect(prisma.calendarEvent.findMany).toHaveBeenCalledTimes(2);
    for (const call of prisma.calendarEvent.findMany.mock.calls) {
      expect(call[0].where.user).toEqual({ institutionId: 'risa' });
    }
  });

  it('keeps an event at the attendee threshold', async () => {
    const prisma = makePrisma([ev()]);
    const out = await selectMeetings(prisma, 'risa', range);
    expect(out.ahead).toHaveLength(1);
    expect(out.ahead[0]).toEqual({
      kind: 'meeting',
      id: 'e1',
      title: 'Network readiness review',
      at: '2026-10-08T09:00:00.000Z',
      participantCount: 2,
    });
  });

  it('drops an event below the threshold', async () => {
    const prisma = makePrisma([ev({ attendees: [{ email: 'only@risa.gov.rw' }] })]);
    const out = await selectMeetings(prisma, 'risa', range);
    // An empty expectation is satisfied by a stub that never queries at all,
    // so confirm the row was actually fetched and then filtered out.
    expect(prisma.calendarEvent.findMany).toHaveBeenCalledTimes(2);
    expect(out.ahead).toHaveLength(0);
  });

  // Review Focus #3 — providers vary; a bad column must not break the lane.
  it('survives attendees that are null, missing, or not an array', async () => {
    const prisma = makePrisma([
      ev({ id: 'a', attendees: null }),
      ev({ id: 'b', attendees: undefined }),
      ev({ id: 'c', attendees: 'nonsense' }),
      ev({ id: 'd', attendees: {} }),
    ]);
    const out = await selectMeetings(prisma, 'risa', range);
    // Same vacuous-pass risk as above: a no-op stub also yields two empty
    // arrays, so pin down that the rows were fetched and then rejected.
    expect(prisma.calendarEvent.findMany).toHaveBeenCalledTimes(2);
    expect(out.ahead).toEqual([]);
    expect(out.concluded).toEqual([]);
  });

  it('shows a meeting once when two mailboxes hold it', async () => {
    const prisma = makePrisma([
      ev({ id: 'copy-1', icalUid: 'shared-uid' }),
      ev({ id: 'copy-2', icalUid: 'shared-uid' }),
    ]);
    const out = await selectMeetings(prisma, 'risa', range);
    expect(out.ahead).toHaveLength(1);
  });

  // icalUid is absent on most historical rows; the fallback key carries them.
  it('de-duplicates on title and start when icalUid is missing', async () => {
    const prisma = makePrisma([
      ev({ id: 'x', icalUid: null }),
      ev({ id: 'y', icalUid: null, title: 'NETWORK READINESS REVIEW' }),
    ]);
    const out = await selectMeetings(prisma, 'risa', range);
    expect(out.ahead).toHaveLength(1);
  });

  it('separates future meetings from concluded ones', async () => {
    const prisma = makePrisma([]);
    await selectMeetings(prisma, 'risa', range);
    const wheres = prisma.calendarEvent.findMany.mock.calls.map((c: any[]) => c[0].where.startAt);
    expect(wheres).toContainEqual({ gte: range.aheadFrom, lte: range.aheadTo });
    expect(wheres).toContainEqual({ gte: range.pastFrom, lt: range.pastTo });
  });
});
