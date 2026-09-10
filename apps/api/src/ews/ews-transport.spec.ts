import { readFileSync } from 'fs';
import { join } from 'path';
import { BadGatewayException, UnauthorizedException } from '@nestjs/common';
import { EwsTransport, handleEwsError, NtlmPostOptions, NtlmResponse } from './ews-transport';
import { MailSession } from '../provider/mail-session';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name), 'utf8');

const SUCCESS = fixture('getfolder-inbox.success.xml');
const FAULT = fixture('soapfault.xml');
const BUSY = fixture('error-servertoobusy.xml');

/** A stub httpntlm poster: records the options it was called with and replies
 *  with a scripted response (or an error). */
function stubPoster(reply: Partial<NtlmResponse> | { error: any }) {
  const calls: NtlmPostOptions[] = [];
  const post = (opts: NtlmPostOptions, cb: (err: any, res?: NtlmResponse) => void) => {
    calls.push(opts);
    if ('error' in reply) return cb(reply.error);
    cb(null, { statusCode: 200, body: SUCCESS, headers: {}, ...reply } as NtlmResponse);
  };
  return { post, calls };
}

const session = (over: Partial<MailSession> = {}): MailSession => ({
  host: 'mail.gov.rw',
  email: 'test-risa1@minaffet.gov.rw',
  credentials: { username: 'MINAFFET\\test-risa1', password: 'fake-pw-123' },
  ...over,
});

describe('handleEwsError', () => {
  it('maps HTTP 401 to UnauthorizedException', () => {
    expect(() => handleEwsError(401)).toThrow(UnauthorizedException);
    try {
      handleEwsError(401);
    } catch (e: any) {
      expect(e.message).toMatch(/no longer valid/i);
    }
  });

  it('maps a SOAP fault to BadGatewayException carrying the ResponseCode', () => {
    expect(() => handleEwsError(500, FAULT)).toThrow(BadGatewayException);
    try {
      handleEwsError(500, FAULT);
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadGatewayException);
      expect(e.message).toContain('ErrorSchemaValidation');
    }
  });

  it('maps a ResponseClass="Error" message to BadGatewayException with code + text', () => {
    try {
      handleEwsError(200, BUSY);
      fail('expected throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadGatewayException);
      expect(e.message).toContain('ErrorServerBusy');
    }
  });

  it('maps a network error to BadGatewayException', () => {
    expect(() => handleEwsError(0, undefined, new Error('ECONNREFUSED'))).toThrow(
      BadGatewayException,
    );
  });

  it('does not leak credentials into the thrown message', () => {
    try {
      handleEwsError(0, undefined, new Error('connect failed for user secret-pw-xyz'));
    } catch (e: any) {
      // network detail is summarised, not echoed verbatim with secrets
      expect(e.message).not.toContain('secret-pw-xyz');
    }
  });
});

describe('EwsTransport.call', () => {
  it('resolves the endpoint from a bare host', async () => {
    const { post, calls } = stubPoster({});
    const t = new EwsTransport(post);
    await t.call(session(), '<body/>');
    expect(calls[0].url).toBe('https://mail.gov.rw/EWS/Exchange.asmx');
  });

  it('accepts a full https URL host', async () => {
    const { post, calls } = stubPoster({});
    const t = new EwsTransport(post);
    await t.call(session({ host: 'https://mail.gov.rw' }), '<body/>');
    expect(calls[0].url).toBe('https://mail.gov.rw/EWS/Exchange.asmx');
  });

  it('splits DOMAIN\\user into separate domain + username for httpntlm', async () => {
    const { post, calls } = stubPoster({});
    const t = new EwsTransport(post);
    await t.call(session(), '<body/>');
    expect(calls[0].domain).toBe('MINAFFET');
    expect(calls[0].username).toBe('test-risa1');
    expect(calls[0].password).toBe('fake-pw-123');
  });

  it('passes a bare username through with an empty domain', async () => {
    const { post, calls } = stubPoster({});
    const t = new EwsTransport(post);
    await t.call(
      session({ credentials: { username: 'plainuser', password: 'fake-pw-123' } }),
      '<body/>',
    );
    expect(calls[0].domain).toBe('');
    expect(calls[0].username).toBe('plainuser');
  });

  it('sends the SOAP content-type header and the body', async () => {
    const { post, calls } = stubPoster({});
    const t = new EwsTransport(post);
    await t.call(session(), '<soap>hi</soap>');
    expect(calls[0].headers['Content-Type']).toMatch(/text\/xml/);
    expect(calls[0].body).toBe('<soap>hi</soap>');
  });

  it('returns the raw XML body on HTTP 200', async () => {
    const { post } = stubPoster({ statusCode: 200, body: SUCCESS });
    const t = new EwsTransport(post);
    await expect(t.call(session(), '<body/>')).resolves.toBe(SUCCESS);
  });

  it('throws UnauthorizedException on HTTP 401', async () => {
    const { post } = stubPoster({ statusCode: 401, body: '' });
    const t = new EwsTransport(post);
    await expect(t.call(session(), '<body/>')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws BadGatewayException on a 500 SOAP fault', async () => {
    const { post } = stubPoster({ statusCode: 500, body: FAULT });
    const t = new EwsTransport(post);
    await expect(t.call(session(), '<body/>')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('throws BadGatewayException on a transport/network error', async () => {
    const { post } = stubPoster({ error: new Error('ETIMEDOUT') });
    const t = new EwsTransport(post);
    await expect(t.call(session(), '<body/>')).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('reuses one keep-alive agent per session email', async () => {
    const { post, calls } = stubPoster({});
    const t = new EwsTransport(post);
    await t.call(session(), '<body/>');
    await t.call(session(), '<body/>');
    expect(calls[0].agent).toBeDefined();
    expect(calls[0].agent).toBe(calls[1].agent);
  });

  it('uses distinct agents for distinct session emails', async () => {
    const { post, calls } = stubPoster({});
    const t = new EwsTransport(post);
    await t.call(session(), '<body/>');
    await t.call(session({ email: 'other@minaffet.gov.rw' }), '<body/>');
    expect(calls[0].agent).not.toBe(calls[1].agent);
  });

  it('throws when the session has no credentials', async () => {
    const { post } = stubPoster({});
    const t = new EwsTransport(post);
    await expect(
      t.call(session({ credentials: undefined }), '<body/>'),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
