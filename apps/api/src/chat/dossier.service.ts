import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  buildGenerationPrompt, clampText, detectInjectionAttempt, extractEmailText,
  fenceUntrusted, neutralizeMarkers, type ChatSource,
} from '@email-client/shared';
import { ChatRequestDto } from '../ai/dto/chat.dto';
import { PrismaService } from '../prisma/prisma.service';
import type { PublicAskSource } from './ask.service';
import type { GenerationKind } from './generation-cache.service';

const DAY_MS = 86_400_000;
const MAIL_CONTEXT_LIMIT = 15;
const EVENT_LOOKAHEAD_DAYS = 30;
const PER_SOURCE_MAX_CHARS = 800;

export interface PreparedGeneration {
  kind: GenerationKind;
  targetKey: string;
  sources: PublicAskSource[];
  degraded: Record<string, boolean>;
  upstreamBody: ChatRequestDto | null;
  fallbackReply: string | null;
  sourceAnchor: Date;
}

export const NO_DOSSIER_DATA_REPLY =
  'There is nothing on file with this person yet — no mail, open commitments, or shared events.';

@Injectable()
export class DossierService {
  private readonly logger = new Logger(DossierService.name);
  readonly chatModel = process.env.CHAT_MODEL ?? 'qwen3-30b-16k:latest';

  constructor(private readonly prisma: PrismaService) {}

