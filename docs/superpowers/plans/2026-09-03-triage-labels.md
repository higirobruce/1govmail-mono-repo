# Persistent Triage Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side background card extraction persisted in Postgres, surfaced as triage filter chips and row badges in the mail list, with the Executive Briefing consuming stored cards for near-instant runs.

**Architecture:** The card prompt/parser moves to `packages/shared` (single implementation; web re-exports at old paths). A stateless cron worker in the NestJS API classifies Inbox+Sent mail from the last 14 days that lacks a card, using stored Zimbra tokens for body hydration and the remote Ollama (`CARD_MODEL`, default `qwen3-4b-fast:latest`) for extraction. Two read-only endpoints serve labels to the list UI and full cards to the briefing.

**Tech Stack:** pnpm workspace package (tsc-built), Prisma 7 migration, NestJS `@nestjs/schedule` cron, jest (api), vitest (web), React Query.

**Spec:** `docs/superpowers/specs/2026-09-03-triage-labels-design.md`

## Global Constraints

- `CARD_MODEL` env, default `qwen3-4b-fast:latest`; extraction temperature 0, `max_tokens` 300, `response_format: {type:'json_object'}` first attempt with one retry without it; `reasoning_effort: 'none'` always sent (retry-without on 400, mirroring `AiService.upstream`).
- Constants: `CARD_BACKFILL_DAYS = 14`, `CARD_RETENTION_DAYS = 90`, `CARD_BATCH_PER_TICK = 8`, per-user max per tick `CARD_PER_USER_PER_TICK = 3`.
- Worker scope: folders with `path` `/Inbox` or `/Sent` only; users with `authToken` set AND `tokenExpiry > now()` only. Worker is read-only on mail (annotates, never sends/moves/deletes).
- Failed extraction ⇒ tombstone card (`failed: true`, empty fields); tombstones invisible to every read path; re-extracted only when the stored `model` differs from `CARD_MODEL`.
- Labels derive in this priority order: `needsDecision` (asksOfMe non-empty) → `waitingOnYou` (waitingOn set) → `deadline` (deadlines non-empty) → `fyi`.
- Web MUST keep old import paths working via re-exports; existing vitest suites must pass unmodified except where a test file explicitly moves.
- No new npm dependencies beyond dev `typescript` in packages/shared if missing.
- Run checks: web `cd apps/web && npx vitest run && npx tsc --noEmit`; api `cd apps/api && npx jest && npx tsc --noEmit`; shared `cd packages/shared && npx tsc -p tsconfig.json`.
- Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Make `packages/shared` a real, built workspace package

**Files:**
- Modify: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Modify: `apps/web/package.json`, `apps/api/package.json` (add dependency)
- Modify: `apps/web/next.config.ts` (transpilePackages not needed when consuming dist, but dev ergonomics: add it anyway — see Step 3)
- Modify: root `package.json` build script

**Interfaces:**
- Produces: importable `@email-client/shared` in both apps; `pnpm --filter @email-client/shared build` emits `dist/`.

- [ ] **Step 1: Package build setup.** Replace `packages/shared/package.json` contents with:

