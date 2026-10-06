# Organisation digest — design

**Date:** 2026-10-06
**Status:** design approved in chat 2026-10-06; awaiting spec review
**Branch:** ft-hyperscale

## 1. Why

1Gov Mail is being adopted across the institution. Everyone who logs in sees
their own mail, their own calendar, their own documents — and nothing that tells
them what the institution as a whole is working on. The ask is a short, shared
answer to "what is going on in our org?", the same answer for everyone, without
anyone having to write it.

### 1.1 Why this is not the intranet that was dropped

A News/Intranet module was scoped and abandoned on 2026-09-04 (see the
`intranet-module-shelved` note). It failed because it was **authored** content —
announcements, an org chart, onboarding guides — which is a CMS somebody has to
maintain, and nobody volunteered.

This is **derived**. Every item comes from activity already in the system. There
is no editor, no publish step, and no one to chase. That difference is the whole
reason this is worth building when the intranet was not.

## 2. The privacy rule, and what it costs

Every content row in this database belongs to one mailbox. `Document`,
`CalendarEvent`, `Task`, `Message` are all scoped by `userId`. **There is no
org-level data to query.** An organisation view therefore has to be assembled
from many individuals' private copies — and the deployment makes that
dangerously easy, because one database holds every user's synced mail.

**The rule: the digest may only surface artefacts that were already collective.**
A meeting several people were invited to. A document shared with colleagues.
Minutes deliberately published. Every item was disclosed to multiple people by
the act that created it, so surfacing it discloses nothing new.

**What this costs: a mailbox contributes nothing directly.** Mail is the *source*
of these artefacts — the invitation that becomes a meeting, the thread that
becomes minutes — but inbox contents never appear. This was accepted knowingly;
mailboxes were the first thing named in the original request.

Rejected alternatives, recorded so they are not relitigated:

| Alternative | Why not |
|---|---|
| Collective artefacts + anonymised mail volume ("traffic with MINICT up 40%") | Still derived from private mailboxes; needs a policy position nobody has written. |
| Treat institution mail as institutional property, show subjects org-wide | Trivially easy given the data, and the exact reason the rule exists. Would need sign-off from whoever owns the privacy policy, in writing. |
| Per-viewer aggregation of only their own data | Zero leak, but two people see different "org" views, which defeats "same page". |

## 3. What it shows

Two lists, plus a short narrative above them.

- **Ahead** — significant meetings in the window.
- **Concluded** — minutes published, documents finalised or newly shared.

There are deliberately no "deadlines" here. Nothing in the schema carries a
shared deadline: tasks are per-user with no sharing model (§13), and a meeting's
start time is already the Ahead list. Promising deadlines would mean inventing a
source.

Every row is a real artefact with a link. Nothing is summarised into a number
the reader cannot click into.

## 4. The mechanism

### 4.1 Meetings: count the invitation, not the mailboxes

The obvious approach — group `calendar_events` by `icalUid` and count distinct
`userId` — was measured and rejected. It counts *how many mailboxes have synced*,
not how many people were invited. On `.155` only **3 of 13** mailboxes with
calendars carry any `icalUid` at all, because the column arrives on re-sync and
ten mailboxes have not re-synced since it shipped. The ceiling on that signal is
set by sync coverage, not by what the institution is doing.

**Use `CalendarEvent.attendees` instead.** The provider populates it on the
organiser's row regardless of whether any other mailbox has synced. A single row
listing fifteen attendees *is* an institution-wide meeting. Privacy is identical:
that attendee list was disclosed to all fifteen by the invitation.

`organizer` is a separate column, so `attendees` holds invitees only. An event
qualifies at **`MEETING_MIN_ATTENDEES = 2`** invitees (three people including the
organiser). The constant is named and tunable; §9 explains why it starts low.

**`icalUid` is demoted to de-duplication.** When two synced mailboxes do hold the
same meeting it prevents showing it twice. When absent, fall back to
`(lower(title), startAt)`. **No backfill and no re-sync campaign is required** —
this was the previously-assumed blocker and the measurement removed it.

