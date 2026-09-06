# Agentic Tool Layer for Ask 1Gov — Design (Phase 4)

**Date:** 2026-09-06
**Status:** Approved direction (Approach A); spec for implementation planning
**Fills:** the "phase-4 spec threat model" referenced in `apps/api/src/chat/chat.controller.ts`

## Summary

Ask 1Gov evolves from a retrieval-only Q&A panel into an agent: the model can
invoke tools (search mail, read threads, read/search docs, check free/busy,
draft, create) in a server-side loop, and *propose* outward or irreversible
actions (send email, create event) that the user approves with one click before
they execute through the existing REST endpoints.

## Standing invariants (carried forward from phases 3a/3b)

- Orchestration is server-side. Retrieval, ACL, prompt assembly, tool
  execution, and upstream streaming happen in the API. The browser receives
  summaries/snippets and the final answer — never full fetched content beyond
  what the user could already read via normal endpoints.
- Every piece of third-party content entering the prompt is wrapped with
  `fenceUntrusted` and governed by `UNTRUSTED_CONTENT_RULE`.
- Model choice is server-side (`CHAT_MODEL`, default `qwen3-30b-16k:latest`).
- Leg/tool failures degrade, never 500 the stream.
- **New invariant:** the `/ai/agent` endpoint itself performs no outward or
  irreversible write. Autonomous writes are limited to private, reversible
  artifacts (a mail draft, an owned document, a task). Everything else is a
  proposal executed by the browser through existing validated REST endpoints
  after explicit user approval.

## Decisions log

| Decision | Choice |
|---|---|
| Surface | Ask 1Gov panel becomes the agent (no new chat product) |
| Write safety | Confirm-gated: reads autonomous; safe writes (draft_email, create_document, create_task) autonomous; outward/irreversible writes proposal-gated |
| V1 tools | Tier-1 set over existing endpoints + `create_chart` + `compare_documents` + `read_attachment` (18 total) |
| Web tools | Deferred (offline gov VMs; revisit when an online deployment is concrete) |
| Loop | Server-side native tool calling (qwen3 via Ollama OpenAI-compat), Approach A |
| Delete/move/bulk tools | Excluded from v1 entirely |

## Section 1: Architecture — AgentModule and the loop

New module `apps/api/src/agent/`:

```
agent.module.ts
agent.controller.ts        POST /ai/agent  (JWT, throttle 10/min)
agent.service.ts           the loop
tool-registry.ts           schemas + dispatch + zod validation
tools/mail.tools.ts
tools/docs.tools.ts
tools/calendar.tools.ts
tools/tasks.tools.ts
tools/people.tools.ts
tools/chart.tools.ts
dto/agent.dto.ts           { messages: ChatTurn[] } — roles user/assistant only
```

`POST /ai/ask` remains untouched for this release; AskPanel routes turns to
`/ai/agent`. The model answers directly when no tool is needed, so `/ai/agent`
subsumes plain Q&A; `/ai/ask` can be folded in later.

**Loop (`AgentService.run`):**

1. Assemble system prompt: agent mandates + `UNTRUSTED_CONTENT_RULE` + current
   date/time + user identity (name, email) + tool-use guidance; then
   conversation turns (client cannot send system role, as with `AskDto`).
2. Call Ollama with `tools` from the registry, streaming.
3. Text response → stream deltas to client; done.
4. `tool_calls` → per call: zod-validate args → emit `tool_start` frame →
   execute via existing service with JWT `userId` → `fenceUntrusted` +
   per-tool char budget → run `detectInjectionAttempt` on the result (flag,
   not block) → emit `tool_result` summary frame → append `role: "tool"`
   message → loop to step 2.
5. Gated write tools never execute: they emit a `proposal` frame and the
   transcript records "Proposal shown to the user; it executes only if they
   approve. Do not call this tool again for the same action."
6. Limits: max **8 iterations**, max **3 tool calls per iteration**, **60s**
   wall clock, per-tool result budget (default 2,000 chars; read_email /
   read_document 4,000). On any limit: inject a final-answer nudge
   ("Answer now with what you have") and force `tool_choice: "none"`.

**AiService change:** `upstream()` accepts `tools` / `tool_choice` for
internal callers. The public `/ai/chat` DTO continues to strip them.

**Context budget:** qwen3-30b-16k has 16k context. System + tool schemas
≈ 2k tokens; tool results are the pressure point — budgets above keep a full
8-iteration transcript inside ~12k tokens; oldest tool results are elided
("[result elided]") beyond a rolling cap.

