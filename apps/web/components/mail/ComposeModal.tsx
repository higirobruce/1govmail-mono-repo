'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
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
  Clock, FileText, Calendar,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
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
  bodyHtml: string | null;
  bodyText: string | null;
  receivedAt: string;
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
}

// ── Email chip input ──────────────────────────────────────────────────────────

interface ContactSuggestion {
  email: string;
  display: string;
}

function EmailChipInput({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  label: string;
  value: string[];
  onChange: (emails: string[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (input.trim().length < 2) {
      setSuggestions([]);
      setActiveIdx(-1);
      setLoadingSuggestions(false);
      return;
    }
    setLoadingSuggestions(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await api.contacts.autocomplete(input.trim());
        setSuggestions(results.filter((r) => !value.includes(r.email)));
      } catch {
        setSuggestions([]);
      } finally {
        setLoadingSuggestions(false);
        setActiveIdx(-1);
      }
    }, 280);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeSuggestions = () => { setSuggestions([]); setActiveIdx(-1); setLoadingSuggestions(false); };
  const commit = (raw: string) => {
    const email = raw.trim().replace(/,+$/, '');
    if (email && !value.includes(email)) onChange([...value, email]);
    setInput(''); closeSuggestions();
  };
  const selectSuggestion = (s: ContactSuggestion) => {
    if (!value.includes(s.email)) onChange([...value, s.email]);
    setInput(''); closeSuggestions(); inputRef.current?.focus();
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const hasSuggestions = suggestions.length > 0;
    if (e.key === 'ArrowDown' && hasSuggestions) { e.preventDefault(); setActiveIdx((p) => (p + 1) % suggestions.length); return; }
    if (e.key === 'ArrowUp' && hasSuggestions) { e.preventDefault(); setActiveIdx((p) => (p <= 0 ? suggestions.length - 1 : p - 1)); return; }
    if (e.key === 'Escape') { closeSuggestions(); return; }
    if ((e.key === 'Enter' || e.key === 'Tab') && hasSuggestions && activeIdx >= 0) { e.preventDefault(); selectSuggestion(suggestions[activeIdx]); return; }
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') { e.preventDefault(); commit(input); }
    else if (e.key === 'Backspace' && input === '' && value.length > 0) { onChange(value.slice(0, -1)); }
  };

  const showDropdown = loadingSuggestions || suggestions.length > 0;
  return (
    <div className="flex items-start gap-2 min-h-[36px]">
      <Label className="text-xs font-medium text-muted-foreground/60 uppercase tracking-wider shrink-0 pt-2 w-14 text-right">{label}</Label>
      <div className="relative flex-1">
        <div className="flex flex-wrap gap-1.5 px-3 py-1.5 bg-muted/30 border border-border/50 rounded-lg cursor-text min-h-[36px]" onClick={() => inputRef.current?.focus()}>
          {value.map((email) => (
            <span key={email} className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 border border-primary/20 text-primary text-xs rounded-full">
              {email}
              <button type="button" onClick={(e) => { e.stopPropagation(); onChange(value.filter((v) => v !== email)); }} className="text-primary/60 hover:text-primary leading-none"><X className="w-3 h-3" /></button>
            </span>
          ))}
          <input ref={inputRef} type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKey}
            onBlur={() => setTimeout(() => { if (!dropdownRef.current?.contains(document.activeElement)) { if (input.trim()) commit(input); else closeSuggestions(); } }, 150)}
            placeholder={value.length === 0 ? placeholder : ''}
            className="flex-1 min-w-[140px] bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/40"
          />
        </div>
        {showDropdown && (
          <div ref={dropdownRef} className="absolute left-0 right-0 top-full mt-1 z-50 bg-popover border border-border/60 rounded-lg shadow-lg overflow-hidden">
            {loadingSuggestions && suggestions.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground/50"><Loader2 className="w-3 h-3 animate-spin" />Searching…</div>
            ) : (
              <ul className="max-h-52 overflow-y-auto py-1">
                {suggestions.map((s, i) => (
                  <li key={s.email}>
                    <button type="button" onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s); }}
                      className={`w-full text-left px-3 py-2 flex flex-col gap-0.5 transition-colors ${i === activeIdx ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/60 text-foreground'}`}>
                      <span className="text-xs font-medium leading-tight truncate">{s.display !== s.email ? s.display : ''}</span>
                      <span className={`text-xs leading-tight truncate ${s.display !== s.email ? 'text-muted-foreground/60' : 'font-medium'}`}>{s.email}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

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
  const quoteContent = original.bodyHtml
    ? stripHtmlDocWrapper(original.bodyHtml)
    : (original.bodyText ? `<pre style="font-family:inherit;white-space:pre-wrap;margin:0">${original.bodyText}</pre>` : '');
  const quote = `<blockquote style="margin:4px 0 0 .8ex;border-left:2px solid #555;padding-left:1ex;color:#aaa;">${quoteContent}</blockquote>`;
  return `${userHtml}${header}${quote}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
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
  const [body, setBody] = useState('');
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Undo send ──────────────────────────────────────────────────────────────
  const undoCancelledRef = useRef(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Scheduled send ─────────────────────────────────────────────────────────
  const [showSchedule, setShowSchedule] = useState(false);
  const [scheduleDateTime, setScheduleDateTime] = useState('');

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

  // ── Attachments ────────────────────────────────────────────────────────────
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);

  // ── Signature injection state ─────────────────────────────────────────────
  const sigInserted = useRef(false);

  // ── Draft auto-save state ─────────────────────────────────────────────────
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    onUpdate({ editor: ed }) {
      setBody(ed.getHTML());
    },
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
    setSavedDraftId(initialDraftZimbraId ?? null);
    setDraftStatus('idle');
    setMinimised(false);
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
      setSubject(''); setBody('');
      setShowCcBcc(false);
      editor?.commands.setContent('<p></p>');
      setTimeout(() => editor?.commands.focus(), 50);
      return;
    }

    const origSubject = originalMessage.subject ?? '(no subject)';
    const selfEmail = user?.email ?? '';

    if (mode === 'reply') {
      setTo([originalMessage.fromEmail]); setCc([]); setBcc([]);
      setSubject(origSubject.match(/^Re:/i) ? origSubject : `Re: ${origSubject}`);
      setShowCcBcc(false);
    } else if (mode === 'replyAll') {
      const toList = [originalMessage.fromEmail, ...originalMessage.toRecipients.map((r) => r.email).filter((e) => e !== selfEmail)];
      const ccList = originalMessage.ccRecipients.map((r) => r.email).filter((e) => e !== selfEmail);
      setTo(toList); setCc(ccList); setBcc([]);
      setShowCcBcc(ccList.length > 0);
      setSubject(origSubject.match(/^Re:/i) ? origSubject : `Re: ${origSubject}`);
    } else if (mode === 'forward') {
      setTo([]); setCc([]); setBcc([]);
      setSubject(origSubject.match(/^Fwd:/i) ? origSubject : `Fwd: ${origSubject}`);
      setShowCcBcc(false);
    }

    editor?.commands.setContent('<p></p>');
    setBody('');
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

  // ── Auto-save draft ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open || sending) return;
    const currentBody = editor?.getHTML() ?? '';
    const hasContent = to.length > 0 || cc.length > 0 || subject.trim().length > 0 || (currentBody && currentBody !== '<p></p>');
    if (!hasContent) return;

    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(async () => {
      setDraftStatus('saving');
      try {
        const result = await api.mail.saveDraft({
          to, cc, bcc, subject,
          body: editor?.getHTML() ?? '',
          draftId: savedDraftId ?? undefined,
        });
        setSavedDraftId(result.zimbraId);
        setDraftStatus('saved');
        if (draftStatusTimerRef.current) clearTimeout(draftStatusTimerRef.current);
        draftStatusTimerRef.current = setTimeout(() => setDraftStatus('idle'), 3000);
      } catch { setDraftStatus('idle'); }
    }, 3000);

    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [to, cc, bcc, subject, body, open]); // eslint-disable-line

  // ── Discard ────────────────────────────────────────────────────────────────
  const handleDiscard = async () => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    if (savedDraftId) api.mail.discardDraft(savedDraftId).catch(() => {});
    setSavedDraftId(null); setDraftStatus('idle');
    onClose();
  };

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
      ...(mode === 'reply' || mode === 'replyAll' ? { replyToId: originalMessage?.id } : {}),
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

  const quoteHtml = (() => {
    if (!originalMessage || mode === 'new') return null;
    return originalMessage.bodyHtml ?? (originalMessage.bodyText ? `<pre style="font-family:inherit;white-space:pre-wrap;font-size:12px">${originalMessage.bodyText}</pre>` : null);
  })();

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
            className="h-6 w-6 p-0 text-muted-foreground/50 hover:text-foreground" title="Close — draft is kept">
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
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-5 py-2 border-b border-border/30 bg-muted/10">
              {attachments.map((file, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-muted/50 border border-border/50 text-xs rounded-full max-w-[200px]">
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
              </div>

              {/* TipTap editor */}
              <div className="relative">
                {editor?.isEmpty && (
                  <div className="absolute top-0 left-0 text-sm text-muted-foreground/40 pointer-events-none select-none">
                    {placeholder}
                  </div>
                )}
                <EditorContent editor={editor} />
              </div>

              {/* Quoted original */}
              {quoteHtml && (
                <>
                  <Separator className="my-4 bg-border/40" />
                  <div
                    className="text-xs prose prose-sm prose-invert max-w-none prose-a:text-primary opacity-60 pointer-events-none select-none"
                    dangerouslySetInnerHTML={{ __html: quoteHtml }}
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
              <Button variant="ghost" size="sm" onClick={handleDiscard}
                className="text-muted-foreground/60 hover:text-destructive/70 h-8">Discard</Button>
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
    </div>
  );
}
