import { z } from 'zod';
import type { CalendarService } from '../../calendar/calendar.service';
import type { ToolDef, ToolRef } from '../tool-registry';

function parseDate(value: string, field: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid ISO date`);
  return d;
}

function renderDate(raw: any): string {
  return raw instanceof Date ? raw.toISOString() : String(raw ?? '');
}

export function buildCalendarTools(calendar: CalendarService): ToolDef[] {
  return [
    {
      name: 'list_events',
      description: 'List the user\'s calendar events between two ISO dates (inclusive).',
      mode: 'read',
      resultBudget: 2000,
      schema: z.object({ startDate: z.string().min(4), endDate: z.string().min(4) }),
      async execute(args: any, ctx) {
        const events: any[] = await calendar.getEvents(
          ctx.userId,
          parseDate(args.startDate, 'startDate'),
          parseDate(args.endDate, 'endDate'),
        );
        const refs: ToolRef[] = events.map((e) => ({
          alias: ctx.nextAlias(),
          type: 'event',
          id: String(e.id),
          title: e.title ?? null,
          date: renderDate(e.startAt),
          snippet: `${renderDate(e.startAt)} → ${renderDate(e.endAt)}${e.location ? ` @ ${e.location}` : ''}`.slice(0, 160),
          injectionSuspected: false,
        }));
        const content = events.length
          ? events
              .map((e, i) => `[${refs[i].alias}] "${e.title}" ${renderDate(e.startAt)} → ${renderDate(e.endAt)}${e.location ? ` @ ${e.location}` : ''}${e.attendees?.length ? ` with ${e.attendees.map((a: any) => a?.name ?? a?.email ?? String(a)).join(', ')}` : ''}`)
              .join('\n')
          : 'No events in that range.';
        return { summary: `${events.length} event(s)`, content, refs };
      },
    },
    {
      name: 'get_freebusy',
      description: 'Check when people are busy between two ISO dates. Use before proposing a meeting time.',
      mode: 'read',
      resultBudget: 2000,
      schema: z.object({
        emails: z.array(z.string().email()).min(1).max(10),
        startDate: z.string().min(4),
        endDate: z.string().min(4),
      }),
      async execute(args: any, ctx) {
        const rows = await calendar.getFreeBusyBatch(
          ctx.userId,
          args.emails,
          parseDate(args.startDate, 'startDate'),
          parseDate(args.endDate, 'endDate'),
        );
        const toIso = (ms: number) => new Date(ms).toISOString();
        const content = rows
          .map((r: any) => {
            const busy = (r.busy ?? []).map((b: any) => `${toIso(b.s)}–${toIso(b.e)}`).join(', ');
            return `${r.email}: ${busy || 'free the whole range'}`;
          })
          .join('\n');
        return { summary: `Free/busy for ${rows.length} attendee(s)`, content };
      },
    },
  ];
}
