'use client';

import { format, parseISO } from 'date-fns';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Reply, ReplyAll, Forward, Trash2, Archive, Star, Inbox, Tag, FolderOpen,
  Paperclip, Download, Loader2, MoreHorizontal,
  ChevronLeft, ChevronRight, X, Mail, User, Calendar,
  Eye, File, FileText, Image as ImageIcon, Printer, BellOff, Bell, AlarmClock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { sanitizeEmailHtml } from '@/lib/sanitize';
import { toast } from 'sonner';
import { QuickReplyBar } from '@/components/mail/QuickReplyBar';
import { AttachmentLightbox } from '@/components/mail/AttachmentLightbox';
import { MailAvatar } from '@/components/mail/MailAvatar';
import { ClassificationChip } from '@/components/mail/ClassificationChip';
import { pickHighestClassification } from '@/lib/classification';
import { AttachmentTile, fileTypeStyle } from '@/components/mail/AttachmentTile';

interface MessageDetail {
  id: string;
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  toRecipients: Array<{ email: string; name?: string }>;
  ccRecipients: Array<{ email: string; name?: string }>;
  bodyHtml: string | null;
  bodyText: string | null;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>;
  inlineImages?: Array<{ cid: string; partId: string; mimeType: string }>;
  receivedAt: string;
  tags?: string[] | null;
}

interface FolderItem {
  id: string;
  name: string;
  path: string;
  type?: string;
}

const BUILTIN_PATHS_DETAIL = new Set([
  '/Inbox', '/Trash', '/Sent', '/Drafts', '/Archive', '/Starred',
  '/Junk', '/Spam', '/Contacts', '/Calendar', '/Tasks', '/Briefcase',
  '/Chats', '/Emailed Contacts',
]);

interface MailDetailProps {
  message?: MessageDetail | null;
  loading?: boolean;
  onClose?: () => void;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onDelete?: () => void;
  onToggleStar?: () => void;
  onMoveToInbox?: () => void;
  folders?: FolderItem[];
  onMoveToFolder?: (folderId: string) => void;
  onMute?: () => void;
  isMuted?: boolean;
  onSnooze?: () => void;
}

type DetailTab = 'overview' | 'message' | 'attachments';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function ActionBtn({
  icon: Icon,
  label,
  onClick,
  danger,
  highlight,
}: {
  icon: React.ElementType;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  highlight?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'p-1.5 rounded-md transition-colors',
            danger
              ? 'text-muted-foreground/45 hover:text-destructive hover:bg-destructive/10'
              : highlight
              ? 'text-amber-400 hover:bg-muted'
              : 'text-muted-foreground/45 hover:text-foreground hover:bg-muted',
          )}
        >
          <Icon className={cn('w-4 h-4', highlight && 'fill-amber-400')} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

function extractBodyContent(html: string): string {
  // Greedy match so that an early stray </body> inside the email body doesn't
  // truncate the content (common in newsletter templates / old Outlook HTML).
  const match = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (match) return match[1];
  // No <body> tag at all — strip <head> and any stray html/body open/close tags,
  // then return the rest verbatim (preserves content from old plaintext-to-HTML
  // converters that omit the body element).
  return html
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?(html|body)[^>]*>/gi, '')
    .trim();
}

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

// Appended to EMAIL_CSS when "Consistent email display" is ON.
// Uses !important so these stylesheet rules beat inline style="" attributes on
// every element — the only way to override sender-supplied typography wholesale.
// Heading-specific rules restore the visual hierarchy because those selectors
// (h1, h2…) have higher specificity than the wildcard (*) rule.
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

