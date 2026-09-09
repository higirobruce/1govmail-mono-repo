# Thread-context Ask — release notes

**Date:** 2026-09-09 · **Branch:** `ft-hyperscale` · **Range:** `0eff6c2..d9fd5a1`
**Spec:** `docs/superpowers/specs/2026-09-09-thread-context-ask-design.md`
**Plan:** `docs/superpowers/plans/2026-09-09-thread-context-ask.md`
**Design page:** https://claude.ai/code/artifact/8fafc221-80bf-4a3b-8866-a15172e65fb5
**Final review page (debt register with dispositions):** https://claude.ai/code/artifact/c540165d-8e33-4ba1-9a22-3e99dd75f2dd

## What shipped

Opening Ask 1Gov from a mail thread now arrives with that thread already pinned as context, instead
of an empty box the user has to describe their own inbox into.

- **Three entry points**, all gated on `aiEnabled`: an **Ask** pill in the thread header beside
  Summarize / Draft doc, an **Ask about this thread** row in the message-list right-click menu, and
  the **`q`** shortcut (listed in the `?` overlay). A message with no `conversationId` is still
  askable — the gather resolves the thread through the seed message id.
- **Pinned by default, inbox still reachable.** A thread scope rides the agent endpoint with all 21
  tools live; the thread's text is gathered client-side, capped at 6000 chars, and sent as a
  `pinned` block. Three thread-aware starter prompts replace the blank composer.
- **"This thread only" lock** on the chip narrows the agent to five thread-local tools
  (`get_thread`, `read_email`, `read_attachment`, `ask_user`, `draft_email` — the last so "draft a
  reply" still works, since a draft is human-reviewed).
- **Honest counts.** The chip reads "N of M messages" when the character budget dropped older
  messages, and the count stated to the model is the number that actually reached it.

## Architecture decisions worth remembering

- **A scope's *variant* now picks the backend.** Previously "has a scope" meant "use retrieval". A
  **doc** scope still goes to `/ai/ask` with a 12-turn history, byte-for-byte as before; a **thread**
  scope goes to `/ai/agent` with a 6-turn history. The 6-turn cap is load-bearing: long transcripts
  are what pushed qwen3 into answering without calling tools (observed 2026-09-06).
- **`messageIds` is the whole thread; `includedCount` is what reached the model.** They diverge
  whenever budgeting drops blocks. The full list is deliberate — it bounds the locked reads, where
  reading an older in-thread message is legitimate — but no count shown to a user or stated to the
  model may be derived from it. The server clamps `includedCount` and declines to state a count it
  cannot substantiate.
- **Filtering the advertised tool list is NOT enforcement.** The llama.cpp host behind `CHAT_MODEL`
  is documented as ignoring `tool_choice`, and prompt mandate 7 actively steers the model at search
  tools. So the **dispatch site** also refuses anything off the allowlist, before the clarify and
  write-gated branches — the write-gated branch returns early, so a guard only around `execute`
  would still let a locked turn raise a `send_email` proposal.
- **The pinned block is untrusted mail.** Text is fenced with `fenceUntrusted`; the label (a mail
  Subject, i.e. attacker-written) is run through `neutralizeMarkers` **and** whitespace-collapsed,
  because `neutralizeMarkers` strips structure but never prose. Injection flagging ORs the
  `MessageCard` cards for the pinned ids with a detector pass over label + text. The block is a
  `user` message — the server owns exactly one system message.
- **Message ids are named outside the fence** so the locked tools are addressable at all. Without
  them a locked answer could carry no citations, because no reachable tool meant no refs. Ids are
  filtered through `SAFE_ID` (drop, never rewrite — a rewritten id would be unaddressable) and
  explicitly labelled as tool arguments, not citation aliases.

## Gates at `d9fd5a1`

- `apps/api`: 49 suites / **443 tests**, `tsc --noEmit` clean
- `apps/web`: 68 files / **564 tests**, `tsc --noEmit` clean
- Zero diff under `apps/api/src/chat/` (the doc-scoped ask is untouched) and none under
  `apps/api/prisma/` (no migration in this stream)

## DEPLOY — read before shipping

**This deploy is NOT code-only.** Both VMs were last at `690af54`, so
`20260908125930_add_user_ai_profiles` from the AI-personalization stream is **still pending on both
boxes** and must be applied with this work. Expect exactly that one migration.

`.155` uses PG on 5433 and needs the SNI probe (`curl --resolve test1.risa.gov.rw:443:<ip>`); its
SSH/scp can time out on the first attempt and succeed on an immediate retry.

Post-deploy markers to grep for: `not part of this thread` in the api dist, `Only this thread` in
the web chunks.

## Live sweep (needs a real session on .154)

1. Open a thread, click **Ask** — chip and three starters appear, and **no gather happens until the
   first send**.
2. Ask where the thread stands — the answer draws on it and the rail shows real tool refs.
3. Flip **only**, then ask something answerable only from elsewhere ("has this come up before?") —
   the agent must decline rather than search.
4. With **only** on, ask for a reply draft — a draft proposal still appears.
5. Press `q` on an open thread; then `?` — the overlay lists **Q — Ask about this thread**.
6. Right-click a list row without opening it — **Ask about this thread** pins that message.
7. Dismiss any event proposals with real attendees — never save them.

## Known debt (dispositioned on the final review page)

Nothing Critical or Important is open. Carried as debt:

- **Unpinnable gather degrades silently** — a conversation that yields no text sends unpinned with
  no notice while the chip still shows the thread. Strictly better than the 400 it replaced; spec §4
  wants the chip's pinned affordance dropped instead.
- **`SAFE_ID` caps ids at 64 chars** and logs nothing when it drops one. Fails safe, but a
  deployment minting longer ids would silently regress locked mode to having no addressable id.
- **`conversationId`** is written by all three entry points and read by nowhere — dead field.
- **Card lookup is unscoped by `userId`** — client-supplied ids are queried directly, leaking one
  bit (is message X flagged). Matches retrieval's existing shape; the id bound is the natural place
  to close it. This is the debt item to close first.
- **`mailRef` hard-codes `injectionSuspected: false`** (`mail.tools.ts:31`) — the agent's mail tools
  never consult the cards, unlike retrieval. Pre-existing, wider than this stream.
- **`[sN]` alias shapes are not stripped** from pinned text; the agent path has no whitelist to
  poison, so worst case is a citation resolving to an unrelated real source.
- **Stop doesn't cancel an in-flight gather** — up to ten body fetches continue and the panel sits
  on "Thinking" until they settle.
- **Gather-failure notice renders after streaming ends**, so a successful answer can sit above it.
- **`slice(-(maxMessages ?? 10))`** — a future caller passing `maxMessages: 0` gets `-0`, and
  `slice(-0)` returns the whole array. No current caller passes it.
- **Spec §5.1's locked placeholder** ("Answers drawn only from this conversation") never shipped.
- **The 21-tool registry total is pinned by no test** — `tool-registry.spec.ts` builds a synthetic
  registry, and no spec instantiates the real one.
- **`includedIn` returns 0** when a client sends neither `includedCount` nor `messageIds`, so a pin
  with real text can under-claim as "0 message(s)". Only reachable from a non-standard client.
