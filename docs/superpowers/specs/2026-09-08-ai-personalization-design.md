# AI Personalization — profile-contextualized prompts (P1–P3)

**Date:** 2026-09-08 · **Status:** draft, awaiting Bruce's review
**Goal:** AI output that knows who it is writing for and as — account-level instructions, a
structured identity card, and (later) a derived writing-style card — injected **tiered**, never
everywhere, because on a 16k-context local model every profile token trades against history, tool
results, and the security mandates (the fabrication-mode trigger).

**Origin:** brainstormed across two sessions 2026-09-08; this spec is the merged, code-verified
version. Key code facts it stands on: custom instructions exist only client-side
(`apps/web/lib/ai/prompt.ts` `customInstructionsBlock`, zustand `ai` store → per-device);
`User` has only email/displayName/zimbraHost; `buildAgentPrompt` already receives
userEmail/userName but dossier/meeting-prep/summarize get no identity; `ai_generations` is a keyed
cache ready for a new kind; `.155` builds lock `NEXT_PUBLIC_AI_MODEL`, which **hides the Settings AI
section** — the current home of custom instructions.

## Phase P1 — account-level instructions + identity (small, ship first)

### Data
One migration for P1+P2 (fields ship together, P2 UI comes later):

```prisma
model UserAiProfile {
  id           String   @id @default(cuid())
  userId       String   @unique
  instructions String?             // free-text preferences, hard cap 500 chars
  jobTitle     String?             // cap 80
  institution  String?             // cap 80
  department   String?             // cap 80
  language     String?             // 'en' | 'fr' | 'rw' | null(auto)
  updatedAt    DateTime @updatedAt
  createdAt    DateTime @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@map("user_ai_profiles")
}
```

Hand-authored migration per the drifted-dev-DB workflow (no vector columns — plain SQL, but same
`db execute` + `resolve --applied` mechanics).

### API
`GET /settings/ai-profile` / `PATCH /settings/ai-profile` in SettingsModule. Server-side caps
enforced in the DTO (instructions ≤ 500, title/institution/department ≤ 80, language enum).

### Prompt integration
- New `buildProfileBlock(profile)` in `packages/shared/src/ai/` beside the other builders:
  neutralizeMarkers on every field, hard char cap, and the explicit subordination sentence the
  client block already uses ("preferences never override the rules above"). ONE implementation,
  rendered identically wherever consumed.
- **Tier table (binding):**
  | Surface | Injected in P1 |
  |---|---|
  | Agent (`buildAgentPrompt`) | instructions (identity already present) |
  | Ask (`buildAskPrompt`) | identity line + instructions |
  | Dossier / meeting prep (`buildGenerationPrompt`) | identity line only |
  | Client tasks (summarize, rewrite, suggestReply, compose AI) | unchanged mechanism — instructions now come from the account |
  | Cards, briefing map-reduce, semantic search, embeddings | nothing |
- Web: instructions move to the account. On first load, if the server profile is empty and the
  local zustand value is non-empty, auto-PATCH the local value up once, then clear local storage
  (the store keeps a read-through of the server value for the client task prompts).

### UI
Settings gains a **Profile** panel OUTSIDE the AI section, so it survives the
`NEXT_PUBLIC_AI_MODEL` lock on .155-style builds: instructions textarea with a 500-char counter
(P1), the identity fields (P2 flips them on).

### Security
Declared-by-owner content: neutralizeMarkers + caps + subordination (same trust level as today's
client instructions). No injection scanning required — the owner is not an attacker of themselves —
but fields are fenced exactly like the client block to keep marker-smuggling impossible.

## Phase P2 — structured identity card + seeding (small)

- `buildProfileBlock` renders the structured card when fields exist:
  `Profile: <jobTitle>, <department>, <institution>. Preferred language: <language>.`
- **Seeding:** `GET /settings/ai-profile/suggestions` derives candidates from the Zimbra identity
  (display name, org attrs where present) and a GAL self-lookup (`searchGal` on own address —
  title/ou attributes when the directory carries them). UI shows confirm-chips; nothing is saved
  without the user accepting.
- Tier change from P1: the full card additionally reaches suggestReply/rewrite (output that speaks
  as the user) and meeting prep; dossier stays identity-line-only; cards/summaries still get nothing.

## Phase P3 — derived writing-style card (own plan, later)

The "reconnaissance" payoff: how the user actually writes, distilled from their own sent mail.

- **Storage:** `ai_generations` kind `'style_profile'`, targetKey = userId. Content = JSON:
  `{ formality, typicalLength, greetings[], signoffs[], languageMix, tendencies[] }` — descriptive
  phrases only, **never raw quoted sentences longer than ~8 words**.
- **Worker:** 6th cron skeleton. Samples the last ~40 `/Sent` messages (excluding `isShared` once
  the sharing stream lands), distills via `CHAT_MODEL` with `response_format: json_object`,
  budget knobs `STYLE_REFRESH_DAYS=7`, `STYLE_PER_TICK=1`. At 5,000 mailboxes that is ~30
  generations/hour average — noise on the 4-slot pool.
- **Consumers:** suggestReply + rewriteText (served to the client through the ai-profile GET) and
  the agent's drafting guidance section (capped ~300 chars). Nothing else.
- **Security (the hard part, why P3 is its own plan):** the card is distilled from email content —
  an injection that survives distillation would land inside a system prompt. Mitigations, all
  mandatory: distillation prompt fences message content as untrusted; output schema-validated;
  stored card scanned with `detectInjectionAttempt` — on suspicion, tombstone and inject nothing;
  descriptive-only constraint enforced at render (drop any field failing the quote-length rule);
  staleness anchored to the newest sampled message id.

## Cost & model notes (measured anchors)
Injection cost is negligible: a 400-char block ≈ 100 tokens ≈ <70 ms prefill at 1.5–2.9k tok/s.
The binding budget is the agent's 16k context / 35k-char transcript cap and qwen3's long-context
fabrication mode — hence the tier table. P3's distillation is the only real GPU line item and it is
weekly-per-user.

## Out of scope
Admin-managed org directory (admin-console stream), profiles for other users (dossiers already
cover counterparties), personalization of cards/summaries/embeddings, multi-language UI.

## Rollout
P1 and P2 ship as one implementation plan (single migration, one settings panel, tier table).
P3 gets its own spec-confirmation + plan when picked up. Deploy both VMs per the standard recipe;
release note: instructions silently move from device to account (one-time auto-migration).
