import { buildMailSession } from './mail-session';

describe('buildMailSession', () => {
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
