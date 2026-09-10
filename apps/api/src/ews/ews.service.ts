import ms from 'ms';
import { Readable } from 'stream';
import { Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MailSession } from '../provider/mail-session';
import {
  ProviderFolder, ProviderMessage, ProviderMessagePage, ProviderContact,
  ProviderEvent, ProviderEventDetail, ProviderEventAttendee, ProviderFreeBusy,
  ProviderAuthResult, MailProviderCapabilities, ProviderIdentity, ProviderSignature,
  ProviderAddress, ProviderAttachmentMeta, ProviderFolderKind,
} from '../provider/provider-types';
import {
  MailProvider,
  SendMessagePayload, DraftPayload, CalendarEventPayload, ModifyCalendarEventPayload,
} from '../provider/mail-provider.interface';
import { CapabilityNotSupportedError } from '../provider/capability.error';
import { EwsCrypto } from './ews-crypto';
import {
  getFolderEnvelope, soapEnvelope, xmlEscape,
  findFolderEnvelope, findItemEnvelope, searchItemEnvelope, getItemEnvelope,
  createFolderEnvelope, deleteFolderEnvelope, renameFolderEnvelope, emptyFolderEnvelope,
  getItemChangeKeyEnvelope, markReadEnvelope, moveItemEnvelope, deleteItemEnvelope,
  createMessageEnvelope, createReplyForwardEnvelope, createAttachmentEnvelope,
  sendItemEnvelope, updateDraftEnvelope, getAttachmentEnvelope,
  findContactsEnvelope, createContactEnvelope, updateContactEnvelope, resolveNamesEnvelope,
  findCalendarEnvelope, getAppointmentEnvelope, createCalendarEventEnvelope,
  updateCalendarEventEnvelope, deleteCalendarEventEnvelope, inviteReplyEnvelope,
  getUserAvailabilityEnvelope, toUnqualifiedUtc, CONVERSATION_TOPIC_TAG,
  EwsFileAttachment, EwsMessageFields, EwsContactFields, EwsCalendarFields,
} from './ews-envelopes';
import {
  parseEws, responseClassOf, toArray, toBool, textOf,
} from './ews-parse';
import { EwsTransport, EwsServerBusyError, handleEwsError, inspectEwsXml } from './ews-transport';

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

/** EWS contact email slot key → the index of its role tag in
 *  `EwsService.CONTACT_EMAIL_ROLES` (1→work/primary, 2→personal, 3→other),
 *  mirroring the Zimbra contact mapping so a contact round-trips unchanged. */
const CONTACT_EMAIL_ROLES_INDEX: Record<string, number> = {
  EmailAddress1: 0,
  EmailAddress2: 1,
  EmailAddress3: 2,
};

/** EWS PhoneNumbers Entry key → the app's phone `type` (the read side of the
 *  write mapping in ews-envelopes' contactPhoneKey). */
const PHONE_KEY_TO_TYPE: Record<string, string> = {
  BusinessPhone: 'work',
  MobilePhone: 'mobile',
  HomePhone: 'home',
};

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
export class EwsService implements MailProvider {
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

  /**
   * Server-side attachment buffer store (spec §5.3: EWS has no standalone
   * attachment upload). `uploadAttachment` stashes the raw bytes here keyed by
   * an opaque handle it returns; the following `sendMessage` resolves each
   * handle back to its bytes, emits a `CreateAttachment` for it, and deletes
   * the entry (consume-on-attach) so a completed send leaves nothing behind.
   * Handles are process-local and single-use — the same model the Zimbra
   * provider's server-side `aid` occupies, so no call site changes.
   */
  private readonly attachmentBuffers = new Map<
    string,
    { filename: string; contentType: string; data: Buffer }
  >();
  private attachmentSeq = 0;

  constructor(private readonly transport: EwsTransport = new EwsTransport()) {
    if (!process.env.MAIL_CRED_KEY) {
      throw new Error(
        'EwsService: MAIL_CRED_KEY is required to encrypt EWS mailbox credentials.',
      );
    }
    // Constructing EwsCrypto here also fails fast on a malformed key.
    this.crypto = new EwsCrypto();
  }

