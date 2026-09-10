import { readFileSync } from 'fs';
import { join } from 'path';
import { BadGatewayException, UnauthorizedException } from '@nestjs/common';
import { EwsService } from './ews.service';
import { handleEwsError } from './ews-transport';
import { EwsCrypto } from './ews-crypto';
import { CapabilityNotSupportedError } from '../provider/capability.error';
import { MailSession } from '../provider/mail-session';

const KEY = 'test-mail-cred-key-0123456789abcdef';
const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

const SUCCESS = fixture('getfolder-inbox.success.xml');
const FAULT = fixture('soapfault.xml');
const BUSY = fixture('error-servertoobusy.xml');
const RESOLVE = fixture('resolvenames.success.xml');

/** A fake transport substitutable for EwsTransport. Each element of `script`
 *  answers one `call`, in order; a string resolves to that XML, `'HTTP401'`
 *  throws exactly as the real transport does for a 401, `'FAULT'` throws a
 *  BadGateway from a 500 fault. When the script runs dry the last entry is
 *  repeated so a ResolveNames follow-up call always has something to return. */
class FakeTransport {
  public calls: Array<{ session: MailSession; body: string }> = [];
  constructor(private script: string[]) {}
  async call(session: MailSession, body: string): Promise<string> {
    this.calls.push({ session, body });
    const idx = Math.min(this.calls.length - 1, this.script.length - 1);
    const step = this.script[idx];
    if (step === 'HTTP401') handleEwsError(401);
    if (step === 'FAULT') handleEwsError(500, FAULT);
    return step;
  }
}

const withKey = () => {
  process.env.MAIL_CRED_KEY = KEY;
};

