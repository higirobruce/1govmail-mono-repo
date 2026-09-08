import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  buildGenerationPrompt, clampText, detectInjectionAttempt, extractEmailText,
  fenceUntrusted, neutralizeMarkers, type ChatSource,
} from '@email-client/shared';
import { ChatRequestDto } from '../ai/dto/chat.dto';
import { PrismaService } from '../prisma/prisma.service';
import { RetrievalService } from './retrieval.service';
import { type PreparedGeneration } from './dossier.service';

const MAX_ATTENDEES = 6;
const MAIL_PER_ATTENDEE = 5;
const MAIL_TOTAL_CAP = 20;
const MAX_SOURCES = 14;
const PER_SOURCE_MAX_CHARS = 800;

@Injectable()
export class MeetingPrepService {
  private readonly logger = new Logger(MeetingPrepService.name);
  readonly chatModel = process.env.CHAT_MODEL ?? 'qwen3-30b-16k:latest';

  constructor(
    private readonly prisma: PrismaService,
    private readonly retrieval: RetrievalService,
  ) {}

  async prepare(userId: string, eventId: string): Promise<PreparedGeneration> {
    // Ownership FIRST — before any retrieval or mail queries; the controller
    // calls prepare() before flushing SSE headers so this is a clean 404.
    const event = await this.prisma.calendarEvent.findFirst({ where: { id: eventId, userId } });
    if (!event) throw new NotFoundException('event not found');

    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const myEmail = me?.email?.toLowerCase() ?? '';
    const attendees = (Array.isArray(event.attendees) ? (event.attendees as Array<{ email?: string; name?: string }>) : [])
      .map((a) => ({ email: a?.email?.toLowerCase() ?? '', name: a?.name ?? null }))
      .filter((a) => a.email && a.email !== myEmail)
      .slice(0, MAX_ATTENDEES);
    const attendeeEmails = attendees.map((a) => a.email);

    const question = [event.title, event.description ?? ''].join(' ').trim();

    const [mailLeg, commitmentLeg, retrievalLeg, linkedLeg] = await Promise.allSettled([
      attendeeEmails.length ? this.attendeeMailLeg(userId, attendeeEmails) : Promise.resolve([]),
      attendeeEmails.length ? this.commitmentLeg(userId, attendeeEmails) : Promise.resolve([]),
      this.retrieval.retrieve(userId, me?.email ?? '', question, { types: ['mail', 'doc'] }),
      event.linkedMessageId ? this.linkedMessageLeg(userId, event.linkedMessageId) : Promise.resolve(null),
    ]);
    const degraded = {
      mail: mailLeg.status === 'rejected',
      commitments: commitmentLeg.status === 'rejected',
      retrieval: retrievalLeg.status === 'rejected',
      linked: linkedLeg.status === 'rejected',
    };
    for (const [name, leg] of Object.entries({ mail: mailLeg, commitments: commitmentLeg, retrieval: retrievalLeg, linked: linkedLeg })) {
      if (leg.status === 'rejected') this.logger.warn(`prep ${name} leg failed: ${(leg as PromiseRejectedResult).reason?.message}`);
    }

    // Assemble: event first (deterministic), then linked mail, attendee mail,
    // then retrieval hits — first occurrence of a (type,id) wins.
    const eventSource = this.eventSource(event);
    const pool: Array<Omit<ChatSource, 'alias'> & { dateObj: Date }> = [eventSource];
    if (linkedLeg.status === 'fulfilled' && linkedLeg.value) pool.push(linkedLeg.value);
    if (mailLeg.status === 'fulfilled') pool.push(...mailLeg.value);
    if (retrievalLeg.status === 'fulfilled') {
      pool.push(...retrievalLeg.value.sources.map((s) => ({
        type: s.type, id: s.id, title: s.title, fromEmail: s.fromEmail, fromName: s.fromName,
        date: s.date.toISOString(), meta: s.meta ?? null,
        context: s.context.slice(0, PER_SOURCE_MAX_CHARS),
        injectionSuspected: s.injectionSuspected, dateObj: s.date,
      })));
    }
    const seen = new Set<string>();
    const deduped = pool.filter((s) => {
      const key = `${s.type}:${s.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_SOURCES);

    const internal: ChatSource[] = deduped.map(({ dateObj, ...s }, i) => ({ ...s, alias: `s${i + 1}` }));

    const newestMail = deduped.filter((s) => s.type === 'mail')
      .reduce<Date | null>((acc, s) => (!acc || s.dateObj > acc ? s.dateObj : acc), null);
    const sourceAnchor = newestMail && newestMail > event.updatedAt ? newestMail : event.updatedAt;

    const commitments = commitmentLeg.status === 'fulfilled' ? commitmentLeg.value : [];
    const extra = commitments.length
      ? fenceUntrusted('TRACKER', commitments
          .map((c) => `- [${c.type}] ${neutralizeMarkers(c.text)}${c.dueHint ? ` (due hint: ${neutralizeMarkers(c.dueHint)})` : ''}`)
          .join('\n'))
      : undefined;

    const subject = `${event.title} — ${event.startAt.toLocaleString()}`;
    const system = buildGenerationPrompt('meeting_prep', subject, internal, extra);

    return {
      kind: 'meeting_prep',
      targetKey: eventId,
      sources: internal.map((s) => ({
        alias: s.alias, type: s.type, id: s.id, title: s.title,
        fromEmail: s.fromEmail, fromName: s.fromName,
        date: typeof s.date === 'string' ? s.date : s.date.toISOString(),
        meta: s.meta, injectionSuspected: s.injectionSuspected,
        snippet: s.context.slice(0, 160),
      })),
      degraded,
      upstreamBody: {
        model: this.chatModel,
        messages: [
          { role: 'system' as const, content: system },
          { role: 'user' as const, content: clampText('Write the meeting prep pack now.', 2000) },
        ],
        stream: true,
        temperature: 0.2,
        max_tokens: 900,
      } as ChatRequestDto,
      fallbackReply: null, // the event source always exists — there is never a zero-source prep
      sourceAnchor,
    };
  }

  private eventSource(event: {
    id: string; title: string; description: string | null; location: string | null;
    organizer: string | null; attendees: unknown; startAt: Date; endAt: Date;
  }): Omit<ChatSource, 'alias'> & { dateObj: Date } {
    const when = `${event.startAt.toLocaleString()} – ${event.endAt.toLocaleString()}`;
    const attendees = Array.isArray(event.attendees)
      ? (event.attendees as Array<{ email?: string; name?: string }>)
          .map((a) => (a?.name ? `${a.name} <${a.email ?? ''}>` : a?.email ?? '')).filter(Boolean).join(', ')
      : '';
    const context = [
      `Event: ${event.title}`, `When: ${when}`, `Where: ${event.location ?? ''}`,
      `Organizer: ${event.organizer ?? ''}`, `Attendees: ${attendees}`,
      `Notes: ${(event.description ?? '').slice(0, 400)}`,
    ].join('\n').slice(0, PER_SOURCE_MAX_CHARS);
    return {
      type: 'event', id: event.id, title: event.title, date: event.startAt.toISOString(),
      meta: when, context, injectionSuspected: detectInjectionAttempt(context), dateObj: event.startAt,
    };
  }

  private async attendeeMailLeg(userId: string, emails: string[]) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; subject: string | null; snippet: string | null;
      bodyText: string | null; bodyHtml: string | null;
      fromEmail: string; fromName: string | null; receivedAt: Date;
      gist: string | null; cardFlag: boolean | null; rn: number;
    }>>`
      SELECT * FROM (
        SELECT m."id", m."subject", m."snippet", m."bodyText", m."bodyHtml",
               m."fromEmail", m."fromName", m."receivedAt",
               c."gist", c."injectionSuspected" AS "cardFlag",
               row_number() OVER (PARTITION BY lower(m."fromEmail") ORDER BY m."receivedAt" DESC) AS rn
        FROM "messages" m
        LEFT JOIN "message_cards" c ON c."messageId" = m."id" AND c."failed" = false
        WHERE m."userId" = ${userId} AND m."isDraft" = false
          AND lower(m."fromEmail") = ANY(${emails}::text[])
      ) ranked
      WHERE ranked.rn <= ${MAIL_PER_ATTENDEE}
      ORDER BY ranked."receivedAt" DESC
      LIMIT ${MAIL_TOTAL_CAP}`;
    return rows.map((r) => {
      const context = (
        r.gist ||
        extractEmailText({ bodyText: r.bodyText, bodyHtml: r.bodyHtml }, { maxChars: PER_SOURCE_MAX_CHARS }) ||
        r.snippet || ''
      ).slice(0, PER_SOURCE_MAX_CHARS);
      return {
        type: 'mail' as const, id: r.id, title: r.subject,
        fromEmail: r.fromEmail, fromName: r.fromName, date: r.receivedAt.toISOString(),
        meta: null, context,
        injectionSuspected: (r.cardFlag ?? false) || detectInjectionAttempt(context),
        dateObj: r.receivedAt,
      };
    }).filter((s) => s.context.length > 0);
  }

  private async commitmentLeg(userId: string, emails: string[]) {
    return this.prisma.$queryRaw<Array<{ type: string; text: string; dueHint: string | null }>>`
      SELECT c."type", c."text", c."dueHint"
      FROM "commitments" c
      JOIN "messages" m ON m."id" = c."messageId"
      WHERE c."userId" = ${userId} AND c."status" = 'open'
        AND (lower(m."fromEmail") = ANY(${emails}::text[])
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ANY(${emails}::text[])))
      ORDER BY c."lastActivityAt" DESC
      LIMIT 10`;
  }

  private async linkedMessageLeg(userId: string, messageId: string) {
    const m = await this.prisma.message.findFirst({
      where: { id: messageId, userId },
      select: { id: true, subject: true, snippet: true, bodyText: true, bodyHtml: true, fromEmail: true, fromName: true, receivedAt: true },
    });
    if (!m) return null;
    const context = (
      extractEmailText({ bodyText: m.bodyText, bodyHtml: m.bodyHtml }, { maxChars: PER_SOURCE_MAX_CHARS }) ||
      m.snippet || ''
    ).slice(0, PER_SOURCE_MAX_CHARS);
    if (!context) return null;
    return {
      type: 'mail' as const, id: m.id, title: m.subject,
      fromEmail: m.fromEmail, fromName: m.fromName, date: m.receivedAt.toISOString(),
      meta: null, context, injectionSuspected: detectInjectionAttempt(context), dateObj: m.receivedAt,
    };
  }
}
