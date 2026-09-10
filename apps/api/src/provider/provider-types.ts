export type { MailSearchFilter } from './mail-search-filter';

/**
 * What a folder holds. Task 9 adjustment (Task 6 controller ruling): Task 5
 * carried Zimbra's own `view` string ('message' | 'contact' | 'appointment' |
 * 'task' | 'document') straight through the neutral DTO, which put provider
 * vocabulary in front of MailService. Renamed and re-spelled as a closed
 * neutral union; the Zimbra literals now stop inside zimbra/ (see
 * ZIMBRA_VIEW_TO_KIND in zimbra.mappers.ts). `undefined` means "the provider
 * did not say", which MailService treats as mail — the same result the old
 * `view: undefined` produced.
 */
export type ProviderFolderKind = 'mail' | 'contacts' | 'calendar' | 'tasks' | 'documents';

export interface ProviderFolder {
  id: string; name: string; path: string;
  type?: string;                 // inbox|sent|drafts|trash|junk|custom
  /** Content class of the folder. MailService maps this to its own FolderType
   *  enum when upserting, so the field has to survive the neutral DTO. */
  kind?: ProviderFolderKind;
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

/**
 * Result of a pre-session `authenticate` / `verifyTwoFactor` leg.
 *
 * Task 9 adjustments — Task 5 declared only
 * `{ authToken?, csrfToken?, displayName?, twoFactorRequired }`, but
 * AuthService.createSession (the single consumer) also reads two fields that
 * were missing, and both are load-bearing:
 *
 *  - `lifetime` — session lifetime in ms. It sets `User.tokenExpiry`, which
 *    JwtStrategy checks on every request. Dropping it would mean inventing an
 *    expiry, so it is required, not optional.
 *  - `redirectHost` — the backend the mailbox actually lives on, when the
 *    login endpoint is not it (Zimbra clusters answer AuthRequest with a
 *    `refer` host; EWS Autodiscover is the same idea). createSession persists
 *    it as the effective host; ignoring it makes every later call fail with
 *    an auth error against a freshly-issued, valid token. Named neutrally so
 *    the Zimbra element name stays inside zimbra/.
 *
 * `authToken` is also tightened from optional to required: both legs throw
 * rather than resolve without one, so no implementation can omit it.
 * With those three, the shape is exactly what ZimbraService already returned,
 * so the old exported `ZimbraAuthResult` became an identical parallel type and
 * was deleted rather than kept as a no-op mapping target.
 */
export interface ProviderAuthResult {
  authToken: string;
  /** Session lifetime in milliseconds. */
  lifetime: number;
  csrfToken?: string;
  displayName?: string;
  /** Host to address all subsequent calls to, when it differs from the login host. */
  redirectHost?: string;
  twoFactorRequired: boolean;
}

/**
 * One sending identity. Task 9 adjustment: Task 5 typed `getIdentities` as
 * `unknown[]`; this is the shape the settings flow has always returned and the
 * REST layer sends verbatim (GET /settings → `identities`), which apps/web
 * reads as `data.identities[0].attrs[...]`.
 *
 * `attrs` stays an open `Record<string, string>` of provider-native keys on
 * purpose: PATCH /settings/identity/:id takes an arbitrary attribute bag from
 * the client (`zimbraPrefFromDisplay`, `zimbraPrefReplyToAddress`,
 * `zimbraPrefDefaultSignatureId`, …) and MailService reads
 * `attrs.zimbraPrefDefaultSignatureId` off it. Enumerating those keys here
 * would be a REST contract change, which Phase 1 forbids; the EWS provider
 * will have to speak the same key names.
 */
export interface ProviderIdentity {
  id: string;
  name: string;
  attrs: Record<string, string>;
}

/**
 * One stored signature. Task 9 adjustment: as with ProviderIdentity, Task 5
 * had `unknown[]` — tightened to the real shape. Both `contentHtml` and
 * `contentText` are always present (empty string when the provider has no
 * body of that type): MailService.getDefaultSignatureHtml falls back from one
 * to the other, and the REST payload has always carried both keys.
 */
export interface ProviderSignature {
  id: string;
  name: string;
  contentHtml: string;
  contentText: string;
}

export interface MailProviderCapabilities {
  signatures: boolean; identities: boolean; serverPrefs: boolean;
  changePassword: boolean; twoFactor: boolean;
}