## Section 2: Tool registry and v1 tool set

Registry entry: `{ name, description, parameters (zod → JSON Schema),
mode: 'read' | 'write-auto' | 'write-gated', execute(userId, args, ctx) }`.
Descriptions are written for a 30B model: one sentence of purpose, one of
when-to-use, explicit arg semantics. The v1 registry holds exactly **18
tools** — near the practical ceiling for reliable selection by qwen3-30b.
Growth beyond this needs consolidation, not more rows; tool-selection
accuracy is an explicit item in the manual sweep.

**Read (autonomous):**

| Tool | Backing |
|---|---|
| `search_emails(query, mode?: semantic\|keyword, limit?)` | `RetrievalService.semantic` / Zimbra keyword search |
| `read_email(messageId)` | `MailService` message fetch (userId-scoped); lists the message's attachments (filename, part, type) so the model can follow up with `read_attachment` |
| `get_thread(messageId)` | conversation endpoint logic |
| `read_attachment(messageId, part)` | **new** text extraction over `MailService.downloadAttachment`: PDF (`pdf-parse`), DOCX (`mammoth`), plain text/CSV/MD direct decode; ≤10MB; other types (images, xlsx) refuse with a clear error |
| `search_documents(query)` | docs vector leg + **new** title/keyword ILIKE search in `DocsService` (ACL: owner OR invite) |
| `read_document(docId)` | `DocsService.verifyReadAccess` + `docText` extraction |
| `compare_documents(docIdA, docIdB)` | reads both via `read_document` path; returns both texts fenced with labels A/B; the model performs the comparison |
| `list_events(startDate, endDate)` | `CalendarService` |
| `get_freebusy(emails[], startDate, endDate)` | freebusy batch |
| `get_person(email)` | `PeopleService` dossier (deterministic facts) |
| `search_contacts(query)` | contacts autocomplete |
| `list_tasks(status?)` | `TasksService` |

**Write, autonomous (private + reversible):**

| Tool | Backing | Rationale |
|---|---|---|
| `draft_email(to[], cc[]?, subject, body, inReplyToMessageId?)` | drafts path in `MailService` | lands in Drafts; nothing leaves |
| `create_document(title, markdown, tags?)` | `DocsService.create` + **new** shared markdown→TipTap JSON converter (paragraphs, headings, lists, bold/italic, code) | owned, unshared |
| `create_task(title, description?, dueDate?, linkedMessageId?)` | `TasksService.create` | private, deletable |

**Write, proposal-gated (never executed by the API loop):**

| Tool | Executes on approval via |
|---|---|
| `send_email(to[], cc[]?, subject, body, inReplyToMessageId?)` | `POST /mail/send` from the browser |
| `create_calendar_event(title, start, end, attendees[]?, location?, description?)` | `POST /calendar/events` from the browser |

**Answer artifact:**

`create_chart(spec)` — autonomous; emits a `chart` SSE frame; no backend
persistence. Spec is constrained:
`{ type: 'bar'|'line'|'pie', title, labels: string[], series: [{ name, data: number[] }] }`
(≤ 3 series, ≤ 30 points, numbers only). The client renders it; the model
must gather the numbers itself via read tools first.

## Section 3: Proposal flow

- Frame: `{ proposalId, tool, args, summary }` — args are the complete,
  validated payload.
- Stateless in v1: no server-side pending-actions table; the payload lives in
  the SSE frame / client store. Dismissing a card discards it.
- AskPanel renders per-tool cards:
  - `send_email` → recipient/subject/body preview; **Approve & Send**
    (browser calls `POST /mail/send` with the payload), **Save as draft
    instead** (browser calls `POST /mail/drafts`; ComposeModal is local to
    the mail page, so cross-page "edit in compose" is deferred), **Dismiss**.
  - `create_calendar_event` → event preview with attendee chips;
    **Approve & Create** (`POST /calendar/events`), **Dismiss**.
- After execution the client appends a local status line under the card
  ("Sent ✓ " / error from the endpoint). No agent round-trip required.
- Approval is per-proposal; there is no "always allow" in v1.

## Section 4: SSE protocol and frontend

Frames on `/ai/agent` (superset of `/ai/ask`):

| event | payload |
|---|---|
| `tool_start` | `{ id, tool, argsSummary }` (human-readable, e.g. `search_emails: "RDB MoU"`) |
| `tool_result` | `{ id, ok, summary, refs?: SourceRef[], degraded?, injectionFlag? }` |
| `proposal` | as Section 3 |
| `chart` | the chart spec |
| default | OpenAI-shaped text deltas, then `[DONE]` |

