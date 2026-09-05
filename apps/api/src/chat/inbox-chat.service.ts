import { Injectable } from '@nestjs/common';
import { buildInboxChatPrompt, detectLanguage, NO_SOURCES_REPLY, type ChatSource, type ChatTurn } from '@email-client/shared';
import { ChatRequestDto } from '../ai/dto/chat.dto';
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

  constructor(private readonly retrieval: RetrievalService) {}

  async prepare(userId: string, turns: ChatTurn[]): Promise<PreparedChat> {
    const question = turns[turns.length - 1].content;
    const { sources: retrieved, degraded } = await this.retrieval.retrieve(userId, question);

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
      messageId: s.messageId,
      subject: s.subject,
      fromEmail: s.fromEmail,
      fromName: s.fromName,
      receivedAt: s.receivedAt.toISOString(),
      context: s.context,
      injectionSuspected: s.injectionSuspected,
    }));

    const { system, turns: clamped } = buildInboxChatPrompt(internal, turns);
    return {
      sources: internal.map(({ context, ...pub }) => ({ ...pub, snippet: context.slice(0, 160) })),
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
