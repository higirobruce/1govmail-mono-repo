import { Injectable } from '@nestjs/common';
import { buildAskPrompt, clampText, detectLanguage, NO_SOURCES_REPLY, type ChatSource, type ChatTurn, type SourceType } from '@email-client/shared';
import { ChatRequestDto } from '../ai/dto/chat.dto';
import { PrismaService } from '../prisma/prisma.service';
import { DocsService } from '../docs/docs.service';
import { RetrievalService, type AskScope } from './retrieval.service';

export interface PublicAskSource {
  alias: string;
  type: SourceType;
  id: string;
  title: string | null;
  fromEmail?: string; // mail only
  fromName?: string | null; // mail only
  date: string; // ISO
  meta?: string | null; // event when/where line, doc emoji
  injectionSuspected: boolean;
  snippet: string; // first 160 chars of context — the sources rail preview; full context never ships
}

export interface PreparedAsk {
  sources: PublicAskSource[];
  degraded: { vector: boolean; keyword: boolean; docs: boolean; calendar: boolean };
  upstreamBody: ChatRequestDto | null; // null => answer with noSourcesReply, no model call
  noSourcesReply: string | null;
}

@Injectable()
export class AskService {
  readonly chatModel = process.env.CHAT_MODEL ?? 'qwen3-30b-16k:latest';

  constructor(
    private readonly retrieval: RetrievalService,
    private readonly prisma: PrismaService,
    private readonly docsService: DocsService,
  ) {}

  async prepare(userId: string, turns: ChatTurn[], scope?: AskScope): Promise<PreparedAsk> {
    if (scope?.docId) {
      // ACCESS CONTRACT (see RetrievalService.retrieve's JSDoc): retrieve()
      // does NOT authorize scope.docId, it only narrows SQL. This check MUST
      // run BEFORE retrieval, and the controller calls prepare() before
      // flushing SSE headers, so a ForbiddenException/NotFoundException here
      // surfaces as a normal pre-stream 403/404 JSON response.
      await this.docsService.verifyReadAccess(userId, scope.docId);
    }

    const question = turns[turns.length - 1].content;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const { sources: retrieved, degraded } = await this.retrieval.retrieve(userId, user?.email ?? '', question, scope);

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

    const internal: ChatSource[] = retrieved.map((s, i) => ({
      alias: `s${i + 1}`,
      type: s.type,
      id: s.id,
      title: s.title,
      fromEmail: s.fromEmail,
      fromName: s.fromName,
      date: s.date.toISOString(),
      meta: s.meta,
      context: s.context,
      injectionSuspected: s.injectionSuspected,
    }));

    const system = buildAskPrompt(internal, turns);
    // buildAskPrompt returns the system string only — turn clamping used to
    // live inside the now-deleted `buildInboxChatPrompt` alias; reintroduced
    // here verbatim (same limits, same '\n\n[…truncated]' 14-char accounting).
    const clampedTurns: ChatTurn[] = turns.map((t, i) => ({
      role: t.role,
      content: clampText(t.content, i === turns.length - 1 ? 2000 - 14 : 1000 - 14),
    }));

    return {
      sources: internal.map((s) => ({
        alias: s.alias,
        type: s.type,
        id: s.id,
        title: s.title,
        fromEmail: s.fromEmail,
        fromName: s.fromName,
        date: typeof s.date === 'string' ? s.date : s.date.toISOString(),
        meta: s.meta,
        injectionSuspected: s.injectionSuspected,
        snippet: s.context.slice(0, 160),
      })),
      degraded,
      upstreamBody: {
        model: this.chatModel,
        messages: [{ role: 'system' as const, content: system }, ...clampedTurns],
        stream: true,
        temperature: 0.2,
        max_tokens: 1024,
      } as ChatRequestDto,
      noSourcesReply: null,
    };
  }
}