```json
{
  "name": "@email-client/shared",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

Create `packages/shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
```

(`DOM` in lib because the extraction module references `DOMParser`/`document` behind runtime guards — types only.)

- [ ] **Step 2: Wire dependencies.** In `apps/web/package.json` and `apps/api/package.json` dependencies add `"@email-client/shared": "workspace:*"`. Run `pnpm install` at the repo root.
- [ ] **Step 3: Next transpile + root build order.** In `apps/web/next.config.ts` add `transpilePackages: ['@email-client/shared'],` inside `nextConfig` (lets `next dev` consume package source/dist uniformly). In root `package.json`, change `"build"` to `"pnpm --filter @email-client/shared build && pnpm --filter web build && pnpm --filter api build"`.
- [ ] **Step 4: Verify.** `cd packages/shared && npx tsc -p tsconfig.json` (emits dist for the existing type files); `cd ../../apps/web && npx tsc --noEmit`; `cd ../api && npx tsc --noEmit`.
- [ ] **Step 5: Commit** `build(shared): make packages/shared a built workspace package consumed by web and api`

---

### Task 2: Move card/extraction/prompt-primitive logic into `packages/shared`

**Files:**
- Create: `packages/shared/src/ai/extract.ts` (moved from `apps/web/lib/ai/extract.ts`, verbatim)
- Create: `packages/shared/src/ai/promptCore.ts` (subset of `apps/web/lib/ai/prompt.ts`)
- Create: `packages/shared/src/ai/cards.ts`
- Modify: `packages/shared/src/index.ts` (re-export the three modules)
- Modify: `apps/web/lib/ai/extract.ts` (becomes re-export), `apps/web/lib/ai/prompt.ts` (imports primitives from shared, keeps web-only pieces), `apps/web/lib/ai/briefing.ts` (imports card bits from shared)
- Modify: `apps/web/lib/ai/briefing.test.ts` (only if an import path must change — prefer none)
- Test: `apps/web/lib/ai/labels.test.ts` (new — deriveLabel)

**Interfaces:**
- Produces (from `@email-client/shared`):

```ts
// extract: extractEmailText, htmlToText, stripQuotedReply, stripSignature, clampText (as today)
// promptCore: UNTRUSTED_CONTENT_RULE, fenceUntrusted(label, content), neutralizeMarkers(text), detectInjectionAttempt(text)
// cards:
export interface CardSource {           // the meta a card prompt needs — superset-compatible with web's BriefingSourceMessage
  id: string; conversationId: string | null; direction: 'received' | 'sent';
  fromEmail: string; fromName: string | null; subject: string | null;
  receivedAt: string; attachments: string[];
}
export interface ExtractedCard {        // identical fields to web's BriefingCard
  messageId: string; conversationId: string | null; direction: 'received' | 'sent';
  from: string; subject: string | null; receivedAt: string;
  gist: string; asksOfMe: string[]; deadlines: string[]; commitmentsIMade: string[];
  waitingOn: string | null; importance: 'high' | 'normal' | 'low';
  attachments: string[]; injectionSuspected: boolean;
}
export function buildCardPrompt(msg: CardSource, body: string): { system: string; user: string };
export function parseCardJson(raw: string, msg: CardSource, body: string): ExtractedCard | null;
export type TriageLabel = 'needsDecision' | 'waitingOnYou' | 'deadline' | 'fyi';
export function deriveLabel(card: Pick<ExtractedCard, 'asksOfMe' | 'waitingOn' | 'deadlines'>): TriageLabel;
```

- Consumes: Task 1's package wiring.

- [ ] **Step 1: Write the failing test** `apps/web/lib/ai/labels.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveLabel } from '@email-client/shared';

const base = { asksOfMe: [] as string[], waitingOn: null as string | null, deadlines: [] as string[] };

