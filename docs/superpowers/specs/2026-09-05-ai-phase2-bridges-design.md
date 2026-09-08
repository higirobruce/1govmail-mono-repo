# AI Phase 2 — Bridges (design)

**Date:** 2026-09-05 · **Status:** approved by Bruce (design page: claude.ai/code/artifact/9e494df7-8628-4268-ad05-1243ffa8820c)
**Scope:** four features connecting mail → docs and mail → calendar, plus one docs editor action. Web app only; **no API schema changes, no migrations**. Builds entirely on the phase-1 AI stack (`docs/superpowers/specs/2026-09-05-ai-phase1-design.md`).

User decisions locked in chat:
1. Phase 2 = the three bridges **plus** the minutes formatter.
2. Draft from thread: **one click, the AI picks the template** (no picker, no preview step).
3. Smart event from mail: **form opens immediately, AI fills fields live**; typing over anything wins.
4. Minutes formatter: **editor selection action** in the docs AI row (not a template-picker box).

## Standing invariants (apply to every feature below)

- Model output NEVER becomes raw HTML or raw editor JSON. Docs-bound content goes markdown → `markdownToHtml` (escape-first + DOMPurify) → TipTap `generateJSON`. Form-bound content goes through validated plain-string fields.
- Every prompt fences untrusted content with `fenceUntrusted` and carries `UNTRUSTED_CONTENT_RULE`; every completion passes `scrubOutput`.
- Every streaming/parsing surface has an AbortController, aborted on unmount and on re-trigger; one in-flight call per surface.
- Locked-model config (`lib/ai/config.ts`) governs everything; `useAIStore` enabled/model respected where not locked.
- Field-parse helpers (`eventParse`, like `taskParse`) never throw: total failure degrades to today's non-AI behavior (blank form, raw-text title), never a blocked user. Draft generation (`draftFromThread`) may fail visibly — a toast — but never creates a partial artifact.
- Collab docs: ranged `insertContentAt` only, never `setContent`; clamp ranges to `doc.content.size`.
- No AI action auto-sends anything. Events save (and invites go out) only on the user's Save click; docs are created only after generation fully succeeds.

## Feature 1 — Draft from thread (mail → docs)

**UX.** A **Draft doc** action (FileText icon) joins the quick-actions row above the thread title in `components/mail/ThreadView.tsx`. Click → small anchored popover with `AIWorkingIndicator` walking real steps: *Reading thread → Choosing template → Drafting*. On success the new doc opens in Docs. On failure: toast with the error, no doc created. Re-click while running aborts and restarts.

**Thread content gathering — new `lib/ai/threadContent.ts`.**
- `gatherThreadContent(messageId, deps): Promise<{ subject, text, messageCount }>`
- Uses `api.mail.getConversation(messageId)` for the ordered message list, then fans out to full bodies via `fetchBodyCached(m.id, api.mail.getMessage)` (`lib/mailBodyCache.ts`) — fixing the snippet-only limitation baked into today's `handleSummarize`.
- Caps: the **last 10 messages** of the thread, each reduced by `extractEmailText({bodyText, bodyHtml}, { maxChars: 2000, keepQuoted: false })`; per-message header `From: <sender>\nDate: <receivedAt>`; joined with `\n\n---\n\n`. A message whose body fetch fails degrades to its snippet — the draft proceeds.
- Deps injected (api functions) so it unit-tests without network. Exported separately so thread summarize can adopt it later (out of scope now).

**Template catalog — extract templates out of the component.**
`components/docs/TemplatePickerDialog.tsx` (896 lines) holds all 18 template definitions inline. Move the `Template` interface, builder helpers (`T/B/P/H/HR/BL/OL/TABLE`…), the template array, and `CATEGORIES` to a new data module **`lib/docs/templates.ts`**; the dialog imports from it. Pure relocation, no behavior change — required so `lib/ai` code can read the catalog without importing a React component.

