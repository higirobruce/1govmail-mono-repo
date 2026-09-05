import { Injectable, Logger } from '@nestjs/common';
import { extractEmailText, extractKeywords, rrfFuse, detectInjectionAttempt, type SourceType } from '@email-client/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { EmbedderService } from '../mail/embedder.service';

export type { SourceType }; // re-export — callers importing typed sources from this module

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 90; // Zimbra keyword leg lookback
const VECTOR_TOP_K = 20;
const KEYWORD_LIMIT = 10;
const CONTEXT_MAX_CHARS = 1200;
const MAX_UNCACHED_HYDRATIONS = 3;
const CALENDAR_PAST_DAYS = 30;
const CALENDAR_FUTURE_DAYS = 90;
const CALENDAR_LIMIT = 5;

export interface RetrievedSource {
  type: SourceType;
  id: string; // messageId | documentId | calendarEvent id
  title: string | null;
  fromEmail?: string; // mail only
  fromName?: string | null; // mail only
  date: Date; // receivedAt | doc updatedAt | event startAt
  meta?: string | null; // event: "When" line; doc: emoji
  context: string;
  injectionSuspected: boolean;
}

export interface AskScope {
  types?: SourceType[]; // undefined = all
  docId?: string; // narrows the docs leg to one document; caller must verifyReadAccess first
}

export interface RetrievalResult {
  sources: RetrievedSource[];
  degraded: { vector: boolean; keyword: boolean; docs: boolean; calendar: boolean };
}

interface FusableHit {
  key: string; // 'mail:<id>' | 'doc:<id>' | 'event:<id>' — rrfFuse's generic dedupe field (Task 5 rename)
  type: SourceType;
  id: string;
  title: string | null;
  fromEmail?: string;
  fromName?: string | null;
  date: Date;
  meta?: string | null;
  context: string | null; // null only for the mail keyword leg — filled by assembleContexts on hydration
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

  /**
   * Runs up to four legs (mail-vector, mail-keyword, docs-vector, calendar)
   * concurrently via allSettled, fuses them with RRF, and assembles clamped,
   * injection-checked contexts. `scope.types` gates which legs run at all
   * (undefined = all); `scope.docId` forces docs-only and narrows the docs
   * SQL to that one document.
   *
   * ACCESS CONTRACT: this method does NOT authorize `scope.docId` — it only
   * narrows the SQL. The caller MUST call DocsService.verifyReadAccess(userId,
   * docId) before invoking retrieve() with a docId scope (the docs-leg SQL's
   * own owner-OR-invite predicate is defense in depth, not the access check).
   */
  async retrieve(userId: string, userEmail: string, question: string, scope?: AskScope): Promise<RetrievalResult> {
    const types: SourceType[] = scope?.docId ? ['doc'] : (scope?.types ?? ['mail', 'doc', 'event']);
    const wantMail = types.includes('mail');
    const wantDoc = types.includes('doc');
    const wantEvent = types.includes('event');

    const [vectorLeg, keywordLeg, docLeg, calendarLeg] = await Promise.allSettled([
      wantMail ? this.vectorLeg(userId, question) : Promise.resolve<FusableHit[]>([]),
      wantMail ? this.keywordLeg(userId, question) : Promise.resolve<FusableHit[]>([]),
      wantDoc ? this.docVectorLeg(userId, userEmail, question, scope?.docId) : Promise.resolve<FusableHit[]>([]),
      wantEvent ? this.calendarLeg(userId, question) : Promise.resolve<FusableHit[]>([]),
    ]);

    const degraded = {
      vector: vectorLeg.status === 'rejected',
      keyword: keywordLeg.status === 'rejected',
      docs: docLeg.status === 'rejected',
      calendar: calendarLeg.status === 'rejected',
    };
    if (degraded.vector) this.logger.warn(`vector leg failed: ${(vectorLeg as PromiseRejectedResult).reason?.message}`);
    if (degraded.keyword) this.logger.warn(`keyword leg failed: ${(keywordLeg as PromiseRejectedResult).reason?.message}`);
    if (degraded.docs) this.logger.warn(`docs leg failed: ${(docLeg as PromiseRejectedResult).reason?.message}`);
    if (degraded.calendar) this.logger.warn(`calendar leg failed: ${(calendarLeg as PromiseRejectedResult).reason?.message}`);

    // Vector legs first: on a same-type id collision RRF keeps the first-seen
    // payload, and the matching chunkText beats a listing snippet as context.
    const fused = rrfFuse<FusableHit>([
      vectorLeg.status === 'fulfilled' ? vectorLeg.value : [],
      docLeg.status === 'fulfilled' ? docLeg.value : [],
      calendarLeg.status === 'fulfilled' ? calendarLeg.value : [],
      keywordLeg.status === 'fulfilled' ? keywordLeg.value : [],
    ]);

    const sources = await this.assembleContexts(userId, fused);
    return { sources, degraded };
  }

