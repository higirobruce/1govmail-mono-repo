import { buildPeopleTools } from './people.tools';
import type { ToolContext } from '../tool-registry';

function makeCtx(): ToolContext {
  let n = 0;
  return { userId: 'u1', userEmail: 'u1@x.rw', aliasFor: () => `s${++n}`, emitChart: jest.fn() };
}

const people = {
  dossier: jest.fn().mockResolvedValue({
    profile: { email: 'a@b.rw', name: 'Alice', firstSeenAt: null, lastSeenAt: null, received90d: 4, sent90d: 2 },
    recentConversations: [{ messageId: 'm1', conversationId: null, subject: 'Hello', snippet: 'hi', direction: 'in', at: '2026-09-01T00:00:00Z' }],
    commitments: [], sharedEvents: [], sharedDocs: [],
  }),
} as any;
const contacts = { autocomplete: jest.fn().mockResolvedValue([{ email: 'a@b.rw', display: 'Alice' }]) } as any;
const tasks = { findAll: jest.fn().mockResolvedValue([{ id: 't1', title: 'Report', status: 'TODO', dueDate: new Date('2026-09-10T00:00:00Z') }]) } as any;

const tools = buildPeopleTools(people, contacts, tasks);
const byName = (n: string) => tools.find((t) => t.name === n)!;

describe('people/contacts/tasks tools', () => {
  it('get_person returns a compact dossier and mail refs', async () => {
    const res = await byName('get_person').execute({ email: 'a@b.rw' }, makeCtx());
    expect(people.dossier).toHaveBeenCalledWith('u1', 'a@b.rw');
    expect(res.content).toContain('Alice');
    expect(res.refs![0]).toMatchObject({ type: 'mail', id: 'm1' });
  });

  it('search_contacts wraps autocomplete', async () => {
    const res = await byName('search_contacts').execute({ query: 'ali' }, makeCtx());
    expect(contacts.autocomplete).toHaveBeenCalledWith('u1', 'ali');
    expect(res.content).toContain('a@b.rw');
  });

  it('list_tasks passes the status filter through', async () => {
    const res = await byName('list_tasks').execute({ status: 'TODO' }, makeCtx());
    expect(tasks.findAll).toHaveBeenCalledWith('u1', 'TODO');
    expect(res.content).toContain('Report');
    expect(res.content).toContain('2026-09-10T00:00:00.000Z');
  });
});