**Draft task — new `lib/ai/draftDoc.ts`.**
- `TEMPLATE_CATALOG`: `{ id, name, description, sections }` for the 17 gov templates (excludes `blank`), derived from `lib/docs/templates.ts`.
- `draftFromThread(client, threadText, opts { model, subject, customInstructions?, signal? }): Promise<{ templateId, title, markdown }>`
  - Single JSON-mode call (`responseFormat: 'json'`). System prompt: the untrusted rule, the catalog (id + description + sections each), instructions to pick the best template, write a `title`, and fill the sections as Markdown (`##` per section, `-` bullets, `**bold**` owners), omitting sections the thread gives nothing for; no fabrication. `languageRule` on the thread text. Temperature 0.2; maxTokens ~1200.
  - Salvage via shared `parseJsonObject`. Validation: `templateId` must be in the catalog else **fallback `memo`**; `title` falls back to the thread subject; empty/missing markdown → throw (caller toasts; nothing created).
- `assembleDocContent(markdown): string` — `markdownToHtml(markdown)` → `generateJSON(html, extensions)` (`@tiptap/core` + the same extension set DocsEditor uses minus Collaboration) → `JSON.stringify`. Unit-tested: headings/lists/bold survive; script/link garbage cannot (DOMPurify already proves this, assert the composition).

**Creation + navigation.**
- `api.docs.create({ title, emoji: template.emoji, content: assembled })` → `router.push('/docs?open=<id>')`.
- **Docs deep link (new):** `app/(app)/docs/page.tsx` reads `useSearchParams().get('open')`; after the doc list loads, `selectDoc(open)` and clear the param via `router.replace('/docs')`. Works for any future caller.

## Feature 2 — Smart event from mail (mail → calendar)

**Entry paths (all three existing ones), each now keeping the message id:**
1. Drop on calendar grid — `calendar/page.tsx` `handleMailDrop` currently discards `msg.id`; keep it.
2. Drop on sidebar Calendar item — `components/layout/Sidebar.tsx` `handleMailNavDrop` → sessionStorage `govmail-prefill-calendar`; payload already carries `id`, the consumer at `calendar/page.tsx` now uses it.
3. Right-click → Create event — `?createFromEmail=<id>` already carries it.

All three set `prefillData.linkedMessageId` (**bug fix**: paths 1–2 lose it today) and a new `prefillData.aiFillMessageId`.

**Modal behavior — `CreateEventModal` in `app/(app)/calendar/page.tsx`.**
- Opens instantly with today's basic prefill (title = subject, description = From/snippet).
- If `aiFillMessageId` && AI enabled: fetch the full message (`api.mail.getMessage`), run `parseEventFromEmail`, show `AIWorkingIndicator` (step: *Reading the email*) inside the modal; abort on close/save.
- **Dirty-field tracking:** every user edit marks that field dirty; parse results apply only to clean fields. The merge is a pure function `mergeParsedEvent(current, parsed, dirtyFields)` (unit-tested) so the modal just applies its output.
- Attendees land as normal chips in `AttendeePicker` — reviewable, removable; invites go out only on Save, as with manual entry.
- Parse failure or AI off: the form simply stays as it opened. No error UI beyond a silent console warn.

**Typing fix (in passing):** `lib/api.ts` calendar `createEvent`/`updateEvent` payload types gain the `linkedMessageId?`/`linkedSubject?` the server (`CalendarEventData`) already accepts.

## Feature 3 — Natural-language event creation

**UX.** A quick-add input in the calendar toolbar, mirroring the tasks page pattern: placeholder `Try "Steering committee Tuesday 10–11 with Erick and Tricia"`, submit button, `AIWorkingIndicator` (step: *Parsing your event*) while working.

**Behavior.** Submit → `parseEventInput` → **open `CreateEventModal` prefilled** with the parse result (title, start/end, allDay, location, attendees). Deliberately different from tasks quick-add (which creates directly): saving an event sends invites, so review stays mandatory. AI off/unreachable/failed → modal opens with the raw text as title. Input clears when the modal saves, not when it opens (cancel keeps the text for retry).

`CreateEventModal.prefillData` widens to: `{ title?, description?, startAt?, endAt?, allDay?, location?, attendees?, linkedMessageId?, linkedSubject?, aiFillMessageId? }` (start/end as `"yyyy-MM-dd'T'HH:mm"` local strings, matching `DateTimePicker`).

## Shared parser — new `lib/ai/eventParse.ts`

