'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, FileText, Loader2, Paperclip, Link2, Star } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api, type Doc } from '@/lib/api';
import { buildTree, type DocTreeNode } from '@/components/docs/DocTree';
import { cn } from '@/lib/utils';

export type DocAttachMode = 'pdf' | 'link';

interface DocPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onPick: (doc: Doc, mode: DocAttachMode) => void;
}

function matchesQuery(doc: Doc, q: string): boolean {
  if (!q) return true;
  return doc.title.toLowerCase().includes(q.toLowerCase());
}

function filterTree(nodes: DocTreeNode[], q: string): DocTreeNode[] {
  if (!q) return nodes;
  return nodes
    .map((n) => ({ ...n, children: filterTree(n.children, q) }))
    .filter((n) => matchesQuery(n, q) || n.children.length > 0);
}

interface DocRowProps {
  node: DocTreeNode;
  depth: number;
  busyId: string | null;
  onPick: (doc: Doc, mode: DocAttachMode) => void;
}

function DocRow({ node, depth, busyId, onPick }: DocRowProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const isBusy = busyId === node.id;

  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1 py-1.5 text-sm rounded-sm mx-1 hover:bg-muted/60',
          isBusy && 'opacity-50 pointer-events-none',
        )}
        style={{ paddingLeft: `${8 + depth * 14}px`, paddingRight: '6px' }}
      >
        <button
          type="button"
          className="shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-muted-foreground/20"
          onClick={() => setExpanded((v) => !v)}
        >
          {hasChildren ? (
            <ChevronRight className={cn('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
          ) : (
            <span className="w-3 h-3" />
          )}
        </button>

        <span className="shrink-0 w-4 text-center text-xs leading-none">
          {node.emoji ? node.emoji : <FileText className="w-3.5 h-3.5 inline text-muted-foreground/60" />}
        </span>

        <span className="flex-1 truncate">{node.title || 'Untitled'}</span>

        {node.isFavorite && <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400 shrink-0" />}

        {isBusy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground/60 shrink-0" />
        ) : (
          <div className="ml-auto opacity-0 group-hover:opacity-100 flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] gap-1 text-muted-foreground/70 hover:text-foreground"
              onClick={() => onPick(node, 'pdf')}
              title="Attach as PDF"
            >
              <Paperclip className="w-3 h-3" /> PDF
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] gap-1 text-muted-foreground/70 hover:text-foreground"
              onClick={() => onPick(node, 'link')}
              title="Insert share link"
            >
              <Link2 className="w-3 h-3" /> Link
            </Button>
          </div>
        )}
      </div>

      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <DocRow key={child.id} node={child} depth={depth + 1} busyId={busyId} onPick={onPick} />
          ))}
        </div>
      )}
    </div>
  );
}

export function DocPickerDialog({ open, onClose, onPick }: DocPickerDialogProps) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: docs = [], isLoading } = useQuery<Doc[]>({
    queryKey: ['docs'],
    queryFn: () => api.docs.getAll(),
    staleTime: 60_000,
    enabled: open,
  });

  const tree = filterTree(buildTree(docs), query.trim());
  const favorites = docs.filter((d) => d.isFavorite);

  const handlePick = async (doc: Doc, mode: DocAttachMode) => {
    setBusyId(doc.id);
    try {
      await Promise.resolve(onPick(doc, mode));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] p-0 flex flex-col gap-0">
        <DialogHeader className="px-5 py-4 border-b border-border/40">
          <DialogTitle className="text-sm font-semibold">Attach a document</DialogTitle>
        </DialogHeader>

        <div className="px-5 py-3 border-b border-border/40">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your documents…"
            className="h-8 text-sm bg-muted/30 border-border/50"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto py-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/50" />
            </div>
          ) : docs.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 text-center py-12">
              You have no documents yet.
            </p>
          ) : tree.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 text-center py-12">
              No documents match &quot;{query}&quot;.
            </p>
          ) : (
            <>
              {!query && favorites.length > 0 && (
                <>
                  <p className="px-4 py-1 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
                    Favorites
                  </p>
                  {favorites.map((fav) => (
                    <DocRow
                      key={`fav-${fav.id}`}
                      node={{ ...fav, children: [] }}
                      depth={0}
                      busyId={busyId}
                      onPick={handlePick}
                    />
                  ))}
                  <p className="px-4 py-1 mt-2 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider">
                    All documents
                  </p>
                </>
              )}
              {tree.map((node) => (
                <DocRow key={node.id} node={node} depth={0} busyId={busyId} onPick={handlePick} />
              ))}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border/40 flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground/50">
            PDF attaches the doc. Link inserts a share link into the body.
          </p>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 text-muted-foreground/70">
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
