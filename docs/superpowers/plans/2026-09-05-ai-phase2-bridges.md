# AI Phase 2 — Bridges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect mail to docs and calendar: one-click draft-a-document from an email thread, AI-prefilled events from dropped mail, natural-language event creation, and a minutes formatter in the docs editor.

**Architecture:** All AI orchestration stays client-side in `apps/web/lib/ai/` (phase-1 pattern): JSON-mode parses with hard validation and non-throwing fallbacks for form fields; markdown → `markdownToHtml` (escape-first + DOMPurify) → TipTap `generateJSON` for doc content. No API schema changes, no migrations. UI pages stay thin; every parse/merge/assembly lives in a unit-tested lib seam.

**Tech Stack:** Next.js 16 app router, TipTap v3.20 (`@tiptap/core` `generateJSON`), vitest + Testing Library, existing `AIClient` (`POST /ai/chat`), guardrails from `lib/ai/prompt.ts`, shared `parseJsonObject`.

**Spec:** `docs/superpowers/specs/2026-09-05-ai-phase2-bridges-design.md` — read it first; the invariants section binds every task.

## Global Constraints

- Model output NEVER becomes raw HTML or raw editor JSON: docs content only via `markdownToHtml` → `generateJSON`; form fields only via validated plain strings.
- Every prompt: `UNTRUSTED_CONTENT_RULE` + `fenceUntrusted(...)`; every completion: `scrubOutput(...)` (all from `lib/ai/prompt.ts`).
- Every AI call takes an `AbortSignal`; UI aborts on unmount/close/re-trigger; one in-flight call per surface.
- Respect `useAIStore` enabled/model and `lib/ai/config.ts` lock. When AI is off/unreachable, every surface degrades to today's behavior — never blocks.
- Never `setContent` on a collab doc — ranged `insertContentAt` only, ranges clamped to `doc.content.size`.
- No AI action auto-sends: events save (invites go out) only on the user's Save; docs are created only after generation fully succeeds.
- Never re-render markdown per stream tick (page-freeze bug): plain-text preview while streaming, `markdownToHtml` once on completion.
- All commits on `ft-hyperscale`, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Run commands from `apps/web` unless stated. Suite must stay green: `npx vitest run` (289 tests pre-plan) and `npx tsc --noEmit`.

---

### Task 1: Extract doc templates into a data module

**Files:**
- Create: `apps/web/lib/docs/templates.ts`
- Modify: `apps/web/components/docs/TemplatePickerDialog.tsx` (remove inlined data, import instead)
- Test: `apps/web/lib/docs/templates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface Template { id: string; name: string; description: string; emoji: string; category: string; sections: string[]; content: object }`, `export const TEMPLATES: Template[]` (all 18, `blank` included), `export const CATEGORIES: string[]`, and the builder helpers (`T`, `B`, `P`, `H`, `HR`, `BL`, `OL`, `TH`, `TR`, `TABLE`) — moved verbatim from `TemplatePickerDialog.tsx` (helpers at lines ~25–35, templates array below them, `CATEGORIES` at ~line 662). Task 7 reads `TEMPLATES` from here.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/lib/docs/templates.test.ts
import { describe, it, expect } from 'vitest';
import { TEMPLATES, CATEGORIES } from './templates';

describe('doc templates', () => {
  it('exposes all 18 templates with the fields the AI catalog needs', () => {
    expect(TEMPLATES).toHaveLength(18);
    for (const t of TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(Array.isArray(t.sections)).toBe(true);
      expect(t.content).toMatchObject({ type: 'doc' });
    }
    expect(TEMPLATES.map((t) => t.id)).toContain('memo');
    expect(TEMPLATES.map((t) => t.id)).toContain('minutes');
    expect(TEMPLATES.map((t) => t.id)).toContain('blank');
  });

  it('derives categories', () => {
    expect(CATEGORIES.length).toBeGreaterThan(2);
  });
});
```

- [ ] **Step 2: Run it — must fail (module not found)**

Run: `npx vitest run lib/docs/templates.test.ts`

- [ ] **Step 3: Create `lib/docs/templates.ts` by MOVING (not rewriting) the `Template` interface, builder helpers, the templates array, and `CATEGORIES` out of `TemplatePickerDialog.tsx`.** Export everything listed under Produces. This is a pure relocation — do not edit template content. Then in `TemplatePickerDialog.tsx` delete the moved code and `import { TEMPLATES, CATEGORIES, type Template } from '@/lib/docs/templates'` (match the repo's alias style — check an existing import). Keep `UserTemplate` and all component code in the dialog file.

- [ ] **Step 4: Verify**

Run: `npx vitest run lib/docs/templates.test.ts` → PASS, then `npx tsc --noEmit` and `npx vitest run` → all green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/docs/templates.ts apps/web/lib/docs/templates.test.ts apps/web/components/docs/TemplatePickerDialog.tsx
git commit -m "refactor(docs): extract template definitions to lib/docs/templates"
```

