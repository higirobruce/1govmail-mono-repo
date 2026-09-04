'use client';

import { formatDistanceToNow, parseISO } from 'date-fns';
import { X, Reply, ReplyAll, Forward, Sparkles, MessageSquareReply } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MailAvatar } from './MailAvatar';

export interface ThreadParticipant {
  email: string;
  name: string | null;
}

interface Props {
  subject: string | null;
  participants: ThreadParticipant[];
  messageCount: number;
  unreadCount: number;
  lastReceivedAt: string;
  lastSenderEmail: string;
  currentUserEmail: string;
  onClose: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onSummarize?: () => void;
  summarizing?: boolean;
  onQuickReply?: () => void;
}

function getInitials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    return parts.length >= 2
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : parts[0].slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

function deriveStatus(
  lastSenderEmail: string,
  currentUserEmail: string,
  unreadCount: number,
): { label: string; className: string } {
  if (unreadCount > 0) {
    return {
      label: `${unreadCount} unread`,
      className: 'bg-blue-500/10 text-blue-400 border border-blue-500/20',
    };
  }
  if (lastSenderEmail.toLowerCase() === currentUserEmail.toLowerCase()) {
    return {
      label: 'You replied',
      className: 'bg-muted text-muted-foreground/60 border border-border/40',
    };
  }
  return {
    label: 'Awaiting reply',
    className: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
  };
}

export default function ThreadHeader({
  subject,
  participants,
  messageCount,
  unreadCount,
  lastReceivedAt,
  lastSenderEmail,
  currentUserEmail,
  onClose,
  onReply,
  onReplyAll,
  onForward,
  onSummarize,
  summarizing,
  onQuickReply,
}: Props) {
  const status = deriveStatus(lastSenderEmail, currentUserEmail, unreadCount);

  const lastActivity = (() => {
    try {
      return formatDistanceToNow(parseISO(lastReceivedAt), { addSuffix: true });
    } catch {
      return '';
    }
  })();

  const visibleParticipants = participants.slice(0, 5);
  const extraParticipantCount = participants.length - visibleParticipants.length;

  return (
    <div className="border-b border-border/30 bg-background shrink-0">
      <div className="flex items-start gap-2 px-4 pt-3.5 pb-3">
        {/* Close */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onClose}
              className="mt-0.5 p-1 rounded-md text-muted-foreground/40 hover:text-foreground hover:bg-muted transition-colors shrink-0"
              aria-label="Close thread"
            >
              <X className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">Close</TooltipContent>
        </Tooltip>

        {/* Subject + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-[0.9375rem] font-semibold text-foreground leading-snug">
              {subject ?? '(no subject)'}
            </h1>
            <span
              className={cn(
                'text-[0.625rem] px-2 py-0.5 rounded-full shrink-0 font-medium whitespace-nowrap',
                status.className,
              )}
            >
              {status.label}
            </span>
          </div>

          {/* Participants + stats */}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <div className="flex -space-x-1.5">
              {visibleParticipants.map((p, i) => (
                <Tooltip key={p.email}>
                  <TooltipTrigger asChild>
                    <div
                      className="cursor-default"
                      style={{ zIndex: visibleParticipants.length - i }}
                    >
                      <MailAvatar
                        name={p.name}
                        email={p.email}
                        size="xs"
                        className="ring-1 ring-background"
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {p.name ? `${p.name} <${p.email}>` : p.email}
                  </TooltipContent>
                </Tooltip>
              ))}
              {extraParticipantCount > 0 && (
                <div className="w-6 h-6 rounded-full bg-muted text-muted-foreground text-[0.5625rem] font-medium flex items-center justify-center ring-1 ring-background">
                  +{extraParticipantCount}
                </div>
              )}
            </div>
            <span className="text-[0.6875rem] text-muted-foreground/50">
              {messageCount} message{messageCount !== 1 ? 's' : ''}
              {unreadCount > 0 && ` · ${unreadCount} unread`}
              {lastActivity && ` · ${lastActivity}`}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0 shrink-0">
          {[
            { icon: Reply,    label: 'Reply',     onClick: onReply },
            { icon: ReplyAll, label: 'Reply All', onClick: onReplyAll },
            { icon: Forward,  label: 'Forward',   onClick: onForward },
          ].map(({ icon: Icon, label, onClick }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <button
                  onClick={onClick}
                  className="p-1.5 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
                  aria-label={label}
                >
                  <Icon className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{label}</TooltipContent>
            </Tooltip>
          ))}
          {onSummarize && (
            <button
              onClick={onSummarize}
              disabled={summarizing}
              className={cn(
                'inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap px-2.5 py-1 rounded-full text-[0.75rem] font-medium transition-colors',
                summarizing
                  ? 'bg-primary/15 text-primary'
                  : 'bg-primary/10 text-primary hover:bg-primary/20',
              )}
              aria-label="Summarize"
            >
              <Sparkles className={cn('w-3.5 h-3.5', summarizing && 'animate-pulse')} />
              Summarize
            </button>
          )}
          {onQuickReply && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onQuickReply}
                  className="p-1.5 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
                  aria-label="Quick reply (AI)"
                >
                  <MessageSquareReply className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Quick reply (AI)</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
