'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { useConfirmStore } from '@/stores/confirm.store';
import { api, type Doc } from '@/lib/api';
import Sidebar from '@/components/layout/Sidebar';
import { MobileSidebarSheet } from '@/components/layout/MobileSidebarSheet';
import { DocsEditor } from '@/components/docs/DocsEditor';
import { DocTree } from '@/components/docs/DocTree';
import { TemplatePickerDialog } from '@/components/docs/TemplatePickerDialog';
import { ShareDocDialog } from '@/components/docs/ShareDocDialog';
import { DocCoverPicker } from '@/components/docs/DocCoverPicker';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Plus, BookOpen, Share2, Menu, ChevronLeft,
  Search, Star, Tag, Download, X, Check,
} from 'lucide-react';
import { cn, getUserColor } from '@/lib/utils';

const GOV_TAGS = [
  { label: 'Unclassified',     cls: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800' },
  { label: 'Internal Use Only', cls: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800' },
  { label: 'Restricted',       cls: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800' },
  { label: 'Confidential',     cls: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800' },
] as const;

function getTagStyle(tag: string) {
  return GOV_TAGS.find((t) => t.label === tag)?.cls
    ?? 'bg-muted text-muted-foreground border-border';
}

export default function DocsPage() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const authToken = useAuthStore((s) => s.token);
  const authUser  = useAuthStore((s) => s.user);
  const [hydrated, setHydrated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const confirm = useConfirmStore((s) => s.confirm);

  const collabToken = useMemo(
    () => (authToken ? JSON.stringify({ type: 'jwt', value: authToken }) : ''),
    [authToken],
  );
  const collabUser = useMemo(
    () => ({
      name:  authUser?.displayName ?? authUser?.email ?? 'Unknown',
      color: getUserColor(authUser?.id ?? 'unknown'),
    }),
    [authUser],
  );

  const [docs, setDocs]               = useState<Doc[]>([]);
  const [selectedId, setSelectedId]   = useState<string | null>(null);
  const [activeDocs, setActiveDocs]   = useState<Doc | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDoc, setLoadingDoc]   = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [templateOpen, setTemplateOpen]       = useState(false);
  const [pendingParentId, setPendingParentId] = useState<string | null>(null);

  // Search & filter
  const [searchQuery, setSearchQuery]     = useState('');
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);

  // Auth hydration
  useEffect(() => {
    const unsub = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
    if (useAuthStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!isAuthenticated) router.replace('/login');
  }, [hydrated, isAuthenticated, router]);

  // Load doc list
  const loadDocs = useCallback(async () => {
    setLoadingList(true);
    try {
      const data = await api.docs.getAll();
      setDocs(data);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !isAuthenticated) return;
    void loadDocs();
  }, [hydrated, isAuthenticated, loadDocs]);

  // Select a doc and fetch full content
  const selectDoc = useCallback(async (id: string) => {
    if (id === selectedId) return;
    setSelectedId(id);
    setLoadingDoc(true);
    try {
      const doc = await api.docs.getOne(id);
      setActiveDocs(doc);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load document');
    } finally {
      setLoadingDoc(false);
    }
  }, [selectedId]);

  // Open template picker (optionally scoped to a parent)
  const openTemplatePicker = useCallback((parentId?: string) => {
    setPendingParentId(parentId ?? null);
    setTemplateOpen(true);
  }, []);

  // Create new doc from a template selection
  const handleCreateFromTemplate = useCallback(async (template: { title: string; emoji: string; content: string }) => {
    try {
      const doc = await api.docs.create({
        title:    template.title,
        emoji:    template.emoji,
        content:  template.content,
        parentId: pendingParentId ?? undefined,
      });
      setDocs((prev) => [...prev, doc]);
      void selectDoc(doc.id);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create document');
    } finally {
      setPendingParentId(null);
    }
  }, [pendingParentId, selectDoc]);

  // Delete a doc
  const handleDelete = useCallback((id: string) => {
    confirm({
      title: 'Delete document',
      description: 'This document and all its subpages will be permanently deleted.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.docs.delete(id);
          setDocs((prev) => prev.filter((d) => d.id !== id));
          if (selectedId === id) {
            setSelectedId(null);
            setActiveDocs(null);
          }
        } catch (err: unknown) {
          toast.error(err instanceof Error ? err.message : 'Failed to delete document');
        }
      },
    });
  }, [confirm, selectedId]);

  // Toggle favorite
  const handleFavorite = useCallback(async (id: string) => {
    try {
      const { isFavorite } = await api.docs.toggleFavorite(id);
      setDocs((prev) => prev.map((d) => d.id === id ? { ...d, isFavorite } : d));
      if (activeDocs?.id === id) setActiveDocs((prev) => prev ? { ...prev, isFavorite } : prev);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update favorite');
    }
  }, [activeDocs]);

  // Update local title after inline rename
  const handleTitleChange = useCallback((newTitle: string) => {
    setDocs((prev) => prev.map((d) => (d.id === selectedId ? { ...d, title: newTitle } : d)));
    setActiveDocs((prev) => prev ? { ...prev, title: newTitle } : prev);
  }, [selectedId]);

  // Update cover color
  const handleCoverChange = useCallback(async (color: string | null) => {
    if (!activeDocs) return;
    try {
      await api.docs.update(activeDocs.id, { coverColor: color });
      setDocs((prev) => prev.map((d) => d.id === activeDocs.id ? { ...d, coverColor: color } : d));
      setActiveDocs((prev) => prev ? { ...prev, coverColor: color } : prev);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update cover');
    }
  }, [activeDocs]);

  // Toggle a tag on the active document
  const handleTagToggle = useCallback(async (tag: string) => {
    if (!activeDocs) return;
    const current = activeDocs.tags ?? [];
    const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag];
    try {
      await api.docs.update(activeDocs.id, { tags: next });
      setDocs((prev) => prev.map((d) => d.id === activeDocs.id ? { ...d, tags: next } : d));
      setActiveDocs((prev) => prev ? { ...prev, tags: next } : prev);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update tags');
    }
  }, [activeDocs]);

  // Export to PDF
  const handleExport = useCallback(() => {
    window.print();
  }, []);

  // Filtered docs for the sidebar list (search + tag filter)
  const filteredDocs = useMemo(() => {
    let result = docs;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((d) => d.title.toLowerCase().includes(q));
    }
    if (activeTagFilter) {
      result = result.filter((d) => d.tags.includes(activeTagFilter));
    }
    return result;
  }, [docs, searchQuery, activeTagFilter]);

  // Favorites for quick-access section
  const favoriteDocs = useMemo(() => docs.filter((d) => d.isFavorite), [docs]);

  // Breadcrumb for nested docs
  const breadcrumb = useMemo(() => {
    if (!activeDocs?.parentId) return null;
    const parts: Doc[] = [];
    let current: Doc | undefined = docs.find((d) => d.id === activeDocs.parentId);
    while (current) {
      parts.unshift(current);
      current = docs.find((d) => d.id === current!.parentId);
    }
    return parts;
  }, [activeDocs, docs]);

  if (!hydrated) return null;

  return (
    <>
      {/* Print styles */}
      <style>{`
        @media print {
          body > * { display: none !important; }
          .docs-print-area { display: block !important; }
          .docs-print-area * { display: revert; }
        }
      `}</style>

      <div className="flex h-screen overflow-hidden bg-background">
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

        {/* Doc list panel */}
        <div className={cn(
          'shrink-0 flex flex-col border-r border-border bg-muted/30',
          'w-full lg:w-60',
          selectedId ? 'hidden lg:flex' : 'flex',
        )}>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSidebarOpen(true)}
                className="lg:hidden p-1 -ml-0.5 rounded-md text-muted-foreground/60 hover:bg-muted/50 hover:text-foreground transition-colors"
                aria-label="Open navigation"
              >
                <Menu className="w-4 h-4" />
              </button>
              <span className="text-sm font-semibold text-foreground">Pages</span>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              onClick={() => openTemplatePicker()}
              title="New page"
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>

          {/* Search */}
          <div className="px-2 py-2 border-b border-border shrink-0">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60" />
              <input
                type="text"
                placeholder="Search pages…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-7 pr-6 py-1 text-xs bg-muted/40 border border-border/50 rounded-md outline-none focus:border-primary/50 placeholder:text-muted-foreground/50"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Tag filter pills */}
          <div className="px-2 py-1.5 flex gap-1 flex-wrap border-b border-border shrink-0">
            {GOV_TAGS.map((t) => {
              const active = activeTagFilter === t.label;
              return (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => setActiveTagFilter(active ? null : t.label)}
                  className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded border transition-colors',
                    active ? t.cls : 'bg-transparent border-border/50 text-muted-foreground hover:border-muted-foreground/40',
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto">
            {loadingList ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
              </div>
            ) : (
              <>
                {/* Favorites section */}
                {favoriteDocs.length > 0 && !searchQuery && !activeTagFilter && (
                  <div className="py-1">
                    <div className="flex items-center gap-1 px-3 py-1">
                      <Star className="w-2.5 h-2.5 text-amber-400 fill-amber-400" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Favorites</span>
                    </div>
                    {favoriteDocs.map((doc) => (
                      <div
                        key={doc.id}
                        className={cn(
                          'flex items-center gap-2 px-3 py-1 mx-1 cursor-pointer hover:bg-muted/60 text-xs rounded-sm',
                          selectedId === doc.id ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground',
                        )}
                        onClick={() => void selectDoc(doc.id)}
                      >
                        <span className="shrink-0 w-4 text-center">
                          {doc.emoji ?? '📄'}
                        </span>
                        <span className="flex-1 truncate">{doc.title || 'Untitled'}</span>
                      </div>
                    ))}
                    <div className="mx-2 my-1.5 border-t border-border" />
                  </div>
                )}

                {/* All pages tree */}
                {filteredDocs.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center px-4 py-6">
                    {searchQuery || activeTagFilter ? 'No matching pages' : 'No pages yet'}
                  </p>
                ) : (
                  <div className="py-1">
                    {(searchQuery || activeTagFilter) && (
                      <div className="px-3 py-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Results</span>
                      </div>
                    )}
                    <DocTree
                      docs={filteredDocs}
                      selectedId={selectedId}
                      onSelect={(id) => void selectDoc(id)}
                      onDelete={handleDelete}
                      onFavorite={(id) => void handleFavorite(id)}
                      onNewSubpage={(parentId) => openTemplatePicker(parentId)}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border p-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2 text-muted-foreground text-xs"
              onClick={() => openTemplatePicker()}
            >
              <Plus className="w-3.5 h-3.5" />
              New page
            </Button>
          </div>
        </div>

        {/* Editor panel */}
        <div className={cn(
          'flex-1 flex flex-col overflow-hidden',
          !selectedId && 'hidden lg:flex',
        )}>
          {/* Mobile back */}
          <div className="lg:hidden flex items-center px-4 py-2 border-b border-border shrink-0">
            <button
              onClick={() => { setSelectedId(null); setActiveDocs(null); }}
              className="flex items-center gap-1.5 text-sm text-muted-foreground/70 hover:text-foreground transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              Pages
            </button>
          </div>

          {loadingDoc ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="w-5 h-5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
            </div>
          ) : activeDocs ? (
            <>
              {/* Editor toolbar */}
              <div className="flex items-center gap-1 px-4 py-1.5 border-b border-border shrink-0">
                {/* Breadcrumb */}
                {breadcrumb && breadcrumb.length > 0 && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground mr-2 hidden md:flex">
                    {breadcrumb.map((b, i) => (
                      <span key={b.id} className="flex items-center gap-1">
                        {i > 0 && <span>/</span>}
                        <button
                          type="button"
                          className="hover:text-foreground transition-colors"
                          onClick={() => void selectDoc(b.id)}
                        >
                          {b.emoji} {b.title || 'Untitled'}
                        </button>
                      </span>
                    ))}
                    <span>/</span>
                  </div>
                )}

                <div className="flex-1" />

                {/* Tag chips */}
                {(activeDocs.tags ?? []).length > 0 && (
                  <div className="flex gap-1 items-center mr-1">
                    {activeDocs.tags.map((tag) => (
                      <span
                        key={tag}
                        className={cn(
                          'text-[10px] px-1.5 py-0.5 rounded border font-medium',
                          getTagStyle(tag),
                        )}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Tag picker */}
                <div className="relative group">
                  <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground h-7 px-2">
                    <Tag className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Tags</span>
                  </Button>
                  <div className="absolute right-0 top-8 z-50 hidden group-focus-within:block hover:block w-52 rounded-md border border-border bg-popover shadow-md p-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Classification</p>
                    {GOV_TAGS.map((t) => {
                      const active = activeDocs.tags?.includes(t.label);
                      return (
                        <button
                          key={t.label}
                          type="button"
                          onClick={() => void handleTagToggle(t.label)}
                          className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs hover:bg-muted text-left"
                        >
                          <span className={cn('w-3.5 h-3.5 flex items-center justify-center rounded border text-[9px]', active ? t.cls : 'border-border')}>
                            {active && <Check className="w-2.5 h-2.5" />}
                          </span>
                          {t.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Cover picker */}
                <DocCoverPicker
                  value={activeDocs.coverColor}
                  onChange={(color) => void handleCoverChange(color)}
                />

                {/* Favorite */}
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn('h-7 w-7 p-0', activeDocs.isFavorite ? 'text-amber-400' : 'text-muted-foreground')}
                  title={activeDocs.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                  onClick={() => void handleFavorite(activeDocs.id)}
                >
                  <Star className={cn('w-3.5 h-3.5', activeDocs.isFavorite && 'fill-amber-400')} />
                </Button>

                {/* Export */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground h-7 px-2"
                  title="Export as PDF"
                  onClick={handleExport}
                >
                  <Download className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Export</span>
                </Button>

                {/* Share */}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-7"
                  onClick={() => setShareDialogOpen(true)}
                >
                  <Share2 className="w-3.5 h-3.5" />
                  Share
                </Button>
              </div>

              <DocsEditor
                key={activeDocs.id}
                docId={activeDocs.id}
                initialContent={activeDocs.content}
                title={activeDocs.title}
                onTitleChange={handleTitleChange}
                collaborationToken={collabToken}
                collaborationUser={collabUser}
                coverColor={activeDocs.coverColor}
                tags={activeDocs.tags}
              />

              <ShareDocDialog
                docId={activeDocs.id}
                open={shareDialogOpen}
                onOpenChange={setShareDialogOpen}
                isShared={activeDocs.isShared}
                shareToken={activeDocs.shareToken}
                onShareChange={({ isShared, shareToken }) => {
                  setActiveDocs((prev) => prev ? { ...prev, isShared, shareToken } : prev);
                }}
              />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
              <BookOpen className="w-10 h-10 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">Select a page or create a new one</p>
              <Button size="sm" variant="outline" onClick={() => openTemplatePicker()} className="gap-2">
                <Plus className="w-4 h-4" />
                New page
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Template picker */}
      <TemplatePickerDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        onSelect={(t) => void handleCreateFromTemplate(t)}
      />
    </>
  );
}
