# AI Phase 1 — Quick Wins Design Spec

**Date:** 2026-09-05
**Status:** Approved 2026-09-05 — decisions resolved: A prefilled modal · B replace-on-rewrite, insert-below-on-summarize · C deterministic digest
**Scoping doc:** https://claude.ai/code/artifact/bab96827-e4ed-41b4-82d0-e3ca31e97ef7
**Prior art:** finish-pass spec/plan flow (2026-09-04)

## Scope

Four features, all client-side against the existing AI stack (NestJS `/ai/chat` proxy,
locked/pickable model via `useAIStore`, `scrubOutput`/`neutralizeMarkers` guardrails,
`useCharStream`, `AIWorkingIndicator`):

1. Thread → tasks: commitments become editable, prefilled tasks in one click
2. Docs writing assistant: rewrite/summarize the selection in DocsEditor
3. Natural-language task entry on the tasks page
4. Workload digest in the morning briefing

Out of scope: everything in scoping phases 2–3 (draft-from-thread, calendar, embeddings
generalization, contact dossier). No schema changes; exactly one backward-compatible API
extension (see Feature 1): `POST /mail/commitments/:id/promote` accepts an optional body
`{ title?, description?, dueDate?, priority? }` overriding the server-built task fields.

## Shared groundwork

### G1 · Widen `TaskModal.prefill`

`components/tasks/TaskModal.tsx` — extend the prop and its lazy-initializer consumption:

```ts
prefill?: {
  linkedMessageId?: string;
  linkedSubject?: string;
  title?: string;
  description?: string;
  dueDate?: string;      // ISO
  priority?: TaskPriority;
}
```

Callers must remount via `key=` to change prefill (existing convention on the tasks page).

### G2 · `lib/ai/taskParse.ts` (new, TDD)

```ts
export interface ParsedTask { title: string; dueDate: string | null; priority: TaskPriority | null }
export async function parseTaskInput(
  client: Pick<AIClient, 'chat'>,
  input: string,
  opts: { model: string; now?: Date; signal?: AbortSignal },
): Promise<ParsedTask>
```

- One `chat` call, `responseFormat: 'json'`, temp 0.1, maxTokens 200. System prompt includes
  `opts.now` (ISO + weekday) so "Friday"/"next week" resolve deterministically; input is
  wrapped with `fenceUntrusted` and `neutralizeMarkers`.
- Robust parsing via the shared `parseJsonObject` salvage helpers (`@email-client/shared` cards.ts).
- **Deterministic fallback:** any error, abort, or unparseable output returns
  `{ title: input.trim(), dueDate: null, priority: null }` — the feature degrades to a plain
  quick-add, never blocks task creation. Same fallback when `useAIStore.enabled` is false
  (callers check and skip the call entirely).
- Used by features 1 (dueHint → dueDate) and 3.

## Feature 1 · Thread → tasks (CommitmentsPanel upgrade)

Today: the `CornerUpRight` action calls `api.mail.promoteCommitment(id)` — a silent
server-side promote; the user never sees or edits the created task.

⚖ **Decision A (recommended: prefilled modal).** Replace the silent promote with an
editable flow:

- The action opens `TaskModal` (create mode) prefilled: `title` = commitment `text`,
  `description` = `"From: {counterparty} · {dueHint}"` context line, `linkedMessageId` =
  `messageId`, `dueDate` = `parseTaskInput(dueHint)`'s date when `dueHint` is present
  (AI call fired on click, result awaited behind `AIWorkingIndicator step="Reading the deadline"`;
  fallback null).
- On save: **RESOLVED (contract verified 2026-09-05):** `updateCommitment` whitelists
  statuses and treats `promoted` as terminal (Conflict), while `promoteCommitment` owns the
  create-task saga (compensation delete), double-promote guard, and `taskId` linkage. So the
  editable flow goes THROUGH promote: extend the endpoint's DTO with optional
  `{ title?, description?, dueDate?, priority? }`; the server creates the task with overrides
  applied (falling back to today's derived values) and links `taskId` exactly as now.
  Client: TaskModal gains an optional `onCreateOverride(payload) => Promise<Task>` prop; the
  commitments flow passes one that calls `api.mail.promoteCommitment(c.id, payload)` and then
  `api.tasks.getAll(undefined, c.messageId)`-independent fetch of the created task
  (`GET /tasks/:id` if available, else construct from payload + returned taskId).
- Panel needs a `TaskModal` mount + `onCreateTask(commitment)` state, or a callback prop to
  the mail page mirroring `onOpenMessage` — planner's choice; prefer the callback so the modal
  z-stack stays owned by the page.
- Alternative if Decision A is rejected: keep silent promote, add a success toast with an
  "Edit task" action opening the modal.

## Feature 2 · Docs writing assistant

Add an **AI row** to DocsEditor's existing hand-rolled selection bubble (the `selBubble`
fixed-position div — NOT the TipTap table BubbleMenu):

