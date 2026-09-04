'use client';

import { useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import {
  Send, Loader2, Maximize2, Bold, Italic, List, Link2, Smile, Paperclip,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuthStore } from '@/stores/auth.store';
import { computeReplyRecipients, type Recipient } from '@/lib/replyRecipients';

interface MessageDetail {
  id: string;
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  toRecipients: Array<{ email: string; name?: string | null }>;
  ccRecipients?: Array<{ email: string; name?: string | null }>;
  zimbraId?: string;
}

interface Props {
  message: MessageDetail;
  onSent: () => void;
  /** Open the full inline composer, carrying the typed draft and chosen mode. */
  onExpand: (initialBody: string, mode: 'reply' | 'replyAll') => void;
}

const EMOJI = ['😊', '👍', '🙏', '✅', '🎉', '📌', '⏰', '📎', '❗', '❓', '💡', '🤝'];

function RecipientChip({ r }: { r: Recipient }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted text-micro font-normal text-ink-2 max-w-[180px]">
      <span className="truncate">{r.name || r.email}</span>
    </span>
  );
}

export function QuickReplyBar({ message, onSent, onExpand }: Props) {
  const user = useAuthStore((s) => s.user);
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<'reply' | 'replyAll'>('reply');
  const [sending, setSending] = useState(false);

  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false })],
    content: '',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'mini-composer-editor text-ui text-foreground outline-none',
        'aria-label': 'Reply',
      },
    },
    onFocus: () => setExpanded(true),
  });

  const { to, cc } = computeReplyRecipients(
    { fromEmail: message.fromEmail, fromName: message.fromName,
      toRecipients: message.toRecipients, ccRecipients: message.ccRecipients },
    mode,
    user?.email ?? '',
  );
  const hasReplyAllExtras =
    computeReplyRecipients(
      { fromEmail: message.fromEmail, fromName: message.fromName,
        toRecipients: message.toRecipients, ccRecipients: message.ccRecipients },
      'replyAll', user?.email ?? '',
    ).to.length > 1;

  const currentHtml = () => editor?.getHTML() ?? '';
  const isEmpty = !editor || editor.isEmpty;

  const handleSend = useCallback(async () => {
    if (!editor || editor.isEmpty || sending) return;
    setSending(true);
    try {
      const subject = message.subject
        ? (message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`)
        : 'Re: (no subject)';
      await api.mail.send({
        to: to.map((r) => r.email),
        ...(cc.length > 0 ? { cc: cc.map((r) => r.email) } : {}),
        subject,
        body: editor.getHTML(),
        replyToId: message.id,
        replyType: 'r',
      });
      toast.success('Reply sent');
      editor.commands.clearContent();
      setExpanded(false);
      onSent();
    } catch (err: any) {
      toast.error('Failed to send reply', { description: err?.message });
    } finally {
      setSending(false);
    }
  }, [editor, sending, message.id, message.subject, to, cc, onSent]);

  return (
    <div className={cn('border-t border-border-faint bg-muted/20', expanded ? 'px-4 py-3' : 'px-4 py-2')}>
      <div className="bg-card border border-border rounded-xl shadow-pill overflow-hidden">
        {/* Recipient row — visible once engaged */}
        {expanded && (
          <div className="flex items-center gap-1.5 flex-wrap px-3 pt-2.5">
            <span className="text-micro text-ink-3 shrink-0">To</span>
            {to.map((r) => <RecipientChip key={r.email} r={r} />)}
            {cc.length > 0 && (
              <>
                <span className="text-micro text-ink-3 shrink-0 ml-1">Cc</span>
                {cc.map((r) => <RecipientChip key={r.email} r={r} />)}
              </>
            )}
            {hasReplyAllExtras && (
              <Button variant="ghost" size="xs" className="ml-auto text-ink-3 hover:text-foreground"
                aria-label={mode === 'reply' ? 'Reply all' : 'Reply only to sender'}
                onClick={() => setMode((m) => (m === 'reply' ? 'replyAll' : 'reply'))}>
                {mode === 'reply' ? 'Reply all' : 'Reply only'}
              </Button>
            )}
          </div>
        )}

        {/* Editor */}
        <div className={cn('px-3', expanded ? 'py-2' : 'py-2')}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSend(); }}>
          <EditorContent editor={editor} onFocus={() => setExpanded(true)} />
          {!expanded && isEmpty && (
            <p className="pointer-events-none -mt-5 text-ui text-ink-4">Quick reply…</p>
          )}
        </div>

        {/* Toolbar + send — visible once engaged */}
        {expanded && (
          <div className="flex items-center gap-0.5 px-2 pb-2">
            <Button variant="ghost" size="icon-xs" aria-label="Bold"
              className={cn('text-ink-3', editor?.isActive('bold') && 'bg-muted text-foreground')}
              onClick={() => editor?.chain().focus().toggleBold().run()}><Bold /></Button>
            <Button variant="ghost" size="icon-xs" aria-label="Italic"
              className={cn('text-ink-3', editor?.isActive('italic') && 'bg-muted text-foreground')}
              onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic /></Button>
            <Button variant="ghost" size="icon-xs" aria-label="Bullet list"
              className={cn('text-ink-3', editor?.isActive('bulletList') && 'bg-muted text-foreground')}
              onClick={() => editor?.chain().focus().toggleBulletList().run()}><List /></Button>
            <Button variant="ghost" size="icon-xs" aria-label="Insert link" className="text-ink-3"
              onClick={() => {
                if (editor?.isActive('link')) { editor.chain().focus().unsetLink().run(); return; }
                const url = window.prompt('Enter URL (e.g. https://example.com):');
                if (url) editor?.chain().focus().setLink({ href: url }).run();
              }}><Link2 /></Button>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Insert emoji" className="text-ink-3"><Smile /></Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-2" align="start">
                <div className="grid grid-cols-6 gap-1">
                  {EMOJI.map((e) => (
                    <button key={e} type="button"
                      className="w-7 h-7 rounded-md hover:bg-muted text-body"
                      onClick={() => editor?.chain().focus().insertContent(e).run()}>
                      {e}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <Button variant="ghost" size="icon-xs" aria-label="Attach files — opens the full editor"
              className="text-ink-3" onClick={() => onExpand(currentHtml(), mode)}><Paperclip /></Button>

            <div className="flex-1" />

            <Button variant="ghost" size="icon-xs" aria-label="Open full editor"
              className="text-ink-3" onClick={() => onExpand(currentHtml(), mode)}><Maximize2 /></Button>
            <Button size="xs" onClick={handleSend} disabled={sending || isEmpty}
              aria-label="Send reply (⌘↵)">
              {sending ? <Loader2 className="animate-spin" /> : <Send />}
              Send
            </Button>
          </div>
        )}
      </div>

      {expanded && (
        <p className="text-micro font-normal text-ink-4 mt-1.5 text-right">⌘↵ to send</p>
      )}
    </div>
  );
}
