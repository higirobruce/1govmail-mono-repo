import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MailRow } from './MailList';

// In Sent, Drafts and Outbox the sender column is dead weight — it is always
// the user. Zimbra shows the addressee there instead, which is the only way to
// scan your own sent mail. 1Gov showed "me" on every row.
const base = {
  id: 'm1',
  subject: 'Budget review Q3',
  snippet: 'Please find attached…',
  fromName: 'Bruce Higiro',
  fromEmail: 'bruce.higiro@risa.gov.rw',
  isRead: true,
  isStarred: false,
  hasAttachments: false,
  tags: [],
  receivedAt: new Date().toISOString(),
  toRecipients: [
    { email: 'alice@minaffet.gov.rw', name: 'Alice Umutoni' },
    { email: 'dg@risa.gov.rw', name: 'DG Office' },
  ],
  ccRecipients: [],
};

function renderRow(over: Record<string, unknown> = {}, showRecipients = false) {
  return render(
    <MailRow
      message={{ ...base, ...over } as any}
      active={false}
      onClick={() => {}}
      onContextMenu={() => {}}
      showRecipients={showRecipients}
    />,
  );
}

describe('MailRow recipient column in sent-like folders', () => {
  afterEach(() => cleanup());

  it('shows the addressee instead of the sender when showRecipients is set', () => {
    renderRow({}, true);

    expect(screen.getByText(/Alice Umutoni/)).toBeInTheDocument();
    expect(screen.queryByText('Bruce Higiro')).not.toBeInTheDocument();
  });

  it('counts the remaining addressees rather than listing them all', () => {
    renderRow({}, true);

    expect(screen.getByText(/\+1/)).toBeInTheDocument();
  });

  it('keeps showing the sender in ordinary folders', () => {
    renderRow({}, false);

    expect(screen.getByText('Bruce Higiro')).toBeInTheDocument();
    expect(screen.queryByText(/Alice Umutoni/)).not.toBeInTheDocument();
  });

  it('falls back to the recipient address when it has no display name', () => {
    renderRow({ toRecipients: [{ email: 'alice@minaffet.gov.rw', name: null }] }, true);

    expect(screen.getByText(/alice@minaffet\.gov\.rw/)).toBeInTheDocument();
  });

  it('falls back to CC when a message has no To at all', () => {
    // Legitimate shape: an undisclosed-recipients circular where everyone is
    // on CC. Showing nothing would make the row unidentifiable.
    renderRow(
      { toRecipients: [], ccRecipients: [{ email: 'all@risa.gov.rw', name: 'All Staff' }] },
      true,
    );

    expect(screen.getByText(/All Staff/)).toBeInTheDocument();
  });

  it('labels a CC fallback as CC, not as To', () => {
    // Calling a CC-only circular "To:" misstates the one thing this column
    // exists to convey.
    renderRow(
      { toRecipients: [], ccRecipients: [{ email: 'all@risa.gov.rw', name: 'All Staff' }] },
      true,
    );

    expect(screen.getByText('Cc:')).toBeInTheDocument();
    expect(screen.queryByText('To:')).not.toBeInTheDocument();
  });

  it('degrades to the sender when no recipients were synced', () => {
    // A row synced before recipients were persisted must not render a blank
    // name column — it shows what it does know.
    renderRow({ toRecipients: [], ccRecipients: [] }, true);

    expect(screen.getByText('Bruce Higiro')).toBeInTheDocument();
  });
});
