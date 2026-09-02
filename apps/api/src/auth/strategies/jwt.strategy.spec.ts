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

  it('accepts a valid session, touches lastSeenAt, and returns sessionId', async () => {
    const { strategy, prisma } = makeStrategy();
    prisma.session.findUnique.mockResolvedValue({ id: 's1', expiresAt: new Date(Date.now() + 60_000) });
    prisma.session.update.mockResolvedValue({});

    const result = await strategy.validate(makeReq('tok'), payload);

    expect(result).toEqual({ sub: 'u1', email: 'u1@example.com', sessionId: 's1' });
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { lastSeenAt: expect.any(Date) },
    });
  });
});