describe('deriveLabel priority order', () => {
  it('needsDecision beats everything', () => {
    expect(deriveLabel({ ...base, asksOfMe: ['approve'], waitingOn: 'x', deadlines: ['Fri'] })).toBe('needsDecision');
  });
  it('waitingOnYou beats deadline', () => {
    expect(deriveLabel({ ...base, waitingOn: 'signature', deadlines: ['Fri'] })).toBe('waitingOnYou');
  });
  it('deadline when only dated', () => {
    expect(deriveLabel({ ...base, deadlines: ['Fri'] })).toBe('deadline');
  });
  it('fyi otherwise', () => {
    expect(deriveLabel(base)).toBe('fyi');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module has no export): `cd apps/web && npx vitest run lib/ai/labels.test.ts`
- [ ] **Step 3: Move the code.**
  - `extract.ts` → `packages/shared/src/ai/extract.ts` verbatim; `apps/web/lib/ai/extract.ts` becomes `export * from '@email-client/shared/dist/ai/extract'`… **no** — re-export through the package root to keep one entry: `export { extractEmailText, htmlToText, stripQuotedReply, stripSignature, clampText, type ExtractOptions } from '@email-client/shared';`
  - From `apps/web/lib/ai/prompt.ts`, move `UNTRUSTED_CONTENT_RULE`, `fenceUntrusted`, `neutralizeMarkers`, `makeSentinel`, `normalizeLabel`, `ROLE_MARKER_LINE`, `SPECIAL_TOKEN`, `SANITIZED_MARKER`, `INJECTION_SIGNALS`, `detectInjectionAttempt` into `packages/shared/src/ai/promptCore.ts` (keep the measured-limits header comment with the moved code). `apps/web/lib/ai/prompt.ts` re-exports those names from shared and keeps everything else (language rules, scrub, custom instructions) unchanged.
  - Create `packages/shared/src/ai/cards.ts`: move `CARD_SYSTEM`, `buildCardPrompt`, `parseCardJson`, `firstJsonObject`, `missingClosers`, `repairTruncatedJson`, `parseJsonObject`, `strArr` from `apps/web/lib/ai/briefing.ts`, renaming the input type to `CardSource` and output to `ExtractedCard` (fields identical). Add:

```ts
export type TriageLabel = 'needsDecision' | 'waitingOnYou' | 'deadline' | 'fyi';

export function deriveLabel(card: Pick<ExtractedCard, 'asksOfMe' | 'waitingOn' | 'deadlines'>): TriageLabel {
  if (card.asksOfMe.length > 0) return 'needsDecision';
  if (card.waitingOn) return 'waitingOnYou';
  if (card.deadlines.length > 0) return 'deadline';
  return 'fyi';
}
```

  - `packages/shared/src/index.ts` re-exports all three modules.
  - `apps/web/lib/ai/briefing.ts`: delete the moved code; import from `@email-client/shared`; keep `export type BriefingCard = ExtractedCard` and `export type BriefingSourceMessage = CardSource & { bodyText?: string | null; bodyHtml?: string | null; snippet?: string | null }` — wait: `BriefingSourceMessage` today includes body fields; keep the existing interface but extend `CardSource` so structural compatibility holds. Re-export `buildCardPrompt`, `parseCardJson` so `briefing.test.ts` imports keep working.
- [ ] **Step 4: Build shared, run ALL web tests** — the moved code must stay covered through re-exports: `cd packages/shared && npx tsc -p tsconfig.json && cd ../../apps/web && npx vitest run && npx tsc --noEmit`. Expected: labels.test.ts passes; every pre-existing test passes without modification. If an import genuinely must change in a test file, change only the import line.
- [ ] **Step 5: Commit** `refactor(shared): move card extraction, prompt primitives, and label derivation into packages/shared`

---

### Task 3: `MessageCard` Prisma model + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: migration via `npx prisma migrate dev --name add_message_cards`

**Interfaces:**
- Produces: `prisma.messageCard` with the spec's schema (including `failed Boolean @default(false)`), relations on `Message` (`card MessageCard?`) and `User` (`messageCards MessageCard[]`).

- [ ] **Step 1: Add the model** exactly as in the spec §2 (plus back-relations). `direction`, `from`, `subject`, `receivedAt` are NOT duplicated — they live on `Message`.
- [ ] **Step 2: Generate migration:** `cd apps/api && npx prisma migrate dev --name add_message_cards` (local dev DB), then `npx prisma generate`.
- [ ] **Step 3: Verify:** `npx tsc --noEmit && npx jest` (all existing suites green).
- [ ] **Step 4: Commit** schema + migration folder: `feat(api): MessageCard table for persisted triage cards`

---

### Task 4: Ollama card-extraction client in the API

**Files:**
- Create: `apps/api/src/mail/card-extractor.service.ts`
- Test: `apps/api/src/mail/card-extractor.service.spec.ts`

**Interfaces:**
- Consumes: `@email-client/shared` (`buildCardPrompt`, `parseCardJson`, `extractEmailText`, `CardSource`, `ExtractedCard`).
- Produces:

```ts
@Injectable()
export class CardExtractorService {
  readonly model = process.env.CARD_MODEL ?? 'qwen3-4b-fast:latest';
  /** null = unparseable after retry (caller writes a tombstone). Throws only on network failure. */
  async extract(msg: CardSource, bodyText: string | null, bodyHtml: string | null): Promise<ExtractedCard | null>;
}
```

- [ ] **Step 1: Write failing tests** (mock `global.fetch`, mirroring `ai.service.spec.ts`'s pattern):

```ts
import { CardExtractorService } from './card-extractor.service';

const MSG = {
  id: 'm1', conversationId: null, direction: 'received' as const,
  fromEmail: 'a@risa.gov.rw', fromName: 'A', subject: 'Budget',
  receivedAt: '2026-09-03T08:00:00Z', attachments: [],
};
const CARD_JSON = JSON.stringify({ choices: [{ message: { content: '{"gist":"g","asksOfMe":["approve"],"importance":"high"}' } }] });

describe('CardExtractorService', () => {
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;
  beforeEach(() => { fetchMock = jest.fn(); global.fetch = fetchMock as unknown as typeof fetch; });
  afterAll(() => { global.fetch = realFetch; });

  it('sends reasoning_effort none, json mode, temperature 0, max_tokens 300, CARD_MODEL', async () => {
    fetchMock.mockResolvedValue(new Response(CARD_JSON, { status: 200 }));
    const svc = new CardExtractorService();
    const card = await svc.extract(MSG, 'Please approve the budget by Friday.', null);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      model: svc.model, temperature: 0, max_tokens: 300,
      reasoning_effort: 'none', response_format: { type: 'json_object' },
    });
    expect(card?.asksOfMe).toEqual(['approve']);
  });

  it('retries without response_format on 400, then without json instructions parses fallback output', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('bad param', { status: 400 }))
      .mockResolvedValueOnce(new Response(CARD_JSON, { status: 200 }));
    const card = await new CardExtractorService().extract(MSG, 'body text here', null);
    expect(card).not.toBeNull();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).response_format).toBeUndefined();
  });

  it('returns null when both attempts yield garbage', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 }));
    expect(await new CardExtractorService().extract(MSG, 'body text here', null)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null for an empty body without calling the model', async () => {
    expect(await new CardExtractorService().extract(MSG, null, null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `cd apps/api && npx jest src/mail/card-extractor.service.spec.ts`
- [ ] **Step 3: Implement.** Structure:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { buildCardPrompt, parseCardJson, extractEmailText, type CardSource, type ExtractedCard } from '@email-client/shared';

@Injectable()
export class CardExtractorService {
  private readonly logger = new Logger(CardExtractorService.name);
  private readonly baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  readonly model = process.env.CARD_MODEL ?? 'qwen3-4b-fast:latest';

  async extract(msg: CardSource, bodyText: string | null, bodyHtml: string | null): Promise<ExtractedCard | null> {
    const body = extractEmailText({ bodyText, bodyHtml }, { maxChars: 3000 });
    if (!body) return null;
    const { system, user } = buildCardPrompt(msg, body);
    const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
    for (const withJson of [true, false]) {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model, messages, temperature: 0, max_tokens: 300,
          reasoning_effort: 'none',
          ...(withJson ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      if (res.status === 400 && withJson) continue;             // backend rejected json mode — retry bare
      if (!res.ok) throw new Error(`Ollama ${res.status}`);      // network/backend failure — caller retries next tick
      const json = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
      const card = parseCardJson(json?.choices?.[0]?.message?.content ?? '', msg, body);
      if (card) return card;
    }
    return null;
  }
}
```

- [ ] **Step 4: Run — expect PASS**: `npx jest src/mail/card-extractor.service.spec.ts && npx tsc --noEmit`
- [ ] **Step 5: Commit** `feat(api): card extractor service calling Ollama with the shared card prompt`

---

### Task 5: `CardWorkerService` — selection, hydration, upsert, tombstones, purge, cron

**Files:**
- Create: `apps/api/src/mail/card-worker.service.ts`
- Modify: `apps/api/src/mail/mail.module.ts` (provide CardExtractorService + CardWorkerService)
- Test: `apps/api/src/mail/card-worker.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (as other services do — check `apps/api/src/prisma/prisma.service.ts` injection idiom), `MailService.getMessage(userId, messageId)` (hydrates+caches bodies), `CardExtractorService.extract(...)`, `deriveLabel` not needed here.
- Produces: `@Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true }) tick()` and a testable `processTick(): Promise<{ classified: number; failed: number; purged: number }>`.

- [ ] **Step 1: Write failing tests** with mocked prisma/mailService/extractor (constructor-inject plain objects):

```ts
// Selection & fairness
it('selects only inbox/sent messages within 14 days lacking a card, for valid-token users, capped per user', ...)
// - prisma.message.findMany asserted to receive a where containing:
//   folder: { path: { in: ['/Inbox', '/Sent'] } }, receivedAt: { gte: <14d cutoff> },
//   card: null, user: { authToken: { not: null }, tokenExpiry: { gt: <now> } }
// - with two users each having 5 pending messages and CARD_PER_USER_PER_TICK=3, batch of 8
//   processes 3 of user A + 3 of user B (round-robin fairness), not 5+3.

// Happy path
it('hydrates bodies via mailService.getMessage and upserts a card', ...)
// extractor returns a card → prisma.messageCard.upsert called with messageId unique key,
// fields mapped, failed: false.

// Tombstone
it('writes a failed tombstone when extraction returns null', ...)
// extractor resolves null → upsert with failed: true, gist ''.

// Network failure skips (no tombstone)
it('leaves the message unclassified when the extractor throws', ...)
// extractor rejects → no upsert for that message; tick continues with the rest; failure counted in log summary.

// Purge
it('purges cards whose message is older than 90 days', ...)
// prisma.messageCard.deleteMany with message: { receivedAt: { lt: <90d cutoff> } }.

// Model change re-extraction
it('re-selects messages whose card model differs from CARD_MODEL', ...)
// where clause includes OR: [{ card: null }, { card: { model: { not: svc.model }, /* tombstones included */ } }]
```

Write these as real jest tests with `jest.fn()` fakes asserting the calls above; keep the where-clause assertions with `expect.objectContaining`.

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Key logic (adapt to the actual PrismaService injection idiom found in the module):

```ts
const CARD_BACKFILL_DAYS = 14;
const CARD_RETENTION_DAYS = 90;
const CARD_BATCH_PER_TICK = 8;
const CARD_PER_USER_PER_TICK = 3;

async processTick() {
  const cutoff = new Date(Date.now() - CARD_BACKFILL_DAYS * 86_400_000);
  const candidates = await this.prisma.message.findMany({
    where: {
      receivedAt: { gte: cutoff },
      folder: { path: { in: ['/Inbox', '/Sent'] } },
      user: { authToken: { not: null }, tokenExpiry: { gt: new Date() } },
      OR: [{ card: null }, { card: { model: { not: this.extractor.model } } }],
    },
    orderBy: { receivedAt: 'desc' },
    take: CARD_BATCH_PER_TICK * 4,               // headroom for fairness trimming
    select: { id: true, userId: true, conversationId: true, subject: true, fromEmail: true,
              fromName: true, receivedAt: true, attachments: true, folder: { select: { path: true } } },
  });
  // round-robin: group by userId, take up to CARD_PER_USER_PER_TICK each, flatten, cap at CARD_BATCH_PER_TICK
  ...
  for (const m of batch) {
    try {
      const full = await this.mailService.getMessage(m.userId, m.id);   // hydrates + caches body
      const source: CardSource = { id: m.id, conversationId: m.conversationId,
        direction: m.folder.path === '/Sent' ? 'sent' : 'received',
        fromEmail: m.fromEmail, fromName: m.fromName, subject: m.subject,
        receivedAt: m.receivedAt.toISOString(),
        attachments: formatAttachmentsFromJson(m.attachments) };
      const card = await this.extractor.extract(source, full?.bodyText ?? null, full?.bodyHtml ?? null);
      await this.prisma.messageCard.upsert({
        where: { messageId: m.id },
        create: cardRow(m, card, this.extractor.model),
        update: cardRow(m, card, this.extractor.model),
      });
      card ? classified++ : failed++;
    } catch { skipped++; /* stays selectable; retried next tick */ }
  }
  const { count: purged } = await this.prisma.messageCard.deleteMany({
    where: { message: { receivedAt: { lt: new Date(Date.now() - CARD_RETENTION_DAYS * 86_400_000) } } },
  });
  if (classified || failed || purged || skipped) this.logger.log(`cards: +${classified} tombstoned ${failed} purged ${purged} skipped ${skipped}`);
  return { classified, failed, purged };
}
```

`cardRow` maps ExtractedCard → columns (tombstone when card is null: `failed: true`, `gist: ''`, arrays `[]`, importance `'normal'`, injectionSuspected false). `formatAttachmentsFromJson` reuses shared's attachment formatting (export `formatAttachments` from shared in Task 2 if not already — it exists in web's briefing.ts today; move it with the cards module).
Register both services as providers in `mail.module.ts`; add the `@Cron` method calling `processTick()` in a try/catch that logs (idiom of `mail.scheduler.ts`).

- [ ] **Step 4: Run — expect PASS**: `npx jest src/mail && npx tsc --noEmit`
- [ ] **Step 5: Commit** `feat(api): stateless card worker — classify, tombstone, purge on a minute cron`

---

### Task 6: Card read endpoints

**Files:**
- Modify: `apps/api/src/mail/mail.controller.ts`, `apps/api/src/mail/mail.service.ts`
- Test: `apps/api/src/mail/mail.service.spec.ts` (append)

**Interfaces:**
- Produces:
  - `GET /mail/cards?ids=a,b,c` → `{ cards: Record<string, { label: TriageLabel; importance: string; injectionSuspected: boolean }> }` — user-scoped, ≤100 ids, tombstones and other users' cards omitted.
  - `GET /mail/cards/window?window=today|24h|week` → `{ cards: ExtractedCard[] }` — full non-tombstone cards for the user's Inbox+Sent within the window (cap 50, newest first), each card assembled from the row + its message (from/subject/receivedAt/direction).
- Consumes: `deriveLabel` from shared.

- [ ] **Step 1: Failing tests** (mail.service.spec.ts uses mocked prisma per its existing pattern — follow it): scoping (ids belonging to another user return nothing), tombstone exclusion, 100-id cap (401st… >100 ids → BadRequest), window mapping (today/24h/week → correct `gte`), cap 50.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** service methods `getCardsByIds(userId, ids)` and `getWindowCards(userId, window)` + controller routes (JwtAuthGuard is controller-wide already — verify, else add). Window cutoffs: today = local midnight UTC-approximated server-side is fine (`new Date().setHours(0,0,0,0)`), 24h/7d arithmetic as in shared `windowStart` — import it if exported, else inline.
- [ ] **Step 4: PASS + tsc.**
- [ ] **Step 5: Commit** `feat(api): batch card labels and window cards endpoints`

---

### Task 7: Mail-list chips + badges (web)

**Files:**
- Modify: `apps/web/lib/api.ts` (mail namespace: `getCards(ids: string[])`, `getWindowCards(window)`)
- Modify: `apps/web/components/mail/MailList.tsx` (row badge)
- Modify: `apps/web/app/(app)/mail/page.tsx` (chips row, cards query, filter state)
- Test: `apps/web/lib/ai/labels.test.ts` (already covers derivation; UI verified by typecheck/lint/manual per the repo's no-component-test ruling)

**Interfaces:**
- Consumes: Task 6 endpoints; `TriageLabel` from shared.
- Produces: chips *Needs decision · Waiting on you · Deadline* with counts over the loaded messages; clicking toggles a client-side filter of the current list; badges (colored dot + 11px label) on classified rows; ⚠ marker when `injectionSuspected`.

- [ ] **Step 1: API client methods** — follow the existing `api.mail` idiom (note `getCards` posts nothing; ids joined with commas, URL-encoded).
- [ ] **Step 2: Cards query in page.tsx** — a React Query keyed `['cards', activeFolderId, pageIds]` fetching labels for currently loaded message ids whenever the messages query settles (batch ≤100; chunk if more loaded). Store as `Record<messageId, {label, importance, injectionSuspected}>`.
- [ ] **Step 3: Chips row** — render above `<MailList …>` (near the existing tag-filter mechanism — page.tsx already has a "rows whose tags intersect" filter around line ~132; REUSE that filtering pathway if it fits, adding label filtering alongside rather than inventing a parallel one — read it first). Chips show `label (count)`; active chip = accent style; clicking toggles; only one active at a time; FYI has no chip.
- [ ] **Step 4: Row badge in MailList.tsx** — accept an optional `cardsById` prop; render a small dot + label text next to the row's date/snippet area for classified rows, amber ⚠ icon when injectionSuspected. Keep to the list's existing text sizes (11–12px) and don't shift row height.
- [ ] **Step 5: Verify** `npx tsc --noEmit && npx eslint components/mail/MailList.tsx 'app/(app)/mail/page.tsx' lib/api.ts && npx vitest run` (pre-existing eslint `any` errors in page.tsx/MailList are acceptable if not introduced by this diff — note them).
- [ ] **Step 6: Commit** `feat(mail): triage label chips and row badges from persisted cards`

---

### Task 8: Briefing fast path

**Files:**
- Modify: `apps/web/lib/ai/briefing.ts` (`generateBriefing` consumes stored window cards first)
- Modify: `apps/web/lib/ai/briefing.test.ts`

**Interfaces:**
- Consumes: `deps.mail` gains optional `getWindowCards?(window: BriefingWindow): Promise<{ cards: ExtractedCard[] }>` on `BriefingMailApi` (optional → old fakes keep working).
- Produces: unchanged `BriefingResult`; behavior: messages whose id has a stored card skip hydrate+extract; stragglers use the existing client-side path with the user's selected model; stored cards count toward `coveredCount`.

- [ ] **Step 1: Failing tests**: (a) with `getWindowCards` returning cards for 2 of 3 selected messages, only 1 card-extraction chat call is made (plus 1 reduce); (b) stored cards appear in the reduce input; (c) a deps.mail without `getWindowCards` behaves exactly as today (regression guard — reuse an existing test's fake unchanged and assert unchanged call count).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement**: after `selectWindowMessages`, `const stored = new Map((await deps.mail.getWindowCards?.(window))?.cards.map(c => [c.messageId, c]) ?? [])`; wrap in try/catch (endpoint failure degrades to full client-side path). Hydrate+map only messages not in `stored`; merge stored + fresh cards for the reduce; local card cache still applies to fresh ones.
- [ ] **Step 4: PASS** full `npx vitest run lib/ai && npx tsc --noEmit`.
- [ ] **Step 5: Wire the real client** in `BriefingPanel.tsx`'s deps (`mail: api.mail` — ensure `api.mail.getWindowCards` from Task 7 matches the optional signature).
- [ ] **Step 6: Commit** `feat(ai): briefing consumes persisted cards — near-instant repeat briefs`

---

### Task 9: Model spot-check script + full verification

**Files:**
- Create: `scripts/card-model-spotcheck.mjs`
- Test: none (operational tooling; run at deploy time)

- [ ] **Step 1: Write the script** — plain Node, no deps: reads `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434/v1`) and two model names from argv (`node scripts/card-model-spotcheck.mjs qwen3-4b-fast:latest qwen3-30b-16k:latest`), runs 6 built-in sample emails (EN/FR mixed: a decision request, a deadline, a commitment in a sent mail, an FYI newsletter, an injection attempt, an empty-ish body) through the same card prompt (import from `packages/shared/dist` — require the built package), prints a side-by-side table of extracted fields per model plus latency, and exits 0. Purpose: a deploy-time judgment aid, not a test.
- [ ] **Step 2: Run it against a reachable Ollama if one exists in the environment; otherwise verify it fails gracefully with a clear "backend unreachable" message.**
- [ ] **Step 3: Full verification:** `cd packages/shared && npx tsc -p tsconfig.json`; `cd apps/web && npx vitest run && npx tsc --noEmit`; `cd apps/api && npx jest && npx tsc --noEmit`.
- [ ] **Step 4: Commit** `chore(ai): card model spot-check script + phase 2 verification`

**Post-deploy manual E2E (user/controller, on the VM):** run the spot-check against 192.168.100.2 and eyeball 4B card quality; watch the worker log drain a mailbox; chips filter correctly; ⚠ badge appears on an injection mail without opening it; second briefing of the day completes in seconds; a user with an expired token is skipped without errors. Deployment notes: `CARD_MODEL=qwen3-4b-fast:latest` in `/opt/govmail/api.env`; `prisma migrate deploy` for the new table; the container build script gains `pnpm --filter @email-client/shared build` before the app builds.

---

## Self-review notes

- Spec coverage: shared module (T1–T2), MessageCard + tombstone (T3, T5), worker selection/fairness/hydration/purge/cron (T5), extractor with model/env/format contract (T4), endpoints + scoping (T6), chips/badges UI (T7), briefing fast path (T8), 4B-vs-30B spot-check (T9), retention (T5), security posture unchanged (shared fencing moves intact in T2). Out-of-scope list respected — no Zimbra write-back, no custom labels.
- Type consistency: `CardSource`/`ExtractedCard`/`TriageLabel`/`deriveLabel` names used identically in T2, T4, T5, T6, T7, T8. `extractor.model` referenced by T5's re-extraction clause matches T4's public field.
- Fixed during review: an earlier draft of T2 Step 3 flirted with deep-path re-exports (`@email-client/shared/dist/ai/extract`) — all consumer imports go through the package root only.
- Known judgment point for the executor: T5's round-robin trimming and `cardRow` mapping are specified in prose+skeleton rather than full code — the reviewer should check fairness and tombstone mapping explicitly.
