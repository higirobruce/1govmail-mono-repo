import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MailService } from './mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { NotificationsService } from '../notifications/notifications.service';

function makeService() {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    senderRule: { findMany: jest.fn(), create: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  } as unknown as PrismaService;
  const zimbra = {} as ZimbraService;
  const notifications = {} as NotificationsService;
  const service = new MailService(prisma, zimbra, notifications);
  return { service, prisma: prisma as any };
}

describe('MailService sender rules', () => {
  const user = { id: 'u1', authToken: 'tok', tokenExpiry: new Date(Date.now() + 60_000) };

  it('getSenderRules lists rules for the current user', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.senderRule.findMany.mockResolvedValue([{ id: 'r1', type: 'BLOCK', address: '@evil.com' }]);

    const result = await service.getSenderRules('u1');

    expect(prisma.senderRule.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(result).toEqual([{ id: 'r1', type: 'BLOCK', address: '@evil.com' }]);
  });

  it('getSenderRules rejects when the user has no Zimbra session', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ ...user, authToken: null });

    await expect(service.getSenderRules('u1')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('createSenderRule stores a lowercased, trimmed address', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(user);
    prisma.senderRule.create.mockResolvedValue({ id: 'r1', userId: 'u1', type: 'BLOCK', address: '@evil.com' });

    await service.createSenderRule('u1', { type: 'BLOCK', address: ' @Evil.com ' });

    expect(prisma.senderRule.create).toHaveBeenCalledWith({
      data: { userId: 'u1', type: 'BLOCK', address: '@evil.com' },
    });
  });

  it('deleteSenderRule throws NotFoundException for a rule the user does not own', async () => {
    const { service, prisma } = makeService();
    prisma.senderRule.findFirst.mockResolvedValue(null);

    await expect(service.deleteSenderRule('u1', 'missing-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleteSenderRule removes an owned rule', async () => {
    const { service, prisma } = makeService();
    prisma.senderRule.findFirst.mockResolvedValue({ id: 'r1', userId: 'u1' });
    prisma.senderRule.delete.mockResolvedValue({});

    const result = await service.deleteSenderRule('u1', 'r1');

    expect(prisma.senderRule.delete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(result).toEqual({ success: true });
  });
});

describe('MailService.enforceSenderRules', () => {
  const user = { zimbraHost: 'mail.example.com', authToken: 'tok', csrfToken: 'csrf' };
  const message = { id: 'm1', zimbraId: 'z1', fromEmail: 'spam@evil.com', folderId: 'inbox-id' };

  // `rules` and `junkFolder` are now caller-resolved (hoisted out of the
  // per-message loop in getMessages to kill the N+1 query pattern), so these
  // tests pass them in directly instead of mocking senderRule.findMany /
  // folder.findFirst-for-the-junk-lookup.
  function makeService() {
    const prisma = {
      folder: { findFirst: jest.fn() },
      message: { update: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = { moveMessage: jest.fn() } as unknown as ZimbraService;
    const notifications = {} as NotificationsService;
    const service = new MailService(prisma, zimbra, notifications);
    return { service: service as any, prisma: prisma as any, zimbra: zimbra as any };
  }

  it('does nothing when there are no sender rules', async () => {
    const { service, prisma, zimbra } = makeService();

    await service.enforceSenderRules('u1', user, message, [], { id: 'junk-id', zimbraId: 'z-junk' });

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
    expect(prisma.folder.findFirst).not.toHaveBeenCalled();
  });

  it('does nothing when an ALLOW rule matches', async () => {
    const { service, prisma, zimbra } = makeService();

    await service.enforceSenderRules(
      'u1',
      user,
      message,
      [{ type: 'ALLOW', address: 'spam@evil.com' }],
      { id: 'junk-id', zimbraId: 'z-junk' },
    );

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the message is already in the Junk folder', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.folder.findFirst.mockResolvedValue({ id: 'inbox-id', path: '/Junk' });

    await service.enforceSenderRules(
      'u1',
      user,
      message,
      [{ type: 'BLOCK', address: '@evil.com' }],
      { id: 'junk-id', zimbraId: 'z-junk' },
    );

    expect(prisma.folder.findFirst).toHaveBeenCalledWith({ where: { userId: 'u1', id: 'inbox-id' } });
    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the message is already in the Spam folder (alternate deployment path)', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.folder.findFirst.mockResolvedValue({ id: 'inbox-id', path: '/Spam' });

    await service.enforceSenderRules(
      'u1',
      user,
      message,
      [{ type: 'BLOCK', address: '@evil.com' }],
      { id: 'junk-id', zimbraId: 'z-junk' },
    );

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('moves a blocked sender\'s message to Junk', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.folder.findFirst.mockResolvedValue({ id: 'inbox-id', path: '/Inbox' });

    await service.enforceSenderRules(
      'u1',
      user,
      message,
      [{ type: 'BLOCK', address: '@evil.com' }],
      { id: 'junk-id', zimbraId: 'z-junk' },
    );

    expect(zimbra.moveMessage).toHaveBeenCalledWith('mail.example.com', 'tok', 'z1', 'z-junk', 'csrf');
    expect(prisma.message.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { folderId: 'junk-id' } });
  });

  it('does nothing and logs a warning when the account has no Junk/Spam folder synced', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.folder.findFirst.mockResolvedValue({ id: 'inbox-id', path: '/Inbox' });
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    await service.enforceSenderRules('u1', user, message, [{ type: 'BLOCK', address: '@evil.com' }], null);

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('m1'));
  });
});

describe('MailService.getMessages sender rule enforcement resilience', () => {
  const activeUser = {
    id: 'u1',
    zimbraHost: 'mail.example.com',
    authToken: 'tok',
    csrfToken: 'csrf',
    tokenExpiry: new Date(Date.now() + 60_000),
  };

  function makeService() {
    const prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      folder: { findFirst: jest.fn() },
      message: { upsert: jest.fn(), update: jest.fn() },
      senderRule: { findMany: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = {
      getMessages: jest.fn(),
      moveMessage: jest.fn(),
    } as unknown as ZimbraService;
    const notifications = {} as NotificationsService;
    const service = new MailService(prisma, zimbra, notifications);
    return { service: service as any, prisma: prisma as any, zimbra: zimbra as any };
  }

  // folder.findFirst call order inside getMessages, once enforcement is wired
  // in and gated on the Inbox: (1) the target-folder lookup for the requested
  // folderId, (2) the hoisted Junk/Spam folder lookup (once per request, not
  // per message), (3) enforceSenderRules' own per-message "already filed?"
  // lookup.
  function mockFolderLookups(prisma: any) {
    prisma.folder.findFirst
      .mockResolvedValueOnce({ id: 'inbox-id', zimbraId: 'zfolder', userId: 'u1', path: '/Inbox' }) // target folder lookup
      .mockResolvedValueOnce({ id: 'junk-id', zimbraId: 'z-junk', path: '/Junk' }) // hoisted junk/spam folder lookup
      .mockResolvedValueOnce({ id: 'inbox-id', path: '/Inbox' }); // enforceSenderRules: current folder lookup
  }

  it('proves enforcement actually ran, then does not let a moveMessage failure abort getMessages', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    mockFolderLookups(prisma);
    zimbra.getMessages.mockResolvedValue({
      messages: [{ id: 'z1', e: [{ t: 'f', a: 'spam@evil.com', d: 'Spam' }], f: '', su: 'Subj', fr: 'snippet', d: Date.now() }],
      total: 1,
      more: false,
    });
    const upserted = { id: 'm1', userId: 'u1', folderId: 'inbox-id', zimbraId: 'z1', fromEmail: 'spam@evil.com' };
    prisma.message.upsert.mockResolvedValue(upserted);
    prisma.senderRule.findMany.mockResolvedValue([{ type: 'BLOCK', address: '@evil.com' }]);
    zimbra.moveMessage.mockRejectedValue(new Error('zimbra unavailable'));

    const result = await service.getMessages('u1', 'inbox-id');

    // This is the crux of the fix: previously this test only checked the
    // outcome of a swallowed failure, which would still pass even if the
    // entire enforcement loop were deleted from getMessages. Asserting the
    // call happened (with the args the wiring is supposed to pass through)
    // proves the enforcement path actually ran before it's rejected.
    expect(zimbra.moveMessage).toHaveBeenCalledWith('mail.example.com', 'tok', 'z1', 'z-junk', 'csrf');
    expect(result.messages).toEqual([upserted]);
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it('files a blocked sender\'s message into Junk end-to-end through getMessages', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    mockFolderLookups(prisma);
    zimbra.getMessages.mockResolvedValue({
      messages: [{ id: 'z1', e: [{ t: 'f', a: 'spam@evil.com', d: 'Spam' }], f: '', su: 'Subj', fr: 'snippet', d: Date.now() }],
      total: 1,
      more: false,
    });
    const upserted = { id: 'm1', userId: 'u1', folderId: 'inbox-id', zimbraId: 'z1', fromEmail: 'spam@evil.com' };
    prisma.message.upsert.mockResolvedValue(upserted);
    prisma.senderRule.findMany.mockResolvedValue([{ type: 'BLOCK', address: '@evil.com' }]);
    zimbra.moveMessage.mockResolvedValue(undefined);

    const result = await service.getMessages('u1', 'inbox-id');

    expect(zimbra.moveMessage).toHaveBeenCalledWith('mail.example.com', 'tok', 'z1', 'z-junk', 'csrf');
    expect(prisma.message.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { folderId: 'junk-id' } });
    // getMessages' own return value still reflects the pre-enforcement upsert
    // snapshot — enforcement is a side effect layered on top of the read-through
    // cache, not something the caller has to wait on to get its response shape.
    expect(result.messages).toEqual([upserted]);
  });

  it('does not run enforcement at all when listing a folder other than Inbox', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.folder.findFirst.mockResolvedValueOnce({ id: 'archive-id', zimbraId: 'zarchive', userId: 'u1', path: '/Archive' });
    zimbra.getMessages.mockResolvedValue({
      messages: [{ id: 'z1', e: [{ t: 'f', a: 'spam@evil.com', d: 'Spam' }], f: '', su: 'Subj', fr: 'snippet', d: Date.now() }],
      total: 1,
      more: false,
    });
    const upserted = { id: 'm1', userId: 'u1', folderId: 'archive-id', zimbraId: 'z1', fromEmail: 'spam@evil.com' };
    prisma.message.upsert.mockResolvedValue(upserted);

    const result = await service.getMessages('u1', 'archive-id');

    // Archive is user-organized mail — a blocked-sender rule created today
    // must not retroactively sweep it into Spam the next time it's opened.
    expect(prisma.senderRule.findMany).not.toHaveBeenCalled();
    expect(zimbra.moveMessage).not.toHaveBeenCalled();
    expect(result.messages).toEqual([upserted]);
  });
});
