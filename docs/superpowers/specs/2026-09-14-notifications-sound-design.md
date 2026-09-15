# Audible notifications — design

**Date:** 2026-09-14
**Status:** approved in chat, awaiting spec review
**Branch:** ft-hyperscale

## 1. Why

1Gov Mail makes no sound. A user who leaves the app open all day learns about new
mail only by looking at it, and learns about a meeting only by remembering it.
Bruce asked for notifications that are **audible by default** — "sound
notifications mostly, not silent ones".

The alerts must reach the user in two situations:

1. the app is open and visible — an on-screen message and a chime;
2. the app is open but the window is in the background — the same chime plus a
   real operating-system notification.

Delivery while the app is **closed** is explicitly out of scope. That tier needs
Web Push, VAPID keys and a server-side per-user mail poll, and at 5,000 mailboxes
that is the infrastructure item tracked in the scale plan. Nothing here forecloses
it: §9 records what would have to change.

## 2. What already exists

Most of the backend is built and idle.

| Piece | State |
|---|---|
| `Notification` model (`type`, `title`, `body`, `actionUrl`, `metadata`, `isRead`) | exists |
| `NotificationsService` (create / list / unread-count / mark read / delete) | exists |
| `NotificationsScheduler`, `@Cron(EVERY_MINUTE)` producing `EVENT_SOON` | exists and runs |
| `TASK_DUE`, `MAIL_SNOOZE_EXPIRED`, `SCHEDULED_SENT` producers | exist |
| `NotificationsBell` component, polls the feed every 30s | exists, **mounted nowhere** |
| Sound of any kind | does not exist |
| `NEW_MAIL` notification type | does not exist |
| Server-side detection of new mail | does not exist |

Two facts from the code shape the design:

- **`getFolders` already sees new mail arrive.** It reads the live folder list
  from the mail provider and upserts each folder's `unreadCount`
  (`mail.service.ts`). In that one code path the server holds both the stored
  count and the freshly fetched one.
- **The browser already polls.** `mail/page.tsx` calls `getFolders` every two
  minutes and compares unread counts, but the result dead-ends at
  `window.electronAPI?.sendNotification(...)` — it fires only in the Electron
  desktop build and does nothing in a browser.

So new mail is already observable, twice over. Nothing new needs to poll.

## 3. Decisions taken

| Question | Decision |
|---|---|
| Reach | In-app everywhere, plus an OS notification when the window is hidden. Not when the app is closed. |
| What is audible | `NEW_MAIL` and `EVENT_SOON`. `TASK_DUE`, `MAIL_SNOOZE_EXPIRED` and `SCHEDULED_SENT` appear in the list silently. |
| The bell | Returns, in the right-hand **intelligence rail** (`AIRail.tsx`) — not the sidebar, which the 2026-09-05 pass deliberately cleared. |
| Sound controls | On/off, volume, **and a per-type choice of chime**, with a Test button. Persisted per device. |
| Chime source | Synthesized with the Web Audio API. No audio files. |

## 4. Architecture

One feed carries every alert. Detection is server-side; announcement is
client-side.

```
mail provider
     │  (folder list + unread counts)
     ▼
MailService.getFolders ──► compares stored vs fetched unreadCount for /Inbox
     │                         │ increase?
     │                         ▼
     │                    NotificationsService.createNotification('NEW_MAIL', …)
     ▼                         │
  folders                      ▼
                        notifications table ◄── EVENT_SOON cron (already runs)
                               │
                               ▼  GET /notifications  (every 30s)
                    NotificationAlerts (app shell, one instance)
                               │
              ┌────────────────┼────────────────────┐
              ▼                ▼                    ▼
        toast on screen    chime (Web Audio)   OS notification
                                               (only when hidden)
```

The bell in the rail reads the **same** query, so the list a user opens and the
sound they just heard can never disagree.

### 4.1 Server — detecting new mail

In `getFolders`, before the upsert loop, read the stored folder rows once. For
the `/Inbox` folder, compare `stored.unreadCount` with the provider's
`f.unreadCount`. A strict increase means mail arrived since the last sync.

Create one notification:

- `type: 'NEW_MAIL'`
- `title`: `"3 new messages"` (or `"1 new message"`)
- `body`: the sender and subject of the newest unread message when the DB
  already holds it; otherwise the inbox unread total
- `actionUrl: '/mail'`
- `metadata: { baseline, unreadCount, delta }` — the unread count the delta was
  measured FROM, the count announced, and the delta the title text uses

**Dedupe.** The browser polls every two minutes, and several tabs or devices may
poll at once, so detection must be idempotent without a lock.

