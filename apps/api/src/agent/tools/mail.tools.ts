import { z } from 'zod';
import type { MailService } from '../../mail/mail.service';
import type { RetrievalService } from '../../chat/retrieval.service';
import type { ToolDef, ToolRef, ToolContext } from '../tool-registry';
import { toIsoDate } from '../dates';

export function stripHtml(html: string): string {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// MailService rows carry `receivedAt` (a native Date, since it's a Prisma
// DateTime) — never `date` — the `m.date` branch is kept only as a defensive
// fallback for any future/alternate caller shape. Dates are rendered as ISO
// strings, not `String(Date)` (which would emit toString()'s locale-formatted
// "Mon Sep 01 2026 00:00:00 GMT+0000 (…)" into every ref/prompt).
function mailRef(ctx: ToolContext, m: any): ToolRef {
  const date = toIsoDate(m.date ?? m.receivedAt);
  return {
    alias: ctx.aliasFor('mail', String(m.id)),
    type: 'mail',
    id: String(m.id),
    title: m.subject ?? null,
    date,
    snippet: stripHtml(m.snippet ?? m.bodyText ?? m.bodyHtml ?? '').slice(0, 160),
    injectionSuspected: false,
  };
}

function renderRefs(refs: ToolRef[], rows: any[]): string {
  return refs
    .map((r, i) => {
      const m = rows[i];
      return `[${r.alias}] (id ${r.id}) "${r.title ?? '(no subject)'}" — from ${m.fromEmail ?? m.fromName ?? 'unknown'} on ${r.date}\n${r.snippet}`;
    })
    .join('\n\n');
}

// MailService.getMessage returns recipients as `toRecipients: {email, name}[]`
// (never a plain `to: string[]`) — format falls back to `to` only defensively.
function formatRecipients(m: any): string {
  if (Array.isArray(m.toRecipients)) {
    return m.toRecipients.map((r: any) => r?.email ?? r?.name ?? String(r)).join(', ');
  }
  if (Array.isArray(m.to)) return m.to.join(', ');
  return m.to ?? '';
}

/**
 * Rewrite common LLM-invented date idioms into valid Zimbra query syntax.
 * Zimbra's lexer rejects ISO dates, `..` ranges, and the nonexistent
 * `received:` operator with mail.QUERY_PARSE_ERROR (observed live: the model
 * retried `received:2026-09-01..2026-09-07` nine times before giving up).
 * Valid Zimbra dates are M/D/YYYY on `after:`/`before:`/`date:`.
 */
const isoToUs = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
};

export function normalizeZimbraQuery(query: string): string {
  let q = query;
  // field:YYYY-MM-DD..YYYY-MM-DD  →  after:M/D/YYYY before:M/D/YYYY
  q = q.replace(
    /\b\w+:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/g,
    (_, a: string, b: string) => `after:${isoToUs(a)} before:${isoToUs(b)}`,
  );
  // received: is not a Zimbra operator — treat a single date as after:
  q = q.replace(/\breceived:(\d{4}-\d{2}-\d{2})/g, (_, a: string) => `after:${isoToUs(a)}`);
  // ISO dates on real date operators → US format
  q = q.replace(
    /\b(after|before|date):(\d{4}-\d{2}-\d{2})/g,
    (_, op: string, a: string) => `${op}:${isoToUs(a)}`,
  );
  return q;
}

