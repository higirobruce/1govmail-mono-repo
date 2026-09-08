import { randomUUID } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { chunkForEmbedding } from '@email-client/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';
import { EmbedderService } from './embedder.service';
import { pickFairBatch } from './card-worker.service';

const EMBED_BACKFILL_DAYS = 90; // window == retention: rows past it are purged
const DAY_MS = 86_400_000;
const BATCH_PER_TICK = Number(process.env.EMBED_BATCH_PER_TICK ?? 16);
const PER_USER_PER_TICK = Number(process.env.EMBED_PER_USER_PER_TICK ?? 4);

interface EmbedCandidate {
  id: string;
  userId: string;
  subject: string | null;
  receivedAt: Date;
}

/**
 * Embedding backfill worker — a sibling of CardWorkerService with the same
 * skeleton: minute tick, fair per-user batching, newest-first (recent mail is
 * searchable within minutes of deploy; history backfills behind it),
 * 3-strike in-memory failure counter -> tombstone, hourly purge.
 */
@Injectable()
export class EmbedWorkerService {
  private readonly logger = new Logger(EmbedWorkerService.name);

  private lastPurgeAt = 0;
  protected purgeIntervalMs = 3_600_000;

  /** Consecutive failure counts, in-memory only (resets on restart — same tradeoff as cards). */
  private failures = new Map<string, number>();
  private readonly FAILURE_LIMIT = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly embedder: EmbedderService,
    @Optional() purgeIntervalMs?: number,
  ) {
    if (purgeIntervalMs !== undefined) this.purgeIntervalMs = purgeIntervalMs;
  }

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async tick() {
    try {
      await this.processTick();
    } catch (err: any) {
      this.logger.error(`processTick failed: ${err?.message}`);
    }
  }

  async processTick(): Promise<{ embedded: number; failed: number; purged: number }> {
    const cutoff = new Date(Date.now() - EMBED_BACKFILL_DAYS * DAY_MS);

    const candidates = (await this.prisma.message.findMany({
      where: {
        receivedAt: { gte: cutoff },
        folder: { path: { in: ['/Inbox', '/Sent'] } },
        user: { authToken: { not: null }, tokenExpiry: { gt: new Date() } },
        // Tombstones carry the current model too, so they stop re-selection.
        // Old-model rows don't match => model change re-embeds lazily.
        NOT: { embeddings: { some: { model: this.embedder.model } } },
      },
      orderBy: { receivedAt: 'desc' },
      take: BATCH_PER_TICK * 4, // headroom so fairness trimming has real users to interleave
      select: { id: true, userId: true, subject: true, receivedAt: true },
    })) as unknown as EmbedCandidate[];

    const batch = pickFairBatch(candidates, PER_USER_PER_TICK, BATCH_PER_TICK);

    let embedded = 0;
    let failed = 0;
    let skipped = 0;

    for (const m of batch) {
      try {
        const full = await this.mailService.getMessage(m.userId, m.id);
        const chunks = chunkForEmbedding(
          { bodyText: full?.bodyText ?? null, bodyHtml: full?.bodyHtml ?? null },
          m.subject,
        );
        if (chunks.length === 0) {
          // No text to embed — permanent condition, tombstone without retries.
          await this.tombstone(m);
          failed++;
          continue;
        }
        const vectors = await this.embedder.embed(chunks);
        await this.prisma.$transaction([
          this.prisma.messageEmbedding.deleteMany({ where: { messageId: m.id } }),
          ...chunks.map((chunk, i) =>
            this.prisma.$executeRaw`
              INSERT INTO "message_embeddings"
                ("id", "messageId", "userId", "chunkIndex", "model", "chunkText", "embedding", "failed", "extractedAt")
              VALUES (${randomUUID()}, ${m.id}, ${m.userId}, ${i}, ${this.embedder.model}, ${chunk},
                      ${`[${vectors[i].join(',')}]`}::vector, false, ${new Date()})`,
          ),
        ]);
        this.failures.delete(m.id);
        embedded++;
      } catch (err: any) {
        this.logger.warn(`embed skip ${m.id}: ${err?.message}`);
        const attempts = (this.failures.get(m.id) ?? 0) + 1;
        if (attempts >= this.FAILURE_LIMIT) {
          await this.tombstone(m);
          this.failures.delete(m.id);
          failed++;
        } else {
          this.failures.set(m.id, attempts);
          skipped++;
        }
      }
    }

    let purged = 0;
    if (Date.now() - this.lastPurgeAt >= this.purgeIntervalMs) {
      const result = await this.prisma.messageEmbedding.deleteMany({
        where: { message: { receivedAt: { lt: cutoff } } },
      });
      purged = result.count;
      this.lastPurgeAt = Date.now();
    }

    if (embedded || failed || purged || skipped) {
      this.logger.log(`embeddings: +${embedded} tombstoned ${failed} purged ${purged} skipped ${skipped}`);
    }

    return { embedded, failed, purged };
  }

  private async tombstone(m: EmbedCandidate): Promise<void> {
    // A model switch plus a 3-strike failure could otherwise leave stale
    // other-model rows behind for this message — clear them before upserting
    // the current-model tombstone.
    await this.prisma.messageEmbedding.deleteMany({
      where: { messageId: m.id, model: { not: this.embedder.model } },
    });
    await this.prisma.messageEmbedding.upsert({
      where: { messageId_chunkIndex_model: { messageId: m.id, chunkIndex: 0, model: this.embedder.model } },
      create: { messageId: m.id, userId: m.userId, chunkIndex: 0, model: this.embedder.model, chunkText: '', failed: true },
      update: { failed: true, extractedAt: new Date() },
    });
  }
}
