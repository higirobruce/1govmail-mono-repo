import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import ThreadMessage, { type ThreadMessageMeta } from './ThreadMessage';
import { TooltipProvider } from '@/components/ui/tooltip';
import { clearBodyCache } from '@/lib/mailBodyCache';
import { api } from '@/lib/api';

// A forwarded message's payload lives exactly where a reply's quoted history
// lives — after Zimbra's `<hr id="zwchr">`. Hiding it is right for a reply and
// destroys the message for a forward. Observed live on .154: the reader saw the
// sender's signature and nothing else, with no control to reveal the rest,
// while Zimbra showed the same mail in full behind its "..." expander.

vi.mock('@/lib/api', () => ({
  api: {
    mail: {
      getMessage: vi.fn(),
      markRead: vi.fn().mockResolvedValue({}),
      downloadAttachment: vi.fn(),
    },
  },
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: any) => sel({ user: { email: 'bruce.higiro@risa.gov.rw' } }),
}));

const FORWARD_SUBJECT = 'Fwd: Follow-Up on regulatory and mobile- Network Readiness';

const meta: ThreadMessageMeta = {
  id: 'm1',
  zimbraId: 'z1',
  snippet: 'Antoine Sebera Chief Executive Officer',
  fromEmail: 'antoine.sebera@risa.gov.rw',
  fromName: 'Antoine',
  toRecipients: [],
  ccRecipients: [],
  isRead: true,
  isStarred: false,
  isDraft: false,
  hasAttachments: false,
  attachments: [],
  receivedAt: new Date().toISOString(),
} as unknown as ThreadMessageMeta;

/** Zimbra's own forward shape: signature, its `zwchr` rule, then the payload. */
const ZIMBRA_FORWARD_HTML = `
<div>
  <div><b>Antoine Sebera</b><br>Chief Executive Officer<br>Rwanda Information Society Authority (RISA)</div>
  <hr id="zwchr">
  <div>
    <b>From:</b> Minister's Office &lt;minister.office@minict.gov.rw&gt;<br>
    <b>To:</b> antoine sebera &lt;antoine.sebera@risa.gov.rw&gt;<br>
    <b>Date:</b> Thursday, 3 September 2026 1:26 PM CAT<br>
    <b>Subject:</b> Follow-Up on regulatory and mobile- Network Readiness
  </div>
  <div id="payload">
    <p>Dear Chief Executive Officer,</p>
    <p>Following Cabinet approval of the national roadmap for the managed retirement of
    legacy 2G and 3G mobile networks, 3G services will be switched off nationwide on
    30 June 2027.</p>
  </div>
</div>`;

/** A genuine reply: the quoted part really is history and may stay collapsed. */
const ZIMBRA_REPLY_HTML = `
<div>
  <div>Thanks — noted, I will circulate this to the team today and revert by Friday.</div>
  <hr id="zwchr">
  <div><b>From:</b> Minister's Office &lt;minister.office@minict.gov.rw&gt;<br><b>Subject:</b> Follow-Up</div>
  <div><p>Dear Chief Executive Officer, Following Cabinet approval ...</p></div>
</div>`;

function row() {
  const noop = () => {};
  return (
    <TooltipProvider>
      <ThreadMessage
        message={meta}
        isExpanded
        onToggle={noop}
        onReply={noop}
        onReplyAll={noop}
        onForward={noop}
        onDelete={noop}
        onToggleStar={noop}
      />
    </TooltipProvider>
  );
}

/** The component reads the subject off the fetched message, not off the row. */
function serve(subject: string, bodyHtml: string) {
  vi.mocked(api.mail.getMessage).mockResolvedValue(
    { id: 'm1', subject, bodyHtml, bodyText: null } as never,
  );
}

describe('ThreadMessage — forwarded content must stay reachable', () => {
  beforeEach(() => {
    clearBodyCache();
    vi.mocked(api.mail.getMessage).mockReset();
  });
  afterEach(() => cleanup());

  // The reported bug. A multi-message thread took a render path that set
  // `quoted` to null, so not even the existing toggle appeared and the
  // forwarded block could not be reached at all.
  it('offers a control to reveal the quoted block in a MULTI-message thread', async () => {
    serve(FORWARD_SUBJECT, ZIMBRA_FORWARD_HTML);

    render(row());

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /quoted message/i })).toBeInTheDocument(),
    );
  });

  // Zimbra shows a forward's payload immediately; only the "..." is collapsed.
  // A Fwd: subject says the enclosed mail is the point, so it opens expanded.
  it('expands the forwarded payload by default when little else remains', async () => {
    serve(FORWARD_SUBJECT, ZIMBRA_FORWARD_HTML);

    render(row());

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /hide quoted message/i })).toBeInTheDocument(),
    );
  });

  // The counterpart: a real reply keeps its history collapsed. Without this,
  // "fixing" forwards would un-collapse every reply in every thread and undo
  // the feature on purpose. Note the reply is SHORT — "Thanks, noted" is an
  // ordinary mail, so brevity must not be read as "this must be a forward".
  it('leaves a genuine reply collapsed, however short the reply is', async () => {
    serve('Re: Follow-Up on regulatory and mobile- Network Readiness', ZIMBRA_REPLY_HTML);

    render(row());

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /show quoted message/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /hide quoted message/i })).not.toBeInTheDocument();
  });

  // A forward whose subject was renamed still has no body of its own. Collapsing
  // that leaves the reader staring at an empty card — the reported symptom.
  it('expands when the body would otherwise render completely empty', async () => {
    serve(
      'Quarterly circulation',
      `<div><hr id="zwchr"><div id="payload"><p>The entire message lives here.</p></div></div>`,
    );

    render(row());

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /hide quoted message/i })).toBeInTheDocument(),
    );
  });
});
