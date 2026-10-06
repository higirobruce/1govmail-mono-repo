import { OrgService } from './org.service';

export function makePrisma() {
  return {
    user: { findUnique: jest.fn() },
    calendarEvent: { findMany: jest.fn().mockResolvedValue([]) },
    document: { findMany: jest.fn().mockResolvedValue([]) },
    meetingMinutes: { findMany: jest.fn().mockResolvedValue([]) },
    orgDigestNarrative: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
  } as any;
}

const makeNarrative = () => ({ get: jest.fn().mockResolvedValue(null) }) as any;
const makeService = (prisma: any, narrative: any = makeNarrative()) =>
  new OrgService(prisma, narrative);

describe('OrgService institution scoping', () => {
  it('reads the institution from the user, never from the caller', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ institutionId: 'risa' });
    const svc = makeService(prisma);

    await expect(svc.resolveInstitution('u1')).resolves.toBe('risa');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { institutionId: true },
    });
  });

  // Review Focus #1 — the fail-open version of this is the whole privacy risk.
  it('returns an EMPTY digest when the caller has no institution', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ institutionId: null });
    const narrative = makeNarrative();
    const svc = makeService(prisma, narrative);

    const d = await svc.getDigest('u1', 'week');

    expect(d).toEqual({
      window: 'week', institutionId: null, narrative: null, ahead: [], concluded: [],
    });
    // Nothing may even be queried for a caller with no institution.
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.document.findMany).not.toHaveBeenCalled();
    expect(prisma.meetingMinutes.findMany).not.toHaveBeenCalled();
    // Strengthened: the guard must also block the model call, not just the lists.
    expect(narrative.get).not.toHaveBeenCalled();
  });

  it('returns an EMPTY digest when the user row is missing', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const svc = makeService(prisma);

    const d = await svc.getDigest('ghost', 'day');
    expect(d.institutionId).toBeNull();
    expect(d.ahead).toEqual([]);
  });

  // Strengthened: none of the above tests exercise getDigest with a valid
  // institution, so a hard-coded "always fail closed" bug would slip past
  // all of them. This asserts the happy path actually carries the real id.
  it('carries the caller institution id through when one is present', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ institutionId: 'risa' });
    const svc = makeService(prisma);

    const d = await svc.getDigest('u1', 'month');

    expect(d.institutionId).toBe('risa');
    expect(d.window).toBe('month');
  });

  it('splits the window into a future and a past range', () => {
    const svc = makeService(makePrisma());
    const before = Date.now();
    const r = svc.windowRange('week');
    const after = Date.now();
    expect(r.aheadFrom.getTime()).toBeLessThanOrEqual(r.aheadTo.getTime());
    expect(r.pastFrom.getTime()).toBeLessThanOrEqual(r.pastTo.getTime());
    // 7 days each side.
    expect(Math.round((r.aheadTo.getTime() - r.aheadFrom.getTime()) / 86400000)).toBe(7);
    expect(Math.round((r.pastTo.getTime() - r.pastFrom.getTime()) / 86400000)).toBe(7);
    // Strengthened: pin which side is actually future vs past — the original
    // assertions only checked widths, so a swapped ahead/past would still pass.
    expect(r.aheadFrom.getTime()).toBeGreaterThanOrEqual(before);
    expect(r.aheadFrom.getTime()).toBeLessThanOrEqual(after);
    expect(r.pastTo.getTime()).toBeGreaterThanOrEqual(before);
    expect(r.pastTo.getTime()).toBeLessThanOrEqual(after);
    expect(r.aheadTo.getTime()).toBeGreaterThan(after);
    expect(r.pastFrom.getTime()).toBeLessThan(before);
  });

  it('puts meetings ahead of documents in the concluded list', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ institutionId: 'risa' });
    prisma.calendarEvent.findMany.mockResolvedValue([{
      id: 'past-meeting', title: 'Review', startAt: new Date('2026-10-01T09:00:00Z'),
      icalUid: 'u', attendees: [{ email: 'a@x' }, { email: 'b@x' }],
    }]);
    prisma.document.findMany.mockResolvedValue([{
      id: 'doc', title: 'Plan', updatedAt: new Date('2026-10-05T09:00:00Z'), invites: [],
    }]);
    const svc = makeService(prisma);

    const d = await svc.getDigest('u1', 'week');
    // The document is NEWER, and still comes second: meetings lead by decision.
    expect(d.concluded.map((i: any) => i.kind)).toEqual(['meeting', 'document']);
  });

  // Strengthened: every other test here uses the default narrative stub that
  // always resolves null, so a getDigest that never calls narrative.get (or
  // ignores what it returns) would pass all of them. This pins both that the
  // model is actually invoked with the real assembled items and that its
  // result is the one returned to the caller.
  it('passes the assembled items to the narrative and surfaces its result', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ institutionId: 'risa' });
    prisma.calendarEvent.findMany
      .mockResolvedValueOnce([{
        id: 'future-meeting', title: 'Kickoff', startAt: new Date('2026-10-10T09:00:00Z'),
        icalUid: 'f1', attendees: [{ email: 'a@x' }, { email: 'b@x' }],
      }])
      .mockResolvedValueOnce([{
        id: 'past-meeting', title: 'Review', startAt: new Date('2026-10-01T09:00:00Z'),
        icalUid: 'p1', attendees: [{ email: 'a@x' }, { email: 'b@x' }],
      }]);
    prisma.document.findMany.mockResolvedValue([{
      id: 'doc', title: 'Plan', updatedAt: new Date('2026-10-05T09:00:00Z'), invites: [],
    }]);
    const narrative = { get: jest.fn().mockResolvedValue('synthesized narrative') };
    const svc = makeService(prisma, narrative);

    const d = await svc.getDigest('u1', 'week');

    expect(d.narrative).toBe('synthesized narrative');
    expect(narrative.get).toHaveBeenCalledWith(
      'risa',
      'week',
      [
        expect.objectContaining({ kind: 'meeting', id: 'future-meeting' }),
        expect.objectContaining({ kind: 'meeting', id: 'past-meeting' }),
        expect.objectContaining({ kind: 'document', id: 'doc' }),
      ],
    );
  });
});
