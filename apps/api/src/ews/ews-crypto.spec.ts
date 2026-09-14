import { EwsCrypto } from './ews-crypto';

describe('EwsCrypto', () => {
  const ORIGINAL_ENV = process.env.MAIL_CRED_KEY;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.MAIL_CRED_KEY;
    else process.env.MAIL_CRED_KEY = ORIGINAL_ENV;
  });

  const c = new EwsCrypto('a'.repeat(48));

  it('round-trips', () => {
    const b = c.encrypt('MINAFFET\\test-risa1|pw');
    expect(c.decrypt(b)).toBe('MINAFFET\\test-risa1|pw');
  });

  it('uses a random IV (distinct ciphertexts)', () => {
    expect(c.encrypt('x')).not.toBe(c.encrypt('x'));
  });

  it('rejects a tampered blob', () => {
    const b = c.encrypt('x');
    const bad = b.slice(0, -2) + (b.endsWith('a') ? 'b' : 'a');
    expect(() => c.decrypt(bad)).toThrow();
  });

  it('refuses to construct without a key', () => {
    delete process.env.MAIL_CRED_KEY;
    expect(() => new EwsCrypto()).toThrow(/MAIL_CRED_KEY/);
    expect(() => new EwsCrypto('')).toThrow(/MAIL_CRED_KEY/);
  });

  it('falls back to process.env.MAIL_CRED_KEY when no rawKey is given', () => {
    process.env.MAIL_CRED_KEY = 'b'.repeat(48);
    const fromEnv = new EwsCrypto();
    const blob = fromEnv.encrypt('via-env');
    expect(fromEnv.decrypt(blob)).toBe('via-env');
  });

  it('derives the key deterministically for the same rawKey', () => {
    const c1 = new EwsCrypto('same-secret-key-material-0123456789');
    const c2 = new EwsCrypto('same-secret-key-material-0123456789');
    const blob = c1.encrypt('deterministic');
    expect(c2.decrypt(blob)).toBe('deterministic');
  });

  it('fails to decrypt with a different key', () => {
    const other = new EwsCrypto('z'.repeat(48));
    const blob = c.encrypt('secret');
    expect(() => other.decrypt(blob)).toThrow();
  });

  it('never falls back to JWT_SECRET', () => {
    delete process.env.MAIL_CRED_KEY;
    const savedJwt = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'some-jwt-secret-that-must-not-be-used';
    try {
      expect(() => new EwsCrypto()).toThrow(/MAIL_CRED_KEY/);
    } finally {
      if (savedJwt === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = savedJwt;
    }
  });
});
