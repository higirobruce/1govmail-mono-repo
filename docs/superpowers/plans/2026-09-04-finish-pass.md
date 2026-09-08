# 1Gov Mail Finish Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the look-and-feel gap between 1Gov Mail and its reference designs by enforcing one palette, one type scale, and one component language across the mail surfaces, then polishing the icon rail, attachment cards, and inline reply path.

**Architecture:** Four workstreams executed in order A → C → D → B. A adds semantic design tokens to `globals.css` (Tailwind v4 CSS-first) and migrates the mail components onto them file-by-file. C, D, and B are small feature deltas on top of components that already exist (collapsible sidebar, attachment tiles, inline ComposeModal).

**Tech Stack:** Next.js 16, Tailwind v4 (CSS-first `@theme`, no tailwind.config), shadcn/ui (new-york), TipTap v3.20, Zustand, vitest + jsdom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-04-finish-pass-design.md`

## Global Constraints

- Work directly on branch `ft-hyperscale` (user preference — no worktree).
- All paths below are relative to `apps/web/` unless prefixed with `docs/`.
- Run tests from `apps/web`: `npx vitest run <path>`. Full suite: `npx vitest run`.
- Type check: `npx tsc --noEmit` from `apps/web`.
- **Tailwind v4 note:** there is NO `tailwind.config.*`. All tokens live in `app/globals.css`. Static tokens (type scale, shadows) go in a plain `@theme { }` block; theme-varying colors go as CSS variables in `:root` / `.dark` plus a `--color-*: var(--*)` mapping line inside the existing `@theme inline { }` block (follow the pattern of `--color-success` there).
- **Dark mode** is a `.dark` class on the root (`@custom-variant dark`). Every new color token MUST have a `.dark` value.
- **The named type scale** (from the spec — steps generate `text-display`, `text-title`, `text-body`, `text-ui`, `text-micro` utilities that carry size + line-height + tracking + weight):

| Step | Size | Weight | Tracking | Line-height |
|---|---|---|---|---|
| `display` | 1.375rem | 700 | −0.02em | 1.2 |
| `title` | 0.9375rem | 600 | −0.01em | 1.35 |
| `body` | 0.875rem | 400 | 0 | 1.55 |
| `ui` | 0.8125rem | 400 | 0 | 1.4 |
| `micro` | 0.6875rem | 500 | 0 | 1.3 |

- **Magic-size mapping** (apply everywhere in mail surfaces; weight/tier expresses hierarchy within a step, never a new size):

| Old class | New class |
|---|---|
| `text-[0.9375rem]` | `text-title` |
| `text-sm` (in running text / message bodies) | `text-body` |
| `text-[0.8125rem]` | `text-ui` |
| `text-[0.781rem]` | `text-ui` |
| `text-[0.75rem]`, `text-xs` (buttons, chips, meta lines) | `text-ui` |
| `text-[0.719rem]` | `text-ui` |
| `text-[0.6875rem]` | `text-micro` |
| `text-[0.656rem]` | `text-micro` |
| `text-[0.625rem]` | `text-micro` |
| `text-[0.5625rem]` | `text-micro leading-none` (tiny badges) |
| `text-[1.375rem]` | `text-display` |

  Exception: sizes inside email-body iframes (`EMAIL_CSS`/`NORMALIZE_CSS` strings) and SVG `fontSize` attributes are rendering constants, not UI chrome — leave them.
  Uppercase labels additionally take `tracking-[0.06em]` (keep existing `tracking-wide(r)` occurrences by replacing them with `tracking-[0.06em]` for consistency).

- **Muted-tier mapping** (three text tiers below `text-foreground`, three border tiers):

| Old | New |
|---|---|
| `text-foreground/65`–`/85` | `text-foreground` (if it's a primary label) or `text-secondary` |
| `text-muted-foreground/70`–`/80`, bare `text-muted-foreground` | `text-secondary` |
| `text-muted-foreground/45`–`/65` | `text-tertiary` |
| `text-muted-foreground/28`–`/40`, `text-foreground/20`–`/30` | `text-faint` |
| `border-border/40`–`/60`, bare `border-border`, `border-input` | `border-border` |
| `border-border/10`–`/30` | `border-border-faint` |
| `bg-border` dividers at `/25`–`/50` | `bg-border-faint` |

- **No raw Tailwind palette classes** (`blue-*`, `amber-*`, `red-*`, `emerald-*`, `green-*`, `orange-*`, `violet-*`, `pink-*`, `slate-*`, `rose-*`, `cyan-*`, `indigo-*`, `yellow-*`) may remain in the workstream-A file list after migration. Semantic replacements are defined in Task 1.
- Every commit message ends with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 1: Design tokens in globals.css + the two silent color bugs

**Files:**
- Modify: `app/globals.css`
- Modify: `components/mail/ComposeModal.tsx:1183` (one line)

**Interfaces:**
- Produces (used by every later task): utilities `text-display|title|body|ui|micro`, `text-secondary|tertiary|faint`, `border-border-faint|border-strong`, `bg-warning-strong`/`text-warning-strong`, `text-file-{pdf,image,doc,sheet,slides,archive,media,generic}` + matching `bg-file-*` (usable as `bg-file-pdf/10`), `shadow-active-row`, `shadow-pill`.

- [ ] **Step 1: Add the static type-scale + shadow tokens**

In `app/globals.css`, directly after the closing `}` of the existing `@theme inline { ... }` block (line 51), add:

```css
/* ── Named type scale — the ONLY text sizes used in app chrome ──────────────
 * display > title > body > ui > micro. Hierarchy within a step is expressed
 * with font-weight and the muted text tiers, never with a new size. */
@theme {
  --text-display: 1.375rem;
  --text-display--line-height: 1.2;
  --text-display--letter-spacing: -0.02em;
  --text-display--font-weight: 700;

  --text-title: 0.9375rem;
  --text-title--line-height: 1.35;
  --text-title--letter-spacing: -0.01em;
  --text-title--font-weight: 600;

  --text-body: 0.875rem;
  --text-body--line-height: 1.55;

  --text-ui: 0.8125rem;
  --text-ui--line-height: 1.4;

  --text-micro: 0.6875rem;
  --text-micro--line-height: 1.3;
  --text-micro--font-weight: 500;

  /* Shadows — tinted from primary via color-mix so they re-theme */
  --shadow-active-row: 0 2px 8px color-mix(in oklch, var(--primary) 8%, transparent);
  --shadow-pill: 0 1px 2px color-mix(in oklch, var(--foreground) 6%, transparent);
}
```

- [ ] **Step 2: Add the theme-varying color tokens**

Inside the existing `@theme inline { ... }` block, after the `--color-warning-foreground` line (line 36), add exactly this set (names chosen to avoid the already-taken `--color-secondary`/`--color-muted-foreground` and to read naturally in markup):

```css
  --color-warning-strong: var(--warning-strong);
  --color-ink-2: var(--ink-2);
  --color-ink-3: var(--ink-3);
  --color-ink-4: var(--ink-4);
  --color-border-strong: var(--border-strong);
  --color-border-faint: var(--border-faint);
  --color-file-pdf: var(--file-pdf);
  --color-file-image: var(--file-image);
  --color-file-doc: var(--file-doc);
  --color-file-sheet: var(--file-sheet);
  --color-file-slides: var(--file-slides);
  --color-file-archive: var(--file-archive);
  --color-file-media: var(--file-media);
  --color-file-generic: var(--file-generic);
```

Utilities become `text-ink-2` (secondary), `text-ink-3` (tertiary), `text-ink-4` (faint), `border-border-faint`, `text-file-pdf`, `bg-file-pdf/10`, etc. **Wherever this plan's mapping tables say `text-secondary`/`text-tertiary`/`text-faint`, write `text-ink-2`/`text-ink-3`/`text-ink-4`.**

- [ ] **Step 3: Define the variable values in `:root` and `.dark`**

In `:root` (after `--warning-foreground`, line 95):

```css
  --warning-strong:       oklch(0.55 0.13 80);    /* darker gold — legible text on light tints */

  /* Muted text tiers — replaces the /30–/80 opacity soup */
  --ink-2:                oklch(0.45 0.015 252);  /* secondary — labels, meta          */
  --ink-3:                oklch(0.55 0.012 250);  /* tertiary — snippets, timestamps   */
  --ink-4:                oklch(0.68 0.010 250);  /* faint — placeholders, disabled    */

  --border-strong:        oklch(0.85 0.008 240);
  --border-faint:         oklch(0.94 0.005 240);

  /* Attachment file-type accents */
  --file-pdf:             oklch(0.55 0.18 25);
  --file-image:           oklch(0.55 0.13 160);
  --file-doc:             oklch(0.50 0.13 255);
  --file-sheet:           oklch(0.48 0.12 150);
  --file-slides:          oklch(0.62 0.15 55);
  --file-archive:         oklch(0.60 0.13 85);
  --file-media:           oklch(0.55 0.16 300);
  --file-generic:         oklch(0.50 0.012 250);
