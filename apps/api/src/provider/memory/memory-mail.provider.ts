import { Readable } from 'stream';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MailSession } from '../mail-session';
import {
  ProviderFolder, ProviderMessage, ProviderMessagePage, ProviderAddress, ProviderAttachmentMeta,
  ProviderAuthResult, MailProviderCapabilities, ProviderContact, ProviderEvent, ProviderEventDetail,
  ProviderFreeBusy, ProviderIdentity, ProviderSignature,
} from '../provider-types';
import { MemoryStore, MemoryMailbox } from './memory-store';
import {
  MailProvider, SendMessagePayload, DraftPayload, CalendarEventPayload, ModifyCalendarEventPayload,
} from '../mail-provider.interface';

const SYSTEM_FOLDER_TYPES = new Set(['inbox', 'sent', 'drafts', 'trash', 'junk']);

let folderCounter = 0;
function nextFolderId(): string {
  folderCounter += 1;
  return `folder-custom-${folderCounter}`;
}

let messageCounter = 0;
function nextMessageId(): string {
  messageCounter += 1;
  return `msg-memory-${messageCounter}`;
}

let conversationCounter = 0;
function nextConversationId(): string {
  conversationCounter += 1;
  return `conv-memory-${conversationCounter}`;
}

let attachmentCounter = 0;
function nextAttachmentId(): string {
  attachmentCounter += 1;
  return `att-${attachmentCounter}`;
}

let contactCounter = 0;
function nextContactId(): string {
  contactCounter += 1;
  return `contact-custom-${contactCounter}`;
}

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `event-custom-${eventCounter}`;
}

let signatureCounter = 0;
function nextSignatureId(): string {
  signatureCounter += 1;
  return `sig-custom-${signatureCounter}`;
}

/**
 * In-memory `MailProvider` implementation backing the demo/dev "memory"
 * account type. Task 2 implements auth + folders + message reads; Tasks 3-4
 * added messages/contacts/calendar; Task 5 adds the settings surface
 * (prefs/identities/signatures/password) and declares `implements
 * MailProvider` — every method now exists with a signature matching the
 * interface exactly, so this compiles with no further changes.
 */
export class MemoryMailProvider implements MailProvider {
  readonly name = 'memory' as const;
  readonly capabilities: MailProviderCapabilities = {
    signatures: true,
    identities: true,
    serverPrefs: true,
    changePassword: true,
    twoFactor: true,
  };

  constructor(private readonly store: MemoryStore) {}

  private mb(s: MailSession): MemoryMailbox {
    const m = this.store.get(s.email);
    if (!m) throw new UnauthorizedException('Your session is no longer valid.');
    return m;
  }

  // ---- auth -----------------------------------------------------------------

  async authenticate(_host: string, email: string, password: string): Promise<ProviderAuthResult> {
    const mailbox = this.store.seedFor(email, password);
    return {
      authToken: 'memory-' + email,
      lifetime: 24 * 3600 * 1000,
      displayName: mailbox.displayName,
      twoFactorRequired: false,
    };
  }

  async verifyTwoFactor(
    _host: string, _email: string, _preAuthToken: string, _twoFactorCode: string,
  ): Promise<ProviderAuthResult> {
    // Memory accounts never challenge for 2FA, so this leg is never reached
    // in practice — kept for interface conformance.
    return {
      authToken: '',
      lifetime: 0,
      twoFactorRequired: false,
    };
  }

  // ---- folders ----------------------------------------------------------------

  async getFolders(s: MailSession): Promise<ProviderFolder[]> {
    return this.mb(s).folders;
  }

  async createFolder(s: MailSession, name: string, parentId?: string): Promise<ProviderFolder> {
    const mailbox = this.mb(s);
    const folder: ProviderFolder = {
      id: nextFolderId(),
      name,
      path: `/${name}`,
      type: 'custom',
      kind: 'mail',
      unreadCount: 0,
      totalCount: 0,
      parentId,
    };
    mailbox.folders.push(folder);
    return folder;
  }

