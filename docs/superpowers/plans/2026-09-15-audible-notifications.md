# Audible Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new mail and calendar reminders audible — a chime and an on-screen toast while 1Gov Mail is open, plus an operating-system notification when the window is hidden.

**Architecture:** Detection is server-side and free: `MailService.getFolders` already holds both the stored `/Inbox` unread count and the one it just fetched from the mail provider, so an increase creates a `NEW_MAIL` notification row during the folder sync the browser already performs every two minutes. One client component (`NotificationAlerts`) mounted in the `(app)` shell polls the existing notification feed and turns each new row into a toast, a synthesized chime, and — only when the document is hidden — an OS notification. The bell returns to the intelligence rail reading the same query, so history and sound can never disagree.

**Tech Stack:** NestJS 11 + Prisma 7 (api), Next.js 16 + React + Zustand + TanStack Query + sonner (web), Web Audio API for chimes, Jest (api) / Vitest + Testing Library (web).

**Spec:** `docs/superpowers/specs/2026-09-14-notifications-sound-design.md` (commit `1a80961`)

## Global Constraints

- Audible types are exactly `NEW_MAIL` and `EVENT_SOON`. `TASK_DUE`, `MAIL_SNOOZE_EXPIRED` and `SCHEDULED_SENT` appear in the list silently.
- A notification failure must NEVER break `getFolders` — wrap in try/catch, log at WARN. The folder list matters more than an alert.
- OS-notification permission is requested ONLY when the user enables sound in Settings. Never on page load.
- A blocked or failed chime is a no-op, never a thrown error — the toast has already appeared.
- Sound preferences are per device (persisted Zustand), not per account. No server round-trip to mute.
- Do not touch the existing notification producers (`EVENT_SOON` cron, task/snooze/scheduled) beyond adding `NEW_MAIL`.
- `apps/web/app/(app)/mail/page.tsx`: drop the `electronAPI.sendNotification` call only. **Keep `setBadgeCount`** — the macOS dock badge has no replacement here.
- Every task ends green: `npx jest` (api) or `npx vitest run` (web) plus `npx tsc --noEmit`.

## Two deliberate deviations from the spec

Both preserve the specified behaviour; they are recorded here so a reviewer is not surprised.

1. **The client tracks `lastAnnouncedAt` (a timestamp), not "the highest notification id".** Notification ids are cuids and are not reliably ordered, so comparing them would be wrong. `createdAt` is comparable and already returned by the feed.
2. **Cross-tab dedupe uses a `localStorage` claim key, not `BroadcastChannel`.** A claim key is synchronous, trivially testable, and needs no timing window. Worst case on a genuine race is one duplicate chime; a `BroadcastChannel` handshake has the same worst case plus a timing window and far more moving parts.

---

### Task 1: Server detects new mail during folder sync

**Files:**
- Modify: `apps/api/src/notifications/notifications.service.ts` (add `hasRecentNotification`)
- Modify: `apps/api/src/mail/mail.service.ts:160` (`getFolders`)
- Test: `apps/api/src/mail/mail.service.spec.ts`
- Test: `apps/api/src/notifications/notifications.service.spec.ts` (create if absent)

**Interfaces:**
- Consumes: `NotificationsService.createNotification(userId, type, title, body?, actionUrl?, metadata?)` — already exists.
- Produces:
  - `NotificationsService.hasRecentNotification(userId: string, type: string, withinMs: number): Promise<boolean>`
  - `MailService.notifyNewMail(userId: string, stored: Array<{ zimbraId: string; path: string; unreadCount: number }>, fetched: Array<{ id: string; path: string; unreadCount: number }>): Promise<void>` — private, called from `getFolders`.
  - Notification shape: `type: 'NEW_MAIL'`, `title: "N new message(s)"`, `body: "Inbox now has N unread"`, `actionUrl: '/mail'`, `metadata: { unreadCount, delta }`.

- [ ] **Step 1: Write the failing test for the dedupe guard**

In `apps/api/src/notifications/notifications.service.spec.ts`:

```typescript
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';

describe('NotificationsService.hasRecentNotification', () => {
  const makeService = (count: number) => {
    const prisma = { notification: { count: jest.fn().mockResolvedValue(count) } } as unknown as PrismaService;
    return { service: new NotificationsService(prisma), prisma: prisma as any };
  };

  it('is true when a notification of that type exists inside the window', async () => {
    const { service } = makeService(1);
    await expect(service.hasRecentNotification('u1', 'NEW_MAIL', 60_000)).resolves.toBe(true);
  });

  it('is false when none exists, and only looks back by the window given', async () => {
    const { service, prisma } = makeService(0);
    await expect(service.hasRecentNotification('u1', 'NEW_MAIL', 60_000)).resolves.toBe(false);

    const where = prisma.notification.count.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.type).toBe('NEW_MAIL');
    expect(where.createdAt.gte.getTime()).toBeGreaterThan(Date.now() - 61_000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx jest src/notifications/notifications.service.spec.ts`
Expected: FAIL — `service.hasRecentNotification is not a function`.

- [ ] **Step 3: Implement the guard**

In `apps/api/src/notifications/notifications.service.ts`, beside `getUnreadCount`:

