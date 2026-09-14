# Advanced (Structured) Search — Design

**Status:** Draft for review · 2026-09-10
**Author:** 1Gov Mail dev
**Parity origin:** Zimbra-readiness priority #5 ("Structured search"). Today search is keyword-only (`GET /mail/search` → `provider.searchMessages(query: string)`); Zimbra's filter builder (from/to, date range, attachment, folder, flags) has no equivalent.

---

## Goal

Give users a **filter-builder panel** — From, To, Subject, a free-text keyword, date range, has-attachment, folder, read/unread, flagged — that runs **server-side against each mail provider's native search** (whole mailbox), so migrating Zimbra users keep the structured search they rely on.

## Architecture

A provider-agnostic **`MailSearchFilter`** object is produced by the builder UI, posted to a new API endpoint, and handed to a new **`searchStructured`** provider method. Each provider translates the neutral filter into its own native search — Zimbra query language, Exchange AQS (+ folder scoping via `ParentFolderIds`), and an in-memory predicate for the memory provider. Results reuse the existing `ProviderMessagePage` shape and the current search-results rendering. The existing keyword `searchMessages(query: string)` is untouched (it still serves the `conv:` back-fill and the quick search box).

## Tech Stack

TypeScript across the stack. Backend: NestJS 11 (`apps/api`), the `MailProvider` abstraction (`apps/api/src/provider`), providers under `apps/api/src/{zimbra,ews,provider/memory}`. Frontend: Next.js 16 (`apps/web`), React Query, the mail view under `apps/web/app/(app)/mail`, existing search entry `apps/web/components/GlobalSearch.tsx`.

---

## Scope

**In (v1):** keyword (free text), from, to, subject, date range (from/to dates), has-attachment (bool), folder (single), read/unread (tri-state), flagged (tri-state). All combined with implicit **AND**. Server-side across all three providers.

**Out (follow-ups, explicitly deferred):** saved searches; size (larger/smaller); attachment filename/type; tags/labels/categories; OR/grouping between clauses; cross-folder multi-select; search within results.

---

## 1 · Neutral filter model

Add to `apps/api/src/provider/provider-types.ts`:

```ts
/** Provider-agnostic structured search. Every field is optional; present fields
 *  combine with AND. Empty/absent fields are ignored. An all-empty filter is
 *  rejected at the API layer (would return the whole mailbox). */
export interface MailSearchFilter {
  keyword?: string;       // free text, matched against subject + body + participants
  from?: string;          // sender contains (display name or address)
  to?: string;            // recipient contains (To/Cc)
  subject?: string;       // subject contains
  dateFrom?: string;      // inclusive lower bound, ISO date 'YYYY-MM-DD'
  dateTo?: string;        // inclusive upper bound, ISO date 'YYYY-MM-DD'
  hasAttachment?: boolean;// true → only messages with attachments
  folderId?: string;      // opaque provider folder id (from getFolders); omitted → whole mailbox
  unread?: boolean;       // true → unread only, false → read only, undefined → either
  flagged?: boolean;      // true → flagged only, false → unflagged only, undefined → either
}
```

`dateFrom`/`dateTo` are calendar dates (no time); the range is **inclusive of both days** — providers translate that to the right boundary form (see per-provider notes). Dates are interpreted in the **user's timezone as UTC calendar days**, consistent with how the app already stamps `receivedAt`.

## 2 · Provider interface addition

Add to `apps/api/src/provider/mail-provider.interface.ts`:

```ts
/** Structured search across the mailbox. Providers translate `filter` into their
 *  native query. Returns the same page shape as searchMessages. */
searchStructured(
  s: MailSession,
  filter: MailSearchFilter,
  limit?: number,
  offset?: number,
): Promise<ProviderMessagePage>;
```

A **new** method, not an overload of `searchMessages(query: string)` — the string form is still needed internally (the Zimbra `conv:` conversation back-fill and the quick keyword box), and keeping them separate avoids a `string | MailSearchFilter` union that every caller must narrow.

`MailProviderCapabilities` gains **no** new flag: all three shipping providers implement `searchStructured` for the v1 field set, so there is nothing to gate. (A future provider that cannot would add a capability then.)

## 3 · Per-provider translation

### 3a · Zimbra (`apps/api/src/zimbra`)

