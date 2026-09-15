import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';

describe('NotificationsService.hasRecentNotification', () => {
  const makeService = (count: number) => {
    const prisma = { notification: { count: jest.fn().mockResolvedValue(count) } } as unknown as PrismaService;
    return { service: new NotificationsService(prisma), prisma: prisma as any };
  };

  it('is true when a notification of that type exists inside the window', async () => {
    const { service } = makeService(1);
    await expect(service.hasRecentNotification('u1', 'NEW_MAIL', 60_000)).resolves.toBe(true);
  });

  it('is false when none exists, and only looks back by the window given', async () => {
    const { service, prisma } = makeService(0);
    await expect(service.hasRecentNotification('u1', 'NEW_MAIL', 60_000)).resolves.toBe(false);

    const where = prisma.notification.count.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.type).toBe('NEW_MAIL');
    expect(where.createdAt.gte.getTime()).toBeGreaterThan(Date.now() - 61_000);
  });
});
