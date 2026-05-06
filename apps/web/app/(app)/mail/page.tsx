'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import Sidebar from '@/components/layout/Sidebar';
import { MobileSidebarSheet } from '@/components/layout/MobileSidebarSheet';
import MailList, { type ContextAction, type BulkAction } from '@/components/mail/MailList';
import { InboxZero } from '@/components/mail/InboxZero';
import SnoozeModal from '@/components/mail/SnoozeModal';
import MailDetail from '@/components/mail/MailDetail';
import ThreadView from '@/components/mail/ThreadView';
import ComposeModal, { type ComposeMode } from '@/components/mail/ComposeModal';
import TaskModal from '@/components/tasks/TaskModal';
import { KeyboardShortcutsModal } from '@/components/mail/KeyboardShortcutsModal';
import { GlobalSearch } from '@/components/GlobalSearch';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { Input } from '@/components/ui/input';
import { Search, RefreshCw, X as XIcon, Menu, ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useOffline } from '@/lib/offline/provider';
import { toast } from 'sonner';

export default function MailPage() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [hydrated, setHydrated] = useState(false);

  const queryClient = useQueryClient();
  const offline = useOffline();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [folders, setFolders] = useState<any[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string>('');
  const [activeMessageId, setActiveMessageId] = useState<string | undefined>();
  const [activeMessage, setActiveMessage] = useState<any | null>(null);

  const [loadingMessage, setLoadingMessage] = useState(false);

  // Increment after sending a reply to force ThreadView to re-fetch the conversation.
  const [threadRefreshKey, setThreadRefreshKey] = useState(0);

  // ── TanStack Query: paginated message list ─────────────────────────────────
  const {
    data: messagesData,
    fetchNextPage,
    hasNextPage,
    isFetching: loadingMessages,
    isFetchingNextPage: loadingMore,
    refetch: refetchMessages,
  } = useInfiniteQuery({
    queryKey: ['messages', activeFolderId],
    queryFn: async ({ pageParam = 0 }) => {
      const offset = pageParam as number;
      const isFirstPage = offset === 0;
      const onlineNow = typeof navigator === 'undefined' ? true : navigator.onLine;

      if (!onlineNow && isFirstPage) {
        const cached = await offline.mail.getFolderPage(activeFolderId);
        if (cached) return cached as { messages: any[]; hasMore: boolean; total: number };
        throw new Error('Offline and no cached messages for this folder');
      }

      try {
        const data = await api.mail.getMessages(activeFolderId, 50, offset);
        if (isFirstPage) {
          void offline.mail.setFolderPage(activeFolderId, data);
        }
        return data;
      } catch (err) {
        if (isFirstPage) {
          const cached = await offline.mail.getFolderPage(activeFolderId);
          if (cached) return cached as { messages: any[]; hasMore: boolean; total: number };
        }
        throw err;
      }
    },
    getNextPageParam: (lastPage: any, allPages: any[]) =>
      lastPage.hasMore
        ? allPages.reduce((sum: number, p: any) => sum + p.messages.length, 0)
        : undefined,
    initialPageParam: 0,
    enabled: !!activeFolderId,
    staleTime: 2 * 60_000,
  });

  // Flatten paginated pages into a single messages array
  const messages: any[] = messagesData?.pages.flatMap((p: any) => p.messages) ?? [];

  /** Invalidate the current folder cache (e.g. after send/delete/move) */
  const invalidateMessages = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['messages', activeFolderId] });
  }, [queryClient, activeFolderId]);

  /** Optimistically update a single message in the cache */
  const updateMessageInCache = useCallback((folderId: string, messageId: string, update: (m: any) => any) => {
    queryClient.setQueryData(['messages', folderId], (old: any) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page: any) => ({
          ...page,
          messages: page.messages.map((m: any) => m.id === messageId ? update(m) : m),
        })),
      };
    });
  }, [queryClient]);

  /** Optimistically remove a single message from the cache */
  const removeMessageFromCache = useCallback((folderId: string, messageId: string) => {
    queryClient.setQueryData(['messages', folderId], (old: any) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page: any) => ({
          ...page,
          messages: page.messages.filter((m: any) => m.id !== messageId),
        })),
      };
    });
  }, [queryClient]);

  // ── Snooze state ───────────────────────────────────────────────────────────
  const [snoozeTarget, setSnoozeTarget] = useState<{ messageId: string; folderId: string } | null>(null);

  // ── Mute state ─────────────────────────────────────────────────────────────
  const [mutedConversationIds, setMutedConversationIds] = useState<string[]>([]);

  // Load muted conversations once on mount
  useEffect(() => {
    if (!isAuthenticated) return;
    api.mail.getMuted().then(setMutedConversationIds).catch(() => {});
  }, [isAuthenticated]);

  // ── Create-task-from-email state ───────────────────────────────────────────
  const [createTaskPrefill, setCreateTaskPrefill] = useState<{ linkedMessageId: string; linkedSubject: string } | null>(null);

  // ── Deep-link: open specific message via ?open=<messageId> ────────────────
  useEffect(() => {
    if (!hydrated || !isAuthenticated || !activeFolderId) return;
    const params = new URLSearchParams(window.location.search);
    const openId = params.get('open');
    if (!openId) return;
    // Clean up the URL without navigating
    window.history.replaceState({}, '', window.location.pathname);
    openMessage(openId);
  }, [hydrated, isAuthenticated, activeFolderId]); // eslint-disable-line

  // ── Compose state ──────────────────────────────────────────────────────────
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeMode, setComposeMode] = useState<ComposeMode>('new');
  /** Populated when the user opens a draft — passed as initial values to ComposeModal */
  const [composeDraftProps, setComposeDraftProps] = useState<{
    zimbraId: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
  } | null>(null);

  // ── Search state ───────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery]     = useState('');
  const [searchInput, setSearchInput]     = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchTotal, setSearchTotal]     = useState(0);
  const searchOffsetRef = useRef(0);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [loadingSearch, setLoadingSearch]     = useState(false);
  const [loadingMoreSearch, setLoadingMoreSearch] = useState(false);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSearchMode = searchQuery.trim().length > 0;
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ── Keyboard shortcuts modal ────────────────────────────────────────────────
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false);

  // ── Global search (⌘K) ─────────────────────────────────────────────────────
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);

  // ── Electron background polling ────────────────────────────────────────────
  // Tracks the last known inbox unread count so we can detect new arrivals.
  // The BrowserWindow is never destroyed when minimised to tray, so this
  // interval keeps running and can fire native notifications even while the
  // window is hidden.
  const lastInboxUnreadRef = useRef<number | null>(null);

  // Wait for Zustand persist to hydrate from localStorage before any redirect
  useEffect(() => {
    const unsub = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
    if (useAuthStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);

  // Redirect if not authenticated (only after hydration)
  useEffect(() => {
    if (!hydrated) return;
    if (!isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  // Electron: poll the inbox unread count every 2 minutes and fire native
  // notifications when new messages arrive.  Works whether the window is
  // visible or hidden in the system tray.
  useEffect(() => {
    if (!isAuthenticated) return;
    // Only enable polling when running inside the Electron desktop app
    if (!window.electronAPI?.isElectron) return;

    const checkInbox = async () => {
      try {
        const data: any[] = await api.mail.getFolders();
        const inbox = data.find((f) => f.path === '/Inbox');
        if (!inbox) return;

        const currentUnread: number = inbox.unreadCount ?? 0;
        const prev = lastInboxUnreadRef.current;

        if (prev !== null && currentUnread > prev) {
          const newCount = currentUnread - prev;
          window.electronAPI?.sendNotification(
            `${newCount} new message${newCount !== 1 ? 's' : ''}`,
            `You have ${currentUnread} unread message${currentUnread !== 1 ? 's' : ''} in your inbox.`,
          );
        }

        // Update Dock badge on macOS
        window.electronAPI?.setBadgeCount(currentUnread);

        lastInboxUnreadRef.current = currentUnread;

        // Also refresh the sidebar folder list if unread counts shifted
        setFolders(data);
      } catch {
        // Polling is best-effort — silent failure keeps the app stable
      }
    };

    // First check 10 s after mount (give the initial folder load time to finish)
    const initial = setTimeout(checkInbox, 10_000);
    // Subsequent checks every 2 minutes
    const interval = setInterval(checkInbox, 2 * 60 * 1000);

    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [isAuthenticated]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load folders on mount
  useEffect(() => {
    if (!isAuthenticated) return;
    api.mail.getFolders()
      .then((data) => {
        setFolders(data);
        const inbox = data.find((f: any) => f.path === '/Inbox');
        if (inbox) setActiveFolderId(inbox.id);
      })
      .catch(console.error);
  }, [isAuthenticated]);

  // ── Folder count helper (Task 5) ─────────────────────────────────────────
  const updateFolderCounts = useCallback((folderId: string, unreadDelta: number, totalDelta = 0) => {
    setFolders((prev) =>
      prev.map((f) =>
        f.id === folderId
          ? {
              ...f,
              unreadCount: Math.max(0, (f.unreadCount ?? 0) + unreadDelta),
              totalCount: Math.max(0, (f.totalCount ?? 0) + totalDelta),
            }
          : f,
      ),
    );
  }, []);

  // Reset active message when switching folders; TanStack Query re-fetches automatically
  useEffect(() => {
    if (activeFolderId) {
      setActiveMessageId(undefined);
      setActiveMessage(null);
    }
  }, [activeFolderId]);

  // ── Inbox Zero celebration ────────────────────────────────────────────────
  // Fires a one-shot confetti + empty-state message when the inbox unread
  // count transitions from >0 to 0, gated to once per local day.
  //
  // Baseline: the first folder snapshot after mount is recorded but does NOT
  // trigger — we only celebrate a *transition* the user caused in this session,
  // not the initial state of an already-empty inbox.
  const prevInboxUnreadRef = useRef<number | null>(null);
  const [pendingInboxZero, setPendingInboxZero] = useState(false);
  useEffect(() => {
    const inbox = folders.find((f) => f.path === '/Inbox');
    if (!inbox) return;
    const current: number = inbox.unreadCount ?? 0;
    const prev = prevInboxUnreadRef.current;
    prevInboxUnreadRef.current = current;
    if (prev === null) return; // baseline snapshot — no celebration
    if (prev > 0 && current === 0) {
      if (typeof window === 'undefined') return;
      const enabled = localStorage.getItem('1gov_inbox_zero_enabled') !== 'false';
      if (!enabled) return;
      const today = new Date().toISOString().slice(0, 10);
      if (localStorage.getItem('1gov_inbox_zero_last_celebration') === today) return;
      setPendingInboxZero(true);
    }
  }, [folders]);

  const handleInboxZeroCelebrated = useCallback(() => {
    const today = new Date().toISOString().slice(0, 10);
    try { localStorage.setItem('1gov_inbox_zero_last_celebration', today); } catch { /* ignore quota/private-mode */ }
    setPendingInboxZero(false);
  }, []);

  const activeFolder = folders.find((f) => f.id === activeFolderId);
  const isInboxActive = activeFolder?.path === '/Inbox';
  // Only surface the Inbox Zero empty-state when the inbox is genuinely at
  // zero unread — otherwise "0 starred" on the starred tab would trigger it.
  const showInboxZeroEmptyState = isInboxActive && (activeFolder?.unreadCount ?? 0) === 0;

  // Load full message
  const openMessage = useCallback(async (messageId: string) => {
    // Look in both messages list and search results
    const msg =
      messages.find((m) => m.id === messageId) ??
      searchResults.find((m) => m.id === messageId);
    const wasUnread = msg ? !msg.isRead : false;

    // Determine whether this is a draft (by folder path or message flag)
    const activeFolder = folders.find((f) => f.id === activeFolderId);
    const isDraft = activeFolder?.path === '/Drafts' || msg?.isDraft === true;

    setActiveMessageId(messageId);
    setLoadingMessage(true);

    // Optimistically mark as read in the list immediately (skip for drafts)
    if (wasUnread && !isDraft) {
      updateMessageInCache(activeFolderId, messageId, (m) => ({ ...m, isRead: true }));
      setSearchResults((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, isRead: true } : m)),
      );
      updateFolderCounts(activeFolderId, -1);
    }
    try {
      const onlineNow = typeof navigator === 'undefined' ? true : navigator.onLine;
      let data: any;
      if (!onlineNow) {
        data = await offline.mail.getMessage(messageId);
        if (!data) {
          toast.error('This message is not available offline');
          setActiveMessageId(undefined);
          if (wasUnread && !isDraft) {
            updateMessageInCache(activeFolderId, messageId, (m) => ({ ...m, isRead: false }));
            updateFolderCounts(activeFolderId, +1);
          }
          setLoadingMessage(false);
          return;
        }
      } else {
        try {
          data = await api.mail.getMessage(messageId);
          void offline.mail.setMessage(messageId, data);
        } catch (netErr) {
          const cached = await offline.mail.getMessage(messageId);
          if (cached) {
            data = cached;
          } else {
            throw netErr;
          }
        }
      }

      if (isDraft) {
        // Open the draft in the compose panel instead of the detail view
        const extractEmails = (arr: any[]): string[] =>
          (arr ?? [])
            .map((r) => (typeof r === 'string' ? r : (r?.email ?? '')))
            .filter(Boolean);

        setComposeDraftProps({
          zimbraId: data.zimbraId ?? messageId,
          to: extractEmails(data.toRecipients),
          cc: extractEmails(data.ccRecipients),
          bcc: extractEmails(data.bccRecipients),
          subject: data.subject ?? '',
          body: data.bodyHtml ?? data.bodyText ?? '',
        });
        setComposeMode('new');
        setComposeOpen(true);
        setActiveMessage(null);
        setActiveMessageId(undefined);
      } else {
        setActiveMessage(data);
        // Persist read status to server (fire-and-forget, don't block UI)
        if (wasUnread) {
          api.mail.markRead(messageId, true).catch(() => {});
        }
      }
    } catch (err: any) {
      toast.error('Failed to load message', { description: err?.message });
      setActiveMessageId(undefined);
      // Revert optimistic update on error
      if (wasUnread && !isDraft) {
        updateMessageInCache(activeFolderId, messageId, (m) => ({ ...m, isRead: false }));
        updateFolderCounts(activeFolderId, +1);
      }
    } finally {
      setLoadingMessage(false);
    }
  }, [messages, searchResults, folders, activeFolderId, updateFolderCounts, updateMessageInCache, offline]);

  const handleMoveToFolder = useCallback(async (folderId: string) => {
    if (!activeMessageId) return;
    const messageId = activeMessageId;
    const sourceFolderId = activeFolderId;
    const removed = messages.find((m) => m.id === messageId);
    const wasUnread = removed ? !removed.isRead : false;
    removeMessageFromCache(sourceFolderId, messageId);
    setActiveMessageId(undefined);
    setActiveMessage(null);
    updateFolderCounts(sourceFolderId, wasUnread ? -1 : 0, -1);
    const targetName = folders.find((f) => f.id === folderId)?.name ?? 'folder';
    toast.success(`Moved to ${targetName}`);
    await offline.enqueue<{ messageId: string; folderId: string }>({
      kind: 'mail.move',
      payload: { messageId, folderId },
      idempotencyKey: `mail.move:${messageId}:${folderId}`,
      onFailed: (errMessage) => {
        invalidateMessages();
        updateFolderCounts(sourceFolderId, wasUnread ? +1 : 0, +1);
        toast.error('Failed to move message', { description: errMessage });
      },
    });
  }, [activeMessageId, messages, folders, activeFolderId, updateFolderCounts, removeMessageFromCache, invalidateMessages, offline]);

  const moveToInbox = useCallback(async () => {
    if (!activeMessageId) return;
    const inboxFolder = folders.find((f) => f.path === '/Inbox');
    if (!inboxFolder) return;
    const messageId = activeMessageId;
    const sourceFolderId = activeFolderId;
    const inboxFolderId = inboxFolder.id;
    const removed = messages.find((m) => m.id === messageId);
    const wasUnread = removed ? !removed.isRead : false;
    removeMessageFromCache(sourceFolderId, messageId);
    setActiveMessageId(undefined);
    setActiveMessage(null);
    updateFolderCounts(sourceFolderId, wasUnread ? -1 : 0, -1);
    toast.success('Message moved to Inbox');
    await offline.enqueue<{ messageId: string; folderId: string }>({
      kind: 'mail.move',
      payload: { messageId, folderId: inboxFolderId },
      idempotencyKey: `mail.move:${messageId}:${inboxFolderId}`,
      onFailed: (errMessage) => {
        invalidateMessages();
        updateFolderCounts(sourceFolderId, wasUnread ? +1 : 0, +1);
        toast.error('Failed to move message', { description: errMessage });
      },
    });
  }, [activeMessageId, folders, messages, activeFolderId, updateFolderCounts, removeMessageFromCache, invalidateMessages, offline]);

  const deleteMessage = useCallback(async () => {
    if (!activeMessageId) return;
    const messageId = activeMessageId;
    const sourceFolderId = activeFolderId;
    const removed = messages.find((m) => m.id === messageId);
    const wasUnread = removed ? !removed.isRead : false;
    removeMessageFromCache(sourceFolderId, messageId);
    setSearchResults((prev) => prev.filter((m) => m.id !== messageId));
    setActiveMessageId(undefined);
    setActiveMessage(null);
    updateFolderCounts(sourceFolderId, wasUnread ? -1 : 0, -1);
    toast.success('Message moved to Trash');
    await offline.enqueue<{ messageId: string }>({
      kind: 'mail.delete',
      payload: { messageId },
      idempotencyKey: `mail.delete:${messageId}`,
      onFailed: (errMessage) => {
        invalidateMessages();
        updateFolderCounts(sourceFolderId, wasUnread ? +1 : 0, +1);
        toast.error('Failed to delete message', { description: errMessage });
      },
    });
  }, [activeMessageId, messages, activeFolderId, updateFolderCounts, removeMessageFromCache, invalidateMessages, offline]);

  const handleBulkAction = useCallback(async (action: BulkAction) => {
    const { messageIds } = action;
    if (!messageIds.length) return;
    const sourceFolderId = activeFolderId;
    const count = messageIds.length;
    const plural = count !== 1 ? 's' : '';
    const onFailed = (errMessage: string) => {
      invalidateMessages();
      toast.error('Bulk action failed', { description: errMessage });
    };

    if (action.type === 'markRead' || action.type === 'markUnread') {
      const read = action.type === 'markRead';
      messageIds.forEach((id) => updateMessageInCache(sourceFolderId, id, (m) => ({ ...m, isRead: read })));
      toast.success(`Marked ${count} message${plural} as ${read ? 'read' : 'unread'}`);
      await offline.enqueue<{ messageIds: string[]; read: boolean }>({
        kind: 'mail.bulkMarkRead',
        payload: { messageIds, read },
        onFailed,
      });
    } else if (action.type === 'delete') {
      messageIds.forEach((id) => removeMessageFromCache(sourceFolderId, id));
      if (activeMessageId && messageIds.includes(activeMessageId)) { setActiveMessageId(undefined); setActiveMessage(null); }
      toast.success(`Deleted ${count} message${plural}`);
      await offline.enqueue<{ messageIds: string[] }>({
        kind: 'mail.bulkDelete',
        payload: { messageIds },
        onFailed,
      });
    } else if (action.type === 'move' && action.targetFolderId) {
      const targetFolderId = action.targetFolderId;
      messageIds.forEach((id) => removeMessageFromCache(sourceFolderId, id));
      if (activeMessageId && messageIds.includes(activeMessageId)) { setActiveMessageId(undefined); setActiveMessage(null); }
      const targetName = folders.find((f) => f.id === targetFolderId)?.name ?? 'folder';
      toast.success(`Moved ${count} message${plural} to ${targetName}`);
      await offline.enqueue<{ messageIds: string[]; folderId: string }>({
        kind: 'mail.bulkMove',
        payload: { messageIds, folderId: targetFolderId },
        onFailed,
      });
    }
  }, [activeFolderId, activeMessageId, folders, updateMessageInCache, removeMessageFromCache, invalidateMessages, offline]);

  const openCompose = useCallback((mode: ComposeMode) => {
    setComposeDraftProps(null); // clear any draft — this is a fresh reply/forward/new
    setComposeMode(mode);
    setComposeOpen(true);
  }, []);

  /** Called from ThreadView when the user replies to a specific message inside
   *  the thread (not necessarily the last one).  We update activeMessage so that
   *  ComposeModal receives the right original message, then open compose. */
  const openComposeWith = useCallback(
    (mode: ComposeMode, target: any) => {
      setActiveMessage(target);
      setComposeDraftProps(null);
      setComposeMode(mode);
      setComposeOpen(true);
    },
    [],
  );

  const toggleStar = useCallback(async () => {
    if (!activeMessage) return;
    const newStarred = !activeMessage.isStarred;
    // Optimistic update
    setActiveMessage((m: any) => m && { ...m, isStarred: newStarred });
    updateMessageInCache(activeFolderId, activeMessage.id, (m) => ({ ...m, isStarred: newStarred }));
    try {
      await api.mail.markRead(activeMessage.id, activeMessage.isRead); // keep read state, just trigger a save
      // Note: a dedicated star endpoint would be ideal; for now Zimbra flagging
      // would need its own SOAP call — we'll keep the optimistic update and add the
      // real call once the flag endpoint is wired up
    } catch {
      // Silently revert — not a critical action
      setActiveMessage((m: any) => m && { ...m, isStarred: !newStarred });
    }
  }, [activeMessage, activeFolderId, updateMessageInCache]);

  // Context menu actions from the message list
  const handleContextAction = useCallback(async (action: ContextAction) => {
    const { type, messageId } = action;
    const msg = [...messages, ...searchResults].find((m) => m.id === messageId);
    if (!msg) return;

    if (type === 'createTask') {
      setCreateTaskPrefill({ linkedMessageId: messageId, linkedSubject: msg.subject ?? '' });
      return;
    }

    if (type === 'createEvent') {
      const params = new URLSearchParams({
        createFromEmail: messageId,
        subject: msg.subject ?? '',
      });
      router.push(`/calendar?${params.toString()}`);
      return;
    }

    if (type === 'snooze') {
      setSnoozeTarget({ messageId, folderId: activeFolderId });
      return;
    }

    if (type === 'mute') {
      const convId = msg.conversationId as string | undefined;
      if (!convId) { toast.info('This message is not part of a conversation'); return; }
      const alreadyMuted = mutedConversationIds.includes(convId);
      try {
        if (alreadyMuted) {
          await api.mail.unmuteConversation(convId);
          setMutedConversationIds((prev) => prev.filter((id) => id !== convId));
          toast.success('Conversation unmuted');
        } else {
          await api.mail.muteConversation(convId);
          setMutedConversationIds((prev) => [...prev, convId]);
          toast.success('Conversation muted — you won\'t be notified of new messages');
        }
      } catch (err: any) {
        toast.error('Failed to update mute', { description: err?.message });
      }
      return;
    }

    if (type === 'print') {
      // Handled by MailDetail's print button — if triggered from context menu, open message first
      await openMessage(messageId);
      return;
    }

    if (type === 'reply' || type === 'forward') {
      await openMessage(messageId);
      openCompose(type === 'reply' ? 'reply' : 'forward');
      return;
    }

    if (type === 'markRead' || type === 'markUnread') {
      const read = type === 'markRead';
      const sourceFolderId = activeFolderId;
      const wasUnread = !msg.isRead;
      updateMessageInCache(sourceFolderId, messageId, (m) => ({ ...m, isRead: read }));
      setSearchResults((prev) => prev.map((m) => m.id === messageId ? { ...m, isRead: read } : m));
      if (activeMessage?.id === messageId) setActiveMessage((m: any) => m && { ...m, isRead: read });
      if (read && wasUnread) updateFolderCounts(sourceFolderId, -1);
      if (!read && !wasUnread) updateFolderCounts(sourceFolderId, +1);
      await offline.enqueue<{ messageId: string; read: boolean }>({
        kind: 'mail.markRead',
        payload: { messageId, read },
        onFailed: () => {
          updateMessageInCache(sourceFolderId, messageId, (m) => ({ ...m, isRead: !read }));
          setSearchResults((prev) => prev.map((m) => m.id === messageId ? { ...m, isRead: !read } : m));
          if (read && wasUnread) updateFolderCounts(sourceFolderId, +1);
          if (!read && !wasUnread) updateFolderCounts(sourceFolderId, -1);
          toast.error('Failed to update message');
        },
      });
      return;
    }

    if (type === 'star' || type === 'unstar') {
      const starred = type === 'star';
      updateMessageInCache(activeFolderId, messageId, (m) => ({ ...m, isStarred: starred }));
      setSearchResults((prev) => prev.map((m) => m.id === messageId ? { ...m, isStarred: starred } : m));
      if (activeMessage?.id === messageId) setActiveMessage((m: any) => m && { ...m, isStarred: starred });
      return;
    }

    if (type === 'delete') {
      const sourceFolderId = activeFolderId;
      const removed = messages.find((m) => m.id === messageId);
      const wasUnread = removed ? !removed.isRead : false;
      removeMessageFromCache(sourceFolderId, messageId);
      setSearchResults((prev) => prev.filter((m) => m.id !== messageId));
      if (activeMessageId === messageId) { setActiveMessageId(undefined); setActiveMessage(null); }
      updateFolderCounts(sourceFolderId, wasUnread ? -1 : 0, -1);
      toast.success('Message moved to Trash');
      await offline.enqueue<{ messageId: string }>({
        kind: 'mail.delete',
        payload: { messageId },
        idempotencyKey: `mail.delete:${messageId}`,
        onFailed: (errMessage) => {
          invalidateMessages();
          updateFolderCounts(sourceFolderId, wasUnread ? +1 : 0, +1);
          toast.error('Failed to delete message', { description: errMessage });
        },
      });
    }

    if (type === 'moveToFolder' && action.targetFolderId) {
      const targetFolderId = action.targetFolderId;
      const removed = messages.find((m) => m.id === messageId);
      const wasUnread = removed ? !removed.isRead : false;
      const sourceFolderId = activeFolderId;
      removeMessageFromCache(sourceFolderId, messageId);
      setSearchResults((prev) => prev.filter((m) => m.id !== messageId));
      if (activeMessageId === messageId) { setActiveMessageId(undefined); setActiveMessage(null); }
      updateFolderCounts(sourceFolderId, wasUnread ? -1 : 0, -1);
      const targetName = folders.find((f) => f.id === targetFolderId)?.name ?? 'folder';
      toast.success(`Moved to ${targetName}`);
      await offline.enqueue<{ messageId: string; folderId: string }>({
        kind: 'mail.move',
        payload: { messageId, folderId: targetFolderId },
        idempotencyKey: `mail.move:${messageId}:${targetFolderId}`,
        onFailed: (errMessage) => {
          invalidateMessages();
          updateFolderCounts(sourceFolderId, wasUnread ? +1 : 0, +1);
          toast.error('Failed to move message', { description: errMessage });
        },
      });
    }
  }, [messages, searchResults, activeMessage, activeMessageId, openMessage, openCompose, folders, activeFolderId, updateFolderCounts, updateMessageInCache, removeMessageFromCache, invalidateMessages, offline]); // eslint-disable-line

  // Debounce search input → fire query after 400 ms of silence
  const handleSearchInput = useCallback((value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!value.trim()) {
      setSearchQuery('');
      setSearchResults([]);
      return;
    }
    searchDebounceRef.current = setTimeout(() => {
      setSearchQuery(value.trim());
    }, 600);
  }, []);

  const runSearch = useCallback(async (query: string, reset = true) => {
    if (!query.trim()) return;
    if (reset) {
      searchOffsetRef.current = 0;
      setSearchResults([]);
      setLoadingSearch(true);
    } else {
      setLoadingMoreSearch(true);
    }
    const currentOffset = searchOffsetRef.current;
    try {
      const data = await api.mail.search(query, 50, currentOffset);
      setSearchResults((prev) => {
        if (reset) return data.messages;
        const seen = new Set(prev.map((m: any) => m.id));
        return [...prev, ...data.messages.filter((m: any) => !seen.has(m.id))];
      });
      setSearchTotal(data.total);
      setSearchHasMore(data.hasMore);
      searchOffsetRef.current = currentOffset + data.messages.length;
    } catch (err: any) {
      toast.error('Search failed', { description: err?.message });
    } finally {
      setLoadingSearch(false);
      setLoadingMoreSearch(false);
    }
  }, []);

  useEffect(() => {
    if (searchQuery) {
      setActiveMessageId(undefined);
      setActiveMessage(null);
      runSearch(searchQuery, true);
    }
  }, [searchQuery]); // eslint-disable-line

  const clearSearch = useCallback(() => {
    setSearchInput('');
    setSearchQuery('');
    setSearchResults([]);
  }, []);

  // ── Keyboard navigation helpers ─────────────────────────────────────────────
  const displayedMessages = isSearchMode ? searchResults : messages;
  const currentIndex = displayedMessages.findIndex((m) => m.id === activeMessageId);

  useKeyboardShortcuts({
    j: () => {
      if (displayedMessages.length === 0) return;
      const next = currentIndex < displayedMessages.length - 1 ? currentIndex + 1 : 0;
      openMessage(displayedMessages[next].id);
    },
    k: () => {
      if (displayedMessages.length === 0) return;
      const prev = currentIndex > 0 ? currentIndex - 1 : displayedMessages.length - 1;
      openMessage(displayedMessages[prev].id);
    },
    c: () => openCompose('new'),
    r: () => { if (activeMessage) openCompose('reply'); },
    a: () => { if (activeMessage) openCompose('replyAll'); },
    f: () => { if (activeMessage) openCompose('forward'); },
    s: toggleStar,
    e: () => {
      const archiveFolder = folders.find((f) => f.path === '/Archive');
      if (activeMessageId && archiveFolder) handleMoveToFolder(archiveFolder.id);
    },
    d: () => { if (activeMessageId) deleteMessage(); },
    u: () => {
      if (activeMessage) {
        const read = activeMessage.isRead;
        updateMessageInCache(activeFolderId, activeMessage.id, (m) => ({ ...m, isRead: !read }));
        setActiveMessage((m: any) => m && { ...m, isRead: !read });
        api.mail.markRead(activeMessage.id, !read).catch(() => {});
      }
    },
    escape: () => {
      if (shortcutsModalOpen) { setShortcutsModalOpen(false); return; }
      if (globalSearchOpen) { setGlobalSearchOpen(false); return; }
      if (activeMessageId) { setActiveMessageId(undefined); setActiveMessage(null); }
    },
    slash: () => { searchInputRef.current?.focus(); searchInputRef.current?.select(); },
    question: () => setShortcutsModalOpen((o) => !o),
    cmdK: () => setGlobalSearchOpen((o) => !o),
  });

  const handleCreateFolder = useCallback(async (name: string) => {
    try {
      await api.mail.createFolder(name);
      // Refresh folder list so the new folder appears immediately
      const data = await api.mail.getFolders();
      setFolders(data);
      toast.success(`Folder "${name}" created`);
    } catch (err: any) {
      toast.error('Failed to create folder', { description: err?.message });
      throw err; // let Sidebar know it failed (so input stays open)
    }
  }, []);

  const handleDeleteFolder = useCallback(async (folderId: string) => {
    // Optimistically remove from sidebar
    const removed = folders.find((f) => f.id === folderId);
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    // If this was the active folder, switch to Inbox
    if (activeFolderId === folderId) {
      const inbox = folders.find((f) => f.path === '/Inbox');
      if (inbox) setActiveFolderId(inbox.id);
    }
    try {
      await api.mail.deleteFolder(folderId);
      toast.success('Folder deleted');
    } catch (err: any) {
      if (removed) setFolders((prev) => [...prev, removed]);
      toast.error('Failed to delete folder', { description: err?.message });
    }
  }, [folders, activeFolderId]);

  const handleEmptyFolder = useCallback(async (folderId: string) => {
    try {
      await api.mail.emptyFolder(folderId);
      // Clear messages if this is the currently viewed folder
      if (activeFolderId === folderId) {
        queryClient.setQueryData(['messages', folderId], (old: any) =>
          old ? { ...old, pages: old.pages.map((p: any) => ({ ...p, messages: [], hasMore: false })) } : old,
        );
        setActiveMessageId(undefined);
        setActiveMessage(null);
      }
      // Reset folder counts
      setFolders((prev) =>
        prev.map((f) => f.id === folderId ? { ...f, unreadCount: 0, totalCount: 0 } : f),
      );
      toast.success('Folder emptied');
    } catch (err: any) {
      toast.error('Failed to empty folder', { description: err?.message });
      throw err;
    }
  }, [activeFolderId, queryClient]);

  const handleRenameFolder = useCallback(async (folderId: string, name: string) => {
    const prev = folders.find((f) => f.id === folderId);
    setFolders((old) => old.map((f) => f.id === folderId ? { ...f, name } : f));
    try {
      await api.mail.renameFolder(folderId, name);
      toast.success('Folder renamed');
    } catch (err: any) {
      if (prev) setFolders((old) => old.map((f) => f.id === folderId ? prev : f));
      toast.error('Failed to rename folder', { description: err?.message });
      throw err;
    }
  }, [folders]);

  // Show a minimal full-screen loader while waiting for persisted auth to hydrate
  if (!hydrated) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          <p className="text-xs text-muted-foreground/50">Loading…</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        folders={folders}
        activeFolderId={activeFolderId}
        onFolderSelect={(id) => setActiveFolderId(id)}
        onCompose={() => { setComposeOpen(true); setComposeMode('new'); }}
        onCreateFolder={handleCreateFolder}
        onDeleteFolder={handleDeleteFolder}
        onEmptyFolder={handleEmptyFolder}
        onRenameFolder={handleRenameFolder}
      />
      <MobileSidebarSheet
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        folders={folders}
        activeFolderId={activeFolderId}
        onFolderSelect={(id) => setActiveFolderId(id)}
        onCompose={() => { setComposeOpen(true); setComposeMode('new'); }}
        onCreateFolder={handleCreateFolder}
        onDeleteFolder={handleDeleteFolder}
        onEmptyFolder={handleEmptyFolder}
        onRenameFolder={handleRenameFolder}
      />

      {/* Mail list pane — full width on mobile, fixed 300px on desktop */}
      <div className={cn(
        'shrink-0 flex flex-col h-full border-r border-border/50',
        'w-full lg:w-[300px]',
        activeMessageId ? 'hidden lg:flex' : 'flex',
      )}>
        {/* List header */}
        <div className="px-3 pt-3 pb-2.5 border-b border-border/25 shrink-0">
          {/* Title row */}
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-1">
              {/* Hamburger — mobile only */}
              <button
                onClick={() => setSidebarOpen(true)}
                className="lg:hidden p-1 -ml-1 mr-1 rounded-md text-muted-foreground/60 hover:bg-muted/50 hover:text-foreground transition-colors"
                aria-label="Open navigation"
              >
                <Menu className="w-4 h-4" />
              </button>
              <h2 className="text-[14px] font-semibold text-foreground">
                {isSearchMode
                  ? 'Search'
                  : (folders.find((f) => f.id === activeFolderId)?.name ?? 'Inbox')}
              </h2>
              {!isSearchMode && (
                <svg className="w-3.5 h-3.5 text-muted-foreground/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              {isSearchMode ? (
                <button
                  onClick={clearSearch}
                  className="p-1.5 rounded-md text-muted-foreground/45 hover:text-foreground hover:bg-muted transition-colors"
                  title="Clear search"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  onClick={() => refetchMessages()}
                  disabled={loadingMessages}
                  className="p-1.5 rounded-md text-muted-foreground/45 hover:text-foreground hover:bg-muted transition-colors"
                >
                  <RefreshCw className={cn('w-3.5 h-3.5', loadingMessages && 'animate-spin')} />
                </button>
              )}
            </div>
          </div>

          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/35" />
            <Input
              ref={searchInputRef}
              value={searchInput}
              onChange={(e) => handleSearchInput(e.target.value)}
              placeholder="Search messages…"
              className="pl-8 h-7 text-[12px] bg-muted/40 border-border/40 focus-visible:border-primary/40 rounded-lg"
            />
            {searchInput && (
              <button
                onClick={clearSearch}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground"
              >
                <XIcon className="w-3 h-3" />
              </button>
            )}
          </div>

          {/* Search result count */}
          {isSearchMode && !loadingSearch && (
            <p className="text-[11px] text-muted-foreground/45 mt-1.5">
              {searchTotal > 0
                ? `${searchTotal.toLocaleString()} message${searchTotal !== 1 ? 's' : ''} found`
                : 'No messages found'}
            </p>
          )}
        </div>

        {!offline.status.online && (
          <div className="px-3 py-1.5 text-[12px] bg-amber-500/10 text-amber-700 dark:text-amber-300 border-b border-amber-500/20 flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
            <span className="truncate">You&rsquo;re offline. Showing cached messages; some may be unavailable.</span>
          </div>
        )}

        {isSearchMode ? (
          <MailList
            key="search"
            messages={searchResults}
            activeMessageId={activeMessageId}
            loading={loadingSearch && searchResults.length === 0}
            loadingMore={loadingMoreSearch}
            onSelect={openMessage}
            onLoadMore={() => { if (!loadingMoreSearch && searchHasMore) runSearch(searchQuery, false); }}
            hasMore={searchHasMore}
            onContextAction={handleContextAction}
            onBulkAction={handleBulkAction}
            folders={folders}
            mutedConversationIds={mutedConversationIds}
          />
        ) : (
          <MailList
            key="regular"
            messages={messages}
            activeMessageId={activeMessageId}
            loading={loadingMessages && messages.length === 0}
            loadingMore={loadingMore}
            onSelect={openMessage}
            onLoadMore={() => { if (!loadingMore && hasNextPage) fetchNextPage(); }}
            hasMore={!!hasNextPage}
            onContextAction={handleContextAction}
            onBulkAction={handleBulkAction}
            folders={folders}
            mutedConversationIds={mutedConversationIds}
            emptyState={showInboxZeroEmptyState ? (
              <InboxZero celebrate={pendingInboxZero} onCelebrated={handleInboxZeroCelebrated} />
            ) : undefined}
          />
        )}
      </div>

      {/* Detail pane — full width on mobile when message selected, always visible on desktop */}
      <div className={cn('flex-1 min-w-0 h-full flex flex-col', !activeMessageId && 'hidden lg:flex')}>
        {/* Mobile back button */}
        <div className="lg:hidden flex items-center px-3 py-2 border-b border-border/25 shrink-0">
          <button
            onClick={() => { setActiveMessageId(undefined); setActiveMessage(null); }}
            className="flex items-center gap-1.5 text-[13px] text-muted-foreground/70 hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>
        </div>
        <div className="flex-1 min-h-0">
        <ThreadView
          message={activeMessage}
          loading={loadingMessage}
          onClose={() => { setActiveMessageId(undefined); setActiveMessage(null); }}
          onComposeWith={openComposeWith}
          onDelete={deleteMessage}
          onToggleStar={toggleStar}
          onMoveToInbox={
            folders.find((f) => f.id === activeFolderId)?.path === '/Trash' &&
            folders.some((f) => f.path === '/Inbox')
              ? moveToInbox
              : undefined
          }
          folders={folders}
          onMoveToFolder={(folderId) => { if (activeMessageId) handleMoveToFolder(folderId); }}
          refreshKey={threadRefreshKey}
          onMute={activeMessage?.conversationId ? async () => {
            const convId = activeMessage.conversationId as string;
            const alreadyMuted = mutedConversationIds.includes(convId);
            try {
              if (alreadyMuted) {
                await api.mail.unmuteConversation(convId);
                setMutedConversationIds((prev) => prev.filter((id) => id !== convId));
                toast.success('Conversation unmuted');
              } else {
                await api.mail.muteConversation(convId);
                setMutedConversationIds((prev) => [...prev, convId]);
                toast.success('Conversation muted');
              }
            } catch (err: any) {
              toast.error('Failed to update mute', { description: err?.message });
            }
          } : undefined}
          isMuted={activeMessage?.conversationId ? mutedConversationIds.includes(activeMessage.conversationId) : false}
        />
        </div>
      </div>

      {/* Snooze modal */}
      <SnoozeModal
        open={!!snoozeTarget}
        onClose={() => setSnoozeTarget(null)}
        onSnooze={async (until) => {
          if (!snoozeTarget) return;
          try {
            await api.mail.snooze(snoozeTarget.messageId, until.toISOString(), snoozeTarget.folderId);
            removeMessageFromCache(activeFolderId, snoozeTarget.messageId);
            if (activeMessageId === snoozeTarget.messageId) { setActiveMessageId(undefined); setActiveMessage(null); }
            toast.success(`Snoozed until ${until.toLocaleString()}`);
          } catch (err: any) {
            toast.error('Failed to snooze', { description: err?.message });
          }
          setSnoozeTarget(null);
        }}
      />

      {/* Create task from email — Sheet */}
      <TaskModal
        open={!!createTaskPrefill}
        task={null}
        prefill={createTaskPrefill ?? undefined}
        onClose={() => setCreateTaskPrefill(null)}
        onSaved={() => setCreateTaskPrefill(null)}
      />

      {/* Floating compose — rendered as a fixed overlay so the thread stays visible */}
      <ComposeModal
        open={composeOpen}
        mode={composeMode}
        originalMessage={activeMessage}
        onClose={() => { setComposeOpen(false); setComposeDraftProps(null); }}
        onSent={() => {
          setComposeOpen(false);
          setComposeDraftProps(null);
          invalidateMessages();
          // Re-fetch the thread so the sent reply appears immediately.
          setThreadRefreshKey((k) => k + 1);
        }}
        initialDraftZimbraId={composeDraftProps?.zimbraId}
        initialTo={composeDraftProps?.to}
        initialCc={composeDraftProps?.cc}
        initialBcc={composeDraftProps?.bcc}
        initialSubject={composeDraftProps?.subject}
        initialBody={composeDraftProps?.body}
      />

      <KeyboardShortcutsModal
        open={shortcutsModalOpen}
        onClose={() => setShortcutsModalOpen(false)}
      />

      <GlobalSearch
        open={globalSearchOpen}
        onClose={() => setGlobalSearchOpen(false)}
      />
    </div>
  );
}
