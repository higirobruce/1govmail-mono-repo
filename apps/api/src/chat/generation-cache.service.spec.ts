import { GenerationCacheService } from './generation-cache.service';

const ANCHOR = new Date('2026-09-05T12:00:00Z');
const ROW = {
  content: 'brief', sources: [], model: 'm', sourceAnchor: ANCHOR,
  generatedAt: new Date('2026-09-05T12:01:00Z'),
};

function makePrisma() {
  return {
    aiGeneration: { findUnique: jest.fn(), upsert: jest.fn().mockResolvedValue({}) },
    calendarEvent: { findFirst: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ newest: null }]),
  } as any;
}

describe('GenerationCacheService', () => {
  it('returns null when no row', async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(null);
    expect(await new GenerationCacheService(prisma).get('u1', 'dossier', 'jd@gov.rw')).toBeNull();
  });

  it('dossier: fresh when no newer mail involves the person', async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(ROW);
    prisma.$queryRaw.mockResolvedValue([{ newest: ANCHOR }]); // nothing after anchor
    const got = await new GenerationCacheService(prisma).get('u1', 'dossier', 'jd@gov.rw');
    expect(got).toEqual({ content: 'brief', sources: [], generatedAt: ROW.generatedAt.toISOString(), stale: false });
  });

  it('dossier: stale when newer mail exists', async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(ROW);
    prisma.$queryRaw.mockResolvedValue([{ newest: new Date('2026-09-06T08:00:00Z') }]);
    const got = await new GenerationCacheService(prisma).get('u1', 'dossier', 'jd@gov.rw');
    expect(got?.stale).toBe(true);
  });

  it("meeting_prep: null when the event is gone (or not the caller's)", async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(ROW);
    prisma.calendarEvent.findFirst.mockResolvedValue(null);
    expect(await new GenerationCacheService(prisma).get('u1', 'meeting_prep', 'e1')).toBeNull();
  });

  it('meeting_prep: stale when the event was updated after the anchor', async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(ROW);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      updatedAt: new Date('2026-09-06T09:00:00Z'), attendees: [],
    });
    const got = await new GenerationCacheService(prisma).get('u1', 'meeting_prep', 'e1');
    expect(got?.stale).toBe(true);
  });

  it('meeting_prep: stale when newer mail from an attendee exists', async () => {
    const prisma = makePrisma();
    prisma.aiGeneration.findUnique.mockResolvedValue(ROW);
    prisma.calendarEvent.findFirst.mockResolvedValue({
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      attendees: [{ email: 'JD@gov.rw' }],
    });
    prisma.$queryRaw.mockResolvedValue([{ newest: new Date('2026-09-06T08:00:00Z') }]);
    const got = await new GenerationCacheService(prisma).get('u1', 'meeting_prep', 'e1');
    expect(got?.stale).toBe(true);
  });

  it('upsert writes the unique triple', async () => {
    const prisma = makePrisma();
    await new GenerationCacheService(prisma).upsert('u1', 'dossier', 'jd@gov.rw', {
      content: 'x', sources: [], model: 'm', sourceAnchor: ANCHOR,
    });
    expect(prisma.aiGeneration.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_kind_targetKey: { userId: 'u1', kind: 'dossier', targetKey: 'jd@gov.rw' } },
    }));
  });
});
