'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth.store';
import { useConfirmStore } from '@/stores/confirm.store';
import { api, type Doc } from '@/lib/api';
import Sidebar from '@/components/layout/Sidebar';
import { DocsEditor } from '@/components/docs/DocsEditor';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Plus, FileText, MoreHorizontal, Trash2, Loader2, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function DocsPage() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [hydrated, setHydrated] = useState(false);
  const confirm = useConfirmStore((s) => s.confirm);

  const [docs, setDocs] = useState<Doc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeDocs, setActiveDocs] = useState<Doc | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

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
      const message = err instanceof Error ? err.message : 'Failed to load documents';
      toast.error(message);
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
      const message = err instanceof Error ? err.message : 'Failed to load document';
      toast.error(message);
    } finally {
      setLoadingDoc(false);
    }
  }, [selectedId]);

  // Create new doc
  const handleCreate = useCallback(async () => {
    try {
      const doc = await api.docs.create({ title: 'Untitled' });
      setDocs((prev) => [...prev, doc]);
      void selectDoc(doc.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create document';
      toast.error(message);
    }
  }, [selectDoc]);

  // Delete a doc
  const handleDelete = useCallback((id: string) => {
    confirm({
      title: 'Delete document',
      description: 'This document will be permanently deleted.',
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
          const message = err instanceof Error ? err.message : 'Failed to delete document';
          toast.error(message);
        }
      },
    });
  }, [confirm, selectedId]);

  // Update local title after inline rename
  const handleTitleChange = useCallback((newTitle: string) => {
    setDocs((prev) =>
      prev.map((d) => (d.id === selectedId ? { ...d, title: newTitle } : d)),
    );
    setActiveDocs((prev) => prev ? { ...prev, title: newTitle } : prev);
  }, [selectedId]);

  if (!hydrated) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        folders={[]}
        activeFolderId=""
        onFolderSelect={() => router.push('/mail')}
        onCompose={() => router.push('/mail')}
      />

      {/* Page list panel */}
      <div className="w-56 shrink-0 flex flex-col border-r border-border bg-muted/30">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-semibold text-foreground">Pages</span>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={handleCreate}
            title="New page"
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {loadingList ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : docs.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center px-4 py-6">
              No pages yet
            </p>
          ) : (
            docs.map((doc) => (
              <div
                key={doc.id}
                className={cn(
                  'group relative flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted/60 text-sm rounded-sm mx-1',
                  selectedId === doc.id && 'bg-muted text-foreground font-medium',
                  selectedId !== doc.id && 'text-muted-foreground',
                )}
                onClick={() => void selectDoc(doc.id)}
              >
                <span className="shrink-0 w-4 text-center">
                  {doc.emoji ?? <FileText className="w-3.5 h-3.5" />}
                </span>
                <span className="flex-1 truncate">{doc.title || 'Untitled'}</span>
                <button
                  type="button"
                  className="ml-auto opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-muted-foreground/20 transition-opacity"
                  onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === doc.id ? null : doc.id); }}
                  title="Options"
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>

                {/* Inline dropdown */}
                {menuOpenId === doc.id && (
                  <div
                    className="absolute right-1 top-7 z-50 w-36 rounded-md border border-border bg-popover shadow-md py-1"
                    onMouseLeave={() => setMenuOpenId(null)}
                  >
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-destructive"
                      onClick={(e) => { e.stopPropagation(); setMenuOpenId(null); void handleDelete(doc.id); }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <div className="border-t border-border p-3">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground text-xs"
            onClick={handleCreate}
          >
            <Plus className="w-3.5 h-3.5" />
            New page
          </Button>
        </div>
      </div>

      {/* Editor panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {loadingDoc ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : activeDocs ? (
          <DocsEditor
            key={activeDocs.id}
            docId={activeDocs.id}
            initialContent={activeDocs.content}
            title={activeDocs.title}
            onTitleChange={handleTitleChange}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center">
            <BookOpen className="w-10 h-10 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">Select a page or create a new one</p>
            <Button size="sm" variant="outline" onClick={handleCreate} className="gap-2">
              <Plus className="w-4 h-4" />
              New page
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
