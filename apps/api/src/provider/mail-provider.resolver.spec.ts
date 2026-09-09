import { BadRequestException } from '@nestjs/common';
import { MailProviderResolver } from './mail-provider.resolver';
import { ZimbraService } from '../zimbra/zimbra.service';

describe('MailProviderResolver', () => {
  const zimbraService = new ZimbraService();
  const resolver = new MailProviderResolver(zimbraService);

  it('returns ZimbraService for zimbra users and throws a clear error otherwise', () => {
    expect(resolver.forUser({ provider: 'zimbra' } as any)).toBe(zimbraService);
    expect(() => resolver.forUser({ provider: 'ews' } as any))
      .toThrow(/not supported on this server/i); // until Phase 3 registers it
    expect(() => resolver.forUser({ provider: 'memory' } as any)).toThrow();
  });

  it('reports the unsupported provider as a 400, not a 500', () => {
    // The resolver IS the login gate now (Task 3's temporary
    // `inst.provider !== 'zimbra'` throw was removed in favour of it), so an
    // institution whose provider has not landed yet must still surface as a
    // client error with a readable message — never an internal error.
    expect(() => resolver.forUser({ provider: 'ews' } as any)).toThrow(BadRequestException);
    try {
      resolver.forUser({ provider: 'ews' } as any);
    } catch (err) {
      expect((err as Error).message).toContain('ews');
    }
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
