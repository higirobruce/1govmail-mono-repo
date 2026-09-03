import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { formatAttachments, type CardSource, type ExtractedCard } from '@email-client/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';
import { CardExtractorService } from './card-extractor.service';

const CARD_BACKFILL_DAYS = 14;
const CARD_RETENTION_DAYS = 90;
const CARD_BATCH_PER_TICK = 8;
const CARD_PER_USER_PER_TICK = 3;
const DAY_MS = 86_400_000;

interface CardCandidate {
  id: string;
  userId: string;
  conversationId: string | null;
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  receivedAt: Date;
  attachments: unknown;
  folder: { path: string };
}

/**
 * Round-robin fairness: no single user should starve the tick's batch just
 * because their inbox has more pending messages. Groups candidates by
 * userId (preserving each user's newest-first order), caps each user at
 * `perUser`, then interleaves round-by-round (every user's 1st, then every
 * user's 2nd, ...) until `total` is reached.
 */
export function pickFairBatch<T extends { userId: string }>(
  candidates: T[],
  perUser: number,
  total: number,
): T[] {
  const byUser = new Map<string, T[]>();
  for (const c of candidates) {
    const list = byUser.get(c.userId);
    if (list) {
      if (list.length < perUser) list.push(c);
    } else {
      byUser.set(c.userId, [c]);
    }
  }

  const users = [...byUser.keys()];
  const result: T[] = [];
  for (let round = 0; round < perUser && result.length < total; round++) {
    for (const userId of users) {
      if (result.length >= total) break;
      const list = byUser.get(userId)!;
      if (round < list.length) result.push(list[round]);
    }
  }
  return result;
}

/** Maps an extracted card (or null on tombstone) to MessageCard columns. */
function cardRow(m: CardCandidate, card: ExtractedCard | null, model: string) {
  return {
    messageId: m.id,
    userId: m.userId,
    model,
    gist: card?.gist ?? '',
    asksOfMe: card?.asksOfMe ?? [],
    deadlines: card?.deadlines ?? [],
    commitmentsIMade: card?.commitmentsIMade ?? [],
    waitingOn: card?.waitingOn ?? null,
    importance: card?.importance ?? 'normal',
    injectionSuspected: card?.injectionSuspected ?? false,
    failed: !card,
  };
}

@Injectable()
export class CardWorkerService {
  private readonly logger = new Logger(CardWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly extractor: CardExtractorService,
  ) {}

  /** Every minute: classify pending messages into MessageCards, then purge stale ones. */
  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async tick() {
    try {
      await this.processTick();
    } catch (err: any) {
      this.logger.error(`processTick failed: ${err?.message}`);
    }
  }

  async processTick(): Promise<{ classified: number; failed: number; purged: number }> {
    const backfillCutoff = new Date(Date.now() - CARD_BACKFILL_DAYS * DAY_MS);

    const candidates = (await this.prisma.message.findMany({
      where: {
        receivedAt: { gte: backfillCutoff },
        folder: { path: { in: ['/Inbox', '/Sent'] } },
        user: { authToken: { not: null }, tokenExpiry: { gt: new Date() } },
        OR: [{ card: null }, { card: { model: { not: this.extractor.model } } }],
      },
      orderBy: { receivedAt: 'desc' },
      take: CARD_BATCH_PER_TICK * 4, // headroom so fairness trimming has real users to interleave
      select: {
        id: true,
        userId: true,
        conversationId: true,
        subject: true,
        fromEmail: true,
        fromName: true,
        receivedAt: true,
        attachments: true,
        folder: { select: { path: true } },
      },
    })) as unknown as CardCandidate[];

    const batch = pickFairBatch(candidates, CARD_PER_USER_PER_TICK, CARD_BATCH_PER_TICK);

    let classified = 0;
    let failed = 0;
    let skipped = 0;

    for (const m of batch) {
      try {
        const full = await this.mailService.getMessage(m.userId, m.id);
        const source: CardSource = {
          id: m.id,
          conversationId: m.conversationId,
          direction: m.folder.path === '/Sent' ? 'sent' : 'received',
          fromEmail: m.fromEmail,
          fromName: m.fromName,
          subject: m.subject,
          receivedAt: m.receivedAt.toISOString(),
          attachments: formatAttachments(m.attachments),
        };
        const card = await this.extractor.extract(source, full?.bodyText ?? null, full?.bodyHtml ?? null);

        await this.prisma.messageCard.upsert({
          where: { messageId: m.id },
          create: cardRow(m, card, this.extractor.model),
          update: cardRow(m, card, this.extractor.model),
        });

        if (card) classified++;
        else failed++;
      } catch {
        // Network/backend failure — leave unclassified so it's retried next tick.
        skipped++;
      }
    }

    const retentionCutoff = new Date(Date.now() - CARD_RETENTION_DAYS * DAY_MS);
    const { count: purged } = await this.prisma.messageCard.deleteMany({
      where: { message: { receivedAt: { lt: retentionCutoff } } },
    });

    if (classified || failed || purged || skipped) {
      this.logger.log(`cards: +${classified} tombstoned ${failed} purged ${purged} skipped ${skipped}`);
    }

    return { classified, failed, purged };
  }
}
