# Advanced (Structured) Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A filter-builder panel (keyword + from/to/subject/date-range/has-attachment/folder/read/flagged) that runs server-side against each provider's native search.

**Architecture:** A neutral `MailSearchFilter` → a new `searchStructured` provider method that every provider translates to its native search (Zimbra query language; Exchange AQS + `ParentFolderIds` for folder scope; memory predicate) → `POST /mail/search/advanced` reusing the keyword-search result path → a new `AdvancedSearchPanel` feeding the existing mail search-results view.

**Tech Stack:** TypeScript. NestJS 11 (`apps/api`), the MailProvider abstraction (`apps/api/src/provider`), providers under `apps/api/src/{zimbra,ews,provider/memory}`. Next.js 16 (`apps/web`), React Query.

**Spec:** `docs/superpowers/specs/2026-09-10-advanced-search-design.md`

## Global Constraints

- **All-AND semantics.** Present filter fields combine with AND; absent/empty fields are ignored. An all-empty filter is a 400 at the API, never a provider call.
- **Injection safety.** Every user-supplied text value (keyword/from/to/subject) is interpolated into a provider query ONLY through the single `quoteZimbra()` / `quoteAqs()` choke point (wrap in quotes, escape/strip embedded quotes+backslashes). No raw interpolation anywhere. Adversarial unit tests are required.
- **Inclusive dates.** `dateFrom`/`dateTo` are inclusive calendar days. Zimbra: `after:` / `before:` are EXCLUSIVE → shift by ∓1 day. EWS: `received:YYYY-MM-DD..YYYY-MM-DD` (open-ended when only one bound).
- **EWS folder scope is NOT an AQS token** — it is `ParentFolderIds` on the FindItem (target folder when set, else `msgfolderroot`).
- **Search never disturbs threading.** The result upsert's `update` touches only `isRead/isStarred/syncedAt` — never `conversationId`. (Mirror the existing keyword-search upsert exactly.)
- **POST only.** Search terms never appear in a URL or query string.
- **Scope.** v1 fields ONLY: keyword, from, to, subject, dateFrom, dateTo, hasAttachment, folderId, unread, flagged. No size/type/tags/saved-searches/OR.
- **No new capability flag.** All three providers implement `searchStructured`; `MailProviderCapabilities` is unchanged.

---

## File Structure

- Create `apps/api/src/provider/mail-search-filter.ts` — `MailSearchFilter` type, `isEmptyFilter()`, and the `quoteZimbra()`/`quoteAqs()` escaping helpers (one home so both the type and the shared escaping live together and are unit-tested in isolation).
- Modify `apps/api/src/provider/provider-types.ts` — re-export `MailSearchFilter` alongside the other neutral types.
- Modify `apps/api/src/provider/mail-provider.interface.ts` — add `searchStructured`.
- Modify `apps/api/src/zimbra/zimbra.service.ts` — implement `searchStructured` (+ a local `buildZimbraQuery`).
- Modify `apps/api/src/ews/ews.service.ts` + `apps/api/src/ews/ews-envelopes.ts` — implement `searchStructured` (+ `buildAqsQuery`, `structuredSearchEnvelope`).
- Modify `apps/api/src/provider/memory/memory-mail.provider.ts` — implement `searchStructured` (predicate).
- Modify `apps/api/src/mail/mail.service.ts` + `mail.controller.ts` — extract the shared result helper, add `searchStructured` + `POST /mail/search/advanced`.
- Modify `apps/web/lib/api.ts` — `mail.searchAdvanced(filter, limit, offset)`.
- Create `apps/web/components/mail/AdvancedSearchPanel.tsx` — the builder panel.
- Modify `apps/web/app/(app)/mail/page.tsx` — the "Advanced" toggle + `runAdvancedSearch`, feeding the existing search-results state.

---

## Task 1: Neutral filter type, escaping helpers, interface + stubs

**Files:**
- Create: `apps/api/src/provider/mail-search-filter.ts`
- Create: `apps/api/src/provider/mail-search-filter.spec.ts`
- Modify: `apps/api/src/provider/provider-types.ts`
- Modify: `apps/api/src/provider/mail-provider.interface.ts`
- Modify: `apps/api/src/zimbra/zimbra.service.ts`, `apps/api/src/ews/ews.service.ts`, `apps/api/src/provider/memory/memory-mail.provider.ts` (throwing stubs)

