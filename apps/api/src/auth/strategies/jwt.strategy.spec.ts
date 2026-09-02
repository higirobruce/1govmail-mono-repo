import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';

function makeStrategy() {
  const config = { get: () => 'test-secret' } as unknown as ConfigService;
  const prisma = { session: { findUnique: jest.fn(), update: jest.fn() } } as unknown as PrismaService;
  return { strategy: new JwtStrategy(config, prisma), prisma: prisma as any };
}

function makeReq(token: string) {
  return { headers: { authorization: `Bearer ${token}` } } as any;
}

describe('JwtStrategy', () => {
  const payload = { sub: 'u1', email: 'u1@example.com' };

  it('rejects when no matching session exists', async () => {
    const { strategy, prisma } = makeStrategy();
    prisma.session.findUnique.mockResolvedValue(null);

    await expect(strategy.validate(makeReq('tok'), payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the session has expired', async () => {
    const { strategy, prisma } = makeStrategy();
    prisma.session.findUnique.mockResolvedValue({ id: 's1', expiresAt: new Date(Date.now() - 1000) });

    await expect(strategy.validate(makeReq('tok'), payload)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a valid session with a stale lastSeenAt, touches it, and returns sessionId', async () => {
    const { strategy, prisma } = makeStrategy();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(Date.now() - 61_000), // more than 60s old
    });
    prisma.session.update.mockResolvedValue({});

    const result = await strategy.validate(makeReq('tok'), payload);

    expect(result).toEqual({ sub: 'u1', email: 'u1@example.com', sessionId: 's1' });
    // The update is fire-and-forget (not awaited by validate), so let
    // pending microtasks flush before asserting it was called.
    await Promise.resolve();
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { lastSeenAt: expect.any(Date) },
    });
  });

  it('accepts a valid session with a fresh lastSeenAt and does NOT touch it', async () => {
    const { strategy, prisma } = makeStrategy();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(), // just now — well within the 60s window
    });

    const result = await strategy.validate(makeReq('tok'), payload);

    expect(result).toEqual({ sub: 'u1', email: 'u1@example.com', sessionId: 's1' });
    await Promise.resolve();
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('does not fail the request when the fire-and-forget lastSeenAt update rejects (e.g. concurrent revocation)', async () => {
    const { strategy, prisma } = makeStrategy();
    prisma.session.findUnique.mockResolvedValue({
      id: 's1',
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(Date.now() - 61_000),
    });
    prisma.session.update.mockRejectedValue(new Error('row not found'));

    await expect(strategy.validate(makeReq('tok'), payload)).resolves.toEqual({
      sub: 'u1',
      email: 'u1@example.com',
      sessionId: 's1',
    });
  });
});