> **Amended 2026-09-15, after the whole-branch review.** This paragraph
> originally said "suppress a new row when a `NEW_MAIL` notification for this
> user already exists within the last 60 seconds", and claimed that mirrored
> the `EVENT_SOON` cron. It does not: that cron dedupes on *identity*
> (`metadata.eventId`) and therefore cannot lose an event, whereas a time
> window loses whatever lands inside it — `getFolders` advances the stored
> unread count whether or not it notified, so a suppressed arrival is never
> seen again. Dedupe is now by **count**: suppress only when the most recent
> `NEW_MAIL` row's `metadata.unreadCount` is already greater than or equal to
> the count about to be announced. A repeated sync at the same level stays
> quiet; any higher level always notifies.

> **Amended again 2026-09-15, after a scoped re-review of the fix wave.** The
> count-based rule above — "suppress only when the most recent `NEW_MAIL` row's
> `metadata.unreadCount` is already greater than or equal to the count about to
> be announced" — is itself wrong, and drops real arrivals. A row is only ever
> written when the count EXCEEDS the last announced level, so
> `metadata.unreadCount` is monotonically non-decreasing across rows: it is a
> high-water mark that never falls. Unread 0→3 notifies (the row records 3), the
> user reads all three so the stored baseline returns to 0, three new messages
> take the inbox back to 3 — a genuine `+3` — and `3 >= 3` suppresses it. A user
> who once reached 50 unread and then cleared their inbox hears nothing until
> they pass 50 again, with no reset except deleting that row by hand from the
> bell.
>
> Transition identity alone does not fix it either, and was considered and
> rejected rather than built: reading mail moves the baseline BACKWARDS, so the
> pair `(0 → 3)` recurs verbatim after a read-then-refill and would be
> suppressed for exactly the same reason.
>
> Dedupe is now by **transition AND recency**: suppress only when a `NEW_MAIL`
> row for this user records the same `(baseline → current)` pair AND is younger
> than `MailService.NEW_MAIL_DUPLICATE_MS` (15s). Time is the only thing that
> separates the two cases — two tabs racing one arrival compute the identical
> transition within milliseconds, while a read-then-refill needs at least two
> sync cycles (the folder poll is two minutes) with a human reading mail in
> between. The row therefore records the `baseline` it measured from as well as
> the count it announced. The query is still unbounded
> (`getLatestNotification`); the age bound is applied by the caller against the
> row's `createdAt`, so the clock can narrow a comparison but can never hide a
> row.
>
> **Still out of scope:** full concurrency-safety. `notifyNewMail` was never
> concurrency-safe — the original clock guard raced identically — and making it
> so needs a compare-and-swap on the folder row (`UPDATE folder SET unreadCount
> = current WHERE id = ? AND unreadCount = previous`, notifying only when a row
> was actually updated), which restructures the upsert loop. Two tabs in the
> same instant may still produce two chimes; that is accepted.

> **Amended a third time 2026-09-15, after a second scoped re-review.** The
> transition-plus-recency rule above — "suppress only when a `NEW_MAIL` row for
> this user records the same `(baseline → current)` pair AND is younger than 15
> seconds" — is the third guard on this path to lose real mail, and it is
> replaced rather than retuned.
>
> Its justification was that "a read-then-refill needs at least two sync cycles
> (the folder poll is two minutes) with a human reading mail in between". That
> premise is false for this codebase. There are three folder-sync paths, not
> one: `Sidebar.tsx` polls `getFolders` every **60 seconds** on every non-mail
> page, the mail page syncs on mount, and `useInboxSync` fires its first sync
> **10 seconds** after mount. A whole notify → read → refill cycle fits inside
> 15 seconds. Traced: a message arrives and notifies at t=0 (pair `0→1`, stored
> becomes 1); the user opens and reads it; a sync at t=11s takes stored back to
> 0; another message arrives at t=12s; a sidebar sync at t=14s sees a genuine
> `+1` with the same pair `0→1` inside the window and suppresses it
> **permanently**, because the upsert advances the baseline anyway and the next
> sync sees no delta. At the unread counts these mailboxes actually run at
> (0→1→0→1) the pair contributes almost nothing and the clock does all the
> work. No window is safe, because nothing puts a floor on how fast a baseline
> can legitimately return.
>
> Dedupe is now a **compare-and-swap on the stored folder row**, which is what
> the note above listed as out of scope. The notification decision OWNS the
> baseline advance:
>
> ```
> UPDATE folder SET unreadCount = <current> WHERE id = <inbox.id> AND unreadCount = <previous>
> ```
>
> (Prisma `updateMany` with both `id` and the expected `unreadCount` in the
> `where`, returning `{ count }`.) Notify only when `count === 1`. A `count` of
> `0` means a concurrent sync already advanced this exact baseline, so that
> sync owns the announcement and this one returns silently. The question is no
> longer "does this look like something we already said?" — which no
> combination of clock and numbers can answer — but "is this sync the one that
> moved the mailbox off that baseline?", which the database answers atomically.
> Cadence, clock skew and user behaviour stop mattering entirely.
>
> Retired with it: the 15-second constant, `isDuplicateTransition`, and
> `NotificationsService.getLatestNotification`, which had no other caller and
> is deleted. `metadata` still carries `baseline`, `unreadCount` and `delta`
> for debugging, but nothing compares them across rows.
>
> **The upsert loop is unaffected.** `getFolders` persists every provider
> folder after `notifyNewMail` returns, and for `/Inbox` it writes the same
> value the compare-and-swap just wrote. `mail.service.ts` is the only writer
> of `Folder.unreadCount` in the codebase, so no other path can resurrect a
> baseline. The one residual is pre-existing and unchanged by this fix: a
> concurrent sync whose provider fetch predates the arrival upserts the older
> count and rewinds the baseline, after which the next sync announces the same
> arrival again. Its cost is one extra chime — never a lost message, which is
> the only failure direction this feature must not take.

