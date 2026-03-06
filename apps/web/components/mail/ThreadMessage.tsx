'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { format, parseISO } from 'date-fns';
import {
  ChevronDown,
  ChevronUp,
  Paperclip,
  Reply,
  ReplyAll,
  Forward,
  Star,
  Trash2,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// ─── Email rendering (mirrors MailDetail.tsx constants) ─────────────────────

const EMAIL_CSS = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:16px;background:#ffffff;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:14px;line-height:1.6;overflow-x:hidden;word-wrap:break-word}
a{color:#2563eb;text-decoration:underline}
a:hover{color:#1d4ed8}
img{max-width:100%;height:auto;display:inline-block}
img[width="1"],img[height="1"],img[width="0"],img[height="0"]{display:none}
table{border-collapse:collapse;max-width:100%}
td,th{padding:4px 8px;vertical-align:top}
pre,code{font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:13px;white-space:pre-wrap;word-break:break-all}
blockquote{border-left:3px solid #d1d5db;margin:12px 0;padding:4px 12px;color:#6b7280}
.gmail_quote,.gmail_extra{border-left:2px solid #d1d5db;margin:12px 0;padding:4px 12px;color:#6b7280;font-size:13px}
.yahoo_quoted,.moz-cite-prefix{color:#9ca3af;font-size:13px}
.MsoNormal{margin:0}
div[style*="border-left"]{color:#6b7280}
hr{border:none;border-top:1px solid #e5e7eb;margin:16px 0}
ul,ol{padding-left:1.5em;margin:8px 0}
li{margin:4px 0}
h1,h2,h3,h4,h5,h6{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;line-height:1.3;margin:16px 0 8px;color:#111827}
p{margin:0 0 12px}
p:last-child{margin-bottom:0}
font{font-family:inherit}`;

const NORMALIZE_CSS = `
*,*::before,*::after{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif!important;color:#111827!important;background-color:transparent!important;font-size:14px!important;line-height:1.65!important;letter-spacing:normal!important;text-transform:none!important;font-weight:normal!important;font-style:normal!important}
html,body{background-color:#ffffff!important;color:#111827!important}
h1{font-size:22px!important;font-weight:700!important;line-height:1.3!important;margin:16px 0 8px!important}
h2{font-size:18px!important;font-weight:600!important;line-height:1.3!important;margin:14px 0 6px!important}
h3{font-size:15px!important;font-weight:600!important;line-height:1.3!important;margin:12px 0 6px!important}
h4,h5,h6{font-size:14px!important;font-weight:600!important;line-height:1.3!important}
strong,b{font-weight:700!important}
em,i{font-style:italic!important}
small{font-size:12px!important}
a,a *{color:#2563eb!important;text-decoration:underline!important}
a:hover,a:hover *{color:#1d4ed8!important}
code,pre,code *,pre *{font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace!important;font-size:13px!important;background-color:#f3f4f6!important}
pre{background-color:#f3f4f6!important;padding:12px!important}
img{background-color:transparent!important}
`;

function extractBodyContent(html: string): string {
  const match = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (match) return match[1];
  return html
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?(html|body)[^>]*>/gi, '')
    .trim();
}

function EmailBodyFrame({ html, text, stripQuotes = true }: { html: string | null; text: string | null; stripQuotes?: boolean }) {
  const normalizeStyles =
    typeof window !== 'undefined'
      ? localStorage.getItem('1gov_normalize_email_styles') !== 'false'
      : true;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  const resizeFrame = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    requestAnimationFrame(() =>
      setHeight(Math.max(doc.documentElement.scrollHeight, 100)),
    );
  }, []);

  const handleLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;

    // ── Strip quoted thread history ─────────────────────────────────────────
    // When the thread has multiple messages, the full history is shown as
    // individual rows so we remove embedded quoted content from each body.
    // When there is only one message (e.g. user was CC'd mid-thread), the
    // quoted content IS the history and must be preserved.
    if (!stripQuotes) { resizeFrame(); return; }

    // Pass 1 — remove elements with known quote class/id
    [
      'blockquote',
      '.gmail_quote', '.gmail_extra', '.gmail_attr',
      '[class*="yahoo_quoted"]', '[id*="yahoo_quoted"]',
      '.moz-cite-prefix',
      '#divRplyFwdMsg', '#divReplyFwdMsg', '#appendonsend',
      '.OutlookMessageHeader', '.x_OutlookMessageHeader',
      '[id^="ms-outlook"]',
      '[class*="BodyFragment"] blockquote',
    ].forEach((sel) => {
      doc.querySelectorAll(sel).forEach((el) => el.remove());
    });

    // Pass 2 — remove a recognised quote-separator and everything after it.
    //
    // Detection priority (most-specific → least-specific to avoid false positives):
    //   1. Zimbra     <hr id="zwchr">
    //   2. Apple Mail <hr class*="Apple-interchange">
    //   3. Outlook    <div style="border-top:solid …"> wrapping From/Sent/To lines
    //   4. <hr> whose next-sibling text starts with "On … wrote:" / "From:" / etc.
    //   5. "On Mon, 1 Jan 2024 at 12:00, Name <email> wrote:" standalone block
    //   6. Outlook "From: Name <email>" block confirmed by sibling "Date:" / "Sent:"
    //   7. Pure separator line "________" or "--------" followed by "From:" / "On…"
    //   8. "---- Original Message ----" / "---- Forwarded Message ----" dividers
    const findQuoteSep = (): Element | null => {
      if (!doc.body) return null;

      // 1. Zimbra
      const byId = doc.body.querySelector<Element>('#zwchr');
      if (byId) return byId;

      // 2. Apple Mail
      const byApple = doc.body.querySelector<Element>('hr[class*="Apple-interchange"]');
      if (byApple) return byApple;

      // 3. Outlook reply wrapper: <div style="…border-top:solid…"> that Outlook inserts
      //    above the quoted message header. Confirmed by "From:" / "Sent:" inside it.
      for (const div of Array.from(doc.body.querySelectorAll<Element>('div[style*="border-top"]'))) {
        if (/From\s*:|Sent\s*:/i.test(div.textContent ?? '')) return div;
      }

      // 4. <hr> whose next sibling looks like an email quote header
      const byHrHeuristic = Array.from(doc.body.querySelectorAll<Element>('hr')).find((hr) => {
        const t = hr.nextElementSibling?.textContent ?? '';
        return /^\s*(On\s.+wrote:|From\s*:|Sent\s*:|De\s*:|Von\s*:|-{3,})/i.test(t);
      });
      if (byHrHeuristic) return byHrHeuristic;

      // 5. "On Mon, 1 Jan 2024 at 12:00, Name <email> wrote:" — Gmail / Apple / Zimbra
      const onWroteRe = /^On\s+\S[\s\S]{5,250}wrote\s*:\s*$/i;
      const byOnWrote = Array.from(doc.body.querySelectorAll<Element>('div, p, span'))
        .find((el) => {
          if (el.children.length > 4) return false;
          const t = (el.textContent ?? '').trim();
          return t.length < 300 && onWroteRe.test(t);
        });
      if (byOnWrote) return byOnWrote;

      // 6. Outlook / calendar "From: Name <email>" or "From: email@domain" block.
      //    Angle brackets are optional (calendar invites omit them).
      //    Confirmed by a sibling or inline field: Date/Sent/When/To/Subject.
      const emailFromRe = /^From\s*:\s*(?:[^<\n]{0,100}<)?[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+/i;
      const byOutlookFrom = Array.from(doc.body.querySelectorAll<Element>('p, div, td'))
        .find((el) => {
          if (el.children.length > 6) return false;
          const t = (el.textContent ?? '').trim();
          // Multi-line single element: contains the whole header block inline
          if (emailFromRe.test(t) && /(Date|Sent|When)\s*:/i.test(t) && /(To|Subject)\s*:/i.test(t)) return true;
          // Single "From:" line — next sibling must be a header field
          if (emailFromRe.test(t) && t.length <= 250) {
            const nextT = el.nextElementSibling?.textContent?.trim() ?? '';
            return /^(Date|Sent|To|When|Subject|À|An)\s*:/i.test(nextT);
          }
          return false;
        });
      if (byOutlookFrom) return byOutlookFrom;

      // 7. Pure separator line ("________", "--------", "========") followed by "From:" or "On…wrote:"
      const pureSepRe = /^[-_=*]{5,}$/;
      const byPureSep = Array.from(doc.body.querySelectorAll<Element>('p, div, span'))
        .find((el) => {
          if ((el.textContent ?? '').trim().match(pureSepRe) === null) return false;
          const nextT = el.nextElementSibling?.textContent?.trim() ?? '';
          return /^From\s*:/i.test(nextT) || /^On\s+\S.{5,}wrote\s*:/i.test(nextT);
        });
      if (byPureSep) return byPureSep;

      // 8. "---- Original Message ----" / "---- Forwarded Message ----" dividers
      const dashMsgRe = /^[-_*\s]{2,}(Original|Forwarded)\s+(Message|mail|e-?mail)[-_*\s]*/i;
      const byDashMsg = Array.from(doc.body.querySelectorAll<Element>('div, p'))
        .find((el) => {
          const t = (el.textContent ?? '').trim();
          return dashMsgRe.test(t) && t.length < 80;
        });
      if (byDashMsg) return byDashMsg;

      // Do NOT fall back to the first <hr> unconditionally — newsletters and
      // formatted emails use <hr> for design/layout.
      return null;
    };

    const sep = findQuoteSep();
    if (sep) {
      // Build the ancestor chain from sep up to (but not including) body.
      // We capture this BEFORE any removals so parentElement references stay valid.
      const ancestors: Element[] = [];
      let node: Element = sep;
      while (node.parentElement && node.parentElement !== doc.body) {
        ancestors.push(node.parentElement);
        node = node.parentElement;
      }

      // Step 1: Remove sep + all its following siblings at its own DOM level.
      //         This preserves content that precedes sep inside the same container.
      let sib: Element | null = sep;
      while (sib) { const nx: Element | null = sib.nextElementSibling; sib.remove(); sib = nx; }

      // Step 2: For every ancestor (inner → outer), remove the ancestor's
      //         following siblings.  Content INSIDE the ancestor (before sep)
      //         is untouched; only sibling containers after the ancestor are cut.
      for (const anc of ancestors) {
        let sib2: Element | null = anc.nextElementSibling;
        while (sib2) { const nx = sib2.nextElementSibling; sib2.remove(); sib2 = nx; }
      }
    }

    resizeFrame();

    doc.querySelectorAll('img').forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load', resizeFrame, { once: true });
        img.addEventListener('error', resizeFrame, { once: true });
      }
    });
  }, [resizeFrame]);

  if (!html) {
    return (
      <pre className="whitespace-pre-wrap font-sans text-[13px] text-foreground/80 leading-relaxed p-4">
        {text ?? 'No content'}
      </pre>
    );
  }

  // Zimbra uses `dfsrc` instead of `src` on images (deferred loading). Convert
  // them to standard `src` so the browser renders them correctly.
  // Also strip the non-standard `name=` parameter from data URIs — e.g.
  // `data:image/gif; name="foo.gif";base64,...` — whose unescaped inner quotes
  // break HTML attribute parsing and cause the image to render as broken.
  const body = extractBodyContent(html)
    .replace(/\bdfsrc=/gi, 'src=')
    .replace(/data:([^;]+);\s*name="[^"]*";/gi, 'data:$1;');
  const css = normalizeStyles ? EMAIL_CSS + NORMALIZE_CSS : EMAIL_CSS;
  // In thread view each message is shown individually, so suppress the quoted
  // history that email clients embed inside every reply/forward body.
  // This covers: standard blockquote, Gmail, Yahoo, Mozilla, Outlook, Zimbra.
  const HIDE_QUOTES_CSS = `
blockquote{display:none!important}
.gmail_quote,.gmail_extra,.gmail_attr{display:none!important}
[class*="yahoo_quoted"],[id*="yahoo_quoted"]{display:none!important}
.moz-cite-prefix{display:none!important}
#divRplyFwdMsg,#divReplyFwdMsg,#appendonsend{display:none!important}
.OutlookMessageHeader,.x_OutlookMessageHeader{display:none!important}
[id^="ms-outlook"]{display:none!important}
div.WordSection1 blockquote{display:none!important}
`;
  const srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}${HIDE_QUOTES_CSS}</style></head><body>${body}</body></html>`;

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      onLoad={handleLoad}
      className="w-full border-0 block"
      style={{ height }}
      sandbox="allow-same-origin"
      title="Email message"
    />
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getInitials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatMessageTime(iso: string): string {
  try {
    const d = parseISO(iso);
    const now = new Date();
    const diffHours = (now.getTime() - d.getTime()) / 3_600_000;
    if (diffHours < 20 && d.getDate() === now.getDate()) return format(d, 'HH:mm');
    if (diffHours < 48) return `Yesterday ${format(d, 'HH:mm')}`;
    if (diffHours < 168) return format(d, 'EEE HH:mm');
    return format(d, 'dd MMM yyyy');
  } catch {
    return '';
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ThreadMessageMeta {
  id: string;
  zimbraId: string;
  fromEmail: string;
  fromName: string | null;
  toRecipients: Array<{ email: string; name?: string | null }>;
  ccRecipients: Array<{ email: string; name?: string | null }>;
  snippet: string | null;
  isRead: boolean;
  isStarred: boolean;
  isDraft?: boolean;
  hasAttachments: boolean;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>;
  receivedAt: string;
}

interface Props {
  message: ThreadMessageMeta;
  isExpanded: boolean;
  onToggle: () => void;
  onReply: (detail: any) => void;
  onReplyAll: (detail: any) => void;
  onForward: (detail: any) => void;
  onDelete: () => void;
  onToggleStar: () => void;
  /** Called when the user clicks a draft row to continue editing it */
  onOpenDraft?: (message: ThreadMessageMeta) => void;
  /** When true, quoted history in the body is preserved (single-message threads) */
  isOnlyMessage?: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ThreadMessage({
  message,
  isExpanded,
  onToggle,
  onReply,
  onReplyAll,
  onForward,
  onDelete,
  onToggleStar,
  onOpenDraft,
  isOnlyMessage = false,
}: Props) {
  const [fullMessage, setFullMessage] = useState<any>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [bodyError, setBodyError] = useState(false);

  // Fetch the full message body whenever this message becomes expanded — this
  // covers both the user clicking to expand AND the default-expanded state set
  // by the parent (e.g. the newest message is expanded on thread open).
  useEffect(() => {
    if (!isExpanded || fullMessage || loadingBody) return;
    let cancelled = false;
    setLoadingBody(true);
    setBodyError(false);
    api.mail.getMessage(message.id)
      .then((data) => { if (!cancelled) setFullMessage(data); })
      .catch(() => { if (!cancelled) setBodyError(true); })
      .finally(() => { if (!cancelled) setLoadingBody(false); });
    return () => { cancelled = true; };
  }, [isExpanded, message.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleToggle = useCallback(() => {
    onToggle();
  }, [onToggle]);

  const initials = getInitials(message.fromName, message.fromEmail);
  const displayName = message.fromName ?? message.fromEmail;
  const timeStr = formatMessageTime(message.receivedAt);
  const detail = fullMessage ?? message;

  // ── Collapsed row ─────────────────────────────────────────────────────────

  if (!isExpanded) {
    // Drafts: clicking opens compose, not the thread expand
    const handleCollapsedClick = message.isDraft
      ? () => onOpenDraft?.(message)
      : handleToggle;

    return (
      <div
        className={cn(
          'relative flex items-center gap-2.5 px-4 py-2 cursor-pointer transition-colors hover:bg-muted/25',
          !message.isRead && !message.isDraft && 'bg-primary/[0.02]',
          message.isDraft && 'bg-amber-50/40 dark:bg-amber-900/10',
        )}
        role="button"
        tabIndex={0}
        onClick={handleCollapsedClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCollapsedClick(); }}
        aria-expanded={false}
        aria-label={`${message.isDraft ? 'Draft: ' : ''}Message from ${displayName}, ${timeStr}${!message.isRead ? ', unread' : ''}`}
      >
        {/* Avatar node — ring punches through spine line */}
        <div className={cn(
          'w-7 h-7 rounded-full text-[11px] font-semibold flex items-center justify-center shrink-0 relative z-10 ring-2 ring-background',
          message.isDraft
            ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
            : 'bg-primary/10 text-primary',
        )}>
          {initials}
        </div>

        {/* Sender name */}
        <span className={cn(
          'text-[13px] shrink-0',
          !message.isRead && !message.isDraft ? 'text-foreground font-semibold' : 'text-foreground/75',
        )}>
          {displayName}
        </span>

        {/* Draft badge */}
        {message.isDraft && (
          <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
            DRAFT
          </span>
        )}

        {/* Snippet — takes remaining space */}
        <span className="text-[12px] text-muted-foreground/50 truncate flex-1 min-w-0">
          {message.snippet ?? ''}
        </span>

        {/* Right: attachment icon + time + action */}
        <div className="flex items-center gap-1.5 shrink-0">
          {message.hasAttachments && (
            <Paperclip className="w-3 h-3 text-muted-foreground/40" />
          )}
          <span className="text-[11px] text-muted-foreground/40">{timeStr}</span>
          {message.isDraft ? (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="p-0.5 rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="Delete draft"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/35" />
          )}
        </div>
      </div>
    );
  }

  // ── Expanded card ─────────────────────────────────────────────────────────

  return (
    <div
      className="flex items-start gap-3 px-4 py-2"
      role="article"
      aria-label={`Message from ${displayName}, ${timeStr}`}
      aria-expanded={true}
    >
      {/* Avatar node — sits on the spine */}
      <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-[11px] font-semibold flex items-center justify-center shrink-0 mt-1 relative z-10 ring-2 ring-background">
        {initials}
      </div>

      {/* Card */}
      <div className="flex-1 min-w-0 rounded-xl border border-border/30 bg-card shadow-sm overflow-hidden mb-2">
        {/* Header — click to collapse */}
        <div
          className="flex items-start px-4 pt-3 pb-2 cursor-pointer select-none hover:bg-muted/20 transition-colors"
          onClick={handleToggle}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleToggle(); }}
          aria-label="Collapse message"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] text-foreground font-semibold">{displayName}</span>
              <div className="flex items-center gap-1.5 shrink-0">
                {message.hasAttachments && (
                  <Paperclip className="w-3 h-3 text-muted-foreground/50" />
                )}
                <span className="text-[11px] text-muted-foreground/50">{timeStr}</span>
                <ChevronUp className="w-3.5 h-3.5 text-muted-foreground/35" />
              </div>
            </div>
            {/* Recipient summary */}
            <div className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground/50 mt-0.5">
              <span className="text-muted-foreground/65">{`<${message.fromEmail}>`}</span>
              {message.toRecipients.length > 0 && (
                <span>
                  To:{' '}
                  {message.toRecipients
                    .slice(0, 3)
                    .map((r) => r.name ?? r.email)
                    .join(', ')}
                  {message.toRecipients.length > 3 && ` +${message.toRecipients.length - 3}`}
                </span>
              )}
              {message.ccRecipients.length > 0 && (
                <span>
                  CC:{' '}
                  {message.ccRecipients
                    .slice(0, 2)
                    .map((r) => r.name ?? r.email)
                    .join(', ')}
                  {message.ccRecipients.length > 2 && ` +${message.ccRecipients.length - 2}`}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        <div>
          {loadingBody ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/40" />
            </div>
          ) : bodyError ? (
            <div className="px-4 py-4 text-[13px] text-destructive/60">
              Could not load message.{' '}
              <button
                onClick={() => { setBodyError(false); setLoadingBody(true); api.mail.getMessage(message.id).then(setFullMessage).catch(() => setBodyError(true)).finally(() => setLoadingBody(false)); }}
                className="underline hover:text-destructive"
              >
                Retry
              </button>
            </div>
          ) : fullMessage ? (
            <div className="border-t border-border/10">
              <EmailBodyFrame html={fullMessage.bodyHtml} text={fullMessage.bodyText} stripQuotes={!isOnlyMessage} />
            </div>
          ) : (
            <div className="px-4 py-4 text-[13px] text-muted-foreground/50">
              {message.snippet ?? 'No content'}
            </div>
          )}

          {/* Attachments */}
          {(fullMessage?.attachments?.length ?? 0) > 0 && (
            <div className="px-4 pt-2 pb-3 flex flex-wrap gap-2 border-t border-border/10">
              {fullMessage.attachments.map((att: any) => (
                <button
                  key={att.id}
                  onClick={() =>
                    api.mail
                      .downloadAttachment(message.id, att.id)
                      .then((url) => {
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = att.filename;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 5_000);
                      })
                      .catch(() => {})
                  }
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/40 hover:bg-muted text-[11px] text-foreground/70 transition-colors"
                >
                  <Paperclip className="w-3 h-3 text-muted-foreground/50 shrink-0" />
                  <span className="max-w-[140px] truncate">{att.filename}</span>
                  {att.size > 0 && (
                    <span className="text-muted-foreground/40 shrink-0">{formatBytes(att.size)}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-0.5 px-4 pb-3 pt-1 border-t border-border/10">
          <button
            onClick={() => onReply(detail)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Reply className="w-3.5 h-3.5" />
            Reply
          </button>
          <button
            onClick={() => onReplyAll(detail)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <ReplyAll className="w-3.5 h-3.5" />
            Reply All
          </button>
          <button
            onClick={() => onForward(detail)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Forward className="w-3.5 h-3.5" />
            Forward
          </button>
          <div className="flex-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onToggleStar}
                className={cn(
                  'p-1.5 rounded-md transition-colors',
                  message.isStarred
                    ? 'text-amber-400 hover:bg-muted'
                    : 'text-muted-foreground/40 hover:text-foreground hover:bg-muted',
                )}
              >
                <Star className={cn('w-4 h-4', message.isStarred && 'fill-amber-400')} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {message.isStarred ? 'Unstar' : 'Star'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onDelete}
                className="p-1.5 rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
