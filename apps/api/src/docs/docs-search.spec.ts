import { DocsService } from './docs.service';

describe('DocsService.searchByTitle', () => {
  it('queries by ILIKE title with owner-or-invite ACL', async () => {
    const prisma = {
      document: {
        findMany: jest.fn().mockResolvedValue([{ id: 'd1', title: 'MoU', emoji: null, updatedAt: new Date() }]),
      },
    } as any;
    // DocsService constructor: match the real parameter list in docs.service.ts
    const svc = Object.create(DocsService.prototype) as DocsService;
    (svc as any).prisma = prisma;

    const rows = await svc.searchByTitle('u1', 'U1@X.RW', 'mou', 5);
    expect(rows).toHaveLength(1);
    const arg = prisma.document.findMany.mock.calls[0][0];
    expect(arg.where.title).toEqual({ contains: 'mou', mode: 'insensitive' });
    expect(JSON.stringify(arg.where.OR)).toContain('u1');
    // Exact-case: mirrors RetrievalService.docVectorRows and
    // verifyReadAccess/getInviteForUser, which compare invitedEmail verbatim.
    // A lowercased/case-insensitive match here would leak a doc's title/id
    // into search results for a user whose invite was stored with different
    // casing than their JWT email, even though those two ACL checks deny it.
    expect(JSON.stringify(arg.where.OR)).toContain('U1@X.RW');
    expect(JSON.stringify(arg.where.OR)).not.toContain('u1@x.rw');
    expect(arg.take).toBe(5);
  });
});
