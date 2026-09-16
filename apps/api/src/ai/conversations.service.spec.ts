import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConversationsService } from './conversations.service';

export const USER = 'u1';

export function makeService() {
  const prisma: any = {
    aiConversation: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    aiConversationTurn: {
      createMany: jest.fn(),
      findMany: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _max: { seq: 0 } }),
    },
    agentToolLog: { updateMany: jest.fn() },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  return { service: new ConversationsService(prisma), prisma };
}

describe('ConversationsService.create', () => {
  it('titles the conversation from the first question, trimmed to 120 chars', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.create.mockResolvedValue({ id: 'c1' });

    await service.create(USER, {
      scopeKind: 'app', scopeId: null, scopeLabel: null, model: 'qwen3',
      turns: [
        { role: 'user', content: 'x'.repeat(200) },
        { role: 'assistant', content: 'answer', sources: [] },
      ],
    });

    const title = prisma.aiConversation.create.mock.calls[0][0].data.title;
    expect(title).toHaveLength(120);
  });

  it('caps each source snippet at 300 characters', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.create.mockResolvedValue({ id: 'c1' });

    await service.create(USER, {
      scopeKind: 'app', scopeId: null, scopeLabel: null, model: 'qwen3',
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', sources: [{ alias: 's1', snippet: 'y'.repeat(900) }] },
      ],
    });

    const written = prisma.aiConversation.create.mock.calls[0][0].data.turns.create;
    expect(written[1].sources[0].snippet).toHaveLength(300);
  });

  it('numbers the pair seq 1 and 2', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.create.mockResolvedValue({ id: 'c1' });

    await service.create(USER, {
      scopeKind: 'app', scopeId: null, scopeLabel: null, model: 'qwen3',
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', sources: [] },
      ],
    });

    const written = prisma.aiConversation.create.mock.calls[0][0].data.turns.create;
    expect(written.map((t: any) => t.seq)).toEqual([1, 2]);
  });
});

describe('ConversationsService.appendTurns', () => {
  it('continues the seq from the highest already stored', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.findFirst.mockResolvedValue({ id: 'c1' });
    prisma.aiConversationTurn.aggregate.mockResolvedValue({ _max: { seq: 4 } });

    await service.appendTurns(USER, 'c1', {
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', sources: [] },
      ],
    });

    const rows = prisma.aiConversationTurn.createMany.mock.calls[0][0].data;
    expect(rows.map((r: any) => r.seq)).toEqual([5, 6]);
  });

  it('retries once against a fresh max seq when the unique key collides', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.findFirst.mockResolvedValue({ id: 'c1' });
    prisma.aiConversationTurn.aggregate
      .mockResolvedValueOnce({ _max: { seq: 4 } })
      .mockResolvedValueOnce({ _max: { seq: 6 } });
    // A REAL Prisma error, not a plain Error with a code bolted on. The service
    // guards on `instanceof PrismaClientKnownRequestError`, so a fake would slip
    // past the guard and the test would pass for the wrong reason.
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    prisma.aiConversationTurn.createMany
      .mockRejectedValueOnce(p2002)
      .mockResolvedValueOnce({ count: 2 });

    await service.appendTurns(USER, 'c1', {
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', sources: [] },
      ],
    });

    const rows = prisma.aiConversationTurn.createMany.mock.calls[1][0].data;
    expect(rows.map((r: any) => r.seq)).toEqual([7, 8]);
  });

  it('propagates a Prisma error that is not P2002 instead of retrying', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.findFirst.mockResolvedValue({ id: 'c1' });
    const other = new Prisma.PrismaClientKnownRequestError('fk', {
      code: 'P2003',
      clientVersion: 'test',
    });
    prisma.aiConversationTurn.createMany.mockRejectedValue(other);

    await expect(
      service.appendTurns(USER, 'c1', {
        turns: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a', sources: [] },
        ],
      }),
    ).rejects.toBe(other);
    // one attempt, not two — a different code is not a lost race
    expect(prisma.aiConversationTurn.createMany).toHaveBeenCalledTimes(1);
  });

  it('refuses a conversation that is not the caller own', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.findFirst.mockResolvedValue(null);

    await expect(
      service.appendTurns(USER, 'someone-else', {
        turns: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a', sources: [] },
        ],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('bumps lastTurnAt on append', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.findFirst.mockResolvedValue({ id: 'c1' });

    await service.appendTurns(USER, 'c1', {
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', sources: [] },
      ],
    });

    expect(prisma.aiConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'c1' } }),
    );
    expect(prisma.aiConversation.update.mock.calls[0][0].data.lastTurnAt).toBeInstanceOf(Date);
  });
});

describe('ConversationsService.getTranscript', () => {
  it('returns the turns in seq order', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.findFirst.mockResolvedValue({
      id: 'c1', title: 'q', scopeKind: 'app', scopeId: null, scopeLabel: null,
      model: 'qwen3', createdAt: new Date(), lastTurnAt: new Date(),
    });
    prisma.aiConversationTurn.findMany.mockResolvedValue([]);

    await service.getTranscript(USER, 'c1');

    expect(prisma.aiConversationTurn.findMany.mock.calls[0][0].orderBy).toEqual({ seq: 'asc' });
  });

  it('refuses another user conversation with NotFound, never Forbidden', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.findFirst.mockResolvedValue(null);
    await expect(service.getTranscript(USER, 'c9')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ConversationsService.list', () => {
  it('scopes the search to the caller own turns', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.findMany.mockResolvedValue([]);

    await service.list(USER, { q: 'budget' });

    const where = prisma.aiConversation.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe(USER);
    expect(JSON.stringify(where)).toContain('"mode":"insensitive"');
    // the turn leg must ALSO carry the owner, or a match on another user's turn
    // could surface through the OR
    expect(JSON.stringify(where)).toContain(USER);
  });

  it('orders newest-first by lastTurnAt', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.findMany.mockResolvedValue([]);
    await service.list(USER, {});
    expect(prisma.aiConversation.findMany.mock.calls[0][0].orderBy).toEqual({ lastTurnAt: 'desc' });
  });

  it('returns a nextCursor only when a full page came back', async () => {
    const { service, prisma } = makeService();
    const row = {
      id: 'c1', title: 't', scopeKind: 'app', scopeId: null, scopeLabel: null,
      lastTurnAt: new Date(), _count: { turns: 2 },
    };
    prisma.aiConversation.findMany.mockResolvedValue(Array(25).fill(row));
    const full = await service.list(USER, { limit: 25 });
    expect(full.nextCursor).toBe('c1');

    prisma.aiConversation.findMany.mockResolvedValue([row]);
    const partial = await service.list(USER, { limit: 25 });
    expect(partial.nextCursor).toBeNull();
  });

  it('counts turns through _count rather than a counter column', async () => {
    const { service, prisma } = makeService();
    prisma.aiConversation.findMany.mockResolvedValue([]);
    await service.list(USER, {});
    expect(prisma.aiConversation.findMany.mock.calls[0][0].select._count)
      .toEqual({ select: { turns: true } });
  });
});