**Failure is silent.** A notification failure must never break `getFolders` —
the folder list is the user's mailbox and matters more than an alert. Wrap in
try/catch and log at WARN, exactly as the existing folder-persist loop does.

### 4.2 Client — announcing

A new `NotificationAlerts` component mounts once in the `(app)` layout, beside
`AiProfileSyncMount`. It:

1. polls `GET /notifications` every 30s (the query the bell already uses, so the
   two share one cache entry and one request);
2. keeps a marker of what it has already announced, so a reload does not
   replay the backlog. **As built** this is the `createdAt` of the newest row
   announced, not "the highest notification id" — ids are cuids and are not
   reliably ordered — and it lives as `lastAnnouncedAt` in the persisted
   `notifications` Zustand store rather than a bare `localStorage` key, moving
   forward only. One field, not two: every completed poll records a marker,
   including one that comes back empty — that one has no server timestamp to
   borrow and records the client's own ISO time — so a null marker means
   exactly one thing, "this device has never polled", and everything in the
   feed is then a backlog to suppress. (An intermediate build recorded nothing
   on an empty poll and carried an `initialized` flag to disambiguate the null;
   the state where the two disagreed replayed all fifty rows, and the flag was
   deleted once the empty-poll marker made it redundant.);
3. for each newer row, in order: shows a toast, plays the chime for its type
   (when the type is audible and sound is on), and — only when
   `document.visibilityState === 'hidden'` — raises an OS notification.

**One tab makes the sound, not all of them.** Server-side dedupe gives one
notification *row*, but every open tab reads that row and would chime. A
`BroadcastChannel('1gov-alerts')` carries a claim message: the first tab to
claim a notification id announces it, and the others see the claim and skip.
A tab that hears no claim within a short window announces it itself, so a single
tab still works when the channel is unavailable.

**OS notification permission is never requested on load.** Asking a user for
permission before they have expressed interest is how permissions get denied
permanently. The prompt is triggered by the user turning notifications on in
Settings, and by nothing else. If permission is absent or denied, the in-app
toast and chime still work.

### 4.3 The chimes

`lib/notifications/chime.ts` owns a small Web Audio synthesizer: an
`AudioContext`, a gain node for volume, and a function that plays a sequence of
`(frequency, duration)` pairs with a short attack and decay envelope.

Four tones ship, each a few notes: `soft` (two rising notes), `ping` (one note),
`double` (two of the same note), `chord` (three notes together). The user picks
one per audible type — mail and calendar — so the two are distinguishable
without looking.

**Autoplay.** A browser rejects `AudioContext` playback before the user has
interacted with the page. Two mitigations: resume the context on the first user
gesture after mount, and treat a rejected play as a no-op rather than an error —
the toast has already appeared, so the alert is not lost. In practice a user has
clicked to log in before any notification arrives.

### 4.4 Settings and storage

A new **Notifications** section on the Settings page: sound on/off, a volume
slider, a chime selector for new mail, a chime selector for calendar reminders,
and a Test button beside each selector. Enabling sound is also the moment the
app requests OS-notification permission.

Preferences live in a persisted `notifications.store` (Zustand, per device, like
`ui.store`) — a chime choice is a property of the machine a person is sitting at,
not of their account, and no server round-trip should stand between them and
turning a sound off.

## 5. Components and files

