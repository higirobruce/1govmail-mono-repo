# 1Gov Mail Finish Pass — Design Spec

**Date:** 2026-09-04
**Status:** Approved by Bruce (direction, scope, and the three open questions resolved in session)
**Review surface:** https://claude.ai/code/artifact/cf867071-dbdc-4117-9931-5fb04a9e0290

## Context

Three reference designs were reviewed to set a look-and-feel direction for the mail app.
Chosen direction: **email-native polish** (classic list + reading pane, refined), cherry-picking
details from the other two references.

A code audit of `apps/web` found that the three scoped features (inline reply, icon rail,
attachment cards) already exist. The visual gap against the references is **consistency debt**,
not missing features. This spec defines four workstreams to close that gap.

## Decisions (resolved 2026-09-04)

1. **Workstream A scope:** mail surfaces first (list, thread, sidebar, compose), but the token
   and type-scale work must be designed app-wide — names and tiers chosen so settings/docs/
   calendar can adopt them in a later pass without rework.
2. **Inline reply becomes the default reply path.** Reply/Reply-all from the thread toolbar
   focuses the inline mini-composer; the compose modal is reached via the expand control.
3. **Download All ships as cheap sequential downloads now.** A zip endpoint is a later
   API-side improvement, not part of this pass.

## Current state (audit summary)

- **Layout:** 3-pane. `apps/web/app/(app)/mail/page.tsx` (~1550-line monolith) renders the shell;
  `components/layout/Sidebar.tsx` (220px ↔ 60px collapsible, persisted), inline list wrapper around
  `components/mail/MailList.tsx` (fixed 300px), `components/mail/ThreadView.tsx` reading pane with
  `MailDetail.tsx` fallback.
- **Tokens:** Tailwind v4 CSS-first, all tokens in `apps/web/app/globals.css` (oklch).
  Palette: primary `#0F4C81` state blue, accent `#00A1DE`, success/warning/destructive,
  warm off-white background. Inter + JetBrains Mono. Dark mode via `.dark` class from
  `stores/theme.store.ts`.
- **Consistency debt:**
  - ~110 ad-hoc Tailwind palette classes bypassing tokens. Worst: `AttachmentTile.tsx` (~40),
    `ThreadView.tsx` (12), `ThreadMessage.tsx` (11), `MailList.tsx` (10, incl. bulk bar
    `bg-blue-500/10 text-blue-600`), `ThreadHeader.tsx` (6, status pills in raw `blue-400`/`amber-400`),
    offline banner `bg-amber-500/10 text-amber-700`.
  - Magic rem font sizes as a private type scale: `text-[0.719rem]`, `[0.781rem]`, `[0.656rem]`,
    `[0.5625rem]`, `[0.8125rem]`, `[0.9375rem]`, mixed with `text-xs`/`text-sm`.
  - Muted-text opacity at ten levels (`text-muted-foreground/30`–`/80`); borders at seven
    (`border-border/10`–`/60`).
  - shadcn `ui/` primitives barely used in mail: raw `<button>` everywhere, hand-rolled row
    checkbox, hand-rolled sidebar context menu, ComposeModal's own dropdowns.
  - Three avatar/initials implementations: `MailAvatar.tsx` (neutral, documented intent),
    `ThreadHeader.getInitials`, `ThreadView.pInitials`+`pColor` (saturated colored circles,
    contradicts MailAvatar).
  - Hardcoded rgb shadows in three places (active row, tab pill, Sidebar:302).
  - **Bugs:** `hsl(var(--x))` wrapping oklch variables — invalid, colors silently fail — in
    `globals.css` (ProseMirror blockquote + inline code) and `ComposeModal.tsx:1171`.
  - **Tablet gap:** sidebar renders only at `lg` while the reader splits at `md` — a band with
    no navigation.

## Workstreams

### A · Consistency foundation (Priority 1, effort M–L)

Mail surfaces: `MailList.tsx`, `ThreadView.tsx`, `ThreadHeader.tsx`, `ThreadMessage.tsx`,
`MailDetail.tsx`, `AttachmentTile.tsx`, `QuickReplyBar.tsx`, `Sidebar.tsx`, `ComposeModal.tsx`,
mail `page.tsx` header/banner regions.

1. **Tokens only.** Replace every raw Tailwind palette class with semantic tokens. Where a needed
   semantic doesn't exist (e.g., per-file-type attachment tints), add tokens to `globals.css`
   rather than keeping raw scales. Status pills (`N unread`, `Awaiting reply`) move to
   primary/warning tokens legible on the off-white ground.
