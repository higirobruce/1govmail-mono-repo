import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class TasksScheduler {
  private readonly logger = new Logger(TasksScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly zimbra: ZimbraService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Every minute: find tasks whose reminderAt has passed but haven't had
   * a reminder email sent yet, then email the task owner.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async sendDueReminders() {
    const now = new Date();

    const tasks = await this.prisma.task.findMany({
      where: {
        reminderAt: { lte: now },
        reminderSentAt: null,
        status: { notIn: ['DONE', 'CANCELLED'] },
      },
      include: { user: true },
    });

    for (const task of tasks) {
      const user = task.user;
      if (!user.authToken) continue;

      try {
        const dueDateStr = task.dueDate
          ? new Date(task.dueDate).toLocaleDateString('en-US', {
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })
          : 'No due date';

        const body = `
<html><body style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;">
  <p>Hi${user.displayName ? ` ${user.displayName}` : ''},</p>
  <p>This is a reminder for your upcoming task:</p>
  <table style="border-collapse:collapse;width:100%;margin:16px 0;">
    <tr>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;background:#f9f9f9;font-weight:bold;width:120px;">Task</td>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;">${task.title}</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;background:#f9f9f9;font-weight:bold;">Due</td>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;">${dueDateStr}</td>
    </tr>
    ${task.description
      ? `<tr>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;background:#f9f9f9;font-weight:bold;">Notes</td>
      <td style="padding:8px 12px;border:1px solid #e0e0e0;">${task.description.replace(/\n/g, '<br>')}</td>
    </tr>`
      : ''}
  </table>
  <p style="color:#888;font-size:12px;">Sent from 1Gov Mail.</p>
</body></html>`;

        await this.zimbra.sendMessage(
          user.zimbraHost,
          user.authToken,
          { to: [user.email], subject: `Reminder: ${task.title}`, body },
          user.csrfToken ?? undefined,
        );

        await this.prisma.task.update({
          where: { id: task.id },
          data: { reminderSentAt: new Date() },
        });
        await this.notifications.createNotification(
          task.userId,
          'TASK_DUE',
          `Task reminder: ${task.title}`,
          task.dueDate
            ? `Due ${new Date(task.dueDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
            : undefined,
          '/tasks',
        ).catch(() => {});
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to send reminder for task ${task.id}: ${message}`,
        );
        // Do NOT set reminderSentAt — allows retry on next cron tick
      }
    }
  }
}
