import ms from 'ms';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { MailSession } from '../provider/mail-session';
import {
  ProviderFolder, ProviderMessage, ProviderMessagePage, ProviderContact,
  ProviderEvent, ProviderEventDetail, ProviderFreeBusy, ProviderAuthResult,
  MailProviderCapabilities, ProviderIdentity, ProviderSignature,
  ProviderAddress, ProviderAttachmentMeta, ProviderFolderKind,
} from '../provider/provider-types';
import {
  SendMessagePayload, DraftPayload, CalendarEventPayload, ModifyCalendarEventPayload,
} from '../provider/mail-provider.interface';
import { CapabilityNotSupportedError } from '../provider/capability.error';
import { EwsCrypto } from './ews-crypto';
import {
  getFolderEnvelope, soapEnvelope, xmlEscape,
  findFolderEnvelope, findItemEnvelope, searchItemEnvelope, getItemEnvelope,
  createFolderEnvelope, deleteFolderEnvelope, renameFolderEnvelope, emptyFolderEnvelope,
} from './ews-envelopes';
import {
  parseEws, responseClassOf, toArray, toBool, textOf,
} from './ews-parse';
import { EwsTransport, handleEwsError, inspectEwsXml } from './ews-transport';

/**
 * Fallback session lifetime (7d) — matches the JWT module's own default for
 * `JWT_EXPIRES_IN` (see auth.module.ts). Used only when the env var is
 * missing or unparseable.
 */
const DEFAULT_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Session lifetime `authenticate` returns → written to `User.tokenExpiry`
 * (AuthService.createSession), which JwtStrategy enforces per request.
 *
 * EWS/NTLM has no server-issued token TTL — every call re-presents the stored
 * credentials, and the encrypted credential blob sits at rest until logout
 * regardless — so the ONLY thing this governs is when the app's own JWT
 * session expires. Spec §5.2: "Set tokenExpiry to the JWT expiry." So we
 * derive it from the SAME env the JWT module signs with (`JWT_EXPIRES_IN`,
 * default '7d'); hardcoding a shorter value would force EWS users to
 * re-authenticate while their JWT is still valid, for no security benefit.
 *
 * Parsed via the `ms` package (already a transitive dep of @nestjs/jwt, which
 * uses it to interpret the very same value): accepts '7d' / '24h' / '30m' etc.
 * and a bare number (milliseconds). Anything unparseable → 7d fallback.
 */
