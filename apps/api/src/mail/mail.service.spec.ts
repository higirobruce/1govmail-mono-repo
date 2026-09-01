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