  async deleteFolder(s: MailSession, folderId: string): Promise<void> {
    const mailbox = this.mb(s);
    const folder = mailbox.folders.find((f) => f.id === folderId);
    if (!folder) throw new NotFoundException('Folder not found');
    if (folder.type && SYSTEM_FOLDER_TYPES.has(folder.type)) {
      throw new BadRequestException('Cannot delete a system folder');
    }
    mailbox.folders = mailbox.folders.filter((f) => f.id !== folderId);
    mailbox.messages = mailbox.messages.filter((m) => m.folderId !== folderId);
  }

  async renameFolder(s: MailSession, folderId: string, name: string): Promise<void> {
    const mailbox = this.mb(s);
    const folder = mailbox.folders.find((f) => f.id === folderId);
    if (!folder) throw new NotFoundException('Folder not found');
    folder.name = name;
    folder.path = `/${name}`;
  }

  async emptyFolder(s: MailSession, folderId: string): Promise<void> {
    const mailbox = this.mb(s);
    const folder = mailbox.folders.find((f) => f.id === folderId);
    if (!folder) throw new NotFoundException('Folder not found');
    mailbox.messages = mailbox.messages.filter((m) => m.folderId !== folderId);
    folder.totalCount = 0;
    folder.unreadCount = 0;
  }

  // ---- messages ---------------------------------------------------------------

  async getMessages(s: MailSession, folderId: string, limit = 25, offset = 0): Promise<ProviderMessagePage> {
    const mailbox = this.mb(s);
    const inFolder = mailbox.messages
      .filter((m) => m.folderId === folderId)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    const total = inFolder.length;
    const messages = inFolder.slice(offset, offset + limit);
    return { messages, total, more: offset + limit < total };
  }

  async getMessage(s: MailSession, messageId: string): Promise<ProviderMessage> {
    const mailbox = this.mb(s);
    const message = mailbox.messages.find((m) => m.id === messageId);
    if (!message) throw new NotFoundException('Message not found');
    return message;
  }

  async searchMessages(s: MailSession, query: string, limit = 25, offset = 0): Promise<ProviderMessagePage> {
    const mailbox = this.mb(s);
    const trashFolder = mailbox.folders.find((f) => f.type === 'trash');
    const needle = query.toLowerCase();
    const matches = mailbox.messages
      .filter((m) => m.folderId !== trashFolder?.id)
      .filter((m) => {
        const subject = (m.subject ?? '').toLowerCase();
        const fromEmail = m.from.email.toLowerCase();
        const fromName = (m.from.name ?? '').toLowerCase();
        const body = `${m.bodyText ?? ''} ${m.bodyHtml ?? ''}`.toLowerCase();
        return subject.includes(needle) || fromEmail.includes(needle) || fromName.includes(needle) || body.includes(needle);
      })
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    const total = matches.length;
    const messages = matches.slice(offset, offset + limit);
    return { messages, total, more: offset + limit < total };
  }

  async markRead(s: MailSession, messageId: string, read: boolean): Promise<void> {
    const mailbox = this.mb(s);
    const message = mailbox.messages.find((m) => m.id === messageId);
    if (!message) throw new NotFoundException('Message not found');
    message.isRead = read;
    this.recomputeFolderCounts(mailbox, message.folderId);
  }

  async moveMessage(s: MailSession, messageId: string, folderId: string): Promise<void> {
    const mailbox = this.mb(s);
    const message = mailbox.messages.find((m) => m.id === messageId);
    if (!message) throw new NotFoundException('Message not found');
    if (!mailbox.folders.some((f) => f.id === folderId)) throw new NotFoundException('Folder not found');
    const oldFolderId = message.folderId;
    message.folderId = folderId;
    this.recomputeFolderCounts(mailbox, oldFolderId);
    this.recomputeFolderCounts(mailbox, folderId);
  }

  async deleteMessage(s: MailSession, messageId: string): Promise<void> {
    const mailbox = this.mb(s);
    const message = mailbox.messages.find((m) => m.id === messageId);
    if (!message) throw new NotFoundException('Message not found');
    const trash = mailbox.folders.find((f) => f.type === 'trash');
    if (!trash) throw new NotFoundException('Trash folder not found');
    const oldFolderId = message.folderId;
    message.folderId = trash.id;
    this.recomputeFolderCounts(mailbox, oldFolderId);
    this.recomputeFolderCounts(mailbox, trash.id);
  }

