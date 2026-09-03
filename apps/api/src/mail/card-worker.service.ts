import { createHash } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { formatAttachments, neutralizeMarkers, type CardSource, type ExtractedCard } from '@email-client/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';
import { CardExtractorService } from './card-extractor.service';

const CARD_BACKFILL_DAYS = 14;
const CARD_RETENTION_DAYS = 90;
const CARD_BATCH_PER_TICK = 8;
const CARD_PER_USER_PER_TICK = 3;
const DAY_MS = 86_400_000;
export const COMMITMENT_IDLE_ARCHIVE_DAYS = 30;

/** sha256 hex of normalized (lowercased, whitespace-collapsed) text — dedupe key. */
export function commitmentTextHash(text: string): string {
  return createHash('sha256').update(text.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
}

/** Rows to project from one card: [] for tombstones/received-without-waitingOn etc. */
export function commitmentRowsFromCard(card: ExtractedCard): Array<{
  type: 'promised' | 'waiting';
  text: string;
  dueHint: string | null;
  textHash: string;
}> {
  const dueHint = card.deadlines.length > 0 ? neutralizeMarkers(card.deadlines[0]) : null;
  const mk = (type: 'promised' | 'waiting', raw: string) => {
    // Redundant with parseCardJson's own laundering — intentional defense-in-depth
    // for fence shapes reaching stored commitment text. Do not simplify away.
    const text = neutralizeMarkers(raw).trim();
    return { type, text, dueHint, textHash: commitmentTextHash(text) };
  };
  if (card.direction === 'sent') return card.commitmentsIMade.filter(Boolean).map((t) => mk('promised', t));
  return card.waitingOn ? [mk('waiting', card.waitingOn)] : [];
}

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
    const list = byUser.get(c.userId) ?? [];
    if (list.length < perUser) list.push(c);
    byUser.set(c.userId, list);
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
    extractedAt: new Date(),
  };
}

@Injectable()
export class CardWorkerService {
  private readonly logger = new Logger(CardWorkerService.name);

  /** Purge (a full-table scan by receivedAt) only needs to run hourly, not every tick. */
  private lastPurgeAt = 0;
  protected purgeIntervalMs = 3_600_000;

  /**
   * Consecutive per-message hydration/extraction failure counts, in-memory only.
   * A worker restart resets these to zero — acceptable: it just means a message
   * that was close to being tombstoned gets a few more retries after a restart,
   * which is harmless and far simpler than persisting failure counts.
   */
  private hydrationFailures = new Map<string, number>();
  private readonly HYDRATION_FAILURE_LIMIT = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly extractor: CardExtractorService,
    @Optional() purgeIntervalMs?: number,
  ) {
    if (purgeIntervalMs !== undefined) this.purgeIntervalMs = purgeIntervalMs;
  }

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
          attachments: formatAttachments((full as Record<string, unknown> | null)?.attachments ?? m.attachments),
        };
        const card = await this.extractor.extract(source, full?.bodyText ?? null, full?.bodyHtml ?? null);

        await this.prisma.messageCard.upsert({
          where: { messageId: m.id },
          create: cardRow(m, card, this.extractor.model),
          update: cardRow(m, card, this.extractor.model),
        });

        this.hydrationFailures.delete(m.id);
        if (card) {
          classified++;

          // Ledger projection: promises made / things awaited, deduped by content hash.
          for (const row of commitmentRowsFromCard(card)) {
            await this.prisma.commitment.upsert({
              where: { userId_type_textHash: { userId: m.userId, type: row.type, textHash: row.textHash } },
              create: {
                userId: m.userId,
                conversationId: m.conversationId,
                messageId: m.id,
                type: row.type,
                text: row.text,
                dueHint: row.dueHint,
                textHash: row.textHash,
              },
              update: { lastActivityAt: new Date() }, // never touches status
            });
          }
          // Reply hint: an open commitment in this conversation, older than this message,
          // may have been resolved by it — flag for human review, never auto-close.
          if (m.conversationId) {
            await this.prisma.commitment.updateMany({
              where: {
                userId: m.userId,
                conversationId: m.conversationId,
                status: 'open',
                extractedAt: { lt: m.receivedAt },
                messageId: { not: m.id },
              },
              data: { suggestResolve: true, hintMessageId: m.id, lastActivityAt: new Date() },
            });
          }
        } else {
          failed++;
        }
      } catch (err: any) {
        // Network/backend failure — leave unclassified so it's retried next tick,
        // up to HYDRATION_FAILURE_LIMIT consecutive failures, then tombstone it
        // so it stops being selected forever.
        this.logger.warn(`card skip ${m.id}: ${err?.message}`);
        const attempts = (this.hydrationFailures.get(m.id) ?? 0) + 1;
        if (attempts >= this.HYDRATION_FAILURE_LIMIT) {
          await this.prisma.messageCard.upsert({
            where: { messageId: m.id },
            create: cardRow(m, null, this.extractor.model),
            update: cardRow(m, null, this.extractor.model),
          });
          this.hydrationFailures.delete(m.id);
          failed++;
        } else {
          this.hydrationFailures.set(m.id, attempts);
          skipped++;
        }
      }
    }

    let purged = 0;
    if (Date.now() - this.lastPurgeAt >= this.purgeIntervalMs) {
      const retentionCutoff = new Date(Date.now() - CARD_RETENTION_DAYS * DAY_MS);
      const result = await this.prisma.messageCard.deleteMany({
        where: { message: { receivedAt: { lt: retentionCutoff } } },
      });
      purged = result.count;

      await this.prisma.commitment.updateMany({
        where: { status: 'open', lastActivityAt: { lt: new Date(Date.now() - COMMITMENT_IDLE_ARCHIVE_DAYS * DAY_MS) } },
        data: { status: 'archived' },
      });

      this.lastPurgeAt = Date.now();
    }

    if (classified || failed || purged || skipped) {
      this.logger.log(`cards: +${classified} tombstoned ${failed} purged ${purged} skipped ${skipped}`);
    }

    return { classified, failed, purged };
  }
}
