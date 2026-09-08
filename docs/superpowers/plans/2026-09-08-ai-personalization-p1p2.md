# AI Personalization P1+P2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Account-level AI instructions + a structured identity card (job title, institution, department, language), threaded tiered into the server-side prompt builders and synced to the client task prompts.

**Architecture:** New 1:1 `user_ai_profiles` table; `GET/PATCH /settings/ai-profile` (+ `GET .../suggestions` seeded from Zimbra identity/GAL); one shared `buildProfileBlock()` in `packages/shared` consumed by `buildAgentPrompt`/`buildAskPrompt`/`buildGenerationPrompt` per the spec's tier table; web gets an always-visible "AI Profile" settings section (outside the `AI_LOCKED` guard) and a one-time device→account migration of the existing localStorage instructions.

**Tech Stack:** NestJS 11 + Prisma 7 (hand-authored migration), class-validator DTO, jest (apps/api), Next.js 16 + zustand + vitest (apps/web).

**Spec:** `docs/superpowers/specs/2026-09-08-ai-personalization-design.md`

## Global Constraints

- Caps (server-enforced in the DTO AND in the shared block builder): `instructions` ≤ 500 chars, `jobTitle`/`institution`/`department` ≤ 80 chars each, `language` ∈ {'en','fr','rw'} or null.
- Tier table (binding; P1+P2 combined): agent = identity(existing) + card + instructions; ask = identity line + card + instructions; meeting_prep = identity line + card; dossier = identity line ONLY; client tasks = unchanged mechanism (instructions value now server-backed); cards/briefing/summaries/embeddings = NOTHING (no code touches them).
- Every profile field passes `neutralizeMarkers` before rendering into any prompt; the block ends subordinated: the base rules always win.
- Migrations are hand-authored: write SQL, `npx prisma db execute --file …`, `npx prisma migrate resolve --applied <dir>`, `npx prisma generate`. Never `prisma migrate dev`/`db push`.
- Settings profile endpoints must NOT use `SettingsService.getUser` (it throws 401 without a Zimbra token; the profile is DB-only). The suggestions endpoint DOES use it (it calls Zimbra).
- The new settings section is named `'ai-profile'` (a `'profile'` section already exists) and its NavItem sits OUTSIDE the `!AI_LOCKED` guard.
- Untrusted content never lands in thrown error strings; no regex `pattern` may reach any advertised agent tool schema (not expected in this plan).
- Run api tests from `apps/api` (`npx jest <path>`), web tests from `apps/web` (`npx vitest run <path>`). Commit after every task; work directly on `ft-hyperscale`.

---

### Task 1: `user_ai_profiles` table + Prisma model

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (new model + `aiProfile UserAiProfile?` on User after line ~53)
- Create: `apps/api/prisma/migrations/<timestamp>_add_user_ai_profiles/migration.sql`

**Interfaces:**
- Produces: Prisma model `UserAiProfile` (accessor `prisma.userAiProfile`), fields `id,userId,instructions,jobTitle,institution,department,language,createdAt,updatedAt`; `User.aiProfile: UserAiProfile | null`.