---

### Task 2: `lib/ai/eventParse.ts` — shared event parser

**Files:**
- Create: `apps/web/lib/ai/eventParse.ts`
- Test: `apps/web/lib/ai/eventParse.test.ts`

**Interfaces:**
- Consumes: `AIClient` (`lib/ai/client.ts` — `chat(opts): Promise<string>` with `responseFormat: 'json'`), `parseJsonObject` (`@email-client/shared`, see `lib/ai/taskParse.ts` for the import), `UNTRUSTED_CONTENT_RULE`, `fenceUntrusted` (`lib/ai/prompt.ts`), `extractEmailText` (`lib/ai/extract.ts`).
- Produces (Tasks 4–5 rely on these exactly):

```ts
export interface ParsedEvent {
  title: string;
  startAt: string | null;   // "yyyy-MM-dd'T'HH:mm" LOCAL, matches DateTimePicker
  endAt: string | null;
  allDay: boolean;
  location: string | null;
  attendees: string[];      // lowercased emails, deduped, max 10
}
export interface EventParseOptions { model: string; now?: Date; signal?: AbortSignal }
export async function parseEventFromEmail(
  client: AIClient,
  email: { subject: string; from: string; bodyText?: string | null; bodyHtml?: string | null },
  opts: EventParseOptions
): Promise<ParsedEvent | null>;      // null = nothing parseable; NEVER throws
export async function parseEventInput(
  client: AIClient, input: string, opts: EventParseOptions
): Promise<ParsedEvent>;             // total failure → { title: input.trim(), startAt: null, endAt: null, allDay: false, location: null, attendees: [] }; NEVER throws
```

- [ ] **Step 1: Write the failing tests.** Mirror `taskParse.test.ts`'s mock-client style (a fake `AIClient` whose `chat` resolves canned JSON). Cover at minimum:

```ts
// apps/web/lib/ai/eventParse.test.ts — shapes, not exhaustive listing
const NOW = new Date('2026-09-05T08:00:00');  // a Saturday, local

it('parses a full result and normalizes attendees', async () => {
  const client = mockClient('{"title":"Steering committee","startAt":"2026-09-08T10:00","endAt":"2026-09-08T11:00","allDay":false,"location":"Boardroom","attendees":["Erick@risa.gov.rw","erick@risa.gov.rw","tricia@risa.gov.rw"]}');
  const r = await parseEventInput(client, 'Steering committee Tuesday 10-11', { model: 'm', now: NOW });
  expect(r.attendees).toEqual(['erick@risa.gov.rw', 'tricia@risa.gov.rw']);
  expect(r.startAt).toBe('2026-09-08T10:00');
});
it('corrects endAt <= startAt to start + 1h', ...);
it('date with no time defaults to 09:00-10:00', ...);           // model returns startAt "2026-09-08" (date only)
it('drops attendee strings without @', ...);                    // ["Erick", "a@b.rw"] → ["a@b.rw"]
it('caps attendees at 10', ...);
it('salvages JSON wrapped in prose', ...);                      // "Sure! {\"title\":...}" via parseJsonObject
it('parseEventInput falls back to raw input as title on garbage', async () => {
  const client = mockClient('not json at all');
  const r = await parseEventInput(client, 'lunch with Yves', { model: 'm', now: NOW });
  expect(r).toEqual({ title: 'lunch with Yves', startAt: null, endAt: null, allDay: false, location: null, attendees: [] });
});
it('parseEventFromEmail returns null on garbage', ...);
it('parseEventFromEmail returns null when client.chat rejects', ...);   // network error → null, no throw
it('empty title from model falls back (subject / raw input)', ...);
```