// bodyHtml is pre-processed server-side: inline images are already embedded as
// base64 data URIs, so EmailBody renders immediately with no async fetching.
// External images (http/https src) are also handled: the CSP meta tag below
// upgrades insecure http:// requests to https:// to avoid mixed-content blocks.
function EmailBody({
  html,
  text,
}: {
  html: string | null;
  text: string | null;
}) {
  // Read the user's "consistent email display" preference from localStorage.
  // Evaluated once per mount (remount happens on message switch via key=).
  // Default: true (normalize on). Set to false only when user disables it.
  const normalizeStyles =
    typeof window !== 'undefined'
      ? localStorage.getItem('1gov_normalize_email_styles') !== 'false'
      : true;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(400);

  // Re-measure iframe height, deferred one animation frame so the browser has
  // finished reflowing (needed when called from an image's load event).
  const resizeFrame = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    requestAnimationFrame(() =>
      setHeight(Math.max(doc.documentElement.scrollHeight, 200)),
    );
  }, []);

  const handleLoad = useCallback(() => {
    resizeFrame();
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    // Attach one-shot listeners to every image that hasn't loaded yet so the
    // iframe grows correctly after lazy / external images finish downloading.
    doc.querySelectorAll('img').forEach((img) => {
      if (!img.complete) {
        img.addEventListener('load',  resizeFrame, { once: true });
        img.addEventListener('error', resizeFrame, { once: true });
      }
    });
  }, [resizeFrame]);

  if (!html) {
    return (
      <pre className="whitespace-pre-wrap font-sans text-[13px] text-foreground/80 leading-relaxed">
        {text ?? 'No content'}
      </pre>
    );
  }

  // Zimbra uses `dfsrc` instead of `src` on images (deferred loading). Convert
  // them to standard `src` so the browser renders them correctly.
  // Also strip the non-standard `name=` parameter from data URIs — e.g.
  // `data:image/gif; name="foo.gif";base64,...` — whose unescaped inner quotes
  // break HTML attribute parsing and cause the image to render as broken.
  const body = sanitizeEmailHtml(
    extractBodyContent(html)
      .replace(/\bdfsrc=/gi, 'src=')
      .replace(/data:([^;]+);\s*name="[^"]*";/gi, 'data:$1;'),
  );
  // upgrade-insecure-requests: silently upgrades http:// image/resource URLs to
  // https:// so external email images are not blocked by mixed-content policy on
  // HTTPS deployments.
  // NORMALIZE_CSS is appended after EMAIL_CSS so its !important rules override
  // any inline styles the sender embedded in the email HTML.
  const css = normalizeStyles ? EMAIL_CSS + NORMALIZE_CSS : EMAIL_CSS;
  const srcDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${body}</body></html>`;

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

// Fetches a blob: URL and renders its content as plain text — avoids any
// embedded-frame restrictions that privacy-first browsers (e.g. Dia) impose on
// blob: URLs loaded inside iframes.

function MetaRow({ icon: Icon, label, children }: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-2">
      <div className="flex items-center gap-2 w-20 shrink-0 mt-0.5">
        <Icon className="w-3.5 h-3.5 text-muted-foreground/35 shrink-0" />
        <span className="text-[12px] text-muted-foreground/50">{label}</span>
      </div>
      <div className="flex-1 min-w-0 text-[13px] text-foreground">
        {children}
      </div>
    </div>
  );
}

export default function MailDetail({
  message,
  loading,
  onClose,
  onReply,
  onReplyAll,
  onForward,
  onDelete,
  onToggleStar,
  onMoveToInbox,
  folders = [],
  onMoveToFolder,
  onMute,
  isMuted = false,
  onSnooze,
}: MailDetailProps) {
  const archiveFolder = folders.find((f) => f.path === '/Archive');
  const handleArchive = useCallback(() => {
    if (archiveFolder && onMoveToFolder) onMoveToFolder(archiveFolder.id);
  }, [archiveFolder, onMoveToFolder]);
  const classification = message ? pickHighestClassification(message.tags) : null;
  const [activeTab, setActiveTab] = useState<DetailTab>('message');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false);
  const folderDropdownRef = useRef<HTMLDivElement>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxSelectedId, setLightboxSelectedId] = useState<string | null>(null);

  const labelFolders = folders.filter(
    (f) => !BUILTIN_PATHS_DETAIL.has(f.path) && (f.type === 'MAIL' || !f.type),
  );

  // Close folder dropdown on outside click
  useEffect(() => {
    if (!folderDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (folderDropdownRef.current && !folderDropdownRef.current.contains(e.target as Node)) {
        setFolderDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [folderDropdownOpen]);

  // Reset to message tab when a new message is opened
  useEffect(() => {
    setActiveTab('message');
  }, [message?.id]);

  // Close lightbox when navigating to a different message
  useEffect(() => {
    setLightboxOpen(false);
    setLightboxSelectedId(null);
  }, [message?.id]);

  const handlePrint = useCallback(() => {
    if (!message) return;
    const css = `body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#111;padding:24px;max-width:800px;margin:0 auto}
      h1{font-size:20px;margin-bottom:4px}
      .meta{font-size:12px;color:#666;margin-bottom:16px;border-bottom:1px solid #e5e7eb;padding-bottom:12px}
      .meta span{margin-right:16px}`;
    const body = message.bodyHtml ?? `<pre style="white-space:pre-wrap">${message.bodyText ?? ''}</pre>`;
    const printWin = window.open('', '_blank', 'width=800,height=600');
    if (!printWin) return;
    printWin.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style><title>${message.subject ?? 'Email'}</title></head><body>
      <h1>${message.subject ?? '(no subject)'}</h1>
      <div class="meta">
        <span><b>From:</b> ${message.fromName ? `${message.fromName} &lt;${message.fromEmail}&gt;` : message.fromEmail}</span>
        <span><b>To:</b> ${message.toRecipients.map((r) => r.name ?? r.email).join(', ')}</span>
        <span><b>Date:</b> ${message.receivedAt}</span>
      </div>
      ${body}
      </body></html>`);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => { printWin.print(); }, 400);
  }, [message]);

  const handleDownload = useCallback(async (att: { id: string; filename: string }) => {
    if (!message || downloadingId) return;
    setDownloadingId(att.id);
    try {
      const url = await api.mail.downloadAttachment(message.id, att.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err: any) {
      toast.error('Download failed', { description: err?.message });
    } finally {
      setDownloadingId(null);
    }
  }, [message, downloadingId]);

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex flex-col h-full bg-background">
        <div className="h-11 border-b border-border/35 animate-pulse bg-muted/10" />
        <div className="h-9 border-b border-border/25 animate-pulse bg-muted/5" />
        <div className="flex-1 p-5 animate-pulse space-y-4">
          <div className="bg-card border border-border/40 rounded-xl p-5 space-y-3">
            <div className="h-5 w-2/3 bg-muted rounded" />
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex gap-3 py-2 border-b border-border/20">
                <div className="h-3 w-20 bg-muted/60 rounded" />
                <div className="h-3 w-40 bg-muted/40 rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!message) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8 bg-background">
        <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
          <Mail className="w-6 h-6 text-muted-foreground/30" />
        </div>
        <p className="text-sm font-medium text-muted-foreground/55">Select a message to read</p>
        <p className="text-xs text-muted-foreground/35 mt-1">Your email will appear here</p>
      </div>
    );
  }

  const senderInitials = (message.fromName ?? message.fromEmail)
    .split(' ')
    .map((w: string) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const formattedDate = (() => {
    try { return format(parseISO(message.receivedAt), 'EEE, MMM d yyyy · h:mm a'); }
    catch { return ''; }
  })();

  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'message',  label: 'Message' },
    ...(message.attachments.length > 0
      ? [{ id: 'attachments' as DetailTab, label: `Attachments (${message.attachments.length})` }]
      : []),
  ];

  return (
    <div className="flex flex-col h-full bg-background">

      {/* ── Navigation header ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border/35 shrink-0">
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Back"
            className="p-1.5 rounded-md text-muted-foreground/55 hover:text-foreground hover:bg-muted transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}

        {/* Subject as breadcrumb */}
        <h2 className="flex-1 min-w-0 px-1.5 text-[13px] font-semibold text-foreground truncate">
          {message.subject ?? '(no subject)'}
        </h2>

        {/* Primary action group — archive / delete / print / snooze */}
        <div className="flex items-center gap-0.5 shrink-0">
          {archiveFolder && onMoveToFolder && (
            <ActionBtn icon={Archive} label="Archive" onClick={handleArchive} />
          )}
          <ActionBtn icon={Trash2}    label="Delete" onClick={onDelete} danger />
          <ActionBtn icon={Printer}   label="Print"  onClick={handlePrint} />
          {onSnooze && (
            <ActionBtn icon={AlarmClock} label="Snooze" onClick={onSnooze} />
          )}

          <span className="mx-1 h-4 w-px bg-border/60" aria-hidden />

          {/* Reply group */}
          <ActionBtn icon={Reply}     label="Reply"     onClick={onReply} />
          <ActionBtn icon={ReplyAll}  label="Reply All" onClick={onReplyAll} />
          <ActionBtn icon={Forward}   label="Forward"   onClick={onForward} />

          <span className="mx-1 h-4 w-px bg-border/60" aria-hidden />

          {/* Secondary group */}
          <ActionBtn
            icon={Star}
            label={message.isStarred ? 'Unstar' : 'Star'}
            onClick={onToggleStar}
            highlight={message.isStarred}
          />
          {onMoveToInbox && (
            <ActionBtn icon={Inbox} label="Move to Inbox" onClick={onMoveToInbox} />
          )}
          {labelFolders.length > 0 && onMoveToFolder && (
            <div ref={folderDropdownRef} className="relative">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setFolderDropdownOpen((v) => !v)}
                    className="p-1.5 rounded-md transition-colors text-muted-foreground/45 hover:text-foreground hover:bg-muted"
                  >
                    <Tag className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">Move to folder</TooltipContent>
              </Tooltip>
              {folderDropdownOpen && (
                <div className="absolute right-0 top-full mt-1 bg-card border border-border/50 rounded-xl shadow-lg p-1.5 min-w-[160px] z-50">
                  {labelFolders.map((folder) => (
                    <button
                      key={folder.id}
                      onClick={() => { setFolderDropdownOpen(false); onMoveToFolder(folder.id); }}
                      className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] rounded-md text-foreground/80 hover:bg-muted hover:text-foreground transition-colors"
                    >
                      <FolderOpen className="w-3.5 h-3.5 shrink-0 text-muted-foreground/50" />
                      {folder.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {onMute && (
            <ActionBtn
              icon={isMuted ? Bell : BellOff}
              label={isMuted ? 'Unmute conversation' : 'Mute conversation'}
              onClick={onMute}
            />
          )}
        </div>
      </div>

      {/* ── Tab bar ───────────────────────────────────────────────────────── */}
      <div className="flex items-end gap-0 px-4 border-b border-border/25 shrink-0 bg-background">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'px-4 py-2.5 text-[13px] font-medium transition-all border-b-2 -mb-px',
              activeTab === tab.id
                ? 'text-primary border-primary'
                : 'text-muted-foreground/55 border-transparent hover:text-foreground hover:border-border/50',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">

        {/* Overview tab */}
        {activeTab === 'overview' && (
          <div className="p-6 space-y-5">

            {/* Subject title + sender subtitle — outside the card */}
            <div>
              <h1 className="text-[20px] font-semibold text-foreground leading-snug mb-1.5">
                {message.subject ?? '(no subject)'}
              </h1>
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-[13px] text-muted-foreground/65">
                  {message.fromName ?? message.fromEmail}
                </p>
                {classification && <ClassificationChip value={classification.label} size="sm" withIcon />}
              </div>
            </div>

            {/* Detail card */}
            <div className="bg-card border border-border/40 rounded-2xl overflow-hidden">

              {/* Sender strip */}
              <div className="flex items-center gap-3 px-5 py-4 border-b border-border/25">
                <MailAvatar
                  name={message.fromName}
                  email={message.fromEmail}
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-foreground leading-none mb-0.5">
                    {message.fromName ?? message.fromEmail}
                  </p>
                  <p className="text-[11px] text-muted-foreground/55">{formattedDate}</p>
                </div>
                <div className="flex items-center gap-0.5 shrink-0">
                  <ActionBtn icon={MoreHorizontal} label="More" />
                </div>
              </div>

              {/* Metadata rows */}
              <div className="px-5 py-3">
                <MetaRow icon={User} label="From">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>{message.fromName ?? message.fromEmail}</span>
                    {message.fromName && (
                      <span className="text-[11px] text-muted-foreground/40">
                        &lt;{message.fromEmail}&gt;
                      </span>
                    )}
                  </div>
                </MetaRow>

                {message.toRecipients.length > 0 && (
                  <MetaRow icon={User} label="To">
                    <span>{message.toRecipients.map((r) => r.name ?? r.email).join(', ')}</span>
                  </MetaRow>
                )}

                {message.ccRecipients.length > 0 && (
                  <MetaRow icon={User} label="Cc">
                    <span>{message.ccRecipients.map((r) => r.name ?? r.email).join(', ')}</span>
                  </MetaRow>
                )}

                <MetaRow icon={Calendar} label="Date">
                  <span>{formattedDate}</span>
                </MetaRow>

                <MetaRow icon={Tag} label="Status">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={cn(
                      'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium',
                      message.isRead
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-primary/10 text-primary',
                    )}>
                      {message.isRead ? 'Read' : 'Unread'}
                    </span>
                    {message.isStarred && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-400/15 text-amber-600">
                        Starred
                      </span>
                    )}
                    {message.hasAttachments && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-muted text-muted-foreground">
                        <Paperclip className="w-2.5 h-2.5" /> Attachments
                      </span>
                    )}
                    {classification && <ClassificationChip value={classification.label} size="xs" />}
                  </div>
                </MetaRow>
              </div>

              {/* Description section */}
              {(message.bodyText || message.bodyHtml) && (
                <div className="px-5 pt-4 pb-5 border-t border-border/25">
                  <h4 className="text-[14px] font-semibold text-foreground mb-3">Description</h4>
                  <p className="text-[13px] text-foreground/65 leading-relaxed">
                    {message.bodyText?.trim().slice(0, 600) ?? 'View the full message in the Message tab.'}
                  </p>
                  <button
                    onClick={() => setActiveTab('message')}
                    className="mt-4 text-[12px] text-muted-foreground/50 hover:text-foreground font-medium transition-colors"
                  >
                    Read full message →
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Message tab */}
        {activeTab === 'message' && (
          <div className="flex flex-col h-full">
            {/* Sender strip */}
            <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-border/25 shrink-0">
              <MailAvatar name={message.fromName} email={message.fromEmail} size="md" />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold text-foreground">
                    {message.fromName ?? message.fromEmail}
                  </span>
                  {message.fromName && (
                    <span className="text-[11px] text-muted-foreground/55">
                      &lt;{message.fromEmail}&gt;
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground/55 mt-0.5">{formattedDate}</p>
              </div>
              {classification && <ClassificationChip value={classification.label} size="sm" withIcon />}
            </div>

            {/* Body — sandboxed in iframe to isolate email styles.
                key forces a full remount when the active message changes so the
                height state resets instantly (prevents stale tall/short iframe). */}
            <EmailBody
              key={message.id}
              html={message.bodyHtml}
              text={message.bodyText}
            />

            {/* Inline attachments bar — shown below the email body so the user
                can see which files are attached without switching tabs. */}
            {message.attachments.length > 0 && (
              <div className="px-6 py-4 border-t border-border/20 shrink-0">
                <div className="flex items-center gap-1.5 mb-3">
                  <Paperclip className="w-3.5 h-3.5 text-muted-foreground/55" />
                  <span className="text-[12px] font-semibold text-foreground/85">
                    Attachments
                  </span>
                  <span className="text-[11px] text-muted-foreground/55">
                    ({message.attachments.length})
                  </span>
                </div>
                <div className="flex items-start gap-3 flex-wrap">
                  {message.attachments.map((att) => {
                    const isPreviewable =
                      att.mimeType.startsWith('image/') ||
                      att.mimeType === 'application/pdf' ||
                      att.mimeType.startsWith('text/') ||
                      att.filename.toLowerCase().endsWith('.pdf');
                    return (
                      <AttachmentTile
                        key={att.id}
                        attachment={att}
                        onClick={() => {
                          if (isPreviewable) {
                            setLightboxSelectedId(att.id);
                            setLightboxOpen(true);
                          } else {
                            handleDownload(att);
                          }
                        }}
                        onPreview={isPreviewable ? () => { setLightboxSelectedId(att.id); setLightboxOpen(true); } : undefined}
                        onDownload={() => handleDownload(att)}
                        downloading={downloadingId === att.id}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {/* Quick reply bar */}
            <QuickReplyBar
              message={message}
              onSent={() => {}}
              onExpand={() => onReply?.()}
            />
          </div>
        )}

        {/* Attachments tab */}
        {activeTab === 'attachments' && (
          <div className="p-5">
            <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-wider mb-4">
              {message.attachments.length} attachment{message.attachments.length !== 1 ? 's' : ''}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {message.attachments.map((att) => {
                const isPreviewable =
                  att.mimeType.startsWith('image/') ||
                  att.mimeType === 'application/pdf' ||
                  att.mimeType.startsWith('text/') ||
                  att.filename.toLowerCase().endsWith('.pdf');
                const style = fileTypeStyle(att);
                return (
                  <div
                    key={att.id}
                    className="flex items-center gap-2.5 p-3 bg-card border border-border/45 rounded-xl group hover:bg-muted/30 transition-colors"
                  >
                    <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center shrink-0', style.bgTint)}>
                      <span className={cn('text-[10px] font-bold tracking-wide', style.color)}>
                        {style.label}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-foreground truncate">{att.filename}</p>
                      <p className="text-[11px] text-muted-foreground/55">{formatBytes(att.size)}</p>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {isPreviewable && (
                        <button
                          onClick={() => { setLightboxSelectedId(att.id); setLightboxOpen(true); }}
                          disabled={!!downloadingId}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-muted-foreground/45 hover:text-foreground disabled:opacity-30"
                          title="Open lightbox"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => handleDownload(att)}
                        disabled={!!downloadingId}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/45 hover:text-foreground disabled:opacity-30 p-1 rounded"
                        title="Download"
                      >
                        {downloadingId === att.id
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Download className="w-3.5 h-3.5" />
                        }
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

          </div>
        )}
      </div>

      {/* Reply bar */}
      <div className="px-4 py-2.5 border-t border-border/35 shrink-0 flex items-center gap-2">
        <button
          onClick={onReply}
          className="flex-1 text-left px-4 py-2 bg-muted/40 hover:bg-muted border border-border/40 rounded-xl text-[13px] text-muted-foreground/50 hover:text-muted-foreground transition-all"
        >
          <span className="flex items-center gap-2">
            <Reply className="w-3.5 h-3.5 shrink-0" />
            Reply to {message.fromName ?? message.fromEmail}…
          </span>
        </button>
        <button
          onClick={onReplyAll}
          className="p-2 bg-muted/40 hover:bg-muted border border-border/40 rounded-xl text-muted-foreground/45 hover:text-muted-foreground transition-all"
          title="Reply All"
        >
          <ReplyAll className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onForward}
          className="p-2 bg-muted/40 hover:bg-muted border border-border/40 rounded-xl text-muted-foreground/45 hover:text-muted-foreground transition-all"
          title="Forward"
        >
          <Forward className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Attachment lightbox */}
      {lightboxOpen && lightboxSelectedId && message.attachments.length > 0 && (
        <AttachmentLightbox
          open={lightboxOpen}
          attachments={message.attachments}
          selectedId={lightboxSelectedId}
          messageId={message.id}
          onClose={() => { setLightboxOpen(false); setLightboxSelectedId(null); }}
        />
      )}
    </div>
  );
}
