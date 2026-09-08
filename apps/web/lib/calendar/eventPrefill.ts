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

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The form keeps `startAt`/`endAt` as full local datetimes ("yyyy-MM-dd'T'HH:mm")
 * — that single shape is what `DateTimePicker`, the duration math and the save
 * path all assume. A parse can hand back a bare date instead: `allDay: true`
 * results keep the bare date by design, and a `{startAt: null, endAt: "..."}`
 * shape escapes `validate()`'s date-only repair. Widen those at the merge
 * boundary so two different string shapes never coexist in form state (a bare
 * date reaching the save path is read as UTC midnight, silently shifting the
 * event by the local UTC offset once all-day is switched off).
 */
export function toFormDateTime(value: string, edge: 'start' | 'end' = 'start'): string {
  return DATE_ONLY_RE.test(value) ? `${value}T${edge === 'end' ? '23:59' : '00:00'}` : value;
}

/** Element-wise list comparison, so a re-run can tell "unchanged" from "new array". */
export function sameAttendees(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
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
    result.startAt = toFormDateTime(parsed.startAt, 'start');
  }

  // endAt: set only if clean and parsed has a value
  if (!dirty.has('endAt') && parsed.endAt) {
    result.endAt = toFormDateTime(parsed.endAt, 'end');
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

    // Only hand back a new array when something was actually added — an
    // unchanged list must keep `current`'s reference so a repeated merge is a
    // fixed point and the caller's write-back stays a no-op.
    if (merged.length > current.attendees.length) {
      result.attendees = merged;
    }
  }

  return result;
}
