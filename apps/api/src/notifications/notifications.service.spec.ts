import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';

describe('NotificationsService.getLatestNotification', () => {
  const makeService = (row: unknown) => {
    const prisma = {
      notification: { findFirst: jest.fn().mockResolvedValue(row) },
    } as unknown as PrismaService;
    return { service: new NotificationsService(prisma), prisma: prisma as any };
  };

  it('returns the newest row of that type, so a caller can compare it with what it is about to say', async () => {
    const row = { id: 'n1', metadata: { unreadCount: 3 }, createdAt: new Date() };
    const { service, prisma } = makeService(row);

    await expect(service.getLatestNotification('u1', 'NEW_MAIL')).resolves.toBe(row);

    const args = prisma.notification.findFirst.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 'u1', type: 'NEW_MAIL' });
    // Newest first: an older row would answer the wrong question.
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    // No time window: a clock-based lookback is exactly what loses arrivals.
    expect(args.where.createdAt).toBeUndefined();
  });

  it('is null when the user has never had a notification of that type', async () => {
    const { service } = makeService(null);
    await expect(service.getLatestNotification('u1', 'NEW_MAIL')).resolves.toBeNull();
  });
});
