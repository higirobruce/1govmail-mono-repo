import { readFileSync } from 'fs';
import * as https from 'https';
import {
  BadGatewayException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { MailSession } from '../provider/mail-session';
import { parseEws } from './ews-parse';

/**
 * NTLM-authenticated HTTP transport for Exchange Web Services.
 *
 * SECURITY: Exchange fronts EWS with Windows Integrated Auth (NTLM). We never
 * hold a bearer token — every request re-presents the mailbox
 * `{ username, password }` decrypted from the DB into `session.credentials`.
 * Two consequences drive this file's design:
 *   1. Credentials must never reach a log line. Only the endpoint + HTTP status
 *      are ever logged; the request body, the Authorization header (NTLM
 *      type-1/type-3 tokens) and the password are never logged, and
 *      `handleEwsError` summarises network errors rather than echoing them.
 *   2. TLS is verified, always. `rejectUnauthorized` is left at its secure
 *      default; `MAIL_CA_BUNDLE` may add a private CA but can never disable
 *      verification. (Zimbra's transport disables it for the lab; EWS does not.)
 */

/** The subset of httpntlm's option bag we use. `username` is the *bare* user
 *  and `domain` is separate — httpntlm does not accept `DOMAIN\user` in one
 *  field, so `EwsTransport.call` splits the composite before it gets here. */
export interface NtlmPostOptions {
  url: string;
  username: string;
  password: string;
  domain: string;
  workstation: string;
  body: string;
  headers: Record<string, string>;
  agent?: https.Agent;
}

export interface NtlmResponse {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}

export type NtlmPoster = (
  opts: NtlmPostOptions,
  cb: (err: any, res?: NtlmResponse) => void,
) => void;

// httpntlm ships no type declarations; require it the same way the codebase
// pulls in other untyped libs (see common/attachment-text.ts pdf-parse).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const httpntlm = require('httpntlm') as { post: NtlmPoster };

const CONTENT_TYPE = 'text/xml; charset=utf-8';

/** Split a stored `DOMAIN\user` credential into the pieces httpntlm wants.
 *  No backslash → empty domain and the value passed through untouched. */
export function splitNtlmUsername(composite: string): { domain: string; username: string } {
  const i = composite.indexOf('\\');
  if (i < 0) return { domain: '', username: composite };
  return { domain: composite.slice(0, i), username: composite.slice(i + 1) };
}

/** Normalise a host into the EWS SOAP endpoint URL. Mirrors
 *  ZimbraService.buildClient's scheme handling: bare host → https://, an
 *  http(s):// prefix is honoured as-is. A URL that already ends in the asmx
 *  path is used verbatim; otherwise `/EWS/Exchange.asmx` is appended. */
export function ewsEndpoint(host: string): string {
  const base = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  if (/\/EWS\/Exchange\.asmx\/?$/i.test(base)) return base.replace(/\/$/, '');
  return base.replace(/\/+$/, '') + '/EWS/Exchange.asmx';
}

// ── Error inspection ────────────────────────────────────────────────────────

interface EwsResponseError {
  kind: 'fault' | 'error';
  responseCode?: string;
  messageText?: string;
  backoffMs?: number;
}

/**
 * ErrorServerBusy, in EITHER shape it arrives in — a 200-body
 * `ResponseClass="Error"` OR (the common real shape) an HTTP-500 SOAP fault.
 * `handleEwsError` throws this so the single back-off retry engages regardless
 * of the transport-visible shape; it extends `BadGatewayException` so that if
 * the throttle persists past the one retry the give-up still surfaces as a
 * clean 502. `callWithRetry` keys the retry on `instanceof EwsServerBusyError`
 * and honours `backoffMs` (capped).
 */
export class EwsServerBusyError extends BadGatewayException {
  constructor(
    messageText: string | undefined,
    readonly backoffMs?: number,
  ) {
    super(`EWS ErrorServerBusy${messageText ? `: ${messageText}` : ''}`);
  }
}

/** Depth-first search for the first object node satisfying `pred`. */
function findNode(obj: any, pred: (node: any) => boolean): any {
  if (!obj || typeof obj !== 'object') return undefined;
  if (pred(obj)) return obj;
  for (const key of Object.keys(obj)) {
    const found = findNode(obj[key], pred);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Depth-first search for the first value stored under `key`. */
function findValue(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined && typeof obj[key] !== 'object') return obj[key];
  for (const k of Object.keys(obj)) {
    const found = findValue(obj[k], key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Pull BackOffMilliseconds out of a ServerBusy `MessageXml` block, if present.
 *  Shape after removeNSPrefix: `{ Value: { '@_Name': 'BackOffMilliseconds',
 *  '#text': 50 } }` (or an array of such Value nodes). */
function extractBackoff(node: any): number | undefined {
  const found = findNode(
    node,
    (n) => n['@_Name'] === 'BackOffMilliseconds' && n['#text'] !== undefined,
  );
  if (!found) return undefined;
  const n = Number(found['#text']);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Inspect a parsed EWS response for a transport-visible failure. Returns
 * `null` for Success/Warning responses. Detects both a SOAP `Fault` and any
 * ResponseMessage carrying `ResponseClass="Error"`.
 */
export function inspectEwsXml(xml: string): EwsResponseError | null {
  let tree: any;
  try {
    tree = parseEws(xml);
  } catch {
    return null;
  }

  const fault = findNode(tree, (n) => n.faultcode !== undefined || n.faultstring !== undefined);
  if (fault) {
    // ResponseCode may live in <detail>; fall back to faultstring for text.
    const responseCode = findValue(fault, 'ResponseCode') ?? findValue(fault, 'faultcode');
    const messageText =
      findValue(fault, 'Message') ?? findValue(fault, 'faultstring') ?? undefined;
    // A throttle fault carries BackOffMilliseconds inside <detail>/MessageXml,
    // exactly like the 200-body error shape — extract it so the retry can honour it.
    return { kind: 'fault', responseCode, messageText, backoffMs: extractBackoff(fault) };
  }

  const errNode = findNode(tree, (n) => n['@_ResponseClass'] === 'Error');
  if (errNode) {
    return {
      kind: 'error',
      responseCode: findValue(errNode, 'ResponseCode'),
      messageText: findValue(errNode, 'MessageText'),
      backoffMs: extractBackoff(errNode),
    };
  }

  return null;
}

/**
 * The single error-mapping funnel for the whole EWS provider. Always throws.
 *
 *  - a network/transport error       → BadGatewayException (summarised, never
 *                                       echoing the raw error which can carry
 *                                       request detail)
 *  - HTTP 401                         → UnauthorizedException (session invalid)
 *  - a SOAP fault / ResponseClass=Error → BadGatewayException with code + text
 *  - any other non-2xx                → BadGatewayException with the status
 *
 * The single ErrorServerBusy/BackOffMilliseconds retry is NOT here — it lives
 * at the EwsService call boundary, which inspects the XML before deciding.
 */
export function handleEwsError(status: number, xml?: string, err?: any): never {
  if (err) {
    // Summarise: an error's `.code` (ECONNREFUSED, ETIMEDOUT, ...) is safe;
    // its `.message` can embed request context, so it is not forwarded.
    const code = typeof err?.code === 'string' ? err.code : 'network error';
    throw new BadGatewayException(`EWS transport failed (${code}).`);
  }

  if (status === 401) {
    throw new UnauthorizedException(
      'Your mail session is no longer valid. Please sign in again.',
    );
  }

  if (xml) {
    const info = inspectEwsXml(xml);
    if (info) {
      // A missing item/folder is a 404, not a bad gateway — the established
      // not-found convention (mirrors MemoryMailProvider): getMessage /
      // renameFolder / emptyFolder etc. on an unknown id surface as
      // NotFoundException so callers can distinguish "gone" from "upstream
      // broke". ErrorNonExistentMailbox is folded in for the same reason.
      if (
        info.responseCode === 'ErrorItemNotFound' ||
        info.responseCode === 'ErrorFolderNotFound' ||
        info.responseCode === 'ErrorNonExistentMailbox'
      ) {
        throw new NotFoundException('The requested mail item no longer exists.');
      }
      // ErrorServerBusy in either shape (200-body error OR this HTTP-500 fault)
      // → a typed error carrying BackOffMilliseconds so callWithRetry can
      // honour the back-off and retry once. It IS a BadGatewayException, so a
      // persistent throttle past the retry still surfaces as a clean 502.
      if (info.responseCode === 'ErrorServerBusy') {
        throw new EwsServerBusyError(info.messageText, info.backoffMs);
      }
      const code = info.responseCode ?? (info.kind === 'fault' ? 'SOAPFault' : 'Error');
      const text = info.messageText ? `: ${info.messageText}` : '';
      throw new BadGatewayException(`EWS ${code}${text}`);
    }
  }

  if (status < 200 || status >= 300) {
    throw new BadGatewayException(`EWS request failed with HTTP ${status}.`);
  }

  throw new BadGatewayException('EWS request failed.');
}

// ── Transport ───────────────────────────────────────────────────────────────

export class EwsTransport {
  private readonly logger = new Logger(EwsTransport.name);
  /** One keep-alive https.Agent per session identity (email). NTLM
   *  authenticates the TCP *connection*, so reusing the socket avoids
   *  re-handshaking the type-1/2/3 exchange on every call. Task 8 evicts on
   *  logout via `evict`. */
  private readonly agents = new Map<string, https.Agent>();

  // `post` is injectable so tests substitute a stub for httpntlm.
  constructor(private readonly post: NtlmPoster = httpntlm.post) {}

  private agentFor(email: string): https.Agent {
    let agent = this.agents.get(email);
    if (!agent) {
      const caPath = process.env.MAIL_CA_BUNDLE;
      // A private CA bundle may be *added*; TLS verification is never disabled.
      const ca = caPath ? readFileSync(caPath) : undefined;
      agent = new https.Agent(ca ? { keepAlive: true, ca } : { keepAlive: true });
      this.agents.set(email, agent);
    }
    return agent;
  }

  /** Drop the cached agent for a session (logout). */
  evict(email: string): void {
    const agent = this.agents.get(email);
    if (agent) {
      agent.destroy();
      this.agents.delete(email);
    }
  }

  /** A single NTLM POST over the given agent, wrapped as a promise. Callers own
   *  the agent lifecycle (keep-alive reuse vs. a fresh re-handshake). No
   *  logging here: the caller logs endpoint + status once per attempt. */
  private postOnce(
    url: string,
    username: string,
    password: string,
    domain: string,
    bodyXml: string,
    agent: https.Agent,
  ): Promise<NtlmResponse> {
    return new Promise<NtlmResponse>((resolve, reject) => {
      this.post(
        {
          url,
          username,
          password,
          domain,
          workstation: '',
          body: bodyXml,
          headers: { 'Content-Type': CONTENT_TYPE },
          agent,
        },
        (err, response) => (err ? reject(err) : resolve(response as NtlmResponse)),
      );
    });
  }

  /**
   * POST a SOAP envelope to the mailbox's EWS endpoint over NTLM and return
   * the raw response XML (HTTP 200). HTTP-level failures throw through
   * `handleEwsError`; SOAP-level `ResponseClass="Error"` bodies are returned
   * as-is for the caller (EwsService) to inspect — that is where the
   * ErrorServerBusy retry lives.
   *
   * NTLM authenticates the *connection*, not the request. When Exchange (or an
   * idle timeout) recycles the cached keep-alive socket, its NTLM context is
   * gone and the next request reusing that socket comes back HTTP 401. That is
   * NOT a dead session — so on a 401 we recover EXACTLY ONCE: evict the stale
   * agent, re-do the NTLM handshake on a fresh connection, and retry. Only a
   * SECOND 401 (genuine bad/expired credentials) surfaces as Unauthorized.
   */
  async call(session: MailSession, bodyXml: string): Promise<string> {
    if (!session.credentials) {
      throw new BadGatewayException('EWS transport: session is missing credentials.');
    }
    const url = ewsEndpoint(session.host);
    const { domain, username } = splitNtlmUsername(session.credentials.username);
    const password = session.credentials.password;

    let res: NtlmResponse;
    try {
      res = await this.postOnce(url, username, password, domain, bodyXml, this.agentFor(session.email));
    } catch (err) {
      // Redacted: only a summarised transport error, never url/creds/body.
      this.logger.debug(`EWS POST ${url} → transport error`);
      handleEwsError(0, undefined, err);
    }

    // Endpoint + status only. Never the body (may contain message content) and
    // never the Authorization header (NTLM bytes) or credentials.
    this.logger.debug(`EWS POST ${url} → HTTP ${res.statusCode}`);

    if (res.statusCode === 401) {
      // Stale keep-alive NTLM context — re-handshake once on a fresh connection.
      this.evict(session.email);
      try {
        res = await this.postOnce(url, username, password, domain, bodyXml, this.agentFor(session.email));
      } catch (err) {
        this.logger.debug(`EWS POST ${url} → transport error`);
        handleEwsError(0, undefined, err);
      }
      this.logger.debug(`EWS POST ${url} → HTTP ${res.statusCode}`);
      // A second 401 is a genuine auth failure (bad/expired credentials).
      if (res.statusCode === 401) handleEwsError(401);
    }

    if (res.statusCode < 200 || res.statusCode >= 300) {
      handleEwsError(res.statusCode, res.body);
    }
    return res.body;
  }
}
