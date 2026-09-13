import { readFileSync } from 'fs';
import * as https from 'https';
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

/** A stub httpntlm poster that replies with a *scripted sequence* of
 *  responses — one per call — so a 401-then-200 recovery can be driven. */
function stubSequence(replies: Array<Partial<NtlmResponse> | { error: any }>) {
  const calls: NtlmPostOptions[] = [];
  const post = (opts: NtlmPostOptions, cb: (err: any, res?: NtlmResponse) => void) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)];
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

  it('recovers a stale-keep-alive 401 by re-handshaking on a fresh agent, then retrying once', async () => {
    const { post, calls } = stubSequence([
      { statusCode: 401, body: '' },
      { statusCode: 200, body: SUCCESS },
    ]);
    const t = new EwsTransport(post);
    await expect(t.call(session(), '<body/>')).resolves.toBe(SUCCESS);
    // Exactly one re-handshake: two POSTs, no more.
    expect(calls).toHaveLength(2);
    // The stale agent was evicted — the retry used a *different* Agent instance.
    expect(calls[0].agent).toBeDefined();
    expect(calls[1].agent).toBeDefined();
    expect(calls[1].agent).not.toBe(calls[0].agent);
  });

  it('does not loop: a 401 on BOTH attempts throws Unauthorized after exactly two POSTs', async () => {
    const { post, calls } = stubSequence([
      { statusCode: 401, body: '' },
      { statusCode: 401, body: '' },
    ]);
    const t = new EwsTransport(post);
    await expect(t.call(session(), '<body/>')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(calls).toHaveLength(2);
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

  it('gives each isolated call its OWN single-socket agent, and disposes it', async () => {
    // NTLM authenticates the CONNECTION, not the request: concurrent calls that
    // share a pooled agent interleave their type-1/2/3 legs across sockets and
    // Exchange answers 401. A fan-out therefore asks for an isolated connection
    // — its own agent, capped at one socket so all three legs ride it.
    const destroy = jest.spyOn(https.Agent.prototype, 'destroy');
    const { post, calls } = stubPoster({});
    const t = new EwsTransport(post);

    await t.call(session(), '<body/>', { isolatedConnection: true });
    await t.call(session(), '<body/>', { isolatedConnection: true });

    expect(calls[0].agent).not.toBe(calls[1].agent); // never shared between calls
    expect((calls[0].agent as any).maxSockets).toBe(1); // all NTLM legs on one socket
    expect(destroy).toHaveBeenCalledTimes(2); // each private agent disposed
    destroy.mockRestore();
  });

  it('keeps the isolated agent out of the shared per-session pool', async () => {
    const { post, calls } = stubPoster({});
    const t = new EwsTransport(post);
    await t.call(session(), '<body/>');                                  // shared
    await t.call(session(), '<body/>', { isolatedConnection: true });     // isolated
    await t.call(session(), '<body/>');                                  // shared again
    expect(calls[2].agent).toBe(calls[0].agent);      // pool survived untouched
    expect(calls[1].agent).not.toBe(calls[0].agent);
  });

  it('renews the session agent on a 401 WITHOUT destroying it', async () => {
    // Destroying the shared agent resets every socket in its pool — which
    // killed sibling requests mid-flight with ECONNRESET (observed live during
    // a mailbox-wide search). Drop it from the pool instead and let it die idle.
    const destroy = jest.spyOn(https.Agent.prototype, 'destroy');
    const { post, calls } = stubSequence([
      { statusCode: 401, body: '' },
      { statusCode: 200, body: SUCCESS },
    ]);
    const t = new EwsTransport(post);

    await expect(t.call(session(), '<body/>')).resolves.toBe(SUCCESS);
    expect(calls[1].agent).not.toBe(calls[0].agent); // fresh connection for the retry
    expect(destroy).not.toHaveBeenCalled();          // but the old pool is NOT reset
    destroy.mockRestore();
  });

  it('still destroys the agent on evict (logout)', async () => {
    const destroy = jest.spyOn(https.Agent.prototype, 'destroy');
    const { post } = stubPoster({});
    const t = new EwsTransport(post);
    await t.call(session(), '<body/>');
    t.evict(session().email);
    expect(destroy).toHaveBeenCalledTimes(1);
    destroy.mockRestore();
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
