export interface ProviderFolder {
  id: string; name: string; path: string;
  type?: string;                 // inbox|sent|drafts|trash|junk|custom
  /**
   * Content class of the folder — 'message' | 'contact' | 'appointment' |
   * 'task' | 'document'. MailService maps this to its own FolderType enum when
   * upserting, so the field has to survive the neutral DTO.
   */
  view?: string;
  unreadCount: number; totalCount: number;
  parentId?: string;
}

export interface ProviderAddress { email: string; name?: string }

export interface ProviderAttachmentMeta {
  part: string; filename: string; contentType: string; size: number;
  isInline: boolean; contentId?: string;
}

export interface ProviderMessage {
  id: string; conversationId: string | null; folderId: string;
  subject: string | null; snippet: string | null;
  from: ProviderAddress; to: ProviderAddress[]; cc: ProviderAddress[]; bcc: ProviderAddress[];
  receivedAt: Date; size: number;
  isRead: boolean; isFlagged: boolean; hasAttachments: boolean;
  /** Zimbra flag char 'd'. Persisted on Message.isDraft by every sync path. */
  isDraft: boolean;
  tags: string[];
  bodyHtml?: string | null; bodyText?: string | null;
  attachments?: ProviderAttachmentMeta[];
}

export interface ProviderMessagePage { messages: ProviderMessage[]; total: number; more: boolean }

export interface ProviderContact {
  id: string; displayName: string | null;
  firstName?: string; lastName?: string;
  emails: string[]; phones: string[]; company?: string;
}

export interface ProviderEventAttendee extends ProviderAddress { ptst?: string }

export interface ProviderEvent {
  id: string; title: string; location?: string;
  startAt: Date; endAt: Date; allDay: boolean;
  description?: string;
  organizer?: ProviderAddress; attendees: ProviderEventAttendee[];
  // extend with the fields calendar.service actually reads (recurrence, ptst, apptId…) during Task 8
}

export interface ProviderFreeBusy {
  busy: Array<{ s: number; e: number }>;
  tentative: Array<{ s: number; e: number }>;
  unavailable: Array<{ s: number; e: number }>;
}

export interface ProviderAuthResult {
  authToken?: string; csrfToken?: string; displayName?: string;
  twoFactorRequired: boolean;
}

export interface MailProviderCapabilities {
  signatures: boolean; identities: boolean; serverPrefs: boolean;
  changePassword: boolean; twoFactor: boolean;
}
