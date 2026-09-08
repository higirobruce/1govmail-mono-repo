import { z } from 'zod';
import { mdToDocJson } from '@email-client/shared';
import type { MailService } from '../../mail/mail.service';
import type { DocsService } from '../../docs/docs.service';
import type { TasksService } from '../../tasks/tasks.service';
import type { ToolDef } from '../tool-registry';

export function buildWriteTools(mail: MailService, docs: DocsService, tasks: TasksService): ToolDef[] {
  return [
    {
      name: 'draft_email',
      description:
        'Create an email draft in the user\'s Drafts folder. Nothing is sent. Use this when the user asks you to write or prepare an email they will review. Write the body as markdown (short paragraphs, lists where they help). Do NOT add a signature block or contact details at the end — the user\'s signature is appended automatically.',
      mode: 'write-auto',
      resultBudget: 500,
      schema: z.object({
        to: z.array(z.string().email()).min(1).max(20),
        cc: z.array(z.string().email()).max(20).optional(),
        subject: z.string().min(1).max(300),
        body: z.string().min(1).max(20000),
      }),
      async execute(args: any, ctx) {
        const { zimbraId } = await mail.saveDraft(ctx.userId, {
          to: args.to,
          cc: args.cc,
          subject: args.subject,
          body: args.body,
          bodyFormat: 'markdown',
        });
        return {
          summary: `Draft "${args.subject}" saved to Drafts`,
          content: `Draft saved (id ${zimbraId}). The user can open it from the source chip or their Drafts folder to review, edit and send it.`,
          refs: [{
            alias: ctx.aliasFor('mail', zimbraId), type: 'mail', id: zimbraId, title: args.subject,
            date: new Date().toISOString(), snippet: '', injectionSuspected: false,
          }],
        };
      },
    },
    {
      name: 'create_document',
      description:
        'Create a new private document owned by the user. Write the content as markdown (headings, lists, bold/italic are supported).',
      mode: 'write-auto',
      resultBudget: 500,
      schema: z.object({
        title: z.string().min(1).max(200),
        markdown: z.string().min(1).max(40000),
        tags: z.array(z.string().max(40)).max(5).optional(),
      }),
      async execute(args: any, ctx) {
        const doc: any = await docs.create(ctx.userId, {
          title: args.title,
          content: mdToDocJson(args.markdown),
          tags: args.tags,
        } as any);
        return {
          summary: `Document "${args.title}" created`,
          content: `Document created with id ${doc.id}. It is private to the user; they can open it in Docs.`,
          refs: [{
            alias: ctx.aliasFor('doc', String(doc.id)), type: 'doc', id: String(doc.id), title: args.title,
            date: new Date().toISOString(), snippet: '', injectionSuspected: false,
          }],
        };
      },
    },
    {
      name: 'create_task',
      description: 'Create a task on the user\'s task board. Private and deletable.',
      mode: 'write-auto',
      resultBudget: 500,
      schema: z.object({
        title: z.string().min(1).max(300),
        description: z.string().max(4000).optional(),
        dueDate: z.string().max(40).optional(),
        linkedMessageId: z.string().max(200).optional(),
      }),
      async execute(args: any, ctx) {
        const task: any = await tasks.create(ctx.userId, {
          title: args.title,
          description: args.description,
          dueDate: args.dueDate,
          linkedMessageId: args.linkedMessageId,
        } as any);
        return {
          summary: `Task "${args.title}" created`,
          content: `Task created with id ${task.id}.`,
        };
      },
    },
  ];
}

export function buildGatedTools(): ToolDef[] {
  const neverExecute = async (): Promise<never> => {
    throw new Error('gated tools are never executed server-side');
  };
  return [
    {
      name: 'send_email',
      description:
        'Propose sending an email. This does NOT send anything — it shows the user an approval card; the email is sent only if they approve. Provide the complete, final email.',
      mode: 'write-gated',
      resultBudget: 0,
      schema: z.object({
        to: z.array(z.string().email()).min(1).max(20),
        cc: z.array(z.string().email()).max(20).optional(),
        subject: z.string().min(1).max(300),
        body: z.string().min(1).max(20000),
        replyToId: z.string().max(200).optional(),
      }),
      execute: neverExecute,
    },
    {
      name: 'create_calendar_event',
      description:
        'Propose a calendar event. This does NOT create anything — it shows the user an approval card; the event is created only if they approve. Check get_freebusy first when attendees are involved.',
      mode: 'write-gated',
      resultBudget: 0,
      schema: z.object({
        title: z.string().min(1).max(300),
        startAt: z.string().min(4),
        endAt: z.string().min(4),
        attendees: z.array(z.string().email()).max(30).optional(),
        location: z.string().max(300).optional(),
        description: z.string().max(4000).optional(),
      }),
      execute: neverExecute,
    },
  ];
}

export function buildChartTool(): ToolDef {
  return {
    name: 'create_chart',
    description:
      'Render a chart in your answer from numbers you already gathered with other tools. Keep it small: ≤30 points, ≤3 series. For pie charts only the first series is used. The chart renders automatically in the panel — never invent image links or markdown image URLs for it.',
    mode: 'read',
    resultBudget: 300,
    schema: z.object({
      type: z.enum(['bar', 'line', 'pie']),
      title: z.string().min(1).max(120),
      labels: z.array(z.string().max(40)).min(1).max(30),
      series: z
        .array(z.object({ name: z.string().max(40), data: z.array(z.number()).min(1).max(30) }))
        .min(1)
        .max(3),
    }),
    async execute(args: any, ctx) {
      ctx.emitChart(args);
      return {
        summary: `Chart "${args.title}" rendered`,
        content: 'Chart rendered in the answer. Refer to it briefly; do not repeat all the numbers.',
      };
    },
  };
}