- `interface ParsedEvent { title: string; startAt: string | null; endAt: string | null; allDay: boolean; location: string | null; attendees: string[] }` — start/end as local `"yyyy-MM-dd'T'HH:mm"`.
- `parseEventFromEmail(client, { subject, from, body }, { model, now?, signal? })` — body pre-reduced by `extractEmailText` (maxChars 3000); fenced as EMAIL.
- `parseEventInput(client, input, { model, now?, signal? })` — input fenced as USER TEXT (still untrusted-fenced for consistency).
- Both: JSON mode, `now` anchor injected for relative dates ("Tuesday", "tomorrow"), temperature 0.1, `parseJsonObject` salvage, then hard validation:
  - dates must parse; `endAt > startAt` else `startAt + 1h`; a date with no time and no explicit all-day → default 09:00–10:00; explicit all-day → `allDay: true`.
  - attendees: strings containing `@` only, lowercased, deduped, max 10. (Autocomplete-only names like "Erick" without an address are dropped — the picker's autocomplete remains the way to resolve names; the prompt asks the model to only emit addresses it saw in the source.)
  - title: trimmed, non-empty else fallback (email subject / raw input).
- Never throws. Total failure → `null` (email path) / `{ title: rawInput, … }` minimal (NL path). Known phase-1 parity: same UTC/local weekday edge as `taskParse` (parked there, parked here).

## Feature 4 — Minutes formatter (docs)

**UX.** **Minutes** joins Rewrite ▾ and Summarize in the DocsEditor selection-bubble AI row. Select raw notes → same preview popover as Summarize: plain-text `whitespace-pre-wrap` while streaming, `markdownToHtml` render once complete, buttons **Discard / Replace selection / Insert below** (minutes gets Replace too, unlike Summarize — reformatting in place is the primary use).

**Task — `formatMinutes` in `lib/ai/tasks.ts`** (sibling of `summarizeSelection`):
- System prompt: restructure the passage as meeting minutes in Markdown with `##` sections **Attendees, Agenda, Decisions, Action items** (bold owner names in action items); include a section only if the notes contain material for it; never invent names, decisions, or dates; `languageRule`; no preamble.
- `truncate(text, 8000)`, fenced as NOTES, temperature 0.2, maxTokens 700, `scrubOutput`.

**Wiring in `components/docs/DocsEditor.tsx`:** new `aiAction: 'minutes'` alongside the existing rewrite/summarize state; reuses `aiRange` clamping, abort ref, and both apply paths (`Replace` = ranged replace of the clamped selection; `Insert below` = `insertContentAt` after the block end, as Summarize does).

## Files touched (summary)

| Area | Files |
|---|---|
| New libs | `lib/ai/threadContent.ts`, `lib/ai/draftDoc.ts`, `lib/ai/eventParse.ts`, `lib/docs/templates.ts` (extraction) + tests for each |
| Tasks | `lib/ai/tasks.ts` (`formatMinutes`) |
| Mail | `components/mail/ThreadView.tsx` (Draft doc action), `components/mail/MailList.tsx` (payload unchanged — id already present) |
| Calendar | `app/(app)/calendar/page.tsx` (quick-add input, `CreateEventModal` aiFill + dirty tracking + widened prefill, drop handlers keep id), `components/layout/Sidebar.tsx` (prefill payload passthrough) |
| Docs | `components/docs/DocsEditor.tsx` (Minutes action), `components/docs/TemplatePickerDialog.tsx` (imports from `lib/docs/templates.ts`), `app/(app)/docs/page.tsx` (`?open=` deep link) |
| API client | `lib/api.ts` (calendar payload typing fix) |

## Testing

Vitest, following the `taskParse`/`quickAdd` seam pattern (logic in libs, pages stay thin):
- `eventParse.test.ts` — relative dates against a fixed `now`, end-before-start correction, defaults, attendee filtering, JSON salvage, total-failure fallbacks.
- `draftDoc.test.ts` — catalog shape, bad-template fallback to memo, title fallback, `assembleDocContent` (markdown survives, hostile HTML doesn't, output parses as TipTap JSON).
- `threadContent.test.ts` — fan-out with mocked deps, 10-message/2000-char caps, body-fetch failure → snippet degradation.
- `mergeParsedEvent` test — dirty fields never overwritten, clean fields filled, attendee merge.
- Existing 289 web tests stay green; api suite untouched.

## Out of scope (noted, not built)

- Thread summarize adopting `gatherThreadContent` (follow-up).
- Timezone handling rework in calendar (`fmtDt` UTC hack is pre-existing).
- Meeting prep pack, Ask 1Gov, embeddings generalization, relationship dossier — phase 3.
- Server-side validation DTO for calendar (pre-existing bare interface; unchanged).
