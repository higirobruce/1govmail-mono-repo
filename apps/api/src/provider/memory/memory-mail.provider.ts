import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { MailSession } from '../mail-session';
import {
  ProviderFolder, ProviderMessage, ProviderMessagePage,
  ProviderAuthResult, MailProviderCapabilities,
} from '../provider-types';
import { MemoryStore, MemoryMailbox } from './memory-store';

let folderCounter = 0;
function nextFolderId(): string {
  folderCounter += 1;
  return `folder-custom-${folderCounter}`;
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
}
