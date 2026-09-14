# Exchange (EWS) Provider — Manual Smoke Checklist (§5.4 real-server pass)

This is the **real end-to-end proof** for Exchange Phase 3 and the **final gate**
before declaring the phase done. It runs **once**, by hand, from the dev Mac
(which can reach the publicly-reachable MINAFFET endpoint). It is **not** part of
CI — the unit suite covers the wire mapping with fixtures; this covers the live
server.

## 0. Preconditions

- Target: **MINAFFET** institution — `provider='ews'`, `host='webmail.minaffet.gov.rw'`,
  `ewsDomain='MINAFFET'` (Institution table, Phase 1). Endpoint is publicly reachable.
- **3 test accounts** on the MINAFFET Exchange (call them `T1`, `T2`, `T3`).
- Credentials live in a **gitignored `.env.local`** — never committed. The repo
  and this doc contain **no** real passwords.
- API env:
  - `MAIL_CRED_KEY` set (`openssl rand -hex 32`), **distinct from `JWT_SECRET`**.
  - `MAIL_CA_BUNDLE` set **only** if the Exchange TLS chain needs an internal CA
    (it must never be used to disable verification).
- Confirm boot: with an `ews` institution present and **no** `MAIL_CRED_KEY`, the
  API must **fail fast at startup** (asserts the key). Set the key, boot clean.

## 1. Seed the empty mailboxes

The three test mailboxes start empty. Before the per-account walk, generate
content by **mailing between the three accounts** (no external recipients):

- [ ] From `T1` → send to `T2` and `T3` (distinct subjects, one with an attachment).
- [ ] From `T2` → send to `T1` and `T3` (reply to one of T1's messages to seed a thread).
- [ ] From `T3` → send to `T1` and `T2`.
- [ ] Confirm each inbox now has unread mail and at least one thread exists.

## 2. Per-account walk (run for T1, then T2, then T3)

Log in via the **institution dropdown** (pick MINAFFET) — not a legacy host field.

- [ ] **Login** — succeeds; NTLM username derives to `MINAFFET\<localpart>`. Bad
      password → clean "sign-in failed", not a 500.
- [ ] **Folder list** — Inbox / Sent Items / Drafts / Deleted Items / Junk Email
      appear and map to the right **types** (see §4 — locale check). User folders
      show as `custom`.
- [ ] **Read a message** — open one seeded in §1; body (HTML), sender, recipients,
      and attachment metadata render.
- [ ] **Send between test accounts** — compose to another test account; verify it
      lands in the recipient's Inbox and a copy is in this account's Sent Items.
- [ ] **Reply / forward** — reply to a seeded thread; forward one with its
      attachment; both arrive intact.
- [ ] **Attachment** — download an inbound attachment; upload+send a new one.
- [ ] **Search** — AQS search across folders returns the expected hits, paged.
- [ ] **Contacts** — list contacts; create one; edit it; delete it. Autocomplete /
      GAL search (ResolveNames) returns directory hits and never errors the compose form.
- [ ] **Calendar round-trip** — create an event **with only the other test accounts
      as attendees (NO real external attendees)**; verify it appears; edit time;
      accept/decline as the invited test account; delete/cancel it.
- [ ] **Free/busy** — query free/busy for another test account over the event window;
      the busy slot shows.

## 3. Provider-independent surfaces still work for the EWS user

These are app-layer features, not provider ops — confirm they behave for an EWS
account exactly as for Zimbra:

- [ ] **Snooze** a message (re-appears at the snooze time).
- [ ] **Scheduled send** (queues and later delivers).
- [ ] **Templates** (insert into compose).
- [ ] **Tasks** (create, incl. thread → task if used).
- [ ] **Docs** (create/edit; realtime collab unaffected).
- [ ] **Notifications** (new-mail / event triggers fire).

## 4. Capability-hidden settings are HIDDEN, not broken

EWS declares all five capability flags `false`. Verify in the client:

- [ ] **Signatures**, **Identities**, **Server preferences (prefs)**, **Change
      password**, **2FA** sections are **absent** from Settings for the EWS user —
      not present-but-erroring.
- [ ] The settings page loads with **no 500s** (SettingsService capability-branches
      before the read methods).
- [ ] A direct/forced call to a capability-gated endpoint returns **HTTP 400**
      (`CapabilityNotSupportedError`), never a 500 or a silent no-op.

## 5. ⚠️ CRITICAL — Folder locale check (carry-over from Task 4 review)

The folder-type mapping (`folderTypeOf`) keys off **English** `DisplayName`s:
`Inbox`, `Sent Items`, `Drafts`, `Deleted Items`, `Junk Email`.

- [ ] **Confirm the MINAFFET mailbox folder locale.** If the mailbox is
      **French-localized** (e.g. *Boîte de réception*, *Éléments envoyés*,
      *Brouillons*, *Éléments supprimés*, *Courrier indésirable*), then
      inbox/sent/trash/junk will **mis-map to `custom`** — breaking the special
      folders in the UI (Sent copy detection, trash, junk).
- [ ] If localized: **this must be hardened before pilot** — extend the mapping to
      the localized names (or key off a locale-independent signal such as the EWS
      well-known `DistinguishedFolderId`). Record the finding here and file the
      hardening task. **Do not declare Phase 3 done with this unresolved.**

## Sign-off

- [ ] All boxes above checked against the real MINAFFET server.
- [ ] §5 locale outcome recorded (pass, or hardening task filed).
- [ ] No real mailbox credentials committed anywhere in the repo.
