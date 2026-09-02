'use client';

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import Link from '@tiptap/extension-link';
import { Extension } from '@tiptap/core';
import TiptapImage from '@tiptap/extension-image';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import {
  X, Send, Loader2, ChevronDown, ChevronUp, Minus,
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, List, ListOrdered, Link2, Paperclip,
  Clock, FileText, Calendar, Files, Sparkles,
} from 'lucide-react';
import { api, type Doc } from '@/lib/api';
import { sanitizeEmailHtml } from '@/lib/sanitize';
import { generateDocPdfBlob } from '@/lib/docExport';
import { EmailChipInput } from './EmailChipInput';
import { DocPickerDialog, type DocAttachMode } from './DocPickerDialog';
import { useAuthStore } from '@/stores/auth.store';
import { useAIStore } from '@/stores/ai.store';
import { AIClient } from '@/lib/ai/client';
import {
  rewriteText,
  type RewriteMode,
  htmlToPlainText,
  suggestReply,
  type ReplyIntent,
  type ReplyLength,
} from '@/lib/ai/tasks';
import { detectInjectionAttempt } from '@/lib/ai/prompt';
import { useCharStream } from '@/lib/ai/useCharStream';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// ── Custom FontSize extension (registers fontSize attr on TextStyle) ──────────

const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() {
    return { types: ['textStyle'] as string[] };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.fontSize || null,
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.fontSize ? { style: `font-size: ${attrs.fontSize}` } : {},
          },
        },
      },
    ];
  },
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

export interface ComposeMessage {
  id: string;
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  toRecipients: Array<{ email: string; name?: string }>;
  ccRecipients: Array<{ email: string; name?: string }>;
  bccRecipients?: Array<{ email: string; name?: string }>;
  bodyHtml: string | null;
  bodyText: string | null;
  /** Present on lightweight thread metas, which carry no body at all. */
  snippet?: string | null;
  receivedAt: string;
  attachments?: Array<{ id: string; filename: string; mimeType: string; size: number }>;
}

interface ComposeModalProps {
  open: boolean;
  mode: ComposeMode;
  originalMessage?: ComposeMessage | null;
  onClose: () => void;
  onSent?: () => void;
  /** Pre-existing draft's Zimbra ID — set when the user opens a draft for editing */
  initialDraftZimbraId?: string;
  initialTo?: string[];
  initialCc?: string[];
  initialBcc?: string[];
  initialSubject?: string;
  initialBody?: string;
  /** When true and originalMessage is present, automatically run Suggest Reply
   *  once the modal opens. Used by the thread toolbar's Quick Reply action. */
  autoSuggestReply?: boolean;
}

// ── Email chip input ──────────────────────────────────────────────────────────
// Defined in EmailChipInput.tsx — imported below with other components.

// ── Toolbar button ────────────────────────────────────────────────────────────

function ToolbarBtn({ title, onClick, active, children }: {
  title: string; onClick: () => void; active?: boolean; children: React.ReactNode;
}) {
  return (
    <button type="button" title={title} onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className={cn(
        'p-1.5 rounded text-muted-foreground/55 hover:text-foreground hover:bg-muted/60 transition-colors',
        active && 'bg-muted/60 text-foreground',
      )}>
      {children}
    </button>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip outer <html>/<head>/<body> wrapper tags from an email body string.
 *
 * When inserting quoted HTML inside a <blockquote>, any <html>/<body> tags
 * inside the blockquote are invalid and confuse the browser's HTML parser.
 * More critically, the extractBodyContent() function used by the email iframe
 * uses a greedy regex to find the <body> content; a nested <body> inside the
 * blockquote would be matched instead of the reply's own outer body, causing
 * the viewer to show the ORIGINAL message content rather than the reply.
 */
function stripHtmlDocWrapper(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) return bodyMatch[1];
  return html
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?(html|body)[^>]*>/gi, '')
    .trim();
}

