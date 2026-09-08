import { SenderRuleSweepService } from './sender-rule-sweep.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';

// The sweep owns blocked/allowed-sender enforcement: it runs on a schedule
// against messages the read-through cache already synced, so the Inbox GET
// never carries mutating Zimbra calls (previously up to 50 serial moves).
describe('SenderRuleSweepService', () => {
  const validUser = (id: string) => ({
    id,
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: null,
    tokenExpiry: new Date(Date.now() + 60_000),
  });

  function makeSweep() {
    const prisma = {
      senderRule: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findUnique: jest.fn() },
      folder: { findFirst: jest.fn() },
      message: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const mailService = { enforceSenderRules: jest.fn().mockResolvedValue(undefined) } as unknown as MailService;
    const sweep = new SenderRuleSweepService(prisma, mailService);
    return { sweep, prisma: prisma as any, mailService: mailService as any };
  }

  it('does nothing when no sender rules exist anywhere', async () => {
    const { sweep, prisma } = makeSweep();

    await sweep.processTick();

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it('skips users without a live Zimbra session (no token / expired token)', async () => {
    const { sweep, prisma, mailService } = makeSweep();
    prisma.senderRule.findMany.mockResolvedValue([
      { userId: 'u-no-token', type: 'BLOCK', address: '@evil.com' },
      { userId: 'u-expired', type: 'BLOCK', address: '@evil.com' },
    ]);
    prisma.user.findUnique
      .mockResolvedValueOnce({ ...validUser('u-no-token'), authToken: null })
      .mockResolvedValueOnce({ ...validUser('u-expired'), tokenExpiry: new Date(Date.now() - 1) });

    await sweep.processTick();

    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(mailService.enforceSenderRules).not.toHaveBeenCalled();
  });

  it('skips a user whose Inbox folder is not synced yet', async () => {
    const { sweep, prisma, mailService } = makeSweep();
    prisma.senderRule.findMany.mockResolvedValue([{ userId: 'u1', type: 'BLOCK', address: '@evil.com' }]);
    prisma.user.findUnique.mockResolvedValue(validUser('u1'));
    prisma.folder.findFirst.mockResolvedValue(null); // no /Inbox

    await sweep.processTick();

    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(mailService.enforceSenderRules).not.toHaveBeenCalled();
  });

  it('enforces only the BLOCK-matching recent Inbox messages, with the junk folder resolved once', async () => {
    const { sweep, prisma, mailService } = makeSweep();
    const rules = [{ userId: 'u1', type: 'BLOCK', address: '@evil.com' }];
    prisma.senderRule.findMany.mockResolvedValue(rules);
    prisma.user.findUnique.mockResolvedValue(validUser('u1'));
    const inbox = { id: 'f-inbox', path: '/Inbox', zimbraId: '2' };
    const junk = { id: 'f-junk', path: '/Junk', zimbraId: '4' };
    prisma.folder.findFirst
      .mockResolvedValueOnce(inbox)
      .mockResolvedValueOnce(junk);
    prisma.message.findMany.mockResolvedValue([
      { id: 'm1', zimbraId: 'z1', fromEmail: 'spam@evil.com', folderId: 'f-inbox' },
      { id: 'm2', zimbraId: 'z2', fromEmail: 'ok@good.com', folderId: 'f-inbox' },
    ]);

    await sweep.processTick();

    expect(mailService.enforceSenderRules).toHaveBeenCalledTimes(1);
    expect(mailService.enforceSenderRules).toHaveBeenCalledWith(
      'u1',
      { zimbraHost: 'mail.example.com', authToken: 'tok', csrfToken: null },
      { id: 'm1', zimbraId: 'z1', fromEmail: 'spam@evil.com', folderId: 'f-inbox' },
      rules,
      junk,
    );
    // Candidates are scoped to the user's Inbox, newest first, bounded
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', folderId: 'f-inbox' },
        orderBy: { receivedAt: 'desc' },
        take: 100,
      }),
    );
  });

  it('applies each user\'s own rules only', async () => {
    const { sweep, prisma, mailService } = makeSweep();
    const r1 = { userId: 'u1', type: 'BLOCK', address: '@evil.com' };
    const r2 = { userId: 'u2', type: 'BLOCK', address: '@bad.org' };
    prisma.senderRule.findMany.mockResolvedValue([r1, r2]);
    prisma.user.findUnique
      .mockResolvedValueOnce(validUser('u1'))
      .mockResolvedValueOnce(validUser('u2'));
    prisma.folder.findFirst.mockResolvedValue({ id: 'f', path: '/Inbox', zimbraId: '2' });
    // u1 inbox has a message that matches u2's rule but not u1's → no enforcement for u1
    prisma.message.findMany
      .mockResolvedValueOnce([{ id: 'm1', zimbraId: 'z1', fromEmail: 'x@bad.org', folderId: 'f' }])
      .mockResolvedValueOnce([{ id: 'm2', zimbraId: 'z2', fromEmail: 'x@bad.org', folderId: 'f' }]);

    await sweep.processTick();

    expect(mailService.enforceSenderRules).toHaveBeenCalledTimes(1);
    expect(mailService.enforceSenderRules.mock.calls[0][0]).toBe('u2');
    expect(mailService.enforceSenderRules.mock.calls[0][3]).toEqual([r2]);
  });

  it('continues with the next user when one user\'s sweep throws', async () => {
    const { sweep, prisma, mailService } = makeSweep();
    prisma.senderRule.findMany.mockResolvedValue([
      { userId: 'u1', type: 'BLOCK', address: '@evil.com' },
      { userId: 'u2', type: 'BLOCK', address: '@evil.com' },
    ]);
    prisma.user.findUnique
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce(validUser('u2'));
    prisma.folder.findFirst.mockResolvedValue({ id: 'f', path: '/Inbox', zimbraId: '2' });
    prisma.message.findMany.mockResolvedValue([
      { id: 'm1', zimbraId: 'z1', fromEmail: 'spam@evil.com', folderId: 'f' },
    ]);

    await sweep.processTick();

    expect(mailService.enforceSenderRules).toHaveBeenCalledTimes(1);
    expect(mailService.enforceSenderRules.mock.calls[0][0]).toBe('u2');
  });

  it('keeps sweeping a user\'s remaining messages when one enforcement fails', async () => {
    const { sweep, prisma, mailService } = makeSweep();
    prisma.senderRule.findMany.mockResolvedValue([{ userId: 'u1', type: 'BLOCK', address: '@evil.com' }]);
    prisma.user.findUnique.mockResolvedValue(validUser('u1'));
    prisma.folder.findFirst.mockResolvedValue({ id: 'f', path: '/Inbox', zimbraId: '2' });
    prisma.message.findMany.mockResolvedValue([
      { id: 'm1', zimbraId: 'z1', fromEmail: 'a@evil.com', folderId: 'f' },
      { id: 'm2', zimbraId: 'z2', fromEmail: 'b@evil.com', folderId: 'f' },
    ]);
    mailService.enforceSenderRules
      .mockRejectedValueOnce(new Error('zimbra 500'))
      .mockResolvedValueOnce(undefined);

    await sweep.processTick();

    expect(mailService.enforceSenderRules).toHaveBeenCalledTimes(2);
  });
});
