import {
  Injectable,
  UnauthorizedException,
  BadGatewayException,
  HttpException,
  Logger,
} from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface ZimbraAuthResult {
  authToken: string;
  lifetime: number;
  csrfToken?: string;
  displayName?: string;
  /**
   * Zimbra clusters: AuthResponse may include a `refer` hostname telling the
   * client to send ALL subsequent requests to a different backend server.
   * If ignored, every post-auth SOAP call will hit the wrong node and return
   * service.AUTH_EXPIRED even for a freshly-issued, valid token.
   */
  refer?: string;
  /**
   * When true the returned authToken is a *pre-auth* token only — not a real
   * session token.  The caller must complete Two-Factor Authentication before
   * any mailbox SOAP call can succeed.
   */
  twoFactorRequired?: boolean;
}

export interface ZimbraFolder {
  id: string;
  name: string;
  absFolderPath: string;
  u?: number;  // unread count
  n?: number;  // total count
  color?: number;
  l?: string;  // parent id
  view?: string; // folder type: 'message' | 'contact' | 'appointment' | 'task' | 'document' | …
}

export interface ZimbraMessage {
  id: string;
  cid?: string; // conversation id
  l: string;   // folder id
  f?: string;  // flags: u=unread, f=flagged, a=has-attachment, r=replied, w=forwarded
  s: number;   // size
  d: number;   // date (ms)
  su?: string; // subject
  fr?: string; // fragment/snippet
  e?: ZimbraEmailAddress[];
  mp?: ZimbraMessagePart[];
}

export interface ZimbraEmailAddress {
  a: string;  // address
  d?: string; // display name
  t: string;  // type: f=from, t=to, c=cc, b=bcc, r=reply-to
}

export interface ZimbraMessagePart {
  part: string;
  ct: string;   // content type
  body?: boolean;
  content?: string;
  mp?: ZimbraMessagePart[];
  filename?: string;
  s?: number;   // size
}

// Zimbra fault codes that indicate the session is no longer valid
const AUTH_FAULT_CODES = new Set([
  'service.AUTH_EXPIRED',
  'service.AUTH_REQUIRED',
  'account.AUTH_FAILED',
]);

@Injectable()
export class ZimbraService {
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

    // Parse a Zimbra SOAP fault from the axios error response body
    const fault = err?.response?.data?.Body?.Fault;
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

