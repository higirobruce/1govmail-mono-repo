import { BadRequestException } from '@nestjs/common';
import { MailProviderResolver } from './mail-provider.resolver';
import { ZimbraService } from '../zimbra/zimbra.service';
import { MemoryMailProvider } from './memory/memory-mail.provider';
import { MemoryStore } from './memory/memory-store';
import { EwsService } from '../ews/ews.service';

describe('MailProviderResolver', () => {
  const zimbraService = new ZimbraService();
  const memoryProvider = new MemoryMailProvider(new MemoryStore());
  // A light stand-in for EwsService — the resolver only returns it by
  // reference, so no MAIL_CRED_KEY / transport is needed here. `evictSession`
  // lets the logout-eviction path (below) assert delegation.
  const ewsService = { name: 'ews', evictSession: jest.fn() } as unknown as EwsService;
  const resolver = new MailProviderResolver(zimbraService, memoryProvider, ewsService);

  // The env gate leaks across tests otherwise: each memory case sets it
  // explicitly and this clears it so a stray 'true' can't turn a later
  // "memory off" assertion green by accident.
  afterEach(() => {
    delete process.env.MAIL_PROVIDER_MEMORY;
  });

  it('returns ZimbraService for zimbra users and throws a clear error otherwise', () => {
    expect(resolver.forUser({ provider: 'zimbra' } as any)).toBe(zimbraService);
    // ews is a real registered provider now (Phase 3) — no env gate.
    expect(resolver.forUser({ provider: 'ews' } as any)).toBe(ewsService);
    expect(() => resolver.forUser({ provider: 'memory' } as any)).toThrow(); // env gate off
  });

  it('returns MemoryMailProvider for memory users only when MAIL_PROVIDER_MEMORY=true', () => {
    process.env.MAIL_PROVIDER_MEMORY = 'true';
    expect(resolver.forUser({ provider: 'memory' } as any)).toBe(memoryProvider);
    delete process.env.MAIL_PROVIDER_MEMORY;
    expect(() => resolver.forUser({ provider: 'memory' } as any)).toThrow(/not supported on this server/i);
  });

  it('returns the EwsService for ews users unconditionally (Institution table is the gate)', () => {
    expect(resolver.forUser({ provider: 'zimbra' } as any)).toBe(zimbraService);
    expect(resolver.forUser({ provider: 'ews' } as any)).toBe(ewsService);
  });

  it('refuses memory (gate off) and an unregistered provider identically', () => {
    // memory has a case but is gated; a truly-unknown provider has no case at
    // all. With the flag off both must surface the identical
    // BadRequestException, never a 500.
    expect(() => resolver.forUser({ provider: 'memory' } as any)).toThrow(BadRequestException);
    expect(() => resolver.forUser({ provider: 'imap' } as any)).toThrow(BadRequestException);
  });

  it('reports an unsupported provider as a 400, not a 500', () => {
    // The resolver IS the login gate now (Task 3's temporary
    // `inst.provider !== 'zimbra'` throw was removed in favour of it), so an
    // institution whose provider has not landed yet must still surface as a
    // client error with a readable message — never an internal error.
    expect(() => resolver.forUser({ provider: 'imap' } as any)).toThrow(BadRequestException);
    try {
      resolver.forUser({ provider: 'imap' } as any);
    } catch (err) {
      expect((err as Error).message).toContain('imap');
    }
  });

  it('evictSession delegates to the EwsService for ews users and is a no-op otherwise', () => {
    (ewsService.evictSession as jest.Mock).mockClear();
    resolver.evictSession({ provider: 'ews' } as any, 'user@minaffet.gov.rw');
    expect(ewsService.evictSession).toHaveBeenCalledWith('user@minaffet.gov.rw');

    (ewsService.evictSession as jest.Mock).mockClear();
    resolver.evictSession({ provider: 'zimbra' } as any, 'user@risa.gov.rw');
    expect(ewsService.evictSession).not.toHaveBeenCalled();
  });

  it('hands the Zimbra service itself to the two sanctioned Zimbra-only extras', () => {
    // downloadZimbraPath (signature/Briefcase image inlining) and
    // galSelfLookup (AI-profile suggestions) are off the MailProvider
    // interface; their call sites reach them here after checking
    // user.provider === 'zimbra' themselves.
    expect(resolver.zimbra()).toBe(zimbraService);
    expect(typeof resolver.zimbra().downloadZimbraPath).toBe('function');
    expect(typeof resolver.zimbra().galSelfLookup).toBe('function');
  });
});
