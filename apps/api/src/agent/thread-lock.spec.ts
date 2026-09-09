import { THREAD_LOCK_TOOLS, assertIdInThread } from './thread-lock';
import { ToolValidationError } from './tool-registry';

describe('THREAD_LOCK_TOOLS', () => {
  it('is exactly the five thread-local tools', () => {
    expect([...THREAD_LOCK_TOOLS].sort()).toEqual(
      ['ask_user', 'draft_email', 'get_thread', 'read_attachment', 'read_email'],
    );
  });

  it('withholds every mailbox-wide search and every gated write', () => {
    for (const name of [
      'search_emails', 'search_attachments', 'search_documents', 'read_document',
      'compare_documents', 'get_mail_stats', 'get_person', 'search_contacts',
      'list_tasks', 'list_events', 'get_freebusy', 'send_email',
      'create_calendar_event', 'create_document', 'create_task', 'create_chart',
    ]) {
      expect(THREAD_LOCK_TOOLS.has(name)).toBe(false);
    }
  });
});

describe('assertIdInThread', () => {
  const ids = ['m1', 'm2'];

  it('allows an in-thread messageId', () => {
    expect(() => assertIdInThread('read_email', { messageId: 'm1' }, ids)).not.toThrow();
    // read_attachment's schema is { messageId, part } — verified at
    // apps/api/src/agent/tools/attachment.tools.ts:15. NOT `partId`.
    expect(() => assertIdInThread('read_attachment', { messageId: 'm2', part: '2' }, ids)).not.toThrow();
  });

  it('rejects an out-of-thread messageId with a recoverable message', () => {
    expect(() => assertIdInThread('read_email', { messageId: 'other' }, ids))
      .toThrow(ToolValidationError);
    try {
      assertIdInThread('read_email', { messageId: 'other' }, ids);
    } catch (e: any) {
      expect(e.message).toMatch(/not part of this thread/i);
    }
  });

  it('does not constrain tools that are not id-addressed', () => {
    expect(() => assertIdInThread('get_thread', { messageId: 'other' }, ids)).not.toThrow();
    expect(() => assertIdInThread('ask_user', { question: 'x', options: [] }, ids)).not.toThrow();
  });

  it('rejects an id-addressed read when the thread has no ids to check against', () => {
    expect(() => assertIdInThread('read_email', { messageId: 'm1' }, []))
      .toThrow(ToolValidationError);
  });
});
