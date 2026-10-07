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
  shareToken: 'tok-d1',
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
      .toMatchObject({ user: { institutionId: 'risa' } });
  });

  it('filters by the past window, not the ahead window', async () => {
    const prisma = makePrisma();
    await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(prisma.document.findMany.mock.calls[0][0].where.updatedAt)
      .toEqual({ gte: range.pastFrom, lte: range.pastTo });
    expect(prisma.meetingMinutes.findMany.mock.calls[0][0].where.createdAt)
      .toEqual({ gte: range.pastFrom, lte: range.pastTo });
  });

  it('includes a link-shared document, linked via its share token', async () => {
    const prisma = makePrisma([doc()]);
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded).toContainEqual({
      kind: 'document',
      id: 'd1',
      title: 'Q4 procurement plan',
      at: '2026-10-02T10:00:00.000Z',
      participantCount: 0,
      href: '/docs/share/tok-d1',
    });
  });

  it('counts invitees as participants', async () => {
    const prisma = makePrisma([doc({ isShared: false, invites: [{ id: 'i1' }, { id: 'i2' }] })]);
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded[0].participantCount).toBe(2);
  });

  // docs?open=:id requires ownership or an invite (docs.service.ts throws
  // ForbiddenException otherwise) — an invite-only document (not isShared)
  // has no publicly-resolvable link, so it must render as plain text.
  it('emits no href for an invite-only document that is not link-shared', async () => {
    const prisma = makePrisma([doc({ isShared: false, shareToken: null, invites: [{ id: 'i1' }] })]);
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded[0].href).toBeUndefined();
  });

  it('asks only for documents the owner has left org-visible', async () => {
    const prisma = makePrisma();
    await selectDocumentsAndMinutes(prisma, 'risa', range);
    const where = prisma.document.findMany.mock.calls[0][0].where;
    expect(where.orgVisible).toBe(true);
    // The old shared-or-invited rule must be gone, not merely supplemented:
    // leaving it in would keep announcing documents the owner opted out of.
    expect(where.OR).toBeUndefined();
    expect(prisma.document.findMany).toHaveBeenCalledTimes(1);
  });

  // The whole point of the toggle. A document can be shared with colleagues
  // and still be withheld from the org page — sharing and announcing are
  // different decisions.
  it('does not ask for documents the owner switched off, even shared ones', async () => {
    const prisma = makePrisma();
    await selectDocumentsAndMinutes(prisma, 'risa', range);
    const where = prisma.document.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ orgVisible: true, user: { institutionId: 'risa' } });
  });

  // Minutes live in a document; if that document is withheld, so are they.
  it('scopes minutes to org-visible documents too', async () => {
    const prisma = makePrisma();
    await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(prisma.meetingMinutes.findMany.mock.calls[0][0].where.document)
      .toEqual({ user: { institutionId: 'risa' }, orgVisible: true });
  });

  it('includes minutes, titled from their document and linked via its share token', async () => {
    const prisma = makePrisma([], [{
      id: 'm1',
      createdAt: new Date('2026-10-03T08:00:00Z'),
      documentId: 'doc-9',
      document: { title: 'Minutes — 2G/3G sunset', isShared: true, shareToken: 'tok-9' },
    }]);
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded).toContainEqual({
      kind: 'minutes',
      id: 'm1',
      title: 'Minutes — 2G/3G sunset',
      at: '2026-10-03T08:00:00.000Z',
      participantCount: 0,
      href: '/docs/share/tok-9',
    });
  });

  it('emits no href for minutes whose document is not link-shared', async () => {
    const prisma = makePrisma([], [{
      id: 'm1',
      createdAt: new Date('2026-10-03T08:00:00Z'),
      documentId: 'doc-9',
      document: { title: 'Minutes — 2G/3G sunset', isShared: false, shareToken: null },
    }]);
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded[0].href).toBeUndefined();
  });

  it('returns newest first across both kinds', async () => {
    const prisma = makePrisma(
      [doc({ id: 'older', updatedAt: new Date('2026-10-01T00:00:00Z') })],
      [{
        id: 'newer', createdAt: new Date('2026-10-04T00:00:00Z'), documentId: 'x',
        document: { title: 'M', isShared: true, shareToken: 'tok-x' },
      }],
    );
    const out = await selectDocumentsAndMinutes(prisma, 'risa', range);
    expect(out.concluded.map((i) => i.id)).toEqual(['newer', 'older']);
  });

  // Live on .155 the digest showed "Minutes — Meet with CTO Roger" twice on the
  // same date. A minutes document IS a Document, so the documents query emits it
  // and the minutes query emits it again.
  it('announces a minutes document once, not once per query', async () => {
    const prisma = makePrisma(
      [doc({ id: 'dm1', title: 'Minutes — Meet with CTO Roger' })],
      [{
        id: 'm1',
        createdAt: new Date('2026-10-02T11:00:00Z'),
        documentId: 'dm1',
        document: { title: 'Minutes — Meet with CTO Roger', isShared: true, shareToken: 'tok-d1' },
      }],
    );

    const { concluded } = await selectDocumentsAndMinutes(prisma, 'risa', range);

    expect(concluded).toHaveLength(1);
    // The minutes row is the one that survives: it carries the meeting meaning,
    // where the document row is incidental to how minutes happen to be stored.
    expect(concluded[0]).toMatchObject({ kind: 'minutes', id: 'm1' });
  });

  it('keeps a minutes document whose minutes row falls outside the window', async () => {
    // Only the document is in range here — the minutes row was never selected.
    // Dropping the document row unconditionally would lose the item entirely.
    const prisma = makePrisma([doc({ id: 'dm2', title: 'Minutes — Older meeting' })], []);

    const { concluded } = await selectDocumentsAndMinutes(prisma, 'risa', range);

    expect(concluded).toHaveLength(1);
    expect(concluded[0]).toMatchObject({ kind: 'document', id: 'dm2' });
  });

  it('leaves ordinary documents alone when minutes are present', async () => {
    const prisma = makePrisma(
      [doc({ id: 'dm3', title: 'Minutes — Standup' }), doc({ id: 'plain', title: 'Q4 procurement plan' })],
      [{
        id: 'm3',
        createdAt: new Date('2026-10-03T09:00:00Z'),
        documentId: 'dm3',
        document: { title: 'Minutes — Standup', isShared: false, shareToken: null },
      }],
    );

    const { concluded } = await selectDocumentsAndMinutes(prisma, 'risa', range);

    expect(concluded.map((i: any) => i.id).sort()).toEqual(['m3', 'plain']);
  });
});