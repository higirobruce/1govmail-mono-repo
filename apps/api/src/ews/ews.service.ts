import { Logger, UnauthorizedException } from '@nestjs/common';
import { MailSession } from '../provider/mail-session';
import {
  ProviderFolder, ProviderMessage, ProviderMessagePage, ProviderContact,
  ProviderEvent, ProviderEventDetail, ProviderFreeBusy, ProviderAuthResult,
  MailProviderCapabilities, ProviderIdentity, ProviderSignature,
} from '../provider/provider-types';
import {
  SendMessagePayload, DraftPayload, CalendarEventPayload, ModifyCalendarEventPayload,
} from '../provider/mail-provider.interface';
import { CapabilityNotSupportedError } from '../provider/capability.error';
import { EwsCrypto } from './ews-crypto';
import { getFolderEnvelope, soapEnvelope, xmlEscape } from './ews-envelopes';
import { parseEws, responseClassOf } from './ews-parse';
import { EwsTransport, handleEwsError, inspectEwsXml } from './ews-transport';

/**
 * Session lifetime handed back from `authenticate`. EWS/NTLM has no
 * server-issued token TTL — every call re-presents the stored credentials — so
 * this is purely how long the app's own JWT session stays valid before a fresh
 * login. Pinned to 8h to match a working day; AuthService.createSession writes
 * it to User.tokenExpiry, which JwtStrategy enforces per request.
 */
const EWS_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

/** Cap on how long we will honour a server's BackOffMilliseconds before the
 *  single retry, so a hostile/huge value cannot stall a request indefinitely. */
const MAX_BACKOFF_MS = 30_000;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * EWS (Exchange Web Services) mail provider.
 *
 * Task 3 builds the skeleton: credential handling, the NTLM transport wiring,
 * error mapping, and the `authenticate` probe. Tasks 4-7 fill the folder /
 * message / contact / calendar methods, and Task 7 adds `implements
 * MailProvider` once every method is real. The method list is already complete
 * here (all stubbed) so that clause can be added without touching the surface.
 *
 * SECURITY: the constructor asserts `MAIL_CRED_KEY` up front — an EWS provider
 * with no key cannot encrypt the credentials it is about to store, and failing
 * fast at construction beats discovering it mid-login. `authenticate` returns
 * an `authToken` that is `EwsCrypto.encrypt(JSON({username, password}))`, the
 * exact blob `buildMailSession` decrypts back into `session.credentials`.
 */
export class EwsService {
  readonly name = 'ews' as const;
  readonly capabilities: MailProviderCapabilities = {
    signatures: false,
    identities: false,
    serverPrefs: false,
    changePassword: false,
    twoFactor: false,
  };

  private readonly logger = new Logger(EwsService.name);
  private readonly crypto: EwsCrypto;

  constructor(private readonly transport: EwsTransport = new EwsTransport()) {
    if (!process.env.MAIL_CRED_KEY) {
      throw new Error(
        'EwsService: MAIL_CRED_KEY is required to encrypt EWS mailbox credentials.',
      );
    }
    // Constructing EwsCrypto here also fails fast on a malformed key.
    this.crypto = new EwsCrypto();
  }

  // ── auth ────────────────────────────────────────────────────────────────

  /**
   * Derive the NTLM login name.
   *  - a value already shaped like `DOMAIN\user` is passed through untouched
   *    (a user typed it deliberately);
   *  - otherwise, when an `ntlmDomain` is supplied, prepend it to the email's
   *    local part → `DOMAIN\localpart`;
   *  - with neither, use the email verbatim (some Exchange deployments accept
   *    UPN-style `user@domain` for NTLM).
   */
  private deriveNtlmUsername(input: string, ntlmDomain?: string): string {
    if (input.includes('\\')) return input;
    if (ntlmDomain) {
      const localpart = input.includes('@') ? input.slice(0, input.indexOf('@')) : input;
      return `${ntlmDomain}\\${localpart}`;
    }
    return input;
  }

  /**
   * Run `body` against the endpoint with a single ErrorServerBusy retry.
   * HTTP-level failures (401, fault, network) throw from inside
   * `transport.call`. A SOAP-level `ResponseClass="Error"` comes back as XML;
   * if it is ErrorServerBusy we honour BackOffMilliseconds and retry exactly
   * once, otherwise (or if still failing) we funnel through `handleEwsError`.
   */
  private async callWithRetry(session: MailSession, body: string): Promise<string> {
    let xml = await this.transport.call(session, body);
    const err = inspectEwsXml(xml);
    if (!err) return xml;

    if (err.responseCode === 'ErrorServerBusy') {
      await delay(Math.min(err.backoffMs ?? 0, MAX_BACKOFF_MS));
      xml = await this.transport.call(session, body);
      const retryErr = inspectEwsXml(xml);
      if (!retryErr) return xml;
      handleEwsError(200, xml); // still failing after the one retry
    }

    handleEwsError(200, xml); // any other Error/fault
  }

