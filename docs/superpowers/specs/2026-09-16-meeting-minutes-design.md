# Minutes of meeting, from a calendar event — design

**Date:** 2026-09-16
**Status:** approved in chat, awaiting spec review
**Branch:** ft-hyperscale

## 1. Why

A meeting happens; someone writes the minutes; everyone who was there needs to
read them, and people who were not there often need to be sent them. Today that
journey leaves 1Gov Mail entirely: there is a Meeting Minutes document template,
but nothing connects it to the meeting it belongs to, so every attendee who
opens it does so through a link somebody pasted into a mail.

Bruce asked for minutes that can be created **from the calendar event**, are
**visible to all attendees**, and are **shareable**.

## 2. What already exists

Unusually much. This design is mostly wiring.

| Piece | State |
|---|---|
| A `Meeting Minutes` document template (attendees, agenda, decisions, action items) | exists — `apps/web/lib/docs/templates.ts` |
| `Document` with `shareToken` / `isShared` / `sharePermission` | exists |
| `DocumentInvite(documentId, invitedEmail, role)` with `InviteRole = VIEWER \| EDITOR` | exists |
| **Invites grant real access** — `DocsService.findOne` falls back from ownership to the invite and returns its role | exists (`docs.service.ts:104`) |
| "Shared with me" — lists documents invited to your email | exists (`docs.service.ts:63`) |
| Public share page for token holders | exists (`app/docs/share/[token]`) |
| Document version history, comments, activity log | exists |
| `CalendarEvent.attendees` (string[] of emails, enriched on detail fetch) | exists |
| A cross-user identity for a meeting | **does not exist** |
| Any link between an event and a document | **does not exist** |

So the access-control machinery is already multi-user. What is missing is a way
to say "this document is the record of *that* meeting" in a way every attendee's
copy of the meeting agrees on.

## 3. The problem this design solves

`CalendarEvent` is keyed `@@unique([userId, zimbraId])`, and `zimbraId` is a
per-mailbox item id. **Alice's copy of Thursday's meeting and Bob's copy are
unrelated rows.** Nothing in the schema is common to both, so "one canonical
minutes document per meeting" has nothing to hang on.

The iCalendar **UID** is that common thing — the same string in every
attendee's copy, which is what iCalendar defines it for. Neither provider mapper
reads it today.

**One correction that shapes the key:** a UID is shared by *every occurrence of
a recurring series*. Keying on UID alone would give one document for a whole
weekly meeting — and weekly meetings are exactly the ones with minutes every
week. The key is therefore the **occurrence**, not the series.

## 4. Decisions taken

| Question | Decision |
|---|---|
| Attendee access | **Both** — a `DocumentInvite` per attendee email, *and* the share link enabled. Internal attendees get it in "Shared with me"; invites for non-users lie dormant and light up if they ever sign in; external attendees get sent the link. |
| Who may create | **Anyone who can see the event.** The note-taker is often not the organizer. First creator owns the document; everyone else edits via their invite. |
| Cardinality | **One canonical document per occurrence**, enforced by a unique key. |
| Attendee role | **`EDITOR`.** Minutes get corrections and action items get ticked off; version history and the activity log make changes attributable and recoverable. VIEW-for-all would funnel every correction through one person, which in practice means corrections do not happen. |
| Share link permission | **`VIEW`.** Being *sent* the minutes is not the same as being *in* the meeting. |
| Identity source | The iCalendar UID (§3), with a documented fallback when absent. |

## 5. Architecture

```
calendar event drawer                    "Create minutes"
        │                                       │
        │ composes prefilled content from the   │
        │ Meeting Minutes template              ▼
        │                     POST /calendar/events/:id/minutes  { title, content }
        │                                       │
        │                                       ▼   ONE transaction
        │                          ┌────────────────────────────┐
        │                          │ Document (owner = caller)  │
        │                          │ DocumentInvite × attendees │  EDITOR
        │                          │ share link enabled         │  VIEW
        │                          │ MeetingMinutes link row    │
        │                          └────────────────────────────┘
        ▼                                       │
event detail response  ◄── minutesDocumentId ───┘
        │
        └─► drawer shows "Open minutes" for every attendee on 1Gov Mail
            and the document appears in their Docs → Shared with me
```

### 5.1 Data model

- **`CalendarEvent.icalUid String?`** — the cross-user meeting identity.
- **`MeetingMinutes`** — the link table:
  - `icalUid String`
  - `occurrenceStartAt DateTime` — **always the event row's own `startAt`.**
    Both providers expand a recurring series into one row per instance, so an
    instance's `startAt` *is* its occurrence, and a non-recurring event is
    simply the degenerate case of one occurrence. No separate recurrence-id
    handling is needed.
  - `documentId String` → `Document`, `onDelete: Cascade`
  - `createdBy String` → `User`
  - `createdAt DateTime @default(now())`
  - **`@@unique([icalUid, occurrenceStartAt])`** — one record per occurrence, enforced by the database rather than by application checks.
  - `@@index([documentId])`

`onDelete: Cascade` on `documentId` matters: deleting the minutes removes the
link, so the event offers "Create minutes" again instead of a button that 404s.

### 5.2 Where the UID comes from

