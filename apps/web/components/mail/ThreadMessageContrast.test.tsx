import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import ThreadMessage, { type ThreadMessageMeta } from './ThreadMessage';
import { TooltipProvider } from '@/components/ui/tooltip';
import { clearBodyCache } from '@/lib/mailBodyCache';
import { api } from '@/lib/api';

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
  useAuthStore: (sel: any) => sel({ user: { email: 'me@risa.gov.rw' } }),
}));

let mockIsDark = true;
vi.mock('@/hooks/useIsDark', () => ({ useIsDark: () => mockIsDark }));

const meta = {
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

// A sender who hardcodes dark text and no background — the shape most
// government mail arrives in, authored against Outlook's white page.
const DARK_ON_NOTHING = '<p id="body-text" style="color: rgb(51,51,51)">Ministerial directive</p>';

function renderExpanded() {
  const noop = () => {};
  return render(
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
        isOnlyMessage
      />
    </TooltipProvider>,
  );
}

/** The iframe is rendered via srcDoc, which jsdom does not parse. Write the
 *  body in directly and fire load, which is what the browser does for us. */
async function loadFrameWith(container: HTMLElement, bodyHtml: string) {
  const frame = await waitFor(() => {
    const f = container.querySelector('iframe');
    if (!f) throw new Error('no iframe yet');
    return f as HTMLIFrameElement;
  });
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(
    `<html><body style="background-color: rgb(8,14,21); color: rgb(235,239,242)">${bodyHtml}</body></html>`,
  );
  doc.close();
  frame.dispatchEvent(new Event('load'));
  return doc;
}

describe('ThreadMessage dark-mode contrast repair', () => {
  beforeEach(() => {
    clearBodyCache();
    vi.mocked(api.mail.getMessage).mockResolvedValue({
      id: 'm1', bodyHtml: DARK_ON_NOTHING, bodyText: null,
    } as never);
    localStorage.clear();
  });
  afterEach(() => cleanup());

  it('rescues dark-on-dark text when consistent display is off', async () => {
    localStorage.setItem('1gov_normalize_email_styles', 'false');
    mockIsDark = true;
    const { container } = renderExpanded();

    const doc = await loadFrameWith(container, DARK_ON_NOTHING);

    await waitFor(() => {
      const el = doc.getElementById('body-text')!;
      // Rewritten to the frame's light ink, not left at the sender's #333.
      expect(el.style.color).toBe('rgb(235, 239, 242)');
    });
  });

  it('leaves the body alone when consistent display is on', async () => {
    // normalizeCss already forces its own palette with !important — repairing
    // on top of it would fight a stylesheet that has already won.
    localStorage.setItem('1gov_normalize_email_styles', 'true');
    mockIsDark = true;
    const { container } = renderExpanded();

    const doc = await loadFrameWith(container, DARK_ON_NOTHING);

    expect(doc.getElementById('body-text')!.style.color).toBe('rgb(51, 51, 51)');
  });

  it('leaves the body alone in light mode', async () => {
    localStorage.setItem('1gov_normalize_email_styles', 'false');
    mockIsDark = false;
    const { container } = renderExpanded();

    const doc = await loadFrameWith(container, DARK_ON_NOTHING);

    // #333 on a white canvas is perfectly legible — nothing to fix.
    expect(doc.getElementById('body-text')!.style.color).toBe('rgb(51, 51, 51)');
  });
});
