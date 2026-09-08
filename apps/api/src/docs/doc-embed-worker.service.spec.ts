import { DocEmbedWorkerService } from './doc-embed-worker.service';

const now = Date.now();
const day = 86_400_000;

const validContent = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A body paragraph.' }] }],
});

const emptyContent = JSON.stringify({ type: 'doc', content: [] });

/** A candidate row as the SQL staleness query returns it — identity only, no content. */
function mkDoc(id: string, userId: string, daysAgo: number) {
  return { id, userId, title: 'Doc Title', updatedAt: new Date(now - daysAgo * day) };
}

function makeFakes() {
  const tx = jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
  const prisma = {
    document: { findMany: jest.fn().mockResolvedValue([]) },
    documentEmbedding: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: tx,
  };
  const vec = Array.from({ length: 1024 }, () => 0.5);
  const embedder = { model: 'bge-m3:latest', dims: 1024, embed: jest.fn(async (texts: string[]) => texts.map(() => vec)) };
  return { prisma, embedder };
}

/** Wire the candidate query + the follow-up content fetch for `docs`. */
function seed(prisma: any, docs: Array<ReturnType<typeof mkDoc>>, content: string = validContent) {
  prisma.$queryRaw.mockResolvedValue(docs);
  prisma.document.findMany.mockImplementation(async ({ where }: any) =>
    (where.id.in as string[]).map((id) => ({ id, content })),
  );
}

