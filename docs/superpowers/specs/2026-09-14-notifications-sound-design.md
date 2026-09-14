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
- `metadata: { unreadCount, delta }`

**Dedupe.** The browser polls every two minutes, and several tabs or devices may
poll at once. Suppress a new row when a `NEW_MAIL` notification for this user
already exists within the last 60 seconds. This mirrors the guard the
`EVENT_SOON` cron already uses, and keeps detection idempotent without a lock.

**Failure is silent.** A notification failure must never break `getFolders` —
the folder list is the user's mailbox and matters more than an alert. Wrap in
try/catch and log at WARN, exactly as the existing folder-persist loop does.

### 4.2 Client — announcing

A new `NotificationAlerts` component mounts once in the `(app)` layout, beside
`AiProfileSyncMount`. It:

1. polls `GET /notifications` every 30s (the query the bell already uses, so the
   two share one cache entry and one request);
2. keeps the highest notification id it has already announced, in
   `localStorage`, so a reload does not replay the backlog;
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
| `apps/api/src/mail/mail.service.ts` | read stored folders before upsert; detect the `/Inbox` unread increase; create `NEW_MAIL` |
| `apps/api/src/notifications/notifications.service.ts` | `hasRecentNotification(userId, type, withinMs)` for the dedupe guard |
| `apps/web/lib/notifications/chime.ts` | new — Web Audio synthesizer and the four tones |
| `apps/web/lib/notifications/announce.ts` | new — pure logic: which rows are new, which are audible, what the OS notification says |
| `apps/web/stores/notifications.store.ts` | new — sound on/off, volume, per-type tone, last announced id |
| `apps/web/components/notifications/NotificationAlerts.tsx` | new — the shell mount that ties feed → toast → chime → OS notification |
| `apps/web/components/layout/AIRail.tsx` | add the bell, with its unread badge |
| `apps/web/app/(app)/layout.tsx` | mount `NotificationAlerts` |
| `apps/web/app/(app)/settings/page.tsx` | the Notifications section |
| `apps/web/app/(app)/mail/page.tsx` | drop the `electronAPI.sendNotification` call only — the shell now announces, and leaving it would make the desktop build alert twice. **Keep `setBadgeCount`**: the macOS dock badge has no replacement here |

## 6. Testing

The pure parts carry the tests, because they are the parts that can be wrong in
ways nobody notices:

- **`announce.ts`** — selects only rows newer than the last announced id;
  classifies audible versus silent types; never announces a backlog on first run;
  is stable when the feed returns rows out of order.
- **`chime.ts`** — builds the expected note sequence per tone; a rejected
  `AudioContext` resolves quietly instead of throwing; volume 0 plays nothing.
- **`notifications.store`** — defaults (sound on, volume, tones), and that the
  last-announced id only moves forward.
- **API** — an `/Inbox` unread increase creates exactly one `NEW_MAIL`; no
  increase creates none; a decrease (the user read mail elsewhere) creates none;
  a second sync inside the dedupe window creates none; a notification failure
  does not break `getFolders`.
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
- **Nothing is heard while the app is closed**, by design.

## 9. If the closed-app tier is wanted later

Three things would need to be added, and none of this design blocks them: a
server-side mail poll for users with a live provider session; VAPID keys and a
`push` handler in the existing service worker (`public/sw.js`, currently
app-shell caching only); and a subscription table. The client half — the feed,
the tone engine, the preferences — would be reused unchanged.
