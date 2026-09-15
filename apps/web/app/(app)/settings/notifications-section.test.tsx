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