- **EWS** — add `<t:FieldURI FieldURI="calendar:UID"/>` to the calendar request
  that already asks for `calendar:RequiredAttendees` and `calendar:Organizer`.
  No extra round trip.
- **Zimbra** — take `uid` from the search response if it is present; otherwise
  from the `GetAppointment` detail the app **already fetches** when an event is
  opened (`calendar.service.ts:95`). ⚠ The search `appt` node type does not
  currently declare `uid`; whether Zimbra returns one must be verified against
  the live server (the raw-capture technique used for the EWS work). If it does
  not, the detail path is the answer and the list path simply leaves `icalUid`
  null until an event is opened.
- **Memory provider** — leaves it null, which exercises the fallback in tests.

### 5.3 Creation

`POST /calendar/events/:eventId/minutes`, body `{ title, content }`.

The client composes the content, prefilled from the event: meeting title, date
and time, location, the organizer as chairperson, and the attendee list. The
template stays in `apps/web` next to the editor that renders it; the API stays
TipTap-agnostic and only stores what it is given.

The server then, in **one transaction**:

1. creates the `Document` owned by the caller;
2. `createMany` the `DocumentInvite` rows — attendee emails lowercased, deduped,
   blanks dropped, **the caller skipped** (they own it) — role `EDITOR`,
   `skipDuplicates`;
3. enables sharing: `isShared: true`, `sharePermission: VIEW`, `shareToken` via
   the existing `shortToken()`;
4. inserts the `MeetingMinutes` row.

**Keep that transaction small.** Content arrives composed, no provider calls
happen inside it, and invites go in as one `createMany` rather than N inserts.
This is a direct lesson from the notifications work, where an interactive
transaction holding a pooled connection became a load-correlated failure at the
5,000-mailbox target.

**Idempotent.** If a link row already exists for `(icalUid, occurrenceStartAt)`,
the endpoint creates nothing and returns that `documentId`. Two attendees
clicking simultaneously get the same document; the unique key is what guarantees
it, not a check-then-act.

**Response:** `{ documentId, linked: boolean }`. `linked: false` means the event
had no UID and this document is not the canonical record for anyone else.

### 5.4 Discovery

The event detail response gains **`minutesDocumentId: string | null`**, resolved
by `(icalUid, occurrenceStartAt)`. The drawer therefore needs no extra request:
the button reads "Create minutes" or "Open minutes", and the latter navigates to
the document. Attendees additionally find it under Docs → Shared with me, which
already works.

### 5.5 Failure and edge behaviour

| Case | Behaviour |
|---|---|
| Event has no `icalUid` | A document is still created, with no link row; response says `linked: false`. Other attendees' drawers still offer "Create minutes" for that event. |
| Recurring series | Each occurrence keys separately, so each meeting gets its own minutes. |
| Event is not the caller's | Refused. |
| Attendee list changes later | Invites are a **snapshot at creation**. A person added next week is not auto-invited; they are added through the document's existing share controls. |
| Minutes document deleted | Link row cascades away; the event offers creation again. |
| Meeting deleted or cancelled | The minutes survive — they are keyed by UID, not by anyone's event row. Minutes outlive the meeting they record. |
| Any write fails | The whole transaction rolls back; nothing partial survives and the user can retry. |

## 6. Testing

- **Provider mappers** — `icalUid` is exposed from fixtures: EWS from
  `calendar:UID`; Zimbra from a search response that has it, and from the
  detail response when the search does not.
- **Creation** — creates document, invites, share link and link row; a second
  call returns the same `documentId` and creates nothing; two occurrences of one
  series produce two documents; a UID-less event reports `linked: false` and
  writes no link row; an event belonging to another user is refused.
- **Invite hygiene** — emails lowercased and deduped, the caller excluded,
  blanks dropped, role `EDITOR`.
- **Atomicity** — a failure during invite creation leaves no document and no
  link row. The test must assert the writes ran **on the transaction client**,
  not merely during the transaction window: that distinction was the seventh
  self-deceiving test found in the notifications work.
- **Discovery** — event detail exposes `minutesDocumentId` for a linked
  occurrence and null otherwise.
- **Web** — the drawer renders "Create minutes" versus "Open minutes" from that
  field, and creating posts the prefilled content then navigates.

## 7. What this deliberately does not do

- **No AI-generated minutes.** There is no transcript to generate from; the
  value here is the record being in the right place with the right people on it.
- **No attendee reconciliation** after creation (§5.5).
- **No cross-organisation canonical record.** The UID unifies attendees who use
  1Gov Mail. An external attendee at another ministry gets the share link and
  can still keep their own notes; nothing can reach into their calendar.
- **No new access-control model.** Invites and share tokens already exist and
  already work; this feature uses them rather than inventing a parallel one.
- **No changes to the provider event.** Writing a marker into the event's
  description would be cross-user by construction but mutates the meeting for
  everyone and can fire update mails from the calendar server. Rejected.

## 8. Known limits, for the release note

- Minutes are canonical only among 1Gov Mail users; external attendees read a
  shared link.
- An event with no iCalendar UID falls back to per-user minutes.
- Attendees added after creation are not invited automatically.
- Deleting a meeting leaves its minutes behind.
