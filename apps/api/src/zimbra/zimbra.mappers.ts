import {
  ProviderAddress,
  ProviderAttachmentMeta,
  ProviderContact,
  ProviderEvent,
  ProviderEventAttendee,
  ProviderEventDetail,
  ProviderFolder,
  ProviderFreeBusy,
  ProviderMessage,
} from '../provider/provider-types';
import { CalendarEventPayload } from '../provider/mail-provider.interface';

// ─── Zimbra wire shapes ──────────────────────────────────────────────────────
// These describe what Zimbra's JSON SOAP actually returns. They live here (not
// in zimbra.service.ts) so the mappers are the single place that knows the wire
// vocabulary — `su`, `fr`, `e[]`, `mp[]`, the flag chars in `f`, `tn`. Nothing
// outside this file and ZimbraService should reference them.

export interface ZimbraFolder {
  id: string;
  name: string;
  absFolderPath: string;
  u?: number;  // unread count
  n?: number;  // total count
  color?: number;
  l?: string;  // parent id
  view?: string; // folder type: 'message' | 'contact' | 'appointment' | 'task' | 'document' | …
}

export interface ZimbraMessage {
  id: string;
  cid?: string; // conversation id
  l: string;   // folder id
  f?: string;  // flags: u=unread, f=flagged, a=has-attachment, d=draft, r=replied, w=forwarded
  s: number;   // size
  d: number;   // date (ms)
  su?: string; // subject
  fr?: string; // fragment/snippet
  tn?: string; // comma-separated tag names
  e?: ZimbraEmailAddress[];
  mp?: ZimbraMessagePart[];
}

export interface ZimbraEmailAddress {
  a: string;  // address
  d?: string; // display name
  t: string;  // type: f=from, t=to, c=cc, b=bcc, r=reply-to
}

export interface ZimbraMessagePart {
  part: string;
  ct: string;   // content type
  body?: boolean;
  content?: string;
  mp?: ZimbraMessagePart[];
  filename?: string;
  ci?: string;  // content-id (inline images carry it, wrapped in angle brackets)
  s?: number;   // size
}

// ─── Messages ────────────────────────────────────────────────────────────────

/** Addresses of one role, in wire order. `name` stays `undefined` (not null)
 *  when Zimbra omits the display name — callers that need null apply their own
 *  `?? null`, and JSON.stringify drops the key exactly as it did before. */
function addressesOfRole(addrs: ZimbraEmailAddress[], role: string): ProviderAddress[] {
  return addrs.filter((a) => a.t === role).map((a) => ({ email: a.a, name: a.d }));
}

/** First part (depth-first) whose content type matches and which Zimbra marked
 *  as the display body. */
