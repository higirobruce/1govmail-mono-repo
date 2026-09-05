import { describe, it, expect } from 'vitest';
import { mergeParsedEvent } from './eventPrefill';
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
