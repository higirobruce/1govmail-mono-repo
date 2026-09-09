import { MailSession } from './mail-session';
import {
  ProviderFolder, ProviderMessage, ProviderMessagePage, ProviderContact,
  ProviderEvent, ProviderEventDetail, ProviderFreeBusy, ProviderAuthResult,
  MailProviderCapabilities, ProviderAddress,
} from './provider-types';

export interface SendMessagePayload {
  to: string[]; cc?: string[]; bcc?: string[];
  subject: string; body: string;
  replyToId?: string; replyType?: 'r' | 'w';
}

export interface DraftPayload { id?: string; to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; body?: string }

export interface CalendarEventPayload {
  title: string; location?: string; startAt: Date; endAt: Date; allDay: boolean;
  description?: string; organizerEmail: string; organizerName?: string; attendees?: string[];
}

/**
 * Task 8 adjustment: Task 5 declared `modifyCalendarEvent` as taking a
 * `Partial<CalendarEventPayload>`, but an appointment update is not a patch —
 * the provider resends the whole component, so title/start/end/allDay/organizer
 * are all mandatory, and it additionally needs the optimistic-concurrency
 * counters read off the current appointment. Sending a stale `modifiedSequence`
 * is what produces the "specified Invite is out of date" failure, so these
 * cannot be dropped from the neutral payload.
 */
export interface ModifyCalendarEventPayload extends CalendarEventPayload {
  modifiedSequence?: number;
  rev?: number;
}

export interface MailProvider {
  readonly name: 'zimbra' | 'ews' | 'memory';
  readonly capabilities: MailProviderCapabilities;

  // auth
  authenticate(host: string, email: string, password: string): Promise<ProviderAuthResult>;
  verifyTwoFactor(host: string, email: string, code: string, tempToken: string): Promise<ProviderAuthResult>;

  // folders
  getFolders(s: MailSession): Promise<ProviderFolder[]>;
  createFolder(s: MailSession, name: string, parentId?: string): Promise<ProviderFolder>;
  deleteFolder(s: MailSession, folderId: string): Promise<void>;
  renameFolder(s: MailSession, folderId: string, name: string): Promise<void>;
  emptyFolder(s: MailSession, folderId: string): Promise<void>;

  // messages
  getMessages(s: MailSession, folderId: string, limit?: number, offset?: number): Promise<ProviderMessagePage>;
  getMessage(s: MailSession, messageId: string): Promise<ProviderMessage>;
  searchMessages(s: MailSession, query: string, limit?: number, offset?: number): Promise<ProviderMessagePage>;
  sendMessage(
    s: MailSession, payload: SendMessagePayload,
    attachmentAids?: string[],
    inlineImageAids?: Array<{ aid: string; cid: string; ct: string }>,
    forwardedAttachments?: Array<{ mid: string; part: string }>,
  ): Promise<{ id: string; conversationId: string | null }>;
  saveDraft(s: MailSession, payload: DraftPayload): Promise<string>;
  deleteMessage(s: MailSession, messageId: string): Promise<void>;
  markRead(s: MailSession, messageId: string, read: boolean): Promise<void>;
  moveMessage(s: MailSession, messageId: string, folderId: string): Promise<void>;

  // attachments (Zimbra pre-upload `aid` model today; §5.3 of the spec flags
  // this for generalization to buffers when EWS lands — keep the method
  // signatures matching current call sites for zero behavior change now)
  uploadAttachment(s: MailSession, filename: string, contentType: string, data: Buffer): Promise<string>;
  /**
   * Streams — the download endpoint is proxied straight to the HTTP response
   * and to the attachment-text extractor, neither of which wants the whole
   * file buffered first. `filename` comes off the upstream
   * Content-Disposition.
   */
  downloadAttachment(s: MailSession, messageId: string, part: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string; filename: string }>;
  /** Buffered variant for server-side processing (base64-embedding inline images).
   *  Returns the content type alongside the bytes — the data URI needs it. */
  downloadAttachmentBuffer(s: MailSession, messageId: string, part: string): Promise<{ data: Buffer; contentType: string }>;

  // contacts + GAL
  getContacts(s: MailSession, limit?: number, offset?: number): Promise<ProviderContact[]>;
  /**
   * `contact` is a Partial<ProviderContact>, NOT the created record echoed
   * back — Zimbra's CreateContactResponse only confirms the new id, and
   * ContactsService.createContact never reads anything else off the return
   * value (it persists the row from its own already-built input). The
   * returned ProviderContact is the input echoed back with the real id.
   */
  createContact(s: MailSession, contact: Partial<ProviderContact>): Promise<ProviderContact>;
  modifyContact(s: MailSession, id: string, contact: Partial<ProviderContact>): Promise<void>;
  deleteContact(s: MailSession, id: string): Promise<void>;
  autoCompleteContacts(s: MailSession, query: string): Promise<Array<{ email: string; display: string }>>;
  searchGal(s: MailSession, query: string): Promise<Array<{ email: string; display: string }>>;

  // calendar
  /**
   * Events overlapping [startMs, endMs). Recurrence is expanded server-side but
   * only the first occurrence of each appointment inside the window is
   * returned — that is what the one caller consumes, and widening it would
   * change the events endpoint's payload. See mapZimbraAppointment.
   */
  getCalendarEvents(s: MailSession, startMs: number, endMs: number): Promise<ProviderEvent[]>;
  /**
   * Full detail for one appointment: the complete attendee list with
   * participation status, plus the ids/counters an update has to quote.
   * Resolves to `null` when the appointment is gone — the caller falls back to
   * its cached copy rather than erroring. Returns ProviderEventDetail, not a
   * ProviderEvent — see the type's doc comment for why.
   */
  getAppointment(s: MailSession, id: string): Promise<ProviderEventDetail | null>;
  createCalendarEvent(s: MailSession, payload: CalendarEventPayload): Promise<string>;
  modifyCalendarEvent(s: MailSession, id: string, payload: ModifyCalendarEventPayload): Promise<void>;
  deleteCalendarEvent(s: MailSession, id: string): Promise<void>;
  /**
   * `inviteId` is the *invite message* id, not the calendar item id.
   * Task 8 adjustment: the Zimbra implementation also accepted `subject` and
   * `organizerEmail` arguments, but never read them — dead parameters threaded
   * through from the caller. Dropped; the request body is unchanged.
   */
  sendInviteReply(s: MailSession, inviteId: string, verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE'): Promise<void>;
  getFreeBusy(s: MailSession, email: string, startMs: number, endMs: number): Promise<ProviderFreeBusy>;

  // settings-surface (capability-gated; EWS throws CapabilityNotSupportedError)
  getPrefs(s: MailSession): Promise<Record<string, string>>;
  modifyPrefs(s: MailSession, prefs: Record<string, string>): Promise<void>;
  getIdentities(s: MailSession): Promise<unknown[]>;
  modifyIdentity(s: MailSession, id: string, attrs: Record<string, unknown>): Promise<void>;
  getSignatures(s: MailSession): Promise<unknown[]>;
  createSignature(s: MailSession, name: string, contentHtml: string): Promise<string>;
  modifySignature(s: MailSession, id: string, name: string, contentHtml: string): Promise<void>;
  deleteSignature(s: MailSession, id: string): Promise<void>;
  changePassword(s: MailSession, oldPassword: string, newPassword: string): Promise<void>;
}