Citations: each read-tool result that surfaces a concrete item registers
source aliases (`s1…sN`) in the same server-vouched whitelist mechanism as
phase 3a; `refs` carry `{ alias, kind, id, title, snippet≤160 }` so the
existing `splitByCitations` + `sourceNav` chips keep working unchanged.

Frontend changes (`apps/web`):

- `lib/ai/agent.ts` — `streamAgent()` (sibling of `streamAsk`, parses the new
  frames).
- `stores/ask.store.ts` — turn model gains `steps[]`, `proposals[]`,
  `charts[]`.
- `components/ai/AskPanel.tsx` — collapsible step timeline ("Searched mail …
  6 results"), proposal cards, chart rendering, existing abort button now
  also aborts mid-loop (server aborts upstream + stops the loop on
  `res.close`).
- `components/ai/AgentChart.tsx` — small dependency-free SVG renderer for the
  constrained spec (reuse the workload-strip chart approach if shareable),
  following the repo dataviz conventions, light/dark aware.

## Section 5: Threat model and security controls

Threats introduced by tools, and their controls:

1. **Prompt injection in read content driving actions.** Fenced +
   injection-scanned as today; but the decisive control is structural:
   *the loop cannot perform an outward action.* Worst case, injected content
   causes a proposal card the user sees and dismisses, or a private
   draft/task the user deletes. `draft_email` body content is never
   auto-sent.
2. **Exfiltration via autonomous writes** (e.g. injected "copy this mailbox
   into a doc"). Mitigated by per-tool result budgets, iteration caps, the
   audit log, and the fact that created artifacts stay private to the user.
   Accepted residual risk in v1; noted for phase-4b review.
3. **Tool-arg injection / confused deputy.** All args zod-validated; IDs are
   executed through services that enforce `userId` scoping / ACL
   (`verifyReadAccess` etc.) — the agent has exactly the user's privileges,
   never more.
4. **Client-forged frames.** Proposals execute through existing REST
   endpoints with their own validation; the agent endpoint grants no new
   capability, so a malicious client gains nothing it couldn't already call.
5. **Resource abuse.** Throttle 10/min on `/ai/agent`; loop/wall-clock caps;
   upstream aborted on client disconnect.
6. **Auditability (gov requirement).** New table `agent_tool_log`
   `(id, userId, turnId, tool, argsJson, ok, durationMs, createdAt)` written
   for every tool execution and every proposal emission. Proposal
   approval/dismissal is not logged by the agent (stateless in v1); approved
   proposals are observable via the target endpoints' own logs.

## Section 6: Error handling

- Tool execution error → `tool_result { ok:false, summary }`, transcript gets
  a short error string; the model may retry once with different args, then
  must answer without it. Never breaks the stream.
- Zod validation failure → treated as tool error with the validation message
  (models self-correct well on these).
- Upstream/Ollama failure mid-loop → stream an apology delta + `[DONE]`;
  partial steps remain visible.
- Zero-tool, zero-source questions behave like today's Ask (model answers or
  declines per mandates).

## Section 7: Testing

- **Unit:** ToolRegistry (schema gen, validation, mode routing); each tool's
  execute against mocked services (ACL refusal paths included);
  markdown→TipTap converter; chart spec validation.
- **Loop:** AgentService with a scripted fake Ollama stream — scenarios:
  direct answer; single tool then answer; multi-iteration; gated tool →
  proposal short-circuit; iteration/wall-clock cap forcing final answer;
  tool error → recovery; injection flag propagation.
- **Controller:** SSE frame ordering and shapes; throttle; role restriction.
- **Frontend:** streamAgent frame parsing; proposal card approve/dismiss
  wiring (approve calls the right endpoint with the exact payload).
- **Manual sweep before VM deploy:** the phase-3a sweep list + new agentic
  scenarios ("find X and draft a reply", "schedule with Y when we're free",
  "compare doc A and B", "chart my mail volume this month").

## Out of scope (v1)

Web search / open_webpage (deferred); spreadsheets, presentations,
server-side PDF (no backend exists); delete/move/bulk mail tools; "always
allow" per-tool autonomy settings; server-persisted proposals; folding
`/ai/ask` into `/ai/agent`; multi-agent / background agents; per-tool user
permissions UI; attachment-content **search** (embedding attachment text in
the ingest workers so `search_emails` finds content inside attachments —
phase 4b; in v1 the agent finds the email first, then reads its attachment);
OCR of scanned/image attachments.