function extractBody(parts: ZimbraMessagePart[], contentType: string): string | null {
  for (const part of parts) {
    if (part.ct === contentType && part.body) return part.content ?? null;
    if (part.mp) {
      const found = extractBody(part.mp, contentType);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Walk the MIME tree once and collect every file-bearing part, tagging each as
 * inline or not.
 *
 * A part is *inline* when it carries a content-id and an `image/*` type and is
 * not the display body (signature logos, pasted images, tracking pixels). It is
 * a real *attachment* when it has a filename, is not the display body, and is
 * not an inline image — surfacing inline images as attachments would pollute
 * attachment counts and the "has attachment" filter.
 */
function collectAttachments(parts: ZimbraMessagePart[]): ProviderAttachmentMeta[] {
  const result: ProviderAttachmentMeta[] = [];
  for (const part of parts) {
    const isInlineImage = !!(part.ci && part.ct?.startsWith('image/'));
    if (isInlineImage && !part.body) {
      result.push({
        part: String(part.part),
        filename: part.filename ?? '',
        contentType: part.ct,
        size: part.s ?? 0,
        isInline: true,
        // CIDs come wrapped in angle brackets; HTML `src="cid:…"` never has them.
        contentId: part.ci!.replace(/^<|>$/g, ''),
      });
    } else if (part.filename && !part.body && !isInlineImage) {
      result.push({
        part: String(part.part),
        filename: part.filename,
        contentType: part.ct ?? 'application/octet-stream',
        size: part.s ?? 0,
        isInline: false,
        contentId: undefined,
      });
    }
    if (part.mp) result.push(...collectAttachments(part.mp));
  }
  return result;
}

export function mapZimbraMessage(raw: ZimbraMessage): ProviderMessage {
  const flags = raw.f ?? '';
  const addrs = raw.e ?? [];
  const from = addrs.find((a) => a.t === 'f');
  const parts = raw.mp ?? [];

  return {
    id: String(raw.id),
    conversationId: raw.cid != null ? String(raw.cid) : null,
    folderId: String(raw.l),
    subject: raw.su ?? null,
    snippet: raw.fr ?? null,
    from: { email: from?.a ?? '', name: from?.d },
    to: addressesOfRole(addrs, 't'),
    cc: addressesOfRole(addrs, 'c'),
    // Bcc is only ever visible on the user's own sent/draft items.
    bcc: addressesOfRole(addrs, 'b'),
    receivedAt: new Date(raw.d),
    size: raw.s ?? 0,
    isRead: !flags.includes('u'),
    isFlagged: flags.includes('f'),
    isDraft: flags.includes('d'),
    // List and search hits carry no part tree, so attachment presence comes
    // from the flag — never from walking `mp`.
    hasAttachments: flags.includes('a'),
    tags: raw.tn ? raw.tn.split(',') : [],
    bodyHtml: extractBody(parts, 'text/html'),
    bodyText: extractBody(parts, 'text/plain'),
    attachments: collectAttachments(parts),
  };
}

// ─── Folders ─────────────────────────────────────────────────────────────────

export function mapZimbraFolder(raw: ZimbraFolder): ProviderFolder {
  return {
    id: String(raw.id),              // Zimbra may return numeric IDs
    name: raw.name ?? 'Unnamed',
    path: raw.absFolderPath ?? (raw.name ? `/${raw.name}` : '/'),
    unreadCount: typeof raw.u === 'number' ? raw.u : 0,
    totalCount: typeof raw.n === 'number' ? raw.n : 0,
    parentId: raw.l != null ? String(raw.l) : undefined,
    view: raw.view ?? undefined,
  };
}

// ─── Contacts + GAL ──────────────────────────────────────────────────────────

/** Zimbra returns `_attrs` (SearchResponse, SearchGalResponse) or `a[]`
 *  (GetContactsResponse/CreateContactResponse) — never both. */
export interface ZimbraContact {
  id: string | number;
  _attrs?: Record<string, string>;
  a?: Array<{ n: string; _content?: unknown }>;
}

/** Ported verbatim from ContactsService.parseZimbraContact so the DB write and
 *  the REST payload (apps/web reads `emails`/`phones` as rich role-tagged
 *  arrays, not flat strings — see ProviderContact) stay byte-identical. */
export function mapZimbraContact(raw: ZimbraContact): ProviderContact {
  let attrs: Record<string, string> = {};
  if (raw._attrs) {
    attrs = raw._attrs;
  } else if (Array.isArray(raw.a)) {
    for (const a of raw.a) {
      if (a.n && a._content != null) attrs[a.n] = String(a._content);
    }
  }

  const emails: ProviderContact['emails'] = [];
  if (attrs.email) emails.push({ email: attrs.email, type: 'work', primary: true });
  if (attrs.email2) emails.push({ email: attrs.email2, type: 'personal' });
  if (attrs.email3) emails.push({ email: attrs.email3, type: 'other' });

  const phones: ProviderContact['phones'] = [];
  if (attrs.workPhone) phones.push({ number: attrs.workPhone, type: 'work' });
  if (attrs.mobilePhone) phones.push({ number: attrs.mobilePhone, type: 'mobile' });
  if (attrs.homePhone) phones.push({ number: attrs.homePhone, type: 'home' });

  const firstName = attrs.firstName ?? null;
  const lastName = attrs.lastName ?? null;
  const displayName =
    attrs.fullName ??
    attrs.fullName2 ??
    (firstName || lastName ? [firstName, lastName].filter(Boolean).join(' ') : null);

  return {
    id: String(raw.id),
    displayName,
    firstName,
    lastName,
    nickname: attrs.nickname ?? null,
    company: attrs.company ?? null,
    jobTitle: attrs.jobTitle ?? null,
    emails,
    phones,
    notes: attrs.notes ?? null,
  };
}

/** Reverse of mapZimbraContact — serialises a (partial) ProviderContact into
 *  the `a[]` attrs Zimbra's Create/ModifyContactRequest expect. Ported from
 *  ContactsService.dataToAttrs, generalised from ContactData's fixed
 *  email/email2/email3 + phone/mobile/homePhone fields to the role-tagged
 *  ProviderContact.emails/phones arrays ContactsService now builds instead —
 *  same role vocabulary (work/personal/other, work/mobile/home), so the SOAP
 *  request body is unchanged for any input ContactsService actually sends. */
export function mapProviderContactToZimbraAttrs(
  contact: Partial<ProviderContact>,
): Array<{ n: string; _content: string }> {
  const attrs: Array<{ n: string; _content: string }> = [];
  const add = (n: string, v: string | undefined | null) => {
    if (v !== undefined && v !== null && v !== '') attrs.push({ n, _content: String(v) });
  };
  const emailByType = (type: string) => contact.emails?.find((e) => e.type === type)?.email;
  const phoneByType = (type: string) => contact.phones?.find((p) => p.type === type)?.number;

  add('firstName', contact.firstName);
  add('lastName', contact.lastName);
  add('fullName', contact.displayName);
  add('nickname', contact.nickname);
  add('company', contact.company);
  add('jobTitle', contact.jobTitle);
  add('email', emailByType('work'));
  add('email2', emailByType('personal'));
  add('email3', emailByType('other'));
  add('workPhone', phoneByType('work'));
  add('mobilePhone', phoneByType('mobile'));
  add('homePhone', phoneByType('home'));
  add('notes', contact.notes);
  return attrs;
}

// ─── Calendar ────────────────────────────────────────────────────────────────
//
// Zimbra returns two quite different `appt` nodes and it matters which one you
// have:
//
//   SearchRequest{types:'appointment', calExpandInstStart/End}
//     → `appt[]`, each with the recurrence already expanded into `inst[]`
//       (one entry per occurrence inside the requested window), the appointment
//       title in `name`, and a flat `at[]` attendee list with no reliable ptst.
//
//   GetAppointmentRequest{includeContent:1}
//     → a single `appt` whose real payload is one level down in
//       `inv[].comp[]`: that is where the complete attendee list with
//       participation status lives, alongside the `ms`/`rev` counters and the
//       invite message id an update has to quote.
//
// Both mappers below are ports of the parsing CalendarService used to do
// inline, kept behaviour-identical down to which fallback wins.

export interface ZimbraCalUser {
  a?: string;     // address
  d?: string;     // display name (CN)
  p?: string;     // personal name — what Create/ModifyAppointmentRequest sends
  ptst?: string;  // participation status: AC | DE | TE | NE
  role?: string;
  rsvp?: number;
}

/** An expanded occurrence of an appointment inside the requested window. */
export interface ZimbraAppointmentInstance {
  s?: number;                 // start (ms)
  dur?: number;               // duration (ms) — often only on the appt, not the instance
  allDay?: boolean | number;
}

/** SearchResponse `appt` node. */
export interface ZimbraAppointment {
  id: string | number;
  invId?: string | number;    // inbox message id of the original invite
  name?: string;              // title
  su?: string;                // subject (older/alternate title carrier)
  desc?: string;
  loc?: string;
  allDay?: boolean | number;
  dur?: number;
  recur?: unknown;            // presence ⇒ recurring
  inst?: ZimbraAppointmentInstance[];
  or?: ZimbraCalUser;
  at?: ZimbraCalUser[];
}

export interface ZimbraInviteComponent {
  at?: ZimbraCalUser[];
  or?: ZimbraCalUser;
}

export interface ZimbraInvite {
  id?: string | number;       // the invite *message* id
  comp?: ZimbraInviteComponent[];
}

/** GetAppointmentResponse `appt` node. */
export interface ZimbraAppointmentDetail {
  id?: string | number;
  ms?: string | number;       // modifiedSequence
  rev?: string | number;
  // The JSON bridge collapses single-item arrays into plain objects, so this
  // arrives either way.
  inv?: ZimbraInvite | ZimbraInvite[];
  or?: ZimbraCalUser;
  at?: ZimbraCalUser[];
}

/** Zimbra's JSON bridge returns single-item arrays as plain objects at any level. */
function firstOf<T>(x: T | T[] | undefined): T | undefined {
  return Array.isArray(x) ? x[0] : x;
}

function calUserToAddress(u: ZimbraCalUser | undefined): ProviderAddress | undefined {
  const email = u?.a;
  if (!email) return undefined;
  // `d` is the CN Zimbra sends back; `p` is the personal name our own
  // Create/ModifyAppointmentRequest puts on the wire. Nothing consumes the
  // organizer's *name* today (CalendarEvent.organizer is an email column), so
  // this is tolerance, not behaviour.
  return { email, name: u!.d ?? u!.p };
}

/**
 * A calendar search hit → ProviderEvent, or null when the hit carried no
 * expanded instance (nothing to show for the requested window).
 *
 * Ported verbatim from CalendarService.parseAppt, including two deliberate
 * quirks:
 *  - only the FIRST expanded instance is used. A recurring appointment
 *    therefore yields one event per appointment, not one per occurrence; the
 *    `isRecurring` flag is all that survives of the recurrence. Changing this
 *    would change what the events endpoint returns.
 *  - attendees are mapped to `{email, name}` only. `ptst` is intentionally NOT
 *    carried here even when the wire has it: this array is persisted verbatim
 *    into the CalendarEvent.attendees JSON column and returned by the list
 *    endpoint, so adding a key would change the REST payload. Per-attendee
 *    status comes from mapZimbraAppointmentDetail, which is the only place
 *    CalendarService ever read it.
 */
export function mapZimbraAppointment(raw: ZimbraAppointment): ProviderEvent | null {
  const inst = Array.isArray(raw.inst) ? raw.inst[0] : null;
  if (!inst) return null;

  const startMs = inst.s ?? 0;
  // inst.dur is not always present in SearchResponse — fall back to the
  // appointment-level duration, then to one hour.
  const dur = inst.dur ?? raw.dur ?? 3_600_000;

  return {
    id: String(raw.id),
    inviteId: raw.invId != null ? String(raw.invId) : null,
    title: raw.name ?? raw.su ?? '(No title)',
    description: raw.desc ?? null,
    location: raw.loc ?? null,
    startAt: new Date(startMs),
    endAt: new Date(startMs + dur),
    allDay: !!(inst.allDay || raw.allDay),
    isRecurring: !!raw.recur,
    organizer: calUserToAddress(raw.or),
    attendees: Array.isArray(raw.at)
      ? raw.at.map((a) => ({ email: a.a as string, name: a.d ?? undefined }))
      : [],
  };
}

/**
 * A single-appointment fetch → ProviderEventDetail.
 *
 * Ported from CalendarService.getEvent (attendees/organizer) and .updateEvent
 * (invite message id, ms, rev), which read the same response through two
 * *different* accessors. That asymmetry is preserved on purpose:
 *
 *  - the attendee/organizer legs index `inv[0].comp[0]` positionally, so a
 *    bridge-collapsed object `inv` falls through to the top-level `at[]`/`or`;
 *  - the invite-message-id leg uses firstOf(), so it resolves through an object
 *    `inv` fine.
 *
 * Unifying them would be a real fix, but it would silently change which
 * attendee list the event endpoint returns for object-shaped `inv` responses —
 * out of scope for a zero-behaviour-change refactor. Flagged as debt.
 */
export function mapZimbraAppointmentDetail(raw: ZimbraAppointmentDetail): ProviderEventDetail {
  const toAttendee = (a: ZimbraCalUser): ProviderEventAttendee => ({
    email: a.a as string,
    name: a.d ?? undefined,
    ptst: a.ptst ?? undefined,
  });

  const comp = (raw.inv as ZimbraInvite[] | undefined)?.[0]?.comp?.[0];

  const attendees: ProviderEventAttendee[] | null = Array.isArray(comp?.at)
    ? comp!.at!.map(toAttendee)
    : Array.isArray(raw.at)
      ? raw.at.map(toAttendee)
      : null;

  const organizer = calUserToAddress(comp?.or) ?? calUserToAddress(raw.or);

  const invMsgId = firstOf(raw.inv)?.id;

  return {
    id: String(raw.id),
    attendees,
    organizer,
    inviteMessageId: invMsgId != null ? String(invMsgId) : null,
    modifiedSequence: raw.ms != null ? Number(raw.ms) : undefined,
    rev: raw.rev != null ? Number(raw.rev) : undefined,
  };
}

// ─── Free / Busy ─────────────────────────────────────────────────────────────

/** One `usr` entry of a GetFreeBusyResponse: b=busy, t=tentative, u=unavailable. */
export interface ZimbraFreeBusyUser {
  b?: Array<{ s: string | number; e: string | number }>;
  t?: Array<{ s: string | number; e: string | number }>;
  u?: Array<{ s: string | number; e: string | number }>;
}

export function mapZimbraFreeBusy(usr: ZimbraFreeBusyUser): ProviderFreeBusy {
  const norm = (arr: unknown): Array<{ s: number; e: number }> =>
    Array.isArray(arr) ? arr.map((i: any) => ({ s: Number(i.s), e: Number(i.e) })) : [];

  return {
    busy: norm(usr.b),
    tentative: norm(usr.t),
    unavailable: norm(usr.u),
  };
}

// ─── Calendar (app → wire) ───────────────────────────────────────────────────

/**
 * Zimbra calendar date-time, always expressed in UTC: `YYYYMMDD` for an all-day
 * event (a date has no time-of-day) and `YYYYMMDDTHHMM00Z` otherwise. Seconds
 * are always zeroed — the appointment UI has minute granularity.
 */
export function formatZimbraCalDateTime(d: Date, allDay: boolean): { d: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  if (allDay) return { d: date };
  return { d: `${date}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z` };
}

/**
 * Build the `m` (message) node that Create/ModifyAppointmentRequest carry.
 *
 * Both requests built this node from two verbatim copies of the same code; it
 * is hoisted here so the wire vocabulary lives in one place, exactly as
 * mapProviderContactToZimbraAttrs does for contacts. The output is
 * byte-identical to what both call sites sent before — including
 * `fb:'B'` (busy) and `transp:'O'` (opaque), the omission of `at` when there
 * are no attendees, and `loc` defaulting to '' rather than being dropped.
 *
 * Note the organizer name goes out as `p`, not `d`. That is what Zimbra's
 * Create/Modify request accepts, and it is asymmetric with the `d` that comes
 * back on a read — see calUserToAddress.
 */
export function mapCalendarEventPayloadToZimbraMessage(payload: CalendarEventPayload): {
  su: string;
  e: Array<{ t: string; a: string; p?: string }>;
  inv: { comp: unknown[] };
} {
  const or = {
    a: payload.organizerEmail,
    ...(payload.organizerName ? { p: payload.organizerName } : {}),
  };

  // Every attendee is invited as required and asked to RSVP; their status
  // starts at NE (needs action).
  const at = (payload.attendees ?? []).map((email) => ({
    a: email,
    role: 'REQ',
    ptst: 'NE',
    rsvp: 1,
  }));

  return {
    su: payload.title,
    // 'f' = from (organizer); 't' = to (each attendee gets an invite email)
    e: [
      { t: 'f', ...or },
      ...(payload.attendees ?? []).map((a) => ({ t: 't', a })),
    ],
    inv: {
      comp: [
        {
          name: payload.title,
          loc: payload.location ?? '',
          allDay: payload.allDay ? 1 : 0,
          fb: 'B',
          transp: 'O',
          s: formatZimbraCalDateTime(payload.startAt, payload.allDay),
          e: formatZimbraCalDateTime(payload.endAt, payload.allDay),
          or,
          ...(at.length ? { at } : {}),
          ...(payload.description ? { desc: { _content: payload.description } } : {}),
        },
      ],
    },
  };
}
