# Exchange Phase 2 — In-Memory Mail Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fully in-process `MailProvider` implementation (`memory`) that lets the whole app run end-to-end with no real mail server, enabled only when `MAIL_PROVIDER_MEMORY=true`.

**Architecture:** A per-user in-memory store (keyed by email) seeded deterministically on first login, plus a `MemoryMailProvider` implementing every `MailProvider` method against it, registered in `MailProviderResolver` behind the env gate. No feature-service or REST changes — the provider plugs in behind the resolver exactly where Phase 1 left the seam. The PostgreSQL cache layer keeps working unchanged (feature services upsert the neutral `ProviderMessage`s the memory provider returns, keyed by their stable ids).

**Tech Stack:** NestJS 11, Jest, TypeScript. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-09-exchange-ews-design.md` §4 (Phase 2), plus §3.1 (the interface it implements).

## Global Constraints

- The provider implements `MailProvider` from `apps/api/src/provider/mail-provider.interface.ts` **exactly** — read that file first; it is the contract. All neutral DTOs come from `apps/api/src/provider/provider-types.ts`. Never change the interface or DTOs in this phase (Phase 1 finalized them); if something seems missing, it's a real gap — stop and flag it.
- `capabilities` is **all-true** (`signatures/identities/serverPrefs/changePassword/twoFactor` all `true`) — the memory provider fakes those surfaces so the full app is exercised.
- `readonly name = 'memory' as const`.
- The provider is reachable ONLY when `process.env.MAIL_PROVIDER_MEMORY === 'true'`. When it's off, no `memory` institution is listed (already true from Phase 1 Task 2) and the resolver must still refuse `memory` with the standard `BadRequestException`.
- Determinism: seeding uses fixed content and a single injected `now: () => number` (default `Date.now`) so tests assert exact state. No `Math.random`/`new Date()` inside seed logic except through injected deps.
- State is process-lifetime only; no persistence, no DB writes from the provider itself (the feature-service cache layer still writes to Postgres as it does for Zimbra — that is expected and out of the provider's concern).
- End every task with `npx jest` green and `npx tsc --noEmit` clean in `apps/api`. Work on `ft-hyperscale`; one commit per task; append the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- TDD throughout: failing test first, watch it fail, implement, watch it pass.

---

### Task 1: In-memory store + deterministic seed

**Files:**
- Create: `apps/api/src/provider/memory/memory-store.ts`, `apps/api/src/provider/memory/memory-seed.ts`
- Test: `apps/api/src/provider/memory/memory-seed.spec.ts`

**Interfaces:**
- Consumes: neutral DTO types from `provider-types.ts` (`ProviderMessage`, `ProviderFolder`, `ProviderContact`, `ProviderEvent`, `ProviderIdentity`, `ProviderSignature`).
- Produces (used by Tasks 2–6):
  - `interface MemoryMailbox { folders: ProviderFolder[]; messages: ProviderMessage[]; contacts: ProviderContact[]; events: ProviderEvent[]; identities: ProviderIdentity[]; signatures: ProviderSignature[]; prefs: Record<string,string>; attachments: Map<string, { filename: string; contentType: string; data: Buffer }>; password: string; displayName: string; }`
  - `class MemoryStore { constructor(now?: () => number); has(email: string): boolean; get(email: string): MemoryMailbox | undefined; seedFor(email: string, password: string): MemoryMailbox; reset(): void; }` — `seedFor` creates and stores a mailbox on first login (idempotent: returns the existing one if already seeded, updating the stored password); `get` returns it thereafter.
  - `function seedMailbox(email: string, password: string, now: () => number): MemoryMailbox` in `memory-seed.ts`.
- The store is a singleton injported as a Nest provider later (Task 6); here it is a plain class.

- [ ] **Step 1: Write the failing seed test**

`memory-seed.spec.ts`:

```ts
import { seedMailbox } from './memory-seed';

const NOW = 1757500000000; // fixed instant
const now = () => NOW;

