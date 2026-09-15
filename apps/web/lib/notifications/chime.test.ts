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
      createOscillator: vi.fn(osc), createGain: vi.fn(gain),
      // Honest fake: the real AudioContext#resume() returns a promise that
      // can reject (e.g. a closed context) — default to a resolved one so
      // tests can override it to reject when exercising that path.
      resume: vi.fn(() => Promise.resolve()),
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

  it('plays through a suspended context, resuming it along the way', async () => {
    const { ctx } = fakeContext('suspended');
    const played = await playTone('ping', 1, () => ctx);

    expect(played).toBe(true);
    expect(ctx.resume).toHaveBeenCalled();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(TONES.ping.length);
  });

  it('never rejects when resume() itself rejects', async () => {
    const { ctx } = fakeContext('suspended');
    (ctx.resume as ReturnType<typeof vi.fn>).mockReturnValue(Promise.reject(new Error('cannot resume')));

    await expect(playTone('ping', 1, () => ctx)).resolves.toBe(true);
  });
});