**Interfaces:**
- Produces: `MailSearchFilter` (see below), `isEmptyFilter(f): boolean`, `quoteZimbra(v): string`, `quoteAqs(v): string`, and `MailProvider.searchStructured(s, filter, limit?, offset?): Promise<ProviderMessagePage>`.

- [ ] **Step 1: Write the escaping test (it fails — module absent)**

```ts
// apps/api/src/provider/mail-search-filter.spec.ts
import { quoteZimbra, quoteAqs, isEmptyFilter } from './mail-search-filter';

describe('quoteZimbra', () => {
  it('wraps in quotes and neutralises injected operators', () => {
    expect(quoteZimbra('budget')).toBe('"budget"');
    // an attempt to break out / inject an operator stays inside the quoted literal
    expect(quoteZimbra('a" OR is:anywhere')).toBe('"a\\" OR is:anywhere"');
    expect(quoteZimbra('back\\slash')).toBe('"back\\\\slash"');
  });
});

describe('quoteAqs', () => {
  it('wraps in quotes and strips embedded quotes (AQS has no escape)', () => {
    expect(quoteAqs('budget')).toBe('"budget"');
    expect(quoteAqs('a" OR from:x')).toBe('"a OR from:x"');
  });
});

describe('isEmptyFilter', () => {
  it('is true only when every field is empty/absent', () => {
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ keyword: '' , from: '  ' })).toBe(true);
    expect(isEmptyFilter({ hasAttachment: false, unread: undefined })).toBe(true); // false booleans that mean "either"? see note
    expect(isEmptyFilter({ subject: 'x' })).toBe(false);
    expect(isEmptyFilter({ hasAttachment: true })).toBe(false);
    expect(isEmptyFilter({ unread: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL (Cannot find module)**

Run: `cd apps/api && npx jest src/provider/mail-search-filter.spec.ts`

- [ ] **Step 3: Implement the module**

```ts
// apps/api/src/provider/mail-search-filter.ts

/** Provider-agnostic structured mail search. Every field optional; present
 *  fields combine with AND. Booleans: true/false select that state, undefined
 *  means "either". Empty/whitespace strings are treated as absent. */
export interface MailSearchFilter {
  keyword?: string;
  from?: string;
  to?: string;
  subject?: string;
  dateFrom?: string;   // 'YYYY-MM-DD', inclusive
  dateTo?: string;     // 'YYYY-MM-DD', inclusive
  hasAttachment?: boolean;
  folderId?: string;
  unread?: boolean;
  flagged?: boolean;
}

const hasText = (v?: string) => typeof v === 'string' && v.trim().length > 0;

/** True when the filter would match the whole mailbox (nothing to search on).
 *  A `false` boolean is a real constraint (read-only / unflagged-only), so it
 *  counts; only `undefined` booleans and empty strings are "absent". */
export function isEmptyFilter(f: MailSearchFilter): boolean {
  return (
    !hasText(f.keyword) && !hasText(f.from) && !hasText(f.to) && !hasText(f.subject) &&
    !hasText(f.dateFrom) && !hasText(f.dateTo) && !hasText(f.folderId) &&
    f.hasAttachment === undefined && f.unread === undefined && f.flagged === undefined
  );
}

/** Zimbra query literal: wrap in quotes, escape backslash then double-quote, so
 *  operator words inside a user value are inert. */
