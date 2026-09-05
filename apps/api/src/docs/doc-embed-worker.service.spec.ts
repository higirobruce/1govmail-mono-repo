import { DocEmbedWorkerService } from './doc-embed-worker.service';

const now = Date.now();
const day = 86_400_000;

const validContent = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A body paragraph.' }] }],
});

const emptyContent = JSON.stringify({ type: 'doc', content: [] });

function mkDoc(
  id: string,
  userId: string,
  daysAgo: number,
  opts: { embeddings?: Array<{ sourceUpdatedAt: Date }>; content?: string } = {},
) {
  return {
    id,
    userId,
    title: 'Doc Title',
    updatedAt: new Date(now - daysAgo * day),
    content: opts.content ?? validContent,
    embeddings: opts.embeddings ?? [],
  };
}

function makeFakes() {
  const tx = jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
  const prisma = {
    document: { findMany: jest.fn().mockResolvedValue([]) },
    documentEmbedding: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: tx,
  };
  const vec = Array.from({ length: 1024 }, () => 0.5);
  const embedder = { model: 'bge-m3:latest', dims: 1024, embed: jest.fn(async (texts: string[]) => texts.map(() => vec)) };
  return { prisma, embedder };
}

describe('DocEmbedWorkerService', () => {
  it('selects live-session, non-empty-content candidates newest-first with headroom for fairness', async () => {
    const { prisma, embedder } = makeFakes();
    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    await svc.processTick();

    expect(prisma.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          content: { not: null },
          NOT: { content: '' },
          user: expect.objectContaining({ authToken: { not: null }, tokenExpiry: { gt: expect.any(Date) } }),
        }),
        orderBy: { updatedAt: 'desc' },
        take: 32, // DOC_EMBED_BATCH_PER_TICK(8) * 4 headroom
        select: expect.objectContaining({
          id: true,
          userId: true,
          title: true,
          updatedAt: true,
          content: true,
          embeddings: expect.objectContaining({
            where: { model: 'bge-m3:latest' },
            select: { sourceUpdatedAt: true },
            take: 1,
          }),
        }),
      }),
    );
  });

  it('(a) embeds a fresh doc with no existing rows for the current model: transaction delete+N inserts, sourceUpdatedAt = doc.updatedAt', async () => {
    const { prisma, embedder } = makeFakes();
    const doc = mkDoc('d1', 'userA', 1, { embeddings: [] });
    prisma.document.findMany.mockResolvedValue([doc]);

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    const result = await svc.processTick();

    expect(embedder.embed).toHaveBeenCalledWith([expect.stringContaining('Title: Doc Title')]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.documentEmbedding.deleteMany).toHaveBeenCalledWith({ where: { documentId: 'd1' } });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1); // one chunk, short text
    expect(prisma.$executeRaw.mock.calls[0]).toContain(doc.updatedAt); // sourceUpdatedAt = doc.updatedAt
    expect(result.embedded).toBe(1);
  });

  it('(b) filters out a doc whose current-model row is up to date (updatedAt <= sourceUpdatedAt): no embed call', async () => {
    const { prisma, embedder } = makeFakes();
    const sourceUpdatedAt = new Date(now - 1 * day);
    const doc = mkDoc('d1', 'userA', 5, { embeddings: [{ sourceUpdatedAt }] }); // updatedAt 5 days ago <= sourceUpdatedAt 1 day ago
    prisma.document.findMany.mockResolvedValue([doc]);

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    const result = await svc.processTick();

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(result.embedded).toBe(0);
    expect(result.tombstoned).toBe(0);
  });

  it('(c) re-embeds a stale doc (updatedAt > sourceUpdatedAt)', async () => {
    const { prisma, embedder } = makeFakes();
    const sourceUpdatedAt = new Date(now - 5 * day);
    const doc = mkDoc('d1', 'userA', 1, { embeddings: [{ sourceUpdatedAt }] }); // updatedAt 1 day ago > sourceUpdatedAt 5 days ago
    prisma.document.findMany.mockResolvedValue([doc]);

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    const result = await svc.processTick();

    expect(embedder.embed).toHaveBeenCalled();
    expect(result.embedded).toBe(1);
  });

  it('(d) tombstones a doc with empty/invalid content without calling the embedder', async () => {
    const { prisma, embedder } = makeFakes();
    const doc = mkDoc('d1', 'userA', 1, { content: emptyContent });
    prisma.document.findMany.mockResolvedValue([doc]);

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    const result = await svc.processTick();

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(prisma.documentEmbedding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { documentId_chunkIndex_model: { documentId: 'd1', chunkIndex: 0, model: 'bge-m3:latest' } },
        create: expect.objectContaining({ failed: true, chunkText: '', sourceUpdatedAt: doc.updatedAt }),
      }),
    );
    expect(result.tombstoned).toBe(1);
  });

  it('clears stale other-model rows for the doc before writing the tombstone', async () => {
    const { prisma, embedder } = makeFakes();
    const doc = mkDoc('d1', 'userA', 1, { content: emptyContent });
    prisma.document.findMany.mockResolvedValue([doc]);

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    await svc.processTick();

    expect(prisma.documentEmbedding.deleteMany).toHaveBeenCalledWith({
      where: { documentId: 'd1', model: { not: 'bge-m3:latest' } },
    });
  });

  it('(e) retries an embedder failure up to 3 consecutive ticks, then tombstones', async () => {
    const { prisma, embedder } = makeFakes();
    const doc = mkDoc('d1', 'userA', 1, { embeddings: [] });
    prisma.document.findMany.mockResolvedValue([doc]);
    embedder.embed.mockRejectedValue(new Error('ollama down'));

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    await svc.processTick();
    await svc.processTick();
    expect(prisma.documentEmbedding.upsert).not.toHaveBeenCalled();
    const result = await svc.processTick();

    expect(prisma.documentEmbedding.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ failed: true }) }),
    );
    expect(result.tombstoned).toBe(1);
    expect((svc as any).failures.has('d1')).toBe(false);
  });

  it('(f) applies per-user fairness (2/user) across the batch: user B is represented despite fewer candidates', async () => {
    const { prisma, embedder } = makeFakes();
    const aDocs = Array.from({ length: 5 }, (_, n) => mkDoc(`a${n}`, 'userA', n + 1));
    const bDoc = mkDoc('b0', 'userB', 6);
    prisma.document.findMany.mockResolvedValue([...aDocs, bDoc]);

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    await svc.processTick();

    const embeddedIds = prisma.documentEmbedding.deleteMany.mock.calls
      .map((c: any[]) => c[0]?.where?.documentId)
      .filter(Boolean);
    expect(embeddedIds).toContain('b0');
    // fairness caps userA at PER_USER(2) even though 5 candidates were available
    expect(embeddedIds.filter((id: string) => id.startsWith('a'))).toHaveLength(2);
  });
});
