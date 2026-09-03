import { Injectable, Logger } from '@nestjs/common';
import { extractEmailText, extractKeywords, rrfFuse, detectInjectionAttempt } from '@email-client/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { EmbedderService } from '../mail/embedder.service';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90;
const VECTOR_TOP_K = 20;
const KEYWORD_LIMIT = 10;
const CONTEXT_MAX_CHARS = 1200;
const MAX_UNCACHED_HYDRATIONS = 3;

export interface RetrievedSource {
  messageId: string;
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  receivedAt: Date;
  context: string;
  injectionSuspected: boolean;
}

export interface RetrievalResult {
  sources: RetrievedSource[];
  degraded: { vector: boolean; keyword: boolean };
}

interface FusableHit {
  messageId: string;
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  receivedAt: Date;
  context: string | null; // vector: chunkText; keyword: filled in assembly
  row?: { snippet?: string | null; bodyText?: string | null; bodyHtml?: string | null };
}

function zimbraAfterDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedder: EmbedderService,
    private readonly mailService: MailService,
  ) {}

  async retrieve(userId: string, question: string): Promise<RetrievalResult> {
    const [vectorLeg, keywordLeg] = await Promise.allSettled([
      this.vectorLeg(userId, question),
      this.keywordLeg(userId, question),
    ]);
    const degraded = {
      vector: vectorLeg.status === 'rejected',
      keyword: keywordLeg.status === 'rejected',
    };
    if (degraded.vector) this.logger.warn(`vector leg failed: ${(vectorLeg as PromiseRejectedResult).reason?.message}`);
    if (degraded.keyword) this.logger.warn(`keyword leg failed: ${(keywordLeg as PromiseRejectedResult).reason?.message}`);

    // Vector leg first: on a messageId collision RRF keeps the first-seen
    // payload, and the matching chunkText beats a listing snippet as context.
    const fused = rrfFuse<FusableHit>([
      vectorLeg.status === 'fulfilled' ? vectorLeg.value : [],
      keywordLeg.status === 'fulfilled' ? keywordLeg.value : [],
    ]);

    const sources = await this.assembleContexts(userId, fused);
    return { sources, degraded };
  }

  /** Vector leg alone, in message-list row shape — the ⌘K semantic section. */
  async semantic(userId: string, query: string, limit = 10): Promise<any[]> {
    const rows = await this.vectorRows(userId, query, limit * 2);
    const seen = new Set<string>();
    const out: any[] = [];
    for (const r of rows) {
      if (seen.has(r.messageId) || out.length >= limit) continue;
      seen.add(r.messageId);
      out.push({
        id: r.messageId, subject: r.subject, snippet: r.snippet ?? r.chunkText.slice(0, 160),
        fromEmail: r.fromEmail, fromName: r.fromName, receivedAt: r.receivedAt,
        isRead: r.isRead, hasAttachments: r.hasAttachments, tags: [],
      });
    }
    return out;
  }

  private async vectorRows(userId: string, text: string, limit: number) {
    const [qvec] = await this.embedder.embed([text]);
    const vecText = `[${qvec.join(',')}]`;
    return this.prisma.$queryRaw<Array<{
      messageId: string; chunkText: string; subject: string | null;
      fromEmail: string; fromName: string | null; receivedAt: Date;
      snippet: string | null; isRead: boolean; hasAttachments: boolean; distance: number;
    }>>`
      SELECT e."messageId", e."chunkText",
             m."subject", m."fromEmail", m."fromName", m."receivedAt",
             m."snippet", m."isRead", m."hasAttachments",
             (e."embedding" <=> ${vecText}::vector) AS distance
      FROM "message_embeddings" e
      JOIN "messages" m ON m."id" = e."messageId"
      WHERE e."userId" = ${userId} AND e."failed" = false AND e."embedding" IS NOT NULL
      ORDER BY e."embedding" <=> ${vecText}::vector
      LIMIT ${limit}`;
  }

  private async vectorLeg(userId: string, question: string): Promise<FusableHit[]> {
    const rows = await this.vectorRows(userId, question, VECTOR_TOP_K);
    const seen = new Set<string>();
    const hits: FusableHit[] = [];
    for (const r of rows) {
      if (seen.has(r.messageId)) continue; // rows are distance-ordered: best chunk per message
      seen.add(r.messageId);
      hits.push({
        messageId: r.messageId, subject: r.subject, fromEmail: r.fromEmail,
        fromName: r.fromName, receivedAt: r.receivedAt, context: r.chunkText,
      });
    }
    return hits;
  }

  private async keywordLeg(userId: string, question: string): Promise<FusableHit[]> {
    const keywords = extractKeywords(question);
    if (!keywords) return [];
    const after = zimbraAfterDate(new Date(Date.now() - WINDOW_DAYS * DAY_MS));
    const res = await this.mailService.searchMessages(userId, `${keywords} after:${after}`, KEYWORD_LIMIT, 0);
    return (res.messages ?? []).map((m: any) => ({
      messageId: m.id, subject: m.subject ?? null, fromEmail: m.fromEmail ?? '',
      fromName: m.fromName ?? null, receivedAt: new Date(m.receivedAt),
      context: null,
      row: { snippet: m.snippet, bodyText: m.bodyText, bodyHtml: m.bodyHtml },
    }));
  }

  private async assembleContexts(userId: string, hits: FusableHit[]): Promise<RetrievedSource[]> {
    const cardFlags = new Map<string, boolean>();
    try {
      const cards = await this.prisma.messageCard.findMany({
        where: { messageId: { in: hits.map((h) => h.messageId) }, failed: false },
        select: { messageId: true, injectionSuspected: true },
      });
      for (const c of cards) cardFlags.set(c.messageId, c.injectionSuspected);
    } catch (err: any) {
      this.logger.warn(`card flag lookup failed: ${err?.message}`); // flags degrade to detector-only
    }

    let hydrations = 0;
    const sources: RetrievedSource[] = [];
    for (const h of hits) {
      let context = h.context;
      if (!context) {
        let body = h.row ?? {};
        if (!body.bodyText && !body.bodyHtml && hydrations < MAX_UNCACHED_HYDRATIONS) {
          hydrations++;
          try {
            const full = await this.mailService.getMessage(userId, h.messageId);
            body = { snippet: h.row?.snippet, bodyText: full?.bodyText, bodyHtml: full?.bodyHtml };
          } catch (err: any) {
            this.logger.warn(`context hydration failed for ${h.messageId}: ${err?.message}`);
          }
        }
        context =
          extractEmailText({ bodyText: body.bodyText ?? null, bodyHtml: body.bodyHtml ?? null }, { maxChars: CONTEXT_MAX_CHARS }) ||
          h.row?.snippet || '';
      }
      if (!context) continue; // nothing to show the model — drop the hit
      sources.push({
        messageId: h.messageId, subject: h.subject, fromEmail: h.fromEmail,
        fromName: h.fromName, receivedAt: h.receivedAt,
        context: context.slice(0, CONTEXT_MAX_CHARS),
        injectionSuspected: (cardFlags.get(h.messageId) ?? false) || detectInjectionAttempt(context),
      });
    }
    return sources;
  }
}