```typescript
  /**
   * Whether this user already has a notification of `type` inside the last
   * `withinMs`. Used to keep repeated detection idempotent: several tabs (or
   * devices) sync folders at once and must not each produce a row.
   */
  async hasRecentNotification(userId: string, type: string, withinMs: number): Promise<boolean> {
    const count = await this.prisma.notification.count({
      where: { userId, type, createdAt: { gte: new Date(Date.now() - withinMs) } },
    });
    return count > 0;
  }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && npx jest src/notifications/notifications.service.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing tests for detection**

Append to `apps/api/src/mail/mail.service.spec.ts`:

```typescript
describe('MailService new-mail detection', () => {
  const user = { id: 'u1', authToken: 'tok', tokenExpiry: new Date(Date.now() + 60_000), provider: 'zimbra' };
  const stored = [{ zimbraId: 'z-inbox', path: '/Inbox', unreadCount: 2 }];

  function makeService(fetchedUnread: number, recent = false) {
    const createNotification = jest.fn().mockResolvedValue({});
    const notifications = {
      createNotification,
      hasRecentNotification: jest.fn().mockResolvedValue(recent),
    } as unknown as NotificationsService;
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user), update: jest.fn() },
      folder: {
        findMany: jest.fn().mockResolvedValue(stored),
        upsert: jest.fn().mockResolvedValue({ id: 'f-inbox' }),
      },
    } as unknown as PrismaService;
    const zimbra = {
      getFolders: jest.fn().mockResolvedValue([
        { id: 'z-inbox', name: 'Inbox', path: '/Inbox', kind: 'mail', unreadCount: fetchedUnread, totalCount: 10 },
      ]),
    } as unknown as ZimbraService;
    const service = new MailService(
      prisma, makeResolver(zimbra), notifications, { create: jest.fn() } as unknown as TasksService,
    );
    return { service, createNotification, notifications: notifications as any };
  }

  it('creates one NEW_MAIL notification when the inbox unread count rises', async () => {
    const { service, createNotification } = makeService(5);

    await service.getFolders('u1');

    expect(createNotification).toHaveBeenCalledTimes(1);
    const [userId, type, title, , actionUrl, metadata] = createNotification.mock.calls[0];
    expect(userId).toBe('u1');
    expect(type).toBe('NEW_MAIL');
    expect(title).toBe('3 new messages');
    expect(actionUrl).toBe('/mail');
    expect(metadata).toEqual({ unreadCount: 5, delta: 3 });
  });

  it('says "1 new message" for a single arrival', async () => {
    const { service, createNotification } = makeService(3);
    await service.getFolders('u1');
    expect(createNotification.mock.calls[0][2]).toBe('1 new message');
  });

  it('creates nothing when the count is unchanged', async () => {
    const { service, createNotification } = makeService(2);
    await service.getFolders('u1');
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('creates nothing when the count FALLS — mail read elsewhere is not an arrival', async () => {
    const { service, createNotification } = makeService(1);
    await service.getFolders('u1');
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('creates nothing when another sync already notified inside the dedupe window', async () => {
    const { service, createNotification } = makeService(5, true);
    await service.getFolders('u1');
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('still returns the folder list when creating the notification throws', async () => {
    // The folder list is the user's mailbox. An alert failure must never cost it.
    const { service, notifications } = makeService(5);
    notifications.createNotification.mockRejectedValue(new Error('db down'));

    await expect(service.getFolders('u1')).resolves.toBeDefined();
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd apps/api && npx jest src/mail/mail.service.spec.ts -t "new-mail detection"`
Expected: FAIL — no notification is created (`createNotification` never called).

- [ ] **Step 7: Implement detection in `getFolders`**

In `apps/api/src/mail/mail.service.ts`, inside `getFolders`, after `providerFolders` is fetched and BEFORE the persist loop:

```typescript
    // Read the folder rows as they stand BEFORE the upsert below overwrites
    // them — this is the only moment the server holds both the previous unread
    // count and the one the provider just reported.
    const storedFolders = await this.prisma.folder.findMany({
      where: { userId },
      select: { zimbraId: true, path: true, unreadCount: true },
    });
    await this.notifyNewMail(userId, storedFolders, providerFolders);
```

Then add the private method after `getFolders`:

```typescript
  /** How long one NEW_MAIL notification suppresses the next. The browser syncs
   *  folders every two minutes, and several tabs may sync at once. */
  private static readonly NEW_MAIL_DEDUPE_MS = 60_000;

  /**
   * Raise a NEW_MAIL notification when the Inbox unread count has RISEN since
   * the last sync. A fall means the user read mail somewhere else, which is
   * not an arrival.
   *
   * Never throws: an alert is worth less than the folder list this runs inside.
   */
  private async notifyNewMail(
    userId: string,
    stored: Array<{ zimbraId: string; path: string; unreadCount: number }>,
    fetched: Array<{ id: string; path: string; unreadCount: number }>,
  ): Promise<void> {
    try {
      const previous = stored.find((f) => f.path === '/Inbox');
      const current = fetched.find((f) => f.path === '/Inbox');
      if (!previous || !current) return; // first sync ever: nothing to compare

      const delta = current.unreadCount - previous.unreadCount;
      if (delta <= 0) return;

      if (await this.notifications.hasRecentNotification(userId, 'NEW_MAIL', MailService.NEW_MAIL_DEDUPE_MS)) {
        return;
      }

      await this.notifications.createNotification(
        userId,
        'NEW_MAIL',
        `${delta} new message${delta === 1 ? '' : 's'}`,
        `Inbox now has ${current.unreadCount} unread`,
        '/mail',
        { unreadCount: current.unreadCount, delta },
      );
    } catch (err: any) {
      this.logger.warn(`NEW_MAIL notification failed for userId=${userId}: ${err?.message}`);
    }
  }
```

- [ ] **Step 8: Run the tests and watch them pass**

Run: `cd apps/api && npx jest src/mail && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS, tsc clean.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/mail/mail.service.ts apps/api/src/mail/mail.service.spec.ts \
        apps/api/src/notifications/notifications.service.ts apps/api/src/notifications/notifications.service.spec.ts
git commit -m "feat(api): raise a NEW_MAIL notification when the inbox unread count rises

getFolders is the one place the server holds both the stored unread count and
the one the provider just reported, so new mail is detectable there with no new
polling. A rise creates one NEW_MAIL row; a fall (mail read elsewhere) creates
none, and a 60s guard keeps several tabs syncing at once from each producing a
row. A notification failure is logged, never propagated — the folder list
matters more than the alert."
```

---

### Task 2: Notification preferences store

**Files:**
- Create: `apps/web/stores/notifications.store.ts`
- Test: `apps/web/stores/notifications.store.test.ts`

**Interfaces:**
- Produces:
  - `type ToneName = 'soft' | 'ping' | 'double' | 'chord'`
  - `useNotificationsStore` with state `{ soundEnabled: boolean; volume: number; tones: Record<'NEW_MAIL' | 'EVENT_SOON', ToneName>; lastAnnouncedAt: string | null }`
  - actions `setSoundEnabled(v: boolean)`, `setVolume(v: number)`, `setTone(type: 'NEW_MAIL' | 'EVENT_SOON', tone: ToneName)`, `setLastAnnouncedAt(iso: string)`
- Defaults: `soundEnabled: true`, `volume: 0.6`, `tones: { NEW_MAIL: 'soft', EVENT_SOON: 'double' }`, `lastAnnouncedAt: null`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useNotificationsStore } from './notifications.store';

const reset = () => useNotificationsStore.setState({
  soundEnabled: true, volume: 0.6,
  tones: { NEW_MAIL: 'soft', EVENT_SOON: 'double' },
  lastAnnouncedAt: null,
});

describe('useNotificationsStore', () => {
  beforeEach(reset);

  it('starts audible — sound is the point of the feature, not an opt-in', () => {
    const s = useNotificationsStore.getState();
    expect(s.soundEnabled).toBe(true);
    expect(s.volume).toBe(0.6);
    expect(s.tones).toEqual({ NEW_MAIL: 'soft', EVENT_SOON: 'double' });
  });

  it('clamps the volume to 0..1 so a bad value cannot deafen anyone', () => {
    useNotificationsStore.getState().setVolume(5);
    expect(useNotificationsStore.getState().volume).toBe(1);
    useNotificationsStore.getState().setVolume(-2);
    expect(useNotificationsStore.getState().volume).toBe(0);
  });

  it('sets a tone per type without disturbing the other', () => {
    useNotificationsStore.getState().setTone('EVENT_SOON', 'chord');
    expect(useNotificationsStore.getState().tones).toEqual({ NEW_MAIL: 'soft', EVENT_SOON: 'chord' });
  });

  it('only moves lastAnnouncedAt forward, so a late poll cannot replay alerts', () => {
    useNotificationsStore.getState().setLastAnnouncedAt('2026-09-15T10:00:00.000Z');
    useNotificationsStore.getState().setLastAnnouncedAt('2026-09-15T09:00:00.000Z');
    expect(useNotificationsStore.getState().lastAnnouncedAt).toBe('2026-09-15T10:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run stores/notifications.store.test.ts`
Expected: FAIL — cannot resolve `./notifications.store`.

- [ ] **Step 3: Implement the store**

```typescript
'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ToneName = 'soft' | 'ping' | 'double' | 'chord';
export type AudibleType = 'NEW_MAIL' | 'EVENT_SOON';

interface NotificationsState {
  /** Sound on by default: an audible alert is the feature, not an opt-in. */
  soundEnabled: boolean;
  /** 0..1, applied to the chime's gain node. */
  volume: number;
  /** Which chime each audible type plays, so the two are distinguishable
   *  without looking at the screen. */
  tones: Record<AudibleType, ToneName>;
  /**
   * `createdAt` of the newest notification already announced on this device.
   * A timestamp rather than an id because ids are cuids and are not reliably
   * ordered. Null means "nothing announced yet" — the first poll records the
   * newest row WITHOUT announcing, so a backlog never plays on login.
   */
  lastAnnouncedAt: string | null;
  setSoundEnabled: (v: boolean) => void;
  setVolume: (v: number) => void;
  setTone: (type: AudibleType, tone: ToneName) => void;
  setLastAnnouncedAt: (iso: string) => void;
}

export const useNotificationsStore = create<NotificationsState>()(
  persist(
    (set) => ({
      soundEnabled: true,
      volume: 0.6,
      tones: { NEW_MAIL: 'soft', EVENT_SOON: 'double' },
      lastAnnouncedAt: null,
      setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
      setVolume: (v) => set({ volume: Math.min(1, Math.max(0, v)) }),
      setTone: (type, tone) => set((s) => ({ tones: { ...s.tones, [type]: tone } })),
      // Monotonic: a slow response arriving after a fast one must not rewind
      // the marker and replay alerts the user already heard.
      setLastAnnouncedAt: (iso) =>
        set((s) => (!s.lastAnnouncedAt || iso > s.lastAnnouncedAt ? { lastAnnouncedAt: iso } : s)),
    }),
    { name: 'notifications' },
  ),
);
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/web && npx vitest run stores/notifications.store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/stores/notifications.store.ts apps/web/stores/notifications.store.test.ts
git commit -m "feat(web): per-device notification sound preferences

Sound on by default, volume clamped to 0..1, one chime choice per audible type.
lastAnnouncedAt is a timestamp rather than an id (cuids are not ordered) and
only ever moves forward, so a slow poll arriving late cannot replay alerts."
```

---

### Task 3: The chime engine

**Files:**
- Create: `apps/web/lib/notifications/chime.ts`
- Test: `apps/web/lib/notifications/chime.test.ts`

**Interfaces:**
- Consumes: `ToneName` from `@/stores/notifications.store`.
- Produces:
  - `interface Note { hz: number; ms: number; delayMs: number }`
  - `const TONES: Record<ToneName, Note[]>`
  - `async function playTone(tone: ToneName, volume: number, ctxFactory?: () => AudioContext | null): Promise<boolean>` — resolves `true` when it played, `false` when it declined (muted, or no audio available). Never rejects.
  - `function unlockAudio(): void` — resumes a suspended context; call from a user gesture.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { TONES, playTone } from './chime';

/** A minimal stand-in for the parts of AudioContext the chime uses. */
function fakeContext(state: AudioContextState = 'running') {
  const starts: number[] = [];
  const osc = () => ({
    frequency: { value: 0 }, type: 'sine',
    connect: vi.fn(), start: vi.fn((t: number) => starts.push(t)), stop: vi.fn(),
  });
  const gain = () => ({
    gain: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  });
  return {
    ctx: {
      state, currentTime: 0, destination: {},
      createOscillator: vi.fn(osc), createGain: vi.fn(gain), resume: vi.fn(),
    } as unknown as AudioContext,
    starts,
  };
}

describe('TONES', () => {
  it('gives every tone at least one note, and distinct shapes per tone', () => {
    expect(Object.keys(TONES).sort()).toEqual(['chord', 'double', 'ping', 'soft']);
    for (const notes of Object.values(TONES)) expect(notes.length).toBeGreaterThan(0);
    expect(TONES.ping.length).toBe(1);
    expect(TONES.chord.length).toBe(3);
  });
});

describe('playTone', () => {
  it('plays one oscillator per note in the tone', async () => {
    const { ctx } = fakeContext();
    const played = await playTone('chord', 0.5, () => ctx);

    expect(played).toBe(true);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(TONES.chord.length);
  });

  it('plays nothing at volume 0 instead of a silent oscillator', async () => {
    const { ctx } = fakeContext();
    const played = await playTone('soft', 0, () => ctx);

    expect(played).toBe(false);
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it('declines quietly when the browser gives no audio context', async () => {
    // Autoplay policy, an unsupported browser, or a locked context: the toast
    // has already appeared, so a missing chime must never surface as an error.
    await expect(playTone('soft', 1, () => null)).resolves.toBe(false);
  });

  it('never rejects when the audio layer throws', async () => {
    const throwing = { createOscillator: () => { throw new Error('boom'); }, state: 'running', currentTime: 0, destination: {}, createGain: vi.fn() } as unknown as AudioContext;
    await expect(playTone('soft', 1, () => throwing)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run lib/notifications/chime.test.ts`
Expected: FAIL — cannot resolve `./chime`.

- [ ] **Step 3: Implement the chime engine**

```typescript
'use client';

import type { ToneName } from '@/stores/notifications.store';

/** One note of a chime: a frequency, how long it sounds, and when it starts. */
export interface Note {
  hz: number;
  ms: number;
  delayMs: number;
}

/**
 * The four chimes, as note sequences rather than audio files.
 *
 * Synthesizing them keeps binaries off the offline servers, sidesteps any
 * licence question on a government product, and makes "a different sound per
 * type" a different list of numbers instead of a different download.
 */
export const TONES: Record<ToneName, Note[]> = {
  // two rising notes — the default for mail
  soft:   [{ hz: 587.33, ms: 120, delayMs: 0 }, { hz: 880.0, ms: 180, delayMs: 110 }],
  // one clean note
  ping:   [{ hz: 987.77, ms: 160, delayMs: 0 }],
  // two of the same note — the default for calendar
  double: [{ hz: 784.0, ms: 90, delayMs: 0 }, { hz: 784.0, ms: 90, delayMs: 150 }],
  // three notes together
  chord:  [{ hz: 523.25, ms: 260, delayMs: 0 }, { hz: 659.25, ms: 260, delayMs: 0 }, { hz: 783.99, ms: 260, delayMs: 0 }],
};

let context: AudioContext | null = null;

/** The shared AudioContext, created lazily. Returns null where Web Audio is
 *  unavailable (older browsers, or a non-browser test environment). */
function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  return context;
}

/**
 * Resume a context the browser suspended. Browsers refuse audio until the user
 * has interacted with the page, so call this from a real gesture — the Test
 * button in Settings, or the first click after mount.
 */
export function unlockAudio(): void {
  try {
    const ctx = getContext();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  } catch {
    // Nothing to do: audio simply stays unavailable.
  }
}

/**
 * Play `tone` at `volume` (0..1). Resolves true when it played, false when it
 * declined. NEVER rejects — a missing chime is not worth an error, because the
 * on-screen toast has already delivered the alert.
 */
export async function playTone(
  tone: ToneName,
  volume: number,
  ctxFactory: () => AudioContext | null = getContext,
): Promise<boolean> {
  if (volume <= 0) return false;
  try {
    const ctx = ctxFactory();
    if (!ctx) return false;
    if (ctx.state === 'suspended') void ctx.resume();

    const now = ctx.currentTime;
    for (const note of TONES[tone]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = note.hz;

      const start = now + note.delayMs / 1000;
      const end = start + note.ms / 1000;
      // A short attack and decay: a bare square start/stop clicks audibly.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(volume * 0.3, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/web && npx vitest run lib/notifications/chime.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/notifications/chime.ts apps/web/lib/notifications/chime.test.ts
git commit -m "feat(web): synthesized notification chimes

Four tones built from oscillator notes rather than audio files: no binaries to
ship to the offline servers, no licence question, and per-type sounds become
different note lists. A blocked or unavailable audio context resolves false
rather than throwing — the toast has already carried the alert."
```

---

### Task 4: Deciding what to announce

**Files:**
- Create: `apps/web/lib/notifications/announce.ts`
- Test: `apps/web/lib/notifications/announce.test.ts`

**Interfaces:**
- Produces:
  - `interface NotificationRow { id: string; type: string; title: string; body?: string | null; actionUrl?: string | null; createdAt: string; isRead?: boolean }`
  - `const AUDIBLE_TYPES: readonly ['NEW_MAIL', 'EVENT_SOON']`
  - `function isAudible(type: string): type is AudibleType`
  - `function selectNewNotifications(feed: NotificationRow[], lastAnnouncedAt: string | null): NotificationRow[]` — oldest-first; `[]` on first run.
  - `function newestCreatedAt(feed: NotificationRow[]): string | null`
  - `function claimAnnouncement(id: string, now?: number): boolean` — cross-tab claim via `localStorage`; true when THIS tab should announce.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AUDIBLE_TYPES, isAudible, selectNewNotifications, newestCreatedAt, claimAnnouncement,
} from './announce';

const row = (id: string, createdAt: string, type = 'NEW_MAIL') => ({ id, type, title: id, createdAt });

describe('isAudible', () => {
  it('is true for exactly new mail and calendar reminders', () => {
    expect(AUDIBLE_TYPES).toEqual(['NEW_MAIL', 'EVENT_SOON']);
    expect(isAudible('NEW_MAIL')).toBe(true);
    expect(isAudible('EVENT_SOON')).toBe(true);
  });

  it('is false for the types that must stay silent', () => {
    expect(isAudible('TASK_DUE')).toBe(false);
    expect(isAudible('MAIL_SNOOZE_EXPIRED')).toBe(false);
    expect(isAudible('SCHEDULED_SENT')).toBe(false);
  });
});

describe('selectNewNotifications', () => {
  const feed = [
    row('c', '2026-09-15T10:02:00.000Z'),
    row('b', '2026-09-15T10:01:00.000Z'),
    row('a', '2026-09-15T10:00:00.000Z'),
  ];

  it('announces nothing on the first run — a backlog must not play on login', () => {
    expect(selectNewNotifications(feed, null)).toEqual([]);
  });

  it('returns only rows newer than the marker, oldest first', () => {
    const picked = selectNewNotifications(feed, '2026-09-15T10:00:00.000Z');
    expect(picked.map((n) => n.id)).toEqual(['b', 'c']);
  });

  it('returns nothing when the feed has not moved', () => {
    expect(selectNewNotifications(feed, '2026-09-15T10:02:00.000Z')).toEqual([]);
  });

  it('is unbothered by a feed that arrives out of order', () => {
    const shuffled = [feed[1], feed[2], feed[0]];
    const picked = selectNewNotifications(shuffled, '2026-09-15T10:00:00.000Z');
    expect(picked.map((n) => n.id)).toEqual(['b', 'c']);
  });
});

describe('newestCreatedAt', () => {
  it('finds the newest timestamp regardless of order', () => {
    expect(newestCreatedAt([row('a', '2026-09-15T10:00:00.000Z'), row('b', '2026-09-15T10:05:00.000Z')]))
      .toBe('2026-09-15T10:05:00.000Z');
  });

  it('is null for an empty feed', () => {
    expect(newestCreatedAt([])).toBeNull();
  });
});

describe('claimAnnouncement', () => {
  beforeEach(() => localStorage.clear());

  it('lets the first caller announce and refuses the second — one chime, not one per tab', () => {
    expect(claimAnnouncement('n1')).toBe(true);
    expect(claimAnnouncement('n1')).toBe(false);
  });

  it('claims different notifications independently', () => {
    expect(claimAnnouncement('n1')).toBe(true);
    expect(claimAnnouncement('n2')).toBe(true);
  });

  it('forgets stale claims so localStorage cannot grow without bound', () => {
    const old = Date.now() - 25 * 60 * 60 * 1000;
    localStorage.setItem('1gov-announced:old', String(old));
    claimAnnouncement('n1');
    expect(localStorage.getItem('1gov-announced:old')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run lib/notifications/announce.test.ts`
Expected: FAIL — cannot resolve `./announce`.

- [ ] **Step 3: Implement it**

```typescript
'use client';

import type { AudibleType } from '@/stores/notifications.store';

/** One row of GET /notifications. */
export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  actionUrl?: string | null;
  createdAt: string;
  isRead?: boolean;
}

/** The only two types worth interrupting someone for. */
export const AUDIBLE_TYPES = ['NEW_MAIL', 'EVENT_SOON'] as const;

export function isAudible(type: string): type is AudibleType {
  return (AUDIBLE_TYPES as readonly string[]).includes(type);
}

/**
 * The rows this device has not announced yet, oldest first.
 *
 * `lastAnnouncedAt === null` means this device has never announced anything, and
 * returns NOTHING on purpose: the feed holds up to 50 rows and replaying them as
 * a burst of chimes at login would be the first thing a user disables.
 */
export function selectNewNotifications(
  feed: NotificationRow[],
  lastAnnouncedAt: string | null,
): NotificationRow[] {
  if (!lastAnnouncedAt) return [];
  return feed
    .filter((n) => n.createdAt > lastAnnouncedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The newest `createdAt` in the feed, or null when it is empty. */
export function newestCreatedAt(feed: NotificationRow[]): string | null {
  return feed.reduce<string | null>(
    (newest, n) => (!newest || n.createdAt > newest ? n.createdAt : newest),
    null,
  );
}

const CLAIM_PREFIX = '1gov-announced:';
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Claim the right to announce `id`, across every tab of this browser.
 *
 * Server-side dedupe yields ONE notification row, but every open tab reads that
 * row and would chime. The first tab to write the claim key announces; the rest
 * see it and stay quiet. A lost race costs one duplicate chime, which is why
 * this is a plain key rather than a coordination protocol.
 */
export function claimAnnouncement(id: string, now: number = Date.now()): boolean {
  try {
    const key = `${CLAIM_PREFIX}${id}`;
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, String(now));

    // Opportunistic sweep: claims are worthless once they are a day old, and
    // nothing else would ever remove them.
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (!k?.startsWith(CLAIM_PREFIX)) continue;
      const at = Number(localStorage.getItem(k));
      if (!Number.isFinite(at) || now - at > CLAIM_TTL_MS) localStorage.removeItem(k);
    }
    return true;
  } catch {
    // Private mode or a full quota: announce rather than stay silent.
    return true;
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/web && npx vitest run lib/notifications/announce.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/notifications/announce.ts apps/web/lib/notifications/announce.test.ts
git commit -m "feat(web): decide which notifications to announce

Pure logic, separated from the component so it can be tested honestly: which
rows are new since this device last announced, which types are audible, and a
localStorage claim so one tab chimes rather than all of them. The first poll
after login announces nothing — replaying a 50-row backlog as chimes is the
fastest way to make someone turn the feature off."
```

---

### Task 5: The shell that announces

**Files:**
- Create: `apps/web/components/notifications/NotificationAlerts.tsx`
- Test: `apps/web/components/notifications/NotificationAlerts.test.tsx`
- Modify: `apps/web/app/(app)/layout.tsx` (mount it)
- Modify: `apps/web/app/(app)/mail/page.tsx:491` (drop `electronAPI.sendNotification`, keep `setBadgeCount`)

**Interfaces:**
- Consumes: `api.notifications.getAll`, `selectNewNotifications`, `newestCreatedAt`, `claimAnnouncement`, `isAudible`, `playTone`, `unlockAudio`, `useNotificationsStore`.
- Produces: `<NotificationAlerts />` — no props, mounted exactly once.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationAlerts } from './NotificationAlerts';
import { useNotificationsStore } from '@/stores/notifications.store';
import { api } from '@/lib/api';
import { playTone } from '@/lib/notifications/chime';
import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

// Vitest cannot spy on a plain ESM named export — the binding the component
// imported is not the one vi.spyOn would replace. Mock the module instead.
vi.mock('@/lib/notifications/chime', () => ({
  playTone: vi.fn().mockResolvedValue(true),
  unlockAudio: vi.fn(),
}));

const MARKER = '2026-09-15T10:00:00.000Z';
const mailRow = { id: 'n1', type: 'NEW_MAIL', title: '2 new messages', body: 'Inbox now has 5 unread', actionUrl: '/mail', createdAt: '2026-09-15T10:01:00.000Z' };
const taskRow = { id: 'n2', type: 'TASK_DUE', title: 'Task due', createdAt: '2026-09-15T10:02:00.000Z' };

function renderAlerts() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><NotificationAlerts /></QueryClientProvider>,
  );
}

describe('NotificationAlerts', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useNotificationsStore.setState({
      soundEnabled: true, volume: 0.6,
      tones: { NEW_MAIL: 'soft', EVENT_SOON: 'double' },
      lastAnnouncedAt: MARKER,
    });
  });

  it('toasts and chimes for an audible notification', async () => {
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);
    const play = vi.mocked(playTone);

    renderAlerts();

    await waitFor(() => expect(toast).toHaveBeenCalledWith('2 new messages', expect.anything()));
    expect(play).toHaveBeenCalledWith('soft', 0.6);
  });

  it('toasts a silent type without playing anything', async () => {
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([taskRow] as any);
    const play = vi.mocked(playTone);

    renderAlerts();

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Task due', expect.anything()));
    expect(play).not.toHaveBeenCalled();
  });

  it('stays silent when the user has turned sound off', async () => {
    useNotificationsStore.setState({ soundEnabled: false });
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);
    const play = vi.mocked(playTone);

    renderAlerts();

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(play).not.toHaveBeenCalled();
  });

  it('says nothing at all when another tab has already claimed the row', async () => {
    localStorage.setItem('1gov-announced:n1', String(Date.now()));
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);
    const play = vi.mocked(playTone);

    renderAlerts();

    await waitFor(() => expect(useNotificationsStore.getState().lastAnnouncedAt).toBe(mailRow.createdAt));
    expect(toast).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('announces nothing on a first run, but records where the feed had got to', async () => {
    useNotificationsStore.setState({ lastAnnouncedAt: null });
    vi.spyOn(api.notifications, 'getAll').mockResolvedValue([mailRow] as any);

    renderAlerts();

    await waitFor(() => expect(useNotificationsStore.getState().lastAnnouncedAt).toBe(mailRow.createdAt));
    expect(toast).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run components/notifications/NotificationAlerts.test.tsx`
Expected: FAIL — cannot resolve `./NotificationAlerts`.

- [ ] **Step 3: Implement the component**

```typescript
'use client';

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useNotificationsStore } from '@/stores/notifications.store';
import { playTone, unlockAudio } from '@/lib/notifications/chime';
import {
  claimAnnouncement, isAudible, newestCreatedAt, selectNewNotifications,
  type NotificationRow,
} from '@/lib/notifications/announce';

/**
 * Turns the notification feed into things a person can notice: a toast, a
 * chime, and — only when the window is hidden — an operating-system
 * notification.
 *
 * Mounted ONCE in the (app) layout, so every page alerts, not just Mail. It
 * shares the query key 'notifications' with the bell, so the two ride one
 * request and can never disagree about what has arrived.
 */
export function NotificationAlerts() {
  const soundEnabled = useNotificationsStore((s) => s.soundEnabled);
  const volume = useNotificationsStore((s) => s.volume);
  const tones = useNotificationsStore((s) => s.tones);
  const setLastAnnouncedAt = useNotificationsStore((s) => s.setLastAnnouncedAt);
  const announcing = useRef(false);

  const { data: feed = [] } = useQuery<NotificationRow[]>({
    queryKey: ['notifications'],
    queryFn: () => api.notifications.getAll(50) as Promise<NotificationRow[]>,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  // Browsers refuse audio until the user has interacted with the page. The
  // first gesture after mount is enough, and costs nothing if audio is already
  // allowed.
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    if (!feed.length || announcing.current) return;
    announcing.current = true;

    const marker = useNotificationsStore.getState().lastAnnouncedAt;
    const fresh = selectNewNotifications(feed, marker);

    for (const row of fresh) {
      // One tab announces; the others see the claim and stay quiet.
      if (!claimAnnouncement(row.id)) continue;

      toast(row.title, { description: row.body ?? undefined });

      if (soundEnabled && isAudible(row.type)) {
        void playTone(tones[row.type], volume);
      }

      // An OS notification is for when the user is looking somewhere else.
      // Raising one over a window they are already reading is just noise.
      if (document.visibilityState === 'hidden' && typeof Notification !== 'undefined'
          && Notification.permission === 'granted') {
        try {
          new Notification(row.title, { body: row.body ?? undefined, tag: row.id });
        } catch {
          // Notification can throw on platforms that require a service worker;
          // the toast and chime have already done the job.
        }
      }
    }

    // Move the marker even when nothing was announced (first run, or another
    // tab claimed everything) so the same rows are never reconsidered.
    const newest = newestCreatedAt(feed);
    if (newest) setLastAnnouncedAt(newest);
    announcing.current = false;
  }, [feed, soundEnabled, volume, tones, setLastAnnouncedAt]);

  return null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/web && npx vitest run components/notifications/NotificationAlerts.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Mount it in the app shell**

In `apps/web/app/(app)/layout.tsx`, beside the other mounts:

```tsx
import { NotificationAlerts } from '@/components/notifications/NotificationAlerts';
```

```tsx
      <AiProfileSyncMount />
      <NotificationAlerts />
```

- [ ] **Step 6: Remove the duplicate desktop notification**

In `apps/web/app/(app)/mail/page.tsx`, inside `checkInbox`, delete ONLY the `window.electronAPI?.sendNotification(...)` call and the `newCount` computation feeding it. **Keep `window.electronAPI?.setBadgeCount(currentUnread)`** and keep `lastInboxUnreadRef` bookkeeping. Leave this comment in its place:

```typescript
        // New-mail alerting lives in NotificationAlerts (app shell) now, driven
        // by the server-side NEW_MAIL notification. Announcing here too would
        // make the desktop build alert twice for one arrival.
```

- [ ] **Step 7: Run the full web suite**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit`
Expected: all PASS, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/components/notifications apps/web/app/\(app\)/layout.tsx apps/web/app/\(app\)/mail/page.tsx
git commit -m "feat(web): announce notifications with a toast, a chime and an OS notification

One shell mount turns the notification feed into things a person notices, on
every page rather than only Mail. It shares the 'notifications' query key with
the bell, so one request feeds both and they cannot disagree. The OS
notification is raised only while the document is hidden — over a window the
user is already reading it would be noise.

Drops the Electron-only sendNotification call from the mail page, which would
otherwise alert twice in the desktop build. setBadgeCount stays: the macOS dock
badge has no replacement here."
```

---

### Task 6: The bell returns to the rail

**Files:**
- Modify: `apps/web/components/layout/AIRail.tsx`
- Test: `apps/web/components/layout/AIRail.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `NotificationsBell` from `@/components/layout/NotificationsBell` (exists, self-contained, owns its own query and popover).
- Produces: no new exports. `AIRail`'s props are unchanged — the bell fetches its own data.

**Note for the implementer:** `AIRail` is currently rendered only by the mail page. The bell therefore appears on Mail only; alerting is app-wide regardless, because Task 5 mounts in the layout. This matches the approved design; do not widen it here.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AIRail } from './AIRail';

vi.mock('@/components/layout/NotificationsBell', () => ({
  NotificationsBell: () => <div data-testid="bell" />,
}));

const props = {
  aiEnabled: true, briefingOpen: false, commitmentsOpen: false, askOpen: false,
  onBriefing: vi.fn(), onCommitments: vi.fn(), onAsk: vi.fn(),
};

describe('AIRail', () => {
  it('carries the notification bell', () => {
    render(<AIRail {...props} />);
    expect(screen.getByTestId('bell')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run components/layout/AIRail.test.tsx`
Expected: FAIL — no element with `data-testid="bell"`.

- [ ] **Step 3: Add the bell to the rail**

In `apps/web/components/layout/AIRail.tsx`, import it:

```typescript
import { NotificationsBell } from '@/components/layout/NotificationsBell';
```

and render it in the utilities group of the `<nav>`, immediately above the theme toggle:

```tsx
        {/* Notifications: its own popover and query — the rail only gives it a
            home. Alerting itself is app-wide and lives in NotificationAlerts. */}
        <NotificationsBell />
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/web && npx vitest run components/layout/AIRail.test.tsx && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/layout/AIRail.tsx apps/web/components/layout/AIRail.test.tsx
git commit -m "feat(web): put the notification bell back, in the intelligence rail

The component and its polling have existed since the notifications work but
were mounted nowhere after the 05 Sept look-and-feel pass cleared the sidebar.
The rail is where that pass moved utilities, so the bell goes there rather than
back into the sidebar it was deliberately removed from."
```

---

### Task 7: Settings — Notifications

**Files:**
- Modify: `apps/web/app/(app)/settings/page.tsx` (new `Section` id, `NavItem`, and a `NotificationsSection` component)
- Test: `apps/web/app/(app)/settings/notifications-section.test.tsx`

**Interfaces:**
- Consumes: `useNotificationsStore`, `playTone`, `unlockAudio`, `TONES`.
- Produces: `export function NotificationsSection()` — exported from the settings page module so the test can mount it alone.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotificationsSection } from './page';
import { useNotificationsStore } from '@/stores/notifications.store';
import { playTone } from '@/lib/notifications/chime';

// Same reason as the NotificationAlerts spec: an ESM named export cannot be
// spied on after the fact, so the module is mocked. TONES is kept real so the
// tone <select> still renders the four genuine options.
vi.mock('@/lib/notifications/chime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notifications/chime')>()),
  playTone: vi.fn().mockResolvedValue(true),
  unlockAudio: vi.fn(),
}));

describe('NotificationsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useNotificationsStore.setState({
      soundEnabled: true, volume: 0.6,
      tones: { NEW_MAIL: 'soft', EVENT_SOON: 'double' }, lastAnnouncedAt: null,
    });
  });

  it('turns sound off and on', () => {
    render(<NotificationsSection />);
    fireEvent.click(screen.getByLabelText('Play a sound for notifications'));
    expect(useNotificationsStore.getState().soundEnabled).toBe(false);
  });

  it('changes the chime for new mail without touching the calendar one', () => {
    render(<NotificationsSection />);
    fireEvent.change(screen.getByLabelText('New mail sound'), { target: { value: 'chord' } });

    expect(useNotificationsStore.getState().tones).toEqual({ NEW_MAIL: 'chord', EVENT_SOON: 'double' });
  });

  it('plays the chosen tone when testing it — the click doubles as the audio unlock', () => {
    const play = vi.mocked(playTone);
    render(<NotificationsSection />);

    fireEvent.click(screen.getByLabelText('Test the new mail sound'));

    expect(play).toHaveBeenCalledWith('soft', 0.6);
  });

  it('asks for OS-notification permission only when sound is switched ON', () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    (globalThis as any).Notification = { permission: 'default', requestPermission };

    render(<NotificationsSection />);
    fireEvent.click(screen.getByLabelText('Play a sound for notifications')); // -> off
    expect(requestPermission).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Play a sound for notifications')); // -> on
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run "app/(app)/settings/notifications-section.test.tsx"`
Expected: FAIL — `NotificationsSection` is not exported from `./page`.

- [ ] **Step 3: Implement the section**

In `apps/web/app/(app)/settings/page.tsx`, add to the `Section` union: `| 'notifications'`. Add the nav item after Preferences:

```tsx
        <NavItem icon={Bell} label="Notifications" active={section === 'notifications'} onClick={() => setSection('notifications')} />
```

Render it beside the other DB-free sections (it needs no Zimbra settings, so it goes in the same early branch as `ai-profile`):

```tsx
          {section === 'notifications' ? (
            <NotificationsSection />
          ) : section === 'ai-profile' ? (
```

And add the component (exported, so the test can mount it alone):

```tsx
export function NotificationsSection() {
  const { soundEnabled, volume, tones, setSoundEnabled, setVolume, setTone } = useNotificationsStore();

  const toggleSound = async (next: boolean) => {
    setSoundEnabled(next);
    // Ask for OS-notification permission at the moment the user shows they want
    // to be alerted — never on page load, which is how permission gets denied
    // permanently.
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* denied is fine */ }
    }
  };

  const test = (type: 'NEW_MAIL' | 'EVENT_SOON') => {
    unlockAudio();           // this click is a real user gesture
    void playTone(tones[type], volume);
  };

  const toneSelect = (type: 'NEW_MAIL' | 'EVENT_SOON', label: string, testLabel: string) => (
    <div className="flex items-center gap-2">
      <label className="flex flex-col gap-1 text-ui text-ink-2 flex-1">
        {label}
        <select
          aria-label={label}
          value={tones[type]}
          onChange={(e) => setTone(type, e.target.value as ToneName)}
          className="w-full rounded border border-border/50 bg-background px-2 py-1 text-ui"
        >
          {Object.keys(TONES).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <Button size="sm" variant="outline" aria-label={testLabel} onClick={() => test(type)} className="mt-5">
        Test
      </Button>
    </div>
  );

  return (
    <div>
      <SectionHeader
        title="Notifications"
        description="New mail and calendar reminders can make a sound. Stored on this device."
      />
      <div className="space-y-4 max-w-sm">
        <label className="flex items-center gap-2 text-ui">
          <input
            type="checkbox"
            aria-label="Play a sound for notifications"
            checked={soundEnabled}
            onChange={(e) => void toggleSound(e.target.checked)}
          />
          Play a sound for notifications
        </label>

        <label className="flex flex-col gap-1 text-ui text-ink-2">
          Volume
          <input
            type="range" min={0} max={1} step={0.1}
            aria-label="Volume"
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
          />
        </label>

        {toneSelect('NEW_MAIL', 'New mail sound', 'Test the new mail sound')}
        {toneSelect('EVENT_SOON', 'Calendar reminder sound', 'Test the calendar reminder sound')}
      </div>
    </div>
  );
}
```

Add the imports at the top of the settings page:

```typescript
import { Bell } from 'lucide-react';
import { useNotificationsStore, type ToneName } from '@/stores/notifications.store';
import { TONES, playTone, unlockAudio } from '@/lib/notifications/chime';
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/web && npx vitest run "app/(app)/settings/notifications-section.test.tsx"`
Expected: PASS (4 tests).

- [ ] **Step 5: Run everything**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit && cd ../api && npx jest && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS, both tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/\(app\)/settings/page.tsx apps/web/app/\(app\)/settings/notifications-section.test.tsx
git commit -m "feat(web): Settings — notification sound controls

On/off, volume, and a chime per audible type with a Test button beside each.
Stored per device, because which sound a machine makes is a property of the
machine, not the account, and nothing should stand between a person and
silencing it.

Switching sound ON is also the only moment the app asks for OS-notification
permission — asking on page load is how permission gets refused forever."
```

---

## After the last task

- [ ] Deploy api + web to `.154` and `.155` (`scripts/build-api.sh`, `scripts/build-web-154.sh`, `scripts/build-web-155.sh`). No migration: `NEW_MAIL` is a string in an existing column.
- [ ] Live check on `.155` (HTTPS): send yourself mail, wait for a folder sync, confirm the chime, the toast, and — with the window hidden — the OS notification.
- [ ] Live check on `.154` (HTTP): confirm the chime and toast still work and that NO OS notification is attempted. This is the documented secure-context limit, not a bug.
- [ ] Release note: a chime can lag the mail by up to two minutes; `.154` cannot raise OS notifications; nothing is heard while the app is closed.
