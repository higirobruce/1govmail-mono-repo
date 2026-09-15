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