describe('seedMailbox', () => {
  const mb = seedMailbox('demo@memory.local', 'pw', now);

  it('creates the five standard folders with correct kinds and counts', () => {
    const names = mb.folders.map((f) => f.name).sort();
    expect(names).toEqual(['Drafts', 'Inbox', 'Junk', 'Sent', 'Trash']);
    const inbox = mb.folders.find((f) => f.name === 'Inbox')!;
    expect(inbox.type).toBe('inbox');
    expect(inbox.kind).toBe('mail');
    // unread count equals the number of unread inbox messages
    const inboxMsgs = mb.messages.filter((m) => m.folderId === inbox.id);
    expect(inbox.totalCount).toBe(inboxMsgs.length);
    expect(inbox.unreadCount).toBe(inboxMsgs.filter((m) => !m.isRead).length);
  });

  it('seeds ~30 messages across a few threads, some unread, some flagged, one with an attachment', () => {
    expect(mb.messages.length).toBeGreaterThanOrEqual(25);
    expect(mb.messages.some((m) => !m.isRead)).toBe(true);
    expect(mb.messages.some((m) => m.isFlagged)).toBe(true);
    expect(mb.messages.some((m) => m.hasAttachments)).toBe(true);
    // threads: at least one conversationId shared by >1 message
    const byConv = new Map<string, number>();
    for (const m of mb.messages) if (m.conversationId) byConv.set(m.conversationId, (byConv.get(m.conversationId) ?? 0) + 1);
    expect([...byConv.values()].some((n) => n > 1)).toBe(true);
  });

  it('is deterministic — same inputs give identical ids and order', () => {
    const a = seedMailbox('demo@memory.local', 'pw', now);
    const b = seedMailbox('demo@memory.local', 'pw', now);
    expect(a.messages.map((m) => m.id)).toEqual(b.messages.map((m) => m.id));
  });

  it('seeds ~10 contacts and ~5 events in the current week relative to now', () => {
    expect(mb.contacts.length).toBeGreaterThanOrEqual(8);
    expect(mb.events.length).toBeGreaterThanOrEqual(4);
    const weekMs = 7 * 24 * 3600 * 1000;
    expect(mb.events.every((e) => Math.abs(e.startAt.getTime() - NOW) <= weekMs)).toBe(true);
  });

  it('provides all-true settings surface (identities, signatures, prefs)', () => {
    expect(mb.identities.length).toBeGreaterThanOrEqual(1);
    expect(mb.signatures.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(mb.prefs).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx jest src/provider/memory/memory-seed.spec.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `memory-seed.ts` and `memory-store.ts`**

Build stable ids from a counter (e.g. `msg-1`, `folder-inbox`, `contact-3`, `event-2`) so they are deterministic and dedupe-friendly in the Postgres cache. Every `ProviderMessage` must set **every required field** of the DTO (`id, conversationId, folderId, subject, snippet, from, to, cc, bcc, receivedAt, size, isRead, isFlagged, hasAttachments, isDraft, tags` — plus `bodyHtml`/`bodyText` and `attachments` where relevant). Seed:
- 5 folders: Inbox (`type:'inbox'`), Sent (`type:'sent'`), Drafts (`type:'drafts'`), Trash (`type:'trash'`), Junk (`type:'junk'`), all `kind:'mail'`, `parentId` undefined; counts derived from the seeded messages.
- ~30 messages: most in Inbox, a few in Sent, spread across 3–4 `conversationId`s; mark ~8 unread, ~2 flagged; exactly one with `hasAttachments:true` and a matching entry in `attachments` (a tiny text/plain buffer). `receivedAt` spread over the last ~10 days from `now`.
- ~10 contacts with the widened `ProviderContact` shape (`emails: [{email, type:'work', primary:true}]`, `phones: [{number, type:'mobile'}]`).
- ~5 events within ±7 days of `now`, with `attendees: []`, `inviteId: null`, `isRecurring:false` (one may be recurring).
- 1 identity (`{id:'ident-1', name: displayName, attrs:{ zimbraPrefFromDisplay: displayName, zimbraPrefFromAddress: email }}` — mirror the key shape the settings REST layer expects), 1–2 signatures, a handful of prefs (`{ zimbraPrefGroupMailBy: 'conversation', ... }`).

`MemoryStore` holds a `Map<string, MemoryMailbox>`; `seedFor` calls `seedMailbox` once per email and caches it (updates `password` if the mailbox already exists); accepts an injected `now` in its constructor (default `Date.now`), threaded into `seedMailbox`.

- [ ] **Step 4: Run to verify pass** — `npx jest src/provider/memory` → PASS. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/provider/memory
git commit -m "feat(api): in-memory mailbox store + deterministic seed (Exchange phase 2)"
```

---

### Task 2: MemoryMailProvider — auth, folders, message reads

**Files:**
- Create: `apps/api/src/provider/memory/memory-mail.provider.ts`
- Test: `apps/api/src/provider/memory/memory-mail.provider.spec.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `MailSession`, and the `MailProvider` interface.
- Produces: `class MemoryMailProvider implements MailProvider` — this task implements `name`, `capabilities`, `authenticate`, `verifyTwoFactor`, `getFolders`, `createFolder`, `deleteFolder`, `renameFolder`, `emptyFolder`, `getMessages`, `getMessage`, `searchMessages`. Later tasks (3–5) add the remaining methods to the SAME class. The class takes `MemoryStore` in its constructor.

**Session→mailbox rule (used by every method):** a private helper `private mb(s: MailSession): MemoryMailbox` that does `const m = this.store.get(s.email); if (!m) throw new UnauthorizedException('Your session is no longer valid.'); return m;`. `MailSession.email` is the store key.

- [ ] **Step 1: Write the failing test** (constructs the provider with a `MemoryStore` seeded at a fixed `now`):

```ts
import { MemoryMailProvider } from './memory-mail.provider';
import { MemoryStore } from './memory-store';
import { UnauthorizedException } from '@nestjs/common';

const NOW = 1757500000000;
function setup() {
  const store = new MemoryStore(() => NOW);
  const provider = new MemoryMailProvider(store);
  return { store, provider };
}
const sessionFor = (email: string) => ({ host: 'memory.local', email, authToken: 'memtok' });

describe('MemoryMailProvider — auth + reads', () => {
  it('authenticate seeds on first login, accepts any password, returns a token + displayName, never 2FA', async () => {
    const { store, provider } = setup();
    const res = await provider.authenticate('memory.local', 'demo@memory.local', 'anything');
    expect(res.authToken).toBeTruthy();
    expect(res.twoFactorRequired).toBe(false);
    expect(res.lifetime).toBeGreaterThan(0);
    expect(store.has('demo@memory.local')).toBe(true);
  });

  it('name and capabilities', () => {
    const { provider } = setup();
    expect(provider.name).toBe('memory');
    expect(provider.capabilities).toEqual({ signatures: true, identities: true, serverPrefs: true, changePassword: true, twoFactor: true });
  });

  it('getFolders returns the seeded folders; unauthenticated session throws', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const folders = await provider.getFolders(sessionFor('demo@memory.local'));
    expect(folders.map((f) => f.name)).toContain('Inbox');
    await expect(provider.getFolders(sessionFor('nobody@memory.local'))).rejects.toThrow(UnauthorizedException);
  });

  it('getMessages paginates inbox by receivedAt desc with correct total/more', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const inbox = (await provider.getFolders(sessionFor('demo@memory.local'))).find((f) => f.type === 'inbox')!;
    const page1 = await provider.getMessages(sessionFor('demo@memory.local'), inbox.id, 5, 0);
    expect(page1.messages.length).toBe(5);
    expect(page1.total).toBeGreaterThan(5);
    expect(page1.more).toBe(true);
    // sorted desc
    const ts = page1.messages.map((m) => m.receivedAt.getTime());
    expect(ts).toEqual([...ts].sort((a, b) => b - a));
  });

  it('getMessage returns a full body; searchMessages substring-matches subject/from/body', async () => {
    const { provider } = setup();
    await provider.authenticate('memory.local', 'demo@memory.local', 'x');
    const inbox = (await provider.getFolders(sessionFor('demo@memory.local'))).find((f) => f.type === 'inbox')!;
    const first = (await provider.getMessages(sessionFor('demo@memory.local'), inbox.id, 1, 0)).messages[0];
    const full = await provider.getMessage(sessionFor('demo@memory.local'), first.id);
    expect(full.bodyHtml ?? full.bodyText).toBeTruthy();
    const hits = await provider.searchMessages(sessionFor('demo@memory.local'), first.subject!.split(' ')[0], 50, 0);
    expect(hits.messages.some((m) => m.id === first.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** the class with the listed methods. `authenticate(host, email, password)` calls `store.seedFor(email, password)` and returns `{ authToken: 'memory-' + email, lifetime: 24*3600*1000, displayName: mb.displayName, twoFactorRequired: false }`. `verifyTwoFactor` throws or returns `twoFactorRequired:false` (never reached — memory never challenges). `getMessages` filters by `folderId`, sorts `receivedAt` desc, slices `[offset, offset+limit]`, returns `{ messages, total, more: offset+limit < total }`. `searchMessages` filters all non-trash messages by case-insensitive substring over `subject`, `from.email`/`from.name`, and body, then paginates the same way. `getMessage` returns the stored message (already carries body). Folder mutations operate on the mailbox's `folders`/`messages` arrays (`emptyFolder` deletes that folder's messages; `deleteFolder` removes a custom folder; `renameFolder` renames; `createFolder` appends a `kind:'mail'` folder with a fresh id).

- [ ] **Step 4: Run → PASS; `npx jest` full + `npx tsc --noEmit`.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/provider/memory
git commit -m "feat(api): MemoryMailProvider — auth, folders, message reads"
```

---

### Task 3: MemoryMailProvider — message mutations, send, drafts, attachments

**Files:**
- Modify: `apps/api/src/provider/memory/memory-mail.provider.ts`
- Test: extend `apps/api/src/provider/memory/memory-mail.provider.spec.ts`

**Interfaces:**
- Produces (added to the class): `markRead`, `moveMessage`, `deleteMessage`, `sendMessage`, `saveDraft`, `uploadAttachment`, `downloadAttachment`, `downloadAttachmentBuffer` — signatures exactly as the interface declares (note `downloadAttachment` returns `{ stream: NodeJS.ReadableStream; contentType; filename }`, `downloadAttachmentBuffer` returns `{ data: Buffer; contentType }`).

- [ ] **Step 1: Failing tests** covering: `markRead` flips `isRead` and adjusts the folder's `unreadCount`; `moveMessage` changes `folderId`; `deleteMessage` moves the message to the Trash folder (soft delete, matching Zimbra); `sendMessage` appends a message to **Sent** (with `isDraft:false`, `from` = the sender), returns `{ id, conversationId }`, and — if a recipient email is another seeded memory mailbox — also appends to that recipient's **Inbox**; `saveDraft` creates (no `id`) or updates (with `id`) a Drafts message with `isDraft:true` and returns its id; `uploadAttachment` stores a buffer and returns a handle that `sendMessage`/`saveDraft` can attach; `downloadAttachmentBuffer` round-trips the seeded attachment's bytes and content type; `downloadAttachment` yields a readable stream of the same bytes.

```ts
it('sendMessage lands in Sent and delivers to a recipient memory inbox', async () => {
  const { store, provider } = setup();
  await provider.authenticate('memory.local', 'demo@memory.local', 'x');
  await provider.authenticate('memory.local', 'peer@memory.local', 'x'); // seed the recipient
  const s = { host: 'memory.local', email: 'demo@memory.local', authToken: 't' };
  const { id } = await provider.sendMessage(s, { to: ['peer@memory.local'], subject: 'Hi', body: '<p>yo</p>' });
  const sent = store.get('demo@memory.local')!;
  expect(sent.messages.find((m) => m.id === id)!.folderId).toBe(sent.folders.find((f) => f.type === 'sent')!.id);
  const peer = store.get('peer@memory.local')!;
  expect(peer.messages.some((m) => m.subject === 'Hi' && m.folderId === peer.folders.find((f) => f.type === 'inbox')!.id)).toBe(true);
});
```

- [ ] **Step 2: Run → FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: `npx jest` + `tsc` clean.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/provider/memory
git commit -m "feat(api): MemoryMailProvider — mutations, send, drafts, attachments"
```

---

### Task 4: MemoryMailProvider — contacts, GAL, calendar, free/busy

**Files:**
- Modify: `apps/api/src/provider/memory/memory-mail.provider.ts`
- Test: extend the provider spec

**Interfaces:**
- Produces (added to the class): `getContacts`, `createContact`, `modifyContact`, `deleteContact`, `autoCompleteContacts`, `searchGal`, `getCalendarEvents`, `getAppointment`, `createCalendarEvent`, `modifyCalendarEvent`, `deleteCalendarEvent`, `sendInviteReply`, `getFreeBusy` — exact interface signatures (`getAppointment` returns `ProviderEventDetail | null`; `getFreeBusy` returns `ProviderFreeBusy`).

- [ ] **Step 1: Failing tests**: `getContacts` paginates the seeded contacts; `createContact` returns a full `ProviderContact` with a new id and it appears in `getContacts`; `modifyContact`/`deleteContact` mutate; `autoCompleteContacts` and `searchGal` substring-match name/email and return `{email, display}` and **never throw** (empty array on no match); `getCalendarEvents` returns events whose `startAt` is within `[startMs, endMs]`; `createCalendarEvent` returns an id and the event appears in range; `modifyCalendarEvent`/`deleteCalendarEvent` mutate; `getAppointment` returns a `ProviderEventDetail` (or `null` for an unknown id); `sendInviteReply` is a no-op that resolves; `getFreeBusy` derives busy blocks from the seeded events overlapping the window.

```ts
it('getFreeBusy derives busy blocks from events in the window', async () => {
  const { provider } = setup();
  await provider.authenticate('memory.local', 'demo@memory.local', 'x');
  const s = { host: 'memory.local', email: 'demo@memory.local', authToken: 't' };
  const fb = await provider.getFreeBusy(s, 'demo@memory.local', NOW - 7*864e5, NOW + 7*864e5);
  expect(fb.busy.length).toBeGreaterThan(0);
  expect(fb.busy.every((b) => b.e > b.s)).toBe(true);
});
```

- [ ] **Step 2: Run → FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: `npx jest` + `tsc` clean.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/provider/memory
git commit -m "feat(api): MemoryMailProvider — contacts, GAL, calendar, free/busy"
```

---

### Task 5: MemoryMailProvider — settings surface (prefs, identities, signatures, password)

**Files:**
- Modify: `apps/api/src/provider/memory/memory-mail.provider.ts`
- Test: extend the provider spec

**Interfaces:**
- Produces (added to the class, completing `implements MailProvider`): `getPrefs`, `modifyPrefs`, `getIdentities`, `modifyIdentity`, `getSignatures`, `createSignature`, `modifySignature`, `deleteSignature`, `changePassword` — exact signatures. After this task the class satisfies the interface with no `CapabilityNotSupportedError` anywhere (capabilities are all-true).

- [ ] **Step 1: Failing tests**: `getPrefs` returns the seeded prefs; `modifyPrefs` merges; `getIdentities`/`getSignatures` return the seeded arrays; `createSignature` returns a new id and it appears; `modifySignature`/`deleteSignature` mutate; `modifyIdentity` merges attrs; `changePassword` updates the mailbox password (a subsequent `authenticate` with the new password still succeeds — any password is accepted, but assert the stored password changed). No method throws `CapabilityNotSupportedError`.

- [ ] **Step 2: Run → FAIL.** — [ ] **Step 3: Implement.** — [ ] **Step 4: `npx jest` + `tsc` clean** — confirm the class now structurally satisfies `MailProvider` (assign an instance to a `MailProvider` typed const in the spec to force the check).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/provider/memory
git commit -m "feat(api): MemoryMailProvider — settings surface; implements MailProvider"
```

---

### Task 6: Resolver registration, module wiring, env gate, login acceptance

**Files:**
- Modify: `apps/api/src/provider/mail-provider.resolver.ts`, `apps/api/src/provider/provider.module.ts`
- Test: `apps/api/src/provider/mail-provider.resolver.spec.ts` (extend), create `apps/api/src/provider/memory/memory-login.integration.spec.ts`
- Modify: `ARCHITECTURE.md` (provider-layer section: add the memory provider + env gate)

**Interfaces:**
- Consumes: `MemoryMailProvider`, `MemoryStore`, the existing resolver/module.
- Produces: `resolver.forUser({provider:'memory'})` returns the `MemoryMailProvider` **only when `MAIL_PROVIDER_MEMORY==='true'`**, else the standard `BadRequestException`.

- [ ] **Step 1: Failing resolver test**

```ts
it('returns MemoryMailProvider for memory users only when MAIL_PROVIDER_MEMORY=true', () => {
  process.env.MAIL_PROVIDER_MEMORY = 'true';
  expect(resolver.forUser({ provider: 'memory' } as any)).toBe(memoryProvider);
  delete process.env.MAIL_PROVIDER_MEMORY;
  expect(() => resolver.forUser({ provider: 'memory' } as any)).toThrow(/not supported on this server/i);
});
it('still returns ZimbraService for zimbra and throws for ews', () => {
  expect(resolver.forUser({ provider: 'zimbra' } as any)).toBe(zimbraService);
  expect(() => resolver.forUser({ provider: 'ews' } as any)).toThrow();
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Inject `MemoryMailProvider` (optional) into the resolver; add `case 'memory':` returning it **iff** `process.env.MAIL_PROVIDER_MEMORY === 'true'` and the provider is present, else fall through to the `BadRequestException`. `provider.module.ts` provides `MemoryStore` (as a singleton value/class provider) and `MemoryMailProvider`, and exports the resolver as before. Keep the module graph acyclic (the memory subtree has no dependency on feature modules).

- [ ] **Step 4: Integration test** (`memory-login.integration.spec.ts`) — with `MAIL_PROVIDER_MEMORY=true`, drive the seam the way a request does: seed a `memory` institution row (or stub `InstitutionRegistry.resolve('memory')` to `{id:'memory', provider:'memory', host:'memory.local', ...}`), call `AuthService.login({institution:'memory', email:'demo@memory.local', password:'x'})`, assert it returns an `accessToken` and stamps `provider:'memory'`, then resolve the provider for that user and exercise `getFolders`→`getMessages`→`sendMessage` end-to-end through the resolver (no real mail server). Assert the login is refused when the env flag is off.

- [ ] **Step 5: Gates** — `npx jest` full green + `npx tsc --noEmit` clean.

- [ ] **Step 6: `ARCHITECTURE.md`** — under the mail-provider-layer section, add the `memory` provider: what it's for (full-app dev/test with no server), the `MAIL_PROVIDER_MEMORY` gate, the deterministic seed, and that it satisfies the same interface with all-true capabilities.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/provider ARCHITECTURE.md
git commit -m "feat(api): register memory provider behind MAIL_PROVIDER_MEMORY gate"
```

---

## Acceptance (spec §4)

With `MAIL_PROVIDER_MEMORY=true` on the API and a seeded `memory` institution, log in through the real web UI as `demo@memory.local` / any password, and exercise inbox, thread view, compose/send, drafts, move-to-folder, search, contacts, and calendar — all against the fake, with the Postgres cache layer upserting the memory provider's messages exactly as it does for Zimbra. This manual pass is the final gate (the unit + integration tests cover the provider in isolation); it needs a web build with the env flag set and is run once at the end, not in CI.
