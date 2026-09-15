'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AudibleType } from '@/lib/notifications/announce';

export type ToneName = 'soft' | 'ping' | 'double' | 'chord';

// The audible types and their union are defined once, beside the code that
// decides what to announce, and re-exported here so the two declarations cannot
// drift apart — drift between them degrades to silence.
export type { AudibleType };

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
   *
   * Every COMPLETED poll records one, including a poll that came back empty:
   * that one has no server timestamp to borrow and records the client's own
   * ISO time instead (see NotificationAlerts). So after any poll this is
   * non-null, and `initialized` with a null marker — the state that replayed a
   * whole backlog — cannot be written by this build.
   */
  lastAnnouncedAt: string | null;
  /**
   * Whether this device has ever completed a poll of the feed.
   *
   * Without it a null `lastAnnouncedAt` was ambiguous, and the ambiguity cost a
   * real alert: a device whose first poll came back EMPTY recorded no marker,
   * and a null marker meant "suppress everything", so the next genuine arrival
   * was swallowed too. The backlog suppression it was protecting only applies
   * to a first poll that actually returned rows.
   *
   * An empty poll now records a marker of its own, which is the primary fix —
   * the flag no longer has to carry that distinction for any store this build
   * writes. It is kept because it is the only thing that can read a store
   * PERSISTED by the build that had the bug (initialized, no marker); see
   * `selectNewNotifications`.
   */
  initialized: boolean;
  setSoundEnabled: (v: boolean) => void;
  setVolume: (v: number) => void;
  setTone: (type: AudibleType, tone: ToneName) => void;
  setLastAnnouncedAt: (iso: string) => void;
  markInitialized: () => void;
}

export const useNotificationsStore = create<NotificationsState>()(
  persist(
    (set) => ({
      soundEnabled: true,
      volume: 0.6,
      tones: { NEW_MAIL: 'soft', EVENT_SOON: 'double' },
      lastAnnouncedAt: null,
      initialized: false,
      setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
      setVolume: (v) => set({ volume: Math.min(1, Math.max(0, v)) }),
      setTone: (type, tone) => set((s) => ({ tones: { ...s.tones, [type]: tone } })),
      // Monotonic: a slow response arriving after a fast one must not rewind
      // the marker and replay alerts the user already heard.
      setLastAnnouncedAt: (iso) =>
        set((s) => (!s.lastAnnouncedAt || iso > s.lastAnnouncedAt ? { lastAnnouncedAt: iso } : s)),
      // One-way, and persisted: once this device has seen the feed there is no
      // backlog left to protect it from.
      markInitialized: () => set((s) => (s.initialized ? s : { initialized: true })),
    }),
    { name: 'notifications' },
  ),
);
