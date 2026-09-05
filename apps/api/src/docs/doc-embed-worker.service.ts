import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { docJsonToText, chunkDocForEmbedding } from '@email-client/shared';
import { PrismaService } from '../prisma/prisma.service';
import { EmbedderService } from '../mail/embedder.service';
import { pickFairBatch } from '../mail/card-worker.service';

const DOC_EMBED_BATCH_PER_TICK = Number(process.env.DOC_EMBED_BATCH_PER_TICK ?? 8);
const DOC_EMBED_PER_USER_PER_TICK = Number(process.env.DOC_EMBED_PER_USER_PER_TICK ?? 2);

interface DocEmbedCandidateRow {
  id: string;
  userId: string;
  title: string;
  updatedAt: Date;
  content: string | null;
  embeddings: Array<{ sourceUpdatedAt: Date }>;
}

interface DocEmbedCandidate {
  id: string;
  userId: string;
  title: string;
  updatedAt: Date;
  content: string;
}

/**
 * Doc embedding worker — a sibling of EmbedWorkerService (mail) with the same
 * skeleton: minute tick, fair per-user batching, newest-first, 3-strike
 * in-memory failure counter -> tombstone. Unlike the mail worker there is no
 * time-window backfill or purge: a document lives until its owner deletes it,
 * and re-embedding is driven purely by staleness (`updatedAt` vs. the current
 * model's `sourceUpdatedAt`), not by an age cutoff.
 */
@Injectable()
export class DocEmbedWorkerService {
  private readonly logger = new Logger(DocEmbedWorkerService.name);

  /** Consecutive failure counts, in-memory only (resets on restart — same tradeoff as mail/cards). */
  private failures = new Map<string, number>();
  private readonly FAILURE_LIMIT = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedder: EmbedderService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async tick() {
    try {
      await this.processTick();
    } catch (err: any) {
      this.logger.error(`processTick failed: ${err?.message}`);
    }
  }

  async processTick(): Promise<{ embedded: number; tombstoned: number; skipped: number }> {
    // Prisma can't compare two columns (document.updatedAt vs. the embedding
    // row's sourceUpdatedAt) in a `where`, so we select broadly here — newest
    // first, with headroom for fairness trimming — and do the staleness
    // comparison in JS below.
    const rows = (await this.prisma.document.findMany({
      where: {
        content: { not: null },
        NOT: { content: '' },
        user: { authToken: { not: null }, tokenExpiry: { gt: new Date() } },
      },
      orderBy: { updatedAt: 'desc' },
      take: DOC_EMBED_BATCH_PER_TICK * 4,
      select: {
        id: true,
        userId: true,
        title: true,
        updatedAt: true,
        content: true,
        embeddings: { where: { model: this.embedder.model }, select: { sourceUpdatedAt: true }, take: 1 },
      },
    })) as unknown as DocEmbedCandidateRow[];

    const candidates: DocEmbedCandidate[] = rows
      .filter((doc) => {
        const row = doc.embeddings[0];
        return !row || doc.updatedAt > row.sourceUpdatedAt;
      })
      .map((doc) => ({
        id: doc.id,
        userId: doc.userId,
        title: doc.title,
        updatedAt: doc.updatedAt,
        content: doc.content as string,
      }));

    const batch = pickFairBatch(candidates, DOC_EMBED_PER_USER_PER_TICK, DOC_EMBED_BATCH_PER_TICK);

    let embedded = 0;
    let tombstoned = 0;
    let skipped = 0;

    for (const doc of batch) {
      try {
        const text = docJsonToText(doc.content);
        if (!text) {
          // No extractable text — a permanent condition, tombstone without retries.
          await this.tombstone(doc);
          tombstoned++;
          continue;
        }
        const chunks = chunkDocForEmbedding(text, doc.title);
        const vectors = await this.embedder.embed(chunks);
        await this.prisma.$transaction([
          this.prisma.documentEmbedding.deleteMany({ where: { documentId: doc.id } }),
          ...chunks.map((chunk, i) =>
            this.prisma.$executeRaw`
              INSERT INTO "document_embeddings"
                ("id", "documentId", "chunkIndex", "model", "chunkText", "embedding", "failed", "sourceUpdatedAt", "extractedAt")
              VALUES (${randomUUID()}, ${doc.id}, ${i}, ${this.embedder.model}, ${chunk},
                      ${`[${vectors[i].join(',')}]`}::vector, false, ${doc.updatedAt}, ${new Date()})`,
          ),
        ]);
        this.failures.delete(doc.id);
        embedded++;
      } catch (err: any) {
        this.logger.warn(`doc embed skip ${doc.id}: ${err?.message}`);
        const attempts = (this.failures.get(doc.id) ?? 0) + 1;
        if (attempts >= this.FAILURE_LIMIT) {
          await this.tombstone(doc);
          this.failures.delete(doc.id);
          tombstoned++;
        } else {
          this.failures.set(doc.id, attempts);
          skipped++;
        }
      }
    }

    if (embedded || tombstoned || skipped) {
      this.logger.log(`doc embeddings: +${embedded} tombstoned ${tombstoned} skipped ${skipped}`);
    }

    return { embedded, tombstoned, skipped };
  }

  private async tombstone(doc: { id: string; updatedAt: Date }): Promise<void> {
    // A model switch plus a 3-strike failure could otherwise leave stale
    // other-model rows behind for this document — clear them before upserting
    // the current-model tombstone.
    await this.prisma.documentEmbedding.deleteMany({
      where: { documentId: doc.id, model: { not: this.embedder.model } },
    });
    await this.prisma.documentEmbedding.upsert({
      where: { documentId_chunkIndex_model: { documentId: doc.id, chunkIndex: 0, model: this.embedder.model } },
      create: {
        documentId: doc.id,
        chunkIndex: 0,
        model: this.embedder.model,
        chunkText: '',
        failed: true,
        sourceUpdatedAt: doc.updatedAt,
      },
      update: { failed: true, sourceUpdatedAt: doc.updatedAt, extractedAt: new Date() },
    });
  }
}
