import { RetrievalService } from './retrieval.service';

const vec = Array.from({ length: 1024 }, () => 0.5);

function vecRow(id: string, over: Record<string, unknown> = {}) {
  return {
    messageId: id, chunkText: `chunk for ${id}`, subject: `subj ${id}`,
    fromEmail: 'a@x.rw', fromName: 'A', receivedAt: new Date(), snippet: `snip ${id}`,
    isRead: true, hasAttachments: false, distance: 0.2, ...over,
  };
}

function makeFakes() {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    messageCard: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const embedder = { model: 'bge-m3:latest', dims: 1024, embed: jest.fn().mockResolvedValue([vec]) };
  const mailService = {
    searchMessages: jest.fn().mockResolvedValue({ messages: [], total: 0, hasMore: false }),
    getMessage: jest.fn().mockResolvedValue(null),
  };
  return { prisma, embedder, mailService };
}

describe('RetrievalService.retrieve', () => {
  it('embeds the question and runs a per-user cosine query', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([vecRow('m1')]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'what did finance say about the budget?');

    expect(embedder.embed).toHaveBeenCalledWith(['what did finance say about the budget?']);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(result.sources[0]).toMatchObject({ messageId: 'm1', context: 'chunk for m1' });
    expect(result.degraded).toEqual({ vector: false, keyword: false });
  });

  it('sends extracted keywords (not the raw question) to the Zimbra leg, scoped to 90 days', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    await svc.retrieve('user1', 'what did finance say about the budget?');

    const [, query, limit] = mailService.searchMessages.mock.calls[0];
    expect(query).toContain('finance');
    expect(query).toContain('budget');
    expect(query).not.toMatch(/\bwhat\b/);
    expect(query).toMatch(/after:\d{1,2}\/\d{1,2}\/\d{4}/);
    expect(limit).toBe(10);
  });

  it('skips the keyword leg entirely when no keywords survive', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);
    await svc.retrieve('user1', 'what is the');
    expect(mailService.searchMessages).not.toHaveBeenCalled();
  });

  it('fuses both legs, ranking a double-hit first, and keeps the vector chunkText as context', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([vecRow('m1'), vecRow('m2')]);
    mailService.searchMessages.mockResolvedValue({
      messages: [
        { id: 'm9', subject: 's9', fromEmail: 'b@x.rw', fromName: null, receivedAt: new Date(), snippet: 'kw snip', bodyText: null, bodyHtml: null },
        { id: 'm2', subject: 's2', fromEmail: 'c@x.rw', fromName: null, receivedAt: new Date(), snippet: 'dup', bodyText: null, bodyHtml: null },
      ],
    });
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'budget finance');

    expect(result.sources[0].messageId).toBe('m2'); // hit by both legs
    const m2 = result.sources.find((s) => s.messageId === 'm2')!;
    expect(m2.context).toBe('chunk for m2'); // vector payload wins dedupe
    expect(result.sources.map((s) => s.messageId)).toContain('m9');
  });

  it('uses cached bodyText via extractEmailText for keyword-only hits, snippet as last resort', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    mailService.searchMessages.mockResolvedValue({
      messages: [
        { id: 'k1', subject: 's', fromEmail: 'a@x.rw', fromName: null, receivedAt: new Date(), snippet: 'the snippet', bodyText: 'A cached body.', bodyHtml: null },
        { id: 'k2', subject: 's', fromEmail: 'a@x.rw', fromName: null, receivedAt: new Date(), snippet: 'only snippet', bodyText: null, bodyHtml: null },
      ],
    });
    mailService.getMessage.mockRejectedValue(new Error('hydration down')); // degrade to snippet
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'budget finance');

    expect(result.sources.find((s) => s.messageId === 'k1')!.context).toContain('A cached body.');
    expect(result.sources.find((s) => s.messageId === 'k2')!.context).toBe('only snippet');
  });

  it('flags injectionSuspected from the message card', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockResolvedValue([vecRow('m1')]);
    prisma.messageCard.findMany.mockResolvedValue([{ messageId: 'm1', injectionSuspected: true }]);
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);
    const result = await svc.retrieve('user1', 'budget');
    expect(result.sources[0].injectionSuspected).toBe(true);
  });

  it('degrades to the surviving leg when one throws, and reports both-degraded with zero sources', async () => {
    const { prisma, embedder, mailService } = makeFakes();
    prisma.$queryRaw.mockRejectedValue(new Error('pg down'));
    mailService.searchMessages.mockResolvedValue({
      messages: [{ id: 'k1', subject: 's', fromEmail: 'a@x.rw', fromName: null, receivedAt: new Date(), snippet: 'snip', bodyText: 'body', bodyHtml: null }],
    });
    const svc = new RetrievalService(prisma as any, embedder as any, mailService as any);

    const result = await svc.retrieve('user1', 'budget finance');
    expect(result.degraded.vector).toBe(true);
    expect(result.sources).toHaveLength(1);

    mailService.searchMessages.mockRejectedValue(new Error('zimbra down'));
    const both = await svc.retrieve('user1', 'budget finance');
    expect(both.degraded).toEqual({ vector: true, keyword: true });
    expect(both.sources).toHaveLength(0);
  });
});