describe('DocEmbedWorkerService', () => {
  describe('candidate selection (staleness in SQL, not in JS)', () => {
    it('asks the database for stale documents only — a NOT EXISTS current-model/sourceUpdatedAt predicate under the live-session + non-empty-content filters', async () => {
      const { prisma, embedder } = makeFakes();
      const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
      await svc.processTick();

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [strings, ...params] = prisma.$queryRaw.mock.calls[0];
      const sql = (strings as string[]).join('?').replace(/\s+/g, ' ');

      expect(sql).toContain('FROM "documents" d');
      expect(sql).toContain('JOIN "users" u ON u."id" = d."userId"');
      expect(sql).toContain('d."content" IS NOT NULL AND d."content" <> \'\'');
      expect(sql).toContain('u."authToken" IS NOT NULL AND u."tokenExpiry" > NOW()');
      // The staleness test itself — an embedded-and-fresh doc is excluded by
      // the query, so it can never occupy a slot in the LIMIT window.
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('FROM "document_embeddings" e');
      expect(sql).toContain('e."documentId" = d."id"');
      expect(sql).toContain('e."sourceUpdatedAt" >= d."updatedAt"');
      expect(sql).toContain('ORDER BY d."updatedAt" DESC');
      expect(sql).toContain('LIMIT');
      // Bound parameters: the model tag and the limit — never interpolated.
      expect(params).toEqual(['bge-m3:latest', 32]); // BATCH(8) * 4 headroom
    });

    it('embeds a doc far outside the newest-32 window when it has no current-model rows (the old JS filter starved it forever)', async () => {
      const { prisma, embedder } = makeFakes();
      // The SQL predicate already excluded the 5000 newer, already-embedded
      // documents, so this ancient un-embedded one IS what the query returns.
      const ancient = mkDoc('old-1', 'userA', 900);
      seed(prisma, [ancient]);

      const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
      const result = await svc.processTick();

      expect(embedder.embed).toHaveBeenCalled();
      expect(result.embedded).toBe(1);
    });

    it('fetches content only for the picked batch, not for the whole headroom window', async () => {
      const { prisma, embedder } = makeFakes();
      const candidates = Array.from({ length: 20 }, (_, n) => mkDoc(`d${n}`, `user${n}`, n + 1));
      seed(prisma, candidates);

      const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
      await svc.processTick();

      expect(prisma.document.findMany).toHaveBeenCalledTimes(1);
      const arg = prisma.document.findMany.mock.calls[0][0];
      expect(arg.select).toEqual({ id: true, content: true });
      expect(arg.where.id.in).toHaveLength(8); // DOC_EMBED_BATCH_PER_TICK, not 20
    });
  });

  it('(a) embeds a fresh doc with no existing rows for the current model: transaction delete+N inserts, sourceUpdatedAt = doc.updatedAt', async () => {
    const { prisma, embedder } = makeFakes();
    const doc = mkDoc('d1', 'userA', 1);
    seed(prisma, [doc]);

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    const result = await svc.processTick();

    expect(embedder.embed).toHaveBeenCalledWith([expect.stringContaining('Title: Doc Title')]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.documentEmbedding.deleteMany).toHaveBeenCalledWith({ where: { documentId: 'd1' } });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1); // one chunk, short text
    expect(prisma.$executeRaw.mock.calls[0]).toContain(doc.updatedAt); // sourceUpdatedAt = doc.updatedAt
    expect(result.embedded).toBe(1);
  });

  it('(b) re-embeds a doc whose stored chunks differ from the freshly extracted text', async () => {
    const { prisma, embedder } = makeFakes();
    const doc = mkDoc('d1', 'userA', 1);
    seed(prisma, [doc]);
    prisma.documentEmbedding.findMany.mockResolvedValue([{ chunkText: 'stale text', failed: false }]);

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    const result = await svc.processTick();

    expect(embedder.embed).toHaveBeenCalled();
    expect(prisma.documentEmbedding.updateMany).not.toHaveBeenCalled();
    expect(result.embedded).toBe(1);
  });

  it('(c) unchanged text (a live collab edit that only bumped updatedAt): no embedder call, rows untouched, sourceUpdatedAt refreshed', async () => {
    const { prisma, embedder } = makeFakes();
    const doc = mkDoc('d1', 'userA', 1);
    seed(prisma, [doc]);
    // Run once to learn the exact chunk text this content produces…
    const probe = new DocEmbedWorkerService(prisma as any, embedder as any);
    await probe.processTick();
    const storedChunk = embedder.embed.mock.calls[0][0][0];

    // …then replay with those chunks already stored for the current model.
    const fresh = makeFakes();
    seed(fresh.prisma, [doc]);
    fresh.prisma.documentEmbedding.findMany.mockResolvedValue([{ chunkText: storedChunk, failed: false }]);

    const svc = new DocEmbedWorkerService(fresh.prisma as any, fresh.embedder as any);
    const result = await svc.processTick();

    expect(fresh.embedder.embed).not.toHaveBeenCalled();
    expect(fresh.prisma.$transaction).not.toHaveBeenCalled();
    expect(fresh.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(fresh.prisma.documentEmbedding.deleteMany).not.toHaveBeenCalled();
    expect(fresh.prisma.documentEmbedding.updateMany).toHaveBeenCalledWith({
      where: { documentId: 'd1', model: 'bge-m3:latest' },
      data: expect.objectContaining({ sourceUpdatedAt: doc.updatedAt }),
    });
    expect(result.refreshed).toBe(1);
    expect(result.embedded).toBe(0);
  });

  it('(c2) a stored tombstone row never counts as "unchanged" — the doc is re-embedded', async () => {
    const { prisma, embedder } = makeFakes();
    const doc = mkDoc('d1', 'userA', 1);
    seed(prisma, [doc]);
    prisma.documentEmbedding.findMany.mockResolvedValue([{ chunkText: '', failed: true }]);

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    const result = await svc.processTick();

    expect(embedder.embed).toHaveBeenCalled();
    expect(result.embedded).toBe(1);
  });

  it('(d) tombstones a doc with empty/invalid content without calling the embedder', async () => {
    const { prisma, embedder } = makeFakes();
    const doc = mkDoc('d1', 'userA', 1);
    seed(prisma, [doc], emptyContent);

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    const result = await svc.processTick();

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(prisma.documentEmbedding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: 'd1',
        chunkIndex: 0,
        model: 'bge-m3:latest',
        chunkText: '',
        failed: true,
        sourceUpdatedAt: doc.updatedAt,
      }),
    });
    expect(result.tombstoned).toBe(1);
  });

  it('a tombstone clears EVERY row for the doc (all models) in one transaction — a previously-embedded doc ends with exactly the failed row', async () => {
    const { prisma, embedder } = makeFakes();
    const doc = mkDoc('d1', 'userA', 1);
    seed(prisma, [doc], emptyContent);

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    await svc.processTick();

    // one atomic transaction, delete-all then the single failed row
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.documentEmbedding.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.documentEmbedding.deleteMany).toHaveBeenCalledWith({ where: { documentId: 'd1' } });
    // no model-qualified delete: old live chunks for THIS model must go too
    expect(prisma.documentEmbedding.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ model: expect.anything() }) }),
    );
    expect(prisma.documentEmbedding.create).toHaveBeenCalledTimes(1);
  });

  it('(e) retries an embedder failure up to 3 consecutive ticks, then tombstones', async () => {
    const { prisma, embedder } = makeFakes();
    const doc = mkDoc('d1', 'userA', 1);
    seed(prisma, [doc]);
    embedder.embed.mockRejectedValue(new Error('ollama down'));

    const svc = new DocEmbedWorkerService(prisma as any, embedder as any);
    await svc.processTick();
    await svc.processTick();
    expect(prisma.documentEmbedding.create).not.toHaveBeenCalled();
    const result = await svc.processTick();

    expect(prisma.documentEmbedding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ failed: true }),
    });
    expect(result.tombstoned).toBe(1);
    expect((svc as any).failures.has('d1')).toBe(false);
  });

  it('(f) applies per-user fairness (2/user) across the batch: user B is represented despite fewer candidates', async () => {
    const { prisma, embedder } = makeFakes();
    const aDocs = Array.from({ length: 5 }, (_, n) => mkDoc(`a${n}`, 'userA', n + 1));
    const bDoc = mkDoc('b0', 'userB', 6);
    seed(prisma, [...aDocs, bDoc]);

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
