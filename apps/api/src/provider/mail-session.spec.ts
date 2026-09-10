import { UnauthorizedException } from '@nestjs/common';
import { buildMailSession } from './mail-session';
import { EwsCrypto } from '../ews/ews-crypto';

describe('buildMailSession', () => {
  const ORIGINAL_MAIL_CRED_KEY = process.env.MAIL_CRED_KEY;

  afterEach(() => {
    if (ORIGINAL_MAIL_CRED_KEY === undefined) delete process.env.MAIL_CRED_KEY;
    else process.env.MAIL_CRED_KEY = ORIGINAL_MAIL_CRED_KEY;
  });

  describe('ews provider', () => {
    it('decrypts authToken into credentials, and leaves authToken/csrfToken unset', () => {
      process.env.MAIL_CRED_KEY = 'a'.repeat(48);
      const crypto = new EwsCrypto();
      const blob = crypto.encrypt(
        JSON.stringify({ username: 'MINAFFET\\jdoe', password: 'hunter2' }),
      );

      const user = {
        zimbraHost: 'mail.example.gov.rw',
        email: 'jdoe@example.gov.rw',
        authToken: blob,
        csrfToken: null,
        provider: 'ews',
      };

      const session = buildMailSession(user);

      expect(session).toEqual({
        host: 'mail.example.gov.rw',
        email: 'jdoe@example.gov.rw',
        credentials: { username: 'MINAFFET\\jdoe', password: 'hunter2' },
      });
      expect(session.authToken).toBeUndefined();
      expect(session.csrfToken).toBeUndefined();
    });

    it('throws a clear UnauthorizedException when an ews user has no authToken', () => {
      process.env.MAIL_CRED_KEY = 'a'.repeat(48);
      const user = {
        zimbraHost: 'mail.example.gov.rw',
        email: 'jdoe@example.gov.rw',
        authToken: null,
        csrfToken: null,
        provider: 'ews',
      };
      // A null/empty credential blob must NOT reach EwsCrypto.decrypt (a cryptic
      // error); it means the session is gone → surface a clean re-login prompt.
      expect(() => buildMailSession(user)).toThrow(UnauthorizedException);
      expect(() => buildMailSession(user)).toThrow(/log in again/i);
    });

    it('surfaces the clear EwsCrypto error when MAIL_CRED_KEY is missing', () => {
      delete process.env.MAIL_CRED_KEY;
      // The module-level EwsCrypto singleton is memoized on first use, so a
      // prior test in this file constructing one (with a key present) would
      // otherwise mask this case. Reset the module registry so this test
      // gets its own, not-yet-constructed singleton.
      jest.resetModules();
      const fresh = require('./mail-session') as typeof import('./mail-session');
      const user = {
        zimbraHost: 'mail.example.gov.rw',
        email: 'jdoe@example.gov.rw',
        authToken: 'irrelevant-blob',
        csrfToken: null,
        provider: 'ews',
      };

      expect(() => fresh.buildMailSession(user)).toThrow(/MAIL_CRED_KEY/);
    });
  });

  describe('non-ews providers (byte-identical to today)', () => {
    it('should build a mail session from a user row with all fields present', () => {
      const user = {
        zimbraHost: 'mail.example.com',
        email: 'user@example.com',
        authToken: 'token123',
        csrfToken: 'csrf456',
        provider: 'zimbra',
      };

      const session = buildMailSession(user);

      expect(session).toEqual({
        host: 'mail.example.com',
        email: 'user@example.com',
        authToken: 'token123',
        csrfToken: 'csrf456',
      });
    });

    it('should convert null authToken to undefined', () => {
      const user = {
        zimbraHost: 'mail.example.com',
        email: 'user@example.com',
        authToken: null,
        csrfToken: 'csrf456',
        provider: 'zimbra',
      };

      const session = buildMailSession(user);

      expect(session.authToken).toBeUndefined();
      expect(session.csrfToken).toBe('csrf456');
    });

    it('should convert null csrfToken to undefined', () => {
      const user = {
        zimbraHost: 'mail.example.com',
        email: 'user@example.com',
        authToken: 'token123',
        csrfToken: null,
        provider: 'zimbra',
      };

      const session = buildMailSession(user);

      expect(session.authToken).toBe('token123');
      expect(session.csrfToken).toBeUndefined();
    });

    it('should convert both null tokens to undefined', () => {
      const user = {
        zimbraHost: 'mail.example.com',
        email: 'user@example.com',
        authToken: null,
        csrfToken: null,
        provider: 'zimbra',
      };

      const session = buildMailSession(user);

      expect(session.authToken).toBeUndefined();
      expect(session.csrfToken).toBeUndefined();
    });
  });
});
