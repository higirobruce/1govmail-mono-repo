import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

  /**
   * Insert one notification row.
   *
   * `client` exists so a caller can put this insert in ITS OWN transaction.
   * `MailService.notifyNewMail` needs that: it claims the arrival by advancing
   * the stored Inbox baseline, and a crash between the claim and this insert
   * would leave the baseline moved with no row to show for it — the next sync
   * then sees no delta and the arrival is lost. Passing the transaction client
   * makes the pair atomic. Defaults to the shared client, so every other
   * caller is unaffected.
   */
  async createNotification(
    userId: string,
    type: string,
    title: string,
    body?: string,
    actionUrl?: string,
    metadata?: Record<string, unknown>,
    client: Prisma.TransactionClient = this.prisma,
  ) {
    return client.notification.create({
      data: { userId, type, title, body, actionUrl, metadata: metadata as any },
    });
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, isRead: false } });
  }
}
