import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthScheduler {
  private readonly logger = new Logger(AuthScheduler.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every hour: delete Session rows past their expiresAt.
   *
   * JwtStrategy already rejects expired sessions on every request, so this is
   * pure housekeeping — without it, a user who logs in daily accumulates one
   * dead Session row per login forever, since only a full `/auth/logout`
   * (which wipes every row for that user) ever clears any.
   */
  @Cron(CronExpression.EVERY_HOUR, { waitForCompletion: true })
  async pruneExpiredSessions() {
    try {
      const { count } = await this.prisma.session.deleteMany({
        where: { expiresAt: { lte: new Date() } },
      });
      if (count > 0) {
        this.logger.log(`pruneExpiredSessions: deleted ${count} expired session row(s)`);
      }
    } catch (err: any) {
      this.logger.error(`pruneExpiredSessions failed: ${err?.message}`);
    }
  }
}
