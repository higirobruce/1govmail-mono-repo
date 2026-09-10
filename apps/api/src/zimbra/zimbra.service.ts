import {
  Injectable,
  UnauthorizedException,
  BadGatewayException,
  HttpException,
  Logger,
} from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { MailSession } from '../provider/mail-session';
import {
  ProviderAuthResult,
  ProviderContact,
  ProviderEvent,
  ProviderEventDetail,
  ProviderFolder,
  ProviderFreeBusy,
  ProviderIdentity,
  ProviderMessage,
  ProviderMessagePage,
  ProviderSignature,
} from '../provider/provider-types';
import {
  CalendarEventPayload,
  DraftPayload,
  MailProvider,
  ModifyCalendarEventPayload,
  SendMessagePayload,
} from '../provider/mail-provider.interface';
import {
  mapCalendarEventPayloadToZimbraMessage,
  mapProviderContactToZimbraAttrs,
  mapZimbraAppointment,
  mapZimbraAppointmentDetail,
  mapZimbraContact,
  mapZimbraFolder,
  mapZimbraFreeBusy,
  mapZimbraMessage,
  ZimbraAppointment,
} from './zimbra.mappers';

// The Zimbra wire shapes live in zimbra.mappers.ts (the only place that knows
// `su`/`fr`/`e[]`/`mp[]`/flag chars, and the calendar's `inst[]`/`inv[].comp[]`
// nesting). Tasks 6-8 left a re-export block here for "existing importers";
// there are none — every importer already reaches into zimbra.mappers — so it
// is gone (Task 9, Task 6 controller ruling).

// Zimbra fault codes that indicate the session is no longer valid
const AUTH_FAULT_CODES = new Set([
  'service.AUTH_EXPIRED',
  'service.AUTH_REQUIRED',
  'account.AUTH_FAILED',
]);

@Injectable()
export class ZimbraService implements MailProvider {
  readonly name = 'zimbra' as const;

  /**
   * Zimbra backs the whole settings surface natively, so every flag is true.
   * The flags exist for the providers that do not: they are what lets
   * GET /settings tell the client which sections to render, instead of the
   * client discovering the gap by watching a save fail.
   */
  readonly capabilities = {
    signatures: true,
    identities: true,
    serverPrefs: true,
    changePassword: true,
    twoFactor: true,
  } as const;

  private readonly logger = new Logger(ZimbraService.name);

