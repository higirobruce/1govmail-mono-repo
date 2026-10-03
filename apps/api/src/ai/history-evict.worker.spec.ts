import { Logger } from '@nestjs/common';
import {
  EVICT_BATCH, EVICT_MAX_BATCHES_PER_TICK, HistoryEvictWorker, positiveSetting,
} from './history-evict.worker';

/** ids for one full batch, so findMany comes back at the cap. */
const fullBatch = (tag: string) =>
  Array.from({ length: EVICT_BATCH }, (_, i) => ({ id: `${tag}${i}` }));

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

  /**
   * F2. The cap was meant to bound one STATEMENT, not one day. With 500 rows
   * per tick on a daily cron, and this feature's own projected volume of
   * thousands of new conversations a day, the deficit is permanent and both
   * tables grow monotonically — on the box already at 78% disk, which is
   * precisely what this worker exists to prevent.
   */
  it('keeps taking batches within one tick until a batch comes back short', async () => {
    const { worker, prisma } = makeWorker();
    prisma.aiConversation.findMany
      .mockResolvedValueOnce(fullBatch('c'))
      .mockResolvedValueOnce([{ id: 'tail1' }, { id: 'tail2' }]);
    prisma.aiConversation.deleteMany
      .mockResolvedValueOnce({ count: EVICT_BATCH })
      .mockResolvedValueOnce({ count: 2 });

    const res = await worker.processTick();

    expect(prisma.aiConversation.findMany).toHaveBeenCalledTimes(2);
    expect(res.conversations).toBe(EVICT_BATCH + 2);
    expect(res.capped).toBe(false);
  });

  it('holds one horizon for the whole tick, so a row does not age into a later batch', async () => {
    const { worker, prisma } = makeWorker();
    prisma.aiConversation.findMany
      .mockResolvedValueOnce(fullBatch('c'))
      .mockResolvedValueOnce([]);
    prisma.aiConversation.deleteMany.mockResolvedValue({ count: EVICT_BATCH });

    await worker.processTick();

    const first = prisma.aiConversation.findMany.mock.calls[0][0].where.lastTurnAt.lt;
    const second = prisma.aiConversation.findMany.mock.calls[1][0].where.lastTurnAt.lt;
    expect(second.getTime()).toBe(first.getTime());
  });

  it('stops at the per-tick ceiling rather than running unbounded, and says work remains', async () => {
    const { worker, prisma } = makeWorker();
    prisma.aiConversation.findMany.mockResolvedValue(fullBatch('c'));
    prisma.aiConversation.deleteMany.mockResolvedValue({ count: EVICT_BATCH });

    const res = await worker.processTick();

    expect(prisma.aiConversation.findMany).toHaveBeenCalledTimes(EVICT_MAX_BATCHES_PER_TICK);
    expect(res.capped).toBe(true);
  });

  it('loops the orphan tool-log sweep the same way', async () => {
    const { worker, prisma } = makeWorker();
    prisma.agentToolLog.findMany
      .mockResolvedValueOnce(fullBatch('l'))
      .mockResolvedValueOnce([{ id: 'ltail' }]);
    prisma.agentToolLog.deleteMany
      .mockResolvedValueOnce({ count: EVICT_BATCH })
      .mockResolvedValueOnce({ count: 1 });

    const res = await worker.processTick();

    expect(prisma.agentToolLog.findMany).toHaveBeenCalledTimes(2);
    expect(res.toolLogs).toBe(EVICT_BATCH + 1);
  });

  it('stops when a batch deletes nothing rather than re-selecting the same rows all night', async () => {
    const { worker, prisma } = makeWorker();
    prisma.aiConversation.findMany.mockResolvedValue(fullBatch('c'));
    prisma.aiConversation.deleteMany.mockResolvedValue({ count: 0 });

    const res = await worker.processTick();

    expect(prisma.aiConversation.findMany).toHaveBeenCalledTimes(1);
    expect(res.conversations).toBe(0);
  });

  /**
   * A tick that stops short reads identically to one that finished, so
   * "is eviction keeping up" was unanswerable from the journal — the exact
   * question §7 says the log exists to answer.
   */
  it('warns, rather than logging a healthy-looking line, when it stops short', async () => {
    const { worker, prisma } = makeWorker();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    prisma.aiConversation.findMany.mockResolvedValue(fullBatch('c'));
    prisma.aiConversation.deleteMany.mockResolvedValue({ count: EVICT_BATCH });

    await worker.tick();

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/remain/i));
    expect(log).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });

  it('logs a plain line when the sweep finished with nothing left', async () => {
    const { worker } = makeWorker();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    await worker.tick();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('ai history eviction'));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    log.mockRestore();
  });
});

/**
 * F7. `Number(process.env.X ?? 90)` catches only undefined: a `.env` line of
 * `AI_HISTORY_RETENTION_DAYS=` yields Number('') === 0, the horizon becomes
 * now, and the next tick deletes every user's entire history while reporting
 * a healthy-looking run in the journal.
 */
describe('positiveSetting', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('falls back, loudly, on an empty value', () => {
    expect(positiveSetting('AI_HISTORY_RETENTION_DAYS', '', 90)).toBe(90);
    expect(warn).toHaveBeenCalled();
  });

  it('falls back on a non-numeric value', () => {
    expect(positiveSetting('AI_HISTORY_RETENTION_DAYS', 'ninety', 90)).toBe(90);
    expect(warn).toHaveBeenCalled();
  });

  it.each(['0', '-1', 'Infinity', 'NaN'])('falls back on %s', (raw) => {
    expect(positiveSetting('AI_HISTORY_RETENTION_DAYS', raw, 90)).toBe(90);
    expect(warn).toHaveBeenCalled();
  });

  it('takes a legitimate override, silently', () => {
    expect(positiveSetting('AI_HISTORY_RETENTION_DAYS', '30', 90)).toBe(30);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is silent when the variable is simply unset — that is not a misconfiguration', () => {
    expect(positiveSetting('AI_HISTORY_RETENTION_DAYS', undefined, 90)).toBe(90);
    expect(warn).not.toHaveBeenCalled();
  });

  it('floors a fractional value rather than handing Prisma a non-integer take', () => {
    expect(positiveSetting('AI_HISTORY_EVICT_BATCH', '250.7', 500)).toBe(250);
  });
});
