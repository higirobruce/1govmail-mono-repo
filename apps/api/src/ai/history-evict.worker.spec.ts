import { HistoryEvictWorker } from './history-evict.worker';

function makeWorker() {
  const prisma: any = {
    aiConversation: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    agentToolLog: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  return { worker: new HistoryEvictWorker(prisma), prisma };
}

describe('HistoryEvictWorker', () => {
  it('selects conversations by lastTurnAt, not createdAt', async () => {
    const { worker, prisma } = makeWorker();

    await worker.processTick();

    const where = prisma.aiConversation.findMany.mock.calls[0][0].where;
    expect(where.lastTurnAt).toBeDefined();
    expect(where.createdAt).toBeUndefined();
  });

  it('uses a horizon 90 days back by default', async () => {
    const { worker, prisma } = makeWorker();

    await worker.processTick();

    const cutoff: Date = prisma.aiConversation.findMany.mock.calls[0][0].where.lastTurnAt.lt;
    const days = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
  });

  it('caps how many conversations it deletes in one tick', async () => {
    const { worker, prisma } = makeWorker();

    await worker.processTick();

    expect(prisma.aiConversation.findMany.mock.calls[0][0].take).toBe(500);
  });

  it('deletes only the batch it selected, guarded against a fresh turn racing the delete', async () => {
    const { worker, prisma } = makeWorker();
    prisma.aiConversation.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    prisma.aiConversation.deleteMany.mockResolvedValue({ count: 2 });

    const res = await worker.processTick();

    const findWhere = prisma.aiConversation.findMany.mock.calls[0][0].where;
    expect(prisma.aiConversation.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2'] }, lastTurnAt: findWhere.lastTurnAt },
    });
    expect(res.conversations).toBe(2);
  });

  it('sweeps only tool logs orphaned by a deleted conversation, scoped by conversationId: null', async () => {
    const { worker, prisma } = makeWorker();
    prisma.agentToolLog.findMany.mockResolvedValue([
      { id: 'l1' }, { id: 'l2' }, { id: 'l3' }, { id: 'l4' },
    ]);
    prisma.agentToolLog.deleteMany.mockResolvedValue({ count: 4 });

    const res = await worker.processTick();

    const findWhere = prisma.agentToolLog.findMany.mock.calls[0][0].where;
    expect(findWhere.conversationId).toBeNull();
    expect(findWhere.createdAt.lt).toBeInstanceOf(Date);
    expect(prisma.agentToolLog.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['l1', 'l2', 'l3', 'l4'] }, conversationId: null },
    });
    expect(res.toolLogs).toBe(4);
  });

  it('caps how many tool logs it deletes in one tick', async () => {
    const { worker, prisma } = makeWorker();

    await worker.processTick();

    expect(prisma.agentToolLog.findMany.mock.calls[0][0].take).toBe(500);
  });

  it('does nothing on either sweep when nothing is past the horizon', async () => {
    const { worker, prisma } = makeWorker();

    await worker.processTick();

    expect(prisma.aiConversation.deleteMany).not.toHaveBeenCalled();
    expect(prisma.agentToolLog.deleteMany).not.toHaveBeenCalled();
  });
});
