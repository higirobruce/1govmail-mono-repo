import { addHours, format } from 'date-fns';
import { parseJsonObject } from '@email-client/shared';
import { UNTRUSTED_CONTENT_RULE, fenceUntrusted } from '@/lib/ai/prompt';
import { extractEmailText } from '@/lib/ai/extract';
import type { AIClient } from '@/lib/ai/client';

export interface ParsedEvent {
  title: string;
  startAt: string | null; // "yyyy-MM-dd'T'HH:mm" LOCAL, matches DateTimePicker
  endAt: string | null;
  allDay: boolean;
  location: string | null;
  attendees: string[]; // lowercased emails, deduped, max 10
}

export interface EventParseOptions {
  model: string;
  now?: Date;
  signal?: AbortSignal;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const DATETIME_FORMAT = "yyyy-MM-dd'T'HH:mm";
const MAX_ATTENDEES = 10;

const SYSTEM = `${UNTRUSTED_CONTENT_RULE}

You extract calendar-event fields from text handed to you by a busy professional's email or a quick-add box. Output ONLY a strict JSON object with exactly these keys:
{"title": string, "startAt": "YYYY-MM-DDTHH:MM" or "YYYY-MM-DD" or null, "endAt": "YYYY-MM-DDTHH:MM" or "YYYY-MM-DD" or null, "allDay": boolean, "location": string or null, "attendees": string[]}

Rules:
- Datetimes are written "YYYY-MM-DDTHH:MM" in the user's local time. Resolve any relative dates ("tomorrow", "next Tuesday", "Friday 2pm") against the current date/time given in the message below.
- "attendees" must contain ONLY email addresses that literally appear in the text — never invent or guess an address. Use [] if none appear.
- Use null for any field that is absent or cannot be determined.
- No commentary, no markdown, no preamble — JSON only.`;

function nowLine(now: Date): string {
  return `Current date/time: ${format(now, "EEEE yyyy-MM-dd'T'HH:mm")}`;
}

/** Validate a raw date-ish field: must match the shape and parse to a real date. */
function normalizeDateField(v: unknown): string | null {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  return Number.isNaN(new Date(v).getTime()) ? null : v;
}

/**
 * Turn the model's raw JSON into a `ParsedEvent`, or `null` when there is
 * nothing usable (no title from the model AND no fallback title either).
 */
function validate(data: Record<string, unknown>, fallbackTitle: string, _now: Date): ParsedEvent | null {
  let title = typeof data.title === 'string' ? data.title.trim() : '';
  if (!title) title = fallbackTitle;
  if (!title) return null;

  const allDay = data.allDay === true;

  let startAt = normalizeDateField(data.startAt);
  let endAt = normalizeDateField(data.endAt);

  if (startAt && !startAt.includes('T') && !allDay) {
    const datePart = startAt;
    startAt = `${datePart}T09:00`;
    if (!endAt) {
      endAt = `${datePart}T10:00`;
    } else if (!endAt.includes('T')) {
      endAt = `${endAt}T10:00`;
    }
  }

  // Mixed shape: a timed start with a bare-date end (the date-only repair
  // above only fires when startAt itself is bare) — normalize endAt to
  // start + 1h so it never escapes the promised datetime format.
  if (startAt?.includes('T') && endAt && !endAt.includes('T') && !allDay) {
    endAt = format(addHours(new Date(startAt), 1), DATETIME_FORMAT);
  }

  if (startAt?.includes('T') && endAt?.includes('T')) {
    const startDate = new Date(startAt);
    const endDate = new Date(endAt);
    if (endDate.getTime() <= startDate.getTime()) {
      endAt = format(addHours(startDate, 1), DATETIME_FORMAT);
    }
  }

  const location = typeof data.location === 'string' && data.location.trim() ? data.location.trim() : null;

  const attendees = Array.isArray(data.attendees)
    ? Array.from(
        new Set(
          data.attendees
            .filter((s): s is string => typeof s === 'string' && s.includes('@'))
            .map((s) => s.trim().toLowerCase()),
        ),
      ).slice(0, MAX_ATTENDEES)
    : [];

  return { title, startAt, endAt, allDay, location, attendees };
}

export async function parseEventFromEmail(
  client: Pick<AIClient, 'chat'>,
  email: { subject: string; from: string; bodyText?: string | null; bodyHtml?: string | null },
  opts: EventParseOptions,
): Promise<ParsedEvent | null> {
  try {
    const now = opts.now ?? new Date();
    const body = extractEmailText({ bodyText: email.bodyText, bodyHtml: email.bodyHtml }, { maxChars: 3000 });
    const emailBlock = `Subject: ${email.subject}\nFrom: ${email.from}\n\n${body}`;

    const raw = await client.chat({
      model: opts.model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${nowLine(now)}\n\n${fenceUntrusted('EMAIL', emailBlock)}` },
      ],
      temperature: 0.1,
      maxTokens: 300,
      responseFormat: 'json',
      signal: opts.signal,
    });

    const data = parseJsonObject(raw);
    if (!data) return null;

    return validate(data, (email.subject ?? '').trim(), now);
  } catch {
    return null;
  }
}

export async function parseEventInput(
  client: Pick<AIClient, 'chat'>,
  input: string,
  opts: EventParseOptions,
): Promise<ParsedEvent> {
  const fallback = (): ParsedEvent => ({
    title: input.trim(),
    startAt: null,
    endAt: null,
    allDay: false,
    location: null,
    attendees: [],
  });

  try {
    const now = opts.now ?? new Date();

    const raw = await client.chat({
      model: opts.model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${nowLine(now)}\n\n${fenceUntrusted('USER TEXT', input)}` },
      ],
      temperature: 0.1,
      maxTokens: 300,
      responseFormat: 'json',
      signal: opts.signal,
    });

    const data = parseJsonObject(raw);
    if (!data) return fallback();

    return validate(data, input.trim(), now) ?? fallback();
  } catch {
    return fallback();
  }
}