  async authenticate(
    host: string,
    email: string,
    password: string,
    opts?: { ntlmDomain?: string },
  ): Promise<ProviderAuthResult> {
    const username = this.deriveNtlmUsername(email, opts?.ntlmDomain);
    const session: MailSession = { host, email, credentials: { username, password } };

    // GetFolder(inbox) is the cheap, side-effect-free probe that proves the
    // NTLM credentials work. Bad credentials surface as HTTP 401 → Unauthorized.
    const probeXml = await this.callWithRetry(session, getFolderEnvelope('inbox'));
    const probeMsg = this.firstResponseMessage(probeXml);
    if (!probeMsg || responseClassOf(probeMsg) !== 'Success') {
      throw new UnauthorizedException('EWS sign-in failed. Check your username and password.');
    }

    const displayName = await this.resolveDisplayName(session, email);

    return {
      authToken: this.crypto.encrypt(JSON.stringify({ username, password })),
      lifetime: EWS_SESSION_LIFETIME_MS,
      displayName,
      twoFactorRequired: false,
    };
  }

  /** EWS is single-leg NTLM — it never issues a 2FA challenge, so this leg is
   *  unreachable in practice; declaring the capability off and throwing here
   *  makes an accidental call loud instead of silent. */
  async verifyTwoFactor(
    _host: string, _email: string, _preAuthToken: string, _twoFactorCode: string,
  ): Promise<ProviderAuthResult> {
    throw new CapabilityNotSupportedError('two-factor authentication');
  }

  /** Best-effort friendly name via ResolveNames. NEVER fails the login: any
   *  error (including a SOAP fault or a mailbox that will not resolve) falls
   *  back to the email address. */
  private async resolveDisplayName(session: MailSession, email: string): Promise<string> {
    try {
      const body =
        '<m:ResolveNames ReturnFullContactData="false">' +
        `<m:UnresolvedEntry>${xmlEscape(email)}</m:UnresolvedEntry>` +
        '</m:ResolveNames>';
      const xml = await this.transport.call(session, soapEnvelope(body));
      if (inspectEwsXml(xml)) return email;
      const tree = parseEws(xml);
      const name = this.deepFindString(tree, 'Name');
      return name && name.trim() ? name.trim() : email;
    } catch {
      return email;
    }
  }

  // ── parse helpers (local; broader ops land with Tasks 4-7) ────────────────

  private firstResponseMessage(xml: string): any {
    const tree = parseEws(xml);
    return this.deepFindNode(tree, (n) => n['@_ResponseClass'] !== undefined);
  }

