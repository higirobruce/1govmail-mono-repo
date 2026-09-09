import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { ZimbraService } from '../zimbra/zimbra.service';
import { AuditService } from '../common/audit/audit.service';
import { InstitutionRegistry } from './institution.registry';

// Rows shaped like Task 1's seed (see institution.registry.spec.ts), plus a
// 'legacy' row whose host matches what the pre-existing tests below already
// use as their zimbraHost, so the legacy resolveByHost path still resolves.
const institutionRows = [
  { id: 'risa', label: 'RISA', provider: 'zimbra', host: 'mail.risa.gov.rw:8443', ewsDomain: null, enabled: true, position: 0 },
  { id: 'legacy', label: 'Legacy', provider: 'zimbra', host: 'mail.example.com', ewsDomain: null, enabled: true, position: 1 },
  { id: 'minaffet', label: 'MINAFFET', provider: 'ews', host: 'webmail.minaffet.gov.rw', ewsDomain: 'MINAFFET', enabled: true, position: 2 },
];

function makeService() {
  const prisma = {
    user: { upsert: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    session: { create: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  } as unknown as PrismaService;
  const zimbra = { authenticate: jest.fn(), verifyTwoFactor: jest.fn() } as unknown as ZimbraService;
  const jwt = { sign: jest.fn(() => 'signed.jwt.token'), verify: jest.fn() } as unknown as JwtService;
  const audit = { record: jest.fn() } as unknown as AuditService;
  const institutionRegistry = {
    list: jest.fn(),
    resolve: jest.fn(async (id: string) => institutionRows.find((r) => r.id === id) ?? null),
    resolveByHost: jest.fn(async (host: string) => institutionRows.find((r) => r.host === host) ?? null),
  } as unknown as InstitutionRegistry;
  const service = new AuthService(prisma, zimbra, jwt, audit, institutionRegistry);
  return {
    service,
    prisma: prisma as any,
    zimbra: zimbra as any,
    jwt: jwt as any,
    audit: audit as any,
    institutionRegistry: institutionRegistry as any,
  };
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
      redirectHost: undefined,
    });
    prisma.user.upsert.mockResolvedValue({
      id: 'u1', email: 'u1@example.com', displayName: 'Test User', zimbraHost: 'mail.example.com',
    });

    await service.login(
      { email: 'u1@example.com', password: 'pw', zimbraHost: 'mail.example.com' } as any,
      { ip: '10.0.0.1', userAgent: 'Vitest/1.0' },
    );

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
      redirectHost: undefined,
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
      service.login(
        { email: 'u1@example.com', password: 'pw', zimbraHost: 'mail.example.com' } as any,
        { ip: '10.0.0.1', userAgent: 'Vitest/1.0' },
      ),
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

describe('AuthService.login lifetime guard', () => {
  it.each([
    ['omitted/zero', 0],
    ['NaN', Number.NaN],
    ['unreasonably small (5s)', 5_000],
    ['negative', -1000],
  ])('floors expiresAt to the 1h default when Zimbra lifetime is %s', async (_label, lifetime) => {
    const { service, prisma, zimbra } = makeService();
    zimbra.authenticate.mockResolvedValue({
      twoFactorRequired: false,
      authToken: 'zimbra-tok',
      csrfToken: 'csrf',
      lifetime,
      displayName: 'Test User',
      redirectHost: undefined,
    });
    prisma.user.upsert.mockResolvedValue({
      id: 'u1', email: 'u1@example.com', displayName: 'Test User', zimbraHost: 'mail.example.com',
    });

    const before = Date.now();
    await service.login({ email: 'u1@example.com', password: 'pw', zimbraHost: 'mail.example.com' } as any, {});
    const after = Date.now();

    const { expiresAt } = (prisma.session.create as jest.Mock).mock.calls[0][0].data;
    const ONE_HOUR_MS = 60 * 60 * 1000;
    // Should land roughly 1h from "now", never at-or-before "now" (which would
    // immediately fail JwtStrategy's expiresAt check on the very next request).
    expect(expiresAt.getTime()).toBeGreaterThan(before + ONE_HOUR_MS - 5_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + ONE_HOUR_MS);
  });

  it('uses the real Zimbra lifetime when it is a sane value', async () => {
    const { service, prisma, zimbra } = makeService();
    const lifetime = 3_600_000; // 1h, matches Zimbra's typical response
    zimbra.authenticate.mockResolvedValue({
      twoFactorRequired: false,
      authToken: 'zimbra-tok',
      csrfToken: 'csrf',
      lifetime,
      displayName: 'Test User',
      redirectHost: undefined,
    });
    prisma.user.upsert.mockResolvedValue({
      id: 'u1', email: 'u1@example.com', displayName: 'Test User', zimbraHost: 'mail.example.com',
    });

    const before = Date.now();
    await service.login({ email: 'u1@example.com', password: 'pw', zimbraHost: 'mail.example.com' } as any, {});

    const { expiresAt } = (prisma.session.create as jest.Mock).mock.calls[0][0].data;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + lifetime);
    expect(expiresAt.getTime()).toBeLessThan(before + lifetime + 5_000);
  });
});