```

In `.dark` (after `--warning-foreground`, line 142):

```css
  --warning-strong:       oklch(0.80 0.13 80);

  --ink-2:                oklch(0.75 0.010 245);
  --ink-3:                oklch(0.62 0.010 245);
  --ink-4:                oklch(0.48 0.010 245);

  --border-strong:        oklch(0.32 0.016 255);
  --border-faint:         oklch(0.20 0.014 255);

  --file-pdf:             oklch(0.70 0.16 25);
  --file-image:           oklch(0.72 0.13 160);
  --file-doc:             oklch(0.72 0.12 255);
  --file-sheet:           oklch(0.70 0.12 150);
  --file-slides:          oklch(0.74 0.14 55);
  --file-archive:         oklch(0.78 0.12 85);
  --file-media:           oklch(0.72 0.14 300);
  --file-generic:         oklch(0.70 0.010 245);
```

- [ ] **Step 4: Fix the `hsl(oklch)` bugs**

In `app/globals.css`:
- Line 265: `border-left: 2px solid hsl(var(--border));` → `border-left: 2px solid var(--border);`
- Line 267: `color: hsl(var(--muted-foreground));` → `color: var(--muted-foreground);`
- Line 345: `background: hsl(var(--muted));` → `background: var(--muted);`
- Line 346: `color: hsl(var(--foreground));` → `color: var(--foreground);`

In `components/mail/ComposeModal.tsx` line 1183:
`style={{ backgroundColor: currentColor ?? 'hsl(var(--foreground))' }}` → `style={{ backgroundColor: currentColor ?? 'var(--foreground)' }}`

- [ ] **Step 5: Verify the app compiles and utilities resolve**

Run from `apps/web`: `npx tsc --noEmit` (expect: clean) and `grep -c "hsl(var(" app/globals.css components/mail/ComposeModal.tsx` (expect: `0` for both files).
Then start the dev server briefly (`pnpm dev`, Ctrl-C after it compiles `/mail`) OR run `pnpm build` — expect no CSS errors.

- [ ] **Step 6: Commit**

```bash
git add app/globals.css components/mail/ComposeModal.tsx
git commit -m "feat(mail): named type scale, muted tiers, file-type + warning-strong tokens; fix hsl(oklch) bugs"
```

---

### Task 2: One avatar implementation

**Files:**
- Modify: `components/mail/MailAvatar.tsx` (export `getInitials`)
- Modify: `components/mail/ThreadHeader.tsx:31-39` (delete dead local `getInitials`)
- Modify: `components/mail/ThreadView.tsx:464-466, 565-566, 600-601` (replace `pColor`/`pInitials` circles with `MailAvatar`)
- Modify: `components/mail/ThreadMessage.tsx:384-392, 539, 568` (use imported `getInitials`)
- Test: `components/mail/MailAvatar.test.tsx` (create)

**Interfaces:**
- Produces: `export function getInitials(name: string | null | undefined, email: string): string` from `components/mail/MailAvatar.tsx` (rename of the existing private `initials`).

- [ ] **Step 1: Write the failing test**

Create `components/mail/MailAvatar.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MailAvatar, getInitials } from './MailAvatar';

describe('getInitials', () => {
  it('uses first + last name initials', () => {
    expect(getInitials('Ronald Richards', 'r@x.rw')).toBe('RR');
  });
  it('uses first two letters of a single name', () => {
    expect(getInitials('Ronald', 'r@x.rw')).toBe('RO');
  });
  it('falls back to the email local part', () => {
    expect(getInitials(null, 'bruce.higiro@risa.gov.rw')).toBe('BR');
  });
});

