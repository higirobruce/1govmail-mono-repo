import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getNotifications(userId: string, limit = 50) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async markRead(userId: string, id: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  async deleteNotification(userId: string, id: string) {
    await this.prisma.notification.deleteMany({ where: { id, userId } });
    return { success: true };
  }

  async createNotification(
    userId: string,
    type: string,
    title: string,
    body?: string,
    actionUrl?: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.prisma.notification.create({
      data: { userId, type, title, body, actionUrl, metadata: metadata as any },
    });
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, isRead: false } });
  }

  /**
   * The newest notification of `type` for this user, or null when there is
   * none. Callers use its `metadata` to decide whether what they are about to
   * say has already been said.
   *
   * There is deliberately NO time window. A clock-based guard ("did we notify
   * in the last 60s?") suppresses whatever happens to land inside the window,
   * and a suppressed arrival is lost for good once the producer's baseline has
   * moved on. Dedupe has to be answerable from the row itself — the identity or
   * the level it reported — which is what this returns.
   */
  async getLatestNotification(
    userId: string,
    type: string,
  ): Promise<{ id: string; metadata: unknown; createdAt: Date } | null> {
    return this.prisma.notification.findFirst({
      where: { userId, type },
      orderBy: { createdAt: 'desc' },
      select: { id: true, metadata: true, createdAt: true },
    });
  }
}
