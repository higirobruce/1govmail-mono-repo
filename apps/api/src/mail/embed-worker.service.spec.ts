import { EmbedWorkerService } from './embed-worker.service';

const now = Date.now();
const day = 86_400_000;

function mkCandidate(id: string, userId: string, daysAgo: number) {
  return { id, userId, subject: 'subject', receivedAt: new Date(now - daysAgo * day) };
}

function makeFakes() {
  const tx = jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
  const prisma = {
    message: { findMany: jest.fn().mockResolvedValue([]) },
    messageEmbedding: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: tx,
  };
  const mailService = { getMessage: jest.fn().mockResolvedValue({ bodyText: 'A body paragraph.', bodyHtml: null }) };
  const vec = Array.from({ length: 1024 }, () => 0.5);
  const embedder = { model: 'bge-m3:latest', dims: 1024, embed: jest.fn(async (texts: string[]) => texts.map(() => vec)) };
  return { prisma, mailService, embedder };
}

describe('EmbedWorkerService', () => {
  it('selects Inbox/Sent messages within 90 days lacking rows for the current model, valid-token users only', async () => {
    const { prisma, mailService, embedder } = makeFakes();
    const svc = new EmbedWorkerService(prisma as any, mailService as any, embedder as any);
    await svc.processTick();

    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          receivedAt: { gte: expect.any(Date) },
          folder: { path: { in: ['/Inbox', '/Sent'] } },
          user: expect.objectContaining({ authToken: { not: null }, tokenExpiry: { gt: expect.any(Date) } }),
          NOT: { embeddings: { some: { model: 'bge-m3:latest' } } },
        }),
        orderBy: { receivedAt: 'desc' },
        take: 64, // EMBED_BATCH_PER_TICK(16) * 4 headroom
      }),
    );
    const cutoff = prisma.message.findMany.mock.calls[0][0].where.receivedAt.gte as Date;
    expect(now - cutoff.getTime()).toBeGreaterThanOrEqual(90 * day - 5000);
    expect(now - cutoff.getTime()).toBeLessThanOrEqual(90 * day + 5000);
  });

  it('applies per-user fairness (4/user) across the 16-message batch', async () => {
    const { prisma, mailService, embedder } = makeFakes();
    const aMsgs = Array.from({ length: 10 }, (_, n) => mkCandidate(`a${n}`, 'userA', n + 1));
    const bMsgs = Array.from({ length: 10 }, (_, n) => mkCandidate(`b${n}`, 'userB', n + 1.5));
    prisma.message.findMany.mockResolvedValue([...aMsgs, ...bMsgs]);

    const svc = new EmbedWorkerService(prisma as any, mailService as any, embedder as any);
    await svc.processTick();

    const ids = mailService.getMessage.mock.calls.map((c: any[]) => c[1]);
    expect(ids.filter((id: string) => id.startsWith('a'))).toHaveLength(4);
    expect(ids.filter((id: string) => id.startsWith('b'))).toHaveLength(4);
  });

  it('embeds the chunks and inserts one row per chunk inside a transaction (delete-then-insert)', async () => {
    const { prisma, mailService, embedder } = makeFakes();
    prisma.message.findMany.mockResolvedValue([mkCandidate('m1', 'userA', 1)]);

    const svc = new EmbedWorkerService(prisma as any, mailService as any, embedder as any);
    const result = await svc.processTick();

    expect(embedder.embed).toHaveBeenCalledWith([expect.stringContaining('Subject: subject')]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.messageEmbedding.deleteMany).toHaveBeenCalledWith({ where: { messageId: 'm1' } });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1); // one chunk
    expect(result.embedded).toBe(1);
  });

  it('tombstones immediately (no retries) when the message has no extractable text', async () => {
    const { prisma, mailService, embedder } = makeFakes();
    prisma.message.findMany.mockResolvedValue([mkCandidate('m1', 'userA', 1)]);
    mailService.getMessage.mockResolvedValue({ bodyText: '', bodyHtml: null });

    const svc = new EmbedWorkerService(prisma as any, mailService as any, embedder as any);
    const result = await svc.processTick();

    expect(prisma.messageEmbedding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId_chunkIndex_model: { messageId: 'm1', chunkIndex: 0, model: 'bge-m3:latest' } },
        create: expect.objectContaining({ failed: true, chunkText: '' }),
      }),
    );
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('clears stale other-model rows for the message before writing the tombstone', async () => {
    const { prisma, mailService, embedder } = makeFakes();
    prisma.message.findMany.mockResolvedValue([mkCandidate('m1', 'userA', 1)]);
    mailService.getMessage.mockResolvedValue({ bodyText: '', bodyHtml: null });

    const svc = new EmbedWorkerService(prisma as any, mailService as any, embedder as any);
    await svc.processTick();

    expect(prisma.messageEmbedding.deleteMany).toHaveBeenCalledWith({
      where: { messageId: 'm1', model: { not: 'bge-m3:latest' } },
    });
  });

  it('retries a network failure up to 3 consecutive ticks, then tombstones', async () => {
    const { prisma, mailService, embedder } = makeFakes();
    prisma.message.findMany.mockResolvedValue([mkCandidate('m1', 'userA', 1)]);
    embedder.embed.mockRejectedValue(new Error('ollama down'));

    const svc = new EmbedWorkerService(prisma as any, mailService as any, embedder as any);
    await svc.processTick();
    await svc.processTick();
    expect(prisma.messageEmbedding.upsert).not.toHaveBeenCalled();
    const result = await svc.processTick();

    expect(prisma.messageEmbedding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ failed: true }) }),
    );
    expect(result.failed).toBe(1);
    expect((svc as any).failures.has('m1')).toBe(false);
  });

  it('purges embeddings past the 90-day window hourly, not every tick', async () => {
    const { prisma, mailService, embedder } = makeFakes();
    prisma.messageEmbedding.deleteMany.mockResolvedValue({ count: 3 });

    const svc = new EmbedWorkerService(prisma as any, mailService as any, embedder as any, 3_600_000);
    const first = await svc.processTick();
    const second = await svc.processTick();

    expect(prisma.messageEmbedding.deleteMany).toHaveBeenCalledWith({
      where: { message: { receivedAt: { lt: expect.any(Date) } } },
    });
    expect(first.purged).toBe(3);
    expect(second.purged).toBe(0);
  });
});
