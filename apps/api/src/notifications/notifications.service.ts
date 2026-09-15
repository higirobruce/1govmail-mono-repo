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
   * Whether this user already has a notification of `type` inside the last
   * `withinMs`. Used to keep repeated detection idempotent: several tabs (or
   * devices) sync folders at once and must not each produce a row.
   */
  async hasRecentNotification(userId: string, type: string, withinMs: number): Promise<boolean> {
    const count = await this.prisma.notification.count({
      where: { userId, type, createdAt: { gte: new Date(Date.now() - withinMs) } },
    });
    return count > 0;
  }
}
