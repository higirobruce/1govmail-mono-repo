import { Readable } from 'stream';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MailSession } from '../mail-session';
import {
  ProviderFolder, ProviderMessage, ProviderMessagePage, ProviderAddress, ProviderAttachmentMeta,
  ProviderAuthResult, MailProviderCapabilities,
} from '../provider-types';
import { MemoryStore, MemoryMailbox } from './memory-store';
import { SendMessagePayload, DraftPayload } from '../mail-provider.interface';

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

/**
 * In-memory `MailProvider` implementation backing the demo/dev "memory"
 * account type. Task 2 implements auth + folders + message reads; Tasks 3-5
 * add the remaining MailProvider methods to this same class. Not yet declared
 * `implements MailProvider` — see Task 1 ruling: with methods still missing
 * that would fail to compile. Method signatures below match the interface
 * exactly so Task 5's `implements` clause typechecks with no further changes.
 */
export class MemoryMailProvider {
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
    mailbox.folders = mailbox.folders.filter((f) => f.id !== folderId);
    mailbox.messages = mailbox.messages.filter((m) => m.folderId !== folderId);
  }

  async renameFolder(s: MailSession, folderId: string, name: string): Promise<void> {
    const mailbox = this.mb(s);
    const folder = mailbox.folders.find((f) => f.id === folderId);
    if (folder) {
      folder.name = name;
      folder.path = `/${name}`;
    }
  }

  async emptyFolder(s: MailSession, folderId: string): Promise<void> {
    const mailbox = this.mb(s);
    mailbox.messages = mailbox.messages.filter((m) => m.folderId !== folderId);
    const folder = mailbox.folders.find((f) => f.id === folderId);
    if (folder) {
      folder.totalCount = 0;
      folder.unreadCount = 0;
    }
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
      });
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

  // ---- private helpers ----------------------------------------------------------

  private recomputeFolderCounts(mailbox: MemoryMailbox, folderId: string): void {
    const folder = mailbox.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const inFolder = mailbox.messages.filter((m) => m.folderId === folderId);
    folder.totalCount = inFolder.length;
    folder.unreadCount = inFolder.filter((m) => !m.isRead).length;
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
