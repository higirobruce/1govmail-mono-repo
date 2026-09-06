import { buildMailReadTools, stripHtml } from './mail.tools';
import type { ToolContext } from '../tool-registry';

function makeCtx(): ToolContext {
  let n = 0;
  return { userId: 'u1', userEmail: 'u1@x.rw', nextAlias: () => `s${++n}`, emitChart: jest.fn() };
}

// Mocks mirror the real MailService/RetrievalService return shapes:
// - MailService.searchMessages/getConversation always wrap rows in `{ messages: [...] }`.
// - Rows carry `receivedAt` as a native Date (Prisma DateTime), never `date` and
//   never a string — kept as real Date instances here so a regression to
//   `String(Date)` (locale toString() instead of ISO) is caught.
// - MailService.getMessage returns the cached Prisma Message row: body lives in
//   `bodyHtml`/`bodyText` (never `body`), recipients in `toRecipients: {email,name}[]`
//   (never `to: string[]`), attachments as `{id, filename, mimeType, size}[]`.
// - RetrievalService.semantic returns a bare array of row-shaped objects.
const mail = {
  searchMessages: jest.fn().mockResolvedValue({
    messages: [{ id: 'm1', subject: 'MoU draft', fromEmail: 'a@b.rw', receivedAt: new Date('2026-09-01T00:00:00Z'), snippet: 'the draft' }],
    total: 1,
    offset: 0,
    limit: 5,
    hasMore: false,
  }),
  getMessage: jest.fn().mockResolvedValue({
    id: 'm1', subject: 'MoU draft', fromEmail: 'a@b.rw', toRecipients: [{ email: 'u1@x.rw', name: null }],
    receivedAt: new Date('2026-09-01T00:00:00Z'), bodyHtml: '<p>Hello <b>world</b></p>',
    attachments: [{ id: '2', filename: 'MoU-final.pdf', mimeType: 'application/pdf', size: 12345 }],
  }),
  getConversation: jest.fn().mockResolvedValue({
    conversationId: 'c1',
    messages: [
      { id: 'm1', subject: 'MoU draft', fromEmail: 'a@b.rw', receivedAt: new Date('2026-09-01T00:00:00Z'), snippet: 'first' },
      { id: 'm2', subject: 'Re: MoU draft', fromEmail: 'u1@x.rw', receivedAt: new Date('2026-09-02T00:00:00Z'), snippet: 'second' },
    ],
  }),
} as any;

const retrieval = {
  semantic: jest.fn().mockResolvedValue([
    { id: 'm9', subject: 'Budget', fromEmail: 'c@d.rw', receivedAt: new Date('2026-08-01T00:00:00Z'), snippet: 'numbers' },
  ]),
} as any;

const tools = buildMailReadTools(mail, retrieval);
const byName = (n: string) => tools.find((t) => t.name === n)!;

describe('mail read tools', () => {
  it('registers three read tools', () => {
    expect(tools.map((t) => `${t.name}:${t.mode}`)).toEqual([
      'search_emails:read', 'read_email:read', 'get_thread:read',
    ]);
  });

  it('search_emails semantic mode uses retrieval and returns aliased refs', async () => {
    const res = await byName('search_emails').execute({ query: 'budget', mode: 'semantic', limit: 5 }, makeCtx());
    expect(retrieval.semantic).toHaveBeenCalledWith('u1', 'budget', 5);
    expect(res.refs![0]).toMatchObject({ alias: 's1', type: 'mail', id: 'm9' });
    expect(res.refs![0].date).toBe('2026-08-01T00:00:00.000Z');
    expect(res.content).toContain('[s1]');
  });

  it('search_emails keyword mode uses MailService', async () => {
    const res = await byName('search_emails').execute({ query: 'from:a@b.rw', mode: 'keyword', limit: 5 }, makeCtx());
    expect(mail.searchMessages).toHaveBeenCalledWith('u1', 'from:a@b.rw', 5, 0);
    expect(res.summary).toContain('1');
  });

  it('read_email strips HTML, includes headers and lists attachments', async () => {
    const res = await byName('read_email').execute({ messageId: 'm1' }, makeCtx());
    expect(res.content).toContain('Hello world');
    expect(res.content).not.toContain('<b>');
    expect(res.content).toContain('a@b.rw');
    expect(res.content).toContain('u1@x.rw');
    expect(res.content).toContain('MoU-final.pdf');
    expect(res.content).toContain('part 2');
    expect(res.content).toContain('2026-09-01T00:00:00.000Z');
    expect(res.refs![0].id).toBe('m1');
  });

  it('get_thread lists messages chronologically', async () => {
    const res = await byName('get_thread').execute({ messageId: 'm1' }, makeCtx());
    expect(res.summary).toContain('2');
    expect(res.content.indexOf('first')).toBeLessThan(res.content.indexOf('second'));
  });

  it('stripHtml collapses tags and whitespace', () => {
    expect(stripHtml('<div>a</div><p>b  c</p>')).toBe('a b c');
  });
});
