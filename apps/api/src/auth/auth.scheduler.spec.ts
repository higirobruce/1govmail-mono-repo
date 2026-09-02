import { AuthScheduler } from './auth.scheduler';
import { PrismaService } from '../prisma/prisma.service';

function makeScheduler() {
  const prisma = { session: { deleteMany: jest.fn() } } as unknown as PrismaService;
  return { scheduler: new AuthScheduler(prisma), prisma: prisma as any };
}

describe('AuthScheduler.pruneExpiredSessions', () => {
  it('deletes sessions whose expiresAt has passed', async () => {
    const { scheduler, prisma } = makeScheduler();
    prisma.session.deleteMany.mockResolvedValue({ count: 3 });

    await scheduler.pruneExpiredSessions();

    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: expect.any(Date) } },
    });
  });

  it('swallows errors so a transient DB failure does not crash the cron job', async () => {
    const { scheduler, prisma } = makeScheduler();
    prisma.session.deleteMany.mockRejectedValue(new Error('db unavailable'));

    await expect(scheduler.pruneExpiredSessions()).resolves.toBeUndefined();
  });
});
