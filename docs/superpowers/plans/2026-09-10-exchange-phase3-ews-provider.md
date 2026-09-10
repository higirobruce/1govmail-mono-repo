# Exchange Phase 3 — EWS Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `ews` `MailProvider` that talks to on-prem Microsoft Exchange over EWS (SOAP/HTTPS) with NTLM auth, so MINAFFET users sign in and use mail/contacts/calendar against their real Exchange mailbox.

**Architecture:** Hand-rolled SOAP-XML over an NTLM-authenticated keep-alive HTTP connection (`httpntlm`, verified by the Phase-0 spike), `fast-xml-parser` for responses, envelopes built in one helper module. Credentials are encrypted at rest (AES-256-GCM, key derived once at boot from `MAIL_CRED_KEY`), stored in the existing `User.authToken` column, and decrypted per request in `buildMailSession`. Capabilities are all-false (no server-side signatures/identities/prefs/password/2FA); the settings surface capability-branches so EWS users don't 500. Registered as `case 'ews'` in the resolver — no feature-service changes.

**Tech Stack:** NestJS 11, Node `crypto`, `httpntlm@1.8.13`, `fast-xml-parser`, Jest. Exchange 2019 CU15 at `webmail.minaffet.gov.rw`.

**Spec:** `docs/superpowers/specs/2026-09-09-exchange-ews-design.md` §5 (Phase 3), §5.2 (auth), §5.3 (operation mapping — the authoritative per-method EWS-op table), §5.4 (testing), §7 (capability gaps). Interface: `apps/api/src/provider/mail-provider.interface.ts` (frozen; the one sanctioned change is Task 1's optional `authenticate` domain arg — see below).

## Global Constraints

- Implement the `MailProvider` interface from `mail-provider.interface.ts`. **One sanctioned interface change** (Task 1): widen `authenticate` to `authenticate(host, email, password, opts?: { ntlmDomain?: string }): Promise<ProviderAuthResult>`. Zimbra/memory ignore the 4th arg; EWS uses it. This is the established adjustment rule — a real call site (EWS login) needs the per-institution domain that the frozen 3-arg signature can't carry. No other interface/DTO change.
- **Security is the spine of this phase.** `MAIL_CRED_KEY` (≥32 bytes) is required to boot the EWS provider — refuse to construct `EwsService` without it; NEVER fall back to `JWT_SECRET`. AES-256-GCM only. Never log passwords, NTLM message bytes, decrypted credentials, or the `Authorization` header — extend the existing debug redaction. **Never `rejectUnauthorized: false`** anywhere.
- Test-account passwords (the three MINAFFET mailboxes) live ONLY in a local gitignored env file (`apps/api/.env.local`). They appear nowhere in the repo, this plan, fixtures, or test code.
- Every EWS response carries a per-item `ResponseClass` — check it on every call, not just HTTP status. `handleEwsError` maps: HTTP 401 → `UnauthorizedException`; SOAP fault / `ResponseClass="Error"` → `BadGatewayException` with `ResponseCode` + `MessageText`; network error → `BadGatewayException`; `ErrorServerBusy` → one retry honoring `BackOffMilliseconds`.
- ChangeKeys are fetched fresh immediately before every update (`GetItem`/`GetFolder` then `UpdateItem`) — never cached.
- Unit tests use recorded fixtures (request envelope snapshot + realistic response XML) under `apps/api/src/ews/__fixtures__/`, with the HTTP layer mocked (`nock` or an injected transport). No test hits a live server. Manual smoke against the real MINAFFET server is a separate end-of-plan gate (§5.4), not CI.
- End every task with `npx jest` green + `npx tsc --noEmit` clean in `apps/api`. Work on `ft-hyperscale`; one commit per task; trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. TDD throughout.

---

### Task 1: Credential encryption + authenticate domain arg

**Files:**
- Create: `apps/api/src/ews/ews-crypto.ts`, `apps/api/src/ews/ews-crypto.spec.ts`
- Modify: `apps/api/src/provider/mail-provider.interface.ts` (widen `authenticate`), `apps/api/src/zimbra/zimbra.service.ts` + `apps/api/src/provider/memory/memory-mail.provider.ts` (accept & ignore the new optional arg — signatures only)

**Interfaces:**
- Produces: `class EwsCrypto { constructor(rawKey?: string); encrypt(plaintext: string): string; decrypt(blob: string): string; }` — AES-256-GCM; `encrypt` returns a self-describing base64 blob (`iv:tag:ciphertext`); `decrypt` throws on tamper/wrong key. The 32-byte key is derived ONCE (memoized) via `scryptSync(rawKey, fixedSalt, 32)` from the constructor's `rawKey` (defaulting to `process.env.MAIL_CRED_KEY`); constructing with no key available throws a clear error. Used by Tasks 2 (session decrypt) and 8 (login encrypt).
- Widened interface method `authenticate(host, email, password, opts?: { ntlmDomain?: string })`.

- [ ] **Step 1: Failing crypto test** — round-trip (`decrypt(encrypt(x)) === x`), distinct ciphertexts for same plaintext (random IV), `decrypt` throws on a mutated blob (GCM tag), constructing with `rawKey=''`/undefined-and-no-env throws `Error(/MAIL_CRED_KEY/)`. Key derivation is deterministic for the same rawKey.

```ts
import { EwsCrypto } from './ews-crypto';
describe('EwsCrypto', () => {
  const c = new EwsCrypto('a'.repeat(48));
  it('round-trips', () => { const b = c.encrypt('MINAFFET\\test-risa1|pw'); expect(c.decrypt(b)).toBe('MINAFFET\\test-risa1|pw'); });
  it('uses a random IV (distinct ciphertexts)', () => { expect(c.encrypt('x')).not.toBe(c.encrypt('x')); });
  it('rejects a tampered blob', () => { const b = c.encrypt('x'); const bad = b.slice(0, -2) + (b.endsWith('a') ? 'b' : 'a'); expect(() => c.decrypt(bad)).toThrow(); });
  it('refuses to construct without a key', () => { delete process.env.MAIL_CRED_KEY; expect(() => new EwsCrypto()).toThrow(/MAIL_CRED_KEY/); });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `ews-crypto.ts`** using Node `crypto` (`scryptSync`, `randomBytes(12)`, `createCipheriv('aes-256-gcm', ...)`, `getAuthTag`). Memoize the derived key in a private field. Blob format: `base64(iv).base64(tag).base64(ciphertext)` joined by a separator that can't appear in base64 (e.g. `.`).

- [ ] **Step 4: Widen `authenticate`** in the interface to `authenticate(host: string, email: string, password: string, opts?: { ntlmDomain?: string }): Promise<ProviderAuthResult>;`. Update `ZimbraService.authenticate` and `MemoryMailProvider.authenticate` to accept the optional arg (name it `_opts` — unused). `AuthService`'s existing call (`authenticate(zimbraHost, email, password)`) still compiles unchanged.

- [ ] **Step 5: Run → PASS; full `npx jest` + `npx tsc --noEmit` clean.**

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/ews apps/api/src/provider/mail-provider.interface.ts apps/api/src/zimbra apps/api/src/provider/memory
git commit -m "feat(api): EWS credential encryption (AES-256-GCM) + authenticate ntlmDomain arg"
```

---

### Task 2: buildMailSession EWS branch + fast-xml-parser + envelope/parse helpers

**Files:**
- Create: `apps/api/src/ews/ews-envelopes.ts`, `apps/api/src/ews/ews-parse.ts`, their specs
- Modify: `apps/api/src/provider/mail-session.ts` (+ spec), `apps/api/package.json` (add `fast-xml-parser`, `httpntlm`)

**Interfaces:**
- Consumes: `EwsCrypto` (Task 1).
- Produces:
  - `buildMailSession` now branches on `user.provider`: for `ews`, decrypt `user.authToken` (the encrypted `{username, password}` blob from Task 8's login) into `session.credentials = { username, password }` and leave `authToken` undefined; for everything else, behave exactly as today. The `EwsCrypto` instance is module-level (derived-key memoized at first use — the carry-over note: buildMailSession is sync, so the key is derived once at boot, not per request).
  - `ews-envelopes.ts`: `soapEnvelope(bodyXml: string): string` wrapping body in the SOAP envelope with the `t:RequestServerVersion Version="Exchange2013_SP1"` header and the three EWS namespaces; plus `getFolderEnvelope(distinguishedId: string): string` as the first concrete op (used by Task 3's `authenticate` probe). Escape all interpolated values (`xmlEscape`).
  - `ews-parse.ts`: `parseEws(xml: string): any` (a configured `fast-xml-parser` instance) and `responseClassOf(messageNode): 'Success'|'Warning'|'Error'` + `responseCodeOf`/`messageTextOf` extractors used by `handleEwsError`.

- [ ] **Step 1: add deps** — `cd apps/api && npm install fast-xml-parser httpntlm@1.8.13` (or the repo's package manager — check for pnpm-lock/package-lock and match). Commit the lockfile change with the task.

- [ ] **Step 2: Failing tests** — (a) `buildMailSession` for an `ews` user with an encrypted authToken yields `credentials:{username,password}` and no `authToken`; for a `zimbra` user it is byte-identical to today. (b) `soapEnvelope` wraps a body with the RequestServerVersion header and escapes `&<>"`. (c) `parseEws` on a small GetFolderResponse fixture returns the folder's DisplayName/UnreadCount/TotalCount and `responseClassOf` reads `Success`.

- [ ] **Step 3: Run → FAIL.** — [ ] **Step 4: Implement** all three. For `mail-session.ts`, gate the decrypt behind `user.provider === 'ews'`; import a shared module-level `EwsCrypto` (lazy-init so non-EWS deployments without `MAIL_CRED_KEY` still boot — only construct the crypto when an ews session is first built, and surface a clear error if the key is missing at that point).

- [ ] **Step 5: `npx jest` + `npx tsc --noEmit` clean.**

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/ews apps/api/src/provider/mail-session.ts apps/api/package.json apps/api/*lock*
git commit -m "feat(api): EWS session decrypt in buildMailSession + SOAP envelope/parse helpers"
```

---

### Task 3: NTLM transport, handleEwsError, EwsService skeleton + authenticate

**Files:**
- Create: `apps/api/src/ews/ews-transport.ts` (NTLM HTTP), `apps/api/src/ews/ews.service.ts` (skeleton + `authenticate`, `verifyTwoFactor`), their specs, `apps/api/src/ews/__fixtures__/` (getfolder-inbox.success.xml, soapfault.xml, error-servertoobusy.xml, http401 case)

**Interfaces:**
- Consumes: envelopes/parse (Task 2), `EwsCrypto`.
- Produces:
  - `class EwsTransport { call(session: MailSession, bodyXml: string): Promise<string> }` — resolves the endpoint (`https://{host}/EWS/Exchange.asmx`, same host-normalization as `ZimbraService.buildClient`), performs the NTLM-authenticated POST via `httpntlm` using `session.credentials.{username,password}`, with a keep-alive `https.Agent` cached per session identity (email) and honoring `MAIL_CA_BUNDLE` when set. Returns the raw response XML or throws through `handleEwsError`. The transport is injectable so tests can substitute a fake.
  - `handleEwsError(status, xml?, err?): never` per the Global Constraints mapping, including the single `ErrorServerBusy`/`BackOffMilliseconds` retry (implemented at the `EwsService` call boundary, not inside `handleEwsError` itself).
  - `EwsService`: constructor asserts `MAIL_CRED_KEY` present (throws otherwise); `readonly name = 'ews'`; `readonly capabilities = { signatures:false, identities:false, serverPrefs:false, changePassword:false, twoFactor:false }`; `authenticate(host, email, password, opts)` derives the NTLM username (`opts.ntlmDomain ? \`${opts.ntlmDomain}\\${localpart(email)}\` : email`, and pass a user-typed `DOMAIN\user` through untouched), runs the `GetFolder(inbox)` probe with those credentials, and on success returns `{ authToken: EwsCrypto.encrypt(JSON.stringify({username, password})), lifetime: <jwt-expiry-ms>, displayName: <ResolveNames best-effort>, twoFactorRequired: false }`; a probe failure throws `UnauthorizedException`. `verifyTwoFactor` throws `CapabilityNotSupportedError` (never reached — EWS never challenges). Every other interface method is a `throw new Error('not implemented')` STUB for now (Tasks 4–7 fill them); the class does NOT yet declare `implements MailProvider`.

- [ ] **Step 1: Failing tests** (transport faked with fixtures): `authenticate` with a good GetFolder fixture returns an encrypted authToken (decrypts to `{username:'MINAFFET\\test-risa1', password}`) + `twoFactorRequired:false`; a 401 fixture → `UnauthorizedException`; a SOAP-fault fixture → `BadGatewayException` carrying the ResponseCode; an `ErrorServerBusy` fixture triggers exactly one retry (assert the transport was called twice) then succeeds/fails; username derivation prepends `ntlmDomain` for a bare email and passes a `DOMAIN\user` through unchanged.

- [ ] **Step 2: Run → FAIL.** — [ ] **Step 3: Implement.** Use `httpntlm.post` (from the spike) inside `EwsTransport`; cache one keep-alive agent per session email in a Map, evicted on logout (Task 8 wires eviction). Redact credentials/Authorization in any debug logging.

- [ ] **Step 4: `npx jest` + `npx tsc --noEmit` clean.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ews
git commit -m "feat(api): EWS NTLM transport + error mapping + authenticate probe"
```

---

### Task 4: EWS folders + message reads

**Files:** Modify `apps/api/src/ews/ews.service.ts`, `ews-envelopes.ts`, `ews-parse.ts`; add fixtures + tests.

**Interfaces:**
- Produces (implemented on `EwsService`): `getFolders`, `getMessages`, `getMessage`, `searchMessages`, `createFolder`, `deleteFolder`, `renameFolder`, `emptyFolder`. Map per **spec §5.3** (the authoritative table): `FindFolder` deep from `msgfolderroot`; `FindItem` + `IndexedPageItemView` sorted `item:DateTimeReceived desc` with the AdditionalProperties listed; `GetItem` `BodyType=HTML`; `FindItem` `QueryString` (AQS); `CreateFolder`/`DeleteFolder`(HardDelete)/`UpdateFolder`(DisplayName)/`EmptyFolder`. Return the neutral DTOs — every field of `ProviderMessage`/`ProviderFolder`/`ProviderMessagePage` exactly as `provider-types.ts` requires (map `DistinguishedFolderId` names → `type`/`kind`, `ConversationId` → `conversationId`, EWS `ItemId Id` → `id`).

- [ ] **Step 1** — Read spec §5.3 rows for these ops and `provider-types.ts`. Write the envelope builders + a fixture pair per op (request snapshot + a realistic response XML — Microsoft's EWS docs examples are the source). **One fully-worked example to follow — `getFolders`:** envelope `FindFolder` deep from `msgfolderroot`; fixture `findfolder.success.xml` with Inbox/Sent/Drafts/Deleted Items/Junk carrying `UnreadCount`/`TotalCount`; test asserts `getFolders(session)` maps them to `ProviderFolder[]` with correct `type`/`kind`/counts. Replicate that shape for the other ops.

- [ ] **Step 2: Failing tests** — per op: envelope construction matches the snapshot; response parse → neutral DTO with all required fields; `getMessages` pagination (`Offset`/`MaxEntriesReturned` → `{messages,total,more}`); `getMessage` unknown id (`ErrorItemNotFound` fixture) → `NotFoundException`. — [ ] **Step 3: Run → FAIL → implement → PASS.**

- [ ] **Step 4: `npx jest` + `npx tsc --noEmit` clean.**

- [ ] **Step 5: Commit** `feat(api): EWS folders + message reads`

---

### Task 5: EWS message mutations, send, drafts, attachments

**Files:** Modify `ews.service.ts`, `ews-envelopes.ts`; fixtures + tests.

**Interfaces:**
- Produces: `markRead`, `moveMessage`, `deleteMessage`, `sendMessage`, `saveDraft`, `uploadAttachment`, `downloadAttachment`, `downloadAttachmentBuffer`. Map per §5.3: `UpdateItem message:IsRead SuppressReadReceipts`; `MoveItem`; `MoveItem→deleteditems`; send = `CreateItem SaveOnly` → `CreateAttachment` per file (base64, inline images `IsInline`+`ContentId`) → `SendItem SaveItemToFolder`, and `ReplyToItem`/`ForwardItem` response objects when `replyToId` is set; `saveDraft` = `CreateItem SaveOnly`→drafts / `UpdateItem AlwaysOverwrite` returning the fresh ItemId; attachments buffered-and-attached (no standalone upload — `uploadAttachment` buffers server-side, keyed for the send/draft that follows); `GetAttachment` → base64 → Buffer + contentType/filename. **ChangeKey fetched fresh** (`GetItem` before each `UpdateItem`).

- [ ] **Step 1** — envelopes + fixture pairs per op (incl. `ErrorChangeKeyRequiredForWriteOperations` and a multi-step send fixture sequence). — [ ] **Step 2: Failing tests** (send round-trip incl. attachment CreateAttachment step; draft create vs update returns fresh id; markRead envelope; download decodes base64; the fresh-ChangeKey fetch happens before UpdateItem). — [ ] **Step 3: Run → FAIL → implement → PASS.**

- [ ] **Step 4: `npx jest` + `npx tsc --noEmit` clean.** — [ ] **Step 5: Commit** `feat(api): EWS mutations, send, drafts, attachments`

---

### Task 6: EWS contacts, GAL, calendar, free/busy

**Files:** Modify `ews.service.ts`, `ews-envelopes.ts`; fixtures + tests.

**Interfaces:**
- Produces: `getContacts`, `createContact`, `modifyContact`, `deleteContact`, `autoCompleteContacts`, `searchGal`, `getCalendarEvents`, `getAppointment`, `createCalendarEvent`, `modifyCalendarEvent`, `deleteCalendarEvent`, `sendInviteReply`, `getFreeBusy`. Map per §5.3: contacts via `FindItem`/`CreateItem`/`UpdateItem`/`MoveItem` (map GivenName/Surname/DisplayName/EmailAddress1..3/phones/company → the role-tagged `ProviderContact`); `ResolveNames ReturnFullContactData ActiveDirectoryContacts` serves both `autoCompleteContacts` and `searchGal`, both returning `{email,display}` and **never throwing** (degrade to `[]`); `CalendarView` on `calendar`; `GetItem` with `RequiredAttendees`/`OptionalAttendees` `ResponseType`→`ptst` for `getAppointment` (→ `ProviderEventDetail | null`); `CreateItem`/`UpdateItem`/`DeleteItem` CalendarItem with the `SendMeetingInvitations*` attributes; `AcceptItem`/`DeclineItem`/`TentativelyAcceptItem` for `sendInviteReply`; `GetUserAvailability FreeBusyViewType=FreeBusy` → the `{busy,tentative,unavailable}` triple.

- [ ] **Step 1** envelopes + fixtures per op. — [ ] **Step 2: Failing tests** (contact CRUD round-trip; ResolveNames → {email,display} + never-throws on error fixture; CalendarView in-window → ProviderEvent[]; getAppointment unknown → null; getFreeBusy parses merged availability into the triple). — [ ] **Step 3: FAIL → implement → PASS.**

- [ ] **Step 4: gates clean.** — [ ] **Step 5: Commit** `feat(api): EWS contacts, GAL, calendar, free/busy`

---

### Task 7: Capability-gap surface + settings branch + CapabilityNotSupportedError mapping; implements MailProvider

**Files:** Modify `ews.service.ts` (settings methods + `implements MailProvider`), `apps/api/src/settings/settings.service.ts` (+ controller/spec), a Nest exception filter or controller mapping for `CapabilityNotSupportedError`; web settings already gates on `capabilities` (Phase 1 Task 9) — verify, no change expected.

**Interfaces:**
- Produces: `getPrefs`, `modifyPrefs`, `getIdentities`, `modifyIdentity`, `getSignatures`, `createSignature`, `modifySignature`, `deleteSignature`, `changePassword` all throw `CapabilityNotSupportedError` (capabilities already all-false from Task 3). Add `implements MailProvider` to `EwsService` — tsc now enforces the full interface is satisfied (Tasks 3–7 must have covered every method). **The §7 carry-over fix (flagged by Phase 1's final review): `SettingsService.getSettings` must capability-branch** — when `provider.capabilities.identities/signatures/serverPrefs` are false, return those sections empty instead of calling the provider (which would throw), and include the `capabilities` object (already added in Phase 1). Map `CapabilityNotSupportedError` → HTTP 400 with a human message (a global exception filter is cleanest) so a direct call to a hidden setting is a clean 400, never a 500. Leave a `TODO(exchange-signatures)` marker where a local `EmailSignature` table would slot in.

- [ ] **Step 1: Failing tests** — `getSettings` for an EWS-capability provider returns `capabilities:{...all false}` with empty identities/signatures/prefs and does NOT throw; a direct `changePassword`/`modifyPrefs` on EWS surfaces as HTTP 400 (via the filter), not 500; each EWS settings method throws `CapabilityNotSupportedError`; `EwsService implements MailProvider` compiles (add a `const _p: MailProvider = ewsService` typed check).

- [ ] **Step 2: FAIL → implement → PASS.** Confirm the web settings page (Phase 1) already hides sections when the flag is false — no web change; note it in the report.

- [ ] **Step 3: `npx jest` + `npx tsc --noEmit` clean.** — [ ] **Step 4: Commit** `feat(api): EWS capability gaps — settings branch + 400 mapping; implements MailProvider`

---

### Task 8: Resolver registration, EwsModule, login credential storage, env, docs

**Files:** Modify `apps/api/src/provider/mail-provider.resolver.ts`, `apps/api/src/provider/provider.module.ts`, create `apps/api/src/ews/ews.module.ts`; modify `apps/api/src/auth/auth.service.ts` (pass `ntlmDomain` + logout agent eviction); `ARCHITECTURE.md`; `.env.example` / config docs; a manual-smoke checklist doc.

**Interfaces:**
- Produces: `resolver.forUser({provider:'ews'})` returns `EwsService`. `EwsModule` provides `EwsService`/`EwsTransport`/`EwsCrypto`, imported by `ProviderModule`; graph acyclic. `AuthService.login` passes `opts:{ ntlmDomain: inst.ewsDomain ?? undefined }` to `authenticate` (the widened arg from Task 1), and `createSession` stores the returned (already-encrypted) `authToken` unchanged — so no plaintext ever touches the DB. On logout, evict the transport's keep-alive agent for that email. `MAIL_CRED_KEY` boot requirement documented.

- [ ] **Step 1: Failing resolver test** — `forUser({provider:'ews'})` returns the EwsService instance; zimbra/memory unchanged; the module compiles the real AppModule (extend the existing provider.module spec). Auth: `login` for an `ews` institution calls `authenticate(host, email, password, { ntlmDomain: 'MINAFFET' })` and stores the encrypted authToken (assert the stored value decrypts to the credentials, and no plaintext password is persisted).

- [ ] **Step 2: FAIL → implement → PASS.** Register `case 'ews': return this.ewsService;` in the resolver (no env gate — EWS is a real provider; the Institution table controls who is `ews`). Wire `EwsModule` into `ProviderModule`. In `auth.service`, thread `inst.ewsDomain` through and add logout agent eviction. `EwsService` construction already asserts `MAIL_CRED_KEY` (Task 3) — so a deployment that has an `ews` institution but no key fails fast at boot, which is correct.

- [ ] **Step 3: `ARCHITECTURE.md`** — EWS provider section: transport/NTLM/keep-alive, credential encryption + at-rest storage, capability matrix (all false), the `ntlmDomain` flow, env vars (`MAIL_CRED_KEY` required, `MAIL_CA_BUNDLE` optional). **`.env.example`**: add `MAIL_CRED_KEY=` (required for EWS) and `MAIL_CA_BUNDLE=` (optional) with comments; note the test-account passwords go in a gitignored `.env.local`.

- [ ] **Step 4: Manual-smoke checklist doc** (`docs/exchange-ews-smoke-checklist.md`) — the §5.4 real-server pass: seed the empty MINAFFET mailboxes by mailing between the three accounts, then log in as each and exercise folders → read → send (between test accounts) → search → contacts → calendar round-trip → free/busy, plus the provider-independent surfaces (snooze, scheduled send, templates, tasks, docs) and the capability-hidden settings sections. No real external attendees.

- [ ] **Step 5: FULL `npx jest` + `npx tsc --noEmit` clean.** — [ ] **Step 6: Commit** `feat(api): register EWS provider + login credential storage + docs`

---

## Acceptance (spec §5.4 / §10.5)

1. Every §5.3 method implemented with fixture-backed unit tests including the error fixtures (SOAP fault, ErrorInvalidId, ErrorItemNotFound, ErrorChangeKeyRequiredForWriteOperations, HTTP 401, ErrorServerBusy back-off). `rejectUnauthorized:false` appears nowhere in new code; credentials encrypted at rest and redacted in logs; test-account passwords appear nowhere in the repo.
2. `EwsService implements MailProvider` (tsc-enforced); capabilities all-false; settings surface capability-branches (no 500s for EWS users); `CapabilityNotSupportedError` → 400.
3. **Manual smoke against the real MINAFFET server** (the checklist doc, run once from the dev Mac which can reach the endpoint) — login as a test account, exercise folders/read/send-between-test-accounts/search/contacts/calendar/free-busy. This is the phase's real end-to-end proof and the final gate before declaring Phase 3 done; it is NOT part of CI.
