import { JwtService } from '@nestjs/jwt';
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
});