- [ ] **Step 2: Run — must fail.** `npx vitest run lib/ai/eventParse.test.ts`

- [ ] **Step 3: Implement.** Structure (follow `taskParse.ts` closely):
  - System prompt: `UNTRUSTED_CONTENT_RULE`, then: you extract calendar-event fields from text; output ONLY a JSON object `{"title","startAt","endAt","allDay","location","attendees"}`; datetimes as `YYYY-MM-DDTHH:MM` in the user's local time; resolve relative dates against the provided current date; `attendees` must contain only email addresses that literally appear in the text — never invent or guess addresses; use `null` for anything absent.
  - User prompt: `Current date/time: ${format(now ?? new Date(), "EEEE yyyy-MM-dd'T'HH:mm")}` + the fenced content — `fenceUntrusted('EMAIL', ...)` for the email path (subject + from + `extractEmailText({bodyText, bodyHtml}, { maxChars: 3000 })`), `fenceUntrusted('USER TEXT', input)` for the NL path.
  - `client.chat({ model, messages, temperature: 0.1, maxTokens: 300, responseFormat: 'json', signal })`, wrap the whole call+parse in try/catch.
  - Shared `validate(raw, fallbackTitle, now): ParsedEvent | null` doing: title `String(...).trim()` else fallbackTitle else null-result; date fields must match `/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/` and `new Date(...)` must be valid, else null; date-only startAt → `T09:00` and endAt `T10:00` unless model set `allDay: true`; if both times set and `endAt <= startAt` → endAt = startAt + 1h (use `date-fns` `addHours`/`format`, already a dependency — see calendar page imports); attendees `filter(s => typeof s === 'string' && s.includes('@')).map(lowercase+trim)`, dedupe via Set, `slice(0, 10)`; location trimmed string or null.

- [ ] **Step 4: Verify.** `npx vitest run lib/ai/eventParse.test.ts` → PASS; `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/eventParse.ts apps/web/lib/ai/eventParse.test.ts
git commit -m "feat(ai): shared event parser (email + natural language) with hard validation"
```

---

### Task 3: `mergeParsedEvent` — dirty-field-safe prefill merge

**Files:**
- Create: `apps/web/lib/calendar/eventPrefill.ts`
- Test: `apps/web/lib/calendar/eventPrefill.test.ts`

**Interfaces:**
- Consumes: `ParsedEvent` from Task 2.
- Produces (Task 4 relies on these exactly):

```ts
export type EventFieldKey = 'title' | 'startAt' | 'endAt' | 'allDay' | 'location' | 'attendees';
export interface EventFormValues {
  title: string; startAt: string; endAt: string;   // "yyyy-MM-dd'T'HH:mm" local strings ('' = unset)
  allDay: boolean; location: string; attendees: string[];
}
export function mergeParsedEvent(
  current: EventFormValues, parsed: ParsedEvent, dirty: ReadonlySet<EventFieldKey>
): EventFormValues;
```

