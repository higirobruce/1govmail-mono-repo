import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import ThreadMessage, { type ThreadMessageMeta } from './ThreadMessage';
import { TooltipProvider } from '@/components/ui/tooltip';
import { clearBodyCache } from '@/lib/mailBodyCache';
import { api } from '@/lib/api';

// Collapse → expand → collapse mid-fetch used to strand loadingBody=true
// forever: the effect cleanup set cancelled=true, the finally skipped
// setLoadingBody(false), and the `|| loadingBody` guard then blocked every
// future fetch — an eternal spinner on re-open (observed live on test1).

vi.mock('@/lib/api', () => ({
  api: {
    mail: {
      getMessage: vi.fn(),
      markRead: vi.fn().mockResolvedValue({}),
      downloadAttachment: vi.fn(),
    },
  },
}));

const meta: ThreadMessageMeta = {
  id: 'm1',
  zimbraId: 'z1',
  subject: 'Subject',
  snippet: 'snippet',
  fromEmail: 'a@x.rw',
  fromName: 'Ann',
  toRecipients: [],
  ccRecipients: [],
  isRead: true,
  isStarred: false,
  isDraft: false,
  hasAttachments: false,
  attachments: [],
  receivedAt: new Date().toISOString(),
} as unknown as ThreadMessageMeta;

function row(isExpanded: boolean) {
  const noop = () => {};
  return (
    <TooltipProvider>
      <ThreadMessage
        message={meta}
        isExpanded={isExpanded}
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

describe('ThreadMessage body loading', () => {
  beforeEach(() => {
    clearBodyCache();
    vi.mocked(api.mail.getMessage).mockReset();
  });
  afterEach(() => cleanup());

  it('recovers and shows the body after a collapse interrupted the in-flight fetch', async () => {
    let resolveFirst!: (v: unknown) => void;
    vi.mocked(api.mail.getMessage).mockReturnValueOnce(
      new Promise((r) => (resolveFirst = r)),
    );

    const view = render(row(true)); // expand → fetch starts (pending)

    // Reader closes mid-flight: row stays mounted, collapses.
    view.rerender(row(false));

    // The interrupted fetch eventually lands.
    await act(async () => {
      resolveFirst({ id: 'm1', bodyHtml: null, bodyText: 'hello body' });
    });

    // Re-open: the body must appear — either from the landed fetch or a retry.
    vi.mocked(api.mail.getMessage).mockResolvedValue({
      id: 'm1', bodyHtml: null, bodyText: 'hello body',
    } as never);
    view.rerender(row(true));

    await waitFor(() => expect(screen.getByText('hello body')).toBeInTheDocument());
  });
});
