'use client';

import { useState, useRef } from 'react';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { Send, Loader2, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MessageDetail {
  id: string;
  subject: string | null;
  fromEmail: string;
  fromName: string | null;
  toRecipients: Array<{ email: string; name?: string }>;
  zimbraId?: string;
}

interface Props {
  message: MessageDetail;
  onSent: () => void;
  onExpand: () => void;
}

export function QuickReplyBar({ message, onSent, onExpand }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleFocus = () => setExpanded(true);

  const handleSend = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const subject = message.subject
        ? (message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`)
        : 'Re: (no subject)';

      await api.mail.send({
        to: [message.fromEmail],
        subject,
        body: trimmed,
        inReplyTo: message.zimbraId ?? message.id,
      });

      toast.success('Reply sent');
      setBody('');
      setExpanded(false);
      onSent();
    } catch (err: any) {
      toast.error('Failed to send reply', { description: err?.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={cn(
      'border-t border-border/30 bg-muted/20 transition-all',
      expanded ? 'px-4 py-3' : 'px-4 py-2',
    )}>
      <div className={cn(
        'flex items-start gap-2 bg-card border border-border/50 rounded-xl px-3 transition-all',
        expanded ? 'py-2.5' : 'py-2',
      )}>
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onFocus={handleFocus}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSend();
          }}
          placeholder="Quick reply…"
          rows={expanded ? 3 : 1}
          className="flex-1 min-w-0 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/40 resize-none outline-none leading-relaxed"
        />

        {expanded && (
          <div className="flex items-center gap-1 pt-0.5 shrink-0">
            <button
              onClick={onExpand}
              title="Open full editor"
              className="p-1.5 rounded-lg text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleSend}
              disabled={sending || !body.trim()}
              title="Send reply (⌘↵)"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium disabled:opacity-50 transition-colors hover:bg-primary/90"
            >
              {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Send
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <p className="text-[10px] text-muted-foreground/30 mt-1.5 text-right">
          ⌘↵ to send · <button onClick={onExpand} className="underline hover:text-muted-foreground/50">Open full editor</button>
        </p>
      )}
    </div>
  );
}
