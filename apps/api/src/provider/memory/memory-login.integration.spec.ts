import { JwtService } from '@nestjs/jwt';
import { BadRequestException } from '@nestjs/common';
import { AuthService } from '../../auth/auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ZimbraService } from '../../zimbra/zimbra.service';
import { MailProviderResolver } from '../mail-provider.resolver';
import { AuditService } from '../../common/audit/audit.service';
import { InstitutionRegistry } from '../../auth/institution.registry';
import { MailSession } from '../mail-session';
import { MemoryStore } from './memory-store';
import { MemoryMailProvider } from './memory-mail.provider';

/**
 * End-to-end login → resolver → provider path for the memory backend, wired
 * with the REAL MailProviderResolver over a REAL MemoryMailProvider (only the
 * DB/JWT/audit edges are mocked, in the style of auth.service.spec). This is
 * the integration seam Task 6 registers: with MAIL_PROVIDER_MEMORY=true a
 * `memory` institution logs in against the fake, and with the flag off the
 * resolver gate refuses it exactly like an unregistered provider.
 *
 * The full Nest AppModule is deliberately NOT compiled here: it drags in
 * Postgres, config and every feature module. Hand-wiring the three collaborators
 * (resolver + memory provider + mocked registry/prisma/jwt/audit) exercises the
 * same objects the request path uses while keeping the test hermetic — the
 * DI graph itself is covered by provider.module.spec.ts compiling AppModule.
 */
const MEMORY_ROW = {
  id: 'memory', label: 'Demo (local)', provider: 'memory',
  host: 'memory.local', ewsDomain: null, enabled: true, position: 9999,
};

function makeHarness() {
  const store = new MemoryStore();
  const memoryProvider = new MemoryMailProvider(store);
  const zimbra = { authenticate: jest.fn(), verifyTwoFactor: jest.fn() } as unknown as ZimbraService;
  // The real resolver, wired with the real memory provider — the gate under test.
  const resolver = new MailProviderResolver(zimbra, memoryProvider);

  const prisma = {
    user: {
      upsert: jest.fn(async ({ create }: any) => ({
        id: 'u-mem', email: create.email, displayName: create.displayName ?? null,
        zimbraHost: create.zimbraHost, provider: create.provider, authToken: create.authToken,
        csrfToken: create.csrfToken ?? null,
      })),
      update: jest.fn(), findUnique: jest.fn(),
    },
    session: { create: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  } as unknown as PrismaService;
  const jwt = { sign: jest.fn(() => 'signed.jwt.token'), verify: jest.fn() } as unknown as JwtService;
  const audit = { record: jest.fn() } as unknown as AuditService;
  const institutionRegistry = {
    list: jest.fn(),
    resolve: jest.fn(async (id: string) => (id === 'memory' ? MEMORY_ROW : null)),
    resolveByHost: jest.fn(async () => null),
  } as unknown as InstitutionRegistry;

  const service = new AuthService(prisma, resolver, jwt, audit, institutionRegistry);
  return { service, resolver, store, memoryProvider, prisma: prisma as any, zimbra: zimbra as any };
}

describe('memory provider login integration', () => {
  afterEach(() => {
    delete process.env.MAIL_PROVIDER_MEMORY;
  });

  it('logs in a memory institution and drives folders→messages→send through the resolver', async () => {
    process.env.MAIL_PROVIDER_MEMORY = 'true';
    const { service, resolver, prisma, zimbra } = makeHarness();

    const res = await service.login({
      institution: 'memory', email: 'demo@memory.local', password: 'x',
    } as any);

    // Login succeeded against the fake — never touched Zimbra — and stamped the
    // memory provider onto the upserted user.
    expect(res).toHaveProperty('accessToken', 'signed.jwt.token');
    expect(zimbra.authenticate).not.toHaveBeenCalled();
    expect(prisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ provider: 'memory', institutionId: 'memory' }),
      update: expect.objectContaining({ provider: 'memory', institutionId: 'memory' }),
    }));

    // Now walk the same seam a request does: resolve the provider off the user's
    // stamped column and exercise the interface end-to-end (no real mail server).
    const user = await (prisma.user.upsert as jest.Mock).mock.results[0].value;
    expect(user.provider).toBe('memory');

    const provider = resolver.forUser({ provider: 'memory' } as any);
    const session: MailSession = { host: 'memory.local', email: 'demo@memory.local', authToken: user.authToken };

    const folders = await provider.getFolders(session);
    expect(folders.length).toBeGreaterThan(0);
    const inbox = folders.find((f) => f.type === 'inbox');
    expect(inbox).toBeDefined();

    const page = await provider.getMessages(session, inbox!.id);
    expect(page.total).toBeGreaterThan(0);
    expect(Array.isArray(page.messages)).toBe(true);

    const sent = await provider.sendMessage(session, {
      to: ['someone@memory.local'], cc: [], bcc: [], subject: 'Hi from memory', body: '<p>body</p>',
    } as any);
    expect(sent.id).toMatch(/^msg-memory-/);

    const sentFolder = folders.find((f) => f.type === 'sent');
    const sentPage = await provider.getMessages(session, sentFolder!.id);
    expect(sentPage.messages.some((m) => m.subject === 'Hi from memory')).toBe(true);
  });

  it('refuses the memory login when MAIL_PROVIDER_MEMORY is off', async () => {
    delete process.env.MAIL_PROVIDER_MEMORY;
    const { service, zimbra } = makeHarness();

    await expect(service.login({
      institution: 'memory', email: 'demo@memory.local', password: 'x',
    } as any)).rejects.toThrow(BadRequestException);
    await expect(service.login({
      institution: 'memory', email: 'demo@memory.local', password: 'x',
    } as any)).rejects.toThrow(/not supported on this server/i);
    expect(zimbra.authenticate).not.toHaveBeenCalled();
  });
});