function ewsSessionLifetimeMs(): number {
  const raw = process.env.JWT_EXPIRES_IN;
  if (!raw) return DEFAULT_SESSION_LIFETIME_MS;
  try {
    const parsed = ms(raw as ms.StringValue);
    return typeof parsed === 'number' && parsed > 0 ? parsed : DEFAULT_SESSION_LIFETIME_MS;
  } catch {
    return DEFAULT_SESSION_LIFETIME_MS;
  }
}

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
      lifetime: ewsSessionLifetimeMs(),
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

  // ── EWS → neutral DTO mappers (Task 4) ────────────────────────────────────

  /** Default page size when a caller omits `limit`. Mirrors the app's list
   *  pages; the server caps its own view regardless. */
  private static readonly DEFAULT_PAGE_SIZE = 50;

  private normLimit(limit?: number): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
      return EwsService.DEFAULT_PAGE_SIZE;
    }
    return Math.trunc(limit);
  }

  private normOffset(offset?: number): number {
    if (typeof offset !== 'number' || !Number.isFinite(offset) || offset <= 0) return 0;
    return Math.trunc(offset);
  }

  private numOr(value: any, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Navigate `Envelope.Body.<responseTag>.ResponseMessages.<messageTag>` on a
   *  parsed tree. The ResponseClass has already been vetted by callWithRetry
   *  (any Error threw before we get here), so this only has to locate the node.
   */
  private responseMessageNode(doc: any, responseTag: string, messageTag: string): any {
    return doc?.Envelope?.Body?.[responseTag]?.ResponseMessages?.[messageTag];
  }

  /** Well-known Exchange English display names → the app's folder `type`. Any
   *  other folder is a user folder → 'custom'. */
  private folderTypeOf(displayName: string | undefined): string {
    switch ((displayName ?? '').trim().toLowerCase()) {
      case 'inbox': return 'inbox';
      case 'sent items': return 'sent';
      case 'drafts': return 'drafts';
      case 'deleted items': return 'trash';
      case 'junk email': return 'junk';
      default: return 'custom';
    }
  }

  private mapFolder(f: any): ProviderFolder {
    const name = textOf(f?.DisplayName) ?? '';
    const kind: ProviderFolderKind = 'mail';
    return {
      id: f?.FolderId?.['@_Id'] ?? '',
      name,
      path: name,
      type: this.folderTypeOf(name),
      kind,
      unreadCount: this.numOr(f?.UnreadCount, 0),
      totalCount: this.numOr(f?.TotalCount, 0),
      parentId: f?.ParentFolderId?.['@_Id'],
    };
  }

  /** A single `<t:Mailbox>` node → ProviderAddress. */
  private mapMailbox(mb: any): ProviderAddress {
    const email = textOf(mb?.EmailAddress) ?? '';
    const name = textOf(mb?.Name);
    return name ? { email, name } : { email };
  }

  /** A recipients container (`ToRecipients`/`CcRecipients`/`BccRecipients`),
   *  whose `Mailbox` may be absent, one object, or an array. */
  private mapMailboxList(container: any): ProviderAddress[] {
    return toArray(container?.Mailbox).map((mb) => this.mapMailbox(mb));
  }

  /** The fields shared by a FindItem summary and a GetItem message. cc/bcc are
   *  left empty here (FindItem does not request them) and filled by getMessage.
   */
  private mapMessageSummary(item: any, folderId: string): ProviderMessage {
    const from = item?.From?.Mailbox
      ? this.mapMailbox(item.From.Mailbox)
      : { email: '' };
    const subjectText = textOf(item?.Subject);
    return {
      id: item?.ItemId?.['@_Id'] ?? '',
      conversationId: item?.ConversationId?.['@_Id'] ?? null,
      folderId: item?.ParentFolderId?.['@_Id'] ?? folderId,
      subject: subjectText === undefined ? null : subjectText,
      snippet: textOf(item?.Preview) ?? null,
      from,
      to: this.mapMailboxList(item?.ToRecipients),
      cc: [],
      bcc: [],
      receivedAt: new Date(textOf(item?.DateTimeReceived) ?? 0),
      size: this.numOr(item?.Size, 0),
      isRead: toBool(item?.IsRead),
      isFlagged: (textOf(item?.Flag?.FlagStatus) ?? '') === 'Flagged',
      hasAttachments: toBool(item?.HasAttachments),
      isDraft: false,
      tags: [],
    };
  }

  private mapAttachment(a: any): ProviderAttachmentMeta {
    const contentId = textOf(a?.ContentId);
    const meta: ProviderAttachmentMeta = {
      part: a?.AttachmentId?.['@_Id'] ?? '',
      filename: textOf(a?.Name) ?? '',
      contentType: textOf(a?.ContentType) ?? 'application/octet-stream',
      size: this.numOr(a?.Size, 0),
      isInline: toBool(a?.IsInline),
    };
    if (contentId) meta.contentId = contentId;
    return meta;
  }

  /** Shared FindItem response → ProviderMessagePage. `total` is the server's
   *  TotalItemsInView; `more` = the window did not reach the end. */
  private parseMessagePage(xml: string, offset: number, folderId: string): ProviderMessagePage {
    const doc = parseEws(xml);
    const rm = this.responseMessageNode(doc, 'FindItemResponse', 'FindItemResponseMessage');
    const root = rm?.RootFolder;
    const items = toArray(root?.Items?.Message);
    const messages = items.map((it) => this.mapMessageSummary(it, folderId));
    const total = this.numOr(root?.['@_TotalItemsInView'], messages.length);
    const more = offset + messages.length < total;
    return { messages, total, more };
  }

  // ── not-yet-implemented MailProvider surface (Tasks 5-7) ──────────────────
  // Listed in full so Task 7 can add `implements MailProvider` with no surface
  // change. Each throws until its task lands.

  private notImplemented(method: string): never {
    throw new Error(`EWS ${method}: not implemented`);
  }

  // folders (Task 4) ─────────────────────────────────────────────────────────

  /**
   * FindFolder Deep from `msgfolderroot` (spec §5.3). Maps every folder in the
   * mail tree to a neutral ProviderFolder, resolving the well-known display
   * names to the app's folder `type` and stamping `kind: 'mail'`.
   */
  async getFolders(session: MailSession): Promise<ProviderFolder[]> {
    const xml = await this.callWithRetry(session, findFolderEnvelope());
    const doc = parseEws(xml);
    const rm = this.responseMessageNode(doc, 'FindFolderResponse', 'FindFolderResponseMessage');
    const folders = toArray(rm?.RootFolder?.Folders?.Folder);
    return folders.map((f) => this.mapFolder(f));
  }

  /** CreateFolder under `parentId` (or `msgfolderroot`) — returns the new,
   *  empty folder as a ProviderFolder (spec §5.3). */
  async createFolder(session: MailSession, name: string, parentId?: string): Promise<ProviderFolder> {
    const xml = await this.callWithRetry(session, createFolderEnvelope(name, parentId));
    const doc = parseEws(xml);
    const rm = this.responseMessageNode(doc, 'CreateFolderResponse', 'CreateFolderResponseMessage');
    const folder = toArray(rm?.Folders?.Folder)[0];
    const id = folder?.FolderId?.['@_Id'] ?? '';
    const displayName = textOf(folder?.DisplayName) ?? name;
    return {
      id,
      name: displayName,
      path: displayName,
      type: 'custom',
      kind: 'mail',
      unreadCount: this.numOr(folder?.UnreadCount, 0),
      totalCount: this.numOr(folder?.TotalCount, 0),
      parentId,
    };
  }

  /** DeleteFolder HardDelete (spec §5.3). */
  async deleteFolder(session: MailSession, folderId: string): Promise<void> {
    await this.callWithRetry(session, deleteFolderEnvelope(folderId));
  }

  /** UpdateFolder folder:DisplayName (spec §5.3). */
  async renameFolder(session: MailSession, folderId: string, name: string): Promise<void> {
    await this.callWithRetry(session, renameFolderEnvelope(folderId, name));
  }

  /** EmptyFolder MoveToDeletedItems, keeping subfolders (spec §5.3). */
  async emptyFolder(session: MailSession, folderId: string): Promise<void> {
    await this.callWithRetry(session, emptyFolderEnvelope(folderId));
  }

  // messages (Task 4) ────────────────────────────────────────────────────────

  /**
   * FindItem over one folder, newest-first, paged (spec §5.3). `total` is the
   * server's TotalItemsInView; `more` is true when the window did not reach the
   * end (`offset + returned < total`).
   */
  async getMessages(
    session: MailSession, folderId: string, limit?: number, offset?: number,
  ): Promise<ProviderMessagePage> {
    const off = this.normOffset(offset);
    const max = this.normLimit(limit);
    const xml = await this.callWithRetry(session, findItemEnvelope(folderId, off, max));
    return this.parseMessagePage(xml, off, folderId);
  }

  /**
   * FindItem with an AQS QueryString across the mailbox (spec §5.3). Same
   * pagination as getMessages; each hit's own ParentFolderId is preferred for
   * `folderId` since a search spans folders.
   */
  async searchMessages(
    session: MailSession, query: string, limit?: number, offset?: number,
  ): Promise<ProviderMessagePage> {
    const off = this.normOffset(offset);
    const max = this.normLimit(limit);
    const xml = await this.callWithRetry(session, searchItemEnvelope(query, off, max));
    return this.parseMessagePage(xml, off, '');
  }

  /**
   * GetItem for one message, HTML body, no MIME (spec §5.3). Parses the body,
   * full address lists, and attachment metadata. An unknown id comes back as
   * ErrorItemNotFound → NotFoundException via the shared error funnel. Does NOT
   * mark the message read (the app marks read explicitly — current contract).
   */
  async getMessage(session: MailSession, messageId: string): Promise<ProviderMessage> {
    const xml = await this.callWithRetry(session, getItemEnvelope(messageId));
    const doc = parseEws(xml);
    const rm = this.responseMessageNode(doc, 'GetItemResponse', 'GetItemResponseMessage');
    const item = toArray(rm?.Items?.Message)[0] ?? {};
    const summary = this.mapMessageSummary(item, item?.ParentFolderId?.['@_Id'] ?? '');

    const bodyHtml = textOf(item?.Body) ?? null;
    const attachments = [
      ...toArray(item?.Attachments?.FileAttachment),
      ...toArray(item?.Attachments?.ItemAttachment),
    ].map((a) => this.mapAttachment(a));

    return {
      ...summary,
      cc: this.mapMailboxList(item?.CcRecipients),
      bcc: this.mapMailboxList(item?.BccRecipients),
      bodyHtml,
      bodyText: null,
      attachments,
    };
  }
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