describe('EwsService', () => {
  const ORIGINAL = process.env.MAIL_CRED_KEY;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MAIL_CRED_KEY;
    else process.env.MAIL_CRED_KEY = ORIGINAL;
  });

  describe('constructor', () => {
    it('throws when MAIL_CRED_KEY is absent', () => {
      delete process.env.MAIL_CRED_KEY;
      expect(() => new EwsService()).toThrow(/MAIL_CRED_KEY/);
    });

    it('constructs when MAIL_CRED_KEY is present', () => {
      withKey();
      expect(() => new EwsService()).not.toThrow();
    });
  });

  describe('metadata', () => {
    beforeEach(withKey);
    it('names itself ews with all settings capabilities off', () => {
      const s = new EwsService();
      expect(s.name).toBe('ews');
      expect(s.capabilities).toEqual({
        signatures: false,
        identities: false,
        serverPrefs: false,
        changePassword: false,
        twoFactor: false,
      });
    });
  });

  describe('authenticate', () => {
    beforeEach(withKey);

    it('returns an authToken that decrypts to {username: DOMAIN\\user, password}', async () => {
      const t = new FakeTransport([SUCCESS, RESOLVE]);
      const svc = new EwsService(t as any);
      const res = await svc.authenticate('mail.gov.rw', 'test-risa1@minaffet.gov.rw', 'fake-pw-123', {
        ntlmDomain: 'MINAFFET',
      });

      expect(res.twoFactorRequired).toBe(false);
      expect(res.lifetime).toBeGreaterThan(0);
      const decrypted = JSON.parse(new EwsCrypto(KEY).decrypt(res.authToken));
      expect(decrypted).toEqual({ username: 'MINAFFET\\test-risa1', password: 'fake-pw-123' });
    });

    it('runs the GetFolder(inbox) probe body', async () => {
      const t = new FakeTransport([SUCCESS, RESOLVE]);
      const svc = new EwsService(t as any);
      await svc.authenticate('mail.gov.rw', 'test-risa1@minaffet.gov.rw', 'fake-pw-123', {
        ntlmDomain: 'MINAFFET',
      });
      expect(t.calls[0].body).toContain('GetFolder');
      expect(t.calls[0].body).toContain('inbox');
    });

    it('resolves the display name best-effort from ResolveNames', async () => {
      const t = new FakeTransport([SUCCESS, RESOLVE]);
      const svc = new EwsService(t as any);
      const res = await svc.authenticate('mail.gov.rw', 'test-risa1@minaffet.gov.rw', 'fake-pw-123', {
        ntlmDomain: 'MINAFFET',
      });
      expect(res.displayName).toBe('Test Risa');
    });

    it('falls back to the email when ResolveNames yields nothing (never fails auth over it)', async () => {
      // second call returns a fault; displayName resolution must swallow it
      const t = new FakeTransport([SUCCESS, 'FAULT']);
      const svc = new EwsService(t as any);
      const res = await svc.authenticate('mail.gov.rw', 'test-risa1@minaffet.gov.rw', 'fake-pw-123', {
        ntlmDomain: 'MINAFFET',
      });
      expect(res.displayName).toBe('test-risa1@minaffet.gov.rw');
    });

    it('throws UnauthorizedException on a probe 401', async () => {
      const t = new FakeTransport(['HTTP401']);
      const svc = new EwsService(t as any);
      await expect(
        svc.authenticate('mail.gov.rw', 'test-risa1@minaffet.gov.rw', 'fake-pw-123', {
          ntlmDomain: 'MINAFFET',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('throws BadGatewayException carrying the code on a SOAP fault', async () => {
      const t = new FakeTransport(['FAULT']);
      const svc = new EwsService(t as any);
      await expect(
        svc.authenticate('mail.gov.rw', 'test-risa1@minaffet.gov.rw', 'fake-pw-123', {
          ntlmDomain: 'MINAFFET',
        }),
      ).rejects.toThrow(/ErrorSchemaValidation/);
    });

    it('retries exactly once on ErrorServerBusy, then succeeds', async () => {
      // probe: busy → retry succeeds; then ResolveNames
      const t = new FakeTransport([BUSY, SUCCESS, RESOLVE]);
      const svc = new EwsService(t as any);
      const res = await svc.authenticate('mail.gov.rw', 'test-risa1@minaffet.gov.rw', 'fake-pw-123', {
        ntlmDomain: 'MINAFFET',
      });
      // two probe calls (busy, then success) before the ResolveNames call
      expect(t.calls[0].body).toContain('GetFolder');
      expect(t.calls[1].body).toContain('GetFolder');
      expect(res.twoFactorRequired).toBe(false);
    });

    it('gives up after a single retry when still busy (ErrorServerBusy twice)', async () => {
      const t = new FakeTransport([BUSY, BUSY]);
      const svc = new EwsService(t as any);
      await expect(
        svc.authenticate('mail.gov.rw', 'test-risa1@minaffet.gov.rw', 'fake-pw-123', {
          ntlmDomain: 'MINAFFET',
        }),
      ).rejects.toBeInstanceOf(BadGatewayException);
      // exactly two GetFolder attempts, not three
      expect(t.calls.filter((c) => c.body.includes('GetFolder')).length).toBe(2);
    });

    describe('NTLM username derivation', () => {
      it('prepends ntlmDomain to the email localpart for a bare email', async () => {
        const t = new FakeTransport([SUCCESS, RESOLVE]);
        const svc = new EwsService(t as any);
        const res = await svc.authenticate('h', 'test-risa1@minaffet.gov.rw', 'fake-pw-123', {
          ntlmDomain: 'MINAFFET',
        });
        const { username } = JSON.parse(new EwsCrypto(KEY).decrypt(res.authToken));
        expect(username).toBe('MINAFFET\\test-risa1');
      });

      it('passes a user-typed DOMAIN\\user through unchanged', async () => {
        const t = new FakeTransport([SUCCESS, RESOLVE]);
        const svc = new EwsService(t as any);
        const res = await svc.authenticate('h', 'CORP\\alice', 'fake-pw-123', {});
        const { username } = JSON.parse(new EwsCrypto(KEY).decrypt(res.authToken));
        expect(username).toBe('CORP\\alice');
      });

      it('uses the email as-is when no ntlmDomain is given and it is not DOMAIN\\user', async () => {
        const t = new FakeTransport([SUCCESS, RESOLVE]);
        const svc = new EwsService(t as any);
        const res = await svc.authenticate('h', 'test-risa1@minaffet.gov.rw', 'fake-pw-123');
        const { username } = JSON.parse(new EwsCrypto(KEY).decrypt(res.authToken));
        expect(username).toBe('test-risa1@minaffet.gov.rw');
      });
    });
  });

  describe('verifyTwoFactor', () => {
    beforeEach(withKey);
    it('throws CapabilityNotSupportedError (EWS never challenges)', async () => {
      const svc = new EwsService(new FakeTransport([SUCCESS]) as any);
      await expect(
        svc.verifyTwoFactor('h', 'e', 'pre', 'code'),
      ).rejects.toBeInstanceOf(CapabilityNotSupportedError);
    });
  });

  describe('unimplemented provider methods', () => {
    beforeEach(withKey);
    it('throw a not-implemented error until Tasks 4-7 fill them', () => {
      const svc = new EwsService(new FakeTransport([SUCCESS]) as any);
      const s = {} as MailSession;
      expect(() => svc.getFolders(s)).toThrow(/not implemented/);
      expect(() => svc.getMessages(s, 'f')).toThrow(/not implemented/);
      expect(() => svc.getContacts(s)).toThrow(/not implemented/);
      expect(() => svc.getCalendarEvents(s, 0, 1)).toThrow(/not implemented/);
    });
  });
});