### 4.2 Documents: already explicitly shared

A document qualifies when `isShared = true` or it has at least one
`DocumentInvite`. Both states are deliberate acts by the owner.

### 4.3 Minutes: already institution-level

`MeetingMinutes` is keyed `@@unique([icalUid, occurrenceStartAt])` and carries no
`userId` — it is the one existing model that is already about a meeting rather
than about a person.

## 5. Measurements that shaped this

Taken on `10.10.94.155` (27 users, 6,806 messages, 868 events, 77 documents) on
2026-10-06. `.154` was measured too and is useless for this purpose — 4 users and
2 calendar events.

| Signal | Measured | Consequence |
|---|---|---|
| `icalUid` coverage, last+next 7 days | 27 of 28 (96%) | fine for daily/weekly |
| `icalUid` coverage, last+next 30 days | 74 of 123 (60%) | monthly view degrades |
| Mailboxes with any UID | 3 of 13 | killed the mailbox-counting mechanism |
| Meetings in >1 mailbox | 4 (all exactly 2) | ditto |
| Recent events with >1 attendee | 11 of 148 | **the meetings lane will be sparse** |
| Documents shared or invited | 25 of 77 (~32%) | **documents are the strongest signal today** |

Two conclusions follow. **Documents lead the page**; meetings are the secondary
lane. And the meetings lane is expected to be thin at first — this dataset is
mostly solo calendar blocks, and genuine multi-party meetings grow with adoption.

## 6. Prerequisite, already cleared

`users.institutionId` was NULL for 19 of 27 users on `.155`, because the column
is written only at login and most accounts had not signed in since
domain-derived login shipped. One database serves RISA, MINICT and MINAFFET, so
every query here filters on it; without it the digest would show one
institution's activity to another.

Backfilled and indexed on both VMs on 2026-10-06, commit `bbdc7b9`: 19 → 0 NULL,
zero users disagreeing with their address domain. **This spec assumes that
holds.** A user with a NULL institution sees an empty digest, never a populated
one — the filter fails closed.

## 7. Data model

**No new table for the digest itself.** It is computed live per request; there is
nothing to store and nothing to go stale.

**One new table, for the shared narrative only.** The existing `AiGeneration`
cache is keyed `@@unique([userId, kind, targetKey])` — per user. A narrative that
must be identical for everyone in an institution does not fit that key, and
storing one row per user would defeat both the point and the cost saving.

```prisma
model OrgDigestNarrative {
  id            String   @id @default(cuid())
  institutionId String
  window        String   // 'day' | 'week' | 'month'
  contentHash   String   // hash of the item ids the narrative describes
  content       String
  model         String
  generatedAt   DateTime @default(now())

  @@unique([institutionId, window])
  @@index([institutionId])
  @@map("org_digest_narratives")
}
```

`contentHash` is what makes it correct: if the underlying items have not changed,
the stored narrative is reused; if they have, it is regenerated. One row per
institution per window — three rows per institution, total.

## 8. API

One endpoint.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/org/digest?window=day\|week\|month` | the two lists plus the narrative |

The caller's institution comes from the JWT subject's `institutionId`, never from
a parameter — the client cannot ask for another institution's digest. A caller
with no institution receives empty lists and no narrative.

Response shape:

```ts
{
  window: 'day' | 'week' | 'month',
  institutionId: string,
  narrative: string | null,       // null below the floor, see §9
  ahead:     OrgItem[],
  concluded: OrgItem[],
}

