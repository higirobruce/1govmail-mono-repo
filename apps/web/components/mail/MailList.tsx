'use client';

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { formatDistanceToNowStrict, parseISO, startOfDay, subDays } from 'date-fns';
import { Loader2, Mail, Reply, Forward, Trash2, Star, MailOpen, MailCheck, FolderOpen, ChevronRight, ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Message {
  id: string;
  subject: string | null;
  snippet: string | null;
  fromName: string | null;
  fromEmail: string;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  tags: string[];
  receivedAt: string;
}

interface FolderItem {
  id: string;
  name: string;
  path: string;
  type?: string;
}

export interface ContextAction {
  type: 'reply' | 'forward' | 'markRead' | 'markUnread' | 'star' | 'unstar' | 'delete' | 'moveToFolder' | 'createTask';
  messageId: string;
  targetFolderId?: string;
}

interface MailListProps {
  messages: Message[];
  activeMessageId?: string;
  loading?: boolean;
  loadingMore?: boolean;
  onSelect: (messageId: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  onContextAction?: (action: ContextAction) => void;
  folders?: FolderItem[];
}

type Tab = 'all' | 'unread' | 'starred';


function formatDate(dateStr: string): string {
  try {
    const d = typeof dateStr === 'string' ? parseISO(dateStr) : new Date(dateStr);
    return formatDistanceToNowStrict(d, { addSuffix: false });
  } catch { return ''; }
}

interface Group { label: string; messages: Message[] }

function groupMessages(messages: Message[], tab: Tab): Group[] {
  let pool: Message[];
  let pinned: Message[] = [];

  if (tab === 'unread') {
    pool = messages.filter((m) => !m.isRead);
  } else if (tab === 'starred') {
    pool = messages.filter((m) => m.isStarred);
  } else {
    pinned = messages.filter((m) => m.isStarred);
    pool   = messages.filter((m) => !m.isStarred);
  }

  const now = new Date();
  const todayStart     = startOfDay(now);
  const yesterdayStart = subDays(todayStart, 1);
  const lastWeekStart  = subDays(todayStart, 7);

  const toGroup = (label: string, pred: (d: Date) => boolean): Group => ({
    label,
    messages: pool.filter((m) => {
      try { return pred(parseISO(m.receivedAt)); } catch { return false; }
    }),
  });

  const groups: Group[] = [];
  if (pinned.length > 0) groups.push({ label: 'Pinned', messages: pinned });
  [
    toGroup('Today',       (d) => d >= todayStart),
    toGroup('Yesterday',   (d) => d >= yesterdayStart && d < todayStart),
    toGroup('Last 7 days', (d) => d >= lastWeekStart  && d < yesterdayStart),
    toGroup('Older',       (d) => d < lastWeekStart),
  ].forEach((g) => { if (g.messages.length > 0) groups.push(g); });

  return groups;
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-muted/20">
      <span className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-wider shrink-0">
        {label}
      </span>
      <div className="flex-1 h-px bg-border/40" />
    </div>
  );
}

// ── Context menu ──────────────────────────────────────────────────────────────

const BUILTIN_PATHS_CTX = new Set([
  '/Inbox', '/Trash', '/Sent', '/Drafts', '/Archive', '/Starred',
  '/Junk', '/Spam', '/Contacts', '/Calendar', '/Tasks', '/Briefcase',
  '/Chats', '/Emailed Contacts',
]);

interface CtxMenuState { x: number; y: number; message: Message }

function ContextMenu({
  state,
  onAction,
  onClose,
  folders = [],
}: {
  state: CtxMenuState;
  onAction: (action: ContextAction) => void;
  onClose: () => void;
  folders?: FolderItem[];
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showFolders, setShowFolders] = useState(false);

  // Close on click-outside or Escape
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const click = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', down);
    document.addEventListener('mousedown', click);
    return () => {
      document.removeEventListener('keydown', down);
      document.removeEventListener('mousedown', click);
    };
  }, [onClose]);

  // Adjust position so menu stays within viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.min(state.y, window.innerHeight - 280),
    left: Math.min(state.x, window.innerWidth - 200),
    zIndex: 9999,
  };

  const labelFolders = folders.filter(
    (f) => !BUILTIN_PATHS_CTX.has(f.path) && (f.type === 'MAIL' || !f.type),
  );

  const item = (
    icon: React.ElementType,
    label: string,
    type: ContextAction['type'],
    danger = false,
  ) => {
    const Icon = icon;
    return (
      <button
        key={type}
        onMouseDown={(e) => { e.preventDefault(); onAction({ type, messageId: state.message.id }); onClose(); }}
        className={cn(
          'w-full flex items-center gap-2.5 px-3 py-2 text-[13px] rounded-md transition-colors',
          danger
            ? 'text-destructive/80 hover:bg-destructive/10 hover:text-destructive'
            : 'text-foreground/80 hover:bg-muted hover:text-foreground',
        )}
      >
        <Icon className="w-3.5 h-3.5 shrink-0" />
        {label}
      </button>
    );
  };

  return (
    <div
      ref={menuRef}
      style={style}
      className="bg-card border border-border/50 rounded-xl shadow-lg p-1.5 min-w-[180px]"
    >
      {item(Reply,      'Reply',          'reply')}
      {item(Forward,    'Forward',        'forward')}
      <div className="my-1 h-px bg-border/40" />
      {state.message.isRead
        ? item(MailCheck,  'Mark as Unread', 'markUnread')
        : item(MailOpen,   'Mark as Read',   'markRead')}
      {state.message.isStarred
        ? item(Star,       'Unstar',         'unstar')
        : item(Star,       'Star',           'star')}
      {item(ListTodo,   'Create Task',    'createTask')}
      {labelFolders.length > 0 && (
        <>
          <div className="my-1 h-px bg-border/40" />
          <button
            onMouseDown={(e) => { e.preventDefault(); setShowFolders((v) => !v); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] rounded-md transition-colors text-foreground/80 hover:bg-muted hover:text-foreground"
          >
            <FolderOpen className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1 text-left">Move to folder</span>
            <ChevronRight className={cn('w-3 h-3 transition-transform', showFolders && 'rotate-90')} />
          </button>
          {showFolders && (
            <div className="pl-4 space-y-0.5">
              {labelFolders.map((folder) => (
                <button
                  key={folder.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onAction({ type: 'moveToFolder', messageId: state.message.id, targetFolderId: folder.id });
                    onClose();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] rounded-md text-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
                >
                  <FolderOpen className="w-3 h-3 shrink-0 text-muted-foreground/50" />
                  {folder.name}
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <div className="my-1 h-px bg-border/40" />
      {item(Trash2,     'Delete',         'delete',  true)}
    </div>
  );
}

// ── Mail row ──────────────────────────────────────────────────────────────────

function MailRow({
  message,
  active,
  onClick,
  onContextMenu,
}: {
  message: Message;
  active: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        'w-full text-left px-4 py-3 border-b border-border/25 transition-all group relative',
        active
          ? 'bg-primary/8 border-l-2 border-l-primary'
          : 'hover:bg-muted/30 border-l-2 border-l-transparent',
      )}
    >
      <div className="flex items-start gap-3">
        {/* Unread dot */}
        <div className="mt-[9px] shrink-0 w-1.5 h-1.5">
          {!message.isRead && <div className="w-1.5 h-1.5 rounded-full bg-primary" />}
        </div>

        {/* Text */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-0.5">
            <span className={cn(
              'text-[13px] truncate pr-2',
              message.isRead ? 'text-foreground/80 font-normal' : 'text-foreground font-semibold',
            )}>
              {message.fromName ?? message.fromEmail}
            </span>
            <span className="text-[11px] text-muted-foreground/65 shrink-0 tabular-nums">
              {formatDate(message.receivedAt)}
            </span>
          </div>

          <p className={cn(
            'text-[12px] truncate mb-0.5',
            message.isRead ? 'text-muted-foreground/80' : 'text-foreground/80 font-medium',
          )}>
            {message.subject ?? '(no subject)'}
          </p>

          <p className="text-[11px] text-muted-foreground/65 truncate leading-relaxed">
            {message.snippet}
          </p>
        </div>
      </div>
    </button>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'all',     label: 'All' },
  { id: 'unread',  label: 'Unread' },
  { id: 'starred', label: 'Starred' },
];

export default function MailList({
  messages,
  activeMessageId,
  loading,
  loadingMore,
  onSelect,
  onLoadMore,
  hasMore,
  onContextAction,
  folders = [],
}: MailListProps) {
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);

  // Infinite scroll
  const scrollRef      = useRef<HTMLDivElement>(null);
  const sentinelRef    = useRef<HTMLDivElement>(null);
  const onLoadMoreRef  = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  // Keep a ref for `loading` so the observer callback always reads the latest
  // value without needing it in the deps array (avoids re-creating observer mid-load)
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  useEffect(() => {
    const el   = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;
    // Re-create the observer whenever messages.length changes so that if the
    // sentinel is already visible after a batch loads, the observer fires again
    // (IntersectionObserver fires immediately on initial observation).
    const observer = new IntersectionObserver(
      (entries) => {
        // Guard: don't fire during an initial/reset load — prevents a race where
        // stale hasMore=true from a previous folder triggers loadMore on the new folder
        if (entries[0].isIntersecting && !loadingRef.current) {
          onLoadMoreRef.current?.();
        }
      },
      { root, threshold: 0, rootMargin: '100px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleContextMenu = useCallback((e: React.MouseEvent, message: Message) => {
    if (!onContextAction) return;
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, message });
  }, [onContextAction]);

  const handleContextAction = useCallback((action: ContextAction) => {
    onContextAction?.(action);
    setCtxMenu(null);
  }, [onContextAction]);

  const groups = useMemo(() => groupMessages(messages, activeTab), [messages, activeTab]);
  const totalFiltered = groups.reduce((s, g) => s + g.messages.length, 0);

  // Loading skeleton
  if (loading && messages.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex gap-1 px-3 py-2.5 border-b border-border/25 shrink-0">
          {TABS.map((t) => (
            <div key={t.id} className="h-6 w-14 bg-muted/60 rounded-full animate-pulse" />
          ))}
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="px-4 py-3 border-b border-border/25 animate-pulse">
            <div className="flex items-start gap-3">
              <div className="w-1.5 h-1.5 mt-2 rounded-full shrink-0" />
              <div className="w-8 h-8 rounded-[6px] bg-muted shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="flex justify-between">
                  <div className="h-3 w-24 bg-muted rounded" />
                  <div className="h-3 w-10 bg-muted/50 rounded" />
                </div>
                <div className="h-3 w-40 bg-muted/70 rounded" />
                <div className="h-2.5 w-32 bg-muted/40 rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Tab bar */}
        <div className="flex gap-1 px-3 py-2.5 border-b border-border/25 shrink-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'px-3 py-1 rounded-full text-[12px] font-medium transition-all',
                activeTab === tab.id
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
          {/* Empty state */}
          {totalFiltered === 0 && !loading && (
            <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
              <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
                <Mail className="w-5 h-5 text-muted-foreground/30" />
              </div>
              <p className="text-sm text-muted-foreground/60">No messages</p>
            </div>
          )}

          {/* Grouped messages */}
          {groups.map((group) => (
            <div key={group.label}>
              <SectionHeader label={group.label} />
              {group.messages.map((msg) => (
                <MailRow
                  key={msg.id}
                  message={msg}
                  active={activeMessageId === msg.id}
                  onClick={() => onSelect(msg.id)}
                  onContextMenu={(e) => handleContextMenu(e, msg)}
                />
              ))}
            </div>
          ))}

          {/* Infinite scroll sentinel + manual fallback */}
          <div ref={sentinelRef} className="py-3 flex justify-center">
            {(loadingMore && hasMore) ? (
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/40" />
            ) : hasMore ? (
              <button
                onClick={() => onLoadMore?.()}
                className="text-[11px] text-muted-foreground/50 hover:text-foreground/70 transition-colors px-3 py-1 rounded-md hover:bg-muted/50"
              >
                Load more
              </button>
            ) : messages.length > 0 ? (
              <span className="text-[11px] text-muted-foreground/30">All messages loaded</span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Context menu portal */}
      {ctxMenu && (
        <ContextMenu
          state={ctxMenu}
          onAction={handleContextAction}
          onClose={() => setCtxMenu(null)}
          folders={folders}
        />
      )}
    </>
  );
}