  // ---- send / drafts ----------------------------------------------------------

  async sendMessage(
    s: MailSession,
    payload: SendMessagePayload,
    attachmentAids?: string[],
    _inlineImageAids?: Array<{ aid: string; cid: string; ct: string }>,
    _forwardedAttachments?: Array<{ mid: string; part: string }>,
  ): Promise<{ id: string; conversationId: string | null }> {
    const mailbox = this.mb(s);
    const sentFolder = mailbox.folders.find((f) => f.type === 'sent');
    if (!sentFolder) throw new NotFoundException('Sent folder not found');

    const self: ProviderAddress = { email: s.email, name: mailbox.displayName };
    const conversationId = payload.replyToId
      ? mailbox.messages.find((m) => m.id === payload.replyToId)?.conversationId ?? nextConversationId()
      : nextConversationId();
    const attachmentsMeta = this.resolveAttachments(mailbox, attachmentAids);

    const id = nextMessageId();
    const message: ProviderMessage = {
      id,
      conversationId,
      folderId: sentFolder.id,
      subject: payload.subject,
      snippet: this.toSnippet(payload.body),
      from: self,
      to: payload.to.map((email) => ({ email })),
      cc: (payload.cc ?? []).map((email) => ({ email })),
      bcc: (payload.bcc ?? []).map((email) => ({ email })),
      receivedAt: new Date(),
      size: Buffer.byteLength(payload.body, 'utf-8'),
      isRead: true,
      isFlagged: false,
      hasAttachments: attachmentsMeta.length > 0,
      isDraft: false,
      tags: [],
      bodyHtml: payload.body,
      bodyText: payload.body,
      attachments: attachmentsMeta,
    };
    mailbox.messages.push(message);
    this.recomputeFolderCounts(mailbox, sentFolder.id);

    // Deliver to any recipient that is itself a seeded memory mailbox.
    const recipients = new Set([...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])]);
    for (const recipientEmail of recipients) {
      if (recipientEmail === s.email) continue;
      if (!this.store.has(recipientEmail)) continue;
      const recipientMailbox = this.store.get(recipientEmail)!;
      const recipientInbox = recipientMailbox.folders.find((f) => f.type === 'inbox');
      if (!recipientInbox) continue;
      recipientMailbox.messages.push({
        ...message,
        id: nextMessageId(),
        folderId: recipientInbox.id,
        isRead: false,
        to: [...message.to],
        cc: [...message.cc],
        bcc: [...message.bcc],
        tags: [...message.tags],
        attachments: message.attachments ? message.attachments.map((a) => ({ ...a })) : message.attachments,
      });
      // Attachment metadata is copied above, but the bytes live in the
      // sender's own mailbox.attachments Map — copy them into the
      // recipient's Map too, keyed the same way (by aid/part), so the
      // recipient can download them.
      for (const meta of message.attachments ?? []) {
        const bytes = mailbox.attachments.get(meta.part);
        if (bytes) recipientMailbox.attachments.set(meta.part, { ...bytes });
      }
      this.recomputeFolderCounts(recipientMailbox, recipientInbox.id);
    }

    return { id, conversationId };
  }

  async saveDraft(s: MailSession, payload: DraftPayload): Promise<string> {
    const mailbox = this.mb(s);
    const draftsFolder = mailbox.folders.find((f) => f.type === 'drafts');
    if (!draftsFolder) throw new NotFoundException('Drafts folder not found');

    if (payload.id) {
      const existing = mailbox.messages.find((m) => m.id === payload.id);
      if (!existing) throw new NotFoundException('Draft not found');
      if (payload.to) existing.to = payload.to.map((email) => ({ email }));
      if (payload.cc) existing.cc = payload.cc.map((email) => ({ email }));
      if (payload.bcc) existing.bcc = payload.bcc.map((email) => ({ email }));
      if (payload.subject !== undefined) existing.subject = payload.subject;
      if (payload.body !== undefined) {
        existing.bodyHtml = payload.body;
        existing.bodyText = payload.body;
        existing.snippet = this.toSnippet(payload.body);
      }
      existing.folderId = draftsFolder.id;
      existing.isDraft = true;
      this.recomputeFolderCounts(mailbox, draftsFolder.id);
      return existing.id;
    }

    const self: ProviderAddress = { email: s.email, name: mailbox.displayName };
    const body = payload.body ?? '';
    const id = nextMessageId();
    const message: ProviderMessage = {
      id,
      conversationId: null,
      folderId: draftsFolder.id,
      subject: payload.subject ?? null,
      snippet: this.toSnippet(body),
      from: self,
      to: (payload.to ?? []).map((email) => ({ email })),
      cc: (payload.cc ?? []).map((email) => ({ email })),
      bcc: (payload.bcc ?? []).map((email) => ({ email })),
      receivedAt: new Date(),
      size: Buffer.byteLength(body, 'utf-8'),
      isRead: true,
      isFlagged: false,
      hasAttachments: false,
      isDraft: true,
      tags: [],
      bodyHtml: body,
      bodyText: body,
      attachments: [],
    };
    mailbox.messages.push(message);
    this.recomputeFolderCounts(mailbox, draftsFolder.id);
    return id;
  }

  // ---- attachments --------------------------------------------------------------

  async uploadAttachment(s: MailSession, filename: string, contentType: string, data: Buffer): Promise<string> {
    const mailbox = this.mb(s);
    const aid = nextAttachmentId();
    mailbox.attachments.set(aid, { filename, contentType, data });
    return aid;
  }

  async downloadAttachment(
    s: MailSession, messageId: string, part: string,
  ): Promise<{ stream: NodeJS.ReadableStream; contentType: string; filename: string }> {
    const mailbox = this.mb(s);
    const stored = this.findAttachmentBytes(mailbox, messageId, part);
    return { stream: Readable.from(stored.data), contentType: stored.contentType, filename: stored.filename };
  }

  async downloadAttachmentBuffer(
    s: MailSession, messageId: string, part: string,
  ): Promise<{ data: Buffer; contentType: string }> {
    const mailbox = this.mb(s);
    const stored = this.findAttachmentBytes(mailbox, messageId, part);
    return { data: stored.data, contentType: stored.contentType };
  }

  // ---- contacts + GAL -----------------------------------------------------------

  async getContacts(s: MailSession, limit = 25, offset = 0): Promise<ProviderContact[]> {
    const mailbox = this.mb(s);
    return mailbox.contacts.slice(offset, offset + limit);
  }

  async createContact(s: MailSession, contact: Partial<ProviderContact>): Promise<ProviderContact> {
    const mailbox = this.mb(s);
    const created: ProviderContact = {
      id: nextContactId(),
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
    mailbox.contacts.push(created);
    return created;
  }

  async modifyContact(s: MailSession, id: string, contact: Partial<ProviderContact>): Promise<void> {
    const mailbox = this.mb(s);
    const existing = mailbox.contacts.find((c) => c.id === id);
    if (!existing) throw new NotFoundException('Contact not found');
    const { id: _ignored, ...rest } = contact;
    Object.assign(existing, rest);
  }

  async deleteContact(s: MailSession, id: string): Promise<void> {
    const mailbox = this.mb(s);
    const idx = mailbox.contacts.findIndex((c) => c.id === id);
    if (idx === -1) throw new NotFoundException('Contact not found');
    mailbox.contacts.splice(idx, 1);
  }

  /**
   * Never throws — callers use these for live-typing suggestions, so a bad
   * session or an empty result both just mean "nothing to suggest", not an
   * error. There is no separate GAL store for memory mailboxes; searchGal
   * matches over the same seeded contacts as autoCompleteContacts.
   */
  async autoCompleteContacts(s: MailSession, query: string): Promise<Array<{ email: string; display: string }>> {
    try {
      return this.matchContacts(this.mb(s), query);
    } catch {
      return [];
    }
  }

  async searchGal(s: MailSession, query: string): Promise<Array<{ email: string; display: string }>> {
    try {
      return this.matchContacts(this.mb(s), query);
    } catch {
      return [];
    }
  }

  // ---- calendar -------------------------------------------------------------------

  async getCalendarEvents(s: MailSession, startMs: number, endMs: number): Promise<ProviderEvent[]> {
    const mailbox = this.mb(s);
    return mailbox.events.filter(
      (e) => e.startAt.getTime() < endMs && e.endAt.getTime() > startMs,
    );
  }

  async getAppointment(s: MailSession, id: string): Promise<ProviderEventDetail | null> {
    const mailbox = this.mb(s);
    const event = mailbox.events.find((e) => e.id === id);
    if (!event) return null;
    return {
      id: event.id,
      attendees: event.attendees,
      organizer: event.organizer,
      inviteMessageId: event.inviteId,
    };
  }

  async createCalendarEvent(s: MailSession, payload: CalendarEventPayload): Promise<string> {
    const mailbox = this.mb(s);
    const id = nextEventId();
    const event: ProviderEvent = {
      id,
      title: payload.title,
      location: payload.location ?? null,
      startAt: payload.startAt,
      endAt: payload.endAt,
      allDay: payload.allDay,
      description: payload.description ?? null,
      organizer: { email: payload.organizerEmail, name: payload.organizerName },
      attendees: (payload.attendees ?? []).map((email) => ({ email })),
      inviteId: null,
      isRecurring: false,
    };
    mailbox.events.push(event);
    return id;
  }

  async modifyCalendarEvent(s: MailSession, id: string, payload: ModifyCalendarEventPayload): Promise<void> {
    const mailbox = this.mb(s);
    const existing = mailbox.events.find((e) => e.id === id);
    if (!existing) throw new NotFoundException('Event not found');
    existing.title = payload.title;
    existing.location = payload.location ?? null;
    existing.startAt = payload.startAt;
    existing.endAt = payload.endAt;
    existing.allDay = payload.allDay;
    existing.description = payload.description ?? null;
    existing.organizer = { email: payload.organizerEmail, name: payload.organizerName };
    existing.attendees = (payload.attendees ?? []).map((email) => ({ email }));
  }

  async deleteCalendarEvent(s: MailSession, id: string): Promise<void> {
    const mailbox = this.mb(s);
    const idx = mailbox.events.findIndex((e) => e.id === id);
    if (idx === -1) throw new NotFoundException('Event not found');
    mailbox.events.splice(idx, 1);
  }

  /**
   * No-op: memory mailboxes have no distinct "invite" inbox flow to update —
   * an accept/decline/tentative reply from the current user doesn't change
   * any seeded/created event's own attendee list for itself.
   */
  async sendInviteReply(s: MailSession, _inviteId: string, _verb: 'ACCEPT' | 'DECLINE' | 'TENTATIVE'): Promise<void> {
    this.mb(s);
  }

  async getFreeBusy(s: MailSession, email: string, startMs: number, endMs: number): Promise<ProviderFreeBusy> {
    this.mb(s);
    const mailbox = email === s.email ? this.store.get(s.email) : this.store.get(email);
    if (!mailbox) return { busy: [], tentative: [], unavailable: [] };
    const busy = mailbox.events
      .filter((e) => e.startAt.getTime() < endMs && e.endAt.getTime() > startMs)
      .map((e) => ({ s: e.startAt.getTime(), e: e.endAt.getTime() }))
      .sort((a, b) => a.s - b.s);
    return { busy, tentative: [], unavailable: [] };
  }

  // ---- settings surface (prefs, identities, signatures, password) ---------------

  async getPrefs(s: MailSession): Promise<Record<string, string>> {
    return this.mb(s).prefs;
  }

  async modifyPrefs(s: MailSession, prefs: Record<string, string>): Promise<void> {
    const mailbox = this.mb(s);
    Object.assign(mailbox.prefs, prefs);
  }

  async getIdentities(s: MailSession): Promise<ProviderIdentity[]> {
    return this.mb(s).identities;
  }

  async modifyIdentity(s: MailSession, id: string, attrs: Record<string, string>): Promise<void> {
    const mailbox = this.mb(s);
    const existing = mailbox.identities.find((i) => i.id === id);
    if (!existing) throw new NotFoundException('Identity not found');
    Object.assign(existing.attrs, attrs);
  }

  async getSignatures(s: MailSession): Promise<ProviderSignature[]> {
    return this.mb(s).signatures;
  }

  async createSignature(s: MailSession, name: string, contentHtml: string): Promise<string> {
    const mailbox = this.mb(s);
    const id = nextSignatureId();
    const signature: ProviderSignature = {
      id,
      name,
      contentHtml,
      contentText: this.toSnippet(contentHtml),
    };
    mailbox.signatures.push(signature);
    return id;
  }

  async modifySignature(s: MailSession, id: string, name: string, contentHtml: string): Promise<void> {
    const mailbox = this.mb(s);
    const existing = mailbox.signatures.find((sig) => sig.id === id);
    if (!existing) throw new NotFoundException('Signature not found');
    existing.name = name;
    existing.contentHtml = contentHtml;
    existing.contentText = this.toSnippet(contentHtml);
  }

  async deleteSignature(s: MailSession, id: string): Promise<void> {
    const mailbox = this.mb(s);
    const idx = mailbox.signatures.findIndex((sig) => sig.id === id);
    if (idx === -1) throw new NotFoundException('Signature not found');
    mailbox.signatures.splice(idx, 1);
  }

  async changePassword(s: MailSession, _oldPassword: string, newPassword: string): Promise<void> {
    const mailbox = this.mb(s);
    mailbox.password = newPassword;
  }

  // ---- private helpers ----------------------------------------------------------

  private recomputeFolderCounts(mailbox: MemoryMailbox, folderId: string): void {
    const folder = mailbox.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const inFolder = mailbox.messages.filter((m) => m.folderId === folderId);
    folder.totalCount = inFolder.length;
    folder.unreadCount = inFolder.filter((m) => !m.isRead).length;
  }

  private matchContacts(mailbox: MemoryMailbox, query: string): Array<{ email: string; display: string }> {
    const needle = query.toLowerCase();
    const hits: Array<{ email: string; display: string }> = [];
    for (const c of mailbox.contacts) {
      const display = c.displayName ?? '';
      const primaryEmail = c.emails.find((e) => e.primary)?.email ?? c.emails[0]?.email;
      if (!primaryEmail) continue;
      if (display.toLowerCase().includes(needle) || primaryEmail.toLowerCase().includes(needle)) {
        hits.push({ email: primaryEmail, display });
      }
    }
    return hits;
  }

  private toSnippet(html: string): string {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  private resolveAttachments(mailbox: MemoryMailbox, aids?: string[]): ProviderAttachmentMeta[] {
    if (!aids || aids.length === 0) return [];
    const metas: ProviderAttachmentMeta[] = [];
    for (const aid of aids) {
      const stored = mailbox.attachments.get(aid);
      if (!stored) continue;
      metas.push({
        part: aid,
        filename: stored.filename,
        contentType: stored.contentType,
        size: stored.data.length,
        isInline: false,
      });
    }
    return metas;
  }

  /**
   * Attachment bytes are keyed two ways in `mailbox.attachments`: seeded data
   * (Task 1) is keyed by messageId (one attachment per seeded message), while
   * attachments uploaded via `uploadAttachment` and threaded through
   * `sendMessage`/`saveDraft` are keyed by their own `aid` (== the message's
   * attachment `part`). Try the part-keyed lookup first, then fall back to the
   * messageId-keyed seed convention.
   */
  private findAttachmentBytes(
    mailbox: MemoryMailbox, messageId: string, part: string,
  ): { filename: string; contentType: string; data: Buffer } {
    const message = mailbox.messages.find((m) => m.id === messageId);
    if (!message) throw new NotFoundException('Message not found');
    const meta = message.attachments?.find((a) => a.part === part);
    if (!meta) throw new NotFoundException('Attachment not found');
    const stored = mailbox.attachments.get(part) ?? mailbox.attachments.get(messageId);
    if (!stored) throw new NotFoundException('Attachment not found');
    return stored;
  }
}
