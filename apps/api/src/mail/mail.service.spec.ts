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

  function makeService() {
    const prisma = {
      senderRule: { findMany: jest.fn() },
      folder: { findFirst: jest.fn() },
      message: { update: jest.fn() },
    } as unknown as PrismaService;
    const zimbra = { moveMessage: jest.fn() } as unknown as ZimbraService;
    const notifications = {} as NotificationsService;
    const service = new MailService(prisma, zimbra, notifications);
    return { service: service as any, prisma: prisma as any, zimbra: zimbra as any };
  }

  it('does nothing when the user has no sender rules', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.senderRule.findMany.mockResolvedValue([]);

    await service.enforceSenderRules('u1', user, message);

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('does nothing when an ALLOW rule matches', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.senderRule.findMany.mockResolvedValue([{ type: 'ALLOW', address: 'spam@evil.com' }]);

    await service.enforceSenderRules('u1', user, message);

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('does nothing when the message is already in the Junk folder', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.senderRule.findMany.mockResolvedValue([{ type: 'BLOCK', address: '@evil.com' }]);
    prisma.folder.findFirst.mockResolvedValue({ id: 'inbox-id', path: '/Junk' });

    await service.enforceSenderRules('u1', user, message);

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
  });

  it('moves a blocked sender\'s message to Junk', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.senderRule.findMany.mockResolvedValue([{ type: 'BLOCK', address: '@evil.com' }]);
    prisma.folder.findFirst
      .mockResolvedValueOnce({ id: 'inbox-id', path: '/Inbox' })   // current folder lookup
      .mockResolvedValueOnce({ id: 'junk-id', zimbraId: 'z-junk', path: '/Junk' }); // junk lookup

    await service.enforceSenderRules('u1', user, message);

    expect(zimbra.moveMessage).toHaveBeenCalledWith('mail.example.com', 'tok', 'z1', 'z-junk', 'csrf');
    expect(prisma.message.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { folderId: 'junk-id' } });
  });

  it('does nothing when the account has no Junk folder synced', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.senderRule.findMany.mockResolvedValue([{ type: 'BLOCK', address: '@evil.com' }]);
    prisma.folder.findFirst
      .mockResolvedValueOnce({ id: 'inbox-id', path: '/Inbox' })
      .mockResolvedValueOnce(null);

    await service.enforceSenderRules('u1', user, message);

    expect(zimbra.moveMessage).not.toHaveBeenCalled();
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

  it('does not let a moveMessage failure during enforcement abort getMessages', async () => {
    const { service, prisma, zimbra } = makeService();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    prisma.folder.findFirst
      .mockResolvedValueOnce({ id: 'inbox-id', zimbraId: 'zfolder', userId: 'u1' }) // target folder lookup
      .mockResolvedValueOnce({ id: 'inbox-id', path: '/Inbox' }) // enforceSenderRules: current folder lookup
      .mockResolvedValueOnce({ id: 'junk-id', zimbraId: 'z-junk', path: '/Junk' }); // enforceSenderRules: junk lookup
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

    expect(result.messages).toEqual([upserted]);
    expect(prisma.message.update).not.toHaveBeenCalled();
  });
});