function buildHtmlBody(userHtml: string, mode: ComposeMode, original?: ComposeMessage | null): string {
  if (!original || mode === 'new') return userHtml;
  const dateStr = (() => { try { return format(parseISO(original.receivedAt), "EEE, MMM d, yyyy 'at' h:mm a"); } catch { return ''; } })();
  const fromStr = original.fromName ? `${original.fromName} &lt;${original.fromEmail}&gt;` : original.fromEmail;
  let header = '';
  if (mode === 'forward') {
    const toStr = original.toRecipients.map((r) => (r.name ? `${r.name} &lt;${r.email}&gt;` : r.email)).join(', ');
    header = `<br/><br/><div style="border-top:1px solid #555;padding-top:8px;color:#999;font-size:13px;"><b>---------- Forwarded message ---------</b><br/><b>From:</b> ${fromStr}<br/><b>Date:</b> ${dateStr}<br/><b>Subject:</b> ${original.subject ?? '(no subject)'}<br/><b>To:</b> ${toStr}</div>`;
  } else {
    header = `<br/><br/><div style="color:#999;font-size:13px;">On ${dateStr}, ${fromStr} wrote:</div>`;
  }
  // Strip document-level wrapper tags from the original body so that nesting
  // it inside a <blockquote> produces valid HTML and does not confuse the
  // greedy extractBodyContent() regex when the reply is later rendered.
  // Strip data: URI images from the quoted content before sending.
  // The original message's inline images (signatures, etc.) are already stored
  // in Zimbra — embedding them as base64 in the reply body would create a
  // massive payload and they don't need to be re-uploaded.
  const rawQuote = original.bodyHtml
    ? stripHtmlDocWrapper(original.bodyHtml)
    : (original.bodyText ? `<pre style="font-family:inherit;white-space:pre-wrap;margin:0">${original.bodyText}</pre>` : '');
  // Strip nested blockquotes (previous thread history) — only preserve the direct
  // parent's new content. Nested <blockquote> elements are the older parts of the
  // thread chain; including them causes exponential HTML growth across many replies.
  // This matches how Gmail/Outlook handle multi-level reply threads.
  const nestedBqStart = rawQuote.search(/<blockquote/i);
  const directParentContent = nestedBqStart !== -1 ? rawQuote.slice(0, nestedBqStart) : rawQuote;
  const quoteContent = directParentContent.replace(/src=["']data:[^"']*["']/gi, 'src=""');
  const quote = `<blockquote style="margin:4px 0 0 .8ex;border-left:2px solid #555;padding-left:1ex;color:#aaa;">${quoteContent}</blockquote>`;
  return `${userHtml}${header}${quote}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Find where the signature begins in the editor's document, if it does.
 *
 * The signature is inserted as `<div data-sig="1">…</div>` but TipTap's
 * default schema strips the wrapper, so we can't query by attribute. We
 * fall back to text-matching: look for the first ~60 chars of the
 * signature's plain text inside the doc, and clip the rewrite range to
 * the start of the block that contains it. Returns the doc position to
 * use as the upper bound, or null if no signature is detectable.
 */
function findSignatureBoundary(editor: Editor, signatureHtml: string): number | null {
  const sigPlain = htmlToPlainText(signatureHtml).trim();
  if (!sigPlain) return null;
  const firstLine = sigPlain.split(/\n+/).find((l) => l.trim().length >= 4);
  if (!firstLine) return null;
  const needle = firstLine.trim().slice(0, 60);

  let foundPos: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (foundPos != null) return false;
    if (node.isText && node.text && node.text.includes(needle)) {
      foundPos = pos + node.text.indexOf(needle);
      return false;
    }
    return true;
  });
  if (foundPos == null) return null;

  const $pos = editor.state.doc.resolve(foundPos);
  return $pos.before($pos.depth);
}

// ── Font options ──────────────────────────────────────────────────────────────

const FONT_FAMILIES = [
  { label: 'Default', value: '' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Calibri', value: 'Calibri, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: "'Times New Roman', serif" },
  { label: 'Monospace', value: "'Courier New', monospace" },
];

const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28];

// ── Main component ────────────────────────────────────────────────────────────

const TITLE: Record<ComposeMode, string> = { new: 'New Message', reply: 'Reply', replyAll: 'Reply All', forward: 'Forward' };

export default function ComposeModal({
  open, mode, originalMessage, onClose, onSent,
  initialDraftZimbraId, initialTo, initialCc, initialBcc, initialSubject, initialBody,
  autoSuggestReply,
}: ComposeModalProps) {
  const user = useAuthStore((s) => s.user);

  // ── Fetch settings (for default signature) ─────────────────────────────────
  // No `enabled` guard — component is always mounted, so we pre-fetch and cache
  // settings immediately; they're available the instant the user opens compose.
  const { data: settingsData } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.get(),
    staleTime: 5 * 60_000,
  });

  // Derive the correct signature HTML for the current compose mode.
  // Check both identity attrs AND prefs — Zimbra may store the ID in either.
  // Falls back to the first available signature when no default is configured or
  // when the configured default ID no longer matches any existing signature.
  // If a signature has no HTML content (text-only Zimbra signature), the plain
  // text is converted to simple HTML paragraphs so it still gets injected.
  const signatureHtml = useMemo(() => {
    const settings = settingsData as any;
    const sigs: any[] = settings?.signatures ?? [];
    if (!sigs.length) return '';

    const primaryIdentity = settings?.identities?.[0];
    const attrs = primaryIdentity?.attrs ?? {};
    const prefs = settings?.prefs ?? {};

    const id = (mode === 'new')
      ? (attrs.zimbraPrefDefaultSignatureId        || prefs.zimbraPrefDefaultSignatureId        || '')
      : (attrs.zimbraPrefForwardReplySignatureId   || prefs.zimbraPrefForwardReplySignatureId   || '');

    const resolveSig = (sig: any): string => {
      if (sig?.contentHtml) return sig.contentHtml;
      // Fallback: convert plain-text signature to HTML paragraphs
      if (sig?.contentText) {
        return sig.contentText
          .split('\n')
          .map((line: string) => `<p>${line || '<br>'}</p>`)
          .join('');
      }
      return '';
    };

    // If an explicit default is configured and found, use it
    if (id) {
      const found = sigs.find((s: any) => s.id === id);
      const html = resolveSig(found);
      if (html) return html;
      // Configured signature no longer exists — fall through to first available
    }
    // No default configured (or configured sig not found) — use first available signature
    return resolveSig(sigs[0]);
  }, [settingsData, mode]);

  const [minimised, setMinimised] = useState(false);
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [subject, setSubject] = useState('');
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Undo send ──────────────────────────────────────────────────────────────
  const undoCancelledRef = useRef(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Scheduled send ─────────────────────────────────────────────────────────
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleDateTime, setScheduleDateTime] = useState('');

  // ── Doc attach ────────────────────────────────────────────────────────────
  const [showDocPicker, setShowDocPicker] = useState(false);

  // ── Templates ─────────────────────────────────────────────────────────────
  const [showTemplates, setShowTemplates] = useState(false);
  const templatesRef = useRef<HTMLDivElement>(null);
  const { data: templates = [] } = useQuery({
    queryKey: ['mail-templates'],
    queryFn: () => api.mail.getTemplates(),
    staleTime: 5 * 60_000,
    enabled: open,
  });

  // Close templates dropdown on outside click
  useEffect(() => {
    if (!showTemplates) return;
    const handler = (e: MouseEvent) => {
      if (templatesRef.current && !templatesRef.current.contains(e.target as Node)) setShowTemplates(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTemplates]);

  // ── Rewrite (AI) ──────────────────────────────────────────────────────────
  const aiEnabled = useAIStore((s) => s.enabled);
  const aiModel = useAIStore((s) => s.model);
  const aiCustomInstructions = useAIStore((s) => s.customInstructions);
  const [showRewrite, setShowRewrite] = useState(false);
  const rewriteRef = useRef<HTMLDivElement>(null);
  const [rewriteOriginal, setRewriteOriginal] = useState<string>(''); // plain text snapshot
  const [rewriteRange, setRewriteRange] = useState<{ from: number; to: number } | null>(null);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteMode, setRewriteMode] = useState<RewriteMode>('paraphrase');
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const [aiAction, setAiAction] = useState<'rewrite' | 'suggest'>('rewrite');
  const [replyIntent, setReplyIntent] = useState<ReplyIntent>('auto');
  const [replyLength, setReplyLength] = useState<ReplyLength>('standard');
  // Set when the incoming email contains text addressed to the model rather
  // than to the reader. Prompt-level defenses do not hold on small local
  // models, so the reviewer is the control that does — say so plainly.
  const [injectionWarning, setInjectionWarning] = useState(false);
  const {
    text: rewriteText_,
    push: pushRewrite,
    reset: resetRewrite,
    replace: replaceRewrite,
  } = useCharStream();
  const rewriteAbortRef = useRef<AbortController | null>(null);

  // Thread rows hand compose a lightweight message meta (snippet only — no
  // body, often no subject), so replying from a thread toolbar or Quick Reply
  // used to feed the AI an essentially empty email. Fetch the full message
  // once per compose target and cache it for every AI prompt that needs it.
  const hydratedOriginalRef = useRef<{ id: string; message: ComposeMessage } | null>(null);
  const getOriginalWithBody = useCallback(async (): Promise<ComposeMessage | null> => {
    if (!originalMessage) return null;
    if (originalMessage.bodyText || originalMessage.bodyHtml) return originalMessage;
    if (hydratedOriginalRef.current?.id === originalMessage.id) {
      return hydratedOriginalRef.current.message;
    }
    try {
      const full = await api.mail.getMessage(originalMessage.id);
      hydratedOriginalRef.current = { id: originalMessage.id, message: full };
      return full;
    } catch {
      // A snippet beats nothing — callers fall back to whatever is present.
      return originalMessage;
    }
  }, [originalMessage]);

  /** Subject + sender + full body of the message being replied to, for AI prompts. */
  const buildIncomingEmail = useCallback(async (): Promise<{ text: string; body: string } | null> => {
    const source = await getOriginalWithBody();
    if (!source) return null;
    const fromLabel = source.fromName
      ? `${source.fromName} <${source.fromEmail}>`
      : source.fromEmail;
    const body = htmlToPlainText(source.bodyText ?? source.bodyHtml ?? source.snippet ?? '');
    if (!body) return null;
    const subj = source.subject ?? originalMessage?.subject;
    return {
      text: `${subj ? `Subject: ${subj}\n` : ''}From: ${fromLabel}\n\n${body}`,
      body,
    };
  }, [getOriginalWithBody, originalMessage]);

  useEffect(() => {
    if (!showRewrite) return;
    const handler = (e: MouseEvent) => {
      if (rewriteRef.current && !rewriteRef.current.contains(e.target as Node)) setShowRewrite(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showRewrite]);

  // ── Attachments ────────────────────────────────────────────────────────────
  const [attachments, setAttachments] = useState<File[]>([]);
  // Attachments from the original message carried forward (forward mode only).
  // Stored as { id (part), filename, mimeType, size } referencing the original msg.
  const [forwardedAttachments, setForwardedAttachments] = useState<Array<{ id: string; filename: string; mimeType: string; size: number }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);

  // ── Signature injection state ─────────────────────────────────────────────
  const sigInserted = useRef(false);

  // ── Draft auto-save state ─────────────────────────────────────────────────
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const draftStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref so handleSend can be called from the TipTap keydown handler without stale closure
  const handleSendRef = useRef<() => void>(() => {});

  // ── TipTap editor ─────────────────────────────────────────────────────────
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      // Extend Image to preserve the data-zimbra-src attribute that
      // processSignatureImages (backend) attaches alongside the base64 data URI.
      // Without this, TipTap drops the attribute and we lose the original
      // Zimbra Briefcase path, making it impossible to restore it before sending.
      TiptapImage.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            'data-zimbra-src': {
              default: null,
              parseHTML: (el) => el.getAttribute('data-zimbra-src'),
              renderHTML: (attrs) =>
                attrs['data-zimbra-src']
                  ? { 'data-zimbra-src': attrs['data-zimbra-src'] }
                  : {},
            },
          };
        },
      }).configure({ inline: true, allowBase64: true }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { class: 'text-primary underline' } }),
    ],
    content: '',
    editorProps: {
      attributes: {
        class: [
          'min-h-[140px] outline-none text-sm text-foreground/90 leading-relaxed',
          '[&_a]:text-primary [&_a]:underline',
          '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
          '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground/60',
        ].join(' '),
        spellcheck: 'true',
      },
      handleKeyDown(_view, event) {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          handleSendRef.current();
          return true;
        }
        return false;
      },
    },
  });

  // ── Pre-populate fields when modal opens ──────────────────────────────────
  // Signature injection is intentionally NOT done here — the editor is null
  // in this closure because TipTap uses immediatelyRender:false (async init).
  // Injection is handled by the dedicated effect below.
  useEffect(() => {
    if (!open) {
      sigInserted.current = false;
      return;
    }
    setError(null);
    setSending(false);
    setAttachments([]);
    setForwardedAttachments([]);
    setSavedDraftId(initialDraftZimbraId ?? null);
    setDraftStatus('idle');
    setMinimised(false);
    setReplyIntent('auto');
    setReplyLength('standard');
    sigInserted.current = false; // reset so injection fires fresh on this open

    if (mode === 'new' || !originalMessage) {
      if (initialTo || initialDraftZimbraId) {
        setTo(initialTo ?? []);
        setCc(initialCc ?? []);
        setBcc(initialBcc ?? []);
        setSubject(initialSubject ?? '');
        setShowCcBcc((initialCc?.length ?? 0) > 0 || (initialBcc?.length ?? 0) > 0);
        editor?.commands.setContent(initialBody || '<p></p>');
        return;
      }
      setTo([]); setCc([]); setBcc([]);
      setSubject('');
      setShowCcBcc(false);
      editor?.commands.setContent('<p></p>');
      setTimeout(() => editor?.commands.focus(), 50);
      return;
    }

    const origSubject = originalMessage.subject ?? '(no subject)';
    const norm = (e: string) => e.trim().toLowerCase();
    const selfEmail = norm(user?.email ?? '');
    const origTo = (originalMessage.toRecipients ?? []).map((r) => r.email).filter(Boolean);
    const origCc = (originalMessage.ccRecipients ?? []).map((r) => r.email).filter(Boolean);
    const origBcc = (originalMessage.bccRecipients ?? []).map((r) => r.email).filter(Boolean);
    // The user is replying to their own sent message — treat original To as the reply target.
    const isOwnMessage = !!selfEmail && norm(originalMessage.fromEmail) === selfEmail;

    // Dedupe preserving first occurrence; everything compared case-insensitively.
    const dedupe = (list: string[]) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const e of list) {
        const k = norm(e);
        if (k && !seen.has(k)) { seen.add(k); out.push(e); }
      }
      return out;
    };
    const excludeSelf = (list: string[]) => list.filter((e) => norm(e) !== selfEmail);

    if (mode === 'reply') {
      const toList = isOwnMessage ? dedupe(excludeSelf(origTo)) : [originalMessage.fromEmail];
      setTo(toList); setCc([]); setBcc([]);
      setSubject(origSubject.match(/^Re:/i) ? origSubject : `Re: ${origSubject}`);
      setShowCcBcc(false);
    } else if (mode === 'replyAll') {
      const toSeed = isOwnMessage
        ? excludeSelf(origTo)
        : [originalMessage.fromEmail, ...excludeSelf(origTo)];
      const toList = dedupe(toSeed);
      const toSet = new Set(toList.map(norm));
      const ccList = dedupe(excludeSelf(origCc)).filter((e) => !toSet.has(norm(e)));
      // Include Bcc only when replying to our own sent message (where we have the Bcc list).
      const bccList = isOwnMessage
        ? dedupe(excludeSelf(origBcc)).filter((e) => !toSet.has(norm(e)) && !ccList.some((c) => norm(c) === norm(e)))
        : [];
      setTo(toList); setCc(ccList); setBcc(bccList);
      setShowCcBcc(ccList.length > 0 || bccList.length > 0);
      setSubject(origSubject.match(/^Re:/i) ? origSubject : `Re: ${origSubject}`);
    } else if (mode === 'forward') {
      // Forward should not carry over any recipients — forwarding to someone new
      // with the original Cc/Bcc would leak addresses from the prior thread.
      setTo([]); setCc([]); setBcc([]);
      setShowCcBcc(false);
      setSubject(origSubject.match(/^Fwd:/i) ? origSubject : `Fwd: ${origSubject}`);
      setForwardedAttachments(originalMessage.attachments ?? []);
    }

    editor?.commands.setContent('<p></p>');
    if (mode !== 'forward') {
      setTimeout(() => editor?.commands.focus(), 50);
    }
  }, [open, mode, originalMessage, user?.email]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Signature injection ────────────────────────────────────────────────────
  // `editor` is in the dep array so this effect re-runs automatically when
  // TipTap finishes async initialisation (null → instance). Combined with
  // `open` and `signatureHtml`, all three async paths are covered:
  //   • editor null → instance  (TipTap useLayoutEffect completes)
  //   • open false  → true      (modal opens, editor already ready)
  //   • signatureHtml '' → html (settings fetch resolves after open)
  // The pre-populate effect above is declared first so React always runs it
  // before this one, guaranteeing sigInserted is reset before we try to inject.
  useEffect(() => {
    if (!editor || !open || sigInserted.current || initialDraftZimbraId || !signatureHtml) return;
    sigInserted.current = true;
    const sigNode = `<div data-sig="1">${signatureHtml}</div>`;
    if (editor.getText().trim().length === 0) {
      // Editor is still empty — set the canonical initial content with signature below.
      editor.commands.setContent(`<p></p>${sigNode}`);
      editor.commands.focus('start');
    } else {
      // Settings resolved AFTER the user started typing — append the signature at
      // the very bottom so it doesn't interrupt in-progress text.
      editor.chain()
        .insertContentAt(editor.state.doc.content.size, sigNode)
        .focus('start')
        .run();
    }
  }, [editor, open, signatureHtml, initialDraftZimbraId]);

  // ── Explicit save draft ───────────────────────────────────────────────────
  // Autosave was removed by product decision: users save drafts explicitly via
  // the "Save draft" button. Closing the modal does NOT persist a draft — this
  // prevents clutter in the Drafts folder from stray composes.
  const handleSaveDraft = async () => {
    const currentBody = editor?.getHTML() ?? '';
    const hasContent = to.length > 0 || cc.length > 0 || bcc.length > 0 || subject.trim().length > 0 || (currentBody && currentBody !== '<p></p>');
    if (!hasContent) { toast.info('Nothing to save'); return; }
    setDraftStatus('saving');
    try {
      const result = await api.mail.saveDraft({
        to, cc, bcc, subject,
        body: currentBody,
        draftId: savedDraftId ?? undefined,
      });
      setSavedDraftId(result.zimbraId);
      setDraftStatus('saved');
      if (draftStatusTimerRef.current) clearTimeout(draftStatusTimerRef.current);
      draftStatusTimerRef.current = setTimeout(() => setDraftStatus('idle'), 3000);
      toast.success('Draft saved');
    } catch (err: any) {
      setDraftStatus('idle');
      toast.error('Failed to save draft', { description: err?.message });
    }
  };

  // ── Attach doc from Docs module ────────────────────────────────────────────
  // Two modes: "pdf" generates a server-side PDF and adds it to attachments;
  // "link" enables sharing on the doc (if needed) and inserts a share-link
  // anchor at the current editor selection.
  const handleDocAttach = async (doc: Doc, mode: DocAttachMode) => {
    try {
      if (mode === 'pdf') {
        // List endpoint omits `content` for perf — fetch the full doc first.
        const full = await api.docs.getOne(doc.id);
        const blob = await generateDocPdfBlob(full.title || 'Untitled', full.content);
        const safeTitle = (full.title || 'Untitled').replace(/[^a-z0-9 _-]/gi, '_');
        const file = new File([blob], `${safeTitle}.pdf`, { type: 'application/pdf' });
        setAttachments((prev) => [...prev, file]);
        toast.success('Document attached as PDF');
      } else {
        let shareToken = doc.shareToken;
        if (!shareToken) {
          const res = await api.docs.share.enable(doc.id);
          shareToken = res.shareToken;
        }
        const url = `${window.location.origin}/docs/share/${shareToken}`;
        const label = `${doc.emoji ? doc.emoji + ' ' : ''}${doc.title || 'Untitled'}`;
        editor?.chain().focus().insertContent({
          type: 'paragraph',
          content: [{ type: 'text', text: label, marks: [{ type: 'link', attrs: { href: url } }] }],
        }).run();
        toast.success('Share link inserted');
      }
    } catch (err: any) {
      toast.error('Failed to attach document', { description: err?.message });
    } finally {
      setShowDocPicker(false);
    }
  };

  // ── Discard ────────────────────────────────────────────────────────────────
  const handleDiscard = async () => {
    if (savedDraftId) api.mail.discardDraft(savedDraftId).catch(() => {});
    setSavedDraftId(null); setDraftStatus('idle');
    onClose();
  };

  // ── Rewrite handlers ──────────────────────────────────────────────────────
  const handleRewrite = useCallback(
    async (mode: RewriteMode) => {
      if (!editor) return;
      setShowRewrite(false);

      // If the user has selected text, operate on the selection. Otherwise
      // grab the entire body — but exclude the signature so the rewrite
      // doesn't clobber it. We snapshot the range so Replace knows where
      // to put the rewritten output, even if the user clicks elsewhere.
      const sel = editor.state.selection;
      const hasSelection = !sel.empty;
      const sigBoundary = !hasSelection && signatureHtml
        ? findSignatureBoundary(editor, signatureHtml)
        : null;
      const from = hasSelection ? sel.from : 0;
      const to = hasSelection
        ? sel.to
        : (sigBoundary ?? editor.state.doc.content.size);
      const original = editor.state.doc.textBetween(from, to, '\n').trim();

      if (!original) {
        toast.error('Nothing to rewrite — type some text first.');
        return;
      }

      rewriteAbortRef.current?.abort();
      const abort = new AbortController();
      rewriteAbortRef.current = abort;
      resetRewrite();
      setRewriteError(null);
      setRewriteMode(mode);
      setRewriteOriginal(original);
      setRewriteRange({ from, to });
      setRewriteOpen(true);
      setRewriting(true);
      setAiAction('rewrite');
      setInjectionWarning(false);

      // For replies/forwards, hand the model the message we're responding to
      // so it can match tone and register without a second LLM call.
      const contextStr = await (async () => {
        if (mode === 'paraphrase' || mode === 'formal' || mode === 'concise' || mode === 'friendly') {
          if (!originalMessage) return undefined;
          return (await buildIncomingEmail())?.text;
        }
        // Grammar mode is purely local — context could mislead it.
        return undefined;
      })();
      if (abort.signal.aborted) return;

      try {
        const client = new AIClient();
        const final = await rewriteText(
          client,
          original,
          mode,
          {
            model: aiModel,
            context: contextStr,
            customInstructions: aiCustomInstructions,
            signal: abort.signal,
          },
          pushRewrite,
        );
        if (!abort.signal.aborted) replaceRewrite(final);
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        const m = err instanceof Error ? err.message : String(err);
        setRewriteError(m);
      } finally {
        setRewriting(false);
      }
    },
    [editor, aiModel, aiCustomInstructions, pushRewrite, resetRewrite, replaceRewrite, signatureHtml, originalMessage, buildIncomingEmail],
  );

  const closeRewrite = useCallback(() => {
    rewriteAbortRef.current?.abort();
    rewriteAbortRef.current = null;
    setRewriteOpen(false);
    resetRewrite();
    setRewriteError(null);
    setRewriting(false);
    setRewriteRange(null);
  }, [resetRewrite]);

  const applyRewrite = useCallback(() => {
    if (!editor || !rewriteText_.trim()) return;
    // Insert as plain paragraphs so we don't accidentally drop unsanitized HTML.
    const paragraphs = rewriteText_
      .trim()
      .split(/\n\n+/)
      .map((p) => `<p>${p.replace(/\n/g, '<br/>').replace(/</g, '&lt;')}</p>`)
      .join('');
    if (aiAction === 'suggest') {
      // Suggestions go at the very top of the doc so the signature (at the
      // bottom) is preserved. If the user already typed something, the
      // suggestion lands above their text — they can edit/move as needed.
      editor.chain().focus().insertContentAt(0, paragraphs).run();
      closeRewrite();
      toast.success('Reply suggestion inserted');
    } else {
      if (!rewriteRange) return;
      editor
        .chain()
        .focus()
        .insertContentAt({ from: rewriteRange.from, to: rewriteRange.to }, paragraphs)
        .run();
      closeRewrite();
      toast.success('Rewrite applied');
    }
  }, [editor, rewriteRange, rewriteText_, closeRewrite, aiAction]);

  // Overrides exist because a chip click needs to re-run with the NEW value —
  // the state set in the same handler is not yet visible to this closure.
  const handleSuggestReply = useCallback(async (overrides?: { intent?: ReplyIntent; length?: ReplyLength }) => {
    if (!editor || !originalMessage) return;
    setShowRewrite(false);

    rewriteAbortRef.current?.abort();
    const abort = new AbortController();
    rewriteAbortRef.current = abort;
    resetRewrite();
    setRewriteError(null);
    setRewriteOriginal('');
    setRewriteRange(null);
    setRewriteOpen(true);
    setRewriting(true);
    setAiAction('suggest');

    const incoming = await buildIncomingEmail();
    if (abort.signal.aborted) return;
    if (!incoming) {
      setRewriteError('Could not load the message being replied to.');
      setRewriting(false);
      return;
    }
    setInjectionWarning(detectInjectionAttempt(incoming.body));

    try {
      const client = new AIClient();
      const final = await suggestReply(
        client,
        incoming.text,
        {
          model: aiModel,
          userName: user?.displayName ?? user?.email ?? 'the user',
          intent: overrides?.intent ?? replyIntent,
          length: overrides?.length ?? replyLength,
          customInstructions: aiCustomInstructions,
          signal: abort.signal,
        },
        pushRewrite,
      );
      if (!abort.signal.aborted) replaceRewrite(final);
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      const m = err instanceof Error ? err.message : String(err);
      setRewriteError(m);
    } finally {
      setRewriting(false);
    }
  }, [
    editor,
    originalMessage,
    aiModel,
    aiCustomInstructions,
    replyIntent,
    replyLength,
    pushRewrite,
    resetRewrite,
    replaceRewrite,
    buildIncomingEmail,
    user,
  ]);

  // Re-run the current AI action with a fresh stream. For rewrite mode we
  // replay using the snapshotted original text (so the new run sees the
  // same input even if the editor selection has changed since the click).
  // Non-zero temperature in the underlying tasks gives meaningfully
  // different output on each call.
  const regenerate = useCallback(() => {
    if (aiAction === 'suggest') {
      void handleSuggestReply();
      return;
    }
    if (!rewriteOriginal) return;

    rewriteAbortRef.current?.abort();
    const abort = new AbortController();
    rewriteAbortRef.current = abort;
    resetRewrite();
    setRewriteError(null);
    setRewriting(true);

    void (async () => {
      const contextStr = await (async () => {
        if (
          rewriteMode === 'paraphrase' ||
          rewriteMode === 'formal' ||
          rewriteMode === 'concise' ||
          rewriteMode === 'friendly'
        ) {
          if (!originalMessage) return undefined;
          return (await buildIncomingEmail())?.text;
        }
        return undefined;
      })();
      if (abort.signal.aborted) return;

      try {
        const client = new AIClient();
        const final = await rewriteText(
          client,
          rewriteOriginal,
          rewriteMode,
          {
            model: aiModel,
            context: contextStr,
            customInstructions: aiCustomInstructions,
            signal: abort.signal,
          },
          pushRewrite,
        );
        if (!abort.signal.aborted) replaceRewrite(final);
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        const m = err instanceof Error ? err.message : String(err);
        setRewriteError(m);
      } finally {
        setRewriting(false);
      }
    })();
  }, [
    aiAction,
    rewriteOriginal,
    rewriteMode,
    originalMessage,
    aiModel,
    aiCustomInstructions,
    pushRewrite,
    resetRewrite,
    replaceRewrite,
    buildIncomingEmail,
    handleSuggestReply,
  ]);

  // Auto-trigger Suggest Reply when the modal was opened via the thread
  // toolbar's Quick Reply button. Fires once per open cycle.
  const autoSuggestFiredRef = useRef(false);
  useEffect(() => {
    if (!open) {
      autoSuggestFiredRef.current = false;
      return;
    }
    if (!autoSuggestReply || !originalMessage || !aiEnabled || !editor || autoSuggestFiredRef.current) return;
    autoSuggestFiredRef.current = true;
    // Small delay so signature injection and the editor focus settle first.
    const t = setTimeout(() => {
      void handleSuggestReply();
    }, 200);
    return () => clearTimeout(t);
  }, [open, autoSuggestReply, originalMessage, aiEnabled, editor, handleSuggestReply]);

  // ── Send (with 5-second undo window) ──────────────────────────────────────
  const handleSend = async () => {
    if (to.length === 0) { setError('Please add at least one recipient'); return; }
    setError(null);
    const currentHtml = editor?.getHTML() ?? '';
    const finalBody = buildHtmlBody(currentHtml, mode, originalMessage);
    const payload = {
      to,
      ...(cc.length > 0 ? { cc } : {}),
      ...(bcc.length > 0 ? { bcc } : {}),
      subject,
      body: finalBody,
      ...(mode === 'reply' || mode === 'replyAll' ? { replyToId: originalMessage?.id, replyType: 'r' } : {}),
      ...(mode === 'forward' ? { replyToId: originalMessage?.id, replyType: 'w' } : {}),
      ...(mode === 'forward' && forwardedAttachments.length > 0
        ? { forwardedAttachments: forwardedAttachments.map((a) => ({ mid: originalMessage!.id, part: a.id })) }
        : {}),
    };

    undoCancelledRef.current = false;
    // Dismiss the compose modal immediately so it feels fast
    onSent?.(); onClose();
    if (savedDraftId) { api.mail.discardDraft(savedDraftId).catch(() => {}); }

    // Show undo toast for 5 seconds
    const toastId = toast.message('Sending in 5 seconds…', {
      duration: 5200,
      action: {
        label: 'Undo',
        onClick: () => {
          undoCancelledRef.current = true;
          if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
          toast.success('Send cancelled');
        },
      },
    });

    undoTimerRef.current = setTimeout(async () => {
      if (undoCancelledRef.current) return;
      try {
        if (attachments.length > 0) {
          await api.mail.sendWithFiles(payload, attachments);
        } else {
          await api.mail.send(payload);
        }
        toast.dismiss(toastId);
        toast.success('Message sent');
      } catch (err: any) {
        const msg = err.message ?? 'Failed to send message';
        toast.error('Failed to send', { description: msg });
      }
    }, 5000);
  };

  // ── Scheduled Send ────────────────────────────────────────────────────────
  const handleScheduledSend = async () => {
    if (to.length === 0) { setError('Please add at least one recipient'); return; }
    if (!scheduleDateTime) { setError('Please pick a date to schedule'); return; }
    setError(null);

    const sendAt = new Date(scheduleDateTime);
    if (sendAt <= new Date()) { setError('Scheduled time must be in the future'); return; }

    const currentHtml = editor?.getHTML() ?? '';
    const finalBody = buildHtmlBody(currentHtml, mode, originalMessage);
    try {
      await api.mail.scheduleMessage({
        sendAt: sendAt.toISOString(),
        to,
        cc: cc.length > 0 ? cc : undefined,
        bcc: bcc.length > 0 ? bcc : undefined,
        subject,
        body: finalBody,
      });
      toast.success(`Message scheduled for ${sendAt.toLocaleString()}`);
      if (savedDraftId) { api.mail.discardDraft(savedDraftId).catch(() => {}); }
      onSent?.(); onClose();
    } catch (err: any) {
      const msg = err.message ?? 'Failed to schedule message';
      setError(msg); toast.error('Schedule failed', { description: msg });
    }
  };

  // Keep the ref current so TipTap's keydown handler can call it
  handleSendRef.current = handleSend;

  // Sanitize the quoted original body once per message — DOMPurify on a large
  // threaded body can take hundreds of ms, so doing it on every keystroke
  // (which used to happen via the unmemoised JSX call) froze the editor.
  const sanitizedQuoteHtml = useMemo(() => {
    if (!originalMessage || mode === 'new') return null;
    const raw = originalMessage.bodyHtml ?? (originalMessage.bodyText ? `<pre style="font-family:inherit;white-space:pre-wrap;font-size:12px">${originalMessage.bodyText}</pre>` : null);
    return raw ? sanitizeEmailHtml(raw) : null;
  }, [originalMessage, mode]);

  const placeholder = mode === 'forward' ? 'Add a message…' : mode === 'new' ? 'Compose your message…' : 'Write your reply…';

  if (!open) return null;

  // ── Current font attributes for toolbar state ─────────────────────────────
  const currentColor = editor?.getAttributes('textStyle').color as string | undefined;
  const currentFontFamily = editor?.getAttributes('textStyle').fontFamily as string | undefined ?? '';
  const currentFontSize = (editor?.getAttributes('textStyle').fontSize as string | undefined)?.replace('px', '') ?? '14';

  return (
    <div className={cn(
      'fixed bottom-4 right-4 z-50 flex flex-col w-[680px] bg-card rounded-2xl border border-border shadow-2xl overflow-hidden',
      minimised ? 'h-auto' : 'max-h-[calc(100vh-2rem)]',
    )}>
      {/* ── Header ── */}
      <div
        className="px-4 py-3 border-b border-border/60 shrink-0 flex items-center justify-between select-none"
        style={{ cursor: minimised ? 'pointer' : 'default' }}
        onClick={() => { if (minimised) setMinimised(false); }}
      >
        <span className="text-sm font-semibold text-foreground">{TITLE[mode]}</span>
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground/40 flex items-center gap-1 mr-1">
            {draftStatus === 'saving' && <><Loader2 className="w-2.5 h-2.5 animate-spin" /> Saving…</>}
            {draftStatus === 'saved' && 'Draft saved'}
          </span>
          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setMinimised((m) => !m); }}
            className="h-6 w-6 p-0 text-muted-foreground/50 hover:text-foreground" title={minimised ? 'Restore' : 'Minimise'}>
            {minimised ? <ChevronDown className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={sending}
            className="h-6 w-6 p-0 text-muted-foreground/50 hover:text-foreground" title="Close">
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Body — hidden when minimised */}
      {!minimised && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* ── Address + subject fields ── */}
          <div className="px-5 py-3 space-y-2.5 shrink-0 border-b border-border/40">
            <div className="flex items-center gap-2 h-9">
              <Label className="text-xs font-medium text-muted-foreground/60 uppercase tracking-wider shrink-0 w-14 text-right">From</Label>
              <span className="text-sm text-muted-foreground/70 px-1">
                {user?.displayName ? `${user.displayName} <${user.email}>` : user?.email}
              </span>
            </div>
            <EmailChipInput label="To" value={to} onChange={setTo} placeholder="recipients@example.com" autoFocus={mode === 'forward'} />
            {!showCcBcc ? (
              <button type="button" onClick={() => setShowCcBcc(true)}
                className="ml-16 text-xs text-muted-foreground/50 hover:text-primary transition-colors flex items-center gap-1">
                <ChevronDown className="w-3 h-3" /> Add Cc / Bcc
              </button>
            ) : (
              <>
                <EmailChipInput label="Cc" value={cc} onChange={setCc} placeholder="cc@example.com" />
                <EmailChipInput label="Bcc" value={bcc} onChange={setBcc} placeholder="bcc@example.com" />
                <button type="button" onClick={() => { setShowCcBcc(false); setCc([]); setBcc([]); }}
                  className="ml-16 text-xs text-muted-foreground/50 hover:text-primary transition-colors flex items-center gap-1">
                  <ChevronUp className="w-3 h-3" /> Hide Cc / Bcc
                </button>
              </>
            )}
            <div className="flex items-center gap-2">
              <Label className="text-xs font-medium text-muted-foreground/60 uppercase tracking-wider shrink-0 w-14 text-right">Subject</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject"
                className="flex-1 h-8 bg-muted/30 border-border/50 focus-visible:border-primary/50 focus-visible:ring-primary/20 text-sm" />
            </div>
          </div>

          {/* ── Attachment pills ── */}
          {(attachments.length > 0 || forwardedAttachments.length > 0) && (
            <div className="flex flex-wrap gap-1.5 px-5 py-2 border-b border-border/30 bg-muted/10">
              {/* Forwarded attachments from original message */}
              {forwardedAttachments.map((att, i) => (
                <span key={`fwd-${i}`} className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-primary/10 border border-primary/30 text-xs rounded-full max-w-[200px]">
                  <Paperclip className="w-3 h-3 text-primary/60 shrink-0" />
                  <span className="truncate">{att.filename}</span>
                  {att.size > 0 && <span className="text-muted-foreground/40 shrink-0">({formatFileSize(att.size)})</span>}
                  <button type="button" onClick={() => setForwardedAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="text-muted-foreground/60 hover:text-destructive leading-none shrink-0">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              {/* Newly added attachments */}
              {attachments.map((file, i) => (
                <span key={`new-${i}`} className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-muted/50 border border-border/50 text-xs rounded-full max-w-[200px]">
                  <Paperclip className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                  <span className="truncate">{file.name}</span>
                  <span className="text-muted-foreground/40 shrink-0">({formatFileSize(file.size)})</span>
                  <button type="button" onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="text-muted-foreground/60 hover:text-destructive leading-none shrink-0">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* ── Body area ── */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="px-5 py-4 flex flex-col">

              {/* Rich-text toolbar */}
              <div className="flex items-center gap-0.5 pb-2 mb-2 border-b border-border/30 flex-wrap">

                {/* Font family */}
                <select
                  value={currentFontFamily}
                  onChange={(e) => {
                    if (e.target.value) editor?.chain().focus().setFontFamily(e.target.value).run();
                    else editor?.chain().focus().unsetFontFamily().run();
                  }}
                  className="h-6 text-[11px] bg-muted/30 border border-border/50 rounded px-1 text-foreground/80 focus:outline-none focus:border-primary/50 mr-0.5"
                  title="Font family"
                >
                  {FONT_FAMILIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>

                {/* Font size */}
                <select
                  value={currentFontSize}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val) editor?.chain().focus().setMark('textStyle', { fontSize: `${val}px` }).run();
                  }}
                  className="h-6 text-[11px] bg-muted/30 border border-border/50 rounded px-1 text-foreground/80 focus:outline-none focus:border-primary/50 w-14 mr-0.5"
                  title="Font size"
                >
                  {FONT_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>

                {/* Text colour */}
                <button
                  type="button"
                  title="Text colour"
                  onMouseDown={(e) => { e.preventDefault(); colorInputRef.current?.click(); }}
                  className="relative p-1.5 rounded hover:bg-muted/60 transition-colors"
                >
                  <span className="text-[11px] font-bold leading-none" style={{ color: currentColor ?? 'currentColor' }}>A</span>
                  <span className="block h-[3px] w-4 rounded-sm mt-0.5" style={{ backgroundColor: currentColor ?? 'hsl(var(--foreground))' }} />
                </button>
                <input
                  ref={colorInputRef}
                  type="color"
                  className="sr-only"
                  defaultValue="#000000"
                  onChange={(e) => editor?.chain().focus().setColor(e.target.value).run()}
                />

                <div className="w-px h-4 bg-border/50 mx-1 shrink-0" />

                {/* Formatting */}
                <ToolbarBtn title="Bold (⌘B)" onClick={() => editor?.chain().focus().toggleBold().run()} active={editor?.isActive('bold')}>
                  <Bold className="w-3.5 h-3.5" />
                </ToolbarBtn>
                <ToolbarBtn title="Italic (⌘I)" onClick={() => editor?.chain().focus().toggleItalic().run()} active={editor?.isActive('italic')}>
                  <Italic className="w-3.5 h-3.5" />
                </ToolbarBtn>
                <ToolbarBtn title="Underline (⌘U)" onClick={() => editor?.chain().focus().toggleUnderline().run()} active={editor?.isActive('underline')}>
                  <UnderlineIcon className="w-3.5 h-3.5" />
                </ToolbarBtn>
                <ToolbarBtn title="Strikethrough" onClick={() => editor?.chain().focus().toggleStrike().run()} active={editor?.isActive('strike')}>
                  <Strikethrough className="w-3.5 h-3.5" />
                </ToolbarBtn>

                <div className="w-px h-4 bg-border/50 mx-1 shrink-0" />

                <ToolbarBtn title="Ordered list" onClick={() => editor?.chain().focus().toggleOrderedList().run()} active={editor?.isActive('orderedList')}>
                  <ListOrdered className="w-3.5 h-3.5" />
                </ToolbarBtn>
                <ToolbarBtn title="Bullet list" onClick={() => editor?.chain().focus().toggleBulletList().run()} active={editor?.isActive('bulletList')}>
                  <List className="w-3.5 h-3.5" />
                </ToolbarBtn>

                <div className="w-px h-4 bg-border/50 mx-1 shrink-0" />

                <ToolbarBtn
                  title={editor?.isActive('link') ? 'Remove link' : 'Insert link'}
                  onClick={() => {
                    if (editor?.isActive('link')) {
                      editor.chain().focus().unsetLink().run();
                    } else {
                      const url = window.prompt('Enter URL (e.g. https://example.com):');
                      if (url) editor?.chain().focus().setLink({ href: url }).run();
                    }
                  }}
                  active={editor?.isActive('link')}
                >
                  <Link2 className="w-3.5 h-3.5" />
                </ToolbarBtn>

                <div className="w-px h-4 bg-border/50 mx-1 shrink-0" />

                {/* File attach */}
                <ToolbarBtn title="Attach file" onClick={() => fileInputRef.current?.click()}>
                  <Paperclip className="w-3.5 h-3.5" />
                </ToolbarBtn>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (files.length) setAttachments((prev) => [...prev, ...files]);
                    e.target.value = '';
                  }}
                />

                {/* Attach doc from Docs module */}
                <ToolbarBtn title="Attach document" onClick={() => setShowDocPicker(true)}>
                  <Files className="w-3.5 h-3.5" />
                </ToolbarBtn>

                {/* Templates */}
                {(templates as any[]).length > 0 && (
                  <div ref={templatesRef} className="relative">
                    <ToolbarBtn title="Insert template" onClick={() => setShowTemplates((v) => !v)} active={showTemplates}>
                      <FileText className="w-3.5 h-3.5" />
                    </ToolbarBtn>
                    {showTemplates && (
                      <div className="absolute left-0 top-full mt-1 z-50 bg-popover border border-border/60 rounded-xl shadow-lg overflow-hidden min-w-[200px]">
                        <p className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider border-b border-border/30">
                          Templates
                        </p>
                        <ul className="py-1 max-h-52 overflow-y-auto">
                          {(templates as any[]).map((t) => (
                            <li key={t.id}>
                              <button
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  if (t.subject && !subject) setSubject(t.subject);
                                  editor?.chain().focus().insertContent(t.body).run();
                                  setShowTemplates(false);
                                }}
                                className="w-full text-left px-3 py-2 text-[12px] hover:bg-muted/60 text-foreground transition-colors"
                              >
                                {t.name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* Rewrite (AI) */}
                {aiEnabled && (
                  <div ref={rewriteRef} className="relative">
                    <ToolbarBtn
                      title="Rewrite with AI"
                      onClick={() => setShowRewrite((v) => !v)}
                      active={showRewrite || rewriteOpen}
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                    </ToolbarBtn>
                    {showRewrite && (
                      <div className="absolute left-0 top-full mt-1 z-50 bg-popover border border-border/60 rounded-xl shadow-lg overflow-hidden min-w-[200px]">
                        {originalMessage && (
                          <>
                            <p className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider border-b border-border/30">
                              Reply
                            </p>
                            <ul className="py-1 border-b border-border/30">
                              <li>
                                <button
                                  type="button"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    void handleSuggestReply();
                                  }}
                                  className="w-full text-left px-3 py-2 text-[12px] hover:bg-muted/60 text-foreground transition-colors"
                                >
                                  Suggest reply
                                </button>
                              </li>
                            </ul>
                          </>
                        )}
                        <p className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider border-b border-border/30">
                          Rewrite
                        </p>
                        <ul className="py-1">
                          {([
                            { id: 'paraphrase', label: 'Paraphrase' },
                            { id: 'formal', label: 'More formal' },
                            { id: 'concise', label: 'More concise' },
                            { id: 'friendly', label: 'Friendlier' },
                            { id: 'grammar', label: 'Fix grammar' },
                          ] as { id: RewriteMode; label: string }[]).map((opt) => (
                            <li key={opt.id}>
                              <button
                                type="button"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  void handleRewrite(opt.id);
                                }}
                                className="w-full text-left px-3 py-2 text-[12px] hover:bg-muted/60 text-foreground transition-colors"
                              >
                                {opt.label}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* TipTap editor */}
              <div className="relative">
                {editor?.isEmpty && (
                  <div className="absolute top-0 left-0 text-sm text-muted-foreground/40 pointer-events-none select-none">
                    {placeholder}
                  </div>
                )}
                <EditorContent editor={editor} />

                {aiEnabled && (
                  <aside
                    aria-hidden={!rewriteOpen}
                    className={cn(
                      'absolute top-2 right-2 w-[340px] max-h-[60vh] z-30',
                      'rounded-xl border border-border/40 bg-card shadow-xl',
                      'flex flex-col overflow-hidden',
                      'transition-all duration-200 ease-out',
                      rewriteOpen
                        ? 'translate-x-0 opacity-100 scale-100'
                        : 'translate-x-[120%] opacity-0 scale-95 pointer-events-none',
                    )}
                  >
                    <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border/30 shrink-0">
                      <Sparkles className="w-3.5 h-3.5 text-primary" />
                      <span className="text-[12px] font-semibold text-foreground capitalize">
                        {aiAction === 'suggest'
                          ? 'Reply suggestion'
                          : rewriteMode === 'grammar' ? 'Grammar fix' : rewriteMode}
                      </span>
                      {rewriting && (
                        <Loader2 className="w-3 h-3 animate-spin text-muted-foreground/60" />
                      )}
                      <button
                        type="button"
                        onClick={closeRewrite}
                        className="ml-auto p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
                        aria-label="Close"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto px-3.5 py-3 space-y-3">
                      {injectionWarning && aiAction === 'suggest' && (
                        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11.5px] leading-relaxed text-amber-800 dark:text-amber-300">
                          <span className="font-semibold">Check this draft carefully.</span> The
                          incoming email contains text written to instruct an AI assistant, which
                          can steer what is suggested here. Read every line before inserting it.
                        </div>
                      )}
                      {aiAction === 'suggest' && (
                        <div className="space-y-2">
                          <div>
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50 mb-1">Respond with</p>
                            <div className="flex flex-wrap gap-1">
                              {(
                                [
                                  ['auto', 'Auto'],
                                  ['acknowledge', 'Acknowledge'],
                                  ['accept', 'Accept'],
                                  ['decline', 'Decline'],
                                  ['request-info', 'Ask for info'],
                                ] as const
                              ).map(([value, label]) => (
                                <button
                                  key={value}
                                  type="button"
                                  disabled={rewriting}
                                  onClick={() => {
                                    if (value === replyIntent) return;
                                    setReplyIntent(value);
                                    void handleSuggestReply({ intent: value });
                                  }}
                                  className={cn(
                                    'text-[11px] px-2 py-0.5 rounded-full border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                                    replyIntent === value
                                      ? 'border-primary/50 bg-primary/10 text-primary'
                                      : 'border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/60',
                                  )}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50 mr-1">Length</p>
                            {(
                              [
                                ['brief', 'Brief'],
                                ['standard', 'Standard'],
                              ] as const
                            ).map(([value, label]) => (
                              <button
                                key={value}
                                type="button"
                                disabled={rewriting}
                                onClick={() => {
                                  if (value === replyLength) return;
                                  setReplyLength(value);
                                  void handleSuggestReply({ length: value });
                                }}
                                className={cn(
                                  'text-[11px] px-2 py-0.5 rounded-full border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                                  replyLength === value
                                    ? 'border-primary/50 bg-primary/10 text-primary'
                                    : 'border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted/60',
                                )}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {aiAction === 'rewrite' && (
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50 mb-1">Original</p>
                          <p className="text-[12px] text-muted-foreground/80 leading-relaxed line-clamp-4 whitespace-pre-wrap">
                            {rewriteOriginal}
                          </p>
                        </div>
                      )}
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50 mb-1">
                          {aiAction === 'suggest' ? 'Suggested reply' : 'Rewrite'}
                        </p>
                        {rewriteError ? (
                          <p className="text-[12px] text-destructive">
                            {rewriteError}{' '}
                            <button
                              type="button"
                              onClick={() =>
                                aiAction === 'suggest' ? handleSuggestReply() : handleRewrite(rewriteMode)
                              }
                              className="underline ml-1"
                            >
                              Retry
                            </button>
                          </p>
                        ) : (
                          <p className="text-[12.5px] text-foreground/90 leading-relaxed whitespace-pre-wrap">
                            {rewriteText_ || (rewriting ? 'Thinking…' : '')}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 px-3.5 py-2.5 border-t border-border/30 shrink-0 bg-muted/20">
                      <button
                        type="button"
                        onClick={closeRewrite}
                        className="text-[12px] px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                      >
                        Discard
                      </button>
                      <button
                        type="button"
                        onClick={regenerate}
                        disabled={rewriting}
                        className="ml-auto text-[12px] px-2.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        title="Generate a different version"
                      >
                        Try another
                      </button>
                      <button
                        type="button"
                        onClick={applyRewrite}
                        disabled={rewriting || !rewriteText_.trim() || !!rewriteError}
                        className="text-[12px] px-3 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {aiAction === 'suggest' ? 'Insert' : 'Replace'}
                      </button>
                    </div>
                  </aside>
                )}
              </div>

              {/* Quoted original */}
              {sanitizedQuoteHtml && (
                <>
                  <Separator className="my-4 bg-border/40" />
                  <div
                    className="text-xs prose prose-sm prose-invert max-w-none prose-a:text-primary opacity-60 pointer-events-none select-none"
                    dangerouslySetInnerHTML={{ __html: sanitizedQuoteHtml }}
                  />
                </>
              )}
            </div>
          </div>

          {/* ── Schedule picker (shown when showSchedule is true) ── */}
          {showSchedule && (
            <div className="px-5 py-3 border-t border-border/40 shrink-0 bg-muted/10">
              <p className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-wider mb-2">Schedule send</p>
              <div className="flex items-center gap-2">
                <DateTimePicker
                  value={scheduleDateTime}
                  onChange={setScheduleDateTime}
                  className="flex-1 h-8 text-[12px]"
                />
                <Button size="sm" onClick={handleScheduledSend} disabled={!scheduleDateTime || to.length === 0}
                  className="h-8 px-3 gap-1.5 bg-primary/90 hover:bg-primary text-primary-foreground">
                  <Calendar className="w-3.5 h-3.5" /> Schedule
                </Button>
                <button onClick={() => setShowSchedule(false)} className="p-1 rounded text-muted-foreground/50 hover:text-foreground">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* ── Footer ── */}
          <div className="px-5 py-3 border-t border-border/60 shrink-0 flex items-center justify-between">
            <div className="flex-1">
              {error && <p className="text-xs text-destructive">{error}</p>}
              {!error && (
                <p className="text-xs text-muted-foreground/30">
                  {typeof navigator !== 'undefined' && navigator?.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to send · 5s undo window
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="destructive-ghost" size="sm" onClick={handleDiscard} className="h-8">Discard</Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleSaveDraft}
                disabled={draftStatus === 'saving'}
                title="Save draft"
                className="h-8 px-3 text-muted-foreground/70 hover:text-foreground"
              >
                {draftStatus === 'saving' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save draft'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setShowSchedule((v) => !v); }}
                title="Schedule send"
                className="h-8 w-8 p-0 text-muted-foreground/50 hover:text-foreground"
              >
                <Clock className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" onClick={handleSend} disabled={to.length === 0}
                className="bg-primary hover:bg-primary/90 text-primary-foreground h-8 px-4 gap-1.5">
                <Send className="w-3.5 h-3.5" /> Send{attachments.length > 0 ? ` (+${attachments.length})` : ''}
              </Button>
            </div>
          </div>
        </div>
      )}

      <DocPickerDialog
        open={showDocPicker}
        onClose={() => setShowDocPicker(false)}
        onPick={handleDocAttach}
      />
    </div>
  );
}