2. **Named type scale.** Promote the de-facto magic sizes into five named steps defined in
   `globals.css` (`@theme`, as `--text-<step>` tokens with paired line-height, letter-spacing,
   and default weight). Replace all magic rem sizes in mail surfaces with the named steps.
   Sizes are rem-based so the existing root font-size setting (14–20px) keeps scaling them.

   | Step      | Size                | Weight        | Tracking            | Line-height | Used for / replaces |
   |-----------|---------------------|---------------|---------------------|-------------|---------------------|
   | `display` | 1.375rem (22px)     | 700           | −0.02em             | 1.2         | Pane/page headings ("Inbox"), empty states. Inter needs negative tracking at this size — this is the Image-3 headline look. |
   | `title`   | 0.9375rem (15px)    | 600           | −0.01em             | 1.35        | Thread subject, dialog/modal titles. Replaces `text-[0.9375rem]`. |
   | `body`    | 0.875rem (14px)     | 400 (600 emphasis) | 0              | 1.55        | Message bodies, compose text, list sender line (sender uses the 600 emphasis weight). Replaces `text-sm` drift and `text-[0.8125rem]` where it's running text. |
   | `ui`      | 0.8125rem (13px)    | 400 / 500     | 0                   | 1.4         | List subject + snippet, buttons, inputs, chips, meta lines. Replaces the `0.8125 / 0.781 / 0.719rem` cluster — subject vs snippet now differ by weight (500 vs 400) and muted tier, not by a 1px size step. |
   | `micro`   | 0.6875rem (11px)    | 500 / 600     | +0.06em when uppercase | 1.3      | Section headers (Today/Yesterday), badges, timestamps (`tabular-nums`). Replaces `0.656 / 0.5625rem`. |

   Rules: no arbitrary `text-[..rem]` values remain in mail surfaces; hierarchy inside a step is
   expressed with weight and muted tier, never a new size; uppercase text always takes the
   tracking bump; digits that align (dates, counts) always take `tabular-nums`.
3. **Three muted tiers.** Define secondary / tertiary / faint text tokens and strong / default /
   faint border tokens; collapse all opacity variants onto them.
4. **Adopt primitives.** Raw `<button>` → `Button` variants (ghost/icon sizes exist); pills →
   `Badge`; row checkbox → `ui/checkbox`; sidebar folder context menu → `ui/dropdown-menu`.
   Visual output should be near-identical — this is consolidation, not redesign.
5. **One avatar.** Fold `ThreadHeader` and `ThreadView` initials logic into `MailAvatar`
   (neutral treatment wins, per its documented intent). Overlapping participant stacks become
   a `MailAvatar` group variant.
6. **Shadow tokens.** Replace the three hardcoded rgb shadows with tokens derived from primary.
7. **Fix the two `hsl(oklch)` bugs** in `globals.css` and `ComposeModal.tsx:1171`.

App-wide planning constraint: token names, type steps, and muted tiers are chosen for the whole
app; only their *application* is limited to mail surfaces in this pass.

### B · Mini-composer (Priority 2, effort M — implemented last)

Upgrade `QuickReplyBar.tsx` into a docked mini-composer; it becomes the default reply path.

- Recipient chips with a Reply ↔ Reply-all switch, visible before sending.
- Compact formatting toolbar (bold, italic, list, link) shown when focused/expanded —
  reuse the existing TipTap setup, no second editor stack.
- Attachment + emoji affordances, primary Send button, ⌘↵ retained.
- Expand control opens `ComposeModal` seeded with the draft (existing escape hatch, kept).
- Thread toolbar Reply / Reply-all focus the inline composer instead of opening the modal.
- Visual weight: card surface, hairline border, subtle shadow.

### C · Icon rail polish (Priority 2, effort S)

`Sidebar.tsx` collapsed state.

- Unread count badge on the collapsed Inbox icon; unread dot on other folders.
- Tooltips on every rail item via `ui/tooltip`.
- Collapsed rail uses quiet monochrome icons with the active item in primary; colored icon
  chips may remain in the expanded state.
- Tablet fix: show the rail from `md` (reader already splits at `md`), full sidebar from `lg`.

### D · Attachment cards completed (Priority 3, effort S)

`AttachmentTile.tsx` + thread Attachments tab + per-message attachment strips.

- File size displayed on each tile.
- "Download All" on message attachment strips and the Attachments tab — sequential downloads
  of each attachment (no zip endpoint in this pass).
- Tile tint colors move onto tokens (delivered via workstream A).

## Sequencing

1. **A** — everything else lands on clean tokens.
2. **C** — small, visible, fixes the tablet gap.
3. **D** — additive.
4. **B** — largest UX change, benefits from settled primitives.

## Out of scope

- Message list row redesign (deselected).
- Activity-feed / productivity-inbox restructure (reference 2's model).
- Pane resizing / layout re-architecture (fixed 300px list stays).
- Consolidating the parallel readers `ThreadView` + `MailDetail` (~87 KB, duplicated email-CSS
  constants) — flagged for a future refactoring pass, not look-and-feel.
- Zip endpoint for Download All (future API work).
- Applying tokens/type scale beyond mail surfaces (future pass; naming designed for it now).

## Acceptance criteria

- No raw Tailwind palette classes (`blue-500`, `amber-400`, `slate-*`, etc.) remain in the mail
  surface components listed under workstream A; a grep for them in those files returns nothing.
- No arbitrary `text-[0.*rem]` sizes remain in those files; all text uses named steps.
- Muted text/borders use only the defined tiers.
- `MailAvatar` is the single initials/avatar implementation in mail surfaces.
- ProseMirror blockquote/inline-code colors render (bug fixed); ComposeModal:1171 renders.
- Collapsed rail shows Inbox unread badge and tooltips; a nav rail is visible at `md`.
- Attachment tiles show sizes; Download All fetches every attachment sequentially.
- Reply/Reply-all in the thread focus the inline mini-composer; expand opens ComposeModal
  with the draft carried over.
- Light and dark themes both verified on list, thread, rail, and mini-composer.

## Testing

- Existing vitest suite stays green (`apps/web`).
- Component-level: MailAvatar consolidation and QuickReplyBar reply-mode switch get unit tests.
- Visual verification in both themes at `md`, `lg`, and mobile widths (manual or via the run
  skill / browser screenshots) before each workstream is called done.
