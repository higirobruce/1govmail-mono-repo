# Executive Briefing — Design

**Date:** 2026-09-02
**Status:** Approved design, pending implementation plan
**Phase:** 1 of the "inbox intelligence" roadmap (2: priority triage & labels, 3: commitment tracker, 4: ask-your-inbox chat — each gets its own design later)

## Purpose

Give power users (CEO/CTO/Chiefs — but gated only by the existing AI toggle, no role ACL) an on-demand, AI-generated briefing of their mailbox over a chosen time window: what needs their decision, who is waiting on them, what they promised, deadlines ahead, and what is worth knowing. Every claim links to its source message.

## Requirements (settled with the user)

- **Trigger:** on-demand, browser-orchestrated through the existing JWT-guarded `/ai/chat` proxy. No server pipeline, no scheduler (deliberately deferred).
- **Scope:** ALL messages in the window across the mailbox — not thread-scoped. Inbox (received) **and Sent** (sent mail is where the user's own commitments live). Read and unread both.
- **Window:** picker with Today / Last 24h (default) / This week.
- **Cap:** 50 newest messages after merging folders (constant, tunable). Coverage is always disclosed ("Covered 50 of 83 messages") — never silently truncated.
- **Attachments:** metadata-aware in this phase — cards carry attachment names/types/sizes so briefs surface "document awaiting review" items. Content extraction (PDF/DOCX/TXT via lazy-loaded pdf.js/mammoth) is the designated follow-up, slotting into the same card schema. Image/scanned content is out of scope until a vision-capable model is hosted.
- **UI surface:** wide slide-over panel on the mail page (existing AI panel idiom), opened by a "Brief me" toolbar button.
- **Access:** anyone with AI enabled. Role gating deferred to the admin-console work.

## Architecture: map-reduce pipeline (chosen over single-pass and two-tier hybrid)

Chosen because: per-message fidelity (a decision request buried in paragraph four is found), per-message isolation limits prompt-injection blast radius, per-message cards cache so re-briefs only process new mail, and the card is exactly the data model Phases 2 and 3 will persist.

All stages run in the browser in `apps/web/lib/ai/briefing.ts`:

1. **Fetch** — page `api.mail.getMessages` for Inbox and Sent; filter `receivedAt` to the window; merge, sort newest-first, cap at 50. Record `totalInWindow` for the coverage line.
2. **Hydrate** — `api.mail.getMessage(id)` for messages lacking a body; concurrency 4.
3. **Map** — one model call per message: `extractEmailText` (≤3000 chars) → `fenceUntrusted` → card-extraction prompt → JSON card:

   ```ts
   interface BriefingCard {
     messageId: string;
     conversationId: string | null;
     direction: 'received' | 'sent';
     from: string;
     subject: string | null;
     gist: string;                    // one sentence
     asksOfMe: string[];              // explicit requests/decisions directed at the user
     deadlines: string[];             // dates/times stated in the mail
     commitmentsIMade: string[];      // sent mail: promises the user made
     waitingOn: string | null;        // what the user is blocked on from the sender
     importance: 'high' | 'normal' | 'low';
     attachments: string[];           // "budget_memo.pdf (2.1MB)" — metadata only this phase
     injectionSuspected: boolean;     // detectInjectionAttempt on the body
   }
   ```

   Temperature 0, ~150 output tokens, concurrency 4. Unparseable JSON → one retry → count as "couldn't analyze". Model output passes `scrubOutput`; JSON extracted defensively (code-fence stripping).
4. **Cache** — cards cached locally keyed by `messageId + model`, LRU-capped (~500). Second brief of the day maps only new mail.
5. **Reduce** — one model call: all cards as compact JSON (grouped by conversation, newest state wins per thread) → brief JSON with sections *Needs your decision · Waiting on you · You promised · Deadlines ahead · Worth knowing*; every item carries `messageIds: string[]`. The reduce prompt sees only our own structured card fields — never raw email text — which is the second injection firewall.

### Backend change (the only one)

`ChatRequestDto` (and `AIClient`) gain optional `response_format: { type: 'json_object' }` pass-through so Ollama enforces JSON mode on card/reduce calls, with prompt-level JSON instructions as fallback if a backend rejects the field (same tolerate-and-retry philosophy as `reasoning_effort`).

## UI — `apps/web/components/mail/BriefingPanel.tsx`

- "Brief me" (Sparkles) button in the mail toolbar, visible when AI is enabled.
- Panel: window picker, live progress ("Analyzed 23/41 messages…"), then sections. Items are clickable → open the source message/thread. Items whose source card has `injectionSuspected` show a ⚠ "verify at source" badge.
- Footer: coverage line, generation time, Regenerate button. Closing the panel aborts in-flight work.
- The brief is AI output for human verification: the panel states this and links, never auto-acts.

## Error handling

- Per-message failures degrade gracefully: brief renders from successful cards; failed count disclosed ("Couldn't analyze 3 messages").
- Total failure (backend down) surfaces the same error treatment as existing AI panels with Retry.
- All fetches/model calls share one AbortController tied to panel lifecycle.

## Security

- Email bodies are attacker-controlled: fenced per message with sentinel fencing; `injectionSuspected` propagates to the UI badge.
- Reduce stage consumes only structured card fields (length-clamped), not raw mail — a manipulated email can at worst distort its own card, visibly linked to its source.
- Known limit (measured, documented in `prompt.ts`): multi-pass pipelines can launder injected claims into confident prose. Mitigation is structural: every brief item links to sources; suspicious sources are badged; nothing is actioned automatically.

## Testing

Unit (vitest, FakeClient pattern from `tasks.test.ts`):
- window filtering, Inbox+Sent merge, cap + coverage counting
- card prompt: fencing present, attachment metadata included, custom instructions absent (briefing uses fixed prompts)
- card JSON parsing: clean JSON, code-fenced JSON, garbage → retry → skip
- cache: hit on same messageId+model, miss on model change, LRU eviction
- reduce input assembly: conversation grouping, newest-wins, no raw body text present
- injection flag propagation card → brief item

Manual E2E on the deployed VM against `qwen3-30b-16k`.

## Out of scope (this phase)

- Attachment *content* extraction (immediate follow-up), scheduling/server-side generation, email/push delivery of briefs, role gating, persistence of cards to the API database (Phase 2/3 will lift the card schema server-side), embeddings/chat (Phase 4).
