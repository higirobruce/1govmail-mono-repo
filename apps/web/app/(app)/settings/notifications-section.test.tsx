import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotificationsSection } from './page';
import { useNotificationsStore } from '@/stores/notifications.store';
import { playTone, unlockAudio } from '@/lib/notifications/chime';

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

  // The Notification stub is a plain global assignment: clearAllMocks() does
  // not remove it, so without this a later test inherits a permission state it
  // never set up.
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).Notification;
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
    // The unlock is half the point of the Test button: a browser refuses audio
    // until a real gesture, and this is the only gesture guaranteed to happen
    // before the first notification. Without this line the assertion above
    // stays green with unlockAudio() deleted from the component.
    expect(vi.mocked(unlockAudio)).toHaveBeenCalled();
  });

  it('names the tones in words, not in store keys', () => {
    render(<NotificationsSection />);
    const select = screen.getByLabelText('New mail sound') as HTMLSelectElement;

    expect(Array.from(select.options).map((o) => o.textContent))
      .toEqual(['Soft chime', 'Ping', 'Double beep', 'Chord']);
    expect(Array.from(select.options).map((o) => o.value))
      .toEqual(['soft', 'ping', 'double', 'chord']);
  });

  it("uses the page's own Switch, not a bare checkbox", () => {
    render(<NotificationsSection />);
    const toggle = screen.getByLabelText('Play a sound for notifications');

    expect(toggle.getAttribute('role')).toBe('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
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

  it('leaves no Notification stub behind for the next test', () => {
    // Canary for the teardown above — the stub is a plain global assignment
    // that clearAllMocks() does not touch.
    expect((globalThis as any).Notification).toBeUndefined();
  });
});
