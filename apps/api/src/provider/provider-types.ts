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

/**
 * Task 5 specced `emails`/`phones` as flat `string[]`. Reality (read off
 * ContactsService.parseZimbraContact/dataToAttrs, Task 6-style fixture
 * correction): the DB `Contact.emails`/`Contact.phones` JSON columns — and
 * the REST payload apps/web reads directly via `c.emails.find(e => e.primary)`
 * and `c.emails[0].email` (apps/web/app/(app)/contacts/page.tsx) — are typed
 * arrays carrying a role tag and a primary flag, not bare strings. Widened to
 * match.
 */
export interface ProviderContactEmail { email: string; type: string; primary?: boolean }
export interface ProviderContactPhone { number: string; type: string }

export interface ProviderContact {
  id: string; displayName: string | null;
  firstName?: string | null; lastName?: string | null;
  nickname?: string | null; company?: string | null; jobTitle?: string | null;
  emails: ProviderContactEmail[]; phones: ProviderContactPhone[];
  notes?: string | null;
}

/** `ptst` is Zimbra's participation status — AC/DE/TE/NE. Kept as the raw
 *  two-letter code because apps/web renders it directly off the
 *  CalendarEvent.attendees JSON column. */
export interface ProviderEventAttendee extends ProviderAddress { ptst?: string }

/**
 * One calendar event as the app layer wants it.
 *
 * Task 8 adjustments (all additive except the two widenings noted):
 *  - `inviteId` — Zimbra's `invId`, the *inbox message* id of the original
 *    invite. SendInviteReplyRequest needs this, not the calendar item id, so
 *    CalendarService persists it as CalendarEvent.zimbraInviteId.
 *  - `isRecurring` — presence of a recurrence rule on the appointment. Persisted
 *    as CalendarEvent.isRecurring; the expansion itself is not modelled here
 *    because the only consumer takes the first expanded instance per appointment.
 *  - `location` / `description` widened from `string` to `string | null`. They
 *    are written straight into nullable Prisma columns on both create AND
 *    update; `undefined` on an update means "leave unchanged" in Prisma, so
 *    collapsing null to undefined would stop a cleared field from ever being
 *    cleared in the cache. The null has to survive the neutral DTO.
 */
export interface ProviderEvent {
  id: string; title: string; location?: string | null;
  startAt: Date; endAt: Date; allDay: boolean;
  description?: string | null;
  organizer?: ProviderAddress; attendees: ProviderEventAttendee[];
  inviteId: string | null;
  isRecurring: boolean;
}

/**
 * The extra detail a single-appointment fetch returns beyond a list hit.
 *
 * Task 8 adjustment: Task 5 declared `getAppointment` as
 * `Promise<ProviderEvent & { attendees: ProviderEventAttendee[] }>`. The real
 * call sites (CalendarService.getEvent and .updateEvent) never read the
 * title/start/end off this response — they only want the enriched attendee
 * list, the organizer, and the three ids/counters an appointment update needs.
 * Modelling it as a full ProviderEvent would force the mapper to invent
 * start/end values from a wire node that does not reliably carry them, so this
 * is a separate, narrower shape.
 */
export interface ProviderEventDetail {
  id: string;
  /**
   * `null` — not `[]` — when the response carried no attendee list at all.
   * The distinction is load-bearing: CalendarService keeps its cached attendee
   * list in that case rather than blanking it.
   */
  attendees: ProviderEventAttendee[] | null;
  organizer?: ProviderAddress;
  /**
   * Id of the invite message *inside* the appointment. An appointment update
   * has to be addressed as "{calendarItemId}-{inviteMessageId}"; the caller
   * owns the join because it holds the calendar item id.
   */
  inviteMessageId: string | null;
  /** Optimistic-concurrency counters the provider requires on an update. */
  modifiedSequence?: number;
  rev?: number;
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
