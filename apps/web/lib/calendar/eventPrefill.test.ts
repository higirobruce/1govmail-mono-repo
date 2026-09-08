import { describe, it, expect } from 'vitest';
import { mergeParsedEvent, sameAttendees, toFormDateTime } from './eventPrefill';
import type { EventFormValues, EventFieldKey } from './eventPrefill';
import type { ParsedEvent } from '@/lib/ai/eventParse';

describe('mergeParsedEvent', () => {
  it('preserves dirty title when parsed provides a new title', () => {
    const current: EventFormValues = {
      title: 'User-entered title',
      startAt: '',
      endAt: '',
      allDay: false,
      location: '',
      attendees: [],
    };
    const parsed: ParsedEvent = {
      title: 'AI-parsed title',
      startAt: null,
      endAt: null,
      allDay: false,
      location: null,
      attendees: [],
    };
    const dirty = new Set<EventFieldKey>(['title']);

    const result = mergeParsedEvent(current, parsed, dirty);
    expect(result.title).toBe('User-entered title');
  });

  it('fills clean fields from parsed values', () => {
    const current: EventFormValues = {
      title: '',
      startAt: '',
      endAt: '',
      allDay: false,
      location: '',
      attendees: [],
    };
    const parsed: ParsedEvent = {
      title: 'Team meeting',
      startAt: '2026-09-05T14:00',
      endAt: '2026-09-05T15:00',
      allDay: false,
      location: 'Conference room A',
      attendees: ['alice@example.com'],
    };
    const dirty = new Set<EventFieldKey>();

    const result = mergeParsedEvent(current, parsed, dirty);
    expect(result.title).toBe('Team meeting');
    expect(result.startAt).toBe('2026-09-05T14:00');
    expect(result.endAt).toBe('2026-09-05T15:00');
    expect(result.location).toBe('Conference room A');
    expect(result.attendees).toEqual(['alice@example.com']);
  });

  it('leaves clean fields alone when parsed values are null', () => {
    const current: EventFormValues = {
      title: 'Meeting',
      startAt: '2026-09-05T10:00',
      endAt: '2026-09-05T11:00',
      allDay: false,
      location: 'Room 1',
      attendees: ['bob@example.com'],
    };
    const parsed: ParsedEvent = {
      title: 'Parsed title',
      startAt: null,
      endAt: null,
      allDay: false,
      location: null,
      attendees: [],
    };
    const dirty = new Set<EventFieldKey>();

    const result = mergeParsedEvent(current, parsed, dirty);
    expect(result.startAt).toBe('2026-09-05T10:00');
    expect(result.endAt).toBe('2026-09-05T11:00');
    expect(result.location).toBe('Room 1');
    expect(result.attendees).toEqual(['bob@example.com']);
  });

  it('dedupes attendees case-insensitively when merging', () => {
    const current: EventFormValues = {
      title: 'Meeting',
      startAt: '',
      endAt: '',
      allDay: false,
      location: '',
      attendees: ['A@example.com'],
    };
    const parsed: ParsedEvent = {
      title: '',
      startAt: null,
      endAt: null,
      allDay: false,
      location: null,
      attendees: ['a@example.com', 'B@example.com'],
    };
    const dirty = new Set<EventFieldKey>();

    const result = mergeParsedEvent(current, parsed, dirty);
    expect(result.attendees).toHaveLength(2);
    expect(result.attendees).toContain('A@example.com');
    expect(result.attendees).toContain('B@example.com');
  });

  it('does not merge attendees when attendees is dirty', () => {
    const current: EventFormValues = {
      title: 'Meeting',
      startAt: '',
      endAt: '',
      allDay: false,
      location: '',
      attendees: ['existing@example.com'],
    };
    const parsed: ParsedEvent = {
      title: '',
      startAt: null,
      endAt: null,
      allDay: false,
      location: null,
      attendees: ['new@example.com'],
    };
    const dirty = new Set<EventFieldKey>(['attendees']);

    const result = mergeParsedEvent(current, parsed, dirty);
    expect(result.attendees).toEqual(['existing@example.com']);
  });

  it('does not mutate the input current object', () => {
    const current: EventFormValues = {
      title: 'Original',
      startAt: '2026-09-05T10:00',
      endAt: '2026-09-05T11:00',
      allDay: false,
      location: 'Room A',
      attendees: ['alice@example.com'],
    };
    const originalCurrent = { ...current };
    const parsed: ParsedEvent = {
      title: 'New title',
      startAt: '2026-09-06T14:00',
      endAt: '2026-09-06T15:00',
      allDay: true,
      location: 'Room B',
      attendees: ['bob@example.com'],
    };
    const dirty = new Set<EventFieldKey>();

    mergeParsedEvent(current, parsed, dirty);
    expect(current).toEqual(originalCurrent);
  });

  it('applies allDay only when clean and parsed.allDay is true', () => {
    const current: EventFormValues = {
      title: 'Meeting',
      startAt: '2026-09-05T10:00',
      endAt: '2026-09-05T11:00',
      allDay: false,
      location: '',
      attendees: [],
    };
    const parsed: ParsedEvent = {
      title: '',
      startAt: null,
      endAt: null,
      allDay: true,
      location: null,
      attendees: [],
    };
    const dirty = new Set<EventFieldKey>();

    const result = mergeParsedEvent(current, parsed, dirty);
    expect(result.allDay).toBe(true);
  });

  it('does not apply allDay when dirty', () => {
    const current: EventFormValues = {
      title: 'Meeting',
      startAt: '',
      endAt: '',
      allDay: false,
      location: '',
      attendees: [],
    };
    const parsed: ParsedEvent = {
      title: '',
      startAt: null,
      endAt: null,
      allDay: true,
      location: null,
      attendees: [],
    };
    const dirty = new Set<EventFieldKey>(['allDay']);

    const result = mergeParsedEvent(current, parsed, dirty);
    expect(result.allDay).toBe(false);
  });

  it('does not apply allDay when parsed.allDay is false', () => {
    const current: EventFormValues = {
      title: 'Meeting',
      startAt: '',
      endAt: '',
      allDay: true,
      location: '',
      attendees: [],
    };
    const parsed: ParsedEvent = {
      title: '',
      startAt: null,
      endAt: null,
      allDay: false,
      location: null,
      attendees: [],
    };
    const dirty = new Set<EventFieldKey>();

    const result = mergeParsedEvent(current, parsed, dirty);
    expect(result.allDay).toBe(true);
  });

  // ── Picker-safe shapes: the form's date fields are always full local
  //    datetimes, so no consumer has to cope with two string shapes.
  it('widens an all-day parse\'s bare dates to full local datetimes', () => {
    const current: EventFormValues = {
      title: '', startAt: '2026-09-05T10:00', endAt: '2026-09-05T11:00',
      allDay: false, location: '', attendees: [],
    };
    const parsed: ParsedEvent = {
      title: 'Workshop',
      startAt: '2026-09-12',
      endAt: '2026-09-12',
      allDay: true,
      location: 'RISA HQ',
      attendees: [],
    };

    const result = mergeParsedEvent(current, parsed, new Set<EventFieldKey>());
    expect(result.allDay).toBe(true);
    expect(result.startAt).toBe('2026-09-12T00:00');
    expect(result.endAt).toBe('2026-09-12T23:59');
    // What the DateTimePicker is handed in each mode stays well-formed.
    expect(result.startAt.split('T')[0]).toBe('2026-09-12');
    expect(Number.isNaN(new Date(result.startAt).getTime())).toBe(false);
    expect(Number.isNaN(new Date(result.endAt).getTime())).toBe(false);
  });

  it('widens a bare endAt that arrives without a startAt (validate() cannot repair that shape)', () => {
    const current: EventFormValues = {
      title: '', startAt: '2026-09-05T10:00', endAt: '2026-09-05T11:00',
      allDay: false, location: '', attendees: [],
    };
    const parsed: ParsedEvent = {
      title: 'Workshop', startAt: null, endAt: '2026-09-12',
      allDay: false, location: null, attendees: [],
    };

    const result = mergeParsedEvent(current, parsed, new Set<EventFieldKey>());
    expect(result.endAt).toBe('2026-09-12T23:59');
  });

  it('leaves already-timed values untouched', () => {
    expect(toFormDateTime('2026-09-12T14:30', 'start')).toBe('2026-09-12T14:30');
    expect(toFormDateTime('2026-09-12T14:30', 'end')).toBe('2026-09-12T14:30');
    expect(toFormDateTime('', 'start')).toBe('');
  });

  // ── Re-running the fill must be a no-op: the modal's write-back only calls
  //    setState for fields whose value actually changed, so a second run (a
  //    remount, or the effect re-firing) can never ping-pong form state.
  it('is a fixed point — merging the merged result again changes nothing', () => {
    const current: EventFormValues = {
      title: 'Invitation: Digital Skills Workshop',
      startAt: '2026-09-05T10:00',
      endAt: '2026-09-05T11:00',
      allDay: false,
      location: '',
      attendees: [],
    };
    const parsed: ParsedEvent = {
      title: 'Digital Skills Workshop',
      startAt: '2026-09-12',
      endAt: '2026-09-12',
      allDay: true,
      location: 'RISA HQ',
      attendees: ['erick@risa.gov.rw', 'jean@risa.gov.rw'],
    };
    const dirty = new Set<EventFieldKey>();

    const first = mergeParsedEvent(current, parsed, dirty);
    const second = mergeParsedEvent(first, parsed, dirty);

    expect(second).toEqual(first);
    // Identity matters as much as equality: the write-back compares values,
    // and `attendees` must not come back as a fresh array every run.
    expect(second.attendees).toBe(first.attendees);
    expect(sameAttendees(second.attendees, first.attendees)).toBe(true);
    // Every scalar field compares equal, so no setState fires on the re-run.
    expect(second.title).toBe(first.title);
    expect(second.startAt).toBe(first.startAt);
    expect(second.endAt).toBe(first.endAt);
    expect(second.allDay).toBe(first.allDay);
    expect(second.location).toBe(first.location);
  });

  it('still returns a new attendees array when the parse adds someone', () => {
    const current: EventFormValues = {
      title: '', startAt: '', endAt: '', allDay: false, location: '',
      attendees: ['erick@risa.gov.rw'],
    };
    const parsed: ParsedEvent = {
      title: '', startAt: null, endAt: null, allDay: false, location: null,
      attendees: ['jean@risa.gov.rw'],
    };

    const result = mergeParsedEvent(current, parsed, new Set<EventFieldKey>());
    expect(result.attendees).not.toBe(current.attendees);
    expect(result.attendees).toEqual(['erick@risa.gov.rw', 'jean@risa.gov.rw']);
  });

  it('sameAttendees compares element-wise', () => {
    expect(sameAttendees([], [])).toBe(true);
    expect(sameAttendees(['a@x.rw'], ['a@x.rw'])).toBe(true);
    expect(sameAttendees(['a@x.rw'], ['b@x.rw'])).toBe(false);
    expect(sameAttendees(['a@x.rw'], ['a@x.rw', 'b@x.rw'])).toBe(false);
  });

  it('returns a new object', () => {
    const current: EventFormValues = {
      title: 'Meeting',
      startAt: '',
      endAt: '',
      allDay: false,
      location: '',
      attendees: [],
    };
    const parsed: ParsedEvent = {
      title: '',
      startAt: null,
      endAt: null,
      allDay: false,
      location: null,
      attendees: [],
    };
    const dirty = new Set<EventFieldKey>();

    const result = mergeParsedEvent(current, parsed, dirty);
    expect(result).not.toBe(current);
  });
});
