export interface EmailAddress {
  email: string;
  name?: string;
}

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  url?: string;
}

export interface MessageSummary {
  id: string;
  zimbraId: string;
  subject: string | null;
  snippet: string | null;
  fromEmail: string;
  fromName: string | null;
  toRecipients: EmailAddress[];
  isRead: boolean;
  isStarred: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  tags: string[];
  receivedAt: string;
}

export interface MessageDetail extends MessageSummary {
  bodyText: string | null;
  bodyHtml: string | null;
  ccRecipients: EmailAddress[];
  bccRecipients: EmailAddress[];
  replyTo: string | null;
  attachments: Attachment[];
  conversationId: string | null;
}

export interface Folder {
  id: string;
  zimbraId: string;
  name: string;
  path: string;
  parentId: string | null;
  type: 'MAIL' | 'CONTACTS' | 'CALENDAR' | 'TASKS' | 'BRIEFCASE';
  unreadCount: number;
  totalCount: number;
  color: string | null;
}

export interface FolderTree extends Folder {
  children: FolderTree[];
}

export interface ComposePayload {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  replyToMessageId?: string;
  attachments?: File[];
}

export interface PaginatedMessages {
  messages: MessageSummary[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/**
 * The spam folder's path, which differs by Zimbra deployment — some report
 * `/Junk`, others `/Spam`.
 *
 * Both sides of the app have to agree on this set: the API files blocked
 * senders into it and refuses to "un-spam" a message that is not in it, while
 * the web decides where to offer the "Not spam" action. A copy per app is how
 * those two quietly drift apart, so there is exactly one definition here.
 */
export const SPAM_FOLDER_PATHS = ['/Junk', '/Spam'] as const;

/** Whether `path` is the account's spam folder. Tolerates a missing path. */
export function isSpamFolderPath(path?: string | null): boolean {
  return !!path && (SPAM_FOLDER_PATHS as readonly string[]).includes(path);
}

/**
 * Folders holding mail the user sent (or is about to). The sender is the user
 * in every row, so listing "From" there is wasted column — the addressee takes
 * its place, which is what Zimbra does and the only way to scan own mail.
 */
export const SENT_LIKE_FOLDER_PATHS = ['/Sent', '/Drafts', '/Outbox'] as const;

/** Whether rows in `path` should name the addressee instead of the sender.
 *  Exact match only: "/Sent items 2024" is somebody's own archive of RECEIVED
 *  mail, and a prefix match would silently relabel every row in it. */
export function isSentLikeFolderPath(path?: string | null): boolean {
  return !!path && (SENT_LIKE_FOLDER_PATHS as readonly string[]).includes(path);
}
