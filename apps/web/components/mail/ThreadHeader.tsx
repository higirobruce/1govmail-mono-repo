'use client';

import { formatDistanceToNow, parseISO } from 'date-fns';
import { X, Reply, ReplyAll, Forward, Sparkles, MessageSquareReply } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
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

function deriveStatus(
  lastSenderEmail: string,
  currentUserEmail: string,
  unreadCount: number,
): { label: string; className: string } {
  if (unreadCount > 0) {
    return {
      label: `${unreadCount} unread`,
      className: 'bg-primary/10 text-primary border border-primary/20',
    };
  }
  if (lastSenderEmail.toLowerCase() === currentUserEmail.toLowerCase()) {
    return {
      label: 'You replied',
      className: 'bg-muted text-ink-3 border border-border',
    };
  }
  return {
    label: 'Awaiting reply',
    className: 'bg-warning/10 text-warning-strong border border-warning/20',
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
    <div className="border-b border-border-faint bg-background shrink-0">
      <div className="px-6 pt-4 pb-4">
        {/* Toolbar row — close on the left, status + quick actions on the right;
            the title gets its own uncrowded line below (Image-3 pattern) */}
        <div className="flex items-center gap-2 mb-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                className="-ml-2 text-ink-3 hover:bg-muted hover:text-foreground shrink-0"
                aria-label="Close thread"
              >
                <X className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">Close</TooltipContent>
          </Tooltip>
          <div className="flex-1" />
          <span
            className={cn(
              'text-micro px-2 py-0.5 rounded-full shrink-0 font-medium whitespace-nowrap',
              status.className,
            )}
          >
            {status.label}
          </span>
        <div className="flex items-center gap-0 shrink-0">
          {[
            { icon: Reply,    label: 'Reply',     onClick: onReply },
            { icon: ReplyAll, label: 'Reply All', onClick: onReplyAll },
            { icon: Forward,  label: 'Forward',   onClick: onForward },
          ].map(({ icon: Icon, label, onClick }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onClick}
                  className="text-ink-3 hover:bg-muted hover:text-foreground"
                  aria-label={label}
                >
                  <Icon className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{label}</TooltipContent>
            </Tooltip>
          ))}
          {onSummarize && (
            <button
              onClick={onSummarize}
              disabled={summarizing}
              className={cn(
                'inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap px-2.5 py-1 rounded-full text-ui font-medium transition-colors',
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
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onQuickReply}
                  className="text-ink-3 hover:bg-muted hover:text-foreground"
                  aria-label="Quick reply (AI)"
                >
                  <MessageSquareReply className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Quick reply (AI)</TooltipContent>
            </Tooltip>
          )}
        </div>
        </div>

        {/* Title — alone on its line */}
        <h1 className="text-display text-balance text-foreground">
          {subject ?? '(no subject)'}
        </h1>

        <div className="min-w-0">

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
                <div className="w-6 h-6 rounded-full bg-muted text-ink-2 text-micro leading-none font-medium flex items-center justify-center ring-1 ring-background">
                  +{extraParticipantCount}
                </div>
              )}
            </div>
            <span className="text-micro font-normal text-ink-3">
              {messageCount} message{messageCount !== 1 ? 's' : ''}
              {unreadCount > 0 && ` · ${unreadCount} unread`}
              {lastActivity && ` · ${lastActivity}`}
            </span>
          </div>
        </div>

      </div>
    </div>
  );
}
