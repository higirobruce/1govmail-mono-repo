import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { AuditService } from '../common/audit/audit.service';

function makeService() {
  const prisma = {
    user: { upsert: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    session: { create: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  } as unknown as PrismaService;
  const zimbra = { authenticate: jest.fn() } as unknown as ZimbraService;
  const jwt = { sign: jest.fn(() => 'signed.jwt.token'), verify: jest.fn() } as unknown as JwtService;
  const audit = { record: jest.fn() } as unknown as AuditService;
  const service = new AuthService(prisma, zimbra, jwt, audit);
  return { service, prisma: prisma as any, zimbra: zimbra as any, jwt: jwt as any, audit: audit as any };
}

describe('AuthService.login', () => {
  it('persists a Session row tied to the issued token', async () => {
    const { service, prisma, zimbra } = makeService();
    zimbra.authenticate.mockResolvedValue({
      twoFactorRequired: false,
      authToken: 'zimbra-tok',
      csrfToken: 'csrf',
      lifetime: 3_600_000,
      displayName: 'Test User',
      refer: undefined,
    });
    prisma.user.upsert.mockResolvedValue({
      id: 'u1', email: 'u1@example.com', displayName: 'Test User', zimbraHost: 'mail.example.com',
    });

    await service.login('u1@example.com', 'pw', 'mail.example.com', { ip: '10.0.0.1', userAgent: 'Vitest/1.0' });

    expect(prisma.session.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        token: 'signed.jwt.token',
        expiresAt: expect.any(Date),
        userAgent: 'Vitest/1.0',
        ipAddress: '10.0.0.1',
      },
    });
  });

  it('does not fail login when a duplicate token collides on the unique Session.token constraint', async () => {
    const { service, prisma, zimbra } = makeService();
    zimbra.authenticate.mockResolvedValue({
      twoFactorRequired: false,
      authToken: 'zimbra-tok',
      csrfToken: 'csrf',
      lifetime: 3_600_000,
      displayName: 'Test User',
      refer: undefined,
    });
    prisma.user.upsert.mockResolvedValue({
      id: 'u1', email: 'u1@example.com', displayName: 'Test User', zimbraHost: 'mail.example.com',
    });
    prisma.session.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`token`)', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.login('u1@example.com', 'pw', 'mail.example.com', { ip: '10.0.0.1', userAgent: 'Vitest/1.0' }),
    ).resolves.toEqual({
      accessToken: 'signed.jwt.token',
      user: {
        id: 'u1',
        email: 'u1@example.com',
        displayName: 'Test User',
        zimbraHost: 'mail.example.com',
      },
    });
  });
});

describe('AuthService sessions', () => {
  it('lists sessions ordered by lastSeenAt, flagging the current one', async () => {
    const { service, prisma } = makeService();
    prisma.session.findMany.mockResolvedValue([
      { id: 's1', userAgent: 'Chrome', ipAddress: '10.0.0.1', createdAt: new Date(), lastSeenAt: new Date() },
      { id: 's2', userAgent: 'Firefox', ipAddress: '10.0.0.2', createdAt: new Date(), lastSeenAt: new Date() },
    ]);

    const result = await service.getSessions('u1', 's2');

    expect(prisma.session.findMany).toHaveBeenCalledWith({ where: { userId: 'u1' }, orderBy: { lastSeenAt: 'desc' } });
    expect(result.find((s: any) => s.id === 's2').isCurrent).toBe(true);
    expect(result.find((s: any) => s.id === 's1').isCurrent).toBe(false);
  });

  it('revokeSession deletes an owned session', async () => {
    const { service, prisma } = makeService();
    prisma.session.findFirst.mockResolvedValue({ id: 's1', userId: 'u1' });

    const result = await service.revokeSession('u1', 's1');

    expect(prisma.session.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    expect(result).toEqual({ success: true });
  });

  it('revokeSession throws NotFoundException for a session the user does not own', async () => {
    const { service, prisma } = makeService();
    prisma.session.findFirst.mockResolvedValue(null);

    await expect(service.revokeSession('u1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('revokeOtherSessions deletes every session except the current one', async () => {
    const { service, prisma } = makeService();
    prisma.session.deleteMany.mockResolvedValue({ count: 2 });

    const result = await service.revokeOtherSessions('u1', 's-current');

    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', id: { not: 's-current' } } });
    expect(result).toEqual({ success: true, revoked: 2 });
  });
});
