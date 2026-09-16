import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThreadMessage, { type ThreadMessageMeta } from './ThreadMessage';
import { TooltipProvider } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { clearBodyCache } from '@/lib/mailBodyCache';

vi.mock('@/lib/api', () => ({
  api: {
    mail: {
      getMessage: vi.fn().mockResolvedValue({ id: 'm1', bodyHtml: null, bodyText: 'body' }),
      markRead: vi.fn().mockResolvedValue({}),
      downloadAttachment: vi.fn(),
    },
  },
}));

vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: any) => sel({ user: { email: 'me@risa.gov.rw' } }),
}));

// A government circular routinely addresses more people than a header line can
// hold. The compact summary truncates (To at 3, Cc at 2) and Bcc was never
// rendered at all, so a reader could not tell whether they were addressed or
// merely copied — the whole point of the disclosure below.
const FIVE_TO = [
  { email: 'me@risa.gov.rw', name: 'Me' },
  { email: 'p.kagame@gov.rw', name: 'P. Kagame' },
  { email: 'a.mutesi@risa.gov.rw', name: 'A. Mutesi' },
  { email: 'd.nkusi@risa.gov.rw', name: 'D. Nkusi' },
  { email: 'j.uwase@risa.gov.rw', name: 'J. Uwase' },
];

const meta = (over: Partial<ThreadMessageMeta> = {}): ThreadMessageMeta => ({
  id: 'm1',
  zimbraId: 'z1',
  subject: 'Subject',
  snippet: 'snippet',
  fromEmail: 'alice@minaffet.gov.rw',
  fromName: 'Alice',
  toRecipients: FIVE_TO,
  ccRecipients: [
    { email: 'dg@risa.gov.rw', name: 'DG' },
    { email: 'ict@risa.gov.rw', name: 'ICT' },
    { email: 'audit@risa.gov.rw', name: 'Audit' },
  ],
  isRead: true,
  isStarred: false,
  isDraft: false,
  hasAttachments: false,
  attachments: [],
  receivedAt: new Date('2026-09-16T09:41:00Z').toISOString(),
  ...over,
} as unknown as ThreadMessageMeta);

function renderMessage(over: Partial<ThreadMessageMeta> = {}) {
  const noop = () => {};
  return render(
    <TooltipProvider>
      <ThreadMessage
        message={meta(over)}
        isExpanded
        onToggle={noop}
        onReply={noop}
        onReplyAll={noop}
        onForward={noop}
        onDelete={noop}
        onToggleStar={noop}
      />
    </TooltipProvider>,
  );
}

const openDetails = async () => {
  const toggle = screen.getByRole('button', { name: /recipient details/i });
  await userEvent.click(toggle);
  return screen.getByTestId('recipient-details');
};

// Thread metadata can carry an empty To while the full fetch has the real one:
// before the API fix, getMessage refreshed cc/bcc on a cached row but never
// toRecipients, so rows healed their CC long ago and kept an empty To. Reading
// recipients off the metadata instead of the fetched message meant the panel
// showed CC and silently omitted To — observed live on .154.
describe('ThreadMessage recipient details prefer the fetched message', () => {
  // The body cache is module-level and would serve a previous test's body,
  // skipping the getMessage call these assertions depend on.
  beforeEach(() => clearBodyCache());
  afterEach(() => cleanup());

  it('shows the To list from the full fetch when the thread metadata has none', async () => {
    vi.mocked(api.mail.getMessage).mockResolvedValue({
      id: 'm1',
      bodyHtml: null,
      bodyText: 'body',
      toRecipients: [{ email: 'fred@risa.gov.rw', name: 'Fred' }],
      ccRecipients: [{ email: 'idc@aos.rw', name: 'idc' }],
    } as never);

    renderMessage({ toRecipients: [], ccRecipients: [{ email: 'idc@aos.rw', name: 'idc' }] });

    await waitFor(() => expect(screen.getByText('body')).toBeInTheDocument());
    const details = await openDetails();

    expect(within(details).getByText(/fred@risa\.gov\.rw/)).toBeInTheDocument();
  });

  it('shows a To summary from the full fetch too, not just inside the panel', async () => {
    vi.mocked(api.mail.getMessage).mockResolvedValue({
      id: 'm1',
      bodyHtml: null,
      bodyText: 'body',
      toRecipients: [{ email: 'fred@risa.gov.rw', name: 'Fred' }],
      ccRecipients: [],
    } as never);

    renderMessage({ toRecipients: [], ccRecipients: [] });

    await waitFor(() => expect(screen.getByText('body')).toBeInTheDocument());

    // The collapsed-summary line above the disclosure must agree with it.
    expect(screen.getByText(/^To:/)).toBeInTheDocument();
  });
});

describe('ThreadMessage recipient details', () => {
  // mockResolvedValue persists across tests, so the override in the describe
  // above would leak its recipients in here and mask what these assert.
  beforeEach(() => {
    clearBodyCache();
    vi.mocked(api.mail.getMessage).mockResolvedValue({
      id: 'm1', bodyHtml: null, bodyText: 'body',
    } as never);
  });
  afterEach(() => cleanup());

  it('keeps the full address list closed until asked', () => {
    renderMessage();

    expect(screen.queryByTestId('recipient-details')).not.toBeInTheDocument();
  });

  it('lists every To address once opened, past the summary cut-off', async () => {
    renderMessage();

    const details = await openDetails();

    // The 4th and 5th recipients are the ones the "+2" summary hid.
    expect(within(details).getByText(/d\.nkusi@risa\.gov\.rw/)).toBeInTheDocument();
    expect(within(details).getByText(/j\.uwase@risa\.gov\.rw/)).toBeInTheDocument();
  });

  it('lists every CC address once opened', async () => {
    renderMessage();

    const details = await openDetails();

    expect(within(details).getByText(/audit@risa\.gov\.rw/)).toBeInTheDocument();
  });

  it('shows a BCC row only when the message carries one', async () => {
    renderMessage({ bccRecipients: [{ email: 'secret@risa.gov.rw', name: null }] });

    const details = await openDetails();

    expect(within(details).getByText(/^BCC:/)).toBeInTheDocument();
    expect(within(details).getByText(/secret@risa\.gov\.rw/)).toBeInTheDocument();
  });

  it('omits the BCC row on a received message that has none', async () => {
    renderMessage();

    const details = await openDetails();

    expect(within(details).queryByText(/^BCC:/)).not.toBeInTheDocument();
  });

  it('shows a Reply-to row only when it differs from the sender', async () => {
    renderMessage({ replyTo: 'comms@minaffet.gov.rw' });

    const details = await openDetails();

    expect(within(details).getByText(/comms@minaffet\.gov\.rw/)).toBeInTheDocument();
  });

  it('renders the sender address in the details even with no reply-to', async () => {
    renderMessage();

    const details = await openDetails();

    expect(within(details).getByText(/alice@minaffet\.gov\.rw/)).toBeInTheDocument();
  });

  it('does not collapse the message when the details toggle is clicked', async () => {
    const onToggle = vi.fn();
    render(
      <TooltipProvider>
        <ThreadMessage
          message={meta()}
          isExpanded
          onToggle={onToggle}
          onReply={() => {}}
          onReplyAll={() => {}}
          onForward={() => {}}
          onDelete={() => {}}
          onToggleStar={() => {}}
        />
      </TooltipProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: /recipient details/i }));

    // The header itself is the collapse control — the disclosure sits inside it.
    expect(onToggle).not.toHaveBeenCalled();
  });
});
