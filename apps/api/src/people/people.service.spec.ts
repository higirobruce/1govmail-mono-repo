import { BadRequestException } from '@nestjs/common';
import { PeopleService } from './people.service';

const NOW = new Date('2026-09-06T10:00:00Z');

function makePrisma() {
  return {
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'me@risa.gov.rw' }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    calendarEvent: { findMany: jest.fn().mockResolvedValue([]) },
    documentInvite: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
}

describe('PeopleService.dossier', () => {
  // PeopleService.dossier's upcoming/past split compares event startAt
  // against Date.now() — pin the clock to NOW so fixtures dated around it
  // (e.g. the sharedEvents test below) stay deterministic as real time passes.
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it('rejects the user own address (case-insensitively)', async () => {
    const svc = new PeopleService(makePrisma());
    await expect(svc.dossier('u1', 'ME@risa.gov.rw')).rejects.toThrow(BadRequestException);
  });

  it('lowercases the email and builds the profile from the stats row', async () => {
    const prisma = makePrisma();
    // 1st $queryRaw = stats, 2nd = recent messages, 3rd = commitments
    prisma.$queryRaw
      .mockResolvedValueOnce([{ firstSeenAt: new Date('2026-01-01'), lastSeenAt: NOW, received90d: 7, sent90d: 3 }])
      .mockResolvedValueOnce([
        { id: 'm2', conversationId: 'c1', subject: 'Re: budget', snippet: 'ok', fromEmail: 'jd@gov.rw', fromName: 'J D', receivedAt: NOW },
        { id: 'm1', conversationId: 'c1', subject: 'budget', snippet: 'hi', fromEmail: 'me@risa.gov.rw', fromName: null, receivedAt: new Date('2026-09-01') },
      ])
      .mockResolvedValueOnce([]);
    const d = await new PeopleService(prisma).dossier('u1', 'JD@gov.rw');
    expect(d.profile).toEqual({
      email: 'jd@gov.rw', name: 'J D',
      firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: NOW.toISOString(),
      received90d: 7, sent90d: 3,
    });
  });

  it('dedupes recentConversations by conversationId keeping the newest, marks direction', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ firstSeenAt: null, lastSeenAt: null, received90d: 0, sent90d: 0 }])
      .mockResolvedValueOnce([
        { id: 'm3', conversationId: 'c1', subject: 'Re: x', snippet: null, fromEmail: 'jd@gov.rw', fromName: null, receivedAt: NOW },
        { id: 'm2', conversationId: 'c1', subject: 'x', snippet: null, fromEmail: 'me@risa.gov.rw', fromName: null, receivedAt: new Date('2026-09-01') },
        { id: 'm1', conversationId: null, subject: 'solo', snippet: null, fromEmail: 'jd@gov.rw', fromName: null, receivedAt: new Date('2026-08-01') },
      ])
      .mockResolvedValueOnce([]);
    const d = await new PeopleService(prisma).dossier('u1', 'jd@gov.rw');
    expect(d.recentConversations.map((c) => c.messageId)).toEqual(['m3', 'm1']);
    expect(d.recentConversations[0].direction).toBe('in');
  });

  it('splits sharedEvents into upcoming (asc, max 5) and past (desc, max 3)', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ firstSeenAt: null, lastSeenAt: null, received90d: 0, sent90d: 0 }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([])
      // 4th $queryRaw = shared events
      .mockResolvedValueOnce([
        { id: 'e-past', title: 'old', startAt: new Date('2026-08-01T09:00Z'), endAt: new Date('2026-08-01T10:00Z') },
        { id: 'e-next', title: 'next', startAt: new Date('2026-09-08T09:00Z'), endAt: new Date('2026-09-08T10:00Z') },
        { id: 'e-later', title: 'later', startAt: new Date('2026-09-20T09:00Z'), endAt: new Date('2026-09-20T10:00Z') },
      ]);
    const d = await new PeopleService(prisma).dossier('u1', 'jd@gov.rw');
    expect(d.sharedEvents.map((e) => e.id)).toEqual(['e-next', 'e-later', 'e-past']);
    expect(d.sharedEvents[0].upcoming).toBe(true);
    expect(d.sharedEvents[2].upcoming).toBe(false);
  });

  it('splits sharedDocs by direction', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ firstSeenAt: null, lastSeenAt: null, received90d: 0, sent90d: 0 }])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prisma.documentInvite.findMany
      .mockResolvedValueOnce([{ document: { id: 'd1', title: 'Mine', emoji: null } }])   // i-shared
      .mockResolvedValueOnce([{ document: { id: 'd2', title: 'Theirs', emoji: '📄' } }]); // they-shared
    const d = await new PeopleService(prisma).dossier('u1', 'jd@gov.rw');
    expect(d.sharedDocs).toEqual([
      { id: 'd1', title: 'Mine', emoji: null, direction: 'i-shared' },
      { id: 'd2', title: 'Theirs', emoji: '📄', direction: 'they-shared' },
    ]);
  });
});