export function quoteZimbra(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** AQS literal: AQS has no escape sequence, so strip embedded quotes and wrap. */
export function quoteAqs(v: string): string {
  return `"${v.replace(/"/g, '')}"`;
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `cd apps/api && npx jest src/provider/mail-search-filter.spec.ts`
(Note on the `hasAttachment:false` case: `false` is a real constraint, so revise the test's 3rd assertion to `false` if it asserted `true`. The implementation above treats only `undefined` booleans as absent — that is the intended contract; make the test match it.)

- [ ] **Step 5: Re-export the type + add the interface method + stubs**

In `provider-types.ts`, add `export type { MailSearchFilter } from './mail-search-filter';`.

In `mail-provider.interface.ts`, add the import and the method right after `searchMessages`:
```ts
import { MailSearchFilter } from './mail-search-filter';
// ...
searchStructured(s: MailSession, filter: MailSearchFilter, limit?: number, offset?: number): Promise<ProviderMessagePage>;
```

In each provider add a throwing stub (replaced in Tasks 2–4) so tsc stays green:
```ts
async searchStructured(): Promise<ProviderMessagePage> {
  throw new Error('searchStructured not yet implemented');
}
```

- [ ] **Step 6: tsc + commit**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
```bash
git add apps/api/src/provider apps/api/src/zimbra apps/api/src/ews apps/api/src/mail 2>/dev/null; git add -u
git commit -m "feat(api): MailSearchFilter + escaping helpers + searchStructured interface (stubs)"
```

---

## Task 2: Zimbra `searchStructured`

**Files:**
- Modify: `apps/api/src/zimbra/zimbra.service.ts`
- Test: `apps/api/src/zimbra/zimbra-search-structured.spec.ts` (new) or the existing zimbra spec

**Interfaces:**
- Consumes: `MailSearchFilter`, `quoteZimbra`. Produces: Zimbra `searchStructured`.

- [ ] **Step 1: Write the translation test (FAIL)**

```ts
import { buildZimbraQuery } from './zimbra.service'; // export it for testing

it('translates a full filter to a Zimbra query with inclusive dates and escaping', () => {
  const q = buildZimbraQuery({
    keyword: 'budget', from: 'alice', subject: 'Q3',
    dateFrom: '2026-09-01', dateTo: '2026-09-30',
    hasAttachment: true, folderId: '2', unread: true, flagged: false,
  });
  expect(q).toContain('content:"budget"');
  expect(q).toContain('from:"alice"');
  expect(q).toContain('subject:"Q3"');
  expect(q).toContain('after:8/31/2026');   // dateFrom −1 day (exclusive after:)
  expect(q).toContain('before:10/1/2026');  // dateTo +1 day (exclusive before:)
  expect(q).toContain('has:attachment');
  expect(q).toContain('inid:2');
  expect(q).toContain('is:unread');
  expect(q).toContain('is:unflagged');
});
```

- [ ] **Step 2: Run — FAIL.** Run: `cd apps/api && npx jest zimbra-search-structured`

- [ ] **Step 3: Implement `buildZimbraQuery` + `searchStructured`**

```ts
import { MailSearchFilter, quoteZimbra } from '../provider/mail-search-filter';

/** epoch shift a 'YYYY-MM-DD' by `days`, format M/D/YYYY (Zimbra date form). */
function zimbraDate(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}/${dt.getUTCFullYear()}`;
}

export function buildZimbraQuery(f: MailSearchFilter): string {
  const p: string[] = [];
  if (f.keyword?.trim())  p.push(`content:${quoteZimbra(f.keyword.trim())}`);
  if (f.from?.trim())     p.push(`from:${quoteZimbra(f.from.trim())}`);
  if (f.to?.trim())       p.push(`to:${quoteZimbra(f.to.trim())}`);
  if (f.subject?.trim())  p.push(`subject:${quoteZimbra(f.subject.trim())}`);
  if (f.dateFrom?.trim()) p.push(`after:${zimbraDate(f.dateFrom.trim(), -1)}`);
  if (f.dateTo?.trim())   p.push(`before:${zimbraDate(f.dateTo.trim(), +1)}`);
  if (f.hasAttachment)    p.push('has:attachment');
  if (f.folderId?.trim()) p.push(`inid:${f.folderId.trim()}`);
  if (f.unread === true)  p.push('is:unread'); else if (f.unread === false)  p.push('is:read');
  if (f.flagged === true) p.push('is:flagged'); else if (f.flagged === false) p.push('is:unflagged');
  return p.join(' ');
}

async searchStructured(s: MailSession, filter: MailSearchFilter, limit = 50, offset = 0): Promise<ProviderMessagePage> {
  return this.searchMessages(s, buildZimbraQuery(filter), limit, offset);
}
```

- [ ] **Step 4: Run — PASS.** Run: `cd apps/api && npx jest zimbra-search-structured`
- [ ] **Step 5: Commit.** `git commit -am "feat(api): Zimbra searchStructured (query-language translation)"`

---

## Task 3: EWS `searchStructured`

**Files:**
- Modify: `apps/api/src/ews/ews-envelopes.ts` (new `structuredSearchEnvelope`), `apps/api/src/ews/ews.service.ts`
- Test: `apps/api/src/ews/ews-envelopes.spec.ts`, `apps/api/src/ews/ews.folders-messages.spec.ts`

- [ ] **Step 0 (DE-RISK, manual — do FIRST):** Deploy a one-line raw-capture of the outgoing AQS QueryString + the FindItem response for a structured search against live MINAFFET, exactly as the ConversationId/availability captures were done (temp `logger.warn`, build, ship to .155, trigger, read journal, revert). Confirm the **flagged** (`isflagged:`/`flag:`) and **date-range** (`received:A..B`) AQS forms return correct results. Record the confirmed forms in the ledger. **If flagged is unreliable, omit it from `buildAqsQuery` and note that the web panel hides Flagged for EWS accounts** (Global Constraint: search must never return silently-wrong results).

- [ ] **Step 1: Write the envelope + translation tests (FAIL)**

```ts
// buildAqsQuery: folder is NOT in the query
it('builds an AQS query without the folder token', () => {
  const q = buildAqsQuery({ from: 'alice', subject: 'Q3', dateFrom: '2026-09-01', dateTo: '2026-09-30', hasAttachment: true, unread: true, folderId: 'F==' });
  expect(q).toContain('from:"alice"');
  expect(q).toContain('subject:"Q3"');
  expect(q).toContain('received:2026-09-01..2026-09-30');
  expect(q).toContain('hasattachment:yes');
  expect(q).toContain('isread:no');
  expect(q).not.toContain('F==');           // folder never goes in the query
});

// structuredSearchEnvelope: folder scope via ParentFolderIds
it('scopes to the folder id when given, else msgfolderroot', () => {
  const withFolder = structuredSearchEnvelope('from:"a"', 'FID==', 0, 50);
  expect(withFolder).toContain('<m:QueryString>from:"a"</m:QueryString>');
  expect(withFolder).toContain('<t:FolderId Id="FID=="/>');
  const noFolder = structuredSearchEnvelope('from:"a"', undefined, 0, 50);
  expect(noFolder).toContain('<t:DistinguishedFolderId Id="msgfolderroot"/>');
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** In `ews-envelopes.ts` (reuse `findItemPrelude`, `FINDITEM_SUMMARY_FIELDS` already include the topic field from the prior fix):

```ts
export function buildAqsQuery(f: import('../provider/mail-search-filter').MailSearchFilter): string {
  const { quoteAqs } = require('../provider/mail-search-filter');
  const p: string[] = [];
  if (f.keyword?.trim()) p.push(quoteAqs(f.keyword.trim()));
  if (f.from?.trim())    p.push(`from:${quoteAqs(f.from.trim())}`);
  if (f.to?.trim())      p.push(`to:${quoteAqs(f.to.trim())}`);
  if (f.subject?.trim()) p.push(`subject:${quoteAqs(f.subject.trim())}`);
  const a = f.dateFrom?.trim(), b = f.dateTo?.trim();
  if (a && b) p.push(`received:${a}..${b}`);
  else if (a) p.push(`received:>=${a}`);
  else if (b) p.push(`received:<=${b}`);
  if (f.hasAttachment)    p.push('hasattachment:yes');
  if (f.unread === true)  p.push('isread:no'); else if (f.unread === false) p.push('isread:yes');
  // flagged: include ONLY the form confirmed live in Step 0; otherwise omit.
  return p.join(' ');
}

export function structuredSearchEnvelope(aqs: string, folderId: string | undefined, offset: number, max: number): string {
  const scope = folderId
    ? `<t:FolderId Id="${xmlEscape(folderId)}"/>`
    : '<t:DistinguishedFolderId Id="msgfolderroot"/>';
  const body =
    '<m:FindItem Traversal="Shallow">' +
    findItemPrelude(offset, max) +
    `<m:QueryString>${xmlEscape(aqs)}</m:QueryString>` +
    `<m:ParentFolderIds>${scope}</m:ParentFolderIds>` +
    '</m:FindItem>';
  return soapEnvelope(body);
}
```

In `ews.service.ts`:
```ts
async searchStructured(session: MailSession, filter: MailSearchFilter, limit?: number, offset?: number): Promise<ProviderMessagePage> {
  const off = this.normOffset(offset);
  const max = this.normLimit(limit);
  const xml = await this.callWithRetry(session, structuredSearchEnvelope(buildAqsQuery(filter), filter.folderId, off, max));
  return this.parseMessagePage(xml, off, filter.folderId ?? '');
}
```

- [ ] **Step 4: Run — PASS.** Run: `cd apps/api && npx jest src/ews`
- [ ] **Step 5: Commit.** `git commit -am "feat(api): EWS searchStructured (AQS + ParentFolderIds folder scope)"`

---

## Task 4: Memory `searchStructured`

**Files:** Modify `apps/api/src/provider/memory/memory-mail.provider.ts`; test `memory-mail.provider.spec.ts`.

- [ ] **Step 1: Test (FAIL)** — assert a filter over the seeded mailbox matches on each field and combinations (AND), and that a `folderId`/date/attachment/read/flag predicate narrows correctly.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** a predicate mirroring `searchMessages`'s substring approach but per field:

```ts
async searchStructured(s: MailSession, f: MailSearchFilter, limit = 25, offset = 0): Promise<ProviderMessagePage> {
  const mailbox = this.mb(s);
  const inc = (h: string | null | undefined, n?: string) => !n?.trim() || (h ?? '').toLowerCase().includes(n.trim().toLowerCase());
  const dOf = (iso?: string) => iso?.trim() ? new Date(iso.trim() + 'T00:00:00Z').getTime() : undefined;
  const from = dOf(f.dateFrom), to = f.dateTo?.trim() ? new Date(f.dateTo.trim() + 'T23:59:59Z').getTime() : undefined;
  const matches = mailbox.messages.filter((m) =>
    inc(m.subject, f.subject) &&
    (!f.keyword?.trim() || [m.subject, m.from.email, m.from.name, m.bodyText, m.bodyHtml].some((h) => inc(h, f.keyword))) &&
    (!f.from?.trim() || inc(m.from.email, f.from) || inc(m.from.name, f.from)) &&
    (!f.to?.trim() || m.to.some((a) => inc(a.email, f.to) || inc(a.name, f.to))) &&
    (from === undefined || m.receivedAt.getTime() >= from) &&
    (to === undefined || m.receivedAt.getTime() <= to) &&
    (f.hasAttachment === undefined || m.hasAttachments === f.hasAttachment) &&
    (!f.folderId?.trim() || m.folderId === f.folderId.trim()) &&
    (f.unread === undefined || m.isRead === !f.unread) &&
    (f.flagged === undefined || m.isFlagged === f.flagged),
  ).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  const total = matches.length;
  return { messages: matches.slice(offset, offset + limit), total, more: offset + limit < total };
}
```

- [ ] **Step 4: Run — PASS.** `cd apps/api && npx jest src/provider/memory`
- [ ] **Step 5: Commit.** `git commit -am "feat(api): memory searchStructured (predicate)"`

---

## Task 5: API layer — endpoint + shared result helper

**Files:** Modify `apps/api/src/mail/mail.service.ts`, `mail.controller.ts`; test `mail.service.spec.ts`, `mail.controller.spec.ts`.

- [ ] **Step 1: Extract the shared result helper.** Pull the `messages.map → upsert/ephemeral` block out of `searchMessages` (mail.service.ts:615–671) into `private async persistSearchResults(userId, page): Promise<{ messages; total; offset; limit; hasMore }>` and have `searchMessages` call it. Run existing search tests to prove no behaviour change.

- [ ] **Step 2: Write the endpoint tests (FAIL)**

```ts
it('rejects an all-empty filter with 400', async () => {
  await expect(service.searchStructured('u1', {}, 50, 0)).rejects.toThrow(/at least one filter/i);
});
it('rejects a folderId the user does not own', async () => { /* folder.findFirst → null → 400/404 */ });
it('calls provider.searchStructured and returns the shared result shape', async () => { /* provider mock → persistSearchResults */ });
```

- [ ] **Step 3: Implement**

```ts
async searchStructured(userId: string, filter: MailSearchFilter, limit = 50, offset = 0) {
  if (isEmptyFilter(filter)) throw new BadRequestException('At least one filter is required.');
  const user = await this.getUser(userId);
  if (filter.folderId) {
    const owned = await this.prisma.folder.findFirst({ where: { userId, zimbraId: filter.folderId } });
    if (!owned) throw new NotFoundException('Folder not found');
  }
  const page = await this.resolver.forUser(user).searchStructured(buildMailSession(user), filter, limit, offset);
  return this.persistSearchResults(userId, page, limit, offset);
}
```

Controller:
```ts
@Post('search/advanced')
searchAdvanced(@Req() req: AuthenticatedRequest, @Body() body: MailSearchFilter & { limit?: number; offset?: number }) {
  const { limit = 50, offset = 0, ...filter } = body ?? {};
  return this.mailService.searchStructured(req.user.sub, filter, limit, offset);
}
```

- [ ] **Step 4: Run — PASS.** `cd apps/api && npx jest src/mail`
- [ ] **Step 5: Commit.** `git commit -am "feat(api): POST /mail/search/advanced + shared search-result helper"`

---

## Task 6: Web — client method + filter-builder panel

**Files:** Modify `apps/web/lib/api.ts`, `apps/web/app/(app)/mail/page.tsx`; create `apps/web/components/mail/AdvancedSearchPanel.tsx`; test alongside.

- [ ] **Step 1: API client.** In `api.ts` mail namespace, next to `search`:
```ts
searchAdvanced: (filter: Record<string, unknown>, limit = 50, offset = 0) =>
  request<any>('/mail/search/advanced', { method: 'POST', body: JSON.stringify({ ...filter, limit, offset }) }),
```

- [ ] **Step 2: Panel.** `AdvancedSearchPanel.tsx` — controlled inputs for keyword/from/to/subject, two date inputs, a has-attachment checkbox, a folder `<select>` (fed the folder list already in the mail page), tri-state read + flagged (a 3-option segmented control: Any / Yes / No), a **Search** and **Clear** button. `onSearch(filter: MailSearchFilter)` prop; it assembles the object omitting empty fields. A `hideFlagged?: boolean` prop (set when the account is EWS and Step-0 dropped flagged).

- [ ] **Step 3: Wire into the mail page.** Add an "Advanced" toggle button beside the search box (mail/page.tsx:1411). Opening it renders the panel in a popover. Add `runAdvancedSearch(filter)` mirroring `runSearch` (mail/page.tsx:1120) but calling `api.mail.searchAdvanced`; it sets the SAME `isSearchMode`/results/pagination state so results render in the existing list. Show the active filter as removable chips; **Clear** exits search mode.

- [ ] **Step 4: Tests.** The panel compiles fields → the right `MailSearchFilter` (empty fields omitted); Clear resets; the request fires on Search. Run: `cd apps/web && npx vitest run AdvancedSearchPanel`. Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit.** `git commit -am "feat(web): advanced-search filter-builder panel + wiring"`

---

## Verification (whole feature)

- `cd apps/api && npx tsc --noEmit -p tsconfig.json && npx jest`
- `cd apps/web && npx tsc --noEmit && npx vitest run`
- Manual on .155: Zimbra account — build a filter (from + date range + has-attachment), confirm results; open a result. EWS account — same, confirm the AQS translation returns real hits and folder scoping works; confirm flagged behaves per the Step-0 decision.

## Self-Review (author checklist — done)

- **Spec coverage:** every spec section maps to a task — filter model+escaping (T1), Zimbra/EWS/memory translation (T2/T3/T4), API+validation+shared-result (T5), UI (T6); the EWS de-risk is T3 Step 0. ✅
- **Placeholder scan:** no TBD/`add validation`/vague steps — validation, escaping, date math, and envelopes are spelled out. The one deliberate runtime unknown (AQS flagged form) is a named de-risk step with a fallback, not a placeholder. ✅
- **Type consistency:** `MailSearchFilter`, `searchStructured`, `buildZimbraQuery`/`buildAqsQuery`/`structuredSearchEnvelope`, `persistSearchResults` used consistently across tasks; `ProviderMessagePage` return shape matches the interface. ✅