- Actions: **Rewrite ▾** (paraphrase / formal / concise / friendly / fix grammar — the
  existing `RewriteMode` union, via `rewriteText`) and **Summarize** (via `summarizeMessage`
  with subject = doc title).
- Interaction copies ComposeModal's proven pattern verbatim:
  - Snapshot `{from, to}` + `doc.textBetween(from, to, '\n')` before the call; store in state.
  - `AbortController` ref; `useCharStream` preview; `AIWorkingIndicator` while empty.
  - **Preview-then-apply** in a small popover anchored like the bubble (never direct mutation).
  - Apply: plain text → escaped `<p>`/`<br/>` HTML (ComposeModal's escaping, reused —
    extract that snippet to `lib/ai/textToHtml.ts` with a unit test rather than copy #3),
    then `editor.chain().focus().insertContentAt({ from, to }, html).run()`.
    ⚖ **Decision B (recommended: replace selection for rewrite; insert below for summarize).**
    Summarize inserts after `to` as a paragraph rather than replacing the selected prose.
  - **Never `setContent`** (collab: Yjs is source of truth; range ops only). Local programmatic
    edits correctly trigger the debounced REST save (verified: `isChangeOrigin` only skips
    remote transactions).
- Gating: row renders only when `useAIStore(s => s.enabled)`; model from the store; user
  `customInstructions` respected (rewrite supports it).
- Read-only/shared docs (`editable === false`): bubble doesn't render today — unchanged.

## Feature 3 · Natural-language task entry

Tasks page (`app/(app)/tasks/page.tsx`), list view, directly under the filter tabs:

- A single quick-add input: placeholder `Add a task — try "Chase the TOR from Solange on Friday"`.
- Enter (or the add button):
  - AI on → `parseTaskInput` behind `AIWorkingIndicator` (inline, small) →
    `api.tasks.create({ title, dueDate?, priority? })` → prepend to local `tasks` state, toast.
  - AI off/failed → create with the raw text as title (fallback contract of G2).
- A subtle result affordance: the created task's toast mentions the parsed due date
  ("Task added · due Fri 12 Sep") so mis-parses are visible and fixable in one click
  (toast action "Edit" opens TaskModal on it).
- Board view: input hidden (list-only), matching where creation feels natural.

## Feature 4 · Workload digest in the briefing

⚖ **Decision C (recommended: deterministic, no AI call).** The briefing pipeline duplicates
its section list across five code points and its reduce step is prompt-sensitive; workload
numbers must be exact, not model-composed. So:

- A **"Your workload" strip** rendered at the top of BriefingPanel's expanded body,
  independent of the AI brief lifecycle (shows even before/without a run):
  - `N open tasks · X overdue · Y due this week` — from `api.tasks.getAll()` filtered
    client-side (the API has no due filters; same approach as the tasks page's TODAY tab).
  - `M open commitments (P promised · W waiting)` — from the already-supplied
    `openCommitmentsCount` plus a widened prop carrying the split (mail page already holds
    `commitmentsData`).
  - Each line links: tasks → `/tasks`, commitments → `onOpenCommitments()` (exists).
- Data fetch: a `useQuery(['tasks','workload'])` inside the panel, `enabled: open && expanded`,
  staleTime 60s. Renders nothing on error (non-critical).
- The AI `Brief` type, prompts, and `parseBriefJson` stay untouched — zero regression surface.
- Alternative if rejected: full `workload` section through the AI reduce (4 coordinated edits
  listed in the audit) — costlier and approximate; not recommended.

## Cross-cutting rules

- Every AI call: model from `useAIStore`, gated on `enabled`, input laundered
  (`fenceUntrusted`/`neutralizeMarkers`), output through `scrubOutput`, abortable, and fronted
  by `AIWorkingIndicator` (exact step names: "Reading the deadline", "Rewriting",
  "Summarizing", "Parsing your task").
- No new endpoints, no schema changes, no changes to briefing prompts.
- Design-system discipline: named text steps, ink tiers, `Button`/`Badge` primitives, tokens only.

## Testing

- TDD for `lib/ai/taskParse.ts` (parse happy path incl. relative dates via injected `now`,
  JSON salvage, fallback contract) and `lib/ai/textToHtml.ts` (escaping, paragraph/br mapping).
- Component tests: quick-add fallback path (AI mocked off → create called with raw title);
  TaskModal prefill widening (initializer picks up title/dueDate/priority).
- Full suite green; `tsc` clean; both-theme visual check on the four touched surfaces.

## Acceptance criteria

- Commitments rows open a prefilled TaskModal; saving creates a task linked to the source
  message and the commitment leaves the open list.
- DocsEditor selection bubble offers Rewrite (5 modes) + Summarize with preview-then-apply;
  collab docs receive the edit as a normal ranged insert; autosave fires.
- Tasks page quick-add parses "…on Friday" into a due date with AI on, and still creates a
  plain task with AI off.
- Briefing shows exact workload numbers without invoking the model, linking to tasks and
  commitments.
- `NEXT_PUBLIC_AI_MODEL`-locked deployments use the locked model for all four features with
  zero configuration.
