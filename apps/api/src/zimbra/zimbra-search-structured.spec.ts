import { buildZimbraQuery } from './zimbra.service';

describe('buildZimbraQuery', () => {
  it('translates a full filter to a Zimbra query with inclusive dates and escaping', () => {
    const q = buildZimbraQuery({
      keyword: 'budget',
      from: 'alice',
      subject: 'Q3',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
      hasAttachment: true,
      folderId: '2',
      unread: true,
      flagged: false,
    });
    expect(q).toContain('content:"budget"');
    expect(q).toContain('from:"alice"');
    expect(q).toContain('subject:"Q3"');
    expect(q).toContain('after:8/31/2026'); // dateFrom −1 day (exclusive after:)
    expect(q).toContain('before:10/1/2026'); // dateTo +1 day (exclusive before:)
    expect(q).toContain('has:attachment');
    expect(q).toContain('inid:2');
    expect(q).toContain('is:unread');
    expect(q).toContain('is:unflagged');
  });
});
