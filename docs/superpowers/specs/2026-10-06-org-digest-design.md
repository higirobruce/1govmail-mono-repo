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

- **Ahead** — significant meetings in the window. **This lane comes first.**
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
qualifies at **`MEETING_MIN_ATTENDEES = 4`** invitees (five people including the
organiser). The constant is named and tunable; §9 explains the value.

**`icalUid` is demoted to de-duplication.** When two synced mailboxes do hold the
same meeting it prevents showing it twice. When absent, fall back to
`(lower(title), startAt)`. **No backfill and no re-sync campaign is required** —
this was the previously-assumed blocker and the measurement removed it.

### 4.2 Documents: org-visible by default, with an owner opt-out

A document qualifies when `Document.orgVisible = true`, a column defaulting to
`true`. Every new document is announced to the institution; the owner switches
one off in the share dialog.

Only the **title and date** reach the digest — never the contents, which stay
behind the document's own permissions. The owner's control is over the
announcement, not over access.

This inverts the original rule, which required a deliberate act by the owner
(`isShared = true` or at least one `DocumentInvite`) before a document appeared.
See the amendment note in §15.

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

One conclusion follows directly: **the meetings lane will be thin at first.**
This dataset is mostly solo calendar blocks, and genuine multi-party meetings
grow with adoption.

On the strength of the numbers alone, documents should lead the page — they are
the only lane with real volume today. **Bruce chose meetings-first anyway, on
editorial grounds**, on 2026-10-06: a meeting is what "what is going on" means to
most readers, and a digest that opens with document churn reads like a changelog.
The cost is accepted knowingly — the first thing on the page is the sparse lane,
and it will look sparse until adoption fills it. Revisit if it still looks empty
once the institution is genuinely using calendars.

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

`MEETING_MIN_ATTENDEES` is 4 invitees — five people with the organiser. It
shipped at 2 to keep the lane non-empty at launch volumes, went to 3 when the
digest first ran live, and then to 4 once the distribution was actually
measured: the live data has no 2-invitee events at all, so 3 excluded nothing.
Re-tune it against the measured histogram, never against a report that one
item looked too small.

## 10. Surface

A new nav item in the left rail, one page, with the same Today / This week /
This month window switcher the existing Executive briefing already uses. Reusing
that control matters: this is the org-level sibling of a personal view people
already know, not a new paradigm.

No interruption on login, no modal, no email. The page is visited, not pushed.

## 11. Build plan

Everything here ships as **one release**. No lane goes live on its own; a digest
with half its content is worse than no digest.

The two lanes can genuinely be built in parallel, but only after the contract
they share exists. Attempting them in parallel from the start would mean two
workers editing the same endpoint, the same response type and the same
institution-scoping helper.

**Stage 1 — the shared foundation (sequential, must land first).**

1. `OrgDigestNarrative` model and migration.
2. The `OrgItem` type, the `/org/digest` endpoint skeleton with window parsing,
   and the institution-scoping helper that derives the caller's institution from
   the JWT and fails closed on NULL. Returns empty lists at this stage.

**Stage 2 — the two lanes, in parallel.** They touch different queries and
different tests, and both write into the contract Stage 1 fixed.

3a. Meetings: attendee-threshold selection, de-duplication by `icalUid` with the
    `(lower(title), startAt)` fallback.
3b. Documents and minutes: `isShared`/invited selection, plus `MeetingMinutes`
    joined to its document's owner for institution scoping.

**Stage 3 — on top of both (sequential).**

4. Narrative generation, `contentHash` caching, the floor and the failure path.
   Needs both lanes, since the hash covers every item.
5. Web: API client, the page, nav entry, window switcher.

Stages 1 and 2 are server-only and land without user-visible change. Only
step 5 makes the feature appear, which is what keeps the single-release
guarantee cheap to honour.

## 12. Testing

- **Institution isolation is the test that matters.** A RISA caller must never
  receive a MINAFFET artefact, and a caller with a NULL institution must receive
  empty lists. Both asserted directly, not inferred.
- Meeting selection: an event below the attendee threshold is excluded; one at
  the threshold is included; the same meeting present in two mailboxes appears
  once; de-duplication still works when `icalUid` is absent on one copy.
