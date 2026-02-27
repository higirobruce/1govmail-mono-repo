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
