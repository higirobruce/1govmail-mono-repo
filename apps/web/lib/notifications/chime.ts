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
