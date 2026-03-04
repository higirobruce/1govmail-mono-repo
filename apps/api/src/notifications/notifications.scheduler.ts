import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsScheduler {
  private readonly logger = new Logger(NotificationsScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Every minute: find calendar events starting within the next 30 minutes
   * and create an EVENT_SOON notification if one hasn't been sent yet.
   * Guard: we look for an existing notification with type EVENT_SOON and
   * metadata.eventId matching the event id so we never double-notify.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async notifyUpcomingEvents() {
    const now = new Date();
    const soon = new Date(now.getTime() + 30 * 60 * 1000);

    const events = await this.prisma.calendarEvent.findMany({
      where: {
        startAt: { gt: now, lte: soon },
        allDay: false,
      },
    });

    for (const event of events) {
      try {
        const recentSameType = await this.prisma.notification.findMany({
          where: {
            userId: event.userId,
            type: 'EVENT_SOON',
            createdAt: { gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
          },
          select: { metadata: true },
        });
        const alreadyNotified = recentSameType.some(
          (n) => (n.metadata as Record<string, unknown> | null)?.eventId === event.id,
        );
        if (alreadyNotified) continue;

        const minutesUntil = Math.round((event.startAt.getTime() - now.getTime()) / 60000);
        await this.notifications.createNotification(
          event.userId,
          'EVENT_SOON',
          `Starting soon: ${event.title}`,
          `In ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'}${event.location ? ` · ${event.location}` : ''}`,
          '/calendar',
          { eventId: event.id },
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to create EVENT_SOON notification for event ${event.id}: ${message}`);
      }
    }
  }
}
