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
   * ISO time instead (see NotificationAlerts). So null means exactly one
   * thing — this device has never completed a poll — and there is no second
   * flag to disambiguate it. An earlier build carried an `initialized` flag
   * for that job; recording a marker on an empty poll does it instead, and
   * without the state where the two disagreed and a whole backlog replayed.
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
