'use client';

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { formatDistanceToNowStrict, parseISO, startOfDay, subDays } from 'date-fns';
import { Loader2, Mail, Reply, Forward, Trash2, Star, MailOpen, MailCheck, FolderOpen, ChevronRight, ListTodo, AlarmClock, BellOff, X, CalendarPlus, Paperclip, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MailAvatar } from './MailAvatar';
import { ClassificationChip } from './ClassificationChip';

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

export interface TriageCard {
  label: string;
  injectionSuspected: boolean;
}

const TRIAGE_LABEL_META: Record<string, { text: string; textClass: string; dotClass: string }> = {
  needsDecision: { text: 'Needs decision', textClass: 'text-destructive', dotClass: 'bg-destructive' },
  waitingOnYou: { text: 'Waiting on you', textClass: 'text-amber-600 dark:text-amber-400', dotClass: 'bg-amber-500' },
  deadline: { text: 'Deadline', textClass: 'text-blue-600 dark:text-blue-400', dotClass: 'bg-blue-500' },
  // fyi intentionally renders nothing — not high-signal enough to warrant a badge.
};

export interface ContextAction {
  type: 'reply' | 'forward' | 'markRead' | 'markUnread' | 'star' | 'unstar' | 'delete' | 'moveToFolder' | 'createTask' | 'createEvent' | 'snooze' | 'mute' | 'print';
  messageId: string;
  targetFolderId?: string;
}

export interface BulkAction {
  type: 'markRead' | 'markUnread' | 'delete' | 'move';
  messageIds: string[];
  targetFolderId?: string;
}

