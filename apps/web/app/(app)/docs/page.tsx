'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { useConfirmStore } from '@/stores/confirm.store';
import { api, type Doc, type InvitedDoc } from '@/lib/api';
import Sidebar from '@/components/layout/Sidebar';
import { MobileSidebarSheet } from '@/components/layout/MobileSidebarSheet';
import { DocsEditor } from '@/components/docs/DocsEditor';
import { DocTree } from '@/components/docs/DocTree';
import { TemplatePickerDialog } from '@/components/docs/TemplatePickerDialog';
import { SaveAsTemplateDialog } from '@/components/docs/SaveAsTemplateDialog';
import { ShareDocDialog } from '@/components/docs/ShareDocDialog';
import { COVER_OPTIONS } from '@/components/docs/DocCoverPicker';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import {
  Plus, BookOpen, Share2, Menu, ChevronLeft,
  Search, Star, Tag, Download, X, Check, MoreHorizontal, Palette,
} from 'lucide-react';
import { cn, getUserColor } from '@/lib/utils';
import { exportAsPdf, exportAsMarkdown, exportAsDocx } from '@/lib/docExport';
import { CLASSIFICATIONS as GOV_TAGS } from '@/lib/classification';


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
  const [sharedWithMe, setSharedWithMe] = useState<InvitedDoc[]>([]);
  const [selectedId, setSelectedId]   = useState<string | null>(null);
  const [activeDocs, setActiveDocs]   = useState<Doc | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDoc, setLoadingDoc]   = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [templateOpen, setTemplateOpen]       = useState(false);
  const [pendingParentId, setPendingParentId] = useState<string | null>(null);
  const [saveAsTemplateDocId, setSaveAsTemplateDocId] = useState<string | null>(null);

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
      const [owned, shared] = await Promise.all([
        api.docs.getAll(),
        api.docs.getSharedWithMe(),
      ]);
      setDocs(owned);
      setSharedWithMe(shared);
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

  // Duplicate a doc
  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const newDoc = await api.docs.duplicate(id);
      setDocs((prev) => [...prev, newDoc]);
      void selectDoc(newDoc.id);
      toast.success('Document duplicated');
    } catch {
      toast.error('Failed to duplicate document');
    }
  }, [selectDoc]);

  // Move a doc to a new parent via drag & drop
  const handleMoveToParent = useCallback(async (docId: string, newParentId: string) => {
    try {
      await api.docs.update(docId, { parentId: newParentId });
      setDocs((prev) => prev.map((d) => d.id === docId ? { ...d, parentId: newParentId } : d));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to move document');
    }
  }, []);

  // Open save-as-template dialog for a doc
  const handleSaveAsTemplate = useCallback((id: string) => {
    setSaveAsTemplateDocId(id);
  }, []);

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

  // Tracks the latest editor content without triggering re-renders
  const liveContentRef = useRef<string | null | undefined>(null);
  useEffect(() => { liveContentRef.current = activeDocs?.content; }, [activeDocs]);

  const [exporting, setExporting] = useState<string | null>(null);

  const handleExport = useCallback(async (format: 'pdf' | 'md' | 'docx') => {
    if (!activeDocs || exporting) return;
    setExporting(format);
    try {
      const title = activeDocs.title || 'Untitled';
      const content = liveContentRef.current;
      if (format === 'pdf')  await exportAsPdf(title, content);
      if (format === 'md')   await exportAsMarkdown(title, content);
      if (format === 'docx') await exportAsDocx(title, content);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(null);
    }
  }, [activeDocs, exporting]);

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
                      onDuplicate={(id) => void handleDuplicate(id)}
                      onSaveAsTemplate={handleSaveAsTemplate}
                      onMoveToParent={(docId, newParentId) => void handleMoveToParent(docId, newParentId)}
                    />
                  </div>
                )}

                {/* Shared with me section */}
                {sharedWithMe.length > 0 && !searchQuery && !activeTagFilter && (
                  <div className="py-1">
                    <div className="mx-2 mb-1.5 border-t border-border" />
                    <div className="flex items-center gap-1 px-3 py-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Shared with me</span>
                    </div>
                    {sharedWithMe.map((doc) => (
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
                        <span className={cn(
                          'text-[9px] px-1 py-0.5 rounded border shrink-0',
                          doc._invite.role === 'VIEWER'
                            ? 'bg-muted/60 border-border/60 text-muted-foreground'
                            : 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400',
                        )}>
                          {doc._invite.role === 'VIEWER' ? 'Viewer' : 'Editor'}
                        </span>
                      </div>
                    ))}
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
                  <div className="hidden md:flex items-center gap-1 text-xs text-muted-foreground mr-2">
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

                {/* Share */}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-7 text-xs"
                  onClick={() => setShareDialogOpen(true)}
                >
                  <Share2 className="w-3.5 h-3.5" />
                  Share
                </Button>

                {/* More options */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground">
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuItem onClick={() => void handleFavorite(activeDocs.id)}>
                      <Star className={cn('w-3.5 h-3.5 mr-2 shrink-0', activeDocs.isFavorite && 'fill-amber-400 text-amber-400')} />
                      {activeDocs.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                    </DropdownMenuItem>

                    <DropdownMenuSeparator />

                    {/* Tags sub-menu */}
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Tag className="w-3.5 h-3.5 mr-2 shrink-0" />
                        Tags
                        {(activeDocs.tags ?? []).length > 0 && (
                          <span className="ml-auto text-[10px] text-muted-foreground">{activeDocs.tags.length}</span>
                        )}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {GOV_TAGS.map((t) => {
                          const active = activeDocs.tags?.includes(t.label);
                          return (
                            <DropdownMenuItem key={t.label} onClick={() => void handleTagToggle(t.label)}>
                              <span className={cn('w-3 h-3 mr-2 shrink-0 rounded-sm border flex items-center justify-center', active ? t.cls : 'border-border')}>
                                {active && <Check className="w-2 h-2" />}
                              </span>
                              {t.label}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>

                    {/* Cover sub-menu */}
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Palette className="w-3.5 h-3.5 mr-2 shrink-0" />
                        Cover
                        {activeDocs.coverColor && (
                          <span className={cn('ml-auto w-3 h-3 rounded-sm', `bg-${activeDocs.coverColor}-600`)} />
                        )}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <div className="grid grid-cols-4 gap-1 p-1">
                          {COVER_OPTIONS.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              title={c.label}
                              onClick={() => void handleCoverChange(c.value)}
                              className={cn(
                                'w-8 h-8 rounded border-2 transition-all',
                                c.cls,
                                activeDocs.coverColor === c.value ? 'border-foreground scale-110' : 'border-transparent hover:scale-105',
                              )}
                            />
                          ))}
                        </div>
                        {activeDocs.coverColor && (
                          <DropdownMenuItem onClick={() => void handleCoverChange(null)}>
                            <X className="w-3.5 h-3.5 mr-2" /> Remove cover
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>

                    <DropdownMenuSeparator />

                    <DropdownMenuItem disabled={!!exporting} onClick={() => void handleExport('pdf')}>
                      <Download className="w-3.5 h-3.5 mr-2 shrink-0" />
                      {exporting === 'pdf' ? 'Exporting…' : 'Export as PDF'}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!!exporting} onClick={() => void handleExport('md')}>
                      <Download className="w-3.5 h-3.5 mr-2 shrink-0" />
                      {exporting === 'md' ? 'Exporting…' : 'Export as Markdown'}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!!exporting} onClick={() => void handleExport('docx')}>
                      <Download className="w-3.5 h-3.5 mr-2 shrink-0" />
                      {exporting === 'docx' ? 'Exporting…' : 'Export as Word'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <DocsEditor
                key={activeDocs.id}
                docId={activeDocs.id}
                initialContent={activeDocs.content}
                title={activeDocs.title}
                onTitleChange={handleTitleChange}
                onContentChange={(c) => { liveContentRef.current = c; }}
                collaborationToken={collabToken}
                collaborationUser={collabUser}
                coverColor={activeDocs.coverColor}
                tags={activeDocs.tags}
                editable={activeDocs._invite?.role !== 'VIEWER'}
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
                isOwner={!activeDocs._invite}
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

      {/* Save as template */}
      {(() => {
        const doc = saveAsTemplateDocId ? docs.find((d) => d.id === saveAsTemplateDocId) : null;
        return (
          <SaveAsTemplateDialog
            open={!!saveAsTemplateDocId}
            onOpenChange={(open) => { if (!open) setSaveAsTemplateDocId(null); }}
            docId={saveAsTemplateDocId}
            docTitle={doc?.title ?? 'Untitled'}
            docEmoji={doc?.emoji ?? null}
            onSaved={() => {
              toast.success('Template saved');
              setSaveAsTemplateDocId(null);
            }}
          />
        );
      })()}
    </>
  );
}