- Document selection: an `orgVisible` document is included; one the owner
  switched off is not, even if it is shared or recently edited.
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
   4-invitee threshold means five people. If the provider ever includes the
   organiser in the array, the threshold means four people and should become 5.
2. **`MEETING_MIN_ATTENDEES = 4`** — raised from 2 via 3 after the digest ran
   live (§15, §16).
3. **`NARRATIVE_MIN_ITEMS = 5`** as the floor.
4. **Meetings lead, documents and minutes follow** — an editorial decision taken
   against the measurements (§5), knowing the leading lane is the sparse one.

## 15. Amendment — 2026-10-07, after the first live digest

Bruce read the digest on `.155` and found both lanes carrying items too small to
be institutional: two-person meetings, and documents whose only claim was that
they had been shared with one colleague.

**Meetings.** `MEETING_MIN_ATTENDEES` 2 → 3. (Superseded the same day — see §16.)

**Documents.** The qualifying rule inverts. It was opt-in by side effect — a
document appeared because its owner had shared it, a decision made for other
reasons entirely. It is now opt-out by intent: `Document.orgVisible` defaults to
`true`, and the owner switches off the documents that should not be announced.

The risk this accepts, stated plainly because it is the reason the inversion
needed a decision rather than a patch: inverting the default exposes titles that
were never chosen with an audience in mind. Measured against the live `.155`
data before building, 58 documents would newly appear, among them a security
vulnerability report, a commercial contract, a document titled with a person's
name, and several left as "Untitled".

The migration therefore does **not** default existing rows to `true`. It
preserves what each document shows today — `orgVisible = true` only where the
document is already shared or invited — so nothing that was private becomes
announced. The default applies to documents created from now on, where the owner
can see the switch at the moment they write the title.

## 16. Amendment — 2026-10-07, after measuring the distribution

The §15 threshold raise was tuned from an observation, not from the data, and
it turned out to be inert. Measured on `.155` immediately after deploying it,
the live attendee distribution over 60 days is:

| invitees | 0 | 1 | 3 | 6 | 7 | 8 | 11 | 12 | 13 | 14 | 15 | 23 | 74 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| events | 136 | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |

There is no 2-invitee event anywhere in it. Raising the bar from 2 to 3
excluded zero meetings, and the lane kept showing exactly what prompted the
complaint.

**`MEETING_MIN_ATTENDEES` is now 4** — the first value that removes anything,
namely the single 3-invitee meeting. The lane keeps every entry from 6 invitees
up.

Both spec fixtures derive their attendee arrays from the constant rather than
hardcoding a count, so this change needed no test edits. That property is worth
preserving: a hardcoded fixture would have silently fallen below the new bar
and turned its assertions vacuous rather than failing.

**The rule this leaves behind:** read the histogram before moving a cutoff. A
threshold chosen to answer "that item looks too small" can easily land in an
empty region of the distribution and change nothing at all.

## 17. Amendment — 2026-10-07, the duplicate found on the live page

Reading the deployed digest on `.155` showed the same item twice: "Minutes —
Meet with CTO Roger", identical title and date, in two adjacent rows.

**Cause.** A minutes document is a `Document`. §4.2's document query selects it
(it is org-visible and was updated in the window) and §4.3's minutes query
selects it again. The two result sets were concatenated with no de-duplication
— unlike the meetings lane, which has had dedup since the first release.

**Rule.** When both queries select the same underlying document, the **minutes
row wins**: it carries the meeting meaning, where the document row is incidental
to how minutes happen to be stored.

The key is the set of minutes rows **actually selected**, not "this document has
minutes somewhere". A document can sit inside the window while its minutes row
falls outside it; keying on the latter would drop the document row while nothing
else announced it, losing the item outright. There is a test pinning exactly
that case.

**Also recorded, not yet acted on.** The item that prompted the threshold work in
§15–16 was a *document* all along — "Minutes — Meeting with RMB CEO · 2 people",
whose `participantCount` is its invite count. Documents have no size threshold at
all; only the owner's `orgVisible` toggle governs them. Whether they should have
one is open.