interface MailListProps {
  messages: Message[];
  activeMessageId?: string;
  loading?: boolean;
  loadingMore?: boolean;
  onSelect: (messageId: string) => void;
  /** Warm the message-body cache when a row is hovered, so the click opens instantly. */
  onPrefetch?: (messageId: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  onContextAction?: (action: ContextAction) => void;
  onBulkAction?: (action: BulkAction) => void;
  folders?: FolderItem[];
  mutedConversationIds?: string[];
  /** Override for the empty-state render. Defaults to the generic "No messages" block. */
  emptyState?: React.ReactNode;
  /** When non-empty, only messages whose `tags` array intersects this set are shown. */
  filterTagNames?: Set<string>;
  /** Persisted triage cards keyed by message id — drives the row label badge. */
  cardsById?: Record<string, TriageCard>;
}

type Tab = 'all' | 'unread' | 'starred';


function formatDate(dateStr: string): string {
  try {
    const d = typeof dateStr === 'string' ? parseISO(dateStr) : new Date(dateStr);
    return formatDistanceToNowStrict(d, { addSuffix: false });
  } catch { return ''; }
}

interface Group { label: string; messages: Message[] }

function groupMessages(messages: Message[], tab: Tab, stickyIds: Set<string>): Group[] {
  let pool: Message[];
  let pinned: Message[] = [];

  // `stickyIds` keeps just-opened messages visible even after they stop matching
  // the current filter (e.g. a message opened in the Unread tab gets marked read
  // and would otherwise vanish mid-read — confusing because its detail is still
  // shown in the right pane). The sticky set clears on tab switch.
  if (tab === 'unread') {
    pool = messages.filter((m) => !m.isRead || stickyIds.has(m.id));
  } else if (tab === 'starred') {
    pool = messages.filter((m) => m.isStarred || stickyIds.has(m.id));
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
    <div className="px-4 pt-3 pb-1">
      <span className="text-[10.5px] font-semibold text-muted-foreground/55 uppercase tracking-[0.06em]">
        {label}
      </span>
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
  mutedConversationIds = [],
}: {
  state: CtxMenuState;
  onAction: (action: ContextAction) => void;
  onClose: () => void;
  folders?: FolderItem[];
  mutedConversationIds?: string[];
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

  const conversationId = (state.message as any).conversationId;
  const isMuted = conversationId && mutedConversationIds.includes(conversationId);

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
      {item(AlarmClock, 'Snooze',         'snooze')}
      {item(BellOff,    isMuted ? 'Unmute conversation' : 'Mute conversation', 'mute')}
      {item(ListTodo,     'Create Task',    'createTask')}
      {item(CalendarPlus, 'Create Event',   'createEvent')}
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
  onHover,
  onContextMenu,
  selected,
  onSelect,
  card,
}: {
  message: Message;
  active: boolean;
  onClick: () => void;
  onHover?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  selected?: boolean;
  onSelect?: () => void;
  card?: TriageCard;
}) {
  const classification = useMemo(() => pickClassificationFromTags(message.tags), [message.tags]);
  const labelMeta = card ? TRIAGE_LABEL_META[card.label] : undefined;

  return (
    <div className="px-2 pt-1 first:pt-2 last:pb-2">
      <div
        draggable
        onMouseEnter={onHover}
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-govmail-msg', JSON.stringify({
            id: message.id,
            subject: message.subject,
            snippet: message.snippet,
            from: message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail,
          }));
          e.dataTransfer.effectAllowed = 'copy';
        }}
        className={cn(
          'group relative rounded-2xl transition-all',
          active
            ? 'bg-card shadow-[0_2px_8px_rgba(15,76,129,0.08)] ring-1 ring-primary/15'
            : selected
            ? 'bg-primary/5 ring-1 ring-primary/20'
            : !message.isRead
            ? 'bg-card hover:bg-card ring-1 ring-border/40'
            : 'hover:bg-muted/40',
        )}
      >
        {!message.isRead && !active && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 h-6 w-1 rounded-r-full bg-primary" aria-hidden />
        )}
        <div className="flex items-start gap-2 px-2.5 py-2.5">
          {/* Checkbox — always visible at low opacity, full on hover/select */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onSelect?.(); }}
            className={cn(
              'shrink-0 mt-[3px] transition-opacity',
              selected || active ? 'opacity-100' : 'opacity-50 group-hover:opacity-100',
            )}
            aria-label={selected ? 'Deselect message' : 'Select message'}
          >
            <div className={cn(
              'w-4 h-4 rounded-md border-2 flex items-center justify-center transition-colors',
              selected ? 'bg-primary border-primary' : 'border-muted-foreground/30 hover:border-primary/50',
            )}>
              {selected && (
                <svg className="w-2.5 h-2.5 text-primary-foreground" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 6l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
          </button>

          {/* Avatar */}
          <button
            onClick={onClick}
            onContextMenu={onContextMenu}
            className="flex-1 min-w-0 flex items-start gap-2.5 text-left"
          >
            <MailAvatar
              name={message.fromName}
              email={message.fromEmail}
              size="sm"
            />

            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2 mb-0.5">
                <span className={cn(
                  'text-[13px] truncate',
                  message.isRead ? 'text-foreground/85 font-normal' : 'text-primary font-semibold',
                )}>
                  {message.fromName ?? message.fromEmail}
                </span>
                <span className={cn(
                  'shrink-0 inline-flex items-center gap-1 tabular-nums',
                  message.isRead ? 'text-[11px] text-muted-foreground/60' : 'text-[11px] text-primary font-semibold',
                )}>
                  {!message.isRead && <span className="w-1.5 h-1.5 rounded-full bg-primary" aria-hidden />}
                  {formatDate(message.receivedAt)}
                </span>
              </div>

              <p className={cn(
                'text-[12.5px] truncate mb-0.5',
                message.isRead ? 'text-foreground/70' : 'text-foreground font-semibold',
              )}>
                {message.subject ?? '(no subject)'}
              </p>

              <p className="text-[11.5px] text-muted-foreground/70 truncate leading-snug">
                {message.snippet}
              </p>

              {/* Chip strip — attachment + classification + triage label */}
              {(message.hasAttachments || classification || labelMeta || card?.injectionSuspected) && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  {message.hasAttachments && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/80 bg-muted/60 rounded-full px-1.5 py-0.5">
                      <Paperclip className="w-2.5 h-2.5" />
                      Attachment
                    </span>
                  )}
                  {classification && <ClassificationChip value={classification} size="xs" />}
                  {labelMeta && (
                    <span className={cn('inline-flex items-center gap-1 text-[10px] font-medium', labelMeta.textClass)}>
                      <span className={cn('w-1.5 h-1.5 rounded-full', labelMeta.dotClass)} aria-hidden />
                      {labelMeta.text}
                    </span>
                  )}
                  {card?.injectionSuspected && (
                    <span title="This message contains text addressed to an AI — verify carefully">
                      <AlertTriangle
                        className="w-3 h-3 text-amber-500"
                        aria-label="This message contains text addressed to an AI — verify carefully"
                      />
                    </span>
                  )}
                </div>
              )}
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Pick the highest-severity classification label out of a tags array.
 *  Inlined here so MailRow doesn't import lib/classification — keeps the row
 *  cheap to re-render and the import surface tight. */
function pickClassificationFromTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  const order = ['Confidential', 'Restricted', 'Internal Use Only', 'Unclassified'];
  for (const o of order) if (tags.includes(o)) return o;
  return null;
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
  onPrefetch,
  onLoadMore,
  hasMore,
  onContextAction,
  onBulkAction,
  folders = [],
  mutedConversationIds = [],
  emptyState,
  filterTagNames,
  cardsById,
}: MailListProps) {
  const [activeTab, setActiveTab] = useState<Tab>('all');
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Messages opened on a filtered tab that should remain visible even after they
  // stop matching the filter — see `groupMessages` for the rationale.
  const [stickyIds, setStickyIds] = useState<Set<string>>(new Set());

  // Reset sticky pins whenever the tab changes — each tab gets a fresh view.
  useEffect(() => { setStickyIds(new Set()); }, [activeTab]);

  // Pin the currently-selected message on filtered tabs so marking it read /
  // toggling its star doesn't make the row vanish while the user is reading it.
  useEffect(() => {
    if (!activeMessageId || activeTab === 'all') return;
    setStickyIds((prev) => {
      if (prev.has(activeMessageId)) return prev;
      const next = new Set(prev);
      next.add(activeMessageId);
      return next;
    });
  }, [activeMessageId, activeTab]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Infinite scroll
  const scrollRef      = useRef<HTMLDivElement>(null);
  const sentinelRef    = useRef<HTMLDivElement>(null);
  const onLoadMoreRef  = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  // Keep refs so observer callbacks always read latest values without needing
  // them in deps (avoids recreating the observer on every render).
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;

  useEffect(() => {
    const el   = sentinelRef.current;
    const root = scrollRef.current;
    // Refs are null during the skeleton render (early-return path).  Once the
    // initial load finishes, `loading` flips to false, this effect re-runs, and
    // by then both refs are attached to the real DOM nodes.
    // Also re-run when hasMore changes: IntersectionObserver only fires on state
    // *changes*, so if the sentinel was already visible when loading went false
    // (and hasMore was still false at that moment), we need a fresh observer
    // once hasMore becomes true so the initial-entry notification fires again.
    if (!el || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingRef.current && hasMoreRef.current) {
          onLoadMoreRef.current?.();
        }
      },
      { root, threshold: 0, rootMargin: '100px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, hasMore]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleContextMenu = useCallback((e: React.MouseEvent, message: Message) => {
    if (!onContextAction) return;
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, message });
  }, [onContextAction]);

  const handleContextAction = useCallback((action: ContextAction) => {
    onContextAction?.(action);
    setCtxMenu(null);
  }, [onContextAction]);

  // After a page finishes loading on the 'all' tab, do a one-shot re-observe so
  // the IntersectionObserver fires again if the sentinel is still in view (e.g.
  // the new batch didn't push it below the fold).  We intentionally skip this
  // for filtered tabs (unread / starred) — those are short client-side views
  // where the sentinel is almost always visible, and firing repeatedly would
  // cascade through all pages causing the UI instability we just fixed.
  const loadingMoreRef = useRef(loadingMore);
  loadingMoreRef.current = loadingMore;
  useEffect(() => {
    if (activeTab !== 'all') return;
    if (loadingMore) return;               // load in progress — wait for it to finish
    if (!hasMoreRef.current) return;       // nothing left to fetch
    const el   = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;
    // Re-observe once: if the sentinel is still intersecting after the load, the
    // callback fires immediately and fetches the next page; if not, the observer
    // idles until the user scrolls.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingRef.current && hasMoreRef.current) {
          onLoadMoreRef.current?.();
        }
        observer.disconnect();
      },
      { root, threshold: 0, rootMargin: '100px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadingMore, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredMessages = useMemo(() => {
    if (!filterTagNames || filterTagNames.size === 0) return messages;
    return messages.filter((m) => m.tags?.some((t) => filterTagNames.has(t)));
  }, [messages, filterTagNames]);
  const groups = useMemo(() => groupMessages(filteredMessages, activeTab, stickyIds), [filteredMessages, activeTab, stickyIds]);
  const totalFiltered = groups.reduce((s, g) => s + g.messages.length, 0);

  // Loading skeleton
  if (loading && messages.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2.5 shrink-0">
          <div className="inline-flex p-0.5 rounded-full bg-muted/60">
            {TABS.map((t) => (
              <div key={t.id} className="h-6 w-14 rounded-full animate-pulse" />
            ))}
          </div>
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="px-2 pt-1">
            <div className="rounded-2xl px-2.5 py-2.5 animate-pulse">
              <div className="flex items-start gap-2.5">
                <div className="w-4 h-4 mt-[3px] rounded-md bg-muted/60 shrink-0" />
                <div className="w-8 h-8 rounded-full bg-muted shrink-0" />
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
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-full">
        {/* Tab bar — segmented-control style */}
        <div className="px-3 py-2.5 shrink-0">
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-full bg-muted/60">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'px-3.5 py-1 rounded-full text-[12px] font-medium transition-all',
                  activeTab === tab.id
                    ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                    : 'text-muted-foreground/80 hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
          {/* Empty state */}
          {totalFiltered === 0 && !loading && (
            emptyState ?? (
              <div className="flex flex-col items-center justify-center py-16 px-8 text-center">
                <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
                  <Mail className="w-5 h-5 text-muted-foreground/30" />
                </div>
                <p className="text-sm text-muted-foreground/60">No messages</p>
              </div>
            )
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
                  onHover={onPrefetch ? () => onPrefetch(msg.id) : undefined}
                  onContextMenu={(e) => handleContextMenu(e, msg)}
                  selected={selectedIds.has(msg.id)}
                  onSelect={() => toggleSelect(msg.id)}
                  card={cardsById?.[msg.id]}
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
          mutedConversationIds={mutedConversationIds}
        />
      )}

      {/* Floating bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 bg-card border border-border/60 rounded-2xl shadow-xl">
          <span className="text-[12px] font-medium text-foreground/70 mr-1">
            {selectedIds.size} selected
          </span>
          <button
            onClick={() => { onBulkAction?.({ type: 'markRead', messageIds: [...selectedIds] }); clearSelection(); }}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 transition-colors"
          >
            Mark read
          </button>
          <button
            onClick={() => { onBulkAction?.({ type: 'markUnread', messageIds: [...selectedIds] }); clearSelection(); }}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-muted/60 text-foreground/70 hover:bg-muted transition-colors"
          >
            Mark unread
          </button>
          <button
            onClick={() => { onBulkAction?.({ type: 'delete', messageIds: [...selectedIds] }); clearSelection(); }}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
          >
            Delete
          </button>
          <button
            onClick={clearSelection}
            className="ml-1 p-1 rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </>
  );
}
