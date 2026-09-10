import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { MailProviderResolver } from './mail-provider.resolver';
import { EwsService } from '../ews/ews.service';

/**
 * The injection swap's guard rail. Every feature service now takes
 * MailProviderResolver instead of a provider implementation, which is a
 * DI-graph change no unit test can see: each of the seven feature modules had
 * to swap `ZimbraModule` for `ProviderModule`. Compiling the real AppModule
 * fails loudly ("Nest can't resolve dependencies of the …Service") if one of
 * them is missed — verified by removing the import and watching this fail.
 *
 * `compile()` only builds the injector: no lifecycle hooks run, so nothing
 * here touches Postgres, Zimbra or the network.
 */
describe('ProviderModule wiring', () => {
  const ORIGINAL_KEY = process.env.MAIL_CRED_KEY;
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.MAIL_CRED_KEY;
    else process.env.MAIL_CRED_KEY = ORIGINAL_KEY;
  });

  it('resolves MailProviderResolver for every feature module in AppModule', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(MailProviderResolver, { strict: false })).toBeInstanceOf(
      MailProviderResolver,
    );
  });

  // FIX 1: MAIL_CRED_KEY is NOT a whole-app boot requirement. A Zimbra-only
  // deployment (no ews institution, no key) must boot cleanly — the EwsModule
  // factory yields `null` instead of constructing EwsService — and an ews login
  // on such a build gets the standard "not supported" 400, never a null-deref.
  describe('without MAIL_CRED_KEY (Zimbra-only deployment)', () => {
    beforeEach(() => {
      delete process.env.MAIL_CRED_KEY;
    });

    it('AppModule still compiles (the key is not a boot requirement)', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      // The EwsService token is provided but yields null (no key → no instance).
      expect(moduleRef.get(EwsService, { strict: false })).toBeNull();
    });

    it('an ews user then gets the clean 400, not a null-deref crash', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const resolver = moduleRef.get(MailProviderResolver, { strict: false });
      expect(() => resolver.forUser({ provider: 'ews' } as any)).toThrow(BadRequestException);
      expect(() => resolver.forUser({ provider: 'ews' } as any)).toThrow(
        /not supported on this server/i,
      );
    });
  });

  describe('with MAIL_CRED_KEY (an ews institution is configured)', () => {
    beforeEach(() => {
      // A throwaway key for the compile (the real value is an ops secret; see
      // .env.example / ARCHITECTURE §8).
      process.env.MAIL_CRED_KEY = 'test-mail-cred-key-provider-module-spec';
    });

    it('registers the EWS provider so an ews user resolves to the EwsService', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

      const resolver = moduleRef.get(MailProviderResolver, { strict: false });
      const ews = moduleRef.get(EwsService, { strict: false });
      expect(ews).toBeInstanceOf(EwsService);
      expect(resolver.forUser({ provider: 'ews' } as any)).toBe(ews);
    });
  });
});
