import { z } from 'zod';
import type { MailService } from '../../mail/mail.service';
import type { RetrievalService } from '../../chat/retrieval.service';
import type { ToolDef, ToolRef, ToolContext } from '../tool-registry';

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
  const raw = m.date ?? m.receivedAt;
  const date = raw instanceof Date ? raw.toISOString() : String(raw ?? '');
  return {
    alias: ctx.nextAlias(),
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
      return `[${r.alias}] "${r.title ?? '(no subject)'}" — from ${m.fromEmail ?? m.fromName ?? 'unknown'} on ${r.date}\n${r.snippet}`;
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

export function buildMailReadTools(mail: MailService, retrieval: RetrievalService): ToolDef[] {
  return [
    {
      name: 'search_emails',
      description:
        'Search the user\'s mailbox and get message ids for read_email/get_thread. Use mode "semantic" for meaning/topic questions; use mode "keyword" for exact names, addresses or Zimbra query syntax (e.g. from:x@y.rw subject:report).',
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
          const res: any = await mail.searchMessages(ctx.userId, args.query, args.limit, 0);
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
