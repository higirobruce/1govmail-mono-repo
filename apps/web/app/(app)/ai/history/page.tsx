'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Clock, Search, Trash2, Loader2, MessageSquare, Menu } from 'lucide-react';
import { api } from '@/lib/api';
import { appendPage, groupByRecency, resumeTarget, scopeChipLabel, type HistoryItem } from '@/lib/ai/history';
import { useAskStore } from '@/stores/ask.store';
import { useConfirmStore } from '@/stores/confirm.store';
import { useAuthStore } from '@/stores/auth.store';
import Sidebar from '@/components/layout/Sidebar';
import { MobileSidebarSheet } from '@/components/layout/MobileSidebarSheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

export default function AiHistoryPage() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const confirm = useConfirmStore((s) => s.confirm);
  const resumeConversation = useAskStore((s) => s.resumeConversation);

  const [items, setItems] = useState<HistoryItem[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  // The server pages at 25. Without this the page showed the newest 25 rows
  // and the newest 25 search hits and nothing else — the Older bucket was
  // unreachable, which is the opposite of the "hunting through months" this
  // page exists for.
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Which search a response belongs to. A page-2 fetch started under one
  // query must not append its rows after the query has moved on — that would
  // mix unfiltered rows into a filtered list, silently.
  const searchSeqRef = useRef(0);
  const [hydrated, setHydrated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Auth hydration — the same guard every page in this group uses. There is no
  // `hydrated` field on the store; it comes from the persist middleware.
  useEffect(() => {
    const unsub = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
    if (useAuthStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  // Debounced so typing does not fire a request per keystroke. Each run is a
  // fresh first page: a new query resets the cursor rather than paging on
  // from where the previous one had got to.
  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    let alive = true;
    const seq = ++searchSeqRef.current;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.aiHistory.list(q ? { q } : undefined);
        if (alive && searchSeqRef.current === seq) {
          setItems(res.items ?? []);
          setNextCursor(res.nextCursor ?? null);
        }
      } catch {
        if (alive) toast.error('Could not load your history');
      } finally {
        if (alive) setLoading(false);
      }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, isAuthenticated, hydrated]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const seq = searchSeqRef.current;
    setLoadingMore(true);
    try {
      // Carries the CURRENT query alongside the cursor: paging through a
      // filtered list must stay filtered.
      const res = await api.aiHistory.list({ ...(q ? { q } : {}), cursor: nextCursor });
      if (searchSeqRef.current !== seq) return; // the search moved on mid-flight
      setItems((prev) => appendPage(prev, res.items ?? []));
      setNextCursor(res.nextCursor ?? null);
    } catch {
      toast.error('Could not load more of your history');
    } finally {
      setLoadingMore(false);
    }
  };

  const groups = useMemo(() => groupByRecency(items, new Date()), [items]);

  const resume = (c: HistoryItem) => {
    resumeConversation(c.id);
    const target = resumeTarget(c);
    if (target) router.push(target);
  };

  const removeOne = (c: HistoryItem) => {
    confirm({
      title: 'Delete this conversation?',
      description: 'It will be removed along with any record of what the assistant did in it.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.aiHistory.remove(c.id);
          setItems((prev) => prev.filter((i) => i.id !== c.id));
        } catch {
          toast.error('Could not delete that conversation');
        }
      },
    });
  };

  const removeAll = () => {
    confirm({
      title: 'Delete all your chat history?',
      description: 'Every saved conversation, and the record of what the assistant did in them. This cannot be undone.',
      confirmLabel: 'Delete everything',
      destructive: true,
      onConfirm: async () => {
        try {
          const { deleted } = await api.aiHistory.removeAll();
          setItems([]);
          toast.success(deleted === 1 ? '1 conversation deleted' : `${deleted} conversations deleted`);
        } catch {
          toast.error('Could not delete your history');
        }
      },
    });
  };

  if (!hydrated) return null;

  // Pages in this group render their own shell — there is no shared chrome in
  // (app)/layout.tsx beyond the Ask panel and the notification mounts. Copy the
  // Sidebar/MobileSidebarSheet props from docs/page.tsx:321-333: this page has
  // no folders of its own, so folder actions route to /mail.
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        folders={[]}
        activeFolderId=""
        onFolderSelect={() => router.push('/mail')}
        onCompose={() => router.push('/mail')}
      />
      <MobileSidebarSheet
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        folders={[]}
        activeFolderId=""
        onFolderSelect={() => router.push('/mail')}
        onCompose={() => router.push('/mail')}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 pt-8 pb-16">
        <div className="flex items-baseline justify-between gap-4 mb-1">
          <h1 className="text-display flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(true)}
              className="lg:hidden p-1 -ml-0.5 rounded-md text-muted-foreground/60 hover:bg-muted/50 hover:text-foreground transition-colors"
              aria-label="Open navigation"
            >
              <Menu className="w-4 h-4" />
            </button>
            <Clock className="w-5 h-5 text-ink-2" />
            Chat history
          </h1>
          {items.length > 0 && (
            <Button variant="destructive-ghost" size="sm" onClick={removeAll} className="gap-1.5">
              <Trash2 className="w-3.5 h-3.5" />
              Delete all
            </Button>
          )}
        </div>
        <p className="text-ui text-ink-2 mb-6">
          Your own conversations with Ask 1Gov. They are kept for 90 days after the last message.
        </p>

        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your conversations"
            className="pl-9"
          />
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-ui text-ink-2 py-8">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading
          </div>
        )}

        {!loading && items.length === 0 && (
          <div className="text-center py-16 text-ink-2">
            <MessageSquare className="w-8 h-8 mx-auto mb-3 opacity-40" />
            <p className="text-ui">
              {q ? 'Nothing matches that.' : 'Conversations you have with Ask 1Gov will appear here.'}
            </p>
          </div>
        )}

        {!loading && groups.map((group) => (
          <section key={group.bucket} className="mb-7">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3 mb-2">
              {group.bucket}
            </h2>
            <ul className="divide-y divide-border/40 border-y border-border/40">
              {group.items.map((c) => (
                <li key={c.id} className="group flex items-center gap-3 py-3">
                  <button
                    onClick={() => resume(c)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <span className="block truncate font-medium">{c.title}</span>
                    <span className="block text-xs text-ink-3 mt-0.5">
                      {scopeChipLabel(c)} · {c.turnCount} message{c.turnCount === 1 ? '' : 's'} ·{' '}
                      {new Date(c.lastTurnAt).toLocaleString()}
                    </span>
                  </button>
                  <button
                    onClick={() => removeOne(c)}
                    aria-label={`Delete ${c.title}`}
                    title="Delete"
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-ink-3 hover:text-destructive shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
          ))}

        {!loading && nextCursor && (
          <div className="flex justify-center pt-2">
            <Button variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore} className="gap-1.5">
              {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {loadingMore ? 'Loading' : 'Load more'}
            </Button>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
