'use client';

import { format, parseISO } from 'date-fns';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Reply, ReplyAll, Forward, Trash2, Archive, Star, Inbox, Tag, FolderOpen,
  Paperclip, Download, Loader2, MoreHorizontal,
  ChevronLeft, ChevronRight, X, Mail, User, Calendar,
  Eye, File, FileText, Image as ImageIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { toast } from 'sonner';

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

  const body = extractBodyContent(html);
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
function TextPreview({ url }: { url: string }) {
  const [content, setContent] = useState('');
  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then(setContent)
      .catch(() => setContent('(Could not load text content)'));
  }, [url]);
  return (
    <pre className="w-full max-h-[400px] overflow-auto text-[13px] text-foreground/80 bg-muted/30 rounded-lg p-4 whitespace-pre-wrap break-words font-mono">
      {content || 'Loading…'}
    </pre>
  );
}

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
}: MailDetailProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>('message');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false);
  const folderDropdownRef = useRef<HTMLDivElement>(null);
  const [previewState, setPreviewState] = useState<{
    id: string;
    url: string;
    mimeType: string;
    filename: string;
  } | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

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

  // Clear preview when navigating to a different message
  useEffect(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewState(null);
    setPreviewLoadingId(null);
  }, [message?.id]);

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

  const handlePreview = useCallback(async (att: { id: string; filename: string; mimeType: string }) => {
    if (!message || previewLoadingId) return;
    // Toggle off if this attachment is already open in the preview
    if (previewState?.id === att.id) {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
      setPreviewState(null);
      return;
    }
    setPreviewLoadingId(att.id);
    try {
      const url = await api.mail.downloadAttachment(message.id, att.id);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      setPreviewState({ id: att.id, url, mimeType: att.mimeType, filename: att.filename });
    } catch (err: any) {
      toast.error('Preview failed', { description: err?.message });
    } finally {
      setPreviewLoadingId(null);
    }
  }, [message, previewLoadingId, previewState?.id]);

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
            className="p-1.5 rounded-md text-muted-foreground/45 hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}

        <button disabled className="p-1.5 rounded-md text-muted-foreground/25 cursor-default">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <button disabled className="p-1.5 rounded-md text-muted-foreground/25 cursor-default">
          <ChevronRight className="w-3.5 h-3.5" />
        </button>

        {/* Subject as breadcrumb */}
        <h2 className="flex-1 min-w-0 px-1.5 text-[13px] font-semibold text-foreground truncate">
          {message.subject ?? '(no subject)'}
        </h2>

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          <ActionBtn
            icon={Star}
            label={message.isStarred ? 'Unstar' : 'Star'}
            onClick={onToggleStar}
            highlight={message.isStarred}
          />
          <ActionBtn icon={Reply}          label="Reply"     onClick={onReply} />
          <ActionBtn icon={ReplyAll}       label="Reply All" onClick={onReplyAll} />
          <ActionBtn icon={Forward}        label="Forward"   onClick={onForward} />
          {onMoveToInbox && (
            <ActionBtn icon={Inbox} label="Move to Inbox" onClick={onMoveToInbox} />
          )}
          {/* Move to label folder dropdown */}
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
          <ActionBtn icon={MoreHorizontal} label="More" />
          <ActionBtn icon={Trash2}         label="Delete"    onClick={onDelete} danger />
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
              <p className="text-[13px] text-muted-foreground/55">
                {message.fromName ?? message.fromEmail}
              </p>
            </div>

            {/* Detail card */}
            <div className="bg-card border border-border/40 rounded-xl overflow-hidden">

              {/* Sender strip */}
              <div className="flex items-center gap-3 px-5 py-4 border-b border-border/25">
                <Avatar className="w-8 h-8 shrink-0">
                  <AvatarFallback className="text-[12px] font-semibold bg-primary/10 text-primary">
                    {senderInitials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-foreground leading-none mb-0.5">
                    {message.fromName ?? message.fromEmail}
                  </p>
                  <p className="text-[11px] text-muted-foreground/45">{formattedDate}</p>
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
                        : 'bg-blue-500/10 text-blue-600',
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
              <Avatar className="w-9 h-9 shrink-0">
                <AvatarFallback className="text-sm font-semibold bg-primary/15 text-primary">
                  {senderInitials}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold text-foreground">
                    {message.fromName ?? message.fromEmail}
                  </span>
                  {message.fromName && (
                    <span className="text-[11px] text-muted-foreground/45">
                      &lt;{message.fromEmail}&gt;
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground/45 mt-0.5">{formattedDate}</p>
              </div>
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
              <div className="px-6 py-2.5 border-t border-border/20 bg-muted/20 shrink-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-muted-foreground/40 uppercase tracking-wider mr-1 shrink-0">
                    <Paperclip className="w-3 h-3" />
                    {message.attachments.length}
                  </span>
                  {message.attachments.map((att) => {
                    const FileIcon = att.mimeType.startsWith('image/') ? ImageIcon
                      : (att.mimeType === 'application/pdf' || att.filename.toLowerCase().endsWith('.pdf')) ? FileText
                      : File;
                    return (
                      <button
                        key={att.id}
                        onClick={() => setActiveTab('attachments')}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-card border border-border/40 text-[11px] text-foreground/65 hover:bg-muted hover:text-foreground transition-colors max-w-[160px]"
                        title={`${att.filename} — view in Attachments tab`}
                      >
                        <FileIcon className="w-3 h-3 shrink-0 text-muted-foreground/50" />
                        <span className="truncate">{att.filename}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
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
                const FileIcon = att.mimeType.startsWith('image/') ? ImageIcon
                  : (att.mimeType === 'application/pdf' || att.filename.toLowerCase().endsWith('.pdf')) ? FileText
                  : File;
                const isActive = previewState?.id === att.id;
                return (
                  <div
                    key={att.id}
                    className={cn(
                      'flex items-center gap-2.5 p-3 bg-card border rounded-xl group hover:bg-muted/30 transition-colors',
                      isActive ? 'border-primary/30 bg-primary/5' : 'border-border/45',
                    )}
                  >
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <FileIcon className="w-4 h-4 text-primary/60" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-foreground truncate">{att.filename}</p>
                      <p className="text-[11px] text-muted-foreground/45">{formatBytes(att.size)}</p>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {isPreviewable && (
                        <button
                          onClick={() => handlePreview(att)}
                          disabled={!!previewLoadingId || !!downloadingId}
                          className={cn(
                            'opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded disabled:opacity-30',
                            isActive
                              ? 'text-primary opacity-100'
                              : 'text-muted-foreground/45 hover:text-foreground',
                          )}
                          title={isActive ? 'Close preview' : 'Preview'}
                        >
                          {previewLoadingId === att.id
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Eye className="w-3.5 h-3.5" />
                          }
                        </button>
                      )}
                      <button
                        onClick={() => handleDownload(att)}
                        disabled={!!downloadingId || !!previewLoadingId}
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

            {/* Inline preview panel */}
            {previewState && (
              <div className="mt-4 border border-border/40 rounded-xl overflow-hidden bg-card">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30 bg-muted/20">
                  <span className="text-[12px] font-medium text-foreground/70 truncate flex-1 mr-3">
                    {previewState.filename}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleDownload({ id: previewState.id, filename: previewState.filename })}
                      className="p-1 rounded text-muted-foreground/45 hover:text-foreground transition-colors"
                      title="Download"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
                        previewUrlRef.current = null;
                        setPreviewState(null);
                      }}
                      className="p-1 rounded text-muted-foreground/45 hover:text-foreground transition-colors"
                      title="Close preview"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="p-4 bg-muted/10">
                  {previewState.mimeType.startsWith('image/') ? (
                    /* Images — plain <img>, works in all browsers */
                    <img
                      src={previewState.url}
                      alt={previewState.filename}
                      className="max-w-full h-auto rounded-lg block mx-auto shadow-sm"
                      style={{ maxHeight: 520 }}
                    />
                  ) : previewState.mimeType.startsWith('text/') ? (
                    /* Text — fetched and rendered as <pre>; no iframe needed */
                    <TextPreview url={previewState.url} />
                  ) : (
                    /* PDFs & other binary types — <embed> avoids the iframe+blob
                       block that Dia (and similar browsers) impose on sandboxed
                       iframes loading blob: URLs. */
                    <embed
                      src={previewState.url}
                      type={previewState.mimeType}
                      className="w-full rounded-lg border-0"
                      style={{ height: 600 }}
                    />
                  )}
                </div>
              </div>
            )}
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
    </div>
  );
}