type OrgItem = {
  kind: 'meeting' | 'document' | 'minutes',
  id: string,                     // the artefact's own id, for linking
  title: string,
  at: string,                     // ISO; start for meetings, updated for docs
  participantCount: number,       // attendees, or invitees for a document
  href: string,
}
```

## 9. The narrative

Two or three sentences above the lists, naming what the institution is
collectively working on.

- **Grounded.** The model is given *only* the items already selected for the two
  lists — their titles, dates and participant counts. It never sees a message, a
  document body, or anything outside the window. Every claim it can make is
  traceable to a row rendered directly beneath it.
- **Shared, not per-viewer.** Cached per `(institutionId, window)`. Everyone in
  RISA reads literally the same sentences, which serves "same page" better than
  per-viewer generation and costs one generation per period rather than one per
  login.
- **Floored.** Below `NARRATIVE_MIN_ITEMS = 5`, the endpoint returns
  `narrative: null` and the page shows the lists alone. A model handed three
  items pads; handed zero it invents. Given §5's measurements this floor will be
  hit often at first, which is exactly why it exists.
- **Failure is silent.** If generation errors or times out, the endpoint returns
  the lists with `narrative: null`. The digest never fails because the model did.

`MEETING_MIN_ATTENDEES` starts at 2 rather than something larger because the
measured data has only 11 multi-attendee events in 60 days. A higher threshold
would be more "significant" and would also render the lane permanently empty.
Raise it once adoption makes the lane crowded.

## 10. Surface

A new nav item in the left rail, one page, with the same Today / This week /
This month window switcher the existing Executive briefing already uses. Reusing
that control matters: this is the org-level sibling of a personal view people
already know, not a new paradigm.

No interruption on login, no modal, no email. The page is visited, not pushed.

## 11. Build plan

1. `OrgDigestNarrative` model and migration.
2. Server: the two list queries (documents first, meetings second, minutes),
   institution-scoped, with de-duplication.
3. Server: the `/org/digest` endpoint and window handling.
4. Server: narrative generation, caching on `contentHash`, floor and failure path.
5. Web: API client method and the page.
6. Web: nav entry and the window switcher.

Phases 1–4 are server-only and land without user-visible change.

## 12. Testing

- **Institution isolation is the test that matters.** A RISA caller must never
  receive a MINAFFET artefact, and a caller with a NULL institution must receive
  empty lists. Both asserted directly, not inferred.
- Meeting selection: an event below the attendee threshold is excluded; one at
  the threshold is included; the same meeting present in two mailboxes appears
  once; de-duplication still works when `icalUid` is absent on one copy.
- Document selection: `isShared` and invited documents are included; a private
  document is not, even if recently edited.
- Narrative: below the floor the endpoint returns `narrative: null` and still
  returns the lists; a generation failure does the same; an unchanged
  `contentHash` reuses the cached row and does not call the model.
- Live smoke on both VMs after deploy. This feature sends no mail and creates no
  calendar entries, so the no-real-recipients rule does not come into play — the
  smoke is read-only. What to check live is that a RISA account and a MINAFFET
  account see different digests, which is the one thing a unit test with mocked
  data cannot fully prove.

## 13. Out of scope

- Mail as a direct source, in any form including anonymised counts (§2).
- A materialised nightly digest. The live query is the right size now; moving it
  behind a cache is the known upgrade if the 5,000-mailbox target in the infra
  scale plan lands.
- An archive of past periods. Nobody asked for one.
- Tasks. They are per-user with no sharing model, so nothing about them is
  collective. Named here because the original request listed them.
- Any authored or curated content. That is the intranet, and it was dropped.
- Backfilling `icalUid` (§4.1 removed the need).

## 14. Assumptions to confirm on review

1. **`attendees` excludes the organiser.** `organizer` is a separate column, so a
   2-invitee threshold means three people. If the provider ever includes the
   organiser in the array, the threshold means two people and should become 3.
2. **`MEETING_MIN_ATTENDEES = 2`** is deliberately permissive to keep the lane
   non-empty at current volumes.
3. **`NARRATIVE_MIN_ITEMS = 5`** as the floor.
4. **Documents lead, meetings follow** — driven by §5's measurements, not by
   taste. If meetings matter more editorially, say so and the order flips.