export function buildMailReadTools(mail: MailService, retrieval: RetrievalService): ToolDef[] {
  return [
    {
      name: 'search_emails',
      description:
        'Search the user\'s mailbox. Each result line includes the message id — pass THAT id to read_email/get_thread, never the [sN] alias. Use mode "semantic" for meaning/topic questions; use mode "keyword" for Zimbra query syntax (e.g. from:x@y.rw subject:report) — but never invent an email address: to find mail from a person by name, search their name as plain keywords first. Date filters use Zimbra operators with M/D/YYYY dates: after:8/31/2026 before:9/7/2026. There is NO received: operator, no ISO dates, no .. ranges.',
      mode: 'read',
      resultBudget: 2000,
      schema: z.object({
        query: z.string().min(1).max(300),
        mode: z.enum(['semantic', 'keyword']).default('semantic'),
        limit: z.number().int().min(1).max(10).default(6),
      }),
      async execute(args: any, ctx) {
        let rows: any[];
        if (args.mode === 'keyword') {
          const query = normalizeZimbraQuery(args.query);
          const res: any = await mail.searchMessages(ctx.userId, query, args.limit, 0);
          rows = (Array.isArray(res) ? res : res?.messages ?? []).slice(0, args.limit);
        } else {
          rows = await retrieval.semantic(ctx.userId, args.query, args.limit);
        }
        const refs = rows.map((m) => mailRef(ctx, m));
        return {
          summary: `${refs.length} message(s) found`,
          content: refs.length ? renderRefs(refs, rows) : 'No matching messages.',
          refs,
        };
      },
    },
    {
      name: 'read_email',
      description: 'Read one email in full by its message id (from search_emails or get_thread results).',
      mode: 'read',
      resultBudget: 4000,
      schema: z.object({ messageId: z.string().min(1) }),
      async execute(args: any, ctx) {
        const m: any = await mail.getMessage(ctx.userId, args.messageId);
        const ref = mailRef(ctx, m);
        const to = formatRecipients(m);
        const body = stripHtml(m.bodyHtml ?? m.bodyText ?? m.body ?? m.snippet ?? '');
        const atts: any[] = Array.isArray(m.attachments) ? m.attachments : [];
        const attLine = atts.length
          ? `\nAttachments: ${atts
              .map((a: any) => `"${a.filename}" (part ${a.id}, ${a.mimeType})`)
              .join('; ')} — use read_attachment to open one.`
          : '';
        return {
          summary: `Read "${m.subject ?? '(no subject)'}"`,
          content: `[${ref.alias}] EMAIL "${m.subject ?? ''}"\nFrom: ${m.fromEmail ?? ''}\nTo: ${to}\nDate: ${ref.date}${attLine}\n\n${body}`,
          refs: [ref],
        };
      },
    },
    {
      name: 'get_thread',
      description: 'Get the whole conversation a message belongs to, oldest first, with a short excerpt per message.',
      mode: 'read',
      resultBudget: 4000,
      schema: z.object({ messageId: z.string().min(1) }),
      async execute(args: any, ctx) {
        const conv: any = await mail.getConversation(ctx.userId, args.messageId);
        const rows: any[] = Array.isArray(conv) ? conv : conv?.messages ?? [];
        const refs = rows.map((m) => mailRef(ctx, m));
        return {
          summary: `Thread with ${rows.length} message(s)`,
          content: rows.length ? renderRefs(refs, rows) : 'Thread not found or empty.',
          refs,
        };
      },
    },
  ];
}

/**
 * Deterministic per-day mail counts straight from the mail server's own
 * totals — the model cannot count a week by paging 10-result searches
 * (observed live: it burned all 8 iterations trying, then answered without
 * a chart). One Zimbra query per day with exact date bounds; `total` comes
 * from the server, not from counting rows.
 */
export function buildMailStatsTool(mail: MailService): ToolDef {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const us = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    name: 'get_mail_stats',
    description:
      'Count received emails per day over a date range (max 31 days). Use this for statistics and charts — it returns exact per-day totals from the mail server, unlike search_emails which only pages a few results.',
    mode: 'read',
    resultBudget: 1500,
    schema: z.object({
      startDate: z.string().min(8).max(10),
      endDate: z.string().min(8).max(10),
    }),
    async execute(args: any, ctx) {
      const start = new Date(`${args.startDate}T00:00:00Z`);
      const end = new Date(`${args.endDate}T00:00:00Z`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new Error('startDate/endDate must be YYYY-MM-DD dates');
      }
      if (end.getTime() < start.getTime()) throw new Error('startDate must be before endDate');
      const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
      if (days > 31) throw new Error('range too large — at most 31 days');
      const lines: string[] = [];
      let total = 0;
      for (let i = 0; i < days; i++) {
        const day = new Date(start.getTime() + i * DAY_MS);
        const query = `after:${us(new Date(day.getTime() - DAY_MS))} before:${us(new Date(day.getTime() + DAY_MS))}`;
        const res: any = await mail.searchMessages(ctx.userId, query, 1, 0);
        const count = typeof res?.total === 'number' ? res.total : (res?.messages ?? []).length;
        total += count;
        lines.push(`${iso(day)}: ${count}`);
      }
      return {
        summary: `Counted ${days} day(s), ${total} email(s)`,
        content: `Emails received per day:\n${lines.join('\n')}\nTotal: ${total}`,
      };
    },
  };
}
