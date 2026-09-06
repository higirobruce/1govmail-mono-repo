import { z } from 'zod';
import type { PeopleService } from '../../people/people.service';
import type { ContactsService } from '../../contacts/contacts.service';
import type { TasksService } from '../../tasks/tasks.service';
import type { ToolDef, ToolRef } from '../tool-registry';

function renderDate(raw: any): string {
  return raw instanceof Date ? raw.toISOString() : String(raw ?? '');
}

export function buildPeopleTools(
  people: PeopleService,
  contacts: ContactsService,
  tasks: TasksService,
): ToolDef[] {
  return [
    {
      name: 'get_person',
      description:
        'Get the relationship dossier for one person by email: profile, recent conversations, open commitments, shared events and docs.',
      mode: 'read',
      resultBudget: 2000,
      schema: z.object({ email: z.string().email() }),
      async execute(args: any, ctx) {
        const d = await people.dossier(ctx.userId, args.email);
        const refs: ToolRef[] = d.recentConversations.slice(0, 5).map((c) => ({
          alias: ctx.nextAlias(),
          type: 'mail',
          id: c.messageId,
          title: c.subject,
          date: c.at,
          snippet: (c.snippet ?? '').slice(0, 160),
          injectionSuspected: false,
        }));
        const lines = [
          `${d.profile.name ?? args.email} <${d.profile.email}> — received ${d.profile.received90d}, sent ${d.profile.sent90d} (90d)`,
          ...refs.map((r, i) => `[${r.alias}] ${d.recentConversations[i].direction === 'in' ? 'from them' : 'to them'}: "${r.title ?? ''}" ${r.date} — ${r.snippet}`),
          ...d.commitments.map((c) => `commitment (${c.type}): ${c.text}${c.dueHint ? ` (due ${c.dueHint})` : ''}`),
          ...d.sharedEvents.map((e) => `shared event: "${e.title}" ${e.startAt}`),
          ...d.sharedDocs.map((doc) => `shared doc: "${doc.title}" (${doc.direction})`),
        ];
        return { summary: `Dossier for ${d.profile.email}`, content: lines.join('\n'), refs };
      },
    },
    {
      name: 'search_contacts',
      description: 'Look up a person\'s email address by (partial) name or address in the user\'s contacts.',
      mode: 'read',
      resultBudget: 1000,
      schema: z.object({ query: z.string().min(1).max(100) }),
      async execute(args: any, ctx) {
        const rows = await contacts.autocomplete(ctx.userId, args.query);
        return {
          summary: `${rows.length} contact(s)`,
          content: rows.length ? rows.map((r) => `${r.display} <${r.email}>`).join('\n') : 'No matching contacts.',
        };
      },
    },
    {
      name: 'list_tasks',
      description: 'List the user\'s tasks, optionally filtered by status (TODO, IN_PROGRESS, DONE, CANCELLED).',
      mode: 'read',
      resultBudget: 2000,
      schema: z.object({ status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional() }),
      async execute(args: any, ctx) {
        const rows: any[] = await tasks.findAll(ctx.userId, args.status);
        return {
          summary: `${rows.length} task(s)`,
          content: rows.length
            ? rows.map((t) => `- [${t.status}] "${t.title}"${t.dueDate ? ` due ${renderDate(t.dueDate)}` : ''} (id ${t.id})`).join('\n')
            : 'No tasks.',
        };
      },
    },
  ];
}