Rules: a dirty field is never changed; a clean field is set only when `parsed` has a non-null/non-empty value for it; `attendees` merge = union (parsed appended, existing kept, deduped case-insensitively) and only when `attendees` is clean; `allDay` applies only when clean AND parsed.allDay is true (never un-sets a user's choice); returns a new object, never mutates.

- [ ] **Step 1: Write the failing tests** — dirty title survives; clean fields fill; null parsed values leave fields alone; attendee union dedupes `A@x.rw` vs `a@x.rw`; dirty attendees untouched; input object not mutated.

- [ ] **Step 2: Run — must fail.** `npx vitest run lib/calendar/eventPrefill.test.ts`

- [ ] **Step 3: Implement** — a single pure function, ~30 lines, no imports beyond the types.

- [ ] **Step 4: Verify** — test PASS, `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/calendar/eventPrefill.ts apps/web/lib/calendar/eventPrefill.test.ts
git commit -m "feat(calendar): pure dirty-field-safe merge for AI event prefill"
```

---

### Task 4: Smart event from mail — modal live-fill + entry paths keep the message id

**Files:**
- Modify: `apps/web/app/(app)/calendar/page.tsx` (`CreateEventModal` ~line 307, `handleMailDrop` ~1928, sessionStorage consumer ~1860–1873, `?createFromEmail` consumer ~1830–1840, `dragPrefill` state in `CalendarPage`)
- Modify: `apps/web/lib/api.ts` (calendar `createEvent`/`updateEvent` payload types, lines 124–199)
- Test: `apps/web/lib/calendar/eventPrefill.test.ts` already covers the merge; this task is wiring + a pure payload helper test in `apps/web/lib/calendar/dropPrefill.test.ts`
- Create: `apps/web/lib/calendar/dropPrefill.ts`

**Interfaces:**
- Consumes: `parseEventFromEmail`, `ParsedEvent` (Task 2); `mergeParsedEvent`, `EventFormValues`, `EventFieldKey` (Task 3); `api.mail.getMessage(id)` (returns record with `subject`, `fromEmail`, `fromName`, `bodyText`, `bodyHtml`); `AIWorkingIndicator` (`components/ai/AIWorkingIndicator.tsx`, prop `step?: string`); `useAIStore` (enabled/model — see how `ThreadView.tsx` reads it); `AIClient`.
- Produces: `CreateEventModal`'s `prefillData` prop widened to

```ts
prefillData?: {
  title?: string; description?: string;
  startAt?: string; endAt?: string; allDay?: boolean;      // "yyyy-MM-dd'T'HH:mm" local
  location?: string; attendees?: string[];
  linkedMessageId?: string; linkedSubject?: string;
  aiFillMessageId?: string;                                 // triggers the live fill
}
```

and `dropPrefill.ts`:

```ts
export interface MailDragPayload { id: string; subject: string; snippet: string; from: string }
export function parseMailDragPayload(raw: string): MailDragPayload | null;   // JSON.parse + shape check, null on garbage
export function dropPrefillFromPayload(p: MailDragPayload): { title: string; description: string; linkedMessageId: string; linkedSubject: string; aiFillMessageId: string };
```

Task 5 reuses the widened `prefillData`.

- [ ] **Step 1: Write failing tests for `dropPrefill.ts`** — valid payload maps subject→title, `From: {from}\n\n{snippet}`→description, id→`linkedMessageId` AND `aiFillMessageId`; garbage/missing-id raw → null.

- [ ] **Step 2: Run — must fail**, then implement `dropPrefill.ts`, run → PASS.

- [ ] **Step 3: Wire the three entry paths in `calendar/page.tsx`:**
  - `handleMailDrop` (~1928) and the sessionStorage consumer (~1860): replace the inline lossy mapping with `parseMailDragPayload` + `dropPrefillFromPayload` → `setDragPrefill(...)`. This fixes the dropped `linkedMessageId` on both paths.
  - `?createFromEmail` consumer (~1830): add `aiFillMessageId: id` next to the `linkedMessageId` it already sets.

- [ ] **Step 4: Live fill inside `CreateEventModal`:**
  - Refactor the six field states into one `EventFormValues` object OR keep them and add `const dirtyRef = useRef<Set<EventFieldKey>>(new Set())` marked in each field's onChange — choose whichever needs the smallest diff (the modal is large; prefer the ref + existing states).
  - New effect: if `prefillData?.aiFillMessageId` and AI enabled → `setAiFilling(true)`; `api.mail.getMessage(id)` → `parseEventFromEmail(client, { subject, from: fromName ? \`${fromName} <${fromEmail}>\` : fromEmail, bodyText, bodyHtml }, { model, signal })`; on non-null result, build `EventFormValues` from current states, `mergeParsedEvent(current, parsed, dirtyRef.current)`, write back only changed fields. `finally setAiFilling(false)`. AbortController in a ref, aborted on unmount and on Save. Errors → `console.warn`, nothing else.
  - Render `{aiFilling && <AIWorkingIndicator step="Reading the email" />}` near the modal title.
  - Apply `prefillData.startAt/endAt/allDay/location/attendees` to the initial state (new — today only title/description exist).
- Fix `lib/api.ts` calendar `createEvent`/`updateEvent` param types: add `linkedMessageId?: string; linkedSubject?: string`.

- [ ] **Step 5: Verify.** `npx tsc --noEmit`; `npx vitest run` all green. Manual (dev server, mail + calendar): drag a mail onto the calendar grid → modal opens instantly with subject/description, indicator shows, parsed time/location/attendees appear; type a title mid-parse → it survives; save → event has `linkedMessageId` (check network payload). Repeat once via sidebar-drop and once via right-click → Create event.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/\(app\)/calendar/page.tsx apps/web/lib/api.ts apps/web/lib/calendar/dropPrefill.ts apps/web/lib/calendar/dropPrefill.test.ts
git commit -m "feat(calendar): AI live-fill for events created from mail; keep linkedMessageId on drag paths"
```

---

### Task 5: Natural-language event quick-add

**Files:**
- Create: `apps/web/lib/calendar/quickAddEvent.ts`
- Test: `apps/web/lib/calendar/quickAddEvent.test.ts`
- Modify: `apps/web/app/(app)/calendar/page.tsx` (toolbar in `CalendarPage`, ~line 1758 onward)

**Interfaces:**
- Consumes: `parseEventInput`, `ParsedEvent` (Task 2); widened `prefillData` (Task 4); `AIClient`; `AIWorkingIndicator`; `useAIStore`.
- Produces:

```ts
export interface QuickAddEventDeps { enabled: boolean; model: string; client: AIClient; now?: Date; signal?: AbortSignal }
export async function quickAddEventPrefill(input: string, deps: QuickAddEventDeps): Promise<{
  title: string; startAt?: string; endAt?: string; allDay?: boolean; location?: string; attendees?: string[];
}>;   // AI off → { title: input.trim() }; AI on → ParsedEvent mapped, null/empty fields omitted; NEVER throws; throws AbortError only if deps.signal aborted after parse (mirror lib/tasks/quickAdd.ts)
```

- [ ] **Step 1: Write failing tests** (mirror `lib/tasks/quickAdd.test.ts`): AI off → title only; AI on → mapped fields present, nulls omitted; abort after parse throws AbortError; parse fallback (garbage) → title = raw input.

- [ ] **Step 2: Run — must fail**, implement (thin wrapper over `parseEventInput`), run → PASS.

- [ ] **Step 3: Toolbar wiring in `CalendarPage`:** a `<form>` with `<Input value={quickAdd}>` placeholder `Try "Steering committee Tuesday 10–11 with Erick and Tricia"`, submit → abort any prior controller (ref), `quickAddEventPrefill` → `setDragPrefill(result)` + `setShowCreate(true)`. `{quickAdding && aiEnabled && <AIWorkingIndicator step="Parsing your event" />}`. Clear the input in the modal's `onCreated` callback, NOT when the modal opens (cancel keeps the text). Copy layout/idiom from `tasks/page.tsx:632-650`. Hide on views where it doesn't fit if the toolbar is cramped — match how tasks gates it to list view only if needed.

- [ ] **Step 4: Verify.** Tests + tsc + full suite green. Manual: type the placeholder example → modal opens with Tuesday 10:00–11:00 prefilled; with AI store disabled locally → modal opens with raw text as title.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/calendar/quickAddEvent.ts apps/web/lib/calendar/quickAddEvent.test.ts apps/web/app/\(app\)/calendar/page.tsx
git commit -m "feat(calendar): natural-language quick-add opens a prefilled event form"
```

---

### Task 6: `lib/ai/threadContent.ts` — full-body thread gathering

**Files:**
- Create: `apps/web/lib/ai/threadContent.ts`
- Test: `apps/web/lib/ai/threadContent.test.ts`

**Interfaces:**
- Consumes: `extractEmailText` (`lib/ai/extract.ts`); the shapes of `api.mail.getConversation(id)` (`{ conversationId, messages: ThreadMessageMeta[] }`, oldest first — meta has `id, fromEmail, fromName, receivedAt, snippet`) and `fetchBodyCached(id, getMessage)` (`lib/mailBodyCache.ts`) — both INJECTED, not imported, so tests need no network/mocking of modules.
- Produces (Task 9 relies on this exactly):

```ts
export interface ThreadContentDeps {
  getConversation: (id: string) => Promise<{ conversationId: string | null; messages: Array<{ id: string; fromEmail: string; fromName: string | null; receivedAt: string; snippet: string | null }> }>;
  getBody: (id: string) => Promise<{ bodyText?: string | null; bodyHtml?: string | null }>;  // caller passes (id) => fetchBodyCached(id, api.mail.getMessage)
}
export async function gatherThreadContent(messageId: string, deps: ThreadContentDeps): Promise<{ text: string; messageCount: number }>;
```

Behavior: take the LAST 10 messages (thread is oldest-first); for each, `deps.getBody` → `extractEmailText({bodyText, bodyHtml}, { maxChars: 2000, keepQuoted: false })`; a rejected/empty body falls back to `snippet ?? ''` (never rejects the whole gather); each block is `From: ${fromName ? `${fromName} <${fromEmail}>` : fromEmail}\nDate: ${receivedAt}\n\n${content}`; blocks joined with `\n\n---\n\n`; `messageCount` = total thread length (not the capped count).

- [ ] **Step 1: Write failing tests** — caps at last 10 of 14 (assert first included message is #5); body-fetch rejection degrades to snippet; per-message 2000-char cap applied (feed a 5000-char body, assert block length); single-message thread works.

- [ ] **Step 2: Run — must fail**, implement (fan out with `Promise.all` over the capped slice, each body call individually try/caught), run → PASS, tsc clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/ai/threadContent.ts apps/web/lib/ai/threadContent.test.ts
git commit -m "feat(ai): gather full-body thread content with caps and graceful degradation"
```

---

### Task 7: `lib/ai/draftDoc.ts` — template pick + draft + safe assembly

**Files:**
- Create: `apps/web/lib/ai/draftDoc.ts`
- Test: `apps/web/lib/ai/draftDoc.test.ts`

**Interfaces:**
- Consumes: `TEMPLATES` (Task 1); `AIClient.chat` JSON mode; `parseJsonObject`; `UNTRUSTED_CONTENT_RULE`, `fenceUntrusted`, `languageRule`, `customInstructionsBlock`/`withCustomInstructions` pattern and `scrubOutput` (`lib/ai/prompt.ts`, see `tasks.ts` usage); `markdownToHtml` (`lib/ai/markdownToHtml.ts`); `generateJSON` from `@tiptap/core`; `StarterKit` from `@tiptap/starter-kit`; the Link extension exactly as DocsEditor configures it (check `DocsEditor.tsx` imports — reuse its configuration; if DocsEditor has no Link extension, omit it and let links degrade to text).
- Produces (Task 9 relies on these exactly):

```ts
export const TEMPLATE_CATALOG: Array<{ id: string; name: string; description: string; sections: string[] }>;  // TEMPLATES minus 'blank'
export interface DraftResult { templateId: string; title: string; markdown: string }
export async function draftFromThread(
  client: AIClient, threadText: string,
  opts: { model: string; subject: string; customInstructions?: string | null; signal?: AbortSignal }
): Promise<DraftResult>;             // REJECTS on unusable output (caller toasts); templateId always valid (fallback 'memo'); title falls back to opts.subject
export function assembleDocContent(markdown: string): string;   // sanitized HTML → generateJSON → JSON.stringify
export function templateEmoji(templateId: string): string;      // emoji of the template, fallback '📄'
```

- [ ] **Step 1: Write failing tests:**

```ts
it('catalog excludes blank and carries sections', ...);
it('valid model output passes through', ...);                        // mock chat → {"templateId":"minutes","title":"...","markdown":"## Attendees\n- ..."}
it('unknown templateId falls back to memo', ...);
it('missing title falls back to subject', ...);
it('missing/empty markdown rejects', async () => { await expect(draftFromThread(...)).rejects.toThrow(); });
it('non-JSON model output rejects', ...);
it('assembleDocContent: headings, bullets, bold survive as TipTap nodes', () => {
  const json = JSON.parse(assembleDocContent('## Decisions\n\n- **Tricia** owns the TOR'));
  expect(json.type).toBe('doc');
  expect(JSON.stringify(json)).toContain('"level":2');
  expect(JSON.stringify(json)).toContain('bulletList');
  expect(JSON.stringify(json)).toContain('bold');
});
it('assembleDocContent: script/onerror payloads cannot survive', () => {
  const out = assembleDocContent('hello <script>alert(1)</script> <img src=x onerror=y>');
  expect(out).not.toContain('script');
  expect(out).not.toContain('onerror');
});
```

- [ ] **Step 2: Run — must fail**, then implement:
  - System prompt: untrusted rule; "You draft a government document from an email thread. Choose the best-fitting template from the catalog and write the document."; the catalog rendered as `- id: name — description (sections: a, b, c)` lines; output contract: ONLY JSON `{"templateId","title","markdown"}`; markdown uses `##` for each section you fill, `- ` bullets, `**bold**` for owners; include only sections the thread supports; never invent facts, names, or dates; `languageRule(threadText)`.
  - User prompt: `Thread subject: ${subject}` + `fenceUntrusted('EMAIL THREAD', threadText)` + "Draft the document now."
  - `client.chat({ ..., temperature: 0.2, maxTokens: 1200, responseFormat: 'json', signal })`; `parseJsonObject` salvage; validate per Produces; `scrubOutput` on title and markdown.
  - `assembleDocContent`: `generateJSON(markdownToHtml(md), extensions)`.

- [ ] **Step 3: Verify** — tests PASS, tsc clean, full suite green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/ai/draftDoc.ts apps/web/lib/ai/draftDoc.test.ts
git commit -m "feat(ai): draft-from-thread task — template pick, markdown draft, safe TipTap assembly"
```

---

### Task 8: Docs deep link `?open=<id>`

**Files:**
- Modify: `apps/web/app/(app)/docs/page.tsx` (list load effect + `selectDoc` at ~line 107)

**Interfaces:**
- Consumes: existing `selectDoc(id)` in the page.
- Produces: visiting `/docs?open=<docId>` opens that doc once the list has loaded, then cleans the URL with `router.replace('/docs')`. Task 9 navigates here.

- [ ] **Step 1: Implement.** Read `useSearchParams().get('open')` (the page is already client-side; if `useSearchParams` demands a Suspense boundary at build, read `window.location.search` inside the effect instead — smallest working diff). In the effect that runs after the docs list loads: if an `open` id is present and not yet consumed (a `useRef` guard), call `selectDoc(openId)` and `router.replace('/docs')`. An id not in the user's list: `selectDoc` already handles fetch failure — verify it fails quietly (console/toast, no crash).

- [ ] **Step 2: Verify.** `npx tsc --noEmit`; `NEXT_TELEMETRY_DISABLED=1 npx next build` must succeed (the Suspense/CSR-bailout risk is why). Manual: copy a doc id from the network tab, visit `/docs?open=<id>` → doc opens, URL cleans.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/\(app\)/docs/page.tsx
git commit -m "feat(docs): ?open=<id> deep link selects a doc after the list loads"
```

---

### Task 9: "Draft doc" action in the thread view

**Files:**
- Modify: `apps/web/components/mail/ThreadView.tsx` (quick-actions row; follow `handleSummarize` at ~line 184 for AI-store/abort idioms)

**Interfaces:**
- Consumes: `gatherThreadContent` (Task 6) with deps `{ getConversation: api.mail.getConversation, getBody: (id) => fetchBodyCached(id, api.mail.getMessage) }`; `draftFromThread`, `assembleDocContent`, `templateEmoji` (Task 7); `api.docs.create({ title, emoji, content })`; `/docs?open=` (Task 8); `AIWorkingIndicator`; `useRouter`; toast idiom used elsewhere in the file.
- Produces: user-facing feature; nothing downstream.

- [ ] **Step 1: Wire it.** A **Draft doc** button (FileText icon from lucide, `text-ui` styling matching siblings) in the quick-actions row, rendered when AI is enabled. Click handler:

```ts
setDraftStep('Reading thread');           // small popover anchored to the button, mirrors the summarize popover pattern
const { text } = await gatherThreadContent(message.id, deps);
setDraftStep('Choosing template');
const draft = await draftFromThread(client, text, { model, subject: message.subject ?? '', customInstructions, signal });
setDraftStep('Drafting');
const content = assembleDocContent(draft.markdown);
const doc = await api.docs.create({ title: draft.title, emoji: templateEmoji(draft.templateId), content });
router.push(`/docs?open=${doc.id}`);
```

State: `draftStep: string | null` (null = idle; non-null renders the popover with `<AIWorkingIndicator step={draftStep} />` and a Cancel button that aborts). AbortController ref: abort on unmount, on Cancel, and on re-click (re-click restarts). Catch: `AbortError` → silent reset; anything else → toast the message, reset, **no doc created** (note `api.docs.create` runs only after generation succeeded — a create failure itself just toasts).

- [ ] **Step 2: Verify.** `npx tsc --noEmit`; full suite green. Manual on dev server: open a real thread → Draft doc → steps advance → lands on `/docs` with the doc open, structured content, sensible template emoji; Cancel mid-run resets quietly; with AI disabled the button is absent.

- [ ] **Step 3: Commit**

```bash
git add apps/web/components/mail/ThreadView.tsx
git commit -m "feat(mail): one-click Draft doc — thread to filled gov template in Docs"
```

---

### Task 10: Minutes formatter in the docs editor

**Files:**
- Modify: `apps/web/lib/ai/tasks.ts` (add `formatMinutes` next to `summarizeSelection`)
- Modify: `apps/web/components/docs/DocsEditor.tsx` (AI row + apply paths)
- Test: `apps/web/lib/ai/tasks.test.ts` if present, else create `apps/web/lib/ai/formatMinutes.test.ts`

**Interfaces:**
- Consumes: `summarizeSelection` as the exact structural template (same file, ~line 360+): `truncate`, `fenceUntrusted`, `withCustomInstructions`, `languageRule`, `scrubOutput`, `client.chatStream`.
- Produces:

```ts
export interface FormatMinutesOptions { model: string; subject?: string; customInstructions?: string | null; signal?: AbortSignal }
export async function formatMinutes(
  client: AIClient, text: string, opts: FormatMinutesOptions, onChunk: (delta: string) => void
): Promise<string>;   // markdown minutes; '' for empty input
```

- [ ] **Step 1: Write failing tests** (mock client capturing the request): system prompt mentions the four sections and forbids invention; input is truncated to 8000 chars; empty input returns `''` without calling the client; output passes through `scrubOutput` (mock a completion containing a marker `scrubOutput` strips — copy the fixture approach from existing `tasks`/`summarize` tests if present, else assert the happy path returns the mock text).

- [ ] **Step 2: Run — must fail**, implement `formatMinutes`:
  - System: `UNTRUSTED_CONTENT_RULE` + "You turn raw meeting notes into structured minutes. Output Markdown with `##` sections in this order, including a section ONLY if the notes contain material for it: Attendees, Agenda, Decisions, Action items. In Action items, bold the owner's name (`**Name**`). Never invent names, decisions, or dates. No preamble, no meta-commentary." + `languageRule(plain)`.
  - User: `${subject ? `Document: ${subject}\n\n` : ''}${fenceUntrusted('NOTES', truncate(text.trim(), 8000))}\n\nFormat the notes above as minutes. Output only the minutes.`
  - `chatStream({ temperature: 0.2, maxTokens: 700, signal })` → `scrubOutput`.

- [ ] **Step 3: Wire DocsEditor.** Add a **Minutes** button to the AI row beside Summarize; `aiAction: 'minutes'` in the existing action state union. Streaming/preview identical to Summarize (plain `whitespace-pre-wrap` while `aiBusy`, `markdownToHtml` render once complete — NEVER per tick). Apply buttons for minutes: **Discard / Replace selection / Insert below** — Replace uses the same clamped-range replace path Rewrite uses (with `markdownToHtml` output, since minutes are markdown); Insert below uses Summarize's `insertContentAt` after-block path.

- [ ] **Step 4: Verify.** Tests PASS, tsc clean, full suite green. Manual: paste messy notes in a doc, select, Minutes → preview streams then renders sections with bold owners; Replace swaps the selection; Insert below appends after the block; second run while streaming aborts the first.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/ai/tasks.ts apps/web/components/docs/DocsEditor.tsx apps/web/lib/ai/formatMinutes.test.ts
git commit -m "feat(docs): Format as minutes — selection action with structured markdown output"
```

---

## Final verification (after Task 10)

- [ ] `cd apps/web && npx tsc --noEmit && npx vitest run` — everything green.
- [ ] `NEXT_TELEMETRY_DISABLED=1 npx next build` — clean production build (the docs `useSearchParams` change and calendar page edits are the risk spots).
- [ ] Manual sweep on dev server: all four features once each, plus one regression check of thread Summarize, tasks quick-add, and the docs Summarize (shared files touched).
- [ ] Push `ft-hyperscale`.
