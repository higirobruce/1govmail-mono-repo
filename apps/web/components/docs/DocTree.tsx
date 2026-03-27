'use client';

import { useState } from 'react';
import { ChevronRight, FileText, Plus, MoreHorizontal, Star, Trash2, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Doc } from '@/lib/api';

export interface DocTreeNode extends Doc {
  children: DocTreeNode[];
}

export function buildTree(docs: Doc[], parentId: string | null = null): DocTreeNode[] {
  return docs
    .filter((d) => (d.parentId ?? null) === parentId)
    .sort((a, b) => a.position - b.position || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((d) => ({ ...d, children: buildTree(docs, d.id) }));
}

interface DocTreeItemProps {
  node: DocTreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onFavorite: (id: string) => void;
  onNewSubpage: (parentId: string) => void;
  onDuplicate: (id: string) => void;
}

function DocTreeItem({ node, depth, selectedId, onSelect, onDelete, onFavorite, onNewSubpage, onDuplicate }: DocTreeItemProps) {
  const [expanded, setExpanded] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={cn(
          'group relative flex items-center gap-1 py-1 cursor-pointer hover:bg-muted/60 text-sm rounded-sm mx-1',
          selectedId === node.id && 'bg-muted text-foreground font-medium',
          selectedId !== node.id && 'text-muted-foreground',
        )}
        style={{ paddingLeft: `${12 + depth * 14}px`, paddingRight: '4px' }}
        onClick={() => void onSelect(node.id)}
      >
        <button
          type="button"
          className="shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-muted-foreground/20"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
        >
          {hasChildren
            ? <ChevronRight className={cn('w-3 h-3 transition-transform', expanded && 'rotate-90')} />
            : <span className="w-3 h-3" />
          }
        </button>

        <span className="shrink-0 w-4 text-center text-xs leading-none">
          {node.emoji ? node.emoji : <FileText className="w-3.5 h-3.5 inline" />}
        </span>

        <span className="flex-1 truncate text-sm">{node.title || 'Untitled'}</span>

        {node.isFavorite && (
          <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400 shrink-0" />
        )}

        <div className="ml-auto opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            className="p-0.5 rounded hover:bg-muted-foreground/20"
            title="New subpage"
            onClick={(e) => { e.stopPropagation(); onNewSubpage(node.id); }}
          >
            <Plus className="w-3 h-3" />
          </button>
          <button
            type="button"
            className="p-0.5 rounded hover:bg-muted-foreground/20"
            title="Options"
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
          >
            <MoreHorizontal className="w-3 h-3" />
          </button>
        </div>

        {menuOpen && (
          <div
            className="absolute right-1 top-7 z-50 w-44 rounded-md border border-border bg-popover shadow-md py-1"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onFavorite(node.id); }}
            >
              <Star className={cn('w-3.5 h-3.5', node.isFavorite && 'fill-amber-400 text-amber-400')} />
              {node.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onNewSubpage(node.id); }}
            >
              <Plus className="w-3.5 h-3.5" />
              New subpage
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDuplicate(node.id); }}
            >
              <Copy className="w-3.5 h-3.5" />
              Duplicate
            </button>
            <hr className="my-1 border-border" />
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-destructive"
              onClick={(e) => { e.stopPropagation(); setMenuOpen(false); onDelete(node.id); }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        )}
      </div>

      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <DocTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onDelete={onDelete}
              onFavorite={onFavorite}
              onNewSubpage={onNewSubpage}
              onDuplicate={onDuplicate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface DocTreeProps {
  docs: Doc[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onFavorite: (id: string) => void;
  onNewSubpage: (parentId: string) => void;
  onDuplicate: (id: string) => void;
}

export function DocTree({ docs, selectedId, onSelect, onDelete, onFavorite, onNewSubpage, onDuplicate }: DocTreeProps) {
  const tree = buildTree(docs);

  if (tree.length === 0) {
    return (
      <p className="text-xs text-muted-foreground text-center px-4 py-6">No pages yet</p>
    );
  }

  return (
    <div>
      {tree.map((node) => (
        <DocTreeItem
          key={node.id}
          node={node}
          depth={0}
          selectedId={selectedId}
          onSelect={onSelect}
          onDelete={onDelete}
          onFavorite={onFavorite}
          onNewSubpage={onNewSubpage}
          onDuplicate={onDuplicate}
        />
      ))}
    </div>
  );
}