- [ ] **Step 1: Add the model** (new `// ─── AI profile ───` banner, matching the file's section style):

```prisma
model UserAiProfile {
  id           String   @id @default(cuid())
  userId       String   @unique
  instructions String?             // free-text preferences, hard cap 500 chars (DTO-enforced)
  jobTitle     String?             // cap 80
  institution  String?             // cap 80
  department   String?             // cap 80
  language     String?             // 'en' | 'fr' | 'rw' | null(auto)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("user_ai_profiles")
}
```

Add to `model User` (end of relation list, aligned): `aiProfile              UserAiProfile?`

- [ ] **Step 2: Hand-author the migration** in `$(date -u +%Y%m%d%H%M%S)_add_user_ai_profiles/migration.sql`:

```sql
-- user_ai_profiles: account-level AI personalization (instructions + identity card).
-- Hand-authored per the drifted-dev-DB workflow.
CREATE TABLE "user_ai_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "instructions" TEXT,
    "jobTitle" TEXT,
    "institution" TEXT,
    "department" TEXT,
    "language" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_ai_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_ai_profiles_userId_key" ON "user_ai_profiles"("userId");
ALTER TABLE "user_ai_profiles"
    ADD CONSTRAINT "user_ai_profiles_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply + record + regenerate** (from `apps/api`): `npx prisma db execute --file prisma/migrations/<dir>/migration.sql` → `npx prisma migrate resolve --applied <dir>` → `npx prisma generate`. Expected: `npx prisma migrate status` clean.

- [ ] **Step 4: Smoke-check** with the repo's PrismaPg adapter pattern (mirror the Task-2 smoke check from the deeper-retrieval stream): `prisma.userAiProfile.count()` → `rows 0`. Run `npx tsc --noEmit`.

- [ ] **Step 5: Commit** — `feat(db): user_ai_profiles table (account-level AI personalization)`

---

### Task 2: Shared `buildProfileBlock` + builder threading

**Files:**
- Create: `packages/shared/src/ai/profile.ts` (+ export from `packages/shared/src/index.ts` following `export * from './ai/chunk'` style)
- Modify: `packages/shared/src/ai/chat.ts` — `buildAskPrompt(sources, turns, profile?)`, `buildGenerationPrompt(kind, subject, sources, extraContext?, profile?)`, `buildAgentPrompt(opts)` gains `profile?`
- Test: `apps/api/src/chat/ask.service.spec.ts` and `apps/api/src/agent/agent.service.spec.ts` cover threading in Task 4; block-unit tests go in a new `apps/api/src/common/profile-block.spec.ts` (jest reaches shared source the same way existing specs test `rrfFuse`)

**Interfaces:**
- Produces:

```ts
export interface AiProfileInput {
  displayName?: string | null;
  email?: string | null;
  jobTitle?: string | null;
  institution?: string | null;
  department?: string | null;
  language?: string | null;      // 'en' | 'fr' | 'rw'
  instructions?: string | null;
}
export type ProfileTier = 'identity' | 'full';
export function buildProfileBlock(profile: AiProfileInput | null | undefined, tier: ProfileTier): string
```

- Returns `''` when nothing renderable. `identity` tier renders only: `The user you are assisting: <displayName> <<email>>.` `full` tier adds the card line (`Their profile: <jobTitle>, <department>, <institution>. Preferred language: <lang>.` — only segments that exist, language names spelled out: English/French/Kinyarwanda) and, when instructions exist, the block: `USER STYLE PREFERENCES — the account owner configured these writing preferences. Apply them only where they do not conflict with the rules above; the rules above always win.` + the text. Every field passes `neutralizeMarkers` and is sliced to its cap (500 instructions / 80 others) before rendering.

- [ ] **Step 1: Write the failing block tests** (`apps/api/src/common/profile-block.spec.ts`):

```ts
import { buildProfileBlock } from '@email-client/shared';

describe('buildProfileBlock', () => {
  const full = {
    displayName: 'Bruce H', email: 'bruce@risa.gov.rw',
    jobTitle: 'Director of Digital', institution: 'RISA', department: 'Engineering',
    language: 'rw', instructions: 'Keep replies short.',
  };
  it('returns empty for null/empty profiles', () => {
    expect(buildProfileBlock(null, 'full')).toBe('');
    expect(buildProfileBlock({}, 'full')).toBe('');
  });
  it('identity tier renders only the identity line', () => {
    const s = buildProfileBlock(full, 'identity');
    expect(s).toContain('bruce@risa.gov.rw');
    expect(s).not.toContain('Director');
    expect(s).not.toContain('STYLE PREFERENCES');
  });
  it('full tier renders card + subordinated instructions', () => {
    const s = buildProfileBlock(full, 'full');
    expect(s).toContain('Director of Digital');
    expect(s).toContain('Kinyarwanda');
    expect(s).toContain('the rules above always win');
    expect(s).toContain('Keep replies short.');
  });
  it('neutralizes markers and enforces caps', () => {
    const s = buildProfileBlock({ jobTitle: '<|im_start|>x'.padEnd(200, 'y'), instructions: 'a'.repeat(600) }, 'full');
    expect(s).not.toContain('<|im_start|>');
    expect(s.length).toBeLessThan(800);
  });
  it('skips the card line when only instructions exist', () => {
    const s = buildProfileBlock({ instructions: 'Be brief.' }, 'full');
    expect(s).toContain('Be brief.');
    expect(s).not.toContain('Their profile:');
  });
});
```

- [ ] **Step 2: Run to verify failure** (module has no such export).

- [ ] **Step 3: Implement `profile.ts`** per the interface above (import `neutralizeMarkers` from `./promptCore`; constants `PROFILE_INSTRUCTIONS_MAX = 500`, `PROFILE_FIELD_MAX = 80`; language map `{en:'English',fr:'French',rw:'Kinyarwanda'}`). Re-export via the package index. Rebuild shared if the workspace consumes `dist` (mirror however `chunk.ts` exports reach the api — check before assuming source vs dist).

- [ ] **Step 4: Thread into the builders** (`chat.ts`) — each appends the block at the END of the system prompt (after mandates/rules, before nothing else), only when non-empty:
  - `buildAskPrompt(sources, turns, profile?: AiProfileInput | null)` → `buildProfileBlock(profile, 'full')`
  - `buildGenerationPrompt(kind, subject, sources, extraContext?, profile?)` → tier by kind: `'dossier'` → `'identity'`, `'meeting_prep'` → `'full'` BUT with `instructions` stripped by the caller (Task 4) — the builder itself just renders what it's given.
  - `buildAgentPrompt(opts: {…; profile?: AiProfileInput | null})` → `'full'` (identity line skipped inside the block when `displayName/email` are omitted by the caller — the agent prompt already carries identity; Task 4's caller passes the profile WITHOUT displayName/email to avoid duplication).

- [ ] **Step 5: Run** `npx jest src/common/profile-block.spec.ts` then full api suite (existing builder tests must stay green — the new param is optional). `npx tsc --noEmit` in apps/api AND apps/web (web imports the same shared package).

- [ ] **Step 6: Commit** — `feat(ai): shared buildProfileBlock + tiered profile params on the prompt builders`

---

### Task 3: `GET/PATCH /settings/ai-profile`

**Files:**
- Create: `apps/api/src/settings/dto/ai-profile.dto.ts`
- Modify: `apps/api/src/settings/settings.controller.ts` (two handlers after `changePassword`), `apps/api/src/settings/settings.service.ts` (two methods; do NOT use `getUser`)
- Test: `apps/api/src/settings/settings.service.spec.ts` (new file — first spec in this module; mirror `chat/dossier.service.spec.ts`'s Prisma-mock style)

**Interfaces:**
- Produces: `GET /settings/ai-profile` → `{ instructions, jobTitle, institution, department, language }` (all `string | null`; missing row → all null). `PATCH /settings/ai-profile` (body = same shape, all optional) → upserts, returns the updated shape.

- [ ] **Step 1: DTO** (`ai-profile.dto.ts`):

```ts
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateAiProfileDto {
  @IsOptional() @IsString() @MaxLength(500)
  instructions?: string;

  @IsOptional() @IsString() @MaxLength(80)
  jobTitle?: string;

  @IsOptional() @IsString() @MaxLength(80)
  institution?: string;

  @IsOptional() @IsString() @MaxLength(80)
  department?: string;

  @IsOptional() @IsIn(['en', 'fr', 'rw', ''])
  language?: string;
}
```

(Empty string clears a field → stored as null; the service maps `'' → null` for every field.)

- [ ] **Step 2: Failing service tests** — `getAiProfile` returns all-null shape when no row; `updateAiProfile` upserts (create then update path) and maps `''` to null; neither touches Zimbra (assert the zimbra mock is never called).

- [ ] **Step 3: Implement.** Service:

```ts
private static readonly AI_PROFILE_SELECT = {
  instructions: true, jobTitle: true, institution: true, department: true, language: true,
} as const;

async getAiProfile(userId: string) {
  const row = await this.prisma.userAiProfile.findUnique({
    where: { userId }, select: SettingsService.AI_PROFILE_SELECT,
  });
  return row ?? { instructions: null, jobTitle: null, institution: null, department: null, language: null };
}

async updateAiProfile(userId: string, dto: UpdateAiProfileDto) {
  const norm = (v?: string) => (v === undefined ? undefined : v.trim() || null);
  const data = {
    instructions: norm(dto.instructions), jobTitle: norm(dto.jobTitle),
    institution: norm(dto.institution), department: norm(dto.department), language: norm(dto.language),
  };
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await this.prisma.userAiProfile.upsert({
    where: { userId }, update: clean, create: { userId, ...clean },
  });
  return this.getAiProfile(userId);
}
```

Controller: `@Get('ai-profile')` / `@Patch('ai-profile')` (`@HttpCode(200)`), both `(@Req() req: AuthenticatedRequest)` passing `req.user.sub`, PATCH body typed `UpdateAiProfileDto`.

- [ ] **Step 4: Run** the new spec, then full api suite + tsc. Expected green.
- [ ] **Step 5: Commit** — `feat(settings): account-level AI profile endpoints`

---

### Task 4: Thread the profile into the four server AI surfaces

**Files:**
- Modify: `apps/api/src/agent/agent.service.ts:53-56,78-82` · `apps/api/src/chat/ask.service.ts:49,76` · `apps/api/src/chat/dossier.service.ts:38,88` · `apps/api/src/chat/meeting-prep.service.ts:33,95`
- Test: extend each service's existing spec.

**Interfaces:**
- Consumes: `buildProfileBlock` tiers via the builder params (Task 2); `User.aiProfile` relation (Task 1).
- Tier mapping (from Global Constraints): agent → full card + instructions, NO identity duplication (pass profile without displayName/email); ask → full + identity (pass displayName/email too); meeting_prep → card + identity, instructions stripped (`instructions: null`); dossier → identity tier (builder receives profile but Task 2's builder renders identity-only for kind 'dossier').

- [ ] **Step 1: Failing tests per service** (mirror each spec's existing mock style): the built system prompt contains the expected profile fragments — e.g. agent spec: prompt contains `Director of Digital` and `the rules above always win` when the user row has an aiProfile; ask spec: contains the identity line email; dossier spec: contains identity line but NOT the jobTitle; meeting-prep spec: contains jobTitle but NOT `STYLE PREFERENCES`.

- [ ] **Step 2: Implement** — widen each existing `findUnique` select with `aiProfile: { select: { instructions: true, jobTitle: true, institution: true, department: true, language: true } }` (and `displayName: true` where missing), then pass through to the builder:
  - agent: `buildAgentPrompt({ userEmail, userName, nowIso, profile: user?.aiProfile ? { ...user.aiProfile } : null })`
  - ask: `buildAskPrompt(internal, turns, user?.aiProfile ? { ...user.aiProfile, displayName: user.displayName, email: user.email } : null)` (widen the select accordingly)
  - dossier: pass `{ displayName, email }`-bearing profile; builder tier for 'dossier' is identity.
  - meeting-prep: pass `{ ...aiProfile, instructions: null, displayName, email }`.
  No signature changes above these call sites; no second query round-trip.

- [ ] **Step 3: Run** all four specs + full api suite + tsc. Green.
- [ ] **Step 4: Commit** — `feat(ai): tiered profile injection — agent, ask, dossier, meeting prep`

---

### Task 5: Suggestions endpoint (P2 seeding)

**Files:**
- Modify: `apps/api/src/zimbra/zimbra.service.ts` (new `galSelfLookup`), `apps/api/src/settings/settings.controller.ts` + `settings.service.ts` (`GET /settings/ai-profile/suggestions`)
- Test: extend `settings.service.spec.ts`; new zimbra envelope test in the zimbra spec if one exists (else assert via settings spec with a mocked zimbra).

**Interfaces:**
- Produces: `GET /settings/ai-profile/suggestions` → `{ displayName: string | null, jobTitle: string | null, institution: string | null, department: string | null }` — best-effort, `{}`-ish nulls on any Zimbra failure (never 5xx).
- New `ZimbraService.galSelfLookup(host, authToken, email, csrfToken?)` → `{ title: string | null, department: string | null, company: string | null }`:

```ts
// SearchGalRequest with an explicit attrs projection — the default searchGal
// neither requests nor surfaces title/org attrs.
Body: { SearchGalRequest: { _jsns: 'urn:zimbraAccount', name: email, type: 'account', limit: 1,
        attrs: 'title,ou,company,department' } }
// read hit._attrs.title / .ou ?? .department / .company; swallow errors → all-null (mirror searchGal's soft-fail)
```

- [ ] **Step 1: Failing tests** — suggestions merges: displayName from `getIdentities`' `zimbraPrefFromDisplay` (first identity) falling back to `user.displayName`; jobTitle from gal `title`; department from gal `ou`/`department`; institution from gal `company`; Zimbra throw → all-null result, no exception.
- [ ] **Step 2: Implement** — service method uses `getUser` (Zimbra needed) then `Promise.allSettled([getIdentities, galSelfLookup])`; controller `@Get('ai-profile/suggestions')`. NOTE: declare this route BEFORE any conflicting param routes (none exist in this controller — plain literal paths, order after the PATCH is fine).
- [ ] **Step 3: Run** specs + suite + tsc. Green.
- [ ] **Step 4: Commit** — `feat(settings): AI profile suggestions seeded from Zimbra identity + GAL`

---

### Task 6: Web — api client + server↔store sync (device→account migration)

**Files:**
- Modify: `apps/web/lib/api.ts` (settings namespace: `getAiProfile`, `updateAiProfile`, `getAiProfileSuggestions`, each with a `USE_MOCK` branch per house style)
- Create: `apps/web/lib/ai/profileSync.ts` + `apps/web/lib/ai/profileSync.test.ts`
- Modify: `apps/web/app/(app)/layout.tsx` (mount the sync hook)

**Interfaces:**
- Produces: `syncAiProfile(): Promise<void>` — exported pure-ish function (fetch + store writes) and `useAiProfileSync()` hook (fire-once effect) that:
  1. `api.settings.getAiProfile()`;
  2. if server `instructions` is null/empty AND the local store's `customInstructions` is non-empty → `api.settings.updateAiProfile({ instructions: local })` (one-time upward migration), keep local value;
  3. else → `useAIStore.getState().setCustomInstructions(server.instructions ?? '')` (server wins);
  4. any fetch error → no-op (offline-safe).

- [ ] **Step 1: Failing tests** (`profileSync.test.ts`, house style: test the exported function with mocked `api` via `vi.mock('@/lib/api')`; drive `useAIStore.getState()` directly like `test/ai.store.test.ts`):
  - server value present → store updated to server value
  - server empty + local set → updateAiProfile called with local value; store unchanged
  - both empty → nothing called beyond the GET
  - GET rejects → store unchanged, no throw
- [ ] **Step 2: Implement** `profileSync.ts` + the three api client methods (GET/PATCH `/settings/ai-profile`, GET `/settings/ai-profile/suggestions`; mock branches return a null-field object). Mount `useAiProfileSync()` in `(app)/layout.tsx` (client component — follow how the layout already runs mount-time effects).
- [ ] **Step 3: Run** `npx vitest run lib/ai` then the full web suite + tsc. Green.
- [ ] **Step 4: Commit** — `feat(web): AI profile client + one-time device-to-account instructions migration`

---

### Task 7: Web — "AI Profile" settings section

**Files:**
- Modify: `apps/web/app/(app)/settings/page.tsx` — 5 edits: `Section` union at :83 gains `'ai-profile'`; a lucide icon import (`IdCard` or `UserCog`); `<NavItem … label="AI Profile" …>` placed OUTSIDE the `!AI_LOCKED` guard (:475-483); body line `{section === 'ai-profile' && <AiProfileSection />}`; new `function AiProfileSection()` modeled on `BlockedSendersSection` (fetches its own data, no props).
- Modify: `AISection` (:1295-1469) — REMOVE the custom-instructions textarea block (:1416-1434) and its draft state; the textarea moves to the new section. `setCustomInstructions` still exists in the store (profileSync writes it).
- Create: `apps/web/app/(app)/settings/ai-profile-helpers.ts` + `ai-profile-helpers.test.ts` (house pattern: logic in helpers, unit-test helpers, never mount page.tsx)

**Interfaces:**
- Consumes: `api.settings.getAiProfile/updateAiProfile/getAiProfileSuggestions` (Task 6).
- Produces (helpers): `normalizeProfileDraft(draft): UpdateAiProfilePayload` (trim, cap 80/500, `''`→omit-or-empty per PATCH semantics) and `mergeSuggestions(current, suggestions)` (fill only empty fields; never overwrite user-entered values).

**Section contents:** intro copy ("Used to personalize AI answers and drafts. Never overrides security rules."); fields jobTitle/institution/department (text inputs, maxLength 80), language select (Auto/English/French/Kinyarwanda), instructions textarea moved here verbatim (500 cap + counter, reusing `CUSTOM_INSTRUCTIONS_MAX_CHARS`); a "Suggest from directory" button that calls suggestions and applies `mergeSuggestions` to the draft (user still saves explicitly); Save button → `updateAiProfile(normalizeProfileDraft(draft))` + `setCustomInstructions(draft.instructions)` + `toast.success('AI profile saved')`.

- [ ] **Step 1: Failing helper tests** — normalize trims/caps and maps empty→`''`; mergeSuggestions fills only blanks (case: current jobTitle set + suggestion different → unchanged).
- [ ] **Step 2: Implement helpers**, then the section + the 5 page edits + the AISection textarea removal.
- [ ] **Step 3: Run** helper tests, then the FULL web suite (AISection-related tests may reference the textarea — update them to point at the new section's behavior without weakening assertions) + tsc.
- [ ] **Step 4: Commit** — `feat(web): AI Profile settings section (identity card + instructions, suggestions from directory)`

---

### Task 8: Gates, deploy, release note

- [ ] **Step 1:** Full gates: `npx jest` + tsc (apps/api); `npx vitest run` + tsc (apps/web).
- [ ] **Step 2:** Containerized builds (`scripts/build-api.sh`, `build-web-154.sh`, `build-web-155.sh`) — separate commands, never piped into a deploy.
- [ ] **Step 3:** Push; deploy both VMs with the standard swap recipe — expect exactly ONE pending migration (`add_user_ai_profiles`) on each; probes 200/401 (+ .155 TLS edge).
- [ ] **Step 4:** Append to `docs/release-notes/`: custom AI instructions now live on the account (one-time silent migration from this device's local value; other devices pick up the account value on next load).
- [ ] **Step 5:** Manual sweep list (Bruce's session): save a profile → agent answer reflects instructions; dossier does NOT leak jobTitle; suggestions button fills blanks from the directory; instructions set on desktop appear on a second browser.
- [ ] **Step 6: Commit** docs; update memory stream file.

---

## Self-review notes (applied)

- Spec coverage: P1 data/API/prompt/UI/migration → Tasks 1,3,4,6,7; P2 card/seeding/tiers → Tasks 2,4,5,7; rollout/release note → Task 8. P3 deliberately absent (own plan later).
- Type consistency: `AiProfileInput`/`ProfileTier` (Task 2) consumed in Task 4; `UpdateAiProfileDto` (Task 3) consumed by Task 5 controller edits and mirrored by Task 6's client payload; helper names in Task 7 self-contained.
- Known judgment points encoded: `getUser` avoided for DB-only endpoints; `'ai-profile'` naming (collision); NavItem outside the lock; agent identity non-duplication; meeting-prep instructions stripped; suggestions soft-fail.
