import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const TITLE_MAX = 120;
const SNIPPET_MAX = 300;
const PAGE_DEFAULT = 25;

export interface TurnInput {
  role: 'user' | 'assistant';
  content: string;
  sources?: unknown[];
  steps?: unknown[] | null;
  proposals?: unknown[] | null;
}

export interface CreateInput {
  scopeKind: 'app' | 'thread' | 'doc';
  scopeId: string | null;
  scopeLabel: string | null;
  model: string;
  turns: TurnInput[];
  /** Agent turn id, so its tool logs can be linked. Absent on scoped asks. */
  turnId?: string | null;
}

export interface AppendInput {
  turns: TurnInput[];
  turnId?: string | null;
}

export interface ListItemDto {
  id: string;
  title: string;
  scopeKind: string;
  scopeId: string | null;
  scopeLabel: string | null;
  lastTurnAt: Date;
  turnCount: number;
}

export interface TranscriptDto {
  id: string;
  title: string;
  scopeKind: string;
  scopeId: string | null;
  scopeLabel: string | null;
  model: string;
  turns: Array<{
    role: string;
    content: string;
    sources: unknown;
    steps: unknown;
    proposals: unknown;
  }>;
}

/**
 * Saved Ask 1Gov conversations. Separate from AiService, which is the Ollama
 * proxy — this one owns persistence and nothing else.
 *
 * Every method takes the caller's userId and scopes on it. A conversation that
 * is not the caller's raises NotFoundException rather than Forbidden: a 403
 * would confirm the row exists, which is itself a disclosure about someone
 * else's history.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, input: CreateInput): Promise<{ id: string }> {
    const first = input.turns.find((t) => t.role === 'user');
    const title = (first?.content ?? 'Untitled').trim().slice(0, TITLE_MAX);
    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      const conv = await tx.aiConversation.create({
        data: {
          userId,
          title,
          scopeKind: input.scopeKind,
          scopeId: input.scopeId,
          scopeLabel: input.scopeLabel,
          model: input.model,
          lastTurnAt: now,
          turns: { create: this.rows(userId, input.turns, 0) },
        },
        select: { id: true },
      });
      await this.linkToolLogs(tx, userId, input.turnId, conv.id);
      return conv;
    });

    return { id: created.id };
  }

  async appendTurns(userId: string, conversationId: string, input: AppendInput): Promise<void> {
    await this.own(userId, conversationId);

    try {
      await this.writeAppend(userId, conversationId, input);
    } catch (err) {
      // Two tabs appending at once: `seq` is unique per conversation, so the
      // loser collides. Re-read the max and write once more — the second
      // attempt is against whatever the winner left behind.
      const collided =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      if (!collided) throw err;
      await this.writeAppend(userId, conversationId, input);
    }
  }

  private async writeAppend(userId: string, conversationId: string, input: AppendInput): Promise<void> {
    const { _max } = await this.prisma.aiConversationTurn.aggregate({
      where: { conversationId },
      _max: { seq: true },
    });
    const from = _max.seq ?? 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.aiConversationTurn.createMany({
        data: this.rows(userId, input.turns, from).map((r) => ({ ...r, conversationId })),
      });
      await tx.aiConversation.update({
        where: { id: conversationId },
        data: { lastTurnAt: new Date() },
      });
      await this.linkToolLogs(tx, userId, input.turnId, conversationId);
    });
  }

  async getTranscript(userId: string, id: string): Promise<TranscriptDto> {
    const conv = await this.own(userId, id);
    const turns = await this.prisma.aiConversationTurn.findMany({
      where: { conversationId: id },
      orderBy: { seq: 'asc' },
      select: { role: true, content: true, sources: true, steps: true, proposals: true },
    });
    return {
      id: conv.id,
      title: conv.title,
      scopeKind: conv.scopeKind,
      scopeId: conv.scopeId,
      scopeLabel: conv.scopeLabel,
      model: conv.model,
      turns,
    };
  }

  async list(
    userId: string,
    opts: { q?: string; cursor?: string; limit?: number },
  ): Promise<{ items: ListItemDto[]; nextCursor: string | null }> {
    const limit = opts.limit ?? PAGE_DEFAULT;
    const q = opts.q?.trim();

    // Both legs of the OR carry userId. Without it on the turn leg, a match in
    // another user's turn could pull their conversation into this result.
    const where: Prisma.AiConversationWhereInput = {
      userId,
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { turns: { some: { userId, content: { contains: q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.aiConversation.findMany({
      where,
      orderBy: { lastTurnAt: 'desc' },
      take: limit,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true, title: true, scopeKind: true, scopeId: true,
        scopeLabel: true, lastTurnAt: true,
        // A counter column would be one more thing to keep correct on every
        // append and on the P2002 retry, to save a subquery on a page of 25.
        _count: { select: { turns: true } },
      },
    });

    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        scopeKind: r.scopeKind,
        scopeId: r.scopeId,
        scopeLabel: r.scopeLabel,
        lastTurnAt: r.lastTurnAt,
        turnCount: r._count.turns,
      })),
      nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
    };
  }

  /** Throws NotFoundException unless the conversation belongs to the caller. */
  private async own(userId: string, id: string) {
    const conv = await this.prisma.aiConversation.findFirst({ where: { id, userId } });
    if (!conv) throw new NotFoundException('Conversation not found');
    return conv;
  }

  private rows(userId: string, turns: TurnInput[], from: number) {
    return turns.map((t, i) => ({
      userId,
      seq: from + i + 1,
      role: t.role,
      content: t.content,
      sources: this.capSnippets(t.sources ?? []) as any,
      steps: (t.steps ?? null) as any,
      proposals: (t.proposals ?? null) as any,
    }));
  }

  /** A snippet is what makes a chip's hover useful; uncapped it is most of the row. */
  private capSnippets(sources: unknown[]): unknown[] {
    return sources.map((s) => {
      const src = s as { snippet?: unknown };
      if (typeof src?.snippet !== 'string') return s;
      return { ...src, snippet: src.snippet.slice(0, SNIPPET_MAX) };
    });
  }

  /**
   * Point this agent turn's tool logs at the conversation. The logs were written
   * while the answer streamed, before any conversation existed, so the link is
   * back-filled from the turnId the agent minted.
   *
   * `userId` in the filter is load-bearing: turnId arrives from the client, so
   * without the owner check a caller could adopt another user's tool logs.
   * `conversationId: null` stops a replayed request re-pointing linked rows.
   */
  private async linkToolLogs(
    tx: Prisma.TransactionClient,
    userId: string,
    turnId: string | null | undefined,
    conversationId: string,
  ): Promise<void> {
    if (!turnId) return;
    await tx.agentToolLog.updateMany({
      where: { turnId, userId, conversationId: null },
      data: { conversationId },
    });
  }
}
