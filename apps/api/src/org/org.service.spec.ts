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

const makeService = (prisma: any) => new OrgService(prisma);

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
    const svc = makeService(prisma);

    const d = await svc.getDigest('u1', 'week');

    expect(d).toEqual({
      window: 'week', institutionId: null, narrative: null, ahead: [], concluded: [],
    });
    // Nothing may even be queried for a caller with no institution.
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.document.findMany).not.toHaveBeenCalled();
    expect(prisma.meetingMinutes.findMany).not.toHaveBeenCalled();
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
});