    // Network error, timeout, TLS failure, etc.
    this.logger.error(`[${context}] ${err.message}`);
    throw new BadGatewayException(
      `Could not reach the Zimbra server: ${err.message}`,
    );
  }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  async authenticate(
    host: string,
    email: string,
    password: string,
  ): Promise<ZimbraAuthResult> {
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
        refer,
        twoFactorRequired: twoFactorRequired || undefined,
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
  ): Promise<ZimbraAuthResult> {
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
        refer,
        displayName: authResponse.prefs?.pref?.find(
          (p: any) => p.name === 'zimbraPrefFromDisplay',
        )?._content,
      };
    } catch (err: any) {
      this.handleZimbraError(err, `verifyTwoFactor(${email})`);
    }
  }

  // ─── Folders ─────────────────────────────────────────────────────────────────

  async getFolders(host: string, authToken: string, csrfToken?: string): Promise<ZimbraFolder[]> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      // No folder filter → Zimbra returns the entire folder hierarchy from root.
      // Passing folder:{l:'1'} is fragile on some Zimbra versions / virtual accounts.
      const response = await client.post('/service/soap', {
        Body: {
          GetFolderRequest: {
            _jsns: 'urn:zimbraMail',
          },
        },
        Header: this.soapHeader(csrfToken),
      });

      const folders: ZimbraFolder[] = [];
      const root = response.data?.Body?.GetFolderResponse?.folder?.[0];
      if (root) this.flattenFolders(root, folders);
      return folders;
    } catch (err: any) {
      this.handleZimbraError(err, 'getFolders');
    }
  }

  private flattenFolders(node: any, acc: ZimbraFolder[]): void {
    // Guard: skip folders that lack an id (system virtual nodes in some setups)
    if (node.id == null) return;

    acc.push({
      id: String(node.id),              // Zimbra may return numeric IDs
      name: node.name ?? 'Unnamed',
      absFolderPath: node.absFolderPath ?? (node.name ? `/${node.name}` : '/'),
      u: typeof node.u === 'number' ? node.u : 0,
      n: typeof node.n === 'number' ? node.n : 0,
      color: node.color,
      l: node.l != null ? String(node.l) : undefined,
      view: node.view ?? undefined,
    });

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
    host: string,
    authToken: string,
    zimbraFolderId: string,
    limit = 50,
    offset = 0,
    csrfToken?: string,
  ): Promise<{ messages: ZimbraMessage[]; total: number; more: boolean }> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      // `inid:` searches by Zimbra folder ID (numeric).
      // `in:FolderName` is unreliable for non-ASCII names and doesn't accept IDs.
      const response = await client.post('/service/soap', {
        Body: {
          SearchRequest: {
            _jsns: 'urn:zimbraMail',
            types: 'message',
            query: `inid:${zimbraFolderId}`,
            sortBy: 'dateDesc',
            limit,
            offset,
            html: 1,
            needExp: 1,
          },
        },
        Header: this.soapHeader(csrfToken),
      });

      const result = response.data?.Body?.SearchResponse;
      const messages: ZimbraMessage[] = result?.m ?? [];
      const total: number = result?.total ?? messages.length;
      // `more` is Zimbra's authoritative flag; fall back to arithmetic estimate
      const more: boolean = result?.more === 1 || result?.more === true || messages.length + offset < total;
      return { messages, total, more };
    } catch (err: any) {
      this.handleZimbraError(err, `getMessages(folder=${zimbraFolderId})`);
    }
  }

  async getMessage(
    host: string,
    authToken: string,
    messageId: string,
    csrfToken?: string,
  ): Promise<ZimbraMessage> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          GetMsgRequest: {
            _jsns: 'urn:zimbraMail',
            m: { id: messageId, html: 1, needExp: 1, read: 1 },
          },
        },
        Header: this.soapHeader(csrfToken),
      });

      const msg = response.data?.Body?.GetMsgResponse?.m?.[0];
      if (!msg) throw new BadGatewayException('Message not found in Zimbra');
      return msg;
    } catch (err: any) {
      this.handleZimbraError(err, `getMessage(${messageId})`);
    }
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  async searchMessages(
    host: string,
    authToken: string,
    query: string,
    limit = 50,
    offset = 0,
    csrfToken?: string,
  ): Promise<{ messages: ZimbraMessage[]; total: number }> {
    const client = this.buildClient(host, authToken, csrfToken);
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
        Header: this.soapHeader(csrfToken),
      });

      const body = response.data?.Body?.SearchResponse;
      const messages: ZimbraMessage[] = body?.m ?? [];
      // Zimbra returns `more` flag and `total` estimate
      const total: number = body?.total ?? messages.length;
      return { messages, total };
    } catch (err: any) {
      this.handleZimbraError(err, `searchMessages("${query}")`);
      return { messages: [], total: 0 }; // unreachable but satisfies TS
    }
  }

  // ─── Send / Modify ───────────────────────────────────────────────────────────

  /**
   * Upload a single file to Zimbra's REST upload endpoint.
   * Returns the attachment ID (`aid`) that can be referenced in SendMsgRequest.
   */
  async uploadAttachment(
    host: string,
    authToken: string,
    buffer: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<string> {
    const baseURL = host.startsWith('http') ? host : `https://${host}`;
    let rawResponse = '';
    try {
      const res = await axios.post(
        `${baseURL}/service/upload?fmt=raw`,
        buffer,
        {
          // Force string response — Zimbra returns non-standard JS:
          // 200,'null',[{"aid":"...","filename":"...","ct":"..."}]
          responseType: 'text',
          headers: {
            Cookie: `ZM_AUTH_TOKEN=${authToken}`,
            'Content-Type': mimeType,
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
    host: string,
    authToken: string,
    payload: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body: string;
      replyToId?: string;
    },
    csrfToken?: string,
    attachmentAids: string[] = [],
  ): Promise<{ zimbraId: string; conversationId: string | null }> {
    const client = this.buildClient(host, authToken, csrfToken);
    const toAddrs  = payload.to.map((a) => ({ t: 't', a }));
    const ccAddrs  = (payload.cc  ?? []).map((a) => ({ t: 'c', a }));
    const bccAddrs = (payload.bcc ?? []).map((a) => ({ t: 'b', a }));

    try {
      const res = await client.post('/service/soap', {
        Body: {
          SendMsgRequest: {
            _jsns: 'urn:zimbraMail',
            m: {
              ...(payload.replyToId ? { origid: payload.replyToId } : {}),
              e: [...toAddrs, ...ccAddrs, ...bccAddrs],
              su: { _content: payload.subject },
              mp: {
                ct: 'text/html',
                content: { _content: payload.body },
              },
              // Attach pre-uploaded files by their Zimbra attachment IDs
              ...(attachmentAids.length > 0
                ? { attach: { aid: attachmentAids.join(',') } }
                : {}),
            },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
      const sent = res.data?.Body?.SendMsgResponse?.m?.[0];
      return {
        zimbraId:       sent?.id  != null ? String(sent.id)  : '',
        conversationId: sent?.cid != null ? String(sent.cid) : null,
      };
    } catch (err: any) {
      this.handleZimbraError(err, 'sendMessage');
    }
  }

  async deleteFolder(
    host: string,
    authToken: string,
    zimbraFolderId: string,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          FolderActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: zimbraFolderId, op: 'delete' },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `deleteFolder(${zimbraFolderId})`);
    }
  }

  async deleteMessage(
    host: string,
    authToken: string,
    messageId: string,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          MsgActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: messageId, op: 'trash' },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `deleteMessage(${messageId})`);
    }
  }

  async markRead(
    host: string,
    authToken: string,
    messageId: string,
    read: boolean,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          MsgActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: messageId, op: read ? 'read' : '!read' },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `markRead(${messageId}, ${read})`);
    }
  }

  async moveMessage(
    host: string,
    authToken: string,
    zimbraMessageId: string,
    targetZimbraFolderId: string,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          MsgActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: zimbraMessageId, op: 'move', l: targetZimbraFolderId },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `moveMessage(${zimbraMessageId} → ${targetZimbraFolderId})`);
    }
  }

  async createFolder(
    host: string,
    authToken: string,
    name: string,
    csrfToken?: string,
  ): Promise<{ id: string; name: string; absFolderPath: string }> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          CreateFolderRequest: {
            _jsns: 'urn:zimbraMail',
            folder: { name, l: '1', view: 'message' },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
      const f = response.data?.Body?.CreateFolderResponse?.folder?.[0];
      return {
        id: String(f.id),
        name: f.name,
        absFolderPath: f.absFolderPath ?? `/${f.name}`,
      };
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
    host: string,
    authToken: string,
    email: string,
    zimbraMessageId: string,
    partId: string,
  ): Promise<{ data: Buffer; contentType: string }> {
    const url = `https://${host}/service/home/${encodeURIComponent(email)}`;
    try {
      const response = await axios.get(url, {
        params: { id: zimbraMessageId, part: partId, disp: 'a', auth: 'qp', zauthtoken: authToken },
        responseType: 'arraybuffer',
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        timeout: 15_000,
      });
      const contentType: string = response.headers['content-type'] ?? 'application/octet-stream';
      return { data: Buffer.from(response.data as ArrayBuffer), contentType };
    } catch (err: any) {
      this.logger.error(`downloadAttachmentBuffer failed for msg=${zimbraMessageId} part=${partId}: ${err?.message}`);
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
    host: string,
    authToken: string,
    email: string,
    zimbraMessageId: string,
    partId: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; filename: string }> {
    const url = `https://${host}/service/home/${encodeURIComponent(email)}`;
    try {
      const response = await axios.get(url, {
        params: {
          id:         zimbraMessageId,
          part:       partId,
          disp:       'a',
          auth:       'qp',
          zauthtoken: authToken,
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
      const filename = filenameMatch?.[2] ?? `attachment_${partId}`;

      return { stream: response.data, contentType, filename };
    } catch (err: any) {
      this.logger.error(`downloadAttachment failed for msg=${zimbraMessageId} part=${partId}: ${err?.message}`);
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
    host: string,
    authToken: string,
    query: string,
    csrfToken?: string,
  ): Promise<Array<{ email: string; display: string }>> {
    if (!query || !query.trim()) return [];
    const client = this.buildClient(host, authToken, csrfToken);
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
        Header: this.soapHeader(csrfToken),
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
    host: string,
    authToken: string,
    csrfToken?: string,
  ): Promise<any[]> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          SearchRequest: {
            _jsns: 'urn:zimbraMail',
            types: 'contact',
            query: 'in:/Contacts',
            limit: 500,
            offset: 0,
          },
        },
        Header: this.soapHeader(csrfToken),
      });
      return response.data?.Body?.SearchResponse?.cn ?? [];
    } catch (err: any) {
      this.handleZimbraError(err, 'getContacts');
    }
  }

  async createContact(
    host: string,
    authToken: string,
    attrs: Array<{ n: string; _content: string }>,
    csrfToken?: string,
  ): Promise<string> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      const response = await client.post('/service/soap', {
        Body: {
          CreateContactRequest: {
            _jsns: 'urn:zimbraMail',
            cn: { a: attrs },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
      const id = response.data?.Body?.CreateContactResponse?.cn?.[0]?.id;
      if (!id) throw new BadGatewayException('Zimbra did not return a contact ID');
      return String(id);
    } catch (err: any) {
      this.handleZimbraError(err, 'createContact');
    }
  }

  async modifyContact(
    host: string,
    authToken: string,
    zimbraId: string,
    attrs: Array<{ n: string; _content: string }>,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          ModifyContactRequest: {
            _jsns: 'urn:zimbraMail',
            replace: 1,
            cn: { id: zimbraId, a: attrs },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `modifyContact(${zimbraId})`);
    }
  }

  async deleteContact(
    host: string,
    authToken: string,
    zimbraId: string,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          ContactActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: zimbraId, op: 'trash' },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `deleteContact(${zimbraId})`);
    }
  }

  // ─── Drafts ───────────────────────────────────────────────────────────────────

  /**
   * Save or update a draft using Zimbra's SaveDraftRequest.
   * Pass `payload.id` to update an existing draft; omit it to create a new one.
   * Returns the Zimbra message ID of the saved draft.
   */
  async saveDraft(
    host: string,
    authToken: string,
    payload: {
      id?: string;
      to?: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      body?: string;
    },
    csrfToken?: string,
  ): Promise<string> {
    const client = this.buildClient(host, authToken, csrfToken);

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
      mp: [{ ct: 'text/html', content: { _content: payload.body ?? '' } }],
    };

    try {
      const response = await client.post('/service/soap', {
        Body: { SaveDraftRequest: { _jsns: 'urn:zimbraMail', m } },
        Header: this.soapHeader(csrfToken),
      });
      const id = response.data?.Body?.SaveDraftResponse?.m?.[0]?.id;
      if (!id) throw new BadGatewayException('Zimbra did not return a draft ID');
      return String(id);
    } catch (err: any) {
      this.handleZimbraError(err, 'saveDraft');
    }
  }

  // ─── Calendar ─────────────────────────────────────────────────────────────────

  async getCalendarEvents(
    host: string,
    authToken: string,
    startMs: number,
    endMs: number,
    csrfToken?: string,
  ): Promise<any[]> {
    const client = this.buildClient(host, authToken, csrfToken);
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
        Header: this.soapHeader(csrfToken),
      });
      return response.data?.Body?.SearchResponse?.appt ?? [];
    } catch (err: any) {
      this.handleZimbraError(err, 'getCalendarEvents');
    }
  }

  async createCalendarEvent(
    host: string,
    authToken: string,
    payload: {
      title: string;
      location?: string;
      startAt: Date;
      endAt: Date;
      allDay: boolean;
      description?: string;
      organizerEmail: string;
      organizerName?: string;
      attendees?: string[];
    },
    csrfToken?: string,
  ): Promise<string> {
    const client = this.buildClient(host, authToken, csrfToken);

    const pad = (n: number) => String(n).padStart(2, '0');
    const fmtDt = (d: Date, allDay: boolean) => {
      if (allDay) {
        return {
          d: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`,
        };
      }
      return {
        d:
          `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
          `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`,
      };
    };

    const or = {
      a: payload.organizerEmail,
      ...(payload.organizerName ? { p: payload.organizerName } : {}),
    };

    const at = (payload.attendees ?? []).map((email) => ({
      a: email,
      role: 'REQ',
      ptst: 'NE',
      rsvp: 1,
    }));

    try {
      const response = await client.post('/service/soap', {
        Body: {
          CreateAppointmentRequest: {
            _jsns: 'urn:zimbraMail',
            m: {
              su: payload.title,
              e: [{ t: 'f', ...or }],
              inv: {
                comp: [
                  {
                    name: payload.title,
                    loc: payload.location ?? '',
                    allDay: payload.allDay ? 1 : 0,
                    fb: 'B',
                    transp: 'O',
                    s: fmtDt(payload.startAt, payload.allDay),
                    e: fmtDt(payload.endAt, payload.allDay),
                    or,
                    ...(at.length ? { at } : {}),
                    ...(payload.description
                      ? { desc: { _content: payload.description } }
                      : {}),
                  },
                ],
              },
            },
          },
        },
        Header: this.soapHeader(csrfToken),
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
    host: string,
    authToken: string,
    zimbraId: string,
    payload: {
      title: string;
      location?: string;
      startAt: Date;
      endAt: Date;
      allDay: boolean;
      description?: string;
      organizerEmail: string;
      organizerName?: string;
      attendees?: string[];
    },
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);

    const pad = (n: number) => String(n).padStart(2, '0');
    const fmtDt = (d: Date, allDay: boolean) => {
      if (allDay) {
        return { d: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` };
      }
      return {
        d:
          `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
          `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`,
      };
    };

    const or = {
      a: payload.organizerEmail,
      ...(payload.organizerName ? { p: payload.organizerName } : {}),
    };

    const at = (payload.attendees ?? []).map((email) => ({
      a: email,
      role: 'REQ',
      ptst: 'NE',
      rsvp: 1,
    }));

    try {
      await client.post('/service/soap', {
        Body: {
          ModifyAppointmentRequest: {
            _jsns: 'urn:zimbraMail',
            id: zimbraId,
            m: {
              su: payload.title,
              e: [{ t: 'f', ...or }],
              inv: {
                comp: [
                  {
                    name: payload.title,
                    loc: payload.location ?? '',
                    allDay: payload.allDay ? 1 : 0,
                    fb: 'B',
                    transp: 'O',
                    s: fmtDt(payload.startAt, payload.allDay),
                    e: fmtDt(payload.endAt, payload.allDay),
                    or,
                    ...(at.length ? { at } : {}),
                    ...(payload.description
                      ? { desc: { _content: payload.description } }
                      : {}),
                  },
                ],
              },
            },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `modifyCalendarEvent(${zimbraId})`);
    }
  }

  async sendInviteReply(
    host: string,
    authToken: string,
    zimbraId: string,
    verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE',
    subject: string,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          SendInviteReplyRequest: {
            _jsns: 'urn:zimbraMail',
            id: zimbraId,
            verb,
            updateOrganizer: '1',
            m: { su: `Re: ${subject}` },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `sendInviteReply(${zimbraId}, ${verb})`);
    }
  }

  async deleteCalendarEvent(
    host: string,
    authToken: string,
    zimbraId: string,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          ItemActionRequest: {
            _jsns: 'urn:zimbraMail',
            action: { id: zimbraId, op: 'trash' },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, `deleteCalendarEvent(${zimbraId})`);
    }
  }

  // ─── Account Preferences & Settings ─────────────────────────────────────────

  /** Fetch all user preferences as a flat key → value map. */
  async getPrefs(
    host: string,
    authToken: string,
    csrfToken?: string,
  ): Promise<Record<string, string>> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      const res = await client.post('/service/soap', {
        Body: { GetPrefsRequest: { _jsns: 'urn:zimbraAccount' } },
        Header: this.soapHeader(csrfToken),
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
  async modifyPrefs(
    host: string,
    authToken: string,
    prefs: Record<string, string>,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
    const pref = Object.entries(prefs).map(([name, _content]) => ({ name, _content }));
    try {
      await client.post('/service/soap', {
        Body: { ModifyPrefsRequest: { _jsns: 'urn:zimbraAccount', pref } },
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, 'modifyPrefs');
    }
  }

  /** Return all user identities (primary + aliases). */
  async getIdentities(
    host: string,
    authToken: string,
    csrfToken?: string,
  ): Promise<Array<{ id: string; name: string; attrs: Record<string, string> }>> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      const res = await client.post('/service/soap', {
        Body: { GetIdentitiesRequest: { _jsns: 'urn:zimbraAccount' } },
        Header: this.soapHeader(csrfToken),
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
    host: string,
    authToken: string,
    identityId: string,
    attrs: Record<string, string>,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
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
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, 'modifyIdentity');
    }
  }

  /** Return all email signatures. */
  async getSignatures(
    host: string,
    authToken: string,
    csrfToken?: string,
  ): Promise<Array<{ id: string; name: string; contentHtml: string; contentText: string }>> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      const res = await client.post('/service/soap', {
        Body: { GetSignaturesRequest: { _jsns: 'urn:zimbraAccount' } },
        Header: this.soapHeader(csrfToken),
      });
      const sigs: any[] = res.data?.Body?.GetSignaturesResponse?.signature ?? [];
      return sigs.map((s: any) => {
        const contents: any[] = Array.isArray(s.content) ? s.content : [];
        return {
          id:          String(s.id ?? ''),
          name:        s.name ?? '',
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
    host: string,
    authToken: string,
    name: string,
    contentHtml: string,
    csrfToken?: string,
  ): Promise<string> {
    const client = this.buildClient(host, authToken, csrfToken);
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
        Header: this.soapHeader(csrfToken),
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
    host: string,
    authToken: string,
    signatureId: string,
    name: string,
    contentHtml: string,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
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
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, 'modifySignature');
    }
  }

  /** Delete a signature by Zimbra ID. */
  async deleteSignature(
    host: string,
    authToken: string,
    signatureId: string,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          DeleteSignatureRequest: {
            _jsns: 'urn:zimbraAccount',
            signature: { id: signatureId },
          },
        },
        Header: this.soapHeader(csrfToken),
      });
    } catch (err: any) {
      this.handleZimbraError(err, 'deleteSignature');
    }
  }

  /** Change the user's Zimbra account password. */
  async changePassword(
    host: string,
    authToken: string,
    accountEmail: string,
    oldPassword: string,
    newPassword: string,
    csrfToken?: string,
  ): Promise<void> {
    const client = this.buildClient(host, authToken, csrfToken);
    try {
      await client.post('/service/soap', {
        Body: {
          ChangePasswordRequest: {
            _jsns: 'urn:zimbraAccount',
            account:     { by: 'name', _content: accountEmail },
            oldPassword,
            password:    newPassword,
          },
        },
        Header: this.soapHeader(csrfToken),
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
    host: string,
    authToken: string,
    query: string,
    csrfToken?: string,
  ): Promise<Array<{ email: string; display: string }>> {
    if (!query || !query.trim()) return [];
    const client = this.buildClient(host, authToken, csrfToken);
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
        Header: this.soapHeader(csrfToken),
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

  // ─── Free / Busy ──────────────────────────────────────────────────────────────

  /**
   * Query free/busy data for a user on the same Zimbra server.
   * Returns arrays of { s, e } millisecond timestamp pairs for busy,
   * tentative, and unavailable (out-of-office) intervals.
   */
  async getFreeBusy(
    host: string,
    authToken: string,
    email: string,
    startMs: number,
    endMs: number,
    csrfToken?: string,
  ): Promise<{
    busy:        Array<{ s: number; e: number }>;
    tentative:   Array<{ s: number; e: number }>;
    unavailable: Array<{ s: number; e: number }>;
  }> {
    const client = this.buildClient(host, authToken, csrfToken);
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
        Header: this.soapHeader(csrfToken),
      });

      const usr = response.data?.Body?.GetFreeBusyResponse?.usr?.[0] ?? {};
      const norm = (arr: any): Array<{ s: number; e: number }> =>
        Array.isArray(arr)
          ? arr.map((i: any) => ({ s: Number(i.s), e: Number(i.e) }))
          : [];

      return {
        busy:        norm(usr.b),
        tentative:   norm(usr.t),
        unavailable: norm(usr.u),
      };
    } catch (err: any) {
      this.handleZimbraError(err, `getFreeBusy(${email})`);
    }
  }
}