  private deepFindNode(obj: any, pred: (n: any) => boolean): any {
    if (!obj || typeof obj !== 'object') return undefined;
    if (pred(obj)) return obj;
    for (const k of Object.keys(obj)) {
      const found = this.deepFindNode(obj[k], pred);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private deepFindString(obj: any, key: string): string | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    if (typeof obj[key] === 'string') return obj[key];
    for (const k of Object.keys(obj)) {
      const found = this.deepFindString(obj[k], key);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  // ── not-yet-implemented MailProvider surface (Tasks 4-7) ──────────────────
  // Listed in full so Task 7 can add `implements MailProvider` with no surface
  // change. Each throws until its task lands.

  private notImplemented(method: string): never {
    throw new Error(`EWS ${method}: not implemented`);
  }

  // folders
  getFolders(_s: MailSession): Promise<ProviderFolder[]> { return this.notImplemented('getFolders'); }
  createFolder(_s: MailSession, _name: string, _parentId?: string): Promise<ProviderFolder> { return this.notImplemented('createFolder'); }
  deleteFolder(_s: MailSession, _folderId: string): Promise<void> { return this.notImplemented('deleteFolder'); }
  renameFolder(_s: MailSession, _folderId: string, _name: string): Promise<void> { return this.notImplemented('renameFolder'); }
  emptyFolder(_s: MailSession, _folderId: string): Promise<void> { return this.notImplemented('emptyFolder'); }

  // messages
  getMessages(_s: MailSession, _folderId: string, _limit?: number, _offset?: number): Promise<ProviderMessagePage> { return this.notImplemented('getMessages'); }
  getMessage(_s: MailSession, _messageId: string): Promise<ProviderMessage> { return this.notImplemented('getMessage'); }
  searchMessages(_s: MailSession, _query: string, _limit?: number, _offset?: number): Promise<ProviderMessagePage> { return this.notImplemented('searchMessages'); }
  sendMessage(
    _s: MailSession, _payload: SendMessagePayload,
    _attachmentAids?: string[],
    _inlineImageAids?: Array<{ aid: string; cid: string; ct: string }>,
    _forwardedAttachments?: Array<{ mid: string; part: string }>,
  ): Promise<{ id: string; conversationId: string | null }> { return this.notImplemented('sendMessage'); }
  saveDraft(_s: MailSession, _payload: DraftPayload): Promise<string> { return this.notImplemented('saveDraft'); }
  deleteMessage(_s: MailSession, _messageId: string): Promise<void> { return this.notImplemented('deleteMessage'); }
  markRead(_s: MailSession, _messageId: string, _read: boolean): Promise<void> { return this.notImplemented('markRead'); }
  moveMessage(_s: MailSession, _messageId: string, _folderId: string): Promise<void> { return this.notImplemented('moveMessage'); }

  // attachments
  uploadAttachment(_s: MailSession, _filename: string, _contentType: string, _data: Buffer): Promise<string> { return this.notImplemented('uploadAttachment'); }
  downloadAttachment(_s: MailSession, _messageId: string, _part: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string; filename: string }> { return this.notImplemented('downloadAttachment'); }
  downloadAttachmentBuffer(_s: MailSession, _messageId: string, _part: string): Promise<{ data: Buffer; contentType: string }> { return this.notImplemented('downloadAttachmentBuffer'); }

  // contacts + GAL
  getContacts(_s: MailSession, _limit?: number, _offset?: number): Promise<ProviderContact[]> { return this.notImplemented('getContacts'); }
  createContact(_s: MailSession, _contact: Partial<ProviderContact>): Promise<ProviderContact> { return this.notImplemented('createContact'); }
  modifyContact(_s: MailSession, _id: string, _contact: Partial<ProviderContact>): Promise<void> { return this.notImplemented('modifyContact'); }
  deleteContact(_s: MailSession, _id: string): Promise<void> { return this.notImplemented('deleteContact'); }
  autoCompleteContacts(_s: MailSession, _query: string): Promise<Array<{ email: string; display: string }>> { return this.notImplemented('autoCompleteContacts'); }
  searchGal(_s: MailSession, _query: string): Promise<Array<{ email: string; display: string }>> { return this.notImplemented('searchGal'); }

  // calendar
  getCalendarEvents(_s: MailSession, _startMs: number, _endMs: number): Promise<ProviderEvent[]> { return this.notImplemented('getCalendarEvents'); }
  getAppointment(_s: MailSession, _id: string): Promise<ProviderEventDetail | null> { return this.notImplemented('getAppointment'); }
  createCalendarEvent(_s: MailSession, _payload: CalendarEventPayload): Promise<string> { return this.notImplemented('createCalendarEvent'); }
  modifyCalendarEvent(_s: MailSession, _id: string, _payload: ModifyCalendarEventPayload): Promise<void> { return this.notImplemented('modifyCalendarEvent'); }
  deleteCalendarEvent(_s: MailSession, _id: string): Promise<void> { return this.notImplemented('deleteCalendarEvent'); }
  sendInviteReply(_s: MailSession, _inviteId: string, _verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE'): Promise<void> { return this.notImplemented('sendInviteReply'); }
  getFreeBusy(_s: MailSession, _email: string, _startMs: number, _endMs: number): Promise<ProviderFreeBusy> { return this.notImplemented('getFreeBusy'); }

  // settings-surface (capability-gated)
  getPrefs(_s: MailSession): Promise<Record<string, string>> { return this.notImplemented('getPrefs'); }
  modifyPrefs(_s: MailSession, _prefs: Record<string, string>): Promise<void> { return this.notImplemented('modifyPrefs'); }
  getIdentities(_s: MailSession): Promise<ProviderIdentity[]> { return this.notImplemented('getIdentities'); }
  modifyIdentity(_s: MailSession, _id: string, _attrs: Record<string, string>): Promise<void> { return this.notImplemented('modifyIdentity'); }
  getSignatures(_s: MailSession): Promise<ProviderSignature[]> { return this.notImplemented('getSignatures'); }
  createSignature(_s: MailSession, _name: string, _contentHtml: string): Promise<string> { return this.notImplemented('createSignature'); }
  modifySignature(_s: MailSession, _id: string, _name: string, _contentHtml: string): Promise<void> { return this.notImplemented('modifySignature'); }
  deleteSignature(_s: MailSession, _id: string): Promise<void> { return this.notImplemented('deleteSignature'); }
  changePassword(_s: MailSession, _oldPassword: string, _newPassword: string): Promise<void> { return this.notImplemented('changePassword'); }
}
