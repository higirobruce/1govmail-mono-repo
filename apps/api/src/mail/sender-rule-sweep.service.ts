import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';
import { matchSenderRule, SenderRuleLike } from './sender-rule-matcher';

// Spam-folder paths mirrored from MailService — different Zimbra deployments
// report the spam folder under either path.
const SPAM_FOLDER_PATHS = ['/Junk', '/Spam'];

/** How many of a user's most recent Inbox messages each sweep inspects. The
 *  read-through cache syncs the Inbox on every list, so anything older has
 *  already been through several sweeps. */
const SWEEP_WINDOW = 100;

/**
 * Background enforcement of blocked/allowed-sender rules.
 *
 * This used to run inside the Inbox list GET, where a user with rules paid up
 * to 50 serial Zimbra move calls of latency on every inbox load — and a
 * mutating SOAP call lived in a read path. The sweep runs the same
 * enforcement out-of-band each minute against the messages the read-through
 * cache has already synced: the GET stays pure, and a blocked sender's mail
 * disappears from the Inbox within a minute of being synced.
 */
@Injectable()
export class SenderRuleSweepService {
  private readonly logger = new Logger(SenderRuleSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async tick() {
    try {
      await this.processTick();
    } catch (err: any) {
      this.logger.error(`processTick failed: ${err?.message}`);
    }
  }

  async processTick(): Promise<void> {
    const allRules = await this.prisma.senderRule.findMany();
    if (allRules.length === 0) return;

    const rulesByUser = new Map<string, (SenderRuleLike & { userId: string })[]>();
    for (const rule of allRules as (SenderRuleLike & { userId: string })[]) {
      const list = rulesByUser.get(rule.userId) ?? [];
      list.push(rule);
      rulesByUser.set(rule.userId, list);
    }

    for (const [userId, rules] of rulesByUser) {
      try {
        await this.sweepUser(userId, rules);
      } catch (err: any) {
        // One user's failure (expired session mid-sweep, transient DB error)
        // must not starve the remaining users until the next tick.
        this.logger.error(`sweep failed for userId=${userId}: ${err?.message}`);
      }
    }
  }

  private async sweepUser(userId: string, rules: SenderRuleLike[]): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // No live Zimbra session — the move call would fail anyway. Unlike the
    // interactive path there is no user to re-authenticate here, so just wait
    // for a future tick after they log in again.
    if (!user?.authToken) return;
    if (user.tokenExpiry && user.tokenExpiry <= new Date()) return;

    const inbox = await this.prisma.folder.findFirst({ where: { userId, path: '/Inbox' } });
    if (!inbox) return;

    const junkFolder = await this.prisma.folder.findFirst({
      where: { userId, path: { in: SPAM_FOLDER_PATHS } },
    });

    const candidates = await this.prisma.message.findMany({
      where: { userId, folderId: inbox.id },
      orderBy: { receivedAt: 'desc' },
      take: SWEEP_WINDOW,
      select: { id: true, zimbraId: true, fromEmail: true, folderId: true },
    });

    for (const message of candidates) {
      if (matchSenderRule(message.fromEmail, rules) !== 'BLOCK') continue;
      try {
        await this.mailService.enforceSenderRules(
          userId,
          { zimbraHost: user.zimbraHost, authToken: user.authToken, csrfToken: user.csrfToken },
          message,
          rules,
          junkFolder,
        );
      } catch (err: any) {
        this.logger.error(`enforce failed for message id=${message.id}: ${err?.message}`);
      }
    }
  }
}