  /**
   * Build an axios client for the given Zimbra host.
   *
   * `host` may be supplied in any of these formats:
   *   - "mail.company.com"              → https://mail.company.com
   *   - "mail.company.com:8443"         → https://mail.company.com:8443
   *   - "https://mail.company.com:443"  → used as-is
   *   - "http://mail.company.com:8080"  → used as-is (self-hosted HTTP)
   */
  private buildClient(host: string, authToken?: string, csrfToken?: string): AxiosInstance {
    const baseURL = host.startsWith('http://') || host.startsWith('https://')
      ? host
      : `https://${host}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers['Cookie'] = `ZM_AUTH_TOKEN=${authToken}`;
    }
    if (csrfToken) {
      // Zimbra 8.7+ requires this header when CSRF protection is enabled.
      headers['X-Zimbra-Csrf-Token'] = csrfToken;
    }

    const client = axios.create({ baseURL, headers, timeout: 15000 });

    // ── Debug interceptors ────────────────────────────────────────────────────
    // Visible at LOG level so they appear in dev without changing log level.
    const logger = this.logger;
    client.interceptors.request.use((config) => {
      const cookie = config.headers?.['Cookie'] as string | undefined;
      const cookieSnippet = cookie
        ? `ZM_AUTH_TOKEN=${cookie.replace('ZM_AUTH_TOKEN=', '').substring(0, 20)}…`
        : 'none';
      logger.debug(`→ SOAP ${config.baseURL}/service/soap  cookie=[${cookieSnippet}]`);
      return config;
    });

    client.interceptors.response.use(
      (res) => res,
      (err) => {
        const fault = err?.response?.data?.Body?.Fault;
        if (fault) {
          logger.debug(`← SOAP fault full: ${JSON.stringify(fault)}`);
        }
        return Promise.reject(err);
      },
    );

    return client;
  }

  /**
   * Build the SOAP envelope Header context.
   * Auth is via ZM_AUTH_TOKEN Cookie + X-Zimbra-Csrf-Token HTTP header.
   * When csrfToken is present it is also included in the SOAP context for
   * Zimbra versions that validate it there rather than in HTTP headers.
   */
  private soapHeader(csrfToken?: string) {
    const context: Record<string, any> = { _jsns: 'urn:zimbra' };
    if (csrfToken) context.csrfToken = csrfToken;
    return { context };
  }

  /**
   * Central error handler for all Zimbra SOAP calls.
   *
   * Zimbra returns HTTP 500 for SOAP faults (not HTTP 400/401), so axios
   * throws for every fault. We inspect the fault code to decide whether to
   * surface a 401 (expired/missing session) or a 502 (upstream failure).
   *
   * NOTE: `if (err?.status) throw err` was the previous check, but axios ≥1.5
   * sets `err.status = err.response.status`, so a Zimbra 500-fault would cause
   * that check to pass and re-throw a raw AxiosError, which NestJS converts to
   * a 500. Using `instanceof HttpException` is the correct guard.
   */
  private handleZimbraError(err: any, context: string): never {
    // Always re-throw our own NestJS exceptions as-is
    if (err instanceof HttpException) throw err;

    // Parse a Zimbra SOAP fault from the axios error response body.
    // Zimbra returns HTTP 500 for SOAP faults; the body is usually JSON with Body.Fault.
    const responseData = err?.response?.data;
    const fault = responseData?.Body?.Fault;
    if (fault) {
      const code: string = fault?.Detail?.Error?.Code ?? '';
      const text: string =
        fault?.Reason?.Text ??
        fault?.Detail?.Error?.Reason?.Text ??
        'Zimbra error';

      this.logger.warn(`[${context}] Zimbra fault [${code}]: ${text}`);

      if (AUTH_FAULT_CODES.has(code)) {
        throw new UnauthorizedException(
          'Your Zimbra session has expired. Please log in again.',
        );
      }
      throw new BadGatewayException(text);
    }

    // Log the raw response body so we can diagnose unparseable errors
    if (responseData) {
      const raw = typeof responseData === 'string'
        ? responseData.slice(0, 800)
        : JSON.stringify(responseData).slice(0, 800);
      this.logger.error(`[${context}] HTTP ${err.response?.status} — response body: ${raw}`);
    } else {
      this.logger.error(`[${context}] ${err.message}`);
    }

    throw new BadGatewayException(
      err.response?.status
        ? `Zimbra server error (HTTP ${err.response.status})`
        : `Could not reach the Zimbra server: ${err.message}`,
    );
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  /**
   * `authenticate` and `verifyTwoFactor` keep `(host, email, …)` rather than
   * taking a MailSession: they run *before* a session exists — issuing the
   * token a session is made of is the whole point of them.
   */
  async authenticate(
    host: string,
    email: string,
    password: string,
    _opts?: { ntlmDomain?: string },
  ): Promise<ProviderAuthResult> {
    const client = this.buildClient(host);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          AuthRequest: {
            _jsns: 'urn:zimbraAccount',
            account: { by: 'name', _content: email },
            password: { _content: password },
          },
        },
        Header: {
          context: { _jsns: 'urn:zimbra', userAgent: { name: 'ZimbraClient' } },
        },
      });

      const authResponse = response.data?.Body?.AuthResponse;
      if (!authResponse) throw new UnauthorizedException('Invalid credentials');

      // authToken is an array in the JSON-SOAP response; trim() guards against
      // stray whitespace/newlines that would make the cookie or SOAP header invalid.
      const authToken: string = (authResponse.authToken?.[0]?._content ?? '').trim();
      // lifetime from Zimbra is in milliseconds (e.g. 86400000 = 24h)
      const lifetime: number = Number(authResponse.lifetime ?? 0);

      if (!authToken) throw new UnauthorizedException('Zimbra returned an empty auth token');

      // Zimbra 8.7+ returns a csrfToken when CSRF protection is enabled.
      const csrfToken: string | undefined = authResponse.csrfToken ?? undefined;

      // Zimbra cluster: `refer` tells us which backend server owns this mailbox.
      // All subsequent SOAP calls MUST go to that server or they get AUTH_EXPIRED.
      // Surfaced as the neutral `redirectHost` — the element name stops here.
      const refer: string | undefined = authResponse.refer?._content ?? undefined;

      // Zimbra may return twoFactorAuthRequired as boolean true, number 1, or
      // string "1" — use Boolean() so all truthy values are caught.
      const rawTwoFactor = authResponse.twoFactorAuthRequired;
      const twoFactorRequired: boolean = Boolean(rawTwoFactor);

      // Log ALL top-level keys AND the raw twoFactor value so we can diagnose.
      this.logger.debug(
        `authenticate(${email}): authResponse keys=[${Object.keys(authResponse).join(', ')}]`,
      );
      this.logger.debug(
        `authenticate(${email}): token length=${authToken.length}, lifetime=${lifetime}ms (~${Math.round(lifetime / 3600000)}h), csrfToken=${csrfToken ? `present (${csrfToken.length} chars)` : 'absent'}, refer=${refer ?? 'absent'}, twoFactorAuthRequired raw=${JSON.stringify(rawTwoFactor)} → ${twoFactorRequired}`,
      );

      return {
        authToken,
        lifetime,
        csrfToken,
        redirectHost: refer,
        twoFactorRequired,
        displayName: authResponse.prefs?.pref?.find(
          (p: any) => p.name === 'zimbraPrefFromDisplay',
        )?._content,
      };
    } catch (err: any) {
      this.handleZimbraError(err, `authenticate(${email})`);
    }
  }

  /**
   * Complete Zimbra Two-Factor Authentication.
   *
   * Sends the pre-auth token (returned by the first AuthRequest) together with
   * the user's TOTP code.  On success Zimbra returns a full session authToken
   * that can be used for all subsequent SOAP calls.
   */
  async verifyTwoFactor(
    host: string,
    email: string,
    preAuthToken: string,
    twoFactorCode: string,
  ): Promise<ProviderAuthResult> {
    const client = this.buildClient(host);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          AuthRequest: {
            _jsns: 'urn:zimbraAccount',
            account: { by: 'name', _content: email },
            authToken: [{ _content: preAuthToken }],
            twoFactorCode: { _content: twoFactorCode },
          },
        },
        Header: {
          context: { _jsns: 'urn:zimbra', userAgent: { name: 'ZimbraClient' } },
        },
      });

      const authResponse = response.data?.Body?.AuthResponse;
      if (!authResponse) throw new UnauthorizedException('Invalid 2FA code');

      const authToken: string = (authResponse.authToken?.[0]?._content ?? '').trim();
      const lifetime: number = Number(authResponse.lifetime ?? 0);

      if (!authToken) throw new UnauthorizedException('Zimbra returned an empty token after 2FA');

      const csrfToken: string | undefined = authResponse.csrfToken ?? undefined;
      const refer: string | undefined = authResponse.refer?._content ?? undefined;

      this.logger.debug(
        `verifyTwoFactor(${email}): token length=${authToken.length}, lifetime=${lifetime}ms, refer=${refer ?? 'absent'}`,
      );

      return {
        authToken,
        lifetime,
        csrfToken,
        redirectHost: refer,
        // The challenge is what just succeeded, so it is never outstanding
        // again on this response. Previously the key was simply absent; the
        // one consumer branches on truthiness, so `false` reads identically.
        twoFactorRequired: false,
        displayName: authResponse.prefs?.pref?.find(
          (p: any) => p.name === 'zimbraPrefFromDisplay',
        )?._content,
      };
    } catch (err: any) {
      this.handleZimbraError(err, `verifyTwoFactor(${email})`);
    }
  }

  // ─── Folders ─────────────────────────────────────────────────────────────────

  async getFolders(s: MailSession): Promise<ProviderFolder[]> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      // No folder filter → Zimbra returns the entire folder hierarchy from root.
      // Passing folder:{l:'1'} is fragile on some Zimbra versions / virtual accounts.
      const response = await client.post('/service/soap', {
        Body: {
          GetFolderRequest: {
            _jsns: 'urn:zimbraMail',
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });

      const folders: ProviderFolder[] = [];
      const root = response.data?.Body?.GetFolderResponse?.folder?.[0];
      if (root) this.flattenFolders(root, folders);
      return folders;
    } catch (err: any) {
      this.handleZimbraError(err, 'getFolders');
    }
  }

  private flattenFolders(node: any, acc: ProviderFolder[]): void {
    // Guard: skip folders that lack an id (system virtual nodes in some setups)
    if (node.id == null) return;

    acc.push(mapZimbraFolder(node));

    // Recurse into sub-folders AND linked/mounted folders
    for (const child of [
      ...(Array.isArray(node.folder) ? node.folder : []),
      ...(Array.isArray(node.link) ? node.link : []),
      ...(Array.isArray(node.mountpoint) ? node.mountpoint : []),
    ]) {
      this.flattenFolders(child, acc);
    }
  }

  // ─── Messages ────────────────────────────────────────────────────────────────

  async getMessages(
    s: MailSession,
    folderId: string,
    limit = 50,
    offset = 0,
  ): Promise<ProviderMessagePage> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      // `inid:` searches by Zimbra folder ID (numeric).
      // `in:FolderName` is unreliable for non-ASCII names and doesn't accept IDs.
      const response = await client.post('/service/soap', {
        Body: {
          SearchRequest: {
            _jsns: 'urn:zimbraMail',
            types: 'message',
            query: `inid:${folderId}`,
            sortBy: 'dateDesc',
            limit,
            offset,
            html: 1,
            needExp: 1,
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });

      const result = response.data?.Body?.SearchResponse;
      const raw: any[] = result?.m ?? [];
      const total: number = result?.total ?? raw.length;
      // `more` is Zimbra's authoritative flag; fall back to arithmetic estimate
      const more: boolean = result?.more === 1 || result?.more === true || raw.length + offset < total;
      return { messages: raw.map(mapZimbraMessage), total, more };
    } catch (err: any) {
      this.handleZimbraError(err, `getMessages(folder=${folderId})`);
    }
  }

  async getMessage(s: MailSession, messageId: string): Promise<ProviderMessage> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          GetMsgRequest: {
            _jsns: 'urn:zimbraMail',
            // NO `read` flag: this method is a pure body fetch. Background jobs
            // (card worker, embed worker, Ask-inbox hydration) fetch bodies
            // through here — `read: 1` was silently marking users' unread mail
            // as read before they ever saw it. Read-marking happens only via
            // the explicit markRead (MsgActionRequest) path.
            m: { id: messageId, html: 1, needExp: 1 },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });

      const msg = response.data?.Body?.GetMsgResponse?.m?.[0];
      if (!msg) throw new BadGatewayException('Message not found in Zimbra');
      return mapZimbraMessage(msg);
    } catch (err: any) {
      this.handleZimbraError(err, `getMessage(${messageId})`);
    }
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  async searchMessages(
    s: MailSession,
    query: string,
    limit = 50,
    offset = 0,
  ): Promise<ProviderMessagePage> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      // NOTE: do NOT include `fetch` — fetching message bodies for every result
      // is extremely expensive and causes timeouts on large mailboxes.
      // Zimbra always returns the snippet (fr) in search results without it.
      const response = await client.post('/service/soap', {
        Body: {
          SearchRequest: {
            _jsns:  'urn:zimbraMail',
            query,
            types:  'message',
            sortBy: 'dateDesc',
            limit,
            offset,
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });

      const body = response.data?.Body?.SearchResponse;
      const raw: any[] = body?.m ?? [];
      // Zimbra returns a `more` boolean (reliable) and an optional `total` estimate.
      // Prefer `more` for hasMore; fall back to a full-page heuristic when Zimbra
      // omits the field (some versions only include `more` when it is true).
      const total: number = body?.total ?? raw.length;
      const more: boolean = !!body?.more || raw.length >= limit;
      return { messages: raw.map(mapZimbraMessage), total, more };
    } catch (err: any) {
      this.handleZimbraError(err, `searchMessages("${query}")`);
      return { messages: [], total: 0, more: false }; // unreachable but satisfies TS
    }
  }

  async searchStructured(): Promise<ProviderMessagePage> {
    throw new Error('searchStructured not yet implemented');
  }

  // ─── Send / Modify ───────────────────────────────────────────────────────────

  /**
   * Upload a single file to Zimbra's REST upload endpoint.
   * Returns the attachment ID (`aid`) that can be referenced in SendMsgRequest.
   */
  async uploadAttachment(
    s: MailSession,
    filename: string,
    contentType: string,
    data: Buffer,
  ): Promise<string> {
    const baseURL = s.host.startsWith('http') ? s.host : `https://${s.host}`;
    let rawResponse = '';
    try {
      const res = await axios.post(
        `${baseURL}/service/upload?fmt=raw`,
        data,
        {
          // Force string response — Zimbra returns non-standard JS:
          // 200,'null',[{"aid":"...","filename":"...","ct":"..."}]
          responseType: 'text',
          headers: {
            Cookie: `ZM_AUTH_TOKEN=${s.authToken}`,
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
          },
          timeout: 30000,
        },
      );

      rawResponse = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      this.logger.debug(`Zimbra upload response for "${filename}": ${rawResponse.substring(0, 400)}`);

      // Strategy 1: direct regex on the standard Zimbra response
      // Handles: 200,'null',[{"aid":"<value>"}] and variants
      const m1 = rawResponse.match(/"aid"\s*:\s*"([^"]+)"/);
      if (m1?.[1]) return m1[1];

      // Strategy 2: extract and parse the JSON array portion
      const arrMatch = rawResponse.match(/\[(\{[^[\]]+\}(?:,\s*\{[^[\]]+\})*)\]/);
      if (arrMatch) {
        try {
          const arr = JSON.parse(arrMatch[0]) as Array<{ aid?: string }>;
          if (Array.isArray(arr) && arr[0]?.aid) return String(arr[0].aid);
        } catch { /* ignore parse error */ }
      }

      // Strategy 3: Axios already parsed the array (some Zimbra configs return JSON)
      if (Array.isArray(res.data) && (res.data as any[])[0]?.aid) {
        return String((res.data as any[])[0].aid);
      }
      if (typeof res.data === 'object' && res.data !== null && (res.data as any).aid) {
        return String((res.data as any).aid);
      }

      // Strategy 4: plain-string format — 200,'null','<aid>'
      // Some Zimbra installs return the aid as a bare single-quoted string,
      // not a JSON array: e.g. 200,'null','uuid1:uuid2'
      const plainMatch = rawResponse.match(/^\d+,'[^']*','([^']+)'/);
      if (plainMatch?.[1]) return plainMatch[1];

      this.logger.error(
        `Zimbra upload: no aid in response for "${filename}". ` +
        `HTTP ${res.status}. Body: ${rawResponse.substring(0, 400)}`,
      );
      throw new BadGatewayException(
        `Zimbra upload did not return an aid for "${filename}". ` +
        `Response: ${rawResponse.substring(0, 200)}`,
      );
    } catch (err: any) {
      if (err instanceof BadGatewayException) throw err;
      this.logger.error(
        `Failed to upload "${filename}": ${err?.message}. ` +
        `Response so far: ${rawResponse.substring(0, 200)}`,
      );
      throw new BadGatewayException(`Failed to upload attachment "${filename}": ${err?.message ?? err}`);
    }
  }