Zimbra `SearchRequest` already takes a `query` string (`zimbra.service.ts:453`). Build the query by joining present clauses with a space (implicit AND):

| Filter | Clause | Notes |
|---|---|---|
| keyword | `content:"<v>"` | quoted; falls back to bare terms only if empty operators unwanted |
| from | `from:"<v>"` | |
| to | `to:"<v>"` | matches To and Cc in Zimbra |
| subject | `subject:"<v>"` | |
| dateFrom | `after:<MM/DD/YYYY-1d>` | `after:` is exclusive → subtract one day for inclusive |
| dateTo | `before:<MM/DD/YYYY+1d>` | `before:` is exclusive → add one day for inclusive |
| hasAttachment=true | `has:attachment` | |
| folderId | `inid:<folderId>` | Zimbra numeric folder id |
| unread=true/false | `is:unread` / `is:read` | |
| flagged=true/false | `is:flagged` / `is:unflagged` | |

Date format: Zimbra accepts `MM/DD/YYYY`. Inclusivity handled by ±1 day around the exclusive `after:`/`before:` operators.

### 3b · Exchange EWS (`apps/api/src/ews`)

Two channels, because AQS cannot express a folder scope:

- **AQS `QueryString`** carries keyword/from/to/subject/date/attachment/read/flag.
- **`ParentFolderIds`** carries the folder: the target `folderId` when set, else `msgfolderroot` (whole mail tree). This mirrors `findItemEnvelope` (folder-scoped) vs `searchItemEnvelope` (root-scoped) — the structured envelope is a new builder that combines a QueryString **and** a chosen ParentFolderId.

| Filter | AQS clause | Notes |
|---|---|---|
| keyword | `<v>` (bare, quoted if spaces) | AQS full-text |
| from | `from:<v>` | |
| to | `to:<v>` | |
| subject | `subject:<v>` | |
| dateFrom/dateTo | `received:YYYY-MM-DD..YYYY-MM-DD` | AQS range; open-ended when only one bound |
| hasAttachment=true | `hasattachment:yes` | |
| unread=true/false | `isread:no` / `isread:yes` | |
| flagged | *(see de-risk)* | AQS flag mapping (`followupflag:`/`flag:`) is inconsistent across Exchange builds |
| folderId | *ParentFolderIds, not AQS* | scope the FindItem, not the query |

**De-risk step (implementation Task 1):** confirm the AQS **flagged** and **date-range** syntaxes against live MINAFFET with the same raw-capture technique used for the ConversationId/availability fixes, before finalizing those two clauses. If `flag:` proves unreliable, flagged is dropped from the EWS translation (and the UI hides it for EWS via a per-provider note) rather than shipping a filter that silently returns wrong results.

### 3c · Memory (`apps/api/src/provider/memory`)

`searchStructured` filters the in-memory seeded messages with a JS predicate — one clause per present field (substring, case-insensitive, for text; `receivedAt` within `[dateFrom, dateTo]`; boolean equality for attachment/read/flag; `folderId` equality). This keeps the memory provider a faithful integration backend (spec parity with the EWS work).

## 4 · Security — query injection

User-supplied text (keyword/from/to/subject) is interpolated into a provider query string. It **must be escaped** so a value like `subject:foo OR is:anywhere` cannot inject operators or break the query:

- **Zimbra:** wrap every user value in double quotes and escape embedded `"` and `\`. A quoted Zimbra term is a literal phrase, so operator words inside it are inert.
- **EWS AQS:** wrap multi-word/quoted values; escape embedded quotes. Reject or strip control characters.
- Never interpolate a raw value outside a quoted context. A shared `quoteZimbra()` / `quoteAqs()` helper is the single choke point, unit-tested with adversarial inputs.

Folder ids and dates are **not** free text — folderId is validated against the user's own folders (`getFolders`) before use; dates are parsed to `YYYY-MM-DD` and rejected if malformed. This closes the "search another mailbox's folder" and "inject via folderId" vectors.

## 5 · API contract

`apps/api/src/mail/mail.controller.ts` + `mail.service.ts`:

```
POST /mail/search/advanced
Body: MailSearchFilter + { limit?: number, offset?: number }
→ MailService.searchStructured(userId, filter, limit, offset)
→ provider.searchStructured(session, filter, limit, offset)
→ ProviderMessagePage  (same shape as GET /mail/search)
```

POST (not GET) because the filter is a structured body and to keep personal search terms **out of URLs/logs** (privacy rule). The service:
- rejects an all-empty filter with 400 (`At least one filter is required`);
- validates `folderId` belongs to the user;
- **reuses the exact keyword-search result path** — provider messages are upserted where their folder is synced (so a result is openable by DB id) and returned as lightweight ephemeral rows (`id = providerId`) otherwise, in the same `{ messages, total, offset, limit, hasMore }` shape as `GET /mail/search`. The shared mapping/upsert block is extracted into one private helper both endpoints call. As in keyword search, the upsert's `update` touches only `isRead/isStarred/syncedAt` — never `conversationId` — so search cannot disturb threading.

## 6 · Frontend — filter-builder panel

- New component `apps/web/components/mail/AdvancedSearchPanel.tsx`: the mockup fields (keyword, From, To, Subject, date-from/date-to, has-attachment checkbox, folder select populated from the folder list, read/unread + flagged tri-state), a **Search** and a **Clear** button.
- Entry point: an **"Advanced"** affordance beside the existing mail-list search box; toggling it opens the panel (a popover/sheet under the search bar). The plain search box keeps its current keyword behavior.
- On submit: assemble `MailSearchFilter`, call `api.mail.searchAdvanced(filter)` (new client method in `apps/web/lib/api.ts`), render results in the **existing** search-results list (same rows as keyword search), with an empty-state and the active filter shown as removable chips.
- Loading/empty/error states reuse the existing search UI patterns; results paginate via the same `limit`/`offset`.

## 7 · Edge cases & error handling

- **All-empty filter:** 400 before hitting a provider.
- **Only a date bound:** open-ended range (Zimbra emits just `after:`/`before:`; AQS uses `received:>=`/`<=` open range).
- **Folder deleted between load and search:** provider returns empty / not-found → surfaced as an empty result, not a 500.
- **Provider search outage:** propagates as the existing search error (toast), never a blank hang.
- **Zimbra/EWS session expiry:** the normal 401 re-login path (unchanged).
- **Very broad filter:** paginated like keyword search; no unbounded fetch.

## 8 · Testing strategy

- **Translation unit tests (per provider):** a table of `MailSearchFilter` → expected native query fragment, including the escaping/injection cases and the inclusive-date ±1-day boundaries (Zimbra) / range form (AQS).
- **EWS envelope test:** the structured FindItem carries both the AQS `QueryString` and the correct `ParentFolderIds` (target folder vs `msgfolderroot`).
- **Memory provider tests:** predicate matches for each field and combinations (AND).
- **API tests:** all-empty → 400; folderId ownership validation; POST body → page shape.
- **Web:** the builder compiles fields → `MailSearchFilter`; the request fires on submit; chips render/clear.
- **Live de-risk:** AQS flagged + date-range verified against MINAFFET before those clauses are finalized (Task 1).

## 9 · Task decomposition (preview for the plan)

1. **EWS AQS de-risk + neutral types** — capture live AQS flagged/date behavior; add `MailSearchFilter` + interface method + escaping helpers (with tests).
2. **Zimbra `searchStructured`** — translation + escaping + inclusive dates; unit tests.
3. **EWS `searchStructured`** — structured envelope (QueryString + ParentFolderIds), translation, tests.
4. **Memory `searchStructured`** — predicate + tests.
5. **API layer** — `POST /mail/search/advanced`, validation (all-empty, folder ownership), reusing the shared keyword-search result-persistence helper; controller/service tests.
6. **Web client + panel** — `api.mail.searchAdvanced`, `AdvancedSearchPanel`, entry-point toggle, results + chips; component tests.

---

## Open questions for review

1. **Flagged on EWS:** accept that flagged may be dropped for Exchange if AQS proves unreliable (with the UI hiding it for EWS), or block v1 on getting it working?
2. **Folder default:** search **whole mailbox** by default (folder optional), as specified — confirm that's the desired default rather than "current folder".
3. **Entry point:** an "Advanced" toggle under the mail-list search box (as specified) vs. also wiring it into the global ⌘K search — v1 keeps it to the mail view; confirm.
