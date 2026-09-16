import { Prisma } from '@prisma/client';
import { DocsService } from './docs.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DocsService.createMinutesDocument', () => {
  const INPUT = {
    title: 'Minutes — Cabinet briefing',
    content: '{"type":"doc","content":[]}',
    attendeeEmails: ['Chair@risa.gov.rw', 'a@risa.gov.rw', 'a@risa.gov.rw', '', 'me@risa.gov.rw'],
    icalUid: 'cabinet@zimbra',
    occurrenceStartAt: new Date('2026-09-17T09:00:00Z'),
  };

  function makeService(existingLink: any = null) {
    const tx = {
      document: { create: jest.fn().mockResolvedValue({ id: 'doc-1' }), findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
      documentInvite: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
      meetingMinutes: { create: jest.fn().mockResolvedValue({ id: 'link-1' }) },
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'u1', email: 'me@risa.gov.rw' }) },
      meetingMinutes: { findUnique: jest.fn().mockResolvedValue(existingLink) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    } as unknown as PrismaService;
    return { service: new DocsService(prisma as any, {} as any), prisma: prisma as any, tx };
  }

  it('creates the document, the invites, the share link and the link row', async () => {
    const { service, tx } = makeService();

    const result = await service.createMinutesDocument('u1', INPUT);

    expect(result).toEqual({ documentId: 'doc-1', linked: true });
    expect(tx.document.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        userId: 'u1', title: INPUT.title, content: INPUT.content,
        isShared: true, sharePermission: 'VIEW',
      }) }),
    );
    expect(tx.document.create.mock.calls[0][0].data.shareToken).toBeTruthy();
    expect(tx.meetingMinutes.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        icalUid: 'cabinet@zimbra', occurrenceStartAt: INPUT.occurrenceStartAt,
        documentId: 'doc-1', createdBy: 'u1',
      }) }),
    );
  });

  it('invites each attendee once, lowercased, and never the caller', async () => {
    const { service, tx } = makeService();

    await service.createMinutesDocument('u1', INPUT);

    expect(tx.documentInvite.createMany).toHaveBeenCalledWith({
      data: [
        { documentId: 'doc-1', invitedEmail: 'chair@risa.gov.rw', invitedBy: 'u1', role: 'EDITOR' },
        { documentId: 'doc-1', invitedEmail: 'a@risa.gov.rw', invitedBy: 'u1', role: 'EDITOR' },
      ],
      skipDuplicates: true,
    });
  });

  it('returns the existing document when this occurrence already has minutes', async () => {
    // Idempotent by the unique key, not by check-then-act: two attendees
    // clicking at the same moment must land on the same document.
    const { service, prisma, tx } = makeService({ documentId: 'doc-existing' });

    const result = await service.createMinutesDocument('u1', INPUT);

    expect(result).toEqual({ documentId: 'doc-existing', linked: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.document.create).not.toHaveBeenCalled();
  });

  it('creates an UNLINKED document when the meeting has no UID', async () => {
    const { service, tx } = makeService();

    const result = await service.createMinutesDocument('u1', { ...INPUT, icalUid: null });

    expect(result).toEqual({ documentId: 'doc-1', linked: false });
    expect(tx.meetingMinutes.create).not.toHaveBeenCalled();
    expect(tx.document.create).toHaveBeenCalled();   // the minutes still exist
  });

  it('writes every row on the TRANSACTION client, not the ambient one', async () => {
    // A fake that hands back `prisma` itself would prove only that the writes
    // happened during the transaction window. This asserts they ran ON it.
    const { service, prisma, tx } = makeService();

    await service.createMinutesDocument('u1', INPUT);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.document.create).toHaveBeenCalled();
    expect(tx.documentInvite.createMany).toHaveBeenCalled();
    expect(tx.meetingMinutes.create).toHaveBeenCalled();
  });

  it("resolves to the winner's document when two attendees race on the same occurrence", async () => {
    // Both callers miss the pre-transaction existence check above and both
    // enter the transaction; only one `meetingMinutes.create` can win
    // @@unique([icalUid, occurrenceStartAt]) — the other gets P2002 and its
    // whole transaction rolls back. The loser must still land on the
    // winner's document rather than surfacing a 500.
    const { service, prisma, tx } = makeService();
    tx.meetingMinutes.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`icalUid`,`occurrenceStartAt`)',
        { code: 'P2002', clientVersion: 'test' },
      ),
    );
    prisma.meetingMinutes.findUnique
      .mockResolvedValueOnce(null) // the pre-check: this caller doesn't see it yet
      .mockResolvedValueOnce({ documentId: 'doc-winner' }); // post-P2002 re-fetch: the winner's row

    const result = await service.createMinutesDocument('u1', INPUT);

    expect(result).toEqual({ documentId: 'doc-winner', linked: true });
  });

  it('does not swallow a non-P2002 failure as if it were the race', async () => {
    // A too-wide catch here would let a real failure (bad FK, dead
    // connection, ...) masquerade as a successful race loss.
    const { service, tx } = makeService();
    tx.meetingMinutes.create.mockRejectedValue(new Error('connection reset'));

    await expect(service.createMinutesDocument('u1', INPUT)).rejects.toThrow('connection reset');
  });
});