  async prepare(userId: string, rawEmail: string): Promise<PreparedGeneration> {
    const email = rawEmail.trim().toLowerCase();
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (me?.email?.toLowerCase() === email) {
      throw new BadRequestException('cannot open a dossier on yourself');
    }

    const [mailLeg, commitmentLeg, eventLeg] = await Promise.allSettled([
      this.mailLeg(userId, email),
      this.commitmentLeg(userId, email),
      this.eventLeg(userId, email),
    ]);
    const degraded = {
      mail: mailLeg.status === 'rejected',
      commitments: commitmentLeg.status === 'rejected',
      events: eventLeg.status === 'rejected',
    };
    for (const [name, leg] of Object.entries({ mail: mailLeg, commitments: commitmentLeg, events: eventLeg })) {
      if (leg.status === 'rejected') this.logger.warn(`dossier ${name} leg failed: ${leg.reason?.message}`);
    }

    const mail = mailLeg.status === 'fulfilled' ? mailLeg.value : [];
    const commitments = commitmentLeg.status === 'fulfilled' ? commitmentLeg.value : [];
    const events = eventLeg.status === 'fulfilled' ? eventLeg.value : [];

    // Anchor: newest mail considered; with no mail, anchor=now so ANY future
    // mail from this person marks the cached brief stale.
    const sourceAnchor = mail[0]?.dateObj ?? new Date();

    const internal: ChatSource[] = [...mail, ...events].map((s, i) => ({ ...s.chatSource, alias: `s${i + 1}` }));

    if (internal.length === 0 && commitments.length === 0) {
      return {
        kind: 'dossier', targetKey: email, sources: [], degraded,
        upstreamBody: null, fallbackReply: NO_DOSSIER_DATA_REPLY, sourceAnchor,
      };
    }

    const personLabel = mail.find((m) => m.inbound && m.fromName)?.fromName;
    const subject = personLabel ? `${personLabel} <${email}>` : email;

    // Commitments are OUR tracker's extraction of untrusted mail — fence them
    // as a non-citable TRACKER block rather than minting aliases for them.
    const extra = commitments.length
      ? fenceUntrusted(
          'TRACKER',
          commitments
            .map((c) => `- [${c.type}] ${neutralizeMarkers(c.text)}${c.dueHint ? ` (due hint: ${neutralizeMarkers(c.dueHint)})` : ''}`)
            .join('\n'),
        )
      : undefined;

    const system = buildGenerationPrompt('dossier', subject, internal, extra);

    return {
      kind: 'dossier',
      targetKey: email,
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
          { role: 'user' as const, content: clampText('Write the relationship brief now.', 2000) },
        ],
        stream: true,
        temperature: 0.2,
        max_tokens: 700,
      } as ChatRequestDto,
      fallbackReply: null,
      sourceAnchor,
    };
  }

  private async mailLeg(userId: string, email: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; subject: string | null; snippet: string | null;
      bodyText: string | null; bodyHtml: string | null;
      fromEmail: string; fromName: string | null; receivedAt: Date;
      gist: string | null; cardFlag: boolean | null;
    }>>`
      SELECT m."id", m."subject", m."snippet", m."bodyText", m."bodyHtml",
             m."fromEmail", m."fromName", m."receivedAt",
             c."gist", c."injectionSuspected" AS "cardFlag"
      FROM "messages" m
      LEFT JOIN "message_cards" c ON c."messageId" = m."id" AND c."failed" = false
      WHERE m."userId" = ${userId} AND m."isDraft" = false
        AND (lower(m."fromEmail") = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ${email}))
      ORDER BY m."receivedAt" DESC
      LIMIT ${MAIL_CONTEXT_LIMIT}`;

    return rows.map((r) => {
      const context = (
        r.gist ||
        extractEmailText({ bodyText: r.bodyText, bodyHtml: r.bodyHtml }, { maxChars: PER_SOURCE_MAX_CHARS }) ||
        r.snippet || ''
      ).slice(0, PER_SOURCE_MAX_CHARS);
      const chatSource: Omit<ChatSource, 'alias'> = {
        type: 'mail', id: r.id, title: r.subject,
        fromEmail: r.fromEmail, fromName: r.fromName,
        date: r.receivedAt.toISOString(), meta: null, context,
        injectionSuspected: (r.cardFlag ?? false) || detectInjectionAttempt(context),
      };
      return { chatSource, dateObj: r.receivedAt, inbound: r.fromEmail.toLowerCase() === email, fromName: r.fromName };
    }).filter((m) => m.chatSource.context.length > 0);
  }

  private async commitmentLeg(userId: string, email: string) {
    return this.prisma.$queryRaw<Array<{ type: string; text: string; dueHint: string | null }>>`
      SELECT c."type", c."text", c."dueHint"
      FROM "commitments" c
      JOIN "messages" m ON m."id" = c."messageId"
      WHERE c."userId" = ${userId} AND c."status" = 'open'
        AND (lower(m."fromEmail") = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(m."toRecipients") r
                        WHERE lower(r->>'email') = ${email}))
      ORDER BY c."lastActivityAt" DESC
      LIMIT 10`;
  }

  private async eventLeg(userId: string, email: string) {
    const now = Date.now();
    const rows = await this.prisma.$queryRaw<Array<{
      id: string; title: string; location: string | null; startAt: Date; endAt: Date;
    }>>`
      SELECT e."id", e."title", e."location", e."startAt", e."endAt"
      FROM "calendar_events" e
      WHERE e."userId" = ${userId}
        AND e."startAt" BETWEEN ${new Date(now)} AND ${new Date(now + EVENT_LOOKAHEAD_DAYS * DAY_MS)}
        AND (lower(coalesce(e."organizer", '')) = ${email}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(e."attendees") a
                        WHERE lower(a->>'email') = ${email}))
      ORDER BY e."startAt" ASC
      LIMIT 5`;
    return rows.map((e) => {
      const when = `${e.startAt.toLocaleString()} – ${e.endAt.toLocaleString()}`;
      const context = [`Event: ${e.title}`, `When: ${when}`, `Where: ${e.location ?? ''}`].join('\n');
      const chatSource: Omit<ChatSource, 'alias'> = {
        type: 'event', id: e.id, title: e.title, date: e.startAt.toISOString(),
        meta: when, context, injectionSuspected: detectInjectionAttempt(context),
      };
      return { chatSource, dateObj: e.startAt, inbound: false, fromName: null };
    });
  }
}
