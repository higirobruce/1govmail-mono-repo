import { describe, it, expect, vi } from 'vitest';
import { quickAddEventPrefill } from './quickAddEvent';

describe('quickAddEventPrefill', () => {
  it('AI off: returns the raw text as the title only, never calls the model', async () => {
    const chat = vi.fn(async () => 'unused');

    const result = await quickAddEventPrefill('  Steering committee Tuesday 10-11  ', {
      enabled: false,
      model: 'm',
      client: { chat },
    });

    expect(chat).not.toHaveBeenCalled();
    expect(result).toEqual({ title: 'Steering committee Tuesday 10-11' });
  });

  it('AI on: maps parsed fields onto the prefill, omitting null/empty ones', async () => {
    const chat = vi.fn(async () =>
      JSON.stringify({
        title: 'Steering committee',
        startAt: '2026-09-08T10:00',
        endAt: '2026-09-08T11:00',
        allDay: false,
        location: 'Room 4B',
        attendees: ['erick@gov.rw', 'tricia@gov.rw'],
      }),
    );

    const result = await quickAddEventPrefill(
      'Steering committee Tuesday 10-11 with Erick and Tricia',
      { enabled: true, model: 'gemma2:2b', client: { chat } },
    );

    expect(chat).toHaveBeenCalledTimes(1);
    // allDay:false is the default state already — omitted like the other
    // absent/empty fields rather than carried as an explicit false.
    expect(result).toEqual({
      title: 'Steering committee',
      startAt: '2026-09-08T10:00',
      endAt: '2026-09-08T11:00',
      location: 'Room 4B',
      attendees: ['erick@gov.rw', 'tricia@gov.rw'],
    });
  });

  it('AI on but allDay is true: allDay is included', async () => {
    const chat = vi.fn(async () =>
      JSON.stringify({
        title: 'Public holiday',
        startAt: '2026-09-08',
        endAt: null,
        allDay: true,
        location: null,
        attendees: [],
      }),
    );

    const result = await quickAddEventPrefill('Public holiday next Tuesday', {
      enabled: true,
      model: 'm',
      client: { chat },
    });

    expect(result).toEqual({
      title: 'Public holiday',
      startAt: '2026-09-08',
      allDay: true,
    });
  });

  it('AI on but the model returned garbage: prefill falls back to the raw title', async () => {
    const chat = vi.fn(async () => 'not json at all');

    const result = await quickAddEventPrefill('lunch with the team', {
      enabled: true,
      model: 'm',
      client: { chat },
    });

    expect(result).toEqual({ title: 'lunch with the team' });
  });

  it('aborted signal: throws AbortError instead of returning a prefill', async () => {
    const controller = new AbortController();
    controller.abort();
    const chat = vi.fn(async () =>
      JSON.stringify({ title: 'lunch', startAt: null, endAt: null, allDay: false, location: null, attendees: [] }),
    );

    await expect(
      quickAddEventPrefill('lunch', {
        enabled: true,
        model: 'm',
        client: { chat },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
