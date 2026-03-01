import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MailService } from './mail.service';

@Injectable()
export class MailScheduler {
  private readonly logger = new Logger(MailScheduler.name);

  constructor(private readonly mailService: MailService) {}

  /** Every minute: resurface snoozed messages whose timer has expired */
  @Cron(CronExpression.EVERY_MINUTE)
  async processSnoozed() {
    try {
      await this.mailService.processExpiredSnoozes();
    } catch (err: any) {
      this.logger.error(`processExpiredSnoozes failed: ${err?.message}`);
    }
  }

  /** Every minute: send any scheduled messages that are due */
  @Cron(CronExpression.EVERY_MINUTE)
  async processScheduled() {
    try {
      await this.mailService.processDueScheduled();
    } catch (err: any) {
      this.logger.error(`processDueScheduled failed: ${err?.message}`);
    }
  }
}
