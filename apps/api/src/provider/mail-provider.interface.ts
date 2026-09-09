import { MailSession } from './mail-session';
import {
  ProviderFolder, ProviderMessage, ProviderMessagePage, ProviderContact,
  ProviderEvent, ProviderEventAttendee, ProviderFreeBusy, ProviderAuthResult,
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
  downloadAttachment(s: MailSession, messageId: string, part: string): Promise<{ data: Buffer; contentType: string; filename: string }>;
  downloadAttachmentBuffer(s: MailSession, messageId: string, part: string): Promise<Buffer>;

  // contacts + GAL
  getContacts(s: MailSession, limit?: number, offset?: number): Promise<ProviderContact[]>;
  createContact(s: MailSession, contact: Partial<ProviderContact>): Promise<ProviderContact>;
  modifyContact(s: MailSession, id: string, contact: Partial<ProviderContact>): Promise<void>;
  deleteContact(s: MailSession, id: string): Promise<void>;
  autoCompleteContacts(s: MailSession, query: string): Promise<Array<{ email: string; display: string }>>;
  searchGal(s: MailSession, query: string): Promise<Array<{ email: string; display: string }>>;

  // calendar
  getCalendarEvents(s: MailSession, startMs: number, endMs: number): Promise<ProviderEvent[]>;
  getAppointment(s: MailSession, id: string): Promise<ProviderEvent & { attendees: ProviderEventAttendee[] }>;
  createCalendarEvent(s: MailSession, payload: CalendarEventPayload): Promise<string>;
  modifyCalendarEvent(s: MailSession, id: string, payload: Partial<CalendarEventPayload>): Promise<void>;
  deleteCalendarEvent(s: MailSession, id: string): Promise<void>;
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
