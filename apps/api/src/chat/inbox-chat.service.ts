import { Injectable } from '@nestjs/common';
import { buildInboxChatPrompt, detectLanguage, NO_SOURCES_REPLY, type ChatSource, type ChatTurn } from '@email-client/shared';
import { ChatRequestDto } from '../ai/dto/chat.dto';
import { PrismaService } from '../prisma/prisma.service';
import { RetrievalService } from './retrieval.service';

export interface PublicChatSource {
  alias: string;
  messageId: string;
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  receivedAt: string; // ISO
  injectionSuspected: boolean;
  snippet: string; // first 160 chars of context — the sources rail preview
}

export interface PreparedChat {
  sources: PublicChatSource[];
  degraded: { vector: boolean; keyword: boolean };
  upstreamBody: ChatRequestDto | null; // null => answer with noSourcesReply, no model call
  noSourcesReply: string | null;
}

@Injectable()
export class InboxChatService {
  readonly chatModel = process.env.CHAT_MODEL ?? 'qwen3-30b-16k:latest';

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly prisma: PrismaService,
  ) {}

  async prepare(userId: string, turns: ChatTurn[]): Promise<PreparedChat> {
    const question = turns[turns.length - 1].content;
    // Task 6 widened retrieve() to (userId, userEmail, question, scope?); this
    // mail-only endpoint doesn't carry the caller's email today, so fetch it
    // here. Task 7 replaces this whole service (rename to AskService) with a
    // request-scoped email and drops the per-call lookup.
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const { sources: retrieved, degraded } = await this.retrieval.retrieve(userId, user?.email ?? '', question, { types: ['mail'] });

    if (retrieved.length === 0) {
      // detectLanguage returns null on short/ambiguous text — English fallback.
      const lang = detectLanguage(question) ?? 'English';
      return {
        sources: [],
        degraded,
        upstreamBody: null,
        noSourcesReply: NO_SOURCES_REPLY[lang],
      };
    }

    // Task 6 widened RetrievedSource (messageId/subject/receivedAt ->
    // id/title/date, + type) to match ChatSource; PublicChatSource is this
    // service's own REST-facing shape and is untouched, so map back to it below.
    const internal: ChatSource[] = retrieved.map((s, i) => ({
      alias: `s${i + 1}`,
      type: s.type,
      id: s.id,
      title: s.title,
      fromEmail: s.fromEmail,
      fromName: s.fromName,
      date: s.date.toISOString(),
      context: s.context,
      injectionSuspected: s.injectionSuspected,
    }));

    const { system, turns: clamped } = buildInboxChatPrompt(internal, turns);
    return {
      sources: internal.map((s) => ({
        alias: s.alias,
        messageId: s.id,
        subject: s.title,
        fromEmail: s.fromEmail ?? '',
        fromName: s.fromName ?? null,
        receivedAt: typeof s.date === 'string' ? s.date : s.date.toISOString(),
        injectionSuspected: s.injectionSuspected,
        snippet: s.context.slice(0, 160),
      })),
      degraded,
      upstreamBody: {
        model: this.chatModel,
        messages: [{ role: 'system' as const, content: system }, ...clamped],
        stream: true,
        temperature: 0.2,
        max_tokens: 1024,
      } as ChatRequestDto,
      noSourcesReply: null,
    };
  }
}