  async sendMessage(
    s: MailSession,
    payload: SendMessagePayload,
    attachmentAids: string[] = [],
    inlineImageAids: Array<{ aid: string; cid: string; ct: string }> = [],
    forwardedAttachments: Array<{ mid: string; part: string }> = [],
  ): Promise<{ id: string; conversationId: string | null }> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    const toAddrs  = payload.to.map((a) => ({ t: 't', a }));
    const ccAddrs  = (payload.cc  ?? []).map((a) => ({ t: 'c', a }));
    const bccAddrs = (payload.bcc ?? []).map((a) => ({ t: 'b', a }));

    // HTML part — body:true tells Zimbra this is the display body.
    // content must be a plain string (NOT { _content: "…" }) for Zimbra JSON SOAP.
    const htmlPart = {
      ct: 'text/html',
      body: true,
      content: payload.body,
    };

    // If there are inline images (signature logos, pasted images) wrap in
    // multipart/related so recipients see them embedded.  Each image is an
    // already-uploaded attachment referenced by its CID.
    // ci must NOT include angle brackets — Zimbra adds <…> itself.
    const innerPart = inlineImageAids.length > 0
      ? {
          ct: 'multipart/related',
          mp: [
            htmlPart,
            ...inlineImageAids.map(({ aid, cid, ct }) => ({
              ct,
              attach: { aid },
              ci: cid,
              cd: 'inline',
            })),
          ],
        }
      : htmlPart;

