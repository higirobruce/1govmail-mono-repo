import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The one thing about this service that can be silently wrong.
 *
 * `createNotification` takes an optional trailing transaction client so
 * `MailService.notifyNewMail` can put the insert in the SAME transaction as
 * its claim on the Inbox baseline — without it, a crash between the two
 * leaves the baseline advanced with no row to show for it and the arrival is
 * lost. Whether the argument is honoured is invisible from the caller's side:
 * the row gets created either way, and only the client it was created ON says
 * whether the pair is atomic. So it is asserted here, at the seam, as well as
 * in the MailService tests.
 */
describe('NotificationsService.createNotification', () => {
  const row = { id: 'n1' };

  function makeService() {
    const prisma = {
      notification: {
        create: jest.fn().mockResolvedValue(row),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(3),
      },
    } as unknown as PrismaService;
    // A transaction client is a Prisma client minus the transaction methods —
    // for this service's purposes, a `notification` delegate.
    const tx = { notification: { create: jest.fn().mockResolvedValue(row) } };
    return { service: new NotificationsService(prisma), prisma: prisma as any, tx };
  }

  it('inserts on the shared client when no client is passed', async () => {
    const { service, prisma, tx } = makeService();

    await service.createNotification('u1', 'TASK_DUE', 'Task due');

    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('inserts on the PASSED client, and not on the shared one', async () => {
    const { service, prisma, tx } = makeService();

    await service.createNotification(
      'u1', 'NEW_MAIL', '3 new messages', 'Alice — Budget review', '/mail',
      { baseline: 2, unreadCount: 5, delta: 3 }, tx as any,
    );

    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('writes the same payload whichever client is used, and returns the created row', async () => {
    const { service, tx } = makeService();
    const args = [
      'u1', 'NEW_MAIL', '3 new messages', 'Alice — Budget review', '/mail',
      { baseline: 2, unreadCount: 5, delta: 3 },
    ] as const;

    const created = await service.createNotification(...args, tx as any);

    expect(created).toBe(row);
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        type: 'NEW_MAIL',
        title: '3 new messages',
        body: 'Alice — Budget review',
        actionUrl: '/mail',
        metadata: { baseline: 2, unreadCount: 5, delta: 3 },
      },
    });
  });

  it('lists a user\'s feed newest-first, capped', async () => {
    const { service, prisma } = makeService();

    await service.getNotifications('u1');

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('counts only this user\'s unread rows', async () => {
    const { service, prisma } = makeService();

    await expect(service.getUnreadCount('u1')).resolves.toBe(3);

    expect(prisma.notification.count).toHaveBeenCalledWith({ where: { userId: 'u1', isRead: false } });
  });
});