  /** Vector leg alone, in message-list row shape — the ⌘K semantic section. Mail-only, untouched. */
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
      WHERE e."userId" = ${userId} AND e."failed" = false AND e."embedding" IS NOT NULL AND e."model" = ${this.embedder.model}
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
        key: `mail:${r.messageId}`, type: 'mail', id: r.messageId, title: r.subject,
        fromEmail: r.fromEmail, fromName: r.fromName, date: r.receivedAt, context: r.chunkText,
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
      key: `mail:${m.id}`, type: 'mail' as const, id: m.id, title: m.subject ?? null, fromEmail: m.fromEmail ?? '',
      fromName: m.fromName ?? null, date: new Date(m.receivedAt),
      context: null,
      row: { snippet: m.snippet, bodyText: m.bodyText, bodyHtml: m.bodyHtml },
    }));
  }

  /**
   * Docs vector leg SQL (verified against apps/api/prisma/schema.prisma's
   * @@map names: "documents", "document_invites", "document_embeddings").
   * ACL is enforced IN SQL — owner OR an invite row for the caller's email —
   * matching `DocsService.getInviteForUser`'s own (unnormalized) exact-string
   * comparison of `invitedEmail`. This is defense in depth, not the access
   * check itself: see the ACCESS CONTRACT note on `retrieve()`.
   */
  private async docVectorRows(userId: string, userEmail: string, text: string, limit: number, docId?: string) {
    const [qvec] = await this.embedder.embed([text]);
    const vecText = `[${qvec.join(',')}]`;
    type Row = { documentId: string; chunkText: string; title: string; emoji: string | null; updatedAt: Date; distance: number };
    if (docId) {
      return this.prisma.$queryRaw<Row[]>`
        SELECT e."documentId", e."chunkText", d."title", d."emoji", d."updatedAt",
               (e."embedding" <=> ${vecText}::vector) AS distance
        FROM "document_embeddings" e
        JOIN "documents" d ON d."id" = e."documentId"
        WHERE e."failed" = false AND e."embedding" IS NOT NULL AND e."model" = ${this.embedder.model}
          AND (d."userId" = ${userId} OR EXISTS (
                SELECT 1 FROM "document_invites" i
                WHERE i."documentId" = d."id" AND i."invitedEmail" = ${userEmail}))
          AND e."documentId" = ${docId}
        ORDER BY e."embedding" <=> ${vecText}::vector
        LIMIT ${limit}`;
    }
    return this.prisma.$queryRaw<Row[]>`
      SELECT e."documentId", e."chunkText", d."title", d."emoji", d."updatedAt",
             (e."embedding" <=> ${vecText}::vector) AS distance
      FROM "document_embeddings" e
      JOIN "documents" d ON d."id" = e."documentId"
      WHERE e."failed" = false AND e."embedding" IS NOT NULL AND e."model" = ${this.embedder.model}
        AND (d."userId" = ${userId} OR EXISTS (
              SELECT 1 FROM "document_invites" i
              WHERE i."documentId" = d."id" AND i."invitedEmail" = ${userEmail}))
      ORDER BY e."embedding" <=> ${vecText}::vector
      LIMIT ${limit}`;
  }

  private async docVectorLeg(userId: string, userEmail: string, question: string, docId?: string): Promise<FusableHit[]> {
    const rows = await this.docVectorRows(userId, userEmail, question, VECTOR_TOP_K, docId);
    const seen = new Set<string>();
    const hits: FusableHit[] = [];
    for (const r of rows) {
      if (seen.has(r.documentId)) continue; // rows are distance-ordered: best chunk per document
      seen.add(r.documentId);
      hits.push({
        key: `doc:${r.documentId}`, type: 'doc', id: r.documentId, title: r.title,
        date: r.updatedAt, meta: r.emoji ?? null, context: r.chunkText,
      });
    }
    return hits;
  }

  private async calendarLeg(userId: string, question: string): Promise<FusableHit[]> {
    const raw = extractKeywords(question);
    if (!raw) return [];
    const terms = raw.split(/\s+/).map((t) => t.replace(/^"|"$/g, '').toLowerCase()).filter(Boolean);
    if (!terms.length) return [];

    const now = Date.now();
    const events = await this.prisma.calendarEvent.findMany({
      where: {
        userId,
        startAt: {
          gte: new Date(now - CALENDAR_PAST_DAYS * DAY_MS),
          lte: new Date(now + CALENDAR_FUTURE_DAYS * DAY_MS),
        },
      },
    });

    const matches = (events as any[]).filter((e) => {
      const haystack = `${e.title ?? ''} ${e.location ?? ''} ${e.description ?? ''} ${JSON.stringify(e.attendees ?? [])}`.toLowerCase();
      return terms.some((t) => haystack.includes(t));
    });
    matches.sort((a, b) => Math.abs(a.startAt.getTime() - now) - Math.abs(b.startAt.getTime() - now));
    return matches.slice(0, CALENDAR_LIMIT).map((e) => this.eventHit(e));
  }

  private eventHit(e: {
    id: string; title: string; description: string | null; location: string | null;
    organizer: string | null; attendees: unknown; startAt: Date; endAt: Date;
  }): FusableHit {
    const when = `${e.startAt.toLocaleString()} – ${e.endAt.toLocaleString()}`;
    const attendees = Array.isArray(e.attendees)
      ? (e.attendees as Array<{ email?: string; name?: string }>)
          .map((a) => (a?.name ? `${a.name} <${a.email ?? ''}>` : a?.email ?? ''))
          .filter(Boolean)
          .join(', ')
      : '';
    const notes = (e.description ?? '').slice(0, 400);
    const context = [
      `Event: ${e.title}`,
      `When: ${when}`,
      `Where: ${e.location ?? ''}`,
      `Organizer: ${e.organizer ?? ''}`,
      `Attendees: ${attendees}`,
      `Notes: ${notes}`,
    ].join('\n');
    return { key: `event:${e.id}`, type: 'event', id: e.id, title: e.title, date: e.startAt, meta: when, context };
  }

  private async assembleContexts(userId: string, hits: FusableHit[]): Promise<RetrievedSource[]> {
    const mailIds = hits.filter((h) => h.type === 'mail').map((h) => h.id);
    const cardFlags = new Map<string, boolean>();
    if (mailIds.length) {
      try {
        const cards = await this.prisma.messageCard.findMany({
          where: { messageId: { in: mailIds }, failed: false },
          select: { messageId: true, injectionSuspected: true },
        });
        for (const c of cards) cardFlags.set(c.messageId, c.injectionSuspected);
      } catch (err: any) {
        this.logger.warn(`card flag lookup failed: ${err?.message}`); // flags degrade to detector-only
      }
    }

    let hydrations = 0;
    const sources: RetrievedSource[] = [];
    for (const h of hits) {
      let context = h.context;
      if (context === null) {
        // Only the mail keyword leg ever produces a null context — everything
        // else (vector chunks, doc chunks, event summaries) arrives pre-filled.
        let body = h.row ?? {};
        if (!body.bodyText && !body.bodyHtml && hydrations < MAX_UNCACHED_HYDRATIONS) {
          hydrations++;
          try {
            const full = await this.mailService.getMessage(userId, h.id);
            body = { snippet: h.row?.snippet, bodyText: full?.bodyText, bodyHtml: full?.bodyHtml };
          } catch (err: any) {
            this.logger.warn(`context hydration failed for ${h.id}: ${err?.message}`);
          }
        }
        context =
          extractEmailText({ bodyText: body.bodyText ?? null, bodyHtml: body.bodyHtml ?? null }, { maxChars: CONTEXT_MAX_CHARS }) ||
          h.row?.snippet || '';
      }
      if (!context) continue; // nothing to show the model — drop the hit
      sources.push({
        type: h.type, id: h.id, title: h.title,
        fromEmail: h.fromEmail, fromName: h.fromName, date: h.date, meta: h.meta ?? null,
        context: context.slice(0, CONTEXT_MAX_CHARS),
        injectionSuspected: (h.type === 'mail' ? (cardFlags.get(h.id) ?? false) : false) || detectInjectionAttempt(context),
      });
    }
    return sources;
  }
}