describe('AuthService.login institution resolution', () => {
  it('login resolves institution server-side and stamps provider + institutionId', async () => {
    const { service, prisma, zimbra } = makeService();
    zimbra.authenticate.mockResolvedValue({
      twoFactorRequired: false,
      authToken: 'zimbra-tok',
      csrfToken: 'csrf',
      lifetime: 3_600_000,
      displayName: 'Test User',
      redirectHost: undefined,
    });
    prisma.user.upsert.mockResolvedValue({
      id: 'u1', email: 'u@risa.gov.rw', displayName: 'Test User', zimbraHost: 'mail.risa.gov.rw:8443',
    });

    const res = await service.login({ institution: 'risa', email: 'u@risa.gov.rw', password: 'pw' } as any);

    expect(zimbra.authenticate).toHaveBeenCalledWith('mail.risa.gov.rw:8443', 'u@risa.gov.rw', 'pw');
    expect(prisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ provider: 'zimbra', institutionId: 'risa' }),
      update: expect.objectContaining({ provider: 'zimbra', institutionId: 'risa' }),
    }));
    expect(res).toHaveProperty('accessToken');
  });

  it('rejects unknown or disabled institutions with 400', async () => {
    const { service } = makeService();
    await expect(service.login({ institution: 'nope', email: 'a@b', password: 'x' } as any))
      .rejects.toThrow(BadRequestException);
  });

  it('legacy zimbraHost still works when it matches a registry row', async () => {
    const { service, prisma, zimbra } = makeService();
    zimbra.authenticate.mockResolvedValue({
      twoFactorRequired: false,
      authToken: 'zimbra-tok',
      csrfToken: 'csrf',
      lifetime: 3_600_000,
      displayName: 'Test User',
      redirectHost: undefined,
    });
    prisma.user.upsert.mockResolvedValue({
      id: 'u1', email: 'u@risa.gov.rw', displayName: 'Test User', zimbraHost: 'mail.risa.gov.rw:8443',
    });

    await service.login({ zimbraHost: 'mail.risa.gov.rw:8443', email: 'u@risa.gov.rw', password: 'pw' } as any);

    expect(zimbra.authenticate).toHaveBeenCalledWith('mail.risa.gov.rw:8443', 'u@risa.gov.rw', 'pw');
  });

  it('rejects a zimbraHost not present in the registry', async () => {
    const { service } = makeService();
    await expect(service.login({ zimbraHost: 'evil.example.com', email: 'a@b', password: 'x' } as any))
      .rejects.toThrow(BadRequestException);
  });

  it('rejects ews/memory institutions until their providers exist', async () => {
    const { service } = makeService();
    // "not yet supported" — lifted in Phase 2/3
    await expect(service.login({ institution: 'minaffet', email: 'a@minaffet.gov.rw', password: 'x' } as any))
      .rejects.toThrow(BadRequestException);
  });
});

describe('AuthService.loginTwoFactor', () => {
  it('stamps provider + institutionId from the challenge token onto the upsert', async () => {
    const { service, prisma, zimbra, jwt } = makeService();
    jwt.verify.mockReturnValue({
      sub: 'zimbra:two-factor',
      email: 'u@risa.gov.rw',
      zimbraHost: 'mail.risa.gov.rw:8443',
      preAuthToken: 'pre-auth-tok',
      provider: 'zimbra',
      institutionId: 'risa',
    });
    zimbra.verifyTwoFactor.mockResolvedValue({
      twoFactorRequired: false,
      authToken: 'zimbra-tok',
      csrfToken: 'csrf',
      lifetime: 3_600_000,
      displayName: 'Test User',
      redirectHost: undefined,
    });
    prisma.user.upsert.mockResolvedValue({
      id: 'u1', email: 'u@risa.gov.rw', displayName: 'Test User', zimbraHost: 'mail.risa.gov.rw:8443',
    });

    const res = await service.loginTwoFactor('challenge-tok', '123456', { ip: '10.0.0.1', userAgent: 'Vitest/1.0' });

    expect(zimbra.verifyTwoFactor).toHaveBeenCalledWith(
      'mail.risa.gov.rw:8443', 'u@risa.gov.rw', 'pre-auth-tok', '123456',
    );
    expect(prisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ provider: 'zimbra', institutionId: 'risa' }),
      update: expect.objectContaining({ provider: 'zimbra', institutionId: 'risa' }),
    }));
    expect(res).toHaveProperty('accessToken');
  });

  it('still issues a signed JWT and persists a Session row (pre-existing behavior unchanged)', async () => {
    const { service, prisma, zimbra, jwt } = makeService();
    jwt.verify.mockReturnValue({
      sub: 'zimbra:two-factor',
      email: 'u1@example.com',
      zimbraHost: 'mail.example.com',
      preAuthToken: 'pre-auth-tok',
      provider: 'zimbra',
      institutionId: 'legacy',
    });
    zimbra.verifyTwoFactor.mockResolvedValue({
      twoFactorRequired: false,
      authToken: 'zimbra-tok',
      csrfToken: 'csrf',
      lifetime: 3_600_000,
      displayName: 'Test User',
      redirectHost: undefined,
    });
    prisma.user.upsert.mockResolvedValue({
      id: 'u1', email: 'u1@example.com', displayName: 'Test User', zimbraHost: 'mail.example.com',
    });

    const res = await service.loginTwoFactor('challenge-tok', '123456', { ip: '10.0.0.1', userAgent: 'Vitest/1.0' });

    expect(jwt.sign).toHaveBeenCalledWith({ sub: 'u1', email: 'u1@example.com' });
    expect(prisma.session.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        token: 'signed.jwt.token',
        expiresAt: expect.any(Date),
        userAgent: 'Vitest/1.0',
        ipAddress: '10.0.0.1',
      },
    });
    expect(res).toEqual({
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

    expect(prisma.session.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', expiresAt: { gt: expect.any(Date) } },
      orderBy: { lastSeenAt: 'desc' },
    });
    expect(result.find((s: any) => s.id === 's2')?.isCurrent).toBe(true);
    expect(result.find((s: any) => s.id === 's1')?.isCurrent).toBe(false);
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
