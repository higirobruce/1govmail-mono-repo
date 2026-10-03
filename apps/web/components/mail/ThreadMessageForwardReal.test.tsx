import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import ThreadMessage, { type ThreadMessageMeta } from './ThreadMessage';
import { TooltipProvider } from '@/components/ui/tooltip';
import { clearBodyCache } from '@/lib/mailBodyCache';
import { api } from '@/lib/api';

// Reproduction built from the ACTUAL body of the reported message, read out of
// the messages table on .154 — not an invented shape. Two things about it
// surprised the first fix: there is no `zwchr` at all, and the forward header
// values are bare text nodes sitting between <b> labels inside a <blockquote>.

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

const meta = {
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

/** Verbatim shape from the live row: signature, then the whole forward inside a
 *  <blockquote> whose header lines are `<b>Label: </b>value<br />`. */
const REAL_FORWARD_HTML = `<html><body><div><br /></div><div id="signature-content-e96f7a69"><div><div style="font-size:12pt;font-family:'arial';color:#000000"> <div><strong>Antoine Sebera</strong><br />Chief Executive Officer<br />Rwanda Information Society Authority (RISA)<br />Web: <a href="https://www.risa.gov.rw/" target="_blank">https://www.risa.gov.rw/</a> </div> </div></div></div> <div><br /></div><div>
<style>/*<![CDATA[*/blockquote { margin: 10.0px 0 10.0px 10.0px; padding: 0 0 0 10.0px; border-left: 3.0px solid rgb(187,187,187); }/*]]>*/</style><div id="OLK_SRC_BODY_SECTION"><div id="OLK_SRC_BODY_SECTION"><blockquote style="margin:0 0 0 0.8em;border-left:1px #ccc solid;padding-left:1em"><hr id="MESSAGE_DATA_MARKER" /><b>From: </b>Minister&#39;s Office &lt;minister.office&#64;minict.gov.rw&gt;<br /><b>To: </b>antoine sebera &lt;antoine.sebera&#64;risa.gov.rw&gt;<br /><b>Cc: </b>paul buramye &lt;paul.buramye&#64;risa.gov.rw&gt;; solange.kalema &lt;solange.kalema&#64;risa.gov.rw&gt;<br /><b>Date: </b>Thursday, 3 September 2026 1:26 PM CAT<br /><b>Subject: </b>Follow-Up on regulatory and mobile- Network Readiness for the national 2G/3G sunset<br /><br /><div style="font-size:12pt;font-family:'times new roman';color:#000000">
<div><p style="margin:12pt 0in">Dear Chief Executive Officer,</p><p>Following Cabinet approval of the national roadmap, 3G services will be switched off nationwide on 30 June 2027.</p></div>
</div></blockquote></div></div></div></body></html>`;

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

/** srcDoc of the quoted iframe, which is where the forwarded mail must land. */
async function quotedSrcDoc(): Promise<string> {
  const frame = await waitFor(() => {
    const el = document.querySelector<HTMLIFrameElement>('iframe[title="Quoted message"]');
    if (!el) throw new Error('quoted iframe not rendered');
    return el;
  });
  return frame.getAttribute('srcdoc') ?? '';
}

describe('ThreadMessage — real Zimbra forward from .154', () => {
  beforeEach(() => {
    clearBodyCache();
    vi.mocked(api.mail.getMessage).mockReset();
    vi.mocked(api.mail.getMessage).mockResolvedValue({
      id: 'm1',
      subject: 'Fwd: Follow-Up on regulatory and mobile- Network Readiness for the national 2G/3G sunset',
      bodyHtml: REAL_FORWARD_HTML,
      bodyText: null,
    } as never);
  });
  afterEach(() => cleanup());

  it('opens the forward expanded', async () => {
    render(row());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /hide quoted message/i })).toBeInTheDocument(),
    );
  });

  // The reported follow-up: labels rendered, values did not.
  it('keeps the From / To / Cc / Date / Subject VALUES, not just the labels', async () => {
    render(row());
    const doc = await quotedSrcDoc();

    // Labels alone are not evidence — the complaint was that these showed up
    // with nothing after them.
    expect(doc).toContain('From:');
    expect(doc).toContain('minister.office');
    expect(doc).toContain('antoine.sebera');
    expect(doc).toContain('paul.buramye');
    expect(doc).toContain('Thursday, 3 September 2026');
    expect(doc).toContain('2G/3G sunset');
  });

  it('keeps the forwarded body itself', async () => {
    render(row());
    const doc = await quotedSrcDoc();
    expect(doc).toContain('Dear Chief Executive Officer');
    expect(doc).toContain('30 June 2027');
  });
});