    const requestBody = {
      Body: {
        SendMsgRequest: {
          _jsns: 'urn:zimbraMail',
          m: {
            ...(payload.replyToId  ? { origid: payload.replyToId }  : {}),
            ...(payload.replyType  ? { rt: payload.replyType }      : {}),
            e: [...toAddrs, ...ccAddrs, ...bccAddrs],
            su: payload.subject,
            mp: [innerPart],
            ...((attachmentAids.length > 0 || forwardedAttachments.length > 0)
              ? {
                  attach: {
                    ...(attachmentAids.length > 0 ? { aid: attachmentAids.join(',') } : {}),
                    ...(forwardedAttachments.length > 0
                      ? { mp: forwardedAttachments.map((a) => ({ mid: a.mid, part: a.part })) }
                      : {}),
                  },
                }
              : {}),
          },
        },
      },
      Header: this.soapHeader(s.csrfToken),
    };

    this.logger.log(
      `[sendMessage] outgoing SOAP: ${JSON.stringify(requestBody).slice(0, 2000)}`,
    );

    try {
      const res = await client.post('/service/soap', requestBody);
      const sent = res.data?.Body?.SendMsgResponse?.m?.[0];
      return {
        id:             sent?.id  != null ? String(sent.id)  : '',
        conversationId: sent?.cid != null ? String(sent.cid) : null,
      };
    } catch (err: any) {
      this.handleZimbraError(err, 'sendMessage');
    }
  }

  async deleteFolder(s: MailSession, folderId: string): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          FolderActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: folderId, op: 'delete' },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `deleteFolder(${folderId})`);
    }
  }

  async emptyFolder(s: MailSession, folderId: string): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          FolderActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: folderId, op: 'empty', recursive: 1 },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `emptyFolder(${folderId})`);
    }
  }

  async renameFolder(s: MailSession, folderId: string, name: string): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          FolderActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: folderId, op: 'rename', name },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `renameFolder(${folderId})`);
    }
  }

  async deleteMessage(s: MailSession, messageId: string): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          MsgActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: messageId, op: 'trash' },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `deleteMessage(${messageId})`);
    }
  }

  async markRead(s: MailSession, messageId: string, read: boolean): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          MsgActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: messageId, op: read ? 'read' : '!read' },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `markRead(${messageId}, ${read})`);
    }
  }

  async moveMessage(s: MailSession, messageId: string, folderId: string): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          MsgActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: messageId, op: 'move', l: folderId },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `moveMessage(${messageId} → ${folderId})`);
    }
  }

  async createFolder(s: MailSession, name: string, parentId?: string): Promise<ProviderFolder> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          CreateFolderRequest: {
            _jsns: 'urn:zimbraMail',
            // '1' is Zimbra's root folder — the default when no parent is given.
            folder: { name, l: parentId ?? '1', view: 'message' },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
      const f = response.data?.Body?.CreateFolderResponse?.folder?.[0];
      return mapZimbraFolder(f);
    } catch (err: any) {
      this.handleZimbraError(err, `createFolder("${name}")`);
    }
  }

  // ─── Attachments ─────────────────────────────────────────────────────────────

  /**
   * Download an attachment as a raw Buffer — for server-side processing
   * (e.g. embedding inline images as base64 data URIs in the HTML body).
   */
  async downloadAttachmentBuffer(
    s: MailSession,
    messageId: string,
    part: string,
  ): Promise<{ data: Buffer; contentType: string }> {
    const url = `https://${s.host}/service/home/${encodeURIComponent(s.email)}`;
    try {
      const response = await axios.get(url, {
        params: { id: messageId, part, disp: 'a', auth: 'qp', zauthtoken: s.authToken },
        responseType: 'arraybuffer',
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        timeout: 15_000,
      });
      const contentType: string = response.headers['content-type'] ?? 'application/octet-stream';
      return { data: Buffer.from(response.data as ArrayBuffer), contentType };
    } catch (err: any) {
      this.logger.error(`downloadAttachmentBuffer failed for msg=${messageId} part=${part}: ${err?.message}`);
      throw new BadGatewayException('Failed to download attachment from Zimbra');
    }
  }

  /**
   * Download any file at a Zimbra-relative path (e.g. a Briefcase image
   * referenced in an email signature: "/home/user@domain/Briefcase/logo.gif").
   * Decodes HTML entities in the path and appends query-param auth so no
   * cookie session is required.
   */
  async downloadZimbraPath(
    host: string,
    authToken: string,
    relativePath: string,
  ): Promise<{ data: Buffer; contentType: string }> {
    // Decode HTML entities that Zimbra encodes in <img src="..."> attributes
    const decoded = relativePath
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    const urlObj = new URL(`https://${host}${decoded}`);
    urlObj.searchParams.set('auth', 'qp');
    urlObj.searchParams.set('zauthtoken', authToken);

    try {
      const response = await axios.get(urlObj.toString(), {
        responseType: 'arraybuffer',
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        timeout: 10_000,
      });
      const contentType: string = response.headers['content-type'] ?? 'image/png';
      return { data: Buffer.from(response.data as ArrayBuffer), contentType };
    } catch (err: any) {
      this.logger.error(`downloadZimbraPath failed for path=${relativePath}: ${err?.message}`);
      throw new BadGatewayException('Failed to download Zimbra resource');
    }
  }

  /**
   * Stream an attachment directly from Zimbra's REST home endpoint.
   * Uses query-param auth (`auth=qp&zauthtoken=…`) so no cookies are needed.
   * Returns the axios response stream together with content-type / filename
   * derived from the response headers (Zimbra sets them automatically).
   */
  async downloadAttachment(
    s: MailSession,
    messageId: string,
    part: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; filename: string }> {
    const url = `https://${s.host}/service/home/${encodeURIComponent(s.email)}`;
    try {
      const response = await axios.get(url, {
        params: {
          id:         messageId,
          part,
          disp:       'a',
          auth:       'qp',
          zauthtoken: s.authToken,
        },
        responseType: 'stream',
        // Accept self-signed certs common on on-premise Zimbra installs
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        timeout: 30_000,
      });

      const contentType: string =
        response.headers['content-type'] ?? 'application/octet-stream';

      // Zimbra sets Content-Disposition: attachment; filename="..."
      const rawDisposition: string = response.headers['content-disposition'] ?? '';
      const filenameMatch = rawDisposition.match(/filename[^;=\n]*=(['"]?)([^'";\n]+)\1/i);
      const filename = filenameMatch?.[2] ?? `attachment_${part}`;

      return { stream: response.data, contentType, filename };
    } catch (err: any) {
      this.logger.error(`downloadAttachment failed for msg=${messageId} part=${part}: ${err?.message}`);
      throw new BadGatewayException('Failed to download attachment from Zimbra');
    }
  }

  // ─── Contacts ────────────────────────────────────────────────────────────────

  /**
   * Use Zimbra's built-in AutoCompleteRequest to suggest contacts/GAL entries
   * matching the given prefix query. Returns an empty array on any error so
   * compose-form autocomplete degrades gracefully without blocking sending.
   */
  async autoCompleteContacts(
    s: MailSession,
    query: string,
  ): Promise<Array<{ email: string; display: string }>> {
    if (!query || !query.trim()) return [];
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          AutoCompleteRequest: {
            _jsns: 'urn:zimbraMail',
            name: query.trim(),
            // Include both personal contacts and the Global Address List
            includeGal: 1,
            t: 'account,group',
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });

      const matches: any[] = response.data?.Body?.AutoCompleteResponse?.match ?? [];
      return matches
        .filter((m: any) => m?.email)
        .map((m: any) => ({
          email: m.email as string,
          display: (m.display || m.full || `${m.first ?? ''} ${m.last ?? ''}`.trim() || m.email) as string,
        }));
    } catch (err: any) {
      // Never throw — autocomplete failure must not break the compose form
      const fault = err?.response?.data?.Body?.Fault;
      const msg = fault?.Reason?.Text ?? err?.message ?? 'unknown';
      this.logger.warn(`autoCompleteContacts: ${msg}`);
      return [];
    }
  }

  // ─── Full Contacts CRUD ───────────────────────────────────────────────────────

  async getContacts(
    s: MailSession,
    limit = 500,
    offset = 0,
  ): Promise<ProviderContact[]> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          SearchRequest: {
            _jsns: 'urn:zimbraMail',
            types: 'contact',
            query: 'in:/Contacts',
            limit,
            offset,
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
      const raw: any[] = response.data?.Body?.SearchResponse?.cn ?? [];
      return raw.map(mapZimbraContact);
    } catch (err: any) {
      this.handleZimbraError(err, 'getContacts');
    }
  }

  /**
   * `contact` is not echoed back by Zimbra beyond the new id — see the
   * interface doc comment. The returned ProviderContact is the input plus
   * the real id; ContactsService.createContact only reads `.id` off it.
   */
  async createContact(
    s: MailSession,
    contact: Partial<ProviderContact>,
  ): Promise<ProviderContact> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    const attrs = mapProviderContactToZimbraAttrs(contact);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          CreateContactRequest: {
            _jsns: 'urn:zimbraMail',
            cn: { a: attrs },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
      const id = response.data?.Body?.CreateContactResponse?.cn?.[0]?.id;
      if (!id) throw new BadGatewayException('Zimbra did not return a contact ID');
      return {
        id: String(id),
        displayName: contact.displayName ?? null,
        firstName: contact.firstName,
        lastName: contact.lastName,
        nickname: contact.nickname,
        company: contact.company,
        jobTitle: contact.jobTitle,
        emails: contact.emails ?? [],
        phones: contact.phones ?? [],
        notes: contact.notes,
      };
    } catch (err: any) {
      this.handleZimbraError(err, 'createContact');
    }
  }

  async modifyContact(
    s: MailSession,
    id: string,
    contact: Partial<ProviderContact>,
  ): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    const attrs = mapProviderContactToZimbraAttrs(contact);
    try {
      await client.post('/service/soap', {
        Body: {
          ModifyContactRequest: {
            _jsns: 'urn:zimbraMail',
            replace: 1,
            cn: { id, a: attrs },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `modifyContact(${id})`);
    }
  }

  async deleteContact(s: MailSession, id: string): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          ContactActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id, op: 'trash' },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `deleteContact(${id})`);
    }
  }

  // ─── Drafts ───────────────────────────────────────────────────────────────────

  /**
   * Save or update a draft using Zimbra's SaveDraftRequest.
   * Pass `payload.id` to update an existing draft; omit it to create a new one.
   * Returns the Zimbra message ID of the saved draft.
   */
  async saveDraft(s: MailSession, payload: DraftPayload): Promise<string> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);

    const buildAddr = (addrs: string[], type: string) =>
      addrs.filter(Boolean).map((a) => ({ t: type, a }));

    const e = [
      ...buildAddr(payload.to ?? [], 't'),
      ...buildAddr(payload.cc ?? [], 'c'),
      ...buildAddr(payload.bcc ?? [], 'b'),
    ];

    const m: Record<string, any> = {
      ...(payload.id ? { id: payload.id } : {}),
      su: payload.subject ?? '',
      ...(e.length > 0 ? { e } : {}),
      mp: [{ ct: 'text/html', body: true, content: payload.body ?? '' }],
    };

    try {
      const response = await client.post('/service/soap', {
        Body: { SaveDraftRequest: { _jsns: 'urn:zimbraMail', m } },
        Header: this.soapHeader(s.csrfToken),
      });
      const id = response.data?.Body?.SaveDraftResponse?.m?.[0]?.id;
      if (!id) throw new BadGatewayException('Zimbra did not return a draft ID');
      return String(id);
    } catch (err: any) {
      this.handleZimbraError(err, 'saveDraft');
    }
  }

  // ─── Calendar ─────────────────────────────────────────────────────────────────

  /**
   * Events overlapping the window. `calExpandInstStart/End` makes Zimbra expand
   * recurrence rules server-side into `inst[]`; appointments whose expansion is
   * empty for the window are dropped by the mapper.
   */
  async getCalendarEvents(
    s: MailSession,
    startMs: number,
    endMs: number,
  ): Promise<ProviderEvent[]> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          SearchRequest: {
            _jsns: 'urn:zimbraMail',
            types: 'appointment',
            calExpandInstStart: startMs,
            calExpandInstEnd: endMs,
            query: 'in:/Calendar',
            limit: 500,
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
      const raw: ZimbraAppointment[] = response.data?.Body?.SearchResponse?.appt ?? [];
      return raw
        .map(mapZimbraAppointment)
        .filter((e): e is ProviderEvent => e !== null);
    } catch (err: any) {
      this.handleZimbraError(err, 'getCalendarEvents');
    }
  }

  /**
   * Fetch full details for a single appointment via GetAppointmentRequest.
   * Unlike SearchRequest, this always returns the complete attendee list with
   * participation status (ptst) for each invitee, plus the invite message id
   * and the modifiedSequence/rev counters an update must quote.
   * Returns null if not found.
   */
  async getAppointment(
    s: MailSession,
    zimbraId: string,
  ): Promise<ProviderEventDetail | null> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          GetAppointmentRequest: {
            _jsns: 'urn:zimbraMail',
            id: zimbraId,
            includeContent: 1,
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
      // Zimbra's JSON bridge sometimes returns a single-item array as a plain object
      const apptData = response.data?.Body?.GetAppointmentResponse?.appt;
      const appt = (Array.isArray(apptData) ? apptData[0] : apptData) ?? null;
      return appt ? mapZimbraAppointmentDetail(appt) : null;
    } catch (err: any) {
      this.handleZimbraError(err, `getAppointment(${zimbraId})`);
    }
  }

  async createCalendarEvent(
    s: MailSession,
    payload: CalendarEventPayload,
  ): Promise<string> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          CreateAppointmentRequest: {
            _jsns: 'urn:zimbraMail',
            m: mapCalendarEventPayloadToZimbraMessage(payload),
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
      const id =
        response.data?.Body?.CreateAppointmentResponse?.calItemId ??
        response.data?.Body?.CreateAppointmentResponse?.m?.[0]?.id ??
        '';
      return String(id);
    } catch (err: any) {
      this.handleZimbraError(err, 'createCalendarEvent');
    }
  }

  async modifyCalendarEvent(
    s: MailSession,
    zimbraId: string,
    payload: ModifyCalendarEventPayload,
  ): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          ModifyAppointmentRequest: {
            _jsns: 'urn:zimbraMail',
            // id must be "{calItemId}-{invMsgId}" — the full invite ID, not just calItemId
            id: zimbraId,
            comp: '0',
            // modifiedSequence and rev are required for Zimbra's conflict detection
            ...(payload.modifiedSequence !== undefined ? { modifiedSequence: payload.modifiedSequence } : {}),
            ...(payload.rev !== undefined ? { rev: payload.rev } : {}),
            // Same `m` node as the create path — no seq in comp, Zimbra manages
            // it internally. Attendees on `e` receive the update email.
            m: mapCalendarEventPayloadToZimbraMessage(payload),
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `modifyCalendarEvent(${zimbraId})`);
    }
  }

  /** `inviteId` is the invite *message* id (Zimbra's invId), not the calendar
   *  item id. `updateOrganizer: '0'` keeps Zimbra from mailing the organizer a
   *  second notification on top of the reply itself. */
  async sendInviteReply(
    s: MailSession,
    inviteId: string,
    verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE',
  ): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          SendInviteReplyRequest: {
            _jsns: 'urn:zimbraMail',
            id: inviteId,
            compNum: 0,
            verb,
            updateOrganizer: '0',
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `sendInviteReply(${inviteId}, ${verb})`);
    }
  }

  async deleteCalendarEvent(s: MailSession, zimbraId: string): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          ItemActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: zimbraId, op: 'trash' },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `deleteCalendarEvent(${zimbraId})`);
    }
  }

  // ─── Account Preferences & Settings ─────────────────────────────────────────

  /** Fetch all user preferences as a flat key → value map. */
  async getPrefs(s: MailSession): Promise<Record<string, string>> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const res = await client.post('/service/soap', {
        Body: { GetPrefsRequest: { _jsns: 'urn:zimbraAccount' } },
        Header: this.soapHeader(s.csrfToken),
      });
      const prefs: any[] = res.data?.Body?.GetPrefsResponse?.pref ?? [];
      const out: Record<string, string> = {};
      for (const p of prefs) if (p.name) out[p.name] = p._content ?? '';
      return out;
    } catch (err: any) {
      this.handleZimbraError(err, 'getPrefs');
    }
  }

  /** Set one or more user preferences. */
  async modifyPrefs(s: MailSession, prefs: Record<string, string>): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    const pref = Object.entries(prefs).map(([name, _content]) => ({ name, _content }));
    try {
      await client.post('/service/soap', {
        Body: { ModifyPrefsRequest: { _jsns: 'urn:zimbraAccount', pref } },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, 'modifyPrefs');
    }
  }

  /** Return all user identities (primary + aliases). */
  async getIdentities(s: MailSession): Promise<ProviderIdentity[]> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const res = await client.post('/service/soap', {
        Body: { GetIdentitiesRequest: { _jsns: 'urn:zimbraAccount' } },
        Header: this.soapHeader(s.csrfToken),
      });
      const identities: any[] = res.data?.Body?.GetIdentitiesResponse?.identity ?? [];
      return identities.map((ident: any) => {
        const attrs: Record<string, string> = {};
        const aArr: any[] = Array.isArray(ident.a) ? ident.a : [];
        for (const a of aArr) if (a.name) attrs[a.name] = a._content ?? '';
        return { id: ident.id ?? '', name: ident.name ?? '', attrs };
      });
    } catch (err: any) {
      this.handleZimbraError(err, 'getIdentities');
    }
  }

  /** Update an identity's attributes (display name, reply-to, default signature, etc.). */
  async modifyIdentity(
    s: MailSession,
    identityId: string,
    attrs: Record<string, string>,
  ): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    const a = Object.entries(attrs)
      .filter(([, v]) => v !== '')          // Zimbra rejects empty-string _content for ID attrs
      .map(([name, _content]) => ({ name, _content }));
    try {
      await client.post('/service/soap', {
        Body: {
          ModifyIdentityRequest: {
            _jsns: 'urn:zimbraAccount',
            identity: { id: identityId, a },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, 'modifyIdentity');
    }
  }

  /** Return all email signatures. */
  async getSignatures(s: MailSession): Promise<ProviderSignature[]> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const res = await client.post('/service/soap', {
        Body: { GetSignaturesRequest: { _jsns: 'urn:zimbraAccount' } },
        Header: this.soapHeader(s.csrfToken),
      });
      const sigs: any[] = res.data?.Body?.GetSignaturesResponse?.signature ?? [];
      return sigs.map((raw: any) => {
        const contents: any[] = Array.isArray(raw.content) ? raw.content : [];
        return {
          id:          String(raw.id ?? ''),
          name:        raw.name ?? '',
          contentHtml: contents.find((c: any) => c.type === 'text/html')?._content  ?? '',
          contentText: contents.find((c: any) => c.type === 'text/plain')?._content ?? '',
        };
      });
    } catch (err: any) {
      this.handleZimbraError(err, 'getSignatures');
    }
  }

  /** Create a new HTML signature. Returns the new signature's Zimbra ID. */
  async createSignature(
    s: MailSession,
    name: string,
    contentHtml: string,
  ): Promise<string> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const res = await client.post('/service/soap', {
        Body: {
          CreateSignatureRequest: {
            _jsns: 'urn:zimbraAccount',
            signature: {
              name,
              content: [{ type: 'text/html', _content: contentHtml }],
            },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
      const id = res.data?.Body?.CreateSignatureResponse?.signature?.[0]?.id;
      if (!id) throw new BadGatewayException('Zimbra did not return a signature ID');
      return String(id);
    } catch (err: any) {
      this.handleZimbraError(err, 'createSignature');
    }
  }

  /** Update an existing signature's name and HTML content. */
  async modifySignature(
    s: MailSession,
    signatureId: string,
    name: string,
    contentHtml: string,
  ): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          ModifySignatureRequest: {
            _jsns: 'urn:zimbraAccount',
            signature: {
              id: signatureId,
              name,
              content: [{ type: 'text/html', _content: contentHtml }],
            },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, 'modifySignature');
    }
  }

  /** Delete a signature by Zimbra ID. */
  async deleteSignature(s: MailSession, signatureId: string): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          DeleteSignatureRequest: {
            _jsns: 'urn:zimbraAccount',
            signature: { id: signatureId },
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, 'deleteSignature');
    }
  }

  /** Change the user's Zimbra account password. The account is the session's
   *  own — SettingsService always passed `user.email` here, so the separate
   *  `accountEmail` argument is now read off the session. */
  async changePassword(
    s: MailSession,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          ChangePasswordRequest: {
            _jsns: 'urn:zimbraAccount',
            account:     { by: 'name', _content: s.email },
            oldPassword,
            password:    newPassword,
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, 'changePassword');
    }
  }

  // ─── GAL (Global Address List) Search ────────────────────────────────────────

  /**
   * Search the Zimbra Global Address List using SearchGalRequest.
   * Runs in parallel with AutoCompleteRequest in ContactsService.autocomplete
   * to provide organisation-wide contact suggestions.
   */
  async searchGal(
    s: MailSession,
    query: string,
  ): Promise<Array<{ email: string; display: string }>> {
    if (!query || !query.trim()) return [];
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          SearchGalRequest: {
            _jsns: 'urn:zimbraAccount',
            name: query.trim(),
            type: 'account',
            limit: 20,
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });

      const contacts: any[] = response.data?.Body?.SearchGalResponse?.cn ?? [];
      return contacts
        .filter((c: any) => c?._attrs?.email)
        .map((c: any) => {
          const a = c._attrs as Record<string, string>;
          const display =
            a.fullName ||
            (a.firstName || a.lastName
              ? [a.firstName, a.lastName].filter(Boolean).join(' ')
              : a.email);
          return { email: a.email, display: display || a.email };
        });
    } catch (err: any) {
      const fault = err?.response?.data?.Body?.Fault;
      const msg = fault?.Reason?.Text ?? err?.message ?? 'unknown';
      this.logger.warn(`searchGal: ${msg}`);
      return [];
    }
  }

  /**
   * Look up the caller's own GAL entry (title/org attrs) by email, for
   * best-effort AI-profile seeding. Unlike `searchGal`, this requests an
   * explicit `attrs` projection since the default GAL search neither asks
   * for nor surfaces title/company/department. Soft-fails like `searchGal`:
   * never throws, always returns an all-null shape on any Zimbra trouble.
   */
  async galSelfLookup(
    s: MailSession,
    email: string,
  ): Promise<{ title: string | null; department: string | null; company: string | null }> {
    const none = { title: null, department: null, company: null };
    if (!email || !email.trim()) return none;
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          SearchGalRequest: {
            _jsns: 'urn:zimbraAccount',
            name: email.trim(),
            type: 'account',
            limit: 1,
            attrs: 'title,ou,company,department',
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });

      const hit: any = response.data?.Body?.SearchGalResponse?.cn?.[0];
      if (!hit) return none;
      const a = (hit._attrs ?? {}) as Record<string, string>;
      return {
        title:      a.title ?? null,
        department: a.ou ?? a.department ?? null,
        company:    a.company ?? null,
      };
    } catch (err: any) {
      const fault = err?.response?.data?.Body?.Fault;
      const msg = fault?.Reason?.Text ?? err?.message ?? 'unknown';
      this.logger.warn(`galSelfLookup: ${msg}`);
      return none;
    }
  }

  // ─── Free / Busy ──────────────────────────────────────────────────────────────

  /**
   * Query free/busy data for a user on the same Zimbra server.
   * Returns arrays of { s, e } millisecond timestamp pairs for busy,
   * tentative, and unavailable (out-of-office) intervals.
   */
  async getFreeBusy(
    s: MailSession,
    email: string,
    startMs: number,
    endMs: number,
  ): Promise<ProviderFreeBusy> {
    const client = this.buildClient(s.host, s.authToken, s.csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          GetFreeBusyRequest: {
            _jsns: 'urn:zimbraMail',
            s: startMs,
            e: endMs,
            uid: email,
          },
        },
        Header: this.soapHeader(s.csrfToken),
      });

      const usr = response.data?.Body?.GetFreeBusyResponse?.usr?.[0] ?? {};
      return mapZimbraFreeBusy(usr);
    } catch (err: any) {
      this.handleZimbraError(err, `getFreeBusy(${email})`);
    }
  }
}