| File | Change |
|---|---|
| `apps/api/src/mail/mail.service.ts` | read the stored `/Inbox` row before the upsert loop; on an unread increase, claim the transition with a conditional baseline advance and create `NEW_MAIL` only if it matched (§4.1) |
| `apps/api/src/notifications/notifications.service.ts` | **no change.** Two dedupe helpers were specified here and both are gone: `hasRecentNotification(userId, type, withinMs)` (a clock-only lookback loses arrivals) and then `getLatestNotification(userId, type)` (comparing rows cannot tell a duplicate from a refill). Dedupe is a compare-and-swap on the folder row — see §4.1 — so the notifications service needs nothing new. |
| `apps/web/lib/notifications/chime.ts` | new — Web Audio synthesizer and the four tones |
| `apps/web/lib/notifications/announce.ts` | new — pure logic: which rows are new, which are audible, what the OS notification says |
| `apps/web/stores/notifications.store.ts` | new — sound on/off, volume, per-type tone, and `lastAnnouncedAt`: the `createdAt` of the newest row this device has announced, moving forward only. A timestamp, not an id — ids are cuids and are not ordered. Every completed poll records one, an empty poll included (its own clock, backdated a minute), so a null marker means exactly "this device has never polled" and no second flag is needed |
| `apps/web/components/notifications/NotificationAlerts.tsx` | new — the shell mount that ties feed → toast → chime → OS notification |
| `apps/web/components/layout/AIRail.tsx` | add the bell, with its unread badge |
| `apps/web/app/(app)/layout.tsx` | mount `NotificationAlerts` |
| `apps/web/app/(app)/settings/page.tsx` | the Notifications section |
| `apps/web/app/(app)/mail/page.tsx` | drop the `electronAPI.sendNotification` call only — the shell now announces, and leaving it would make the desktop build alert twice. **Keep `setBadgeCount`**: the macOS dock badge has no replacement here |

## 6. Testing

The pure parts carry the tests, because they are the parts that can be wrong in
ways nobody notices:

- **`announce.ts`** — selects only rows whose `createdAt` is newer than
  `lastAnnouncedAt`; classifies audible versus silent types; announces nothing
  at all on a device that has never polled (a null marker); is stable when the
  feed returns rows out of order.
- **`chime.ts`** — builds the expected note sequence per tone; a rejected
  `AudioContext` resolves quietly instead of throwing; volume 0 plays nothing.
- **`notifications.store`** — defaults (sound on, volume, tones), and that
  `lastAnnouncedAt` only moves forward, so a slow poll landing after a fast one
  cannot rewind the marker and replay what was already heard.
- **API** — an `/Inbox` unread increase creates exactly one `NEW_MAIL`; no
  increase creates none, and writes nothing; a decrease (the user read mail
  elsewhere) creates none, and writes nothing; a mailbox with no stored Inbox
  row yet creates none and does not crash; a read-then-refill repeating a
  transition announced seconds ago DOES notify; a concurrent sync whose
  conditional baseline advance matches zero rows creates none; a notification
  failure does not break `getFolders`.
- **`NotificationAlerts`** — a new row triggers toast and chime; a hidden
  document also raises an OS notification; a visible one does not; a tab that
  sees another tab's claim stays silent.

## 7. What this deliberately does not do

- No delivery while the app is closed (see §1).
- No per-notification "mark read" round-trip from the alert — the bell already
  owns that.
- No quiet hours, no digest, no per-sender rules. All are additive later.
- No change to the existing notification producers other than adding `NEW_MAIL`.

## 8. Known limits, to be stated in the release note

- **Latency.** The server notices new mail only during a folder sync, and the
  browser syncs every two minutes. A chime can therefore arrive up to two
  minutes after the mail does.
- **`10.10.94.154` cannot raise OS notifications.** The `Notification` API
  requires a secure context and that box serves plain HTTP. The chime and the
  on-screen toast still work there. `10.10.94.155` (HTTPS) and production are
  unaffected. This is the same secure-context limit that already breaks
  `crypto.randomUUID` on that box.
- **A device coming back from a long absence announces everything that
  arrived while it was away.** `lastAnnouncedAt` dates what has already been
  heard; it does not date a row as too old to be worth saying. Reopen a tab
  after a day and every row stamped since its marker is announced oldest-first
  — up to the fifty the feed carries, with a chime for each audible one. Only a
  device's very FIRST poll suppresses what it finds. This is pre-existing
  behaviour, not a regression, and the obvious fixes (an age ceiling, or
  collapsing a burst into one summary toast) are additive later.
- **Nothing is heard while the app is closed**, by design.

## 9. If the closed-app tier is wanted later

Three things would need to be added, and none of this design blocks them: a
server-side mail poll for users with a live provider session; VAPID keys and a
`push` handler in the existing service worker (`public/sw.js`, currently
app-shell caching only); and a subscription table. The client half — the feed,
the tone engine, the preferences — would be reused unchanged.
