import { selectDocumentsAndMinutes } from './org.documents';

const range = {
  aheadFrom: new Date('2026-10-06T00:00:00Z'),
  aheadTo:   new Date('2026-10-13T00:00:00Z'),
  pastFrom:  new Date('2026-09-29T00:00:00Z'),
  pastTo:    new Date('2026-10-06T00:00:00Z'),
};

function makePrisma(docs: any[] = [], minutes: any[] = []) {
  return {
    document: { findMany: jest.fn().mockResolvedValue(docs) },
    meetingMinutes: { findMany: jest.fn().mockResolvedValue(minutes) },
  } as any;
}

const doc = (over: Partial<any> = {}) => ({
  id: 'd1',
  title: 'Q4 procurement plan',
  updatedAt: new Date('2026-10-02T10:00:00Z'),
  isShared: true,
  invites: [],
  ...over,
});

describe('selectDocumentsAndMinutes', () => {
  // Review Focus #2 — the leak that matters.
  it('scopes documents and minutes to the institution', async () => {
    const prisma = makePrisma();
    await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(prisma.document.findMany.mock.calls[0][0].where.user)
      .toEqual({ institutionId: 'risa' });
    expect(prisma.meetingMinutes.findMany.mock.calls[0][0].where.document)
      .toEqual({ user: { institutionId: 'risa' } });
  });

  it('filters by the past window, not the ahead window', async () => {
    const prisma = makePrisma();
    await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(prisma.document.findMany.mock.calls[0][0].where.updatedAt)
      .toEqual({ gte: range.pastFrom, lte: range.pastTo });
    expect(prisma.meetingMinutes.findMany.mock.calls[0][0].where.createdAt)
      .toEqual({ gte: range.pastFrom, lte: range.pastTo });
  });

  it('includes a link-shared document', async () => {
    const prisma = makePrisma([doc()]);
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded).toContainEqual({
      kind: 'document',
      id: 'd1',
      title: 'Q4 procurement plan',
      at: '2026-10-02T10:00:00.000Z',
      participantCount: 0,
      href: '/docs?open=d1',
    });
  });

  it('counts invitees as participants', async () => {
    const prisma = makePrisma([doc({ isShared: false, invites: [{ id: 'i1' }, { id: 'i2' }] })]);
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded[0].participantCount).toBe(2);
  });

  it('asks only for documents that are shared or invited', async () => {
    const prisma = makePrisma();
    await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(prisma.document.findMany.mock.calls[0][0].where.OR).toEqual([
      { isShared: true },
      { invites: { some: {} } },
    ]);
  });

  it('includes minutes, titled from their document', async () => {
    const prisma = makePrisma([], [{
      id: 'm1',
      createdAt: new Date('2026-10-03T08:00:00Z'),
      documentId: 'doc-9',
      document: { title: 'Minutes — 2G/3G sunset' },
    }]);
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded).toContainEqual({
      kind: 'minutes',
      id: 'm1',
      title: 'Minutes — 2G/3G sunset',
      at: '2026-10-03T08:00:00.000Z',
      participantCount: 0,
      href: '/docs?open=doc-9',
    });
  });

  it('returns newest first across both kinds', async () => {
    const prisma = makePrisma(
      [doc({ id: 'older', updatedAt: new Date('2026-10-01T00:00:00Z') })],
      [{ id: 'newer', createdAt: new Date('2026-10-04T00:00:00Z'), documentId: 'x', document: { title: 'M' } }],
    );
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded.map((i) => i.id)).toEqual(['newer', 'older']);
  });
});
