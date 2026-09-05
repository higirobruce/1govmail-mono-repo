import type { ParsedEvent } from '@/lib/ai/eventParse';

export type EventFieldKey = 'title' | 'startAt' | 'endAt' | 'allDay' | 'location' | 'attendees';

export interface EventFormValues {
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  location: string;
  attendees: string[];
}

export function mergeParsedEvent(
  current: EventFormValues,
  parsed: ParsedEvent,
  dirty: ReadonlySet<EventFieldKey>,
): EventFormValues {
  const result: EventFormValues = { ...current };

  // title: set only if clean and parsed has a value
  if (!dirty.has('title') && parsed.title) {
    result.title = parsed.title;
  }

  // startAt: set only if clean and parsed has a value
  if (!dirty.has('startAt') && parsed.startAt) {
    result.startAt = parsed.startAt;
  }

  // endAt: set only if clean and parsed has a value
  if (!dirty.has('endAt') && parsed.endAt) {
    result.endAt = parsed.endAt;
  }

  // location: set only if clean and parsed has a value
  if (!dirty.has('location') && parsed.location) {
    result.location = parsed.location;
  }

  // allDay: set only if clean AND parsed.allDay is true
  if (!dirty.has('allDay') && parsed.allDay) {
    result.allDay = true;
  }

  // attendees: merge union only if clean
  if (!dirty.has('attendees') && parsed.attendees.length > 0) {
    const existing = new Set(current.attendees.map(e => e.toLowerCase()));
    const merged = [...current.attendees];

    for (const attendee of parsed.attendees) {
      const lowerAttendee = attendee.toLowerCase();
      if (!existing.has(lowerAttendee)) {
        merged.push(attendee);
        existing.add(lowerAttendee);
      }
    }

    result.attendees = merged;
  }

  return result;
}