describe('MailAvatar', () => {
  it('renders neutral initials for a person', () => {
    const { container } = render(<MailAvatar name="Jane Doe" email="jane@x.rw" />);
    expect(container.textContent).toBe('JD');
  });
  it('renders a mail glyph for system senders', () => {
    const { container } = render(<MailAvatar email="noreply@x.rw" />);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(container.textContent).toBe('');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`getInitials` is not exported)

`npx vitest run components/mail/MailAvatar.test.tsx` — expect: `getInitials` import error.

- [ ] **Step 3: Export the helper**

In `MailAvatar.tsx`, rename `function initials(` to `export function getInitials(` and update its two call sites in the same file.

- [ ] **Step 4: Run the test — expect PASS**

- [ ] **Step 5: Delete the duplicates**

1. `ThreadHeader.tsx`: delete the local `getInitials` function (lines 31–39) — it is dead code (participants already render `MailAvatar`).
2. `ThreadMessage.tsx`: delete the local `getInitials` (lines 384–392) and add `getInitials` to the existing `import { MailAvatar } from './MailAvatar';` line: `import { MailAvatar, getInitials } from './MailAvatar';`. The draft-avatar div (line 568) and `initials` const (line 539) keep working unchanged.
3. `ThreadView.tsx`: delete `P_COLORS`, `pColor`, `pInitials` (lines 464–466). In the Overview participants list, replace both colored-circle divs:

```tsx
// was: <div className={cn('w-7 h-7 rounded-full ... text-white ...', pColor(p.email))}>{pInitials(p.name, p.email)}</div>
<MailAvatar name={p.name} email={p.email} size="sm" />
```

For the CC list keep the reduced emphasis: `<MailAvatar name={p.name} email={p.email} size="sm" className="opacity-70" />`.

- [ ] **Step 6: Verify**

`npx vitest run components/mail` and `npx tsc --noEmit` — expect: PASS / clean. `grep -rn "pColor\|pInitials" components/` — expect: no matches.

- [ ] **Step 7: Commit**

```bash
git add components/mail/MailAvatar.tsx components/mail/MailAvatar.test.tsx components/mail/ThreadHeader.tsx components/mail/ThreadView.tsx components/mail/ThreadMessage.tsx
git commit -m "refactor(mail): single getInitials/MailAvatar source; neutral avatars in thread overview"
```

---

### Task 3: Migrate MailList + mail page banner onto tokens, scale, and primitives

**Files:**
- Modify: `components/mail/MailList.tsx`
- Modify: `app/(app)/mail/page.tsx:1333-1334` (offline banner)

**Interfaces:**
- Consumes: Task 1 utilities.

- [ ] **Step 1: Semantic color replacements in `MailList.tsx`**

| Line | Old | New |
|---|---|---|
| 37 | `text-amber-600 dark:text-amber-400` / `bg-amber-500` (waitingOnYou) | `text-warning-strong` / `bg-warning-strong` |
| 38 | `text-blue-600 dark:text-blue-400` / `bg-blue-500` (deadline) | `text-primary` / `bg-primary` |
| 315 | `shadow-[0_2px_8px_rgba(15,76,129,0.08)]` | `shadow-active-row` |
| 409 | `text-amber-500` (AlertTriangle) | `text-warning-strong` |
| 618 | `shadow-[0_1px_2px_rgba(0,0,0,0.06)]` | `shadow-pill` |
| 698 | `bg-blue-500/10 text-blue-600 hover:bg-blue-500/20` (bulk Mark read) | `bg-primary/10 text-primary hover:bg-primary/20` |

- [ ] **Step 2: Type scale + tiers in `MailList.tsx`**

Apply the global mapping tables. The significant rows:
- Sender (364): `text-[0.8125rem]` → `text-ui`; read state `text-foreground/85 font-normal` → `text-foreground`.
- Date (371): `text-[0.6875rem]` → `text-micro`; read tint `text-muted-foreground/60` → `text-ink-3`.
- Subject (379): `text-[0.781rem]` → `text-ui`; read `text-foreground/70` → `text-ink-2`; unread keeps `text-foreground font-semibold`. **Subject and snippet are now the same size — weight + tier carry the difference.**
- Snippet (385): `text-[0.719rem] text-muted-foreground/70` → `text-ui font-normal text-ink-3`.
- Section header (132): `text-[0.656rem] ... text-muted-foreground/55 ... tracking-[0.06em]` → `text-micro font-semibold text-ink-3 uppercase tracking-[0.06em]`.
- Chips (393, 400): `text-[0.625rem]` → `text-micro`; `text-muted-foreground/80` → `text-ink-2`.
- Tabs (616): `text-[0.75rem]` → `text-ui font-medium`; inactive `text-muted-foreground/80` → `text-ink-2`.
- Context-menu items (203, 258): `text-[0.8125rem]`/`text-[0.75rem]` → `text-ui`; `text-foreground/80` → `text-ink-2` (hover states unchanged in intent: `hover:text-foreground`).
- Bulk bar (693, 698, 704, 710): `text-[0.75rem]` → `text-ui`; `text-foreground/70` → `text-ink-2`.
- Load-more / footer (668, 673): `text-[0.6875rem]` → `text-micro`; tiers per table.
- All `text-muted-foreground/NN` and `border-border/NN` occurrences per the global tier tables.

- [ ] **Step 3: Row checkbox → `ui/checkbox`**

Replace the hand-rolled checkbox (lines 328–347) with the shadcn primitive:

```tsx
import { Checkbox } from '@/components/ui/checkbox';
```

```tsx
<Checkbox
  checked={!!selected}
  onCheckedChange={() => onSelect?.()}
  onClick={(e) => e.stopPropagation()}
  aria-label={selected ? 'Deselect message' : 'Select message'}
  className={cn(
    'shrink-0 mt-[3px] transition-opacity',
    selected || active ? 'opacity-100' : 'opacity-50 group-hover:opacity-100',
  )}
/>
```

Delete the old `<button>` + inline SVG block entirely.

- [ ] **Step 4: Bulk bar buttons → `Button`**

Import `Button` from `@/components/ui/button`. Replace the four raw buttons (lines 696–719):

```tsx
<Button variant="ghost" size="xs" className="bg-primary/10 text-primary hover:bg-primary/20"
  onClick={() => { onBulkAction?.({ type: 'markRead', messageIds: [...selectedIds] }); clearSelection(); }}>
  Mark read
</Button>
<Button variant="secondary" size="xs"
  onClick={() => { onBulkAction?.({ type: 'markUnread', messageIds: [...selectedIds] }); clearSelection(); }}>
  Mark unread
</Button>
<Button variant="destructive-ghost" size="xs" className="bg-destructive/10 text-destructive hover:bg-destructive/20"
  onClick={() => { onBulkAction?.({ type: 'delete', messageIds: [...selectedIds] }); clearSelection(); }}>
  Delete
</Button>
<Button variant="ghost" size="icon-xs" onClick={clearSelection} aria-label="Clear selection">
  <X />
</Button>
```

- [ ] **Step 5: Offline banner in `page.tsx`**

Lines 1333–1334: `bg-amber-500/10 text-amber-700 dark:text-amber-300 border-b border-amber-500/20` → `bg-warning/10 text-warning-strong border-b border-warning/20`; dot `bg-amber-500` → `bg-warning-strong`; `text-[0.75rem]` → `text-ui`.

- [ ] **Step 6: Verify**

From `apps/web`:
```bash
grep -nE "text-\[0\.[0-9]+rem\]|(blue|amber|red|emerald|green|orange|violet|pink|slate|rose|cyan|indigo|yellow)-[0-9]" components/mail/MailList.tsx
```
Expect: no matches. `npx tsc --noEmit` clean. `npx vitest run` green. Load `/mail` in the dev server: list renders, checkbox selects, bulk bar works, tabs switch.

- [ ] **Step 7: Commit**

```bash
git add components/mail/MailList.tsx "app/(app)/mail/page.tsx"
git commit -m "refactor(mail): MailList + offline banner on named type scale, ink tiers, ui primitives"
```

---

### Task 4: Migrate ThreadHeader + ThreadView

**Files:**
- Modify: `components/mail/ThreadHeader.tsx`
- Modify: `components/mail/ThreadView.tsx`

- [ ] **Step 1: Status pills in `ThreadHeader.deriveStatus` (lines 41–62)**

```ts
if (unreadCount > 0) {
  return { label: `${unreadCount} unread`,
    className: 'bg-primary/10 text-primary border border-primary/20' };
}
if (lastSenderEmail.toLowerCase() === currentUserEmail.toLowerCase()) {
  return { label: 'You replied',
    className: 'bg-muted text-ink-3 border border-border' };
}
return { label: 'Awaiting reply',
  className: 'bg-warning/10 text-warning-strong border border-warning/20' };
```

- [ ] **Step 2: ThreadHeader scale/tiers/primitives**

- Subject (113): `text-[0.9375rem] font-semibold` → `text-title` (weight comes with the step).
- Pill (118): `text-[0.625rem]` → `text-micro`.
- Meta line (155): `text-[0.6875rem] text-muted-foreground/50` → `text-micro font-normal text-ink-3`.
- `+N` circle (150): `text-[0.5625rem]` → `text-micro leading-none`; `text-muted-foreground` → `text-ink-2`.
- Close + toolbar icon buttons (99–105, 172–178, 202–208): replace each raw `<button className="p-1.5 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted ...">` with `<Button variant="ghost" size="icon-sm" className="text-ink-3 hover:text-foreground">` (import `Button`; keep the existing `onClick`/`aria-label`/Tooltip wrappers — `TooltipTrigger asChild` composes with `Button` directly).
- Summarize pill (186–197): `text-[0.75rem]` → `text-ui font-medium`; colors already tokenized — keep.
- Tier/border sweep per global tables (e.g. `border-border/30` → `border-border-faint`).

- [ ] **Step 3: ThreadView file-type icons (GroupIcon, lines 78–89)**

```tsx
case 'Images':        return <ImageIcon className={cn(cls, 'text-file-image')} />;
case 'PDFs':          return <FileText className={cn(cls, 'text-file-pdf')} />;
case 'Documents':     return <FileText className={cn(cls, 'text-file-doc')} />;
case 'Spreadsheets':  return <Table2 className={cn(cls, 'text-file-sheet')} />;
case 'Presentations': return <Presentation className={cn(cls, 'text-file-slides')} />;
case 'Archives':      return <Archive className={cn(cls, 'text-file-archive')} />;
default:              return <File className={cn(cls, 'text-file-generic')} />;
```

- [ ] **Step 4: ThreadView scale/tier sweep**

Apply the global mapping tables through the whole file. Notable rows: tab buttons (504) `text-[0.75rem]` → `text-ui font-medium`; stats value (547) `text-[1.375rem] font-semibold` → `text-display font-semibold` (keep semibold override); section labels (557, 631, 693) → `text-micro font-semibold text-ink-3 uppercase tracking-[0.06em]`; summary body (1014) `text-[0.781rem] text-foreground/85` → `text-ui text-foreground`; every `text-[0.8125rem]`/`text-[0.75rem]`/`text-[0.6875rem]`/`text-[0.625rem]` per table; `text-muted-foreground/NN` + `border-border/NN` per tier tables. Raw icon buttons on attachment rows (876–909, 921–941) → `Button variant="ghost" size="icon-xs"` with `text-ink-3`.

Also fix the wrong icon at line 940: the preview-panel Close button renders `<Download className="w-3.5 h-3.5 rotate-180" />` — replace with `<XIconSmall className="w-3.5 h-3.5" />` (already imported as `XIconSmall`).

- [ ] **Step 5: Verify**

```bash
grep -nE "text-\[0\.[0-9]+rem\]|text-\[1\.375rem\]|(blue|amber|red|emerald|green|orange|violet|pink|slate|rose|cyan|indigo|yellow)-[0-9]" components/mail/ThreadHeader.tsx components/mail/ThreadView.tsx
```
Expect: no matches. `npx tsc --noEmit` clean, `npx vitest run` green. In dev: open a threaded message — header pills, tabs, overview, attachments tab all render in both themes.

- [ ] **Step 6: Commit**

```bash
git add components/mail/ThreadHeader.tsx components/mail/ThreadView.tsx
git commit -m "refactor(mail): ThreadHeader + ThreadView on tokens — status pills, file-type colors, type scale"
```

---

### Task 5: Migrate ThreadMessage + MailDetail + AttachmentTile

**Files:**
- Modify: `components/mail/AttachmentTile.tsx`
- Modify: `components/mail/ThreadMessage.tsx`
- Modify: `components/mail/MailDetail.tsx`

- [ ] **Step 1: `fileTypeStyle` onto file tokens (AttachmentTile.tsx lines 29–56)**

Replace every branch's `color`/`bgTint` pair with token classes (dark variants no longer needed — tokens theme themselves):

| Branch | color | bgTint |
|---|---|---|
| PDF | `text-file-pdf` | `bg-file-pdf/10` |
| image | `text-file-image` | `bg-file-image/10` |
| word/doc | `text-file-doc` | `bg-file-doc/10` |
| sheet/csv | `text-file-sheet` | `bg-file-sheet/10` |
| presentation | `text-file-slides` | `bg-file-slides/10` |
| archive | `text-file-archive` | `bg-file-archive/10` |
| audio/video | `text-file-media` | `bg-file-media/10` |
| text + fallback | `text-file-generic` | `bg-file-generic/10` |

Also: hover shadow (173) `hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)]` → `hover:shadow-active-row`; filename pill (208–212) `text-[0.656rem]` → `text-micro font-normal`, `text-[0.5625rem]` → `text-micro leading-none`, `text-foreground/80` → `text-ink-2`.

- [ ] **Step 2: ThreadMessage draft/star colors + scale**

- Draft row bg (557): `bg-amber-50/40 dark:bg-amber-900/10` → `bg-warning/5`.
- Draft avatar (568): `bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400` → `bg-warning/15 text-warning-strong`.
- Draft badge (590): same substitution; `text-[0.625rem]` → `text-micro leading-none`.
- Star (787, 791): `text-amber-400` → `text-warning-strong`; `fill-amber-400` → `fill-warning-strong`.
- Footer buttons (758–778): → `Button variant="ghost" size="xs" className="text-ink-2 hover:text-foreground"`; star/delete icon buttons (782–808) → `Button variant="ghost" size="icon-sm"` (delete keeps `variant="destructive-ghost"`).
- Full scale/tier sweep per global tables (skip `EMAIL_CSS` / `NORMALIZE_CSS` / `HIDE_QUOTES_CSS` strings — iframe constants).
- `components/mail/ThreadMessage.test.tsx` exists: run it after the edit and fix any selector that matched removed markup.

- [ ] **Step 3: MailDetail sweep**

Apply the same color/scale/tier/primitive treatment across `MailDetail.tsx` (979 lines; same patterns: raw icon buttons → `Button variant="ghost" size="icon-sm"`, magic rems → steps, opacity tiers → ink tokens, any raw palette classes → semantic tokens using the same substitutions as above; skip its email-iframe CSS constants).

- [ ] **Step 4: Verify**

```bash
grep -nE "text-\[0\.[0-9]+rem\]|(blue|amber|red|emerald|green|orange|violet|pink|slate|rose|cyan|indigo|yellow)-[0-9]" components/mail/AttachmentTile.tsx components/mail/ThreadMessage.tsx components/mail/MailDetail.tsx | grep -v "EMAIL_CSS\|NORMALIZE_CSS\|font-family\|#"
```
Expect: no class-name matches (iframe CSS string hits are fine — they contain `#hex`, not Tailwind classes). `npx vitest run components/mail` green. `npx tsc --noEmit` clean. Dev check: expanded message card, attachments, draft row, single-message fallback all render in both themes.

- [ ] **Step 5: Commit**

```bash
git add components/mail/AttachmentTile.tsx components/mail/ThreadMessage.tsx components/mail/MailDetail.tsx
git commit -m "refactor(mail): ThreadMessage, MailDetail, AttachmentTile on tokens and named scale"
```

---

### Task 6: Migrate Sidebar — tokens, scale, folder menu → DropdownMenu

**Files:**
- Modify: `components/layout/Sidebar.tsx`

- [ ] **Step 1: Scale/tier sweep**

Per global tables: all `text-[0.8125rem]` → `text-ui`, `text-[0.75rem]` → `text-ui`, `text-[0.6875rem]` → `text-micro`, `text-[0.625rem]` → `text-micro`; `text-foreground/65` → `text-ink-2`, `text-foreground/28`/`/20` (comingSoon) → `text-ink-4`, `text-muted-foreground/NN` per tiers; `border-border/NN` per tiers; label checked shadow (306) `shadow-[0_0_0_1px_rgba(0,0,0,0.04)]` → `shadow-pill`. Labels header (669) gets `text-micro font-semibold uppercase tracking-[0.06em] text-ink-3`. `OfflineStatusPill` tone (363) `text-amber-600 dark:text-amber-400` → `text-warning-strong`.

- [ ] **Step 2: Folder context menu → `ui/dropdown-menu`**

Replace the hand-rolled `FolderContextMenu` portal (lines 43–121) with the shadcn `DropdownMenu` rendered once at the sidebar root, anchored at the cursor:

```tsx
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
```

```tsx
{folderMenu && (
  <DropdownMenu open onOpenChange={(o) => { if (!o) setFolderMenu(null); }}>
    <DropdownMenuTrigger asChild>
      {/* invisible anchor at the click position */}
      <span style={{ position: 'fixed', top: folderMenu.y, left: folderMenu.x, width: 0, height: 0 }} />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-[160px]">
      {!folderMenu.folder.isSystem && onRenameFolder && (
        <DropdownMenuItem onSelect={() => openRenameInline(folderMenu.folder.id, folderMenu.folder.name)}>
          <Pencil /> Rename
        </DropdownMenuItem>
      )}
      {onEmptyFolder && EMPTYABLE_PATHS_OR_CUSTOM && (
        <DropdownMenuItem onSelect={() => openEmptyConfirm(folderMenu.folder.id, folderMenu.folder.name)}>
          <Trash2 /> Empty folder
        </DropdownMenuItem>
      )}
      {!folderMenu.folder.isSystem && onDeleteFolder && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive"
            onSelect={() => handleDeleteFolder(folderMenu.folder.id, folderMenu.folder.name)}>
            <X /> Delete folder
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  </DropdownMenu>
)}
```

Notes: `EMPTYABLE_PATHS_OR_CUSTOM` above stands for the existing availability logic — system folders show Empty only when in `EMPTYABLE_PATHS` (the current call sites already gate this by only offering the menu there); replicate the current option availability exactly: system rows pass `isSystem: true` and offered `onEmpty` only; custom rows offer rename/empty/delete as the current `FolderContextMenu` props do. Delete the whole `FolderContextMenu` component and its `createPortal` import if now unused. If `components/ui/dropdown-menu.tsx`'s `DropdownMenuItem` has no `variant` prop, use `className="text-destructive focus:text-destructive focus:bg-destructive/10"` instead.

**Deviation note (MailList):** the message-row right-click menu in `MailList.tsx` stays hand-rolled — it has no visible trigger element and a folder submenu; converting it to Radix is a behavior change outside this pass. It was tokenized in Task 3, which satisfies the visual goal.

- [ ] **Step 3: Raw buttons → `Button`**

Compose button (598–609) → `<Button variant="ghost" className="w-full justify-start gap-2 bg-primary/10 hover:bg-primary/20 text-primary text-ui font-medium h-8">` (keep collapsed centering via the existing `cn(collapsed ? 'justify-center px-0' : 'px-3')`). Collapse toggle (585), theme cycle (814), tour (822), small icon buttons (`+`, `X` in labels header) → `Button variant="ghost"` with matching `size` (`icon-xs` for the tiny ones). `NavItem`'s root `<button>` stays raw (it is a bespoke nav row, not a Button variant) but takes the tier/scale sweep.

- [ ] **Step 4: Verify**

```bash
grep -nE "text-\[0\.[0-9]+rem\]|(blue|amber|red|emerald|green|orange|violet|pink|slate|rose|cyan|indigo|yellow)-[0-9]" components/layout/Sidebar.tsx
```
Expect: no matches. `npx tsc --noEmit` clean, `npx vitest run` green. Dev: folder ⋯ menu and right-click menu open at the cursor, rename/empty/delete work, collapse toggle works.

- [ ] **Step 5: Commit**

```bash
git add components/layout/Sidebar.tsx
git commit -m "refactor(mail): Sidebar on tokens + named scale; folder menu on ui/dropdown-menu"
```

---

### Task 7: Workstream A closeout — ComposeModal sweep + acceptance greps

**Files:**
- Modify: `components/mail/ComposeModal.tsx` (scale/tier sweep)
- Others only if greps surface stragglers

- [ ] **Step 0: ComposeModal scale + tier sweep**

Apply the global magic-size and muted-tier mapping tables across `ComposeModal.tsx` (`text-[0.6875rem]` → `text-micro`, `text-xs`/`text-sm` on chrome → `text-ui`/`text-body` per role, `text-muted-foreground/NN` → ink tiers, `border-border/NN` → border tiers). Skip: TipTap editor content styling, the `buildHtmlBody` quoted-mail inline styles (they travel inside sent emails — rendering constants), and `FONT_SIZES`/`FONT_FAMILIES` (user-facing email fonts). While there, convert standalone pill `<span>`s whose shape matches `Badge` (attachment pills, lines 1117–1138) to `<Badge variant="secondary" className=...>` — keep the remove buttons as children.

- [ ] **Step 1: Acceptance greps across the full workstream-A file list**

From `apps/web`:

```bash
FILES="components/mail/MailList.tsx components/mail/ThreadView.tsx components/mail/ThreadHeader.tsx components/mail/ThreadMessage.tsx components/mail/MailDetail.tsx components/mail/AttachmentTile.tsx components/mail/ComposeModal.tsx components/layout/Sidebar.tsx"
grep -nE "text-\[[01]\.[0-9]+rem\]" $FILES
grep -nE "(blue|amber|red|emerald|green|orange|violet|pink|slate|rose|cyan|indigo|yellow)-[0-9]{2,3}" $FILES
grep -nE "shadow-\[0" $FILES
grep -nE "text-muted-foreground/[0-9]|text-foreground/[0-9]" $FILES
```

Expected: zero matches from each (iframe-CSS constants inside template strings don't contain Tailwind classes, so they can't false-positive; if any hit remains, fix it using the global tables).

- [ ] **Step 2: Full test suite + types**

`npx vitest run` — all green. `npx tsc --noEmit` — clean.

- [ ] **Step 3: Visual check, both themes**

Run the app (`pnpm dev`), open `/mail`: check list, thread, overview tab, attachments tab, sidebar, compose modal in light AND dark (cycle via the sidebar theme button). Verify ProseMirror blockquote + inline code now render with visible border/background in compose (the fixed bug).

- [ ] **Step 4: Commit any straggler fixes**

```bash
git add -A && git commit -m "refactor(mail): workstream A stragglers — token/scale acceptance pass"
```
(Skip the commit if the tree is clean.)

---

### Task 8: Icon rail polish (Workstream C)

**Files:**
- Modify: `components/layout/Sidebar.tsx`

**Interfaces:**
- Consumes: `useUIStore().sidebarCollapsed`, `ui/tooltip`, `ui/badge`.

- [ ] **Step 1: Tablet rail — sidebar visible from `md`, rail-only between `md` and `lg`**

In `Sidebar` add a viewport hook (top of the component file, below imports):

```tsx
/** true between md (768px) and lg (1024px) — the band where only the rail fits */
function useIsTabletBand(): boolean {
  const [tablet, setTablet] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px) and (max-width: 1023.98px)');
    const update = () => setTablet(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return tablet;
}
```

In the component body:

```tsx
const isTablet = useIsTabletBand();
const railMode = collapsed || isTablet;   // effective collapsed state
```

Root div changes: `data-collapsed={railMode}`, class `hidden lg:flex` → `hidden md:flex`, width `collapsed ? 'w-[60px]' : 'w-[220px]'` → `railMode ? 'w-[60px]' : 'w-[220px]'`. Replace every other `collapsed ?` conditional in the JSX with `railMode ?` (header padding, compose button, labels section gate `!collapsed &&` → `!railMode &&`). Hide the collapse toggle in the tablet band (it can't expand there): wrap the toggle button in `{!isTablet && (...)}`.

NOTE: `MobileSidebarSheet` passes `className` to override `hidden` for the mobile drawer — confirm it still renders full-width inside the Sheet (it passes `flex` via className and `collapsed` comes from the store; inside the Sheet the viewport is `< md` so `isTablet` is false — unchanged behavior).

- [ ] **Step 2: Numeric unread badge on the collapsed Inbox icon**

In `NavItem`, add prop `collapsedBadge?: 'count' | 'dot'` (default `'dot'`). Replace the current collapsed dot (line 257):

```tsx
{collapsedBadge === 'count' ? (
  <span className="hidden group-data-[collapsed=true]/sidebar:flex absolute top-0.5 right-1 min-w-4 h-4 px-1 items-center justify-center rounded-full bg-primary text-primary-foreground text-micro leading-none font-semibold tabular-nums">
    {unread > 99 ? '99+' : unread}
  </span>
) : (
  <span className="hidden group-data-[collapsed=true]/sidebar:block absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full bg-primary" />
)}
```

Pass `collapsedBadge="count"` for the Inbox `NavItem` only (the `systemFolders.map` call sites — add `collapsedBadge={folder.id === 'inbox' || folder.path === '/Inbox' ? 'count' : 'dot'}`).

- [ ] **Step 3: Tooltips in rail mode**

Pass `railMode` into `NavItem` as prop `collapsed?: boolean`. Wrap the returned `<button>`:

```tsx
if (collapsed) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" className="text-xs">{label}{unread ? ` (${unread})` : ''}</TooltipContent>
    </Tooltip>
  );
}
return button;
```

(Extract the current JSX into a `const button = (...)` first; remove the `title={label}` attribute so tooltip and title don't double up.) Import `Tooltip, TooltipContent, TooltipTrigger` from `@/components/ui/tooltip`. Give the compose, theme, tour, and collapse-toggle buttons the same treatment (tooltip only when `railMode`).

- [ ] **Step 4: Monochrome icons in rail mode**

In `NavItem`, when `collapsed` is true render the plain icon even when `iconBg` is set:

```tsx
{iconBg && !collapsed ? (
  <FolderIcon icon={Icon} bg={iconBg} />
) : (
  <Icon className={cn('w-4 h-4 shrink-0',
    active ? 'text-primary' : comingSoon ? 'text-ink-4' : 'text-ink-3 group-hover:text-ink-2')} />
)}
```

The colored chips remain in the expanded sidebar.

- [ ] **Step 5: Verify**

`npx tsc --noEmit` clean; `npx vitest run stores/ui.store.test.ts` green. Dev checks: resize the window — at 800–1023px a rail (not nothing) shows next to the split reader; at ≥1024px full sidebar with working collapse toggle; collapsed Inbox shows a numeric badge; rail icons are monochrome with tooltips; mobile (<768px) still uses the hamburger Sheet with the full sidebar.

- [ ] **Step 6: Commit**

```bash
git add components/layout/Sidebar.tsx
git commit -m "feat(mail): icon rail polish — md tablet rail, inbox count badge, tooltips, monochrome rail icons"
```

---

### Task 9: Attachment cards completed (Workstream D)

**Files:**
- Create: `lib/downloadAll.ts`
- Test: `lib/downloadAll.test.ts` (create)
- Modify: `components/mail/AttachmentTile.tsx` (size line)
- Modify: `components/mail/ThreadMessage.tsx` (strip header button)
- Modify: `components/mail/ThreadView.tsx` (attachments tab button)
- Modify: `components/mail/MailDetail.tsx` (attachments bar button)

**Interfaces:**
- Produces: `downloadAll(attachments: Array<{ messageId: string; id: string; filename: string }>, getUrl: (messageId: string, attachmentId: string) => Promise<string>, opts?: { delayMs?: number; onError?: (filename: string) => void }): Promise<number>` — sequentially fetches each URL and triggers an anchor download; returns the count downloaded; skips (and reports) failures without aborting the rest.
- Consumes: `getAttachmentUrl` from `@/lib/attachmentBlobCache`, `api.mail.downloadAttachment`.

- [ ] **Step 1: Write the failing test**

Create `lib/downloadAll.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { downloadAll } from './downloadAll';

const atts = [
  { messageId: 'm1', id: 'a1', filename: 'one.pdf' },
  { messageId: 'm1', id: 'a2', filename: 'two.png' },
  { messageId: 'm2', id: 'a3', filename: 'three.zip' },
];

describe('downloadAll', () => {
  it('downloads every attachment sequentially and returns the count', async () => {
    const order: string[] = [];
    const getUrl = vi.fn(async (_mid: string, aid: string) => { order.push(aid); return `blob:${aid}`; });
    const clicks: string[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    const n = await downloadAll(atts, getUrl, { delayMs: 0 });
    expect(n).toBe(3);
    expect(order).toEqual(['a1', 'a2', 'a3']);
    expect(clicks).toEqual(['one.pdf', 'two.png', 'three.zip']);
    spy.mockRestore();
  });

  it('skips failures, reports them, and keeps going', async () => {
    const getUrl = vi.fn(async (_mid: string, aid: string) => {
      if (aid === 'a2') throw new Error('boom');
      return `blob:${aid}`;
    });
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const failed: string[] = [];
    const n = await downloadAll(atts, getUrl, { delayMs: 0, onError: (f) => failed.push(f) });
    expect(n).toBe(2);
    expect(failed).toEqual(['two.png']);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`./downloadAll` doesn't exist)

`npx vitest run lib/downloadAll.test.ts`

- [ ] **Step 3: Implement `lib/downloadAll.ts`**

```ts
export interface DownloadableAttachment {
  messageId: string;
  id: string;
  filename: string;
}

/**
 * Sequentially download a list of attachments via anchor clicks.
 * Sequential + spaced so the browser doesn't suppress the downloads as a
 * popup burst; failures skip to the next file (reported via onError).
 */
export async function downloadAll(
  attachments: DownloadableAttachment[],
  getUrl: (messageId: string, attachmentId: string) => Promise<string>,
  opts: { delayMs?: number; onError?: (filename: string) => void } = {},
): Promise<number> {
  const { delayMs = 300, onError } = opts;
  let downloaded = 0;
  for (const att of attachments) {
    try {
      const url = await getUrl(att.messageId, att.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      a.click();
      downloaded += 1;
    } catch {
      onError?.(att.filename);
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return downloaded;
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: File size on the tile**

In `AttachmentTile.tsx`, below the filename pill (after the closing `</div>` at line 213), add:

```tsx
<span className="mt-0.5 text-micro leading-none font-normal text-ink-4 tabular-nums">
  {formatBytes(attachment.size)}
</span>
```

(If `attachment.size` can be `0`, guard: `{attachment.size > 0 && (...)}`.)

- [ ] **Step 6: “Download all” buttons (three spots, one pattern)**

Shared handler shape (adapt names per file):

```tsx
import { downloadAll } from '@/lib/downloadAll';
// in the component:
const [downloadingAll, setDownloadingAll] = useState(false);
const handleDownloadAll = async () => {
  if (downloadingAll) return;
  setDownloadingAll(true);
  const n = await downloadAll(
    items,                                              // see per-file mapping below
    (mid, aid) => getAttachmentUrl(mid, aid, () => api.mail.downloadAttachment(mid, aid)),
    { onError: (f) => toast.error(`Failed to download ${f}`) },
  );
  if (n > 0) toast.success(`Downloaded ${n} file${n === 1 ? '' : 's'}`);
  setDownloadingAll(false);
};
```

Button (place right-aligned in the attachments header row):

```tsx
<Button variant="ghost" size="xs" className="ml-auto text-primary hover:text-primary"
  onClick={handleDownloadAll} disabled={downloadingAll}>
  {downloadingAll ? <Loader2 className="animate-spin" /> : <Download />}
  Download all
</Button>
```

Per-file `items`:
1. `ThreadMessage.tsx` (strip header, lines 716–723): `fullMessage.attachments.map((a: any) => ({ messageId: message.id, id: a.id, filename: a.filename }))`. Show the button only when `fullMessage.attachments.length > 1`.
2. `ThreadView.tsx` (attachments tab): add one button in a header row above `orderedGroups` when `allAttachments.length > 1`; `items = allAttachments.map((a) => ({ messageId: a.messageId, id: a.id, filename: a.filename }))`.
3. `MailDetail.tsx` (inline attachments bar header, lines 788–796): `message.attachments.map((a) => ({ messageId: message.id, id: a.id, filename: a.filename }))`, shown when `> 1`.

- [ ] **Step 7: Verify**

`npx vitest run lib/downloadAll.test.ts components/mail` green; `npx tsc --noEmit` clean. Dev: open a message with 2+ attachments → tiles show sizes; “Download all” fetches each file (browser saves them one by one).

- [ ] **Step 8: Commit**

```bash
git add lib/downloadAll.ts lib/downloadAll.test.ts components/mail/AttachmentTile.tsx components/mail/ThreadMessage.tsx components/mail/ThreadView.tsx components/mail/MailDetail.tsx
git commit -m "feat(mail): attachment tile sizes + sequential Download All on strips and attachments tab"
```

---

### Task 10: Reply-recipient computation (Workstream B groundwork)

**Files:**
- Create: `lib/replyRecipients.ts`
- Test: `lib/replyRecipients.test.ts` (create)

**Interfaces:**
- Produces: `computeReplyRecipients(msg: ReplySource, mode: 'reply' | 'replyAll', currentUserEmail: string): { to: Recipient[]; cc: Recipient[] }` with `interface Recipient { email: string; name?: string | null }` and `interface ReplySource { fromEmail: string; fromName: string | null; toRecipients: Recipient[]; ccRecipients?: Recipient[] }` — all exported.

- [ ] **Step 1: Write the failing test**

Create `lib/replyRecipients.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeReplyRecipients } from './replyRecipients';

const me = 'bruce.higiro@risa.gov.rw';
const msg = {
  fromEmail: 'alice@risa.gov.rw',
  fromName: 'Alice',
  toRecipients: [{ email: me, name: 'Bruce' }, { email: 'carol@risa.gov.rw', name: 'Carol' }],
  ccRecipients: [{ email: 'dan@risa.gov.rw', name: 'Dan' }, { email: me }],
};

describe('computeReplyRecipients', () => {
  it('reply → sender only', () => {
    expect(computeReplyRecipients(msg, 'reply', me)).toEqual({
      to: [{ email: 'alice@risa.gov.rw', name: 'Alice' }],
      cc: [],
    });
  });

  it('replyAll → sender + other To recipients, CC minus me, no duplicates', () => {
    const r = computeReplyRecipients(msg, 'replyAll', me);
    expect(r.to.map((x) => x.email)).toEqual(['alice@risa.gov.rw', 'carol@risa.gov.rw']);
    expect(r.cc.map((x) => x.email)).toEqual(['dan@risa.gov.rw']);
  });

  it('replying to my own message → original To recipients', () => {
    const own = { ...msg, fromEmail: me, fromName: 'Bruce' };
    const r = computeReplyRecipients(own, 'reply', me);
    expect(r.to.map((x) => x.email)).toEqual(['carol@risa.gov.rw']);
  });

  it('matches emails case-insensitively', () => {
    const r = computeReplyRecipients({ ...msg, fromEmail: 'ALICE@RISA.GOV.RW' }, 'replyAll', me.toUpperCase());
    expect(r.to.map((x) => x.email)).toEqual(['ALICE@RISA.GOV.RW', 'carol@risa.gov.rw']);
    expect(r.cc.map((x) => x.email)).toEqual(['dan@risa.gov.rw']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing)

- [ ] **Step 3: Implement `lib/replyRecipients.ts`**

```ts
export interface Recipient {
  email: string;
  name?: string | null;
}

export interface ReplySource {
  fromEmail: string;
  fromName: string | null;
  toRecipients: Recipient[];
  ccRecipients?: Recipient[];
}

/**
 * Compute the recipients an inline reply goes to.
 * reply     → the sender (or, when replying to your own message, its To list).
 * replyAll  → sender + every To recipient, CC preserved; you are removed
 *             everywhere and duplicates collapse (case-insensitive).
 */
export function computeReplyRecipients(
  msg: ReplySource,
  mode: 'reply' | 'replyAll',
  currentUserEmail: string,
): { to: Recipient[]; cc: Recipient[] } {
  const me = currentUserEmail.toLowerCase();
  const fromIsMe = msg.fromEmail.toLowerCase() === me;

  if (mode === 'reply') {
    if (fromIsMe) {
      return { to: msg.toRecipients.filter((r) => r.email.toLowerCase() !== me), cc: [] };
    }
    return { to: [{ email: msg.fromEmail, name: msg.fromName }], cc: [] };
  }

  const seen = new Set<string>([me]);
  const push = (arr: Recipient[], r: Recipient) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    arr.push(r);
  };

  const to: Recipient[] = [];
  push(to, { email: msg.fromEmail, name: msg.fromName });
  msg.toRecipients.forEach((r) => push(to, r));

  const cc: Recipient[] = [];
  (msg.ccRecipients ?? []).forEach((r) => push(cc, r));

  return { to, cc };
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add lib/replyRecipients.ts lib/replyRecipients.test.ts
git commit -m "feat(mail): computeReplyRecipients for the inline mini-composer"
```

---

### Task 11: QuickReplyBar → mini-composer

**Files:**
- Modify: `components/mail/QuickReplyBar.tsx` (rewrite)
- Modify: `app/globals.css` (one rule)
- Modify: `components/mail/MailDetail.tsx:822-827` (props pass-through)
- Test: `components/mail/QuickReplyBar.test.tsx` (create)

**Interfaces:**
- Consumes: `computeReplyRecipients` (Task 10), `useAuthStore`, `api.mail.send` (payload shape used by ComposeModal: `{ to: string[], cc?: string[], subject, body: <html string>, replyToId, replyType: 'r' }`), TipTap (`useEditor`, `EditorContent`, `StarterKit` — already dependencies).
- Produces: `QuickReplyBar` props become:

```ts
interface Props {
  message: MessageDetail;          // now also carries ccRecipients?: Array<{ email: string; name?: string | null }>
  onSent: () => void;
  /** Open the full inline composer, carrying the typed draft and chosen mode. */
  onExpand: (initialBody: string, mode: 'reply' | 'replyAll') => void;
}
```

- [ ] **Step 1: Write the failing test (TipTap mocked for jsdom determinism)**

Create `components/mail/QuickReplyBar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@tiptap/react', () => ({
  useEditor: () => null,
  EditorContent: (props: any) => <div data-testid="editor" {...props} />,
}));
vi.mock('@/lib/api', () => ({ api: { mail: { send: vi.fn(async () => ({})) } } }));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: any) => sel({ user: { email: 'me@risa.gov.rw', displayName: 'Me' } }),
}));

import { QuickReplyBar } from './QuickReplyBar';

const message = {
  id: 'm1',
  subject: 'Budget review',
  fromEmail: 'alice@risa.gov.rw',
  fromName: 'Alice',
  toRecipients: [{ email: 'me@risa.gov.rw' }, { email: 'carol@risa.gov.rw', name: 'Carol' }],
  ccRecipients: [{ email: 'dan@risa.gov.rw', name: 'Dan' }],
};

describe('QuickReplyBar mini-composer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the reply recipient as a chip after focusing', () => {
    render(<QuickReplyBar message={message} onSent={() => {}} onExpand={() => {}} />);
    fireEvent.focus(screen.getByTestId('editor'));
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.queryByText('Carol')).toBeNull();
  });

  it('switching to Reply all adds the other recipients', () => {
    render(<QuickReplyBar message={message} onSent={() => {}} onExpand={() => {}} />);
    fireEvent.focus(screen.getByTestId('editor'));
    fireEvent.click(screen.getByRole('button', { name: /reply all/i }));
    expect(screen.getByText('Carol')).toBeTruthy();
    expect(screen.getByText('Dan')).toBeTruthy();
  });

  it('expand hands the current mode to onExpand', () => {
    const onExpand = vi.fn();
    render(<QuickReplyBar message={message} onSent={() => {}} onExpand={onExpand} />);
    fireEvent.focus(screen.getByTestId('editor'));
    fireEvent.click(screen.getByRole('button', { name: /reply all/i }));
    fireEvent.click(screen.getByRole('button', { name: /open full editor/i }));
    expect(onExpand).toHaveBeenCalledWith('', 'replyAll');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (current component has no chips/mode switch)

- [ ] **Step 3: Rewrite `QuickReplyBar.tsx`**

```tsx
'use client';

import { useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import {
  Send, Loader2, Maximize2, Bold, Italic, List, Link2, Smile, Paperclip,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuthStore } from '@/stores/auth.store';
import { computeReplyRecipients, type Recipient } from '@/lib/replyRecipients';

interface MessageDetail {
  id: string;
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  toRecipients: Array<{ email: string; name?: string | null }>;
  ccRecipients?: Array<{ email: string; name?: string | null }>;
  zimbraId?: string;
}

interface Props {
  message: MessageDetail;
  onSent: () => void;
  /** Open the full inline composer, carrying the typed draft and chosen mode. */
  onExpand: (initialBody: string, mode: 'reply' | 'replyAll') => void;
}

const EMOJI = ['😊', '👍', '🙏', '✅', '🎉', '📌', '⏰', '📎', '❗', '❓', '💡', '🤝'];

function RecipientChip({ r }: { r: Recipient }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted text-micro font-normal text-ink-2 max-w-[180px]">
      <span className="truncate">{r.name || r.email}</span>
    </span>
  );
}

export function QuickReplyBar({ message, onSent, onExpand }: Props) {
  const user = useAuthStore((s) => s.user);
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<'reply' | 'replyAll'>('reply');
  const [sending, setSending] = useState(false);

  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false })],
    content: '',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'mini-composer-editor text-ui text-foreground outline-none',
        'aria-label': 'Reply',
      },
    },
    onFocus: () => setExpanded(true),
  });

  const { to, cc } = computeReplyRecipients(
    { fromEmail: message.fromEmail, fromName: message.fromName,
      toRecipients: message.toRecipients, ccRecipients: message.ccRecipients },
    mode,
    user?.email ?? '',
  );
  const hasReplyAllExtras =
    computeReplyRecipients(
      { fromEmail: message.fromEmail, fromName: message.fromName,
        toRecipients: message.toRecipients, ccRecipients: message.ccRecipients },
      'replyAll', user?.email ?? '',
    ).to.length > 1;

  const currentHtml = () => editor?.getHTML() ?? '';
  const isEmpty = !editor || editor.isEmpty;

  const handleSend = useCallback(async () => {
    if (!editor || editor.isEmpty || sending) return;
    setSending(true);
    try {
      const subject = message.subject
        ? (message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`)
        : 'Re: (no subject)';
      await api.mail.send({
        to: to.map((r) => r.email),
        ...(cc.length > 0 ? { cc: cc.map((r) => r.email) } : {}),
        subject,
        body: editor.getHTML(),
        replyToId: message.id,
        replyType: 'r',
      });
      toast.success('Reply sent');
      editor.commands.clearContent();
      setExpanded(false);
      onSent();
    } catch (err: any) {
      toast.error('Failed to send reply', { description: err?.message });
    } finally {
      setSending(false);
    }
  }, [editor, sending, message.id, message.subject, to, cc, onSent]);

  return (
    <div className={cn('border-t border-border-faint bg-muted/20', expanded ? 'px-4 py-3' : 'px-4 py-2')}>
      <div className="bg-card border border-border rounded-xl shadow-pill overflow-hidden">
        {/* Recipient row — visible once engaged */}
        {expanded && (
          <div className="flex items-center gap-1.5 flex-wrap px-3 pt-2.5">
            <span className="text-micro text-ink-3 shrink-0">To</span>
            {to.map((r) => <RecipientChip key={r.email} r={r} />)}
            {cc.length > 0 && (
              <>
                <span className="text-micro text-ink-3 shrink-0 ml-1">Cc</span>
                {cc.map((r) => <RecipientChip key={r.email} r={r} />)}
              </>
            )}
            {hasReplyAllExtras && (
              <Button variant="ghost" size="xs" className="ml-auto text-ink-3 hover:text-foreground"
                aria-label={mode === 'reply' ? 'Reply all' : 'Reply only to sender'}
                onClick={() => setMode((m) => (m === 'reply' ? 'replyAll' : 'reply'))}>
                {mode === 'reply' ? 'Reply all' : 'Reply only'}
              </Button>
            )}
          </div>
        )}

        {/* Editor */}
        <div className={cn('px-3', expanded ? 'py-2' : 'py-2')}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSend(); }}>
          <EditorContent editor={editor} onFocus={() => setExpanded(true)} />
          {!expanded && isEmpty && (
            <p className="pointer-events-none -mt-5 text-ui text-ink-4">Quick reply…</p>
          )}
        </div>

        {/* Toolbar + send — visible once engaged */}
        {expanded && (
          <div className="flex items-center gap-0.5 px-2 pb-2">
            <Button variant="ghost" size="icon-xs" aria-label="Bold"
              className={cn('text-ink-3', editor?.isActive('bold') && 'bg-muted text-foreground')}
              onClick={() => editor?.chain().focus().toggleBold().run()}><Bold /></Button>
            <Button variant="ghost" size="icon-xs" aria-label="Italic"
              className={cn('text-ink-3', editor?.isActive('italic') && 'bg-muted text-foreground')}
              onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic /></Button>
            <Button variant="ghost" size="icon-xs" aria-label="Bullet list"
              className={cn('text-ink-3', editor?.isActive('bulletList') && 'bg-muted text-foreground')}
              onClick={() => editor?.chain().focus().toggleBulletList().run()}><List /></Button>
            <Button variant="ghost" size="icon-xs" aria-label="Insert link" className="text-ink-3"
              onClick={() => {
                if (editor?.isActive('link')) { editor.chain().focus().unsetLink().run(); return; }
                const url = window.prompt('Enter URL (e.g. https://example.com):');
                if (url) editor?.chain().focus().setLink({ href: url }).run();
              }}><Link2 /></Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Insert emoji" className="text-ink-3"><Smile /></Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-2" align="start">
                <div className="grid grid-cols-6 gap-1">
                  {EMOJI.map((e) => (
                    <button key={e} type="button"
                      className="w-7 h-7 rounded-md hover:bg-muted text-body"
                      onClick={() => editor?.chain().focus().insertContent(e).run()}>
                      {e}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <Button variant="ghost" size="icon-xs" aria-label="Attach files — opens the full editor"
              className="text-ink-3" onClick={() => onExpand(currentHtml(), mode)}><Paperclip /></Button>

            <div className="flex-1" />

            <Button variant="ghost" size="icon-xs" aria-label="Open full editor"
              className="text-ink-3" onClick={() => onExpand(currentHtml(), mode)}><Maximize2 /></Button>
            <Button size="xs" onClick={handleSend} disabled={sending || isEmpty}
              aria-label="Send reply (⌘↵)">
              {sending ? <Loader2 className="animate-spin" /> : <Send />}
              Send
            </Button>
          </div>
        )}
      </div>

      {expanded && (
        <p className="text-micro font-normal text-ink-4 mt-1.5 text-right">⌘↵ to send</p>
      )}
    </div>
  );
}
```

Notes: `StarterKit` in TipTap v3 bundles Link — if `setLink` is not available at compile time, add `import Link from '@tiptap/extension-link'` (already a ComposeModal dependency) and append `Link.configure({ openOnClick: false })` to `extensions`. The placeholder uses a simple overlay rather than the Placeholder extension to avoid a new dependency.

- [ ] **Step 4: Constrain the mini editor's height in `globals.css`**

The global `.ProseMirror { min-height: 140px; }` rule would make the collapsed bar huge. After that rule block (line 250), add:

```css
/* Mini reply composer — compact editor, grows with content */
.mini-composer-editor.ProseMirror {
  min-height: 24px;
  max-height: 200px;
  overflow-y: auto;
}
```

- [ ] **Step 5: Update the MailDetail call site (lines 822–827)**

```tsx
<QuickReplyBar
  message={message}
  onSent={() => {}}
  onExpand={(initialBody, mode) =>
    mode === 'replyAll' ? onReplyAll?.(initialBody) : onReply?.(initialBody)}
/>
```

Update `MailDetail`'s own `Props` so `onReply`/`onReplyAll` accept an optional body: `onReply?: (initialBody?: string) => void; onReplyAll?: (initialBody?: string) => void;` (their existing no-arg invocations elsewhere in MailDetail remain valid). Also confirm the `message` object MailDetail passes exposes `ccRecipients` — if its local message type lacks the field, add `ccRecipients?: Array<{ email: string; name?: string | null }>` to that type (the API detail payload already includes it; `ThreadMessageMeta` in ThreadMessage.tsx line 422 proves the field exists on message data).

- [ ] **Step 6: Run tests — expect PASS**

`npx vitest run components/mail/QuickReplyBar.test.tsx` then `npx vitest run components/mail` and `npx tsc --noEmit`.

- [ ] **Step 7: Manual check**

Dev: open an unthreaded message (or any single-message fallback view) → bar shows “Quick reply…”; focus expands chips + toolbar; Reply all toggle adds recipients; bold/italic/list/emoji work; ⌘↵ sends; paperclip and expand open the full composer.

- [ ] **Step 8: Commit**

```bash
git add components/mail/QuickReplyBar.tsx components/mail/QuickReplyBar.test.tsx components/mail/MailDetail.tsx app/globals.css
git commit -m "feat(mail): QuickReplyBar mini-composer — recipient chips, reply-all switch, formatting toolbar"
```

---

### Task 12: Inline becomes the default reply path

**Files:**
- Modify: `components/mail/ThreadView.tsx`
- Modify: `components/mail/ComposeModal.tsx` (only if initialBody isn't honored in reply mode — see Step 3)

**Interfaces:**
- Consumes: `ThreadView`'s existing `inlineReply` state + `inlineComposer` element (lines 340–357), `ComposeModal`'s `initialBody` prop.

- [ ] **Step 1: Carry a draft into the inline composer**

In `ThreadView.tsx` line 340, extend the state type:

```tsx
const [inlineReply, setInlineReply] = useState<{ mode: 'reply' | 'replyAll'; target: any; initialBody?: string } | null>(null);
```

In `inlineComposer` (line 348), pass it through: add `initialBody={inlineReply.initialBody}` to the `<ComposeModal ... />` props.

- [ ] **Step 2: Rewire the header + overview reply actions to inline**

1. `ThreadHeader` usage (lines 482–483):

```tsx
onReply={() => { setActiveTab('messages'); setInlineReply({ mode: 'reply', target: lastMessage }); }}
onReplyAll={() => { setActiveTab('messages'); setInlineReply({ mode: 'replyAll', target: lastMessage }); }}
```

(`onForward` stays `onComposeWith('forward', lastMessage)` — forwards keep the floating window.)

2. Overview tab action buttons (lines 698, 705): same two substitutions (`setActiveTab('messages')` first so the composer, which renders inside the Messages tab, is visible).

3. Fallback `MailDetail` wiring (lines 368–369) — accept the carried draft:

```tsx
onReply={(initialBody) => setInlineReply({ mode: 'reply', target: message, initialBody })}
onReplyAll={(initialBody) => setInlineReply({ mode: 'replyAll', target: message, initialBody })}
```

- [ ] **Step 3: Verify ComposeModal honors `initialBody` for reply modes**

Search `ComposeModal.tsx` for where the editor's initial content is set (search for `initialBody`). If `initialBody` is only applied for draft editing (guarded by mode or `initialDraftZimbraId`), change the content initialization so a non-empty `initialBody` seeds the editor in ANY mode (replies included), e.g. `content: initialBody ?? <existing default>`. If it already applies unconditionally, no change.

- [ ] **Step 4: Verify behavior**

`npx tsc --noEmit` clean; `npx vitest run` green. Dev checks:
- Thread toolbar Reply → inline composer appears below the newest message (not the floating window), pre-addressed.
- Overview tab Reply/Reply all → jumps to Messages tab with the inline composer open.
- Per-message Reply buttons (ThreadMessage footer) → unchanged inline behavior.
- Single-message view: type in the mini bar → expand → full inline composer opens with the typed text preserved.
- Forward (header + message footer) still opens the floating window.

- [ ] **Step 5: Commit**

```bash
git add components/mail/ThreadView.tsx components/mail/ComposeModal.tsx
git commit -m "feat(mail): inline composer is the default reply path; drafts carry into the full editor"
```

---

### Task 13: Final verification + spec acceptance

**Files:** none (verification; fix in place if needed)

- [ ] **Step 1: Run the spec's acceptance greps** (same commands as Task 7 Step 1, plus `components/mail/QuickReplyBar.tsx` added to `$FILES`) — expect zero matches.

- [ ] **Step 2: Full suite + types**

`npx vitest run` all green; `npx tsc --noEmit` clean; `pnpm build` from `apps/web` succeeds.

- [ ] **Step 3: Manual sweep, both themes, three widths**

At mobile (<768px), tablet (~900px), desktop (≥1200px), in light and dark:
- List: grouped rows, unread treatment, chips, bulk bar.
- Sidebar: tablet shows the rail; desktop collapse toggle; inbox count badge; tooltips; monochrome rail icons.
- Thread: header pills, tabs, message cards, attachments with sizes + Download all.
- Reply: header Reply → inline composer; mini bar in single-message view; expand carries the draft; send works.
- Compose modal: text-color swatch renders (fixed bug); blockquote/inline code visible in the editor.

- [ ] **Step 4: Report**

Summarize what shipped per workstream against `docs/superpowers/specs/2026-09-04-finish-pass-design.md` acceptance criteria, including the one documented deviation (MailList row context menu stays hand-rolled, tokenized). Then use superpowers:finishing-a-development-branch.
