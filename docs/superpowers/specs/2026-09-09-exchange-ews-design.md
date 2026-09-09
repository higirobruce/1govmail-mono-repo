# Spec: Exchange (on-prem, EWS) support for 1Gov Mail

**Status:** ready for implementation
**Revised:** 2026-09-09 — folded in the MINAFFET environment reply and a live NTLM spike (§0); auth strategy changed from Basic-first to NTLM-only; §2 corrected (PostgreSQL, not SQLite); §9 values filled in. Second revision same day: login is **institution-driven** — users pick an institution, a DB `Institution` table maps it to provider/host/NTLM domain (§6.1); no mail-server-type selector, no client-supplied host.
**Working branch:** `ft-hyperscale` (Bruce's standing SDD preference; the `claude/exchange-mailserver-support-8hhh52` branch named by the original draft was never created).
**Prerequisite reading:** `ARCHITECTURE.md` (whole file), `apps/api/src/zimbra/zimbra.service.ts`

---

## 0. Verified environment facts (2026-09-09)

Everything in this section was confirmed against the live MINAFFET server, not taken from documentation.

- **Server:** `MINAFFET-EXCH-2`, Exchange 2019 CU15 (15.2.2562.37, seen in `ServerVersionInfo`). `EwsEnabled: True`.
- **Endpoint:** `https://webmail.minaffet.gov.rw/EWS/Exchange.asmx` — internal and external URL are identical, and it is **reachable from the public internet** (dev works from any machine; no VPN required).
- **TLS:** publicly issued GeoTrust cert (`CN=webmail.minaffet.gov.rw`, expires 2027-02-14). No CA bundle needed for this deployment.
- **Auth:** `BasicAuthentication: False` on both server and EWS vdir; the endpoint offers only `WWW-Authenticate: Negotiate, NTLM`. **NTLM is mandatory.**
- **NTLM spike (passed):** plain `httpntlm` from Node completed the handshake and `GetFolder(inbox)` returned `ResponseClass="Success" / NoError` — Windows Extended Protection, if enabled, does not block this client.
- **Username format (empirical):** `MINAFFET\<user>` authenticates; bare UPN (`user@minaffet.gov.rw`) is rejected. Hence `ewsDomain = "MINAFFET"` on the institution row (§6.1).
- **Test accounts:** three mailboxes provided (`test-risa1@`, `test-risa2@`, `testminaf3@minaffet.gov.rw`); OWA at `https://webmail.minaffet.gov.rw/owa/`. The two new accounts start **empty** — seed them by mailing between the three before functional testing. **Credentials live in a local untracked env file only — never in this repo, this spec, or any commit.**
- **Latency:** single calls from the dev Mac run ~2–4s — reinforces the keep-alive requirement in §5.1/§5.2 and gentle retry tuning.
- **Still unknown:** the tenant's EWS throttling policy; whether the 1Gov Mail VMs (no internet, no DNS) get a firewall path + `/etc/hosts` entry to reach the endpoint. Neither blocks implementation.

---

## 1. Goal

Add support for **on-premises Microsoft Exchange** as a second mail backend, alongside the existing Zimbra backend, using **Exchange Web Services (EWS)** — SOAP over HTTPS. Each user authenticates with their own mailbox email + Active Directory password (same model as the current Zimbra login: no service account, no impersonation, no OAuth).

The integration must be delivered in three phases, each independently shippable:

1. **Phase 1 — Provider abstraction.** Extract a `MailProvider` interface from `ZimbraService`; no behavior change for Zimbra users.
2. **Phase 2 — In-memory fake provider.** A `MemoryMailProvider` implementing the interface against in-process data, enabling full-stack dev/test with no mail server.
3. **Phase 3 — EWS provider.** `EwsService` implementing the interface against Exchange.

Do not start a later phase until the previous one builds, typechecks, and (for Phase 1) leaves the existing Zimbra flow working unchanged.

---

## 2. Current architecture (summary — verify against the code, it is authoritative)

> Revision note: the original draft claimed SQLite/better-sqlite3 here; that was wrong. Because this section was written from a stale snapshot once already, re-verify each claim below against the code before relying on it.

- `apps/api/src/zimbra/zimbra.service.ts` (~1,800 lines) is the **only** file that talks to the mail server. All feature services (`MailService`, `ContactsService`, `CalendarService`, `SettingsService`, `AuthService`, `TasksService` schedulers) inject the concrete `ZimbraService`.
- Every `ZimbraService` method takes `(host, authToken, ..., csrfToken?)` — session material is stored on the `User` row (`zimbraHost`, `authToken`, `csrfToken`, `tokenExpiry` in `apps/api/prisma/schema.prisma`) and threaded through by the callers.
- **PostgreSQL** (Prisma 7) is a **cache/enrichment layer only**; mail/contacts/calendar truth lives in the mail server. Cached rows key remote objects by a `zimbraId` string column — treat this as an opaque remote ID; it will hold EWS item IDs unchanged (they can exceed 150 chars — fine for a TEXT column).
- The frontend (`apps/web`) only talks to the NestJS REST API. The only frontend change in this spec is the login form (§8) and the capabilities handling (§7).
- Repo conventions that will bite you if ignored:
  - After any Prisma schema change: `npx prisma migrate dev --name <name> && npx prisma generate`, then clear stale `tsconfig*.tsbuildinfo` under `apps/api/dist/` if present.
  - pnpm workspaces, Node ≥ 20. Run API checks from `apps/api` (`npx tsc --noEmit` at minimum; use the repo's lint/test scripts if present).
  - The AI layer (agent tools, embed workers, Ask retrieval) reaches mail through the same feature services — the Phase 1 interface must cover everything those paths use, derived from the real call sites.

---

## 3. Phase 1 — Provider abstraction

### 3.1 Interface

Create `apps/api/src/provider/mail-provider.interface.ts` defining a `MailProvider` interface covering the **entire current `ZimbraService` public method catalogue** (auth, 2FA, folders, messages, search, send, drafts, attachments upload/download, contacts CRUD + autocomplete, calendar CRUD + RSVP + free/busy, GAL search, prefs, identities, signatures, password change). Derive the exact list from the source file, not from this spec.

Design decisions:

- **Neutral session type.** Replace the `(host, authToken, csrfToken?)` triplet with a single `MailSession` object: `{ host: string; email: string; authToken?: string; csrfToken?: string; credentials?: { username: string; password: string } }`. Zimbra uses `authToken`/`csrfToken`; EWS uses `credentials` (EWS has no session token — every request is authenticated, §5.2). Callers build the session from the `User` row via one shared helper so the mapping lives in one place.
- **Neutral DTOs.** The interface's return types must not leak Zimbra wire shapes. Today, `MailService` parses raw `ZimbraMessage` (`su`, `fr`, `e[]`, `mp[]`). Move that parsing **into** the Zimbra provider so the interface returns neutral shapes (`ProviderMessage`, `ProviderFolder`, `ProviderContact`, `ProviderEvent`, …). This is the bulk of Phase 1's work; do it method-by-method, running the typechecker as you go.
- **Capability flags.** Add `readonly capabilities: { signatures: boolean; identities: boolean; serverPrefs: boolean; changePassword: boolean; twoFactor: boolean }`. Zimbra: all true. EWS: all false (§7). Feature services check flags and return graceful "not supported by this mail server" responses (HTTP 400 with a clear message) instead of calling missing capabilities.

### 3.2 Provider selection

- Add `provider String @default("zimbra")` to the `User` model (values: `zimbra` | `ews` | `memory`). Keep the existing column names (`zimbraHost`, `authToken`, …) — do **not** rename columns; renames churn every call site and the migration for zero functional gain. Document in the schema that `zimbraHost` means "mail server host" generally.
- Create a `MailProviderResolver` (injectable) with `forUser(user): MailProvider` returning the right implementation. Feature services inject the resolver instead of `ZimbraService` and resolve per request (they already load the `User` row for host/token — reuse that).
- `ZimbraService` remains, unmodified in behavior, as the `zimbra` implementation.

### 3.3 Acceptance for Phase 1

- `npx tsc --noEmit` clean in `apps/api`.
- No REST API contract changes; `apps/web` untouched and still working against a Zimbra account (or mock mode).
- Grep check: outside `apps/api/src/zimbra/` and the resolver, no file imports `ZimbraService` or references Zimbra wire-format fields (`su`, `fr`, `mp`, `_jsns`, …).

---

## 4. Phase 2 — In-memory provider

`apps/api/src/provider/memory-mail.provider.ts`, registered as provider `memory`, enabled only when env `MAIL_PROVIDER_MEMORY=true` (refuse `memory` logins otherwise).

- Seed per-user state on first login (any password accepted): standard folders (Inbox, Sent, Drafts, Trash, Junk), ~30 messages across a few conversation threads (some unread, some flagged, one with an attachment), ~10 contacts, ~5 calendar events in the current week. Deterministic seed (fixed data or seeded RNG) so e2e tests can assert on it.
- Implement every interface method against the in-memory store, including pagination (`limit`/`offset` semantics identical to the real providers), search (substring match over subject/from/body), move/trash/read flags, draft save/update, send (delivers to the recipient's Inbox if the recipient is another memory user, always lands in sender's Sent), free/busy derived from the seeded events.
- Capabilities: all true (it fakes signatures/prefs too — it exists to exercise the full app).
- State is process-lifetime only; no persistence.

Acceptance: with `MAIL_PROVIDER_MEMORY=true`, log in through the real web UI as `demo@memory.local` / any password with provider `memory`, and exercise inbox, thread view, compose/send, drafts, move to folder, search, contacts, calendar — all against the fake, with the PostgreSQL cache layer behaving as it does for Zimbra (messages upserted on list/fetch, conversations assembled from the cache).

---

## 5. Phase 3 — EWS provider

`apps/api/src/ews/ews.service.ts` (+ `ews.module.ts`), registered as provider `ews`.

### 5.1 Transport

- **Hand-rolled SOAP XML over the Node HTTP stack**, mirroring the codebase's Zimbra style (hand-rolled JSON-SOAP over axios). Do not adopt `ews-javascript-api` — it drags in its own auth/XHR stack and is poorly maintained. Use `fast-xml-parser` (add as a dependency) for response parsing; build request envelopes with template literals in one `ews-envelopes.ts` helper module.
- Endpoint: `https://{host}/EWS/Exchange.asmx` (accept full URLs too, same normalization rules as `ZimbraService.buildClient`). SOAP header must include `<t:RequestServerVersion Version="Exchange2013_SP1"/>` — confirmed fine against the real server (2019 CU15, §0).
- **Connection reuse is mandatory, not an optimization.** The NTLM handshake (§5.2) authenticates a *connection* (3 round-trips) and observed per-call latency is 2–4s. Maintain a keep-alive `https.Agent` per user session so consecutive EWS calls reuse the authenticated socket; drop the agent on logout/session expiry.
- TLS: honor a `MAIL_CA_BUNDLE` env var (path to a PEM bundle) for internally-issued certificates via a proper `https.Agent({ ca })` — not needed for MINAFFET (public GeoTrust cert, §0) but keep the seam for other tenants. **Never set `rejectUnauthorized: false`** (do not copy the Zimbra service's two lapses).
- Timeouts and error mapping mirror `ZimbraService`: a central `handleEwsError` that maps HTTP 401 → `UnauthorizedException` ("Your mail session is no longer valid…"), SOAP faults / `ResponseClass="Error"` → `BadGatewayException` with the `ResponseCode` + `MessageText`, network errors → `BadGatewayException`. Every response message in EWS carries a per-item `ResponseClass` — check it on every call, not just HTTP status.

### 5.2 Authentication — NTLM (revised 2026-09-09)

EWS has **no session token** — every request (in practice: every *connection*, via NTLM) carries credentials. Basic auth is **disabled** on the MINAFFET server (§0) and must not be assumed anywhere.

- **NTLM is the implemented strategy.** The spike proved `httpntlm@1.8.13` completes the handshake against this server. Two acceptable shapes — decide at implementation time with the spike as reference:
  1. use `httpntlm` as the EWS HTTP client directly (own request stack; wrap it to apply the timeout/error/redaction conventions), or
  2. use `httpntlm`'s exported `ntlm` helpers (Type-1/Type-3 message construction) on top of the axios + `https.Agent` transport from §5.1, keeping one HTTP stack for the module.
  Keep the auth scheme an injectable strategy regardless, so Negotiate/Kerberos or a future OAuth tenant slots in without touching operations.
- **Username format.** The server requires `DOMAIN\user` (`MINAFFET\test-risa1` verified; bare UPN rejected). Users type their email; the backend derives the NTLM username as `${EWS_DEFAULT_DOMAIN}\\${localpart}` when `EWS_DEFAULT_DOMAIN` is set. Allow a user-typed `DOMAIN\user` in the login form to pass through untouched for other tenants.
- `authenticate()` = perform a cheap authenticated call (`GetFolder` on the `inbox` distinguished folder — exactly the spike's call). Success proves credentials; get the display name via `ResolveNames` on the user's own address, best effort. `twoFactorRequired` is always false for EWS.
- **Credential storage (security-sensitive).** The Zimbra flow stores a server-issued token on the `User` row; EWS/NTLM has none, so the password must be retained for the JWT session's lifetime. Store it in the existing `authToken` column, **encrypted** with AES-256-GCM using a key derived (scrypt/HKDF) from a new required env `MAIL_CRED_KEY` (refuse to boot the EWS provider without it; never fall back to `JWT_SECRET`). Encrypt on login, decrypt per request in the session helper (§3.1). Set `tokenExpiry` to the JWT expiry. On logout, null the column and drop the keep-alive agent. Never log the password, NTLM message contents, or decrypted material; extend the existing axios debug interceptors to redact `Authorization`.
- **Test credentials hygiene.** The three MINAFFET test accounts' passwords live in a local untracked env file (`apps/api/.env.local` or similar, gitignored). They appear nowhere in the repo, this spec, fixtures, or test code.

### 5.3 Operation mapping

Implement each interface method with the listed EWS operation. All item IDs returned to the rest of the app are the EWS `ItemId Id` attribute (opaque string, can exceed 150 chars — fine for a TEXT column). **ChangeKeys:** fetch-fresh before every update (`GetItem`/`GetFolder` immediately before `UpdateItem`) rather than caching them; simpler and immune to staleness.

| Interface method | EWS operation | Notes |
|---|---|---|
| `getFolders` | `FindFolder` Deep traversal from `msgfolderroot` | Map `DistinguishedFolderId` names to the app's folder semantics (inbox/sent/drafts/trash/junk). Include unread (`UnreadCount`) and total (`TotalCount`). |
| `getMessages` | `FindItem` with `ParentFolderIds`, `IndexedPageItemView` (`Offset`, `MaxEntriesReturned`), sort `item:DateTimeReceived` desc | Request `IdOnly` + `AdditionalProperties` (subject, from/to, date, size, IsRead, HasAttachments, flags, `ConversationId`, preview). `ConversationId` maps to the app's conversation/thread ID. |
| `getMessage` | `GetItem`, `BodyType=HTML`, `IncludeMimeContent=false` | Parse body, address lists, attachment metadata (`AttachmentId`, name, content type, size, `IsInline`, `ContentId` for inline images). Mark read via a follow-up `UpdateItem` only if the interface contract says fetching marks read (Zimbra's `read:1` no longer does — the app marks read explicitly; replicate the current contract, verify in code). |
| `searchMessages` | `FindItem` with `QueryString` (AQS syntax) | Map the app's plain-text query straight through; AQS handles bare words. |
| `sendMessage` | `CreateItem` `MessageDisposition="SendAndSaveCopy"`, `SavedItemFolderId=sentitems` | Attachments: create the message with `MessageDisposition="SaveOnly"` first, `CreateAttachment` for each file (`FileAttachment`, base64 `Content`; inline images get `IsInline=true` + `ContentId`), then `SendItem` with `SaveItemToFolder=true`. Reply/forward: use `ReplyToItem`/`ForwardItem` response objects when `replyToId` is present — threading rides on the `References` headers EWS sets for those. |
| `saveDraft` | `CreateItem` `MessageDisposition="SaveOnly"` into `drafts`; update via `UpdateItem` `ConflictResolution="AlwaysOverwrite"`, `MessageDisposition="SaveOnly"` | Return the new/updated ItemId (UpdateItem returns a fresh one — return it, the old ID dies with the ChangeKey). |
| `uploadAttachment` | (no standalone upload) | EWS attaches to items directly; implement the interface's upload semantics by buffering server-side and attaching during send/draft-save (see `sendMessage`). The provider-neutral interface from Phase 1 should already be shaped as "attach these buffers to this outgoing message", not "pre-upload then reference" — if Phase 1 kept Zimbra's `aid` model, generalize it now. |
| `downloadAttachment` / `...Buffer` | `GetAttachment` | Returns base64 content — decode to Buffer; content type and filename come from the attachment metadata. |
| `moveMessage` | `MoveItem` | |
| `deleteMessage` | `MoveItem` to `deleteditems` (matches Zimbra `op:'trash'` semantics — soft delete) | |
| `markRead` | `UpdateItem` on `message:IsRead`, `SuppressReadReceipts=true` | |
| `createFolder` / `deleteFolder` / `renameFolder` / `emptyFolder` | `CreateFolder` / `DeleteFolder` (HardDelete) / `UpdateFolder` (folder:DisplayName) / `EmptyFolder` (MoveToDeletedItems, `DeleteSubFolders=false`) | |
| `getContacts` | `FindItem` on `contacts` folder, contact shape | Map GivenName/Surname/DisplayName/EmailAddress1..3/phones/company. |
| `createContact` / `modifyContact` / `deleteContact` | `CreateItem` (Contact) / `UpdateItem` / `MoveItem` to `deleteditems` | |
| `autoCompleteContacts` + `searchGal` | `ResolveNames` (`ReturnFullContactData=true`, search scope `ActiveDirectoryContacts`) | One EWS op serves both interface methods; keep both returning `{email, display}` and never throwing (degrade to `[]` like the Zimbra impls). |
| `getCalendarEvents` | `FindItem` with `CalendarView` (`StartDate`/`EndDate`) on `calendar` | CalendarView expands recurrences server-side — matches Zimbra's `calExpandInst*` behavior. |
| `getAppointment` | `GetItem` calendar shape incl. `RequiredAttendees`/`OptionalAttendees` with `ResponseType` | ResponseType maps to the app's `ptst`. |
| `createCalendarEvent` | `CreateItem` (CalendarItem) `SendMeetingInvitations="SendToAllAndSaveCopy"` | All-day: `IsAllDayEvent=true` with date-only boundaries in UTC. |
| `modifyCalendarEvent` | `UpdateItem` `SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy"` | Fetch fresh ChangeKey first. |
| `deleteCalendarEvent` | `DeleteItem` `SendMeetingCancellations="SendToAllAndSaveCopy"`, MoveToDeletedItems | |
| `sendInviteReply` | `CreateItem` with `AcceptItem` / `DeclineItem` / `TentativelyAcceptItem` referencing the invite's ItemId | |
| `getFreeBusy` | `GetUserAvailability` (`FreeBusyViewType="FreeBusy"`) | Map merged/CalendarEvent output to the `{busy, tentative, unavailable}` triple. |
| `getPrefs`/`modifyPrefs`/identities/signatures/`changePassword`/`verifyTwoFactor` | — | Not implemented; capabilities flags false (§7). Throw a typed `CapabilityNotSupportedError` if called anyway. |

### 5.4 Testing

- **Unit tests with recorded fixtures.** For every operation above, add a fixture pair (request envelope snapshot + a realistic response XML taken from Microsoft's EWS documentation examples) under `apps/api/src/ews/__fixtures__/`, and test envelope construction + response parsing against them (`nock` or axios adapter mock). Include error fixtures: SOAP fault, `ErrorInvalidId`, `ErrorItemNotFound`, `ErrorChangeKeyRequiredForWriteOperations`, HTTP 401, HTTP 503 (throttling back-off: honor `ErrorServerBusy`'s `BackOffMilliseconds` with a single retry).
- **Integration tests** run the full API against `MemoryMailProvider` (Phase 2), not against EWS.
- **Manual smoke against the real MINAFFET server is possible from day one** (endpoint publicly reachable, test accounts in hand — §0). Seed the empty mailboxes by mailing between the three accounts first. Not part of CI.

---

## 6. Auth flow changes (`apps/api/src/auth/`) — institution-driven (revised 2026-09-09)

Users never choose a mail-server type or host. They pick their **institution**; the institution row carries the provider and host. This also closes the current hole where the client submits an arbitrary `zimbraHost` for the backend to send credentials to.

**Phasing:** ship the registry, the endpoint, and the institution-driven login (with the §8 form change) as part of **Phase 1** — it is provider-agnostic, folds into Phase 1's schema migration, and removes the client-supplied host immediately. Phase 3 only *adds* the `ews` rows' behavior.

### 6.1 Institution registry (DB)

- New Prisma model:
  ```prisma
  model Institution {
    id        String  @id            // slug, e.g. "risa", "minaffet"
    label     String                 // shown in the login dropdown
    provider  String                 // 'zimbra' | 'ews'
    host      String                 // mail server host (port allowed, e.g. mail.risa.gov.rw:8443)
    ewsDomain String?                // NTLM domain for ews providers (e.g. "MINAFFET")
    enabled   Boolean @default(true)
    position  Int     @default(0)    // dropdown order
  }
  ```
- Migration seeds the current registry (hand-authored INSERTs in the migration, per the repo's drifted-dev-DB workflow): `risa` → zimbra / `mail.risa.gov.rw:8443`, `minict` → zimbra / `mail.minict.gov.rw`, `minaffet` → **ews** / `webmail.minaffet.gov.rw` / ewsDomain `MINAFFET`. (Today's frontend list wrongly points MINAFFET at a Zimbra host — the seed corrects that.)
- `GET /auth/institutions` — public, unauthenticated — returns enabled rows ordered by `position` as `[{ id, label }]` only (provider/host stay server-side). When `MAIL_PROVIDER_MEMORY=true`, append a synthetic `{ id: 'memory', label: 'Demo (local)' }` entry.
- Registry reads go through one injectable `InstitutionRegistry` service — the lookup used by both the endpoint and `AuthService`.

### 6.2 Login

- `POST /auth/login` body: `{ institution: string, email, password }`. `institution` replaces the client-supplied host; validate in `login.dto.ts`. Unknown or disabled institution → 400. (Keep accepting the legacy `zimbraHost` field during the transition — resolve it against the registry by host match, and log a deprecation warning; remove once the web app ships the new form.)
- `AuthService.login`: resolve the institution row → provider + host (+ `ewsDomain`), call that provider's `authenticate`, then upsert the `User` with `provider`, host, `institutionId`, and the provider's session material (Zimbra: token/csrf as today; EWS: encrypted credentials per §5.2). Add `institutionId String?` to `User` in the same migration. JWT issuance, `Session` row, and 2FA handling for Zimbra are unchanged. For `ews`, never return `requiresTwoFactor`.
- EWS username derivation uses the institution's `ewsDomain` (`MINAFFET\<localpart>`), not a global env (§9 revised accordingly).
- The shared session helper (§3.1) is the only code that reads these columns back.

---

## 7. Capability gaps — required app behavior

For `ews` users, the Settings page depends on capabilities the provider lacks. Do **not** silently 500:

- `GET /settings` returns identities/signatures/prefs sections as empty with a `capabilities` object so the frontend can hide the sections (frontend change: hide, don't break, when a section is absent).
- **Signatures:** out of scope to re-home them in PostgreSQL in this spec; return empty + hidden UI. Leave a `TODO(exchange-signatures)` marker where a local `EmailSignature` table would slot in.
- **Password change / server prefs / 2FA:** hidden for `ews` users, HTTP 400 with a human message if called directly.
- Snooze, scheduled send, templates, rules, mute, tasks, docs, notifications are provider-independent (local DB + `moveMessage`/`sendMessage`) and must work for EWS users without modification — add this to the manual test checklist. The AI layer (Ask, agent tools, briefing, embeddings) also rides the feature services and must degrade gracefully where a capability is absent.

---

## 8. Frontend changes (`apps/web`) — minimal

- Login page: the user selects their **institution only** — no mail-server-type or host field. Replace the hardcoded `INSTITUTIONS` array in `app/(auth)/login/page.tsx` with a fetch of `GET /auth/institutions`; submit `{ institution, email, password }`. The user never sees "Zimbra" or "Exchange".
- Settings page: honor the `capabilities` object per §7.
- No other UI changes. `lib/api.ts`: thread `institution` through `api.auth.login`.

---

## 9. Deployment configuration (values confirmed 2026-09-09)

| Env var | Meaning | Value / status |
|---|---|---|
| `MAIL_CA_BUNDLE` | Path to internal CA PEM, if a tenant's cert is internally issued | not needed for MINAFFET (public GeoTrust cert); keep the seam |
| `MAIL_CRED_KEY` | Required 32+ byte secret for credential encryption (§5.2) | generate per deployment |
| `MAIL_PROVIDER_MEMORY` | Enable the fake provider (dev only; also surfaces the Demo entry in `GET /auth/institutions`) | dev |

Host and NTLM domain are **not** env vars: they live per-institution in the `Institution` table (§6.1) — MINAFFET's row carries `webmail.minaffet.gov.rw` + ewsDomain `MINAFFET` (both verified, §0). The earlier draft's `EWS_DEFAULT_HOST` / `EWS_DEFAULT_DOMAIN` envs are superseded by that table.

Remaining unknowns (leave clean seams, don't block): tenant EWS throttling policy (→ retry tuning), VM network path to the endpoint (`/etc/hosts` + firewall — the VMs have no DNS/internet; needed only when the pilot moves off the dev Mac).

---

## 10. Definition of done

1. Phase order respected; each phase committed separately with passing typecheck (and repo test suite) before the next begins.
2. Zimbra path behaviorally unchanged (manual regression against mock mode at minimum).
3. Full app usable end-to-end on `MemoryMailProvider` with `MAIL_PROVIDER_MEMORY=true`.
4. EWS provider implements every row of §5.3's table with fixture-backed unit tests, including the listed error cases; `rejectUnauthorized: false` appears nowhere in new code; credentials encrypted at rest and redacted in logs; test-account passwords appear nowhere in the repo.
5. Manual smoke pass against the real MINAFFET server (the three test accounts, seeded) covering login, folder list, read, send between test accounts, search, contacts, calendar event round-trip, free/busy.
6. `ARCHITECTURE.md` updated: provider layer section, EWS module, new env vars, capability matrix.
7. Work on `ft-hyperscale`; commits pushed; **no PR unless asked**.