  /**
   * Logout hook (Task 8): drop the transport's cached keep-alive https.Agent
   * for this mailbox so a later, differently-authenticated session can never
   * reuse a stale authenticated NTLM socket. Evicting an unknown email is a
   * no-op, so callers may invoke this unconditionally. `MailProviderResolver`
   * routes here only for `provider === 'ews'`.
   */
  evictSession(email: string): void {
    this.transport.evict(email);
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
   *
   * The throttle arrives in one of two shapes and BOTH must trigger the
   * back-off:
   *  - a 200-body `ResponseClass="Error"` — returned as XML, detected here by
   *    `inspectEwsXml`;
   *  - the common real shape, an HTTP-500 SOAP fault — thrown from inside
   *    `transport.call` via `handleEwsError` as a typed `EwsServerBusyError`
   *    before any body reaches us.
   *
   * Either way we honour (a capped) BackOffMilliseconds and retry exactly once
   * via `retryAfterBackoff`, whose own second attempt is final — so a
   * persistent throttle surfaces as a clean 502, never a second retry. Any
   * other Error/fault funnels through `handleEwsError`.
   */
  private async callWithRetry(session: MailSession, body: string): Promise<string> {
    let xml: string;
    try {
      xml = await this.transport.call(session, body);
    } catch (e) {
      // HTTP-500 SOAP-fault ErrorServerBusy → the single back-off retry.
      if (e instanceof EwsServerBusyError) return this.retryAfterBackoff(session, body, e.backoffMs);
      throw e;
    }

    const err = inspectEwsXml(xml);
    if (!err) return xml;
    // 200-body ErrorServerBusy → the same single back-off retry.
    if (err.responseCode === 'ErrorServerBusy') return this.retryAfterBackoff(session, body, err.backoffMs);
    handleEwsError(200, xml); // any other Error/fault
  }

  /** The one and only ErrorServerBusy retry, shared by both throttle shapes.
   *  Sleeps the capped back-off, then re-issues the call once. This second
   *  attempt is terminal: a throttle (or any error) now funnels straight
   *  through `handleEwsError` / propagates — there is no further retry. */
  private async retryAfterBackoff(session: MailSession, body: string, backoffMs?: number): Promise<string> {
    await delay(Math.min(backoffMs ?? 0, MAX_BACKOFF_MS));
    const xml = await this.transport.call(session, body);
    const err = inspectEwsXml(xml);
    if (!err) return xml;
    handleEwsError(200, xml); // still failing after the one retry
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

  /**
   * A recognized Exchange system folder `type` → the app's canonical Zimbra-style
   * folder `path`. The WEB sidebar matches system folders by these exact paths
   * (see Sidebar.tsx SYSTEM_FOLDERS/BUILTIN_PATHS), so an Exchange "Inbox" /
   * "Sent Items" / … must surface as '/Inbox' / '/Sent' / … or it falls into the
   * Labels section and the canonical menu item shows empty. A 'custom' folder has
   * no entry here and keeps its DisplayName-based path (never a BUILTIN path), so
   * user folders correctly appear under Labels.
   */
  private static readonly SYSTEM_FOLDER_PATHS: Record<string, string> = {
    inbox: '/Inbox',
    sent: '/Sent',
    drafts: '/Drafts',
    trash: '/Trash',
    junk: '/Junk',
  };

  private mapFolder(f: any): ProviderFolder {
    const name = textOf(f?.DisplayName) ?? '';
    const kind: ProviderFolderKind = 'mail';
    const type = this.folderTypeOf(name);
    return {
      id: f?.FolderId?.['@_Id'] ?? '',
      name,
      path: EwsService.SYSTEM_FOLDER_PATHS[type] ?? name,
      type,
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
  /**
   * Read a requested extended MAPI property's string value off a parsed item,
   * matching by numeric property tag. fast-xml-parser may surface the tag
   * attribute as the hex string `'0x0070'` or the coerced number `112`; `Number`
   * folds both to the same value. `ExtendedProperty` is one object when a single
   * property was requested and an array when several were, so funnel through
   * `toArray`.
   */
  private extendedPropString(item: any, propertyTag: number): string | undefined {
    for (const ep of toArray(item?.ExtendedProperty)) {
      if (Number(ep?.ExtendedFieldURI?.['@_PropertyTag']) === propertyTag) {
        return textOf(ep?.Value);
      }
    }
    return undefined;
  }

  /**
   * The grouping key the whole app threads on (`conversationId`). Exchange's
   * `FindItem` never returns the strongly-typed ConversationId (see
   * `CONVERSATION_TOPIC_TAG`), so prefer the ConversationTopic extended property,
   * fall back to a ConversationId if one did arrive (GetItem sometimes carries
   * it), and finally to the item's own id so a message is never left ungrouped
   * (null) — a null id would drop it onto the degraded single-message layout.
   */
  private conversationKey(item: any): string | null {
    const topic = this.extendedPropString(item, CONVERSATION_TOPIC_TAG)?.trim();
    return (topic || undefined) ?? item?.ConversationId?.['@_Id'] ?? item?.ItemId?.['@_Id'] ?? null;
  }

  private mapMessageSummary(item: any, folderId: string): ProviderMessage {
    const from = item?.From?.Mailbox
      ? this.mapMailbox(item.From.Mailbox)
      : { email: '' };
    const subjectText = textOf(item?.Subject);
    return {
      id: item?.ItemId?.['@_Id'] ?? '',
      conversationId: this.conversationKey(item),
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

  /** The message-shaped item element names an `Items` container can carry. A
   *  real inbox returns invites as `MeetingRequest` / `MeetingCancellation` /
   *  `MeetingResponse` — not `Message` — and they share the message wire shape,
   *  so the message layer must collect all four or invites vanish from listings
   *  and cannot be opened. Mirrors the `anyItemIdOf` broadening on the id side. */
  private static readonly MESSAGE_ITEM_TAGS = [
    'Message', 'MeetingRequest', 'MeetingCancellation', 'MeetingResponse',
  ] as const;

  /** Collect every message-shaped item from an `Items` container (Message +
   *  the three meeting element names), preserving document order per tag. */
  private messageItemsOf(itemsContainer: any): any[] {
    if (!itemsContainer) return [];
    return EwsService.MESSAGE_ITEM_TAGS.flatMap((tag) => toArray(itemsContainer[tag]));
  }

  /** Shared FindItem response → ProviderMessagePage. `total` is the server's
   *  TotalItemsInView; `more` = the window did not reach the end. */
  private parseMessagePage(xml: string, offset: number, folderId: string): ProviderMessagePage {
    const doc = parseEws(xml);
    const rm = this.responseMessageNode(doc, 'FindItemResponse', 'FindItemResponseMessage');
    const root = rm?.RootFolder;
    const items = this.messageItemsOf(root?.Items);
    const messages = items.map((it) => this.mapMessageSummary(it, folderId));
    const total = this.numOr(root?.['@_TotalItemsInView'], messages.length);
    const more = offset + messages.length < total;
    return { messages, total, more };
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
    // Message + MeetingRequest/Cancellation/Response — an invite opens the same
    // way a plain message does (shared wire shape).
    const item = this.messageItemsOf(rm?.Items)[0] ?? {};
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
  // ── send / drafts / mutations (Task 5) ────────────────────────────────────

  /** The message fields shared by create/reply/forward/update, pulled off a
   *  Send or Draft payload (both carry the same optional shape). */
  private messageFieldsOf(p: SendMessagePayload | DraftPayload): EwsMessageFields {
    return { subject: p.subject, body: p.body, to: p.to, cc: p.cc, bcc: p.bcc };
  }

  /** `Envelope.Body.<responseTag>.ResponseMessages.<messageTag>.Items.Message`
   *  → its `{ id, changeKey }`. Shared by CreateItem/UpdateItem/GetItem reads. */
  private itemIdOf(doc: any, responseTag: string, messageTag: string): { id: string; changeKey: string } {
    const rm = this.responseMessageNode(doc, responseTag, messageTag);
    const idNode = (toArray(rm?.Items?.Message)[0] ?? {})?.ItemId ?? {};
    return { id: idNode['@_Id'] ?? '', changeKey: idNode['@_ChangeKey'] ?? '' };
  }

  /** The parent item's NEW change key echoed on a CreateAttachment response
   *  (`AttachmentId/@RootItemChangeKey`) — the key the next CreateAttachment or
   *  the SendItem must quote. */
  private rootChangeKeyOf(doc: any): string {
    const rm = this.responseMessageNode(doc, 'CreateAttachmentResponse', 'CreateAttachmentResponseMessage');
    const att = toArray(rm?.Attachments?.FileAttachment)[0] ?? {};
    return att?.AttachmentId?.['@_RootItemChangeKey'] ?? '';
  }

  /** The ConversationId echoed on a create response, if the server included it
   *  (threading is otherwise carried by the References headers EWS sets). */
  private conversationIdOf(doc: any, responseTag: string, messageTag: string): string | null {
    const rm = this.responseMessageNode(doc, responseTag, messageTag);
    const conv = (toArray(rm?.Items?.Message)[0] ?? {})?.ConversationId;
    return conv?.['@_Id'] ?? null;
  }

  /** Resolve upload handles (regular + inline) into ready-to-attach files,
   *  consuming each buffer as it is read. Unknown handles are skipped rather
   *  than failing the whole send. */
  private collectAttachments(
    attachmentAids?: string[],
    inlineImageAids?: Array<{ aid: string; cid: string; ct: string }>,
  ): EwsFileAttachment[] {
    const files: EwsFileAttachment[] = [];
    for (const aid of attachmentAids ?? []) {
      const buf = this.attachmentBuffers.get(aid);
      if (!buf) continue;
      files.push({ name: buf.filename, contentType: buf.contentType, contentBase64: buf.data.toString('base64') });
      this.attachmentBuffers.delete(aid);
    }
    for (const img of inlineImageAids ?? []) {
      const buf = this.attachmentBuffers.get(img.aid);
      if (!buf) continue;
      files.push({
        name: buf.filename,
        contentType: img.ct || buf.contentType,
        contentBase64: buf.data.toString('base64'),
        isInline: true,
        contentId: img.cid,
      });
      this.attachmentBuffers.delete(img.aid);
    }
    return files;
  }

  /**
   * Send flow (spec §5.3): CreateItem `SaveOnly` (a `ReplyToItem`/`ForwardItem`
   * response object when `replyToId` is set) → one `CreateAttachment` per
   * buffered file / inline image / forwarded part, threading the parent's
   * change key forward each time → `SendItem` saving a copy to Sent Items.
   * Returns the staged item's id (the app correlates the Sent copy off it) and
   * the ConversationId when the server surfaced one.
   */
  async sendMessage(
    session: MailSession, payload: SendMessagePayload,
    attachmentAids?: string[],
    inlineImageAids?: Array<{ aid: string; cid: string; ct: string }>,
    forwardedAttachments?: Array<{ mid: string; part: string }>,
  ): Promise<{ id: string; conversationId: string | null }> {
    const fields = this.messageFieldsOf(payload);
    let createBody: string;
    if (payload.replyToId) {
      // Exchange requires the ReferenceItemId to carry the referenced item's
      // CURRENT ChangeKey for a ReplyToItem/ForwardItem create, else it faults
      // with ErrorChangeKeyRequiredForWriteOperations. Read it fresh via GetItem
      // IdOnly immediately before the write — the same fetch-fresh discipline
      // markRead/saveDraft-update use.
      const refChangeKey = await this.freshChangeKey(session, payload.replyToId);
      createBody = createReplyForwardEnvelope(
        payload.replyToId, refChangeKey, payload.replyType === 'w' ? 'w' : 'r', fields,
      );
    } else {
      createBody = createMessageEnvelope(fields, 'drafts');
    }

    const createDoc = parseEws(await this.callWithRetry(session, createBody));
    const created = this.itemIdOf(createDoc, 'CreateItemResponse', 'CreateItemResponseMessage');
    const conversationId = this.conversationIdOf(createDoc, 'CreateItemResponse', 'CreateItemResponseMessage');

    const itemId = created.id;
    let changeKey = created.changeKey;

    const files = this.collectAttachments(attachmentAids, inlineImageAids);
    // Forwarded parts reference attachments already on the server — pull the
    // bytes down and re-attach them as fresh FileAttachments on the draft.
    for (const fa of forwardedAttachments ?? []) {
      const dl = await this.fetchAttachment(session, fa.part);
      files.push({ name: dl.filename, contentType: dl.contentType, contentBase64: dl.data.toString('base64') });
    }

    for (const file of files) {
      const attachDoc = parseEws(await this.callWithRetry(session, createAttachmentEnvelope(itemId, changeKey, file)));
      changeKey = this.rootChangeKeyOf(attachDoc) || changeKey;
    }

    await this.callWithRetry(session, sendItemEnvelope(itemId, changeKey));
    return { id: itemId, conversationId };
  }

  /**
   * Save a draft (spec §5.3). No id → CreateItem `SaveOnly` into `drafts`,
   * returning the new ItemId. With an id → read a fresh ChangeKey (GetItem
   * IdOnly) *immediately before* UpdateItem `AlwaysOverwrite`, then return the
   * FRESH ItemId UpdateItem hands back (the old id dies with its change key).
   */
  async saveDraft(session: MailSession, payload: DraftPayload): Promise<string> {
    const fields = this.messageFieldsOf(payload);
    if (!payload.id) {
      const doc = parseEws(await this.callWithRetry(session, createMessageEnvelope(fields, 'drafts')));
      return this.itemIdOf(doc, 'CreateItemResponse', 'CreateItemResponseMessage').id;
    }
    const fresh = await this.freshChangeKey(session, payload.id);
    const doc = parseEws(await this.callWithRetry(session, updateDraftEnvelope(payload.id, fresh, fields)));
    return this.itemIdOf(doc, 'UpdateItemResponse', 'UpdateItemResponseMessage').id;
  }

  /** GetItem IdOnly to read the item's current ChangeKey — the fetch-fresh step
   *  that MUST run immediately before any UpdateItem (spec §5.3). */
  private async freshChangeKey(session: MailSession, itemId: string): Promise<string> {
    const doc = parseEws(await this.callWithRetry(session, getItemChangeKeyEnvelope(itemId)));
    // `anyItemIdOf` (not `itemIdOf`) so the fresh key is read whether the item
    // came back as a Message, a Contact, or a CalendarItem.
    return this.anyItemIdOf(doc, 'GetItemResponse', 'GetItemResponseMessage').changeKey;
  }

  /** MoveItem to `deleteditems` — soft delete, matching Zimbra's trash
   *  semantics (spec §5.3). */
  async deleteMessage(session: MailSession, messageId: string): Promise<void> {
    await this.callWithRetry(session, deleteItemEnvelope(messageId));
  }

  /** Toggle read state (spec §5.3): read a fresh ChangeKey with GetItem, then
   *  UpdateItem `message:IsRead` with SuppressReadReceipts. */
  async markRead(session: MailSession, messageId: string, read: boolean): Promise<void> {
    const fresh = await this.freshChangeKey(session, messageId);
    await this.callWithRetry(session, markReadEnvelope(messageId, fresh, read));
  }

  /** MoveItem to a concrete destination folder (spec §5.3). */
  async moveMessage(session: MailSession, messageId: string, folderId: string): Promise<void> {
    await this.callWithRetry(session, moveItemEnvelope(messageId, folderId));
  }

  // attachments (Task 5) ───────────────────────────────────────────────────

  /** Buffer the bytes server-side and hand back an opaque, single-use handle;
   *  the following `sendMessage` attaches them via CreateAttachment. EWS has no
   *  standalone upload op, so nothing goes over the wire here (spec §5.3). */
  async uploadAttachment(_session: MailSession, filename: string, contentType: string, data: Buffer): Promise<string> {
    const handle = `ews-att-${Date.now()}-${++this.attachmentSeq}`;
    this.attachmentBuffers.set(handle, { filename, contentType, data: Buffer.from(data) });
    return handle;
  }

  /** GetAttachment for `part` → decode the base64 `Content` to a Buffer, with
   *  the name/content-type off the attachment metadata. Shared by both download
   *  variants and the forwarded-attachment re-attach path. `messageId` is not
   *  needed — an EWS AttachmentId is self-addressing. */
  private async fetchAttachment(
    session: MailSession, part: string,
  ): Promise<{ data: Buffer; contentType: string; filename: string }> {
    const doc = parseEws(await this.callWithRetry(session, getAttachmentEnvelope(part)));
    const rm = this.responseMessageNode(doc, 'GetAttachmentResponse', 'GetAttachmentResponseMessage');
    const att = toArray(rm?.Attachments?.FileAttachment)[0] ?? {};
    return {
      data: Buffer.from(textOf(att?.Content) ?? '', 'base64'),
      contentType: textOf(att?.ContentType) ?? 'application/octet-stream',
      filename: textOf(att?.Name) ?? '',
    };
  }

  async downloadAttachment(
    session: MailSession, _messageId: string, part: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; filename: string }> {
    const a = await this.fetchAttachment(session, part);
    return { stream: Readable.from(a.data), contentType: a.contentType, filename: a.filename };
  }

  async downloadAttachmentBuffer(
    session: MailSession, _messageId: string, part: string,
  ): Promise<{ data: Buffer; contentType: string }> {
    const a = await this.fetchAttachment(session, part);
    return { data: a.data, contentType: a.contentType };
  }

  // ── contacts + GAL (Task 6) ───────────────────────────────────────────────

  /** `Envelope.Body.<responseTag>.<messageTag>.Items.<first item>` → its
   *  `{ id, changeKey }`. Unlike `itemIdOf` (message-only), this looks past the
   *  child element name so a Contact / CalendarItem create is read the same way
   *  a Message create is. */
  private anyItemIdOf(doc: any, responseTag: string, messageTag: string): { id: string; changeKey: string } {
    const rm = this.responseMessageNode(doc, responseTag, messageTag);
    const items = rm?.Items ?? {};
    const node = items.Message ?? items.Contact ?? items.CalendarItem ?? items.Item;
    const idNode = (toArray(node)[0] ?? {})?.ItemId ?? {};
    return { id: idNode['@_Id'] ?? '', changeKey: idNode['@_ChangeKey'] ?? '' };
  }

  /** EWS keys the three contact email slots EmailAddress1..3; the read path tags
   *  them work(primary)/personal/other to match the Zimbra contact mapping. */
  private static readonly CONTACT_EMAIL_ROLES: Array<{ type: string; primary?: boolean }> = [
    { type: 'work', primary: true },
    { type: 'personal' },
    { type: 'other' },
  ];

  /** One EWS `<t:Entry Key="…">value</t:Entry>` node → `{ key, value }`. */
  private entryKV(entry: any): { key: string; value: string } {
    return { key: entry?.['@_Key'] ?? '', value: textOf(entry) ?? '' };
  }

  /** A single FindItem/GetItem `<t:Contact>` → ProviderContact. Emails carry the
   *  role tag + primary flag the DB column and apps/web expect; a leading
   *  `SMTP:` routing prefix (GAL entries) is stripped. */
  private mapContact(item: any): ProviderContact {
    const emails: ProviderContact['emails'] = [];
    for (const raw of toArray(item?.EmailAddresses?.Entry)) {
      const { key, value } = this.entryKV(raw);
      if (!value) continue;
      const idx = CONTACT_EMAIL_ROLES_INDEX[key];
      const role = idx === undefined ? { type: 'other' } : EwsService.CONTACT_EMAIL_ROLES[idx];
      emails.push({ email: value.replace(/^SMTP:/i, ''), ...role });
    }

    const phones: ProviderContact['phones'] = [];
    for (const raw of toArray(item?.PhoneNumbers?.Entry)) {
      const { key, value } = this.entryKV(raw);
      if (!value) continue;
      phones.push({ number: value, type: PHONE_KEY_TO_TYPE[key] ?? 'work' });
    }

    const firstName = textOf(item?.GivenName) ?? null;
    const lastName = textOf(item?.Surname) ?? null;
    const displayName =
      textOf(item?.DisplayName) ??
      (firstName || lastName ? [firstName, lastName].filter(Boolean).join(' ') : null);

    return {
      id: item?.ItemId?.['@_Id'] ?? '',
      displayName,
      firstName,
      lastName,
      nickname: textOf(item?.Nickname) ?? null,
      company: textOf(item?.CompanyName) ?? null,
      jobTitle: textOf(item?.JobTitle) ?? null,
      emails,
      phones,
      notes: textOf(item?.Body) ?? null,
    };
  }

  /** Narrow a Partial<ProviderContact> to the wire-field shape the create/update
   *  envelopes take (drops `id`). */
  private contactFieldsOf(c: Partial<ProviderContact>): EwsContactFields {
    return {
      displayName: c.displayName ?? undefined,
      firstName: c.firstName ?? undefined,
      lastName: c.lastName ?? undefined,
      nickname: c.nickname ?? undefined,
      company: c.company ?? undefined,
      jobTitle: c.jobTitle ?? undefined,
      notes: c.notes ?? undefined,
      emails: c.emails,
      phones: c.phones,
    };
  }

  /** FindItem over the `contacts` folder, paged (spec §5.3). */
  async getContacts(session: MailSession, limit?: number, offset?: number): Promise<ProviderContact[]> {
    const off = this.normOffset(offset);
    const max = this.normLimit(limit);
    const xml = await this.callWithRetry(session, findContactsEnvelope(off, max));
    const doc = parseEws(xml);
    const rm = this.responseMessageNode(doc, 'FindItemResponse', 'FindItemResponseMessage');
    return toArray(rm?.RootFolder?.Items?.Contact).map((c) => this.mapContact(c));
  }

  /**
   * CreateItem (Contact) in the `contacts` folder (spec §5.3). Per the interface
   * contract the return value is the input echoed back with the server id — the
   * one caller (ContactsService) persists its own already-built row and reads
   * only the id off this.
   */
  async createContact(session: MailSession, contact: Partial<ProviderContact>): Promise<ProviderContact> {
    const doc = parseEws(await this.callWithRetry(session, createContactEnvelope(this.contactFieldsOf(contact))));
    const { id } = this.anyItemIdOf(doc, 'CreateItemResponse', 'CreateItemResponseMessage');
    return {
      id,
      displayName: contact.displayName ?? null,
      firstName: contact.firstName ?? null,
      lastName: contact.lastName ?? null,
      nickname: contact.nickname ?? null,
      company: contact.company ?? null,
      jobTitle: contact.jobTitle ?? null,
      emails: contact.emails ?? [],
      phones: contact.phones ?? [],
      notes: contact.notes ?? null,
    };
  }

  /** UpdateItem (Contact) after a fresh-ChangeKey GetItem (spec §5.3). */
  async modifyContact(session: MailSession, id: string, contact: Partial<ProviderContact>): Promise<void> {
    const fresh = await this.freshChangeKey(session, id);
    await this.callWithRetry(session, updateContactEnvelope(id, fresh, this.contactFieldsOf(contact)));
  }

  /** MoveItem to `deleteditems` — soft delete, matching the message contract
   *  (spec §5.3). */
  async deleteContact(session: MailSession, id: string): Promise<void> {
    await this.callWithRetry(session, deleteItemEnvelope(id));
  }

  /** ResolveNames → `{email,display}` (spec §5.3). Serves BOTH autocomplete and
   *  GAL search; both NEVER throw — any failure degrades to `[]` so the compose
   *  form keeps working (matches Zimbra + MemoryMailProvider). */
  private async resolveNames(session: MailSession, query: string): Promise<Array<{ email: string; display: string }>> {
    if (!query || !query.trim()) return [];
    try {
      const xml = await this.callWithRetry(session, resolveNamesEnvelope(query.trim()));
      const doc = parseEws(xml);
      const rm = this.responseMessageNode(doc, 'ResolveNamesResponse', 'ResolveNamesResponseMessage');
      const out: Array<{ email: string; display: string }> = [];
      for (const res of toArray(rm?.ResolutionSet?.Resolution)) {
        const mb = res?.Mailbox;
        const email = (textOf(mb?.EmailAddress) ?? '').replace(/^SMTP:/i, '');
        if (!email) continue;
        const display = textOf(mb?.Name) ?? textOf(res?.Contact?.DisplayName) ?? email;
        out.push({ email, display });
      }
      return out;
    } catch (err: any) {
      this.logger.warn(`resolveNames: ${err?.message ?? 'unknown'}`);
      return [];
    }
  }

  autoCompleteContacts(session: MailSession, query: string): Promise<Array<{ email: string; display: string }>> {
    return this.resolveNames(session, query);
  }

  searchGal(session: MailSession, query: string): Promise<Array<{ email: string; display: string }>> {
    return this.resolveNames(session, query);
  }

  // ── calendar (Task 6) ─────────────────────────────────────────────────────

  /** EWS Attendee `ResponseType` → the app's two-letter `ptst`. */
  private ptstOf(responseType: string | undefined): string {
    switch ((responseType ?? '').trim()) {
      case 'Accept': return 'AC';
      case 'Decline': return 'DE';
      case 'Tentative': return 'TE';
      default: return 'NE';
    }
  }

  /** A `<t:Mailbox>` (calendar organizer/attendee) → ProviderAddress. */
  private mapCalMailbox(mb: any): ProviderAddress {
    const email = textOf(mb?.EmailAddress) ?? '';
    const name = textOf(mb?.Name);
    return name ? { email, name } : { email };
  }

  /** A FindItem CalendarView `<t:CalendarItem>` → ProviderEvent. Attendees are
   *  not requested for the list view (they land on getAppointment), so the list
   *  hit carries an empty attendee array. */
  private mapCalendarEvent(item: any): ProviderEvent {
    const location = textOf(item?.Location);
    const organizerMb = item?.Organizer?.Mailbox;
    return {
      id: item?.ItemId?.['@_Id'] ?? '',
      title: textOf(item?.Subject) ?? '',
      location: location === undefined ? null : location,
      startAt: new Date(textOf(item?.Start) ?? 0),
      endAt: new Date(textOf(item?.End) ?? 0),
      allDay: toBool(item?.IsAllDayEvent),
      description: null,
      organizer: organizerMb ? this.mapCalMailbox(organizerMb) : undefined,
      attendees: [],
      inviteId: null,
      isRecurring: toBool(item?.IsRecurring),
    };
  }

  /** FindItem CalendarView over `calendar` for `[startMs, endMs)` (spec §5.3).
   *  CalendarView expands recurrences server-side. */
  async getCalendarEvents(session: MailSession, startMs: number, endMs: number): Promise<ProviderEvent[]> {
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    const xml = await this.callWithRetry(session, findCalendarEnvelope(startIso, endIso));
    const doc = parseEws(xml);
    const rm = this.responseMessageNode(doc, 'FindItemResponse', 'FindItemResponseMessage');
    return toArray(rm?.RootFolder?.Items?.CalendarItem).map((it) => this.mapCalendarEvent(it));
  }

  /** One RequiredAttendees/OptionalAttendees container → attendee list with ptst. */
  private mapAttendeeContainer(container: any): ProviderEventAttendee[] {
    return toArray(container?.Attendee).map((a) => ({
      ...this.mapCalMailbox(a?.Mailbox),
      ptst: this.ptstOf(textOf(a?.ResponseType)),
    }));
  }

  /**
   * GetItem for one appointment (spec §5.3). Returns the enriched attendee list
   * (with participation status) + organizer. Resolves to `null` — not a
   * NotFoundException — when the appointment is gone: the interface is
   * `ProviderEventDetail | null`, and the caller falls back to its cached copy.
   */
  async getAppointment(session: MailSession, id: string): Promise<ProviderEventDetail | null> {
    let xml: string;
    try {
      xml = await this.callWithRetry(session, getAppointmentEnvelope(id));
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
    const doc = parseEws(xml);
    const rm = this.responseMessageNode(doc, 'GetItemResponse', 'GetItemResponseMessage');
    const item = toArray(rm?.Items?.CalendarItem)[0];
    if (!item) return null;

    const hasRequired = item?.RequiredAttendees !== undefined;
    const hasOptional = item?.OptionalAttendees !== undefined;
    const attendees = hasRequired || hasOptional
      ? [
          ...this.mapAttendeeContainer(item?.RequiredAttendees),
          ...this.mapAttendeeContainer(item?.OptionalAttendees),
        ]
      : null;

    const organizerMb = item?.Organizer?.Mailbox;
    return {
      id: item?.ItemId?.['@_Id'] ?? id,
      attendees,
      organizer: organizerMb ? this.mapCalMailbox(organizerMb) : undefined,
      // EWS addresses an appointment update by its own ItemId + a fresh
      // ChangeKey — there is no separate invite-message id to join on.
      inviteMessageId: null,
    };
  }

  /** Narrow a calendar payload to the create/update envelope field shape. */
  private calendarFieldsOf(payload: CalendarEventPayload): EwsCalendarFields {
    return {
      title: payload.title,
      location: payload.location ?? undefined,
      description: payload.description ?? undefined,
      startAt: payload.startAt,
      endAt: payload.endAt,
      allDay: payload.allDay,
      attendees: payload.attendees,
    };
  }

  /** CreateItem (CalendarItem) mailing invitations (spec §5.3). Returns the new
   *  appointment's ItemId. */
  async createCalendarEvent(session: MailSession, payload: CalendarEventPayload): Promise<string> {
    const doc = parseEws(await this.callWithRetry(session, createCalendarEventEnvelope(this.calendarFieldsOf(payload))));
    return this.anyItemIdOf(doc, 'CreateItemResponse', 'CreateItemResponseMessage').id;
  }

  /** UpdateItem (CalendarItem) after a fresh-ChangeKey GetItem, re-sending
   *  invitations (spec §5.3). */
  async modifyCalendarEvent(session: MailSession, id: string, payload: ModifyCalendarEventPayload): Promise<void> {
    const fresh = await this.freshChangeKey(session, id);
    await this.callWithRetry(session, updateCalendarEventEnvelope(id, fresh, this.calendarFieldsOf(payload)));
  }

  /** DeleteItem MoveToDeletedItems, cancelling for attendees (spec §5.3). */
  async deleteCalendarEvent(session: MailSession, id: string): Promise<void> {
    await this.callWithRetry(session, deleteCalendarEventEnvelope(id));
  }

  /** CreateItem AcceptItem/DeclineItem/TentativelyAcceptItem against the invite
   *  message id (spec §5.3). */
  async sendInviteReply(session: MailSession, inviteId: string, verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE'): Promise<void> {
    await this.callWithRetry(session, inviteReplyEnvelope(inviteId, verb));
  }

  /**
   * GetUserAvailability FreeBusy for one mailbox (spec §5.3). Folds the returned
   * CalendarEvent slots into the {busy,tentative,unavailable} triple by BusyType
   * (Busy→busy, Tentative→tentative, OOF→unavailable; Free and the rest are
   * dropped). The response nests its ResponseMessage inside FreeBusyResponse, so
   * the view is located by a targeted walk rather than the generic navigator.
   */
  async getFreeBusy(session: MailSession, email: string, startMs: number, endMs: number): Promise<ProviderFreeBusy> {
    // GetUserAvailability's TimeWindow requires UNQUALIFIED datetimes
    // (yyyy-MM-ddTHH:mm:ss, no 'Z'/ms) — an ISO string with 'Z'/milliseconds
    // faults the request generically (0x80131500). The declared zero-bias UTC
    // TimeZone provides the context for these bare wall-clock boundaries.
    const startTime = toUnqualifiedUtc(startMs);
    const endTime = toUnqualifiedUtc(endMs);
    const xml = await this.callWithRetry(session, getUserAvailabilityEnvelope(email, startTime, endTime));
    const doc = parseEws(xml);

    const view = this.deepFindNode(doc, (n) => n?.CalendarEventArray !== undefined);
    const busy: ProviderFreeBusy['busy'] = [];
    const tentative: ProviderFreeBusy['tentative'] = [];
    const unavailable: ProviderFreeBusy['unavailable'] = [];
    for (const ev of toArray(view?.CalendarEventArray?.CalendarEvent)) {
      const s = Date.parse(textOf(ev?.StartTime) ?? '');
      const e = Date.parse(textOf(ev?.EndTime) ?? '');
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      const slot = { s, e };
      switch ((textOf(ev?.BusyType) ?? '').trim()) {
        case 'Busy': busy.push(slot); break;
        case 'Tentative': tentative.push(slot); break;
        case 'OOF': unavailable.push(slot); break;
        default: break; // Free / WorkingElsewhere / NoData → not a conflict
      }
    }
    return { busy, tentative, unavailable };
  }

  // settings-surface (capability-gated) ─────────────────────────────────────
  // Every flag in `capabilities` is false for EWS (spec §7): Exchange exposes
  // none of these over the EWS operations this module speaks. Each method
  // throws the typed CapabilityNotSupportedError so a DIRECT call surfaces as a
  // clean HTTP 400 via CapabilityNotSupportedFilter — never a silent no-op or a
  // 500. SettingsService.getSettings capability-branches BEFORE the read
  // methods so a normal settings-page load never reaches getPrefs/getIdentities/
  // getSignatures at all. Thrown synchronously (not async-rejected) to match
  // the interface's Promise return without an extra microtask.
  getPrefs(_s: MailSession): Promise<Record<string, string>> {
    throw new CapabilityNotSupportedError('server preferences');
  }
  modifyPrefs(_s: MailSession, _prefs: Record<string, string>): Promise<void> {
    throw new CapabilityNotSupportedError('server preferences');
  }
  getIdentities(_s: MailSession): Promise<ProviderIdentity[]> {
    throw new CapabilityNotSupportedError('identities');
  }
  modifyIdentity(_s: MailSession, _id: string, _attrs: Record<string, string>): Promise<void> {
    throw new CapabilityNotSupportedError('identities');
  }
  getSignatures(_s: MailSession): Promise<ProviderSignature[]> {
    throw new CapabilityNotSupportedError('signatures');
  }
  createSignature(_s: MailSession, _name: string, _contentHtml: string): Promise<string> {
    throw new CapabilityNotSupportedError('signatures');
  }
  modifySignature(_s: MailSession, _id: string, _name: string, _contentHtml: string): Promise<void> {
    throw new CapabilityNotSupportedError('signatures');
  }
  deleteSignature(_s: MailSession, _id: string): Promise<void> {
    throw new CapabilityNotSupportedError('signatures');
  }
  changePassword(_s: MailSession, _oldPassword: string, _newPassword: string): Promise<void> {
    throw new CapabilityNotSupportedError('password changes');
  }
}
