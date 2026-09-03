import { CardWorkerService, pickFairBatch } from './card-worker.service';
import type { ExtractedCard } from '@email-client/shared';

const now = Date.now();
const day = 86_400_000;

function mkCandidate(id: string, userId: string, daysAgo: number, path = '/Inbox') {
  return {
    id,
    userId,
    conversationId: null,
    subject: 'subject',
    fromEmail: 'sender@example.com',
    fromName: 'Sender',
    receivedAt: new Date(now - daysAgo * day),
    attachments: [],
    folder: { path },
  };
}

function makeFakes() {
  const prisma = {
    message: { findMany: jest.fn() },
    messageCard: { upsert: jest.fn(), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const mailService = { getMessage: jest.fn().mockResolvedValue({ bodyText: 'body text', bodyHtml: null }) };
  const extractor = { model: 'test-model:latest', extract: jest.fn() };
  return { prisma, mailService, extractor };
}

const SAMPLE_CARD: ExtractedCard = {
  messageId: 'ignored',
  conversationId: null,
  direction: 'received',
  from: 'sender@example.com',
  subject: 'subject',
  receivedAt: new Date(now).toISOString(),
  gist: 'a gist',
  asksOfMe: ['do the thing'],
  deadlines: ['Friday'],
  commitmentsIMade: [],
  waitingOn: null,
  importance: 'high',
  attachments: [],
  injectionSuspected: false,
};

describe('pickFairBatch', () => {
  it('interleaves rounds across users up to perUser, capped at total', () => {
    const a = [1, 2, 3, 4, 5].map((n) => ({ userId: 'A', id: `a${n}` }));
    const b = [1, 2, 3].map((n) => ({ userId: 'B', id: `b${n}` }));
    const result = pickFairBatch([...a, ...b], 3, 8);
    expect(result.map((r) => r.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
  });

  it('stops at total even if perUser has not been exhausted', () => {
    const a = [1, 2, 3].map((n) => ({ userId: 'A', id: `a${n}` }));
    const b = [1, 2, 3].map((n) => ({ userId: 'B', id: `b${n}` }));
    const c = [1, 2, 3].map((n) => ({ userId: 'C', id: `c${n}` }));
    const result = pickFairBatch([...a, ...b, ...c], 3, 4);
    expect(result).toHaveLength(4);
  });

  it('returns nothing when perUser is 0', () => {
    const candidates = [1, 2, 3].map((n) => ({ userId: 'A', id: `a${n}` }));
    expect(pickFairBatch(candidates, 0, 8)).toEqual([]);
  });
});

describe('CardWorkerService', () => {
  it('selects only inbox/sent messages within 14 days lacking a card, for valid-token users, capped per user', async () => {
    const { prisma, mailService, extractor } = makeFakes();
    extractor.extract.mockResolvedValue(SAMPLE_CARD);

    // 5 pending messages for user A (all newer) and 5 for user B — a naive
    // top-8-by-date slice would take all 5 of A plus only 3 of B.
    const aMsgs = [1, 2, 3, 4, 5].map((n) => mkCandidate(`a${n}`, 'userA', n));
    const bMsgs = [1, 2, 3, 4, 5].map((n) => mkCandidate(`b${n}`, 'userB', n + 0.5));
    prisma.message.findMany.mockResolvedValue([...aMsgs, ...bMsgs]);

    const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any);
    await svc.processTick();

    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          folder: { path: { in: ['/Inbox', '/Sent'] } },
          receivedAt: { gte: expect.any(Date) },
          user: expect.objectContaining({
            authToken: { not: null },
            tokenExpiry: { gt: expect.any(Date) },
          }),
          OR: [{ card: null }, { card: { model: { not: extractor.model } } }],
        }),
        orderBy: { receivedAt: 'desc' },
        take: 32, // CARD_BATCH_PER_TICK * 4
      }),
    );

    const processedIds = mailService.getMessage.mock.calls.map((c) => c[1]);
    expect(processedIds).toHaveLength(6);
    expect(processedIds.filter((id) => id.startsWith('a'))).toHaveLength(3);
    expect(processedIds.filter((id) => id.startsWith('b'))).toHaveLength(3);
  });

  it('hydrates bodies via mailService.getMessage and upserts a card', async () => {
    const { prisma, mailService, extractor } = makeFakes();
    const candidate = mkCandidate('m1', 'userA', 1);
    prisma.message.findMany.mockResolvedValue([candidate]);
    mailService.getMessage.mockResolvedValue({
      bodyText: 'hello world',
      bodyHtml: null,
      attachments: [{ filename: 'budget.xlsx', size: 1024 }],
    });
    extractor.extract.mockResolvedValue(SAMPLE_CARD);

    const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any);
    const result = await svc.processTick();

    expect(mailService.getMessage).toHaveBeenCalledWith('userA', 'm1');
    // Prompt attachments should come from the hydrated detail (`full`), not the
    // stale listing-row `attachments` on the candidate.
    expect(extractor.extract).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: ['budget.xlsx (1KB)'] }),
      'hello world',
      null,
    );
    expect(prisma.messageCard.upsert).toHaveBeenCalledWith({
      where: { messageId: 'm1' },
      create: expect.objectContaining({
        messageId: 'm1',
        userId: 'userA',
        model: extractor.model,
        gist: SAMPLE_CARD.gist,
        asksOfMe: SAMPLE_CARD.asksOfMe,
        deadlines: SAMPLE_CARD.deadlines,
        commitmentsIMade: SAMPLE_CARD.commitmentsIMade,
        waitingOn: SAMPLE_CARD.waitingOn,
        importance: SAMPLE_CARD.importance,
        injectionSuspected: SAMPLE_CARD.injectionSuspected,
        failed: false,
        extractedAt: expect.any(Date),
      }),
      update: expect.objectContaining({ failed: false, extractedAt: expect.any(Date) }),
    });
    expect(result.classified).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('writes a failed tombstone when extraction returns null', async () => {
    const { prisma, mailService, extractor } = makeFakes();
    const candidate = mkCandidate('m2', 'userA', 1);
    prisma.message.findMany.mockResolvedValue([candidate]);
    extractor.extract.mockResolvedValue(null);

    const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any);
    const result = await svc.processTick();

    expect(prisma.messageCard.upsert).toHaveBeenCalledWith({
      where: { messageId: 'm2' },
      create: expect.objectContaining({
        gist: '',
        asksOfMe: [],
        deadlines: [],
        commitmentsIMade: [],
        waitingOn: null,
        importance: 'normal',
        injectionSuspected: false,
        failed: true,
        extractedAt: expect.any(Date),
      }),
      update: expect.objectContaining({ failed: true, extractedAt: expect.any(Date) }),
    });
    expect(result.failed).toBe(1);
    expect(result.classified).toBe(0);
  });

  it('leaves the message unclassified when the extractor throws', async () => {
    const { prisma, mailService, extractor } = makeFakes();
    const bad = mkCandidate('bad', 'userA', 1);
    const good = mkCandidate('good', 'userA', 2);
    prisma.message.findMany.mockResolvedValue([bad, good]);
    extractor.extract.mockImplementation(async (source: any) => {
      if (source.id === 'bad') throw new Error('network down');
      return SAMPLE_CARD;
    });

    const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any);
    const result = await svc.processTick();

    expect(prisma.messageCard.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.messageCard.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { messageId: 'good' } }),
    );
    expect(result.classified).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('purges cards whose message is older than 90 days', async () => {
    const { prisma, mailService, extractor } = makeFakes();
    prisma.message.findMany.mockResolvedValue([]);
    prisma.messageCard.deleteMany.mockResolvedValue({ count: 4 });

    const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any);
    const beforeCutoff = new Date(Date.now() - 90 * day);
    const result = await svc.processTick();
    const afterCutoff = new Date(Date.now() - 90 * day);

    expect(prisma.messageCard.deleteMany).toHaveBeenCalledWith({
      where: { message: { receivedAt: { lt: expect.any(Date) } } },
    });
    const actualCutoff = prisma.messageCard.deleteMany.mock.calls[0][0].where.message.receivedAt.lt as Date;
    expect(actualCutoff.getTime()).toBeGreaterThanOrEqual(beforeCutoff.getTime() - 1000);
    expect(actualCutoff.getTime()).toBeLessThanOrEqual(afterCutoff.getTime() + 1000);
    expect(result.purged).toBe(4);
  });

  describe('hourly purge scheduling', () => {
    it('purges on the first tick', async () => {
      const { prisma, mailService, extractor } = makeFakes();
      prisma.message.findMany.mockResolvedValue([]);
      prisma.messageCard.deleteMany.mockResolvedValue({ count: 2 });

      const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any, 3_600_000);
      const result = await svc.processTick();

      expect(prisma.messageCard.deleteMany).toHaveBeenCalledTimes(1);
      expect(result.purged).toBe(2);
    });

    it('does not purge again on an immediate second tick within the interval', async () => {
      const { prisma, mailService, extractor } = makeFakes();
      prisma.message.findMany.mockResolvedValue([]);
      prisma.messageCard.deleteMany.mockResolvedValue({ count: 2 });

      const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any, 3_600_000);
      await svc.processTick();
      const second = await svc.processTick();

      expect(prisma.messageCard.deleteMany).toHaveBeenCalledTimes(1);
      expect(second.purged).toBe(0);
    });

    it('purges again once the interval has elapsed', async () => {
      const { prisma, mailService, extractor } = makeFakes();
      prisma.message.findMany.mockResolvedValue([]);
      prisma.messageCard.deleteMany.mockResolvedValue({ count: 2 });

      const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any, 3_600_000);
      await svc.processTick();
      // Force lastPurgeAt back past the interval, as if an hour had elapsed.
      (svc as any).lastPurgeAt = Date.now() - 3_600_001;
      const third = await svc.processTick();

      expect(prisma.messageCard.deleteMany).toHaveBeenCalledTimes(2);
      expect(third.purged).toBe(2);
    });
  });

  describe('hydration failure cap', () => {
    it('does not upsert while failures are below the limit, and grows the counter', async () => {
      const { prisma, mailService, extractor } = makeFakes();
      const candidate = mkCandidate('m1', 'userA', 1);
      prisma.message.findMany.mockResolvedValue([candidate]);
      mailService.getMessage.mockRejectedValue(new Error('zimbra down'));

      const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any);
      await svc.processTick();
      await svc.processTick();

      expect(prisma.messageCard.upsert).not.toHaveBeenCalled();
      expect((svc as any).hydrationFailures.get('m1')).toBe(2);
    });

    it('tombstones the message once failures reach the limit, and clears the counter', async () => {
      const { prisma, mailService, extractor } = makeFakes();
      const candidate = mkCandidate('m1', 'userA', 1);
      prisma.message.findMany.mockResolvedValue([candidate]);
      mailService.getMessage.mockRejectedValue(new Error('zimbra down'));

      const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any);
      await svc.processTick();
      await svc.processTick();
      const result = await svc.processTick();

      expect(prisma.messageCard.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.messageCard.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { messageId: 'm1' },
          create: expect.objectContaining({ failed: true }),
        }),
      );
      expect(result.failed).toBe(1);
      expect((svc as any).hydrationFailures.has('m1')).toBe(false);
    });

    it('clears the failure counter on a subsequent success', async () => {
      const { prisma, mailService, extractor } = makeFakes();
      const candidate = mkCandidate('m1', 'userA', 1);
      prisma.message.findMany.mockResolvedValue([candidate]);
      extractor.extract.mockResolvedValue(SAMPLE_CARD);

      const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any);
      mailService.getMessage.mockRejectedValueOnce(new Error('zimbra down'));
      await svc.processTick();
      expect((svc as any).hydrationFailures.get('m1')).toBe(1);

      mailService.getMessage.mockResolvedValue({ bodyText: 'hello', bodyHtml: null });
      await svc.processTick();
      expect((svc as any).hydrationFailures.has('m1')).toBe(false);
    });
  });

  it("re-selects messages whose card model differs from CARD_MODEL", async () => {
    const { prisma, mailService, extractor } = makeFakes();
    prisma.message.findMany.mockResolvedValue([]);

    const svc = new CardWorkerService(prisma as any, mailService as any, extractor as any);
    await svc.processTick();

    const where = prisma.message.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ card: null }, { card: { model: { not: extractor.model } } }]);
  });
});
