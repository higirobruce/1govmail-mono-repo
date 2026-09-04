'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
import { fetchBodyCached, watchPendingBody } from '@/lib/mailBodyCache';
import { getAttachmentUrl } from '@/lib/attachmentBlobCache';
import { getPreviewKind } from '@/lib/attachmentPreviewKind';
import { prepareEmailHtml } from '@/lib/emailRender';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { MailAvatar, getInitials } from './MailAvatar';
import { AttachmentTile } from './AttachmentTile';
import { AttachmentLightbox } from './AttachmentLightbox';

/** Files we can render inline rather than force-download — one shared
 *  classification with the lightbox and inline previewer (image / pdf / csv /
 *  text / video / audio). */
function isPreviewableAttachment(att: { mimeType: string; filename: string }): boolean {
  return getPreviewKind(att.mimeType, att.filename) !== null;
}

// ─── Email rendering (mirrors MailDetail.tsx constants) ─────────────────────

const EMAIL_CSS = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:16px;background:#ffffff;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:16px;line-height:1.6;overflow-x:auto;word-wrap:break-word}
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
*,*::before,*::after{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif!important;color:#111827!important;background-color:transparent!important;font-size:16px!important;line-height:1.65!important;letter-spacing:normal!important;text-transform:none!important;font-weight:normal!important;font-style:normal!important}
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

// In thread view each message is shown individually so quoted history is stripped.
// The CSS below is baked into the srcDoc for the stripQuotes=true (multi-message) path.
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

// Selectors used by the JS DOM stripper (stripQuotes=true path)
const QUOTE_SELECTORS = [
  'blockquote',
  '.gmail_quote', '.gmail_extra', '.gmail_attr',
  '[class*="yahoo_quoted"]', '[id*="yahoo_quoted"]',
  '.moz-cite-prefix',
  '#divRplyFwdMsg', '#divReplyFwdMsg', '#appendonsend',
  '.OutlookMessageHeader', '.x_OutlookMessageHeader',
  '[id^="ms-outlook"]',
  '[class*="BodyFragment"] blockquote',
];

// Finds the first element that marks the start of quoted content in `root`.
// Works on any Element so it can be used both inside iframe handleLoad callbacks
// and on temporary div elements for pre-render splitting.
function findQuoteSep(root: Element): Element | null {
  const byId = root.querySelector<Element>('#zwchr');
  if (byId) return byId;

  const byApple = root.querySelector<Element>('hr[class*="Apple-interchange"]');
  if (byApple) return byApple;

  for (const div of Array.from(root.querySelectorAll<Element>('div[style*="border-top"]'))) {
    if (/From\s*:|Sent\s*:/i.test(div.textContent ?? '')) return div;
  }

  const byHrHeuristic = Array.from(root.querySelectorAll<Element>('hr')).find((hr) => {
    const t = hr.nextElementSibling?.textContent ?? '';
    return /^\s*(On\s.+wrote:|From\s*:|Sent\s*:|De\s*:|Von\s*:|-{3,})/i.test(t);
  });
  if (byHrHeuristic) return byHrHeuristic;

  const onWroteRe = /^On\s+\S[\s\S]{5,250}wrote\s*:\s*$/i;
  const byOnWrote = Array.from(root.querySelectorAll<Element>('div, p, span'))
    .find((el) => {
      if (el.children.length > 4) return false;
      const t = (el.textContent ?? '').trim();
      return t.length < 300 && onWroteRe.test(t);
    });
  if (byOnWrote) return byOnWrote;

  const emailFromRe = /^From\s*:\s*(?:[^<\n]{0,100}<)?[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+/i;
  const byOutlookFrom = Array.from(root.querySelectorAll<Element>('p, div, td'))
    .find((el) => {
      if (el.children.length > 6) return false;
      const t = (el.textContent ?? '').trim();
      if (emailFromRe.test(t) && /(Date|Sent|When)\s*:/i.test(t) && /(To|Subject)\s*:/i.test(t)) return true;
      if (emailFromRe.test(t) && t.length <= 250) {
        const nextT = el.nextElementSibling?.textContent?.trim() ?? '';
        return /^(Date|Sent|To|When|Subject|À|An)\s*:/i.test(nextT);
      }
      return false;
    });
  if (byOutlookFrom) return byOutlookFrom;

  const pureSepRe = /^[-_=*]{5,}$/;
  const byPureSep = Array.from(root.querySelectorAll<Element>('p, div, span'))
    .find((el) => {
      if ((el.textContent ?? '').trim().match(pureSepRe) === null) return false;
      const nextT = el.nextElementSibling?.textContent?.trim() ?? '';
      return /^From\s*:/i.test(nextT) || /^On\s+\S.{5,}wrote\s*:/i.test(nextT);
    });
  if (byPureSep) return byPureSep;

  const dashMsgRe = /^[-_*\s]{2,}(Original|Forwarded)\s+(Message|mail|e-?mail)[-_*\s]*/i;
  const byDashMsg = Array.from(root.querySelectorAll<Element>('div, p'))
    .find((el) => {
      const t = (el.textContent ?? '').trim();
      return dashMsgRe.test(t) && t.length < 80;
    });
  if (byDashMsg) return byDashMsg;

  return null;
}

// Splits preprocessed email HTML into main content and quoted content using the
// same heuristics as the iframe DOM stripper.  Returns { main, quoted } where
// quoted is null when no split point is found.  Client-side only.
function splitEmailBody(html: string): { main: string; quoted: string | null } {
  if (typeof document === 'undefined') return { main: html, quoted: null };

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  const quotedNodes: Node[] = [];
  const sep = findQuoteSep(tmp);

  if (sep) {
    const ancestors: Element[] = [];
    let node: Element = sep;
    while (node.parentElement && node.parentElement !== tmp) {
      ancestors.push(node.parentElement);
      node = node.parentElement;
    }
    let sib: Element | null = sep;
    while (sib) { const nx: Element | null = sib.nextElementSibling; quotedNodes.push(sib); sib.remove(); sib = nx; }
    for (const anc of ancestors) {
      let sib2: Element | null = anc.nextElementSibling;
      while (sib2) { const nx: Element | null = sib2.nextElementSibling; quotedNodes.push(sib2); sib2.remove(); sib2 = nx; }
    }
  } else {
    // Fallback: split at the first blockquote
    const firstBq = tmp.querySelector('blockquote');
    if (firstBq) {
      let sib: ChildNode | null = firstBq;
      while (sib) { const nx: ChildNode | null = sib.nextSibling; quotedNodes.push(sib); tmp.removeChild(sib); sib = nx; }
    }
  }

  if (quotedNodes.length === 0) return { main: html, quoted: null };

  const quotedDiv = document.createElement('div');
  quotedNodes.forEach((n) => quotedDiv.appendChild(n));
  return { main: tmp.innerHTML, quoted: quotedDiv.innerHTML };
}

function EmailBodyFrame({ html, text, stripQuotes = true }: { html: string | null; text: string | null; stripQuotes?: boolean }) {
  const normalizeStyles =
    typeof window !== 'undefined'
      ? localStorage.getItem('1gov_normalize_email_styles') !== 'false'
      : true;

  const mainRef  = useRef<HTMLIFrameElement>(null);
  const quotedRef = useRef<HTMLIFrameElement>(null);
  const [showQuoted, setShowQuoted] = useState(false);

  // Heights are written straight to the iframe elements instead of held in
  // React state: every image load fires a resize, and a state update here
  // would re-render (and re-sanitize + re-split) a body that can hold
  // multi-megabyte base64 images.
  const resizeMain = useCallback(() => {
    const frame = mainRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;
    requestAnimationFrame(() => {
      if (!mainRef.current?.contentDocument) return;
      frame.style.height = `${Math.max(doc.documentElement.scrollHeight, 100)}px`;
    });
  }, []);

  const resizeQuoted = useCallback(() => {
    const frame = quotedRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;
    requestAnimationFrame(() => {
      if (!quotedRef.current?.contentDocument) return;
      frame.style.height = `${Math.max(doc.documentElement.scrollHeight, 100)}px`;
    });
  }, []);

  // handleLoad for the main iframe.
  // When stripQuotes=false the body was already split before render, so just resize.
  // When stripQuotes=true run the full JS + CSS quote-stripping pass.
  const handleMainLoad = useCallback(() => {
    const doc = mainRef.current?.contentDocument;
    if (!doc) return;

    if (!stripQuotes) {
      resizeMain();
      doc.querySelectorAll('img').forEach((img) => {
        if (!img.complete) {
          img.addEventListener('load',  resizeMain, { once: true });
          img.addEventListener('error', resizeMain, { once: true });
        }
      });
      return;
    }

    // Pass 1 — remove elements with known quote class/id
    QUOTE_SELECTORS.forEach((sel) => {
      doc.querySelectorAll(sel).forEach((el) => el.remove());
    });

    // Pass 2 — remove separator and everything after it
    if (doc.body) {
      const sep = findQuoteSep(doc.body);
      if (sep) {
        const ancestors: Element[] = [];
        let node: Element = sep;
        while (node.parentElement && node.parentElement !== doc.body) {
          ancestors.push(node.parentElement);
          node = node.parentElement;
        }
        let sib: Element | null = sep;
        while (sib) { const nx: Element | null = sib.nextElementSibling; sib.remove(); sib = nx; }
        for (const anc of ancestors) {
          let sib2: Element | null = anc.nextElementSibling;
          while (sib2) { const nx = sib2.nextElementSibling; sib2.remove(); sib2 = nx; }
        }
      }
    }

    resizeMain();
    doc.querySelectorAll('img').forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load',  resizeMain, { once: true });
        img.addEventListener('error', resizeMain, { once: true });
      }
    });
  }, [resizeMain, stripQuotes]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleQuotedLoad = useCallback(() => {
    const doc = quotedRef.current?.contentDocument;
    if (!doc) return;
    resizeQuoted();
    doc.querySelectorAll('img').forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load',  resizeQuoted, { once: true });
        img.addEventListener('error', resizeQuoted, { once: true });
      }
    });
  }, [resizeQuoted]);

  // Preprocess once per body (memoized here and in prepareEmailHtml): fix
  // Zimbra deferred images and malformed data URIs, sanitize (defense-in-depth
  // — the iframe is also sandboxed), split out the quoted history, and build
  // the srcDoc strings. Hooks run before the no-html early return to keep the
  // hook order stable.
  const docs = useMemo(() => {
    if (!html) return null;
    const body = prepareEmailHtml(html);
    const css = normalizeStyles ? EMAIL_CSS + NORMALIZE_CSS : EMAIL_CSS;
    const mkSrcDoc = (content: string, hideQuotes = false) =>
      `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}${hideQuotes ? HIDE_QUOTES_CSS : ''}</style></head><body>${content}</body></html>`;
    if (!stripQuotes) {
      const split = splitEmailBody(body);
      return { main: mkSrcDoc(split.main), quoted: split.quoted ? mkSrcDoc(split.quoted) : null };
    }
    return { main: mkSrcDoc(body, true), quoted: null };
  }, [html, normalizeStyles, stripQuotes]);

  if (!docs) {
    return (
      <pre className="whitespace-pre-wrap font-sans text-ui text-ink-2 leading-relaxed p-4">
        {text ?? 'No content'}
      </pre>
    );
  }

  // ── stripQuotes=false: split body into main + quoted, render two iframes ──
  if (!stripQuotes) {
    return (
      <div>
        <iframe
          ref={mainRef}
          srcDoc={docs.main}
          onLoad={handleMainLoad}
          className="w-full border-0 block"
          style={{ height: 200 }}
          sandbox="allow-same-origin"
          title="Email message"
        />
        {docs.quoted && (
          <div className="border-t border-border-faint">
            <div className="px-4 py-2">
              <button
                onClick={() => setShowQuoted((v) => !v)}
                className="flex items-center gap-1 text-ui text-ink-2 hover:text-foreground transition-colors"
              >
                {showQuoted ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {showQuoted ? 'Hide quoted message' : 'Show quoted message'}
              </button>
            </div>
            {showQuoted && (
              <iframe
                ref={quotedRef}
                srcDoc={docs.quoted}
                onLoad={handleQuotedLoad}
                className="w-full border-0 block"
                style={{ height: 200 }}
                sandbox="allow-same-origin"
                title="Quoted message"
              />
            )}
          </div>
        )}
      </div>
    );
  }

  // ── stripQuotes=true: single iframe, JS + CSS stripping in handleMainLoad ──
  return (
    <iframe
      ref={mainRef}
      srcDoc={docs.main}
      onLoad={handleMainLoad}
      className="w-full border-0 block"
      style={{ height: 200 }}
      sandbox="allow-same-origin"
      title="Email message"
    />
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  /** Called after expanding an unread message marks it read (parent updates its list state) */
  onMarkedRead?: () => void;
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
  onMarkedRead,
  isOnlyMessage = false,
}: Props) {
  const [fullMessage, setFullMessage] = useState<any>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [bodyError, setBodyError] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxSelectedId, setLightboxSelectedId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const handleDownloadAttachment = useCallback(async (att: { id: string; filename: string }) => {
    if (downloadingId) return;
    setDownloadingId(att.id);
    try {
      // Shared blob cache — repeat/preview-then-download reuses the fetched
      // blob; the cache owns the URL lifecycle (no revoke here).
      const url = await getAttachmentUrl(message.id, att.id, () => api.mail.downloadAttachment(message.id, att.id));
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      a.click();
    } catch {
      /* non-critical — surfaced by the lightbox / retry paths elsewhere */
    } finally {
      setDownloadingId(null);
    }
  }, [downloadingId, message.id]);

  // Expanding an unread message marks it read explicitly. The body fetch is a
  // pure read (the server no longer passes Zimbra's read flag, so background
  // jobs can't consume unread state) — the user actually seeing the message is
  // the one moment read-marking belongs to. Fire-and-forget + idempotent: the
  // clicked/newest message may already be marked by openMessage.
  useEffect(() => {
    if (!isExpanded || message.isRead || message.isDraft) return;
    api.mail.markRead(message.id, true).catch(() => {});
    onMarkedRead?.();
  }, [isExpanded, message.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the full message body whenever this message becomes expanded — this
  // covers both the user clicking to expand AND the default-expanded state set
  // by the parent (e.g. the newest message is expanded on thread open).
  useEffect(() => {
    if (!isExpanded || fullMessage || loadingBody) return;
    let cancelled = false;
    setLoadingBody(true);
    setBodyError(false);
    // Cache-first: when this is the message the detail pane already fetched
    // (the common case — the newest message auto-expands on open), this resolves
    // from the shared body cache instead of re-downloading the body + images.
    //
    // Settlement deliberately IGNORES `cancelled` for state that stays valid:
    // this component instance is keyed by message.id, so a fetch that lands
    // after a collapse still belongs to this message — store it. Skipping
    // setLoadingBody(false) on cancel used to strand loadingBody=true forever
    // (the guard above then blocked every retry → eternal spinner on re-open,
    // since a closed reader keeps its ThreadView rows mounted).
    fetchBodyCached(message.id, api.mail.getMessage)
      .then((data) => {
        setFullMessage(data);
        // Inline images still embedding server-side — poll for the final body
        // and swap it in when it lands (shares one poll loop with the detail pane).
        if ((data as { embedPending?: boolean })?.embedPending) {
          watchPendingBody(message.id, api.mail.getMessage, (fresh) => setFullMessage(fresh));
        }
      })
      // `cancelled` only gates the error flag — a failure from an abandoned
      // expand shouldn't flash "Could not load" on a collapsed row; the next
      // expand simply retries because loadingBody is reset below.
      .catch(() => { if (!cancelled) setBodyError(true); })
      .finally(() => setLoadingBody(false));
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
          message.isDraft && 'bg-warning/5',
        )}
        role="button"
        tabIndex={0}
        onClick={handleCollapsedClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleCollapsedClick(); }}
        aria-expanded={false}
        aria-label={`${message.isDraft ? 'Draft: ' : ''}Message from ${displayName}, ${timeStr}${!message.isRead ? ', unread' : ''}`}
      >
        {/* Avatar node — ring punches through spine line */}
        {message.isDraft ? (
          <div className="w-7 h-7 rounded-full text-micro font-semibold flex items-center justify-center shrink-0 relative z-10 ring-2 ring-background bg-warning/15 text-warning-strong">
            {initials}
          </div>
        ) : (
          <MailAvatar
            name={message.fromName}
            email={message.fromEmail}
            size="xs"
            className="relative z-10 ring-2 ring-background"
          />
        )}

        {/* Sender name */}
        <span className={cn(
          'text-ui shrink-0',
          !message.isRead && !message.isDraft ? 'text-foreground font-semibold' : 'text-ink-2',
        )}>
          {displayName}
        </span>

        {/* Draft badge */}
        {message.isDraft && (
          <span className="shrink-0 px-1.5 py-0.5 rounded text-micro leading-none font-semibold bg-warning/15 text-warning-strong">
            DRAFT
          </span>
        )}

        {/* Snippet — takes remaining space */}
        <span className="text-ui text-ink-3 truncate flex-1 min-w-0">
          {message.snippet ?? ''}
        </span>

        {/* Right: attachment icon + time + action */}
        <div className="flex items-center gap-1.5 shrink-0">
          {message.hasAttachments && (
            <Paperclip className="w-3 h-3 text-ink-4" />
          )}
          <span className="text-micro text-ink-4">{timeStr}</span>
          {message.isDraft ? (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="p-0.5 rounded text-ink-4 hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="Delete draft"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-ink-4" />
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
      <MailAvatar
        name={message.fromName}
        email={message.fromEmail}
        size="xs"
        className="mt-1 relative z-10 ring-2 ring-background"
      />

      {/* Card */}
      <div className="flex-1 min-w-0 rounded-xl border border-border-faint bg-card shadow-sm overflow-hidden mb-2">
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
              <span className="text-ui text-foreground font-semibold">{displayName}</span>
              <div className="flex items-center gap-1.5 shrink-0">
                {message.hasAttachments && (
                  <Paperclip className="w-3 h-3 text-ink-3" />
                )}
                <span className="text-micro text-ink-3">{timeStr}</span>
                <ChevronUp className="w-3.5 h-3.5 text-ink-4" />
              </div>
            </div>
            {/* Recipient summary */}
            <div className="flex flex-wrap gap-x-3 text-micro text-ink-3 mt-0.5">
              <span className="text-ink-3">{`<${message.fromEmail}>`}</span>
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
              <Loader2 className="w-4 h-4 animate-spin text-ink-4" />
            </div>
          ) : bodyError ? (
            <div className="px-4 py-4 text-ui text-destructive/60">
              Could not load message.{' '}
              <button
                onClick={() => { setBodyError(false); setLoadingBody(true); api.mail.getMessage(message.id).then(setFullMessage).catch(() => setBodyError(true)).finally(() => setLoadingBody(false)); }}
                className="underline hover:text-destructive"
              >
                Retry
              </button>
            </div>
          ) : fullMessage ? (
            <div className="border-t border-border-faint">
              <EmailBodyFrame html={fullMessage.bodyHtml} text={fullMessage.bodyText} stripQuotes={!isOnlyMessage} />
            </div>
          ) : (
            <div className="px-4 py-4 text-ui text-ink-3">
              {message.snippet ?? 'No content'}
            </div>
          )}

          {/* Attachments */}
          {(fullMessage?.attachments?.length ?? 0) > 0 && (
            <div className="px-4 pt-3 pb-3 border-t border-border-faint">
              <div className="flex items-center gap-1.5 mb-2.5">
                <Paperclip className="w-3.5 h-3.5 text-ink-3" />
                <span className="text-ui font-semibold text-foreground">Attachments</span>
                <span className="text-micro text-ink-3">
                  ({fullMessage.attachments.length})
                </span>
              </div>
              <div className="flex items-start gap-3 flex-wrap">
                {fullMessage.attachments.map((att: any) => {
                  const previewable = isPreviewableAttachment(att);
                  const openPreview = () => { setLightboxSelectedId(att.id); setLightboxOpen(true); };
                  return (
                    <AttachmentTile
                      key={att.id}
                      attachment={att}
                      // Click previews when we can render it inline; otherwise downloads.
                      onClick={() => (previewable ? openPreview() : handleDownloadAttachment(att))}
                      onPreview={previewable ? openPreview : undefined}
                      onDownload={() => handleDownloadAttachment(att)}
                      downloading={downloadingId === att.id}
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* Attachment preview lightbox (image / PDF / text — before any download) */}
          {lightboxOpen && lightboxSelectedId && (fullMessage?.attachments?.length ?? 0) > 0 && (
            <AttachmentLightbox
              open={lightboxOpen}
              attachments={fullMessage.attachments}
              selectedId={lightboxSelectedId}
              messageId={message.id}
              onClose={() => { setLightboxOpen(false); setLightboxSelectedId(null); }}
            />
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-0.5 px-4 pb-3 pt-1 border-t border-border-faint">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onReply(detail)}
            className="text-ink-2 hover:text-foreground"
          >
            <Reply className="w-3.5 h-3.5" />
            Reply
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onReplyAll(detail)}
            className="text-ink-2 hover:text-foreground"
          >
            <ReplyAll className="w-3.5 h-3.5" />
            Reply All
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onForward(detail)}
            className="text-ink-2 hover:text-foreground"
          >
            <Forward className="w-3.5 h-3.5" />
            Forward
          </Button>
          <div className="flex-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onToggleStar}
                className={cn(
                  message.isStarred
                    ? 'text-warning-strong hover:bg-muted'
                    : 'text-ink-4 hover:text-foreground hover:bg-muted',
                )}
              >
                <Star className={cn('w-4 h-4', message.isStarred && 'fill-warning-strong')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {message.isStarred ? 'Unstar' : 'Star'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="destructive-ghost" size="icon-sm" onClick={onDelete}>
                <Trash2 className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">Delete</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
