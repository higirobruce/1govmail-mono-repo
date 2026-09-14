'use client';

import { formatDistanceToNow, parseISO } from 'date-fns';
import {
  X, Reply, ReplyAll, Forward, ScrollText, FileText,
  MessageSquareReply, MessagesSquare, MoreVertical,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  onClose: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onSummarize?: () => void;
  summarizing?: boolean;
  onDraftDoc?: () => void;
  drafting?: boolean;
  onQuickReply?: () => void;
  onAskThread?: () => void;
}

/**
 * One descriptor per action, rendered two ways: as the desktop toolbar row and
 * as the phone overflow menu. Keeping a single list is the point — the two
 * surfaces cannot drift as actions are added, which is exactly what happened
 * while each was hand-written inline.
 */
interface ThreadAction {
  key: string;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  /** Renders the label, not just an icon, in the desktop row. */
  prominent?: boolean;
  busy?: boolean;
}

export default function ThreadHeader({
  subject,
  participants,
  messageCount,
  unreadCount,
  lastReceivedAt,
  onClose,
  onReply,
  onReplyAll,
  onForward,
  onSummarize,
  summarizing,
  onDraftDoc,
  drafting,
  onQuickReply,
  onAskThread,
}: Props) {
  const lastActivity = (() => {
    try {
      return formatDistanceToNow(parseISO(lastReceivedAt), { addSuffix: true });
    } catch {
      return '';
    }
  })();

  const visibleParticipants = participants.slice(0, 5);
  const extraParticipantCount = participants.length - visibleParticipants.length;

  const mailActions: ThreadAction[] = [
    { key: 'reply', icon: Reply, label: 'Reply', onClick: onReply },
    { key: 'reply-all', icon: ReplyAll, label: 'Reply all', onClick: onReplyAll },
    { key: 'forward', icon: Forward, label: 'Forward', onClick: onForward },
  ];

  const aiActions: ThreadAction[] = [
    onSummarize && {
      key: 'summarize', icon: ScrollText, label: 'Summarize',
      onClick: onSummarize, prominent: true, busy: summarizing,
    },
    onDraftDoc && {
      key: 'draft-doc', icon: FileText, label: 'Draft doc',
      onClick: onDraftDoc, prominent: true, busy: drafting,
    },
    onAskThread && {
      key: 'ask-thread', icon: MessagesSquare, label: 'Ask about this thread',
      onClick: onAskThread, prominent: true,
    },
    onQuickReply && {
      key: 'quick-reply', icon: MessageSquareReply, label: 'Quick reply (AI)',
      onClick: onQuickReply,
    },
  ].filter(Boolean) as ThreadAction[];

  /** The Ask pill's accessible name is a sentence; its visible label is one word. */
  const shortLabel = (a: ThreadAction) =>
    a.key === 'ask-thread' ? 'Ask' : a.key === 'quick-reply' ? 'Quick reply' : a.label;

  const iconButton = (a: ThreadAction) => (
    <Tooltip key={a.key}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={a.onClick}
          disabled={a.busy}
          className="text-ink-3 hover:bg-muted hover:text-foreground"
          aria-label={a.label}
        >
          <a.icon className="w-4 h-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">{a.label}</TooltipContent>
    </Tooltip>
  );

  const pill = (a: ThreadAction) => (
    <button
      key={a.key}
      onClick={a.onClick}
      disabled={a.busy}
      className={cn(
        'inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap px-2.5 py-1 rounded-full text-ui font-medium transition-colors',
        a.busy ? 'bg-primary/15 text-primary' : 'bg-primary/10 text-primary hover:bg-primary/20',
      )}
      aria-label={a.label}
      title={a.label}
    >
      <a.icon className={cn('w-3.5 h-3.5', a.busy && 'animate-pulse')} />
      <span>{shortLabel(a)}</span>
    </button>
  );

  return (
    <div className="border-b border-border-faint bg-background shrink-0">
      <div className="px-6 pt-4 pb-4">
        {/* Toolbar row — close on the left, actions on the right. Below sm the
            whole action row collapses into one overflow menu: seven targets do
            not fit a phone-width toolbar, and icon-only pills were unreadable. */}
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

          {/* Desktop: everything visible, mail actions divided from AI actions */}
          <div className="hidden sm:flex items-center gap-1 shrink-0">
            {mailActions.map(iconButton)}
            {aiActions.length > 0 && (
              <span
                data-testid="thread-action-divider"
                aria-hidden="true"
                className="w-px h-4 bg-border mx-1"
              />
            )}
            {aiActions.map((a) => (a.prominent ? pill(a) : iconButton(a)))}
          </div>

          {/* Phone: one trigger, labeled options */}
          <div className="sm:hidden shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-ink-3 hover:bg-muted hover:text-foreground"
                  aria-label="More actions"
                >
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {mailActions.map((a) => (
                  <DropdownMenuItem key={a.key} onSelect={a.onClick}>
                    <a.icon className="w-4 h-4" />
                    {a.label}
                  </DropdownMenuItem>
                ))}
                {aiActions.length > 0 && <DropdownMenuSeparator />}
                {aiActions.map((a) => (
                  <DropdownMenuItem key={a.key} onSelect={a.onClick} disabled={a.busy}>
                    <a.icon className="w-4 h-4" />
                    {a.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
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
