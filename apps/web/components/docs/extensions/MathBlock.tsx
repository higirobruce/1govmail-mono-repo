'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { Sigma, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Node view ─────────────────────────────────────────────────────────────────

function MathView({ node, updateAttributes, selected }: any) {
  const { latex, display } = node.attrs as { latex: string; display: boolean };
  const [editing, setEditing] = useState(!latex);
  const [draft, setDraft] = useState(latex ?? '');
  const renderRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setTimeout(() => textareaRef.current?.focus(), 50);
      return;
    }
    if (!latex || !renderRef.current) return;

    import('katex').then(({ default: katex }) => {
      try {
        katex.render(latex, renderRef.current!, {
          displayMode: display,
          throwOnError: false,
          output: 'html',
        });
      } catch {
        if (renderRef.current) renderRef.current.textContent = latex;
      }
    });
  }, [latex, display, editing]);

  const save = () => {
    updateAttributes({ latex: draft.trim() });
    setEditing(false);
  };

  const cancel = () => {
    setDraft(latex ?? '');
    if (!latex) return; // keep editing if nothing saved yet
    setEditing(false);
  };

  return (
    <NodeViewWrapper>
      <div
        contentEditable={false}
        className={cn(
          'my-2 rounded-lg border transition-colors',
          selected ? 'border-primary/50 bg-primary/5' : 'border-border hover:border-border/80',
        )}
      >
        {editing ? (
          <div className="p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Sigma className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">LaTeX equation</span>
            </div>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
                if (e.key === 'Escape') cancel();
              }}
              rows={3}
              placeholder="e.g. \frac{a}{b} = \sqrt{c^2 + d^2}"
              className="w-full text-sm font-mono bg-muted/40 rounded-md p-2 outline-none resize-none placeholder:text-muted-foreground/50"
            />
            <div className="flex justify-between items-center mt-1.5">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none">
                <input
                  type="checkbox"
                  checked={display}
                  onChange={(e) => updateAttributes({ display: e.target.checked })}
                  className="rounded"
                />
                Display mode (centered)
              </label>
              <div className="flex gap-1.5">
                <button type="button" onClick={cancel} className="text-xs text-muted-foreground px-2 py-0.5 rounded hover:bg-muted">Cancel</button>
                <button type="button" onClick={save} disabled={!draft.trim()} className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded disabled:opacity-40">Done</button>
              </div>
            </div>
          </div>
        ) : (
          <div
            className="group relative flex items-center px-4 py-3 cursor-text"
            onClick={() => setEditing(true)}
          >
            <div ref={renderRef} className={cn('w-full', display ? 'text-center' : '')} />
            <button
              type="button"
              title="Edit equation"
              className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-muted transition-all text-muted-foreground"
              onClick={(e) => { e.stopPropagation(); setEditing(true); }}
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

// ── TipTap Node ───────────────────────────────────────────────────────────────

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mathBlock: {
      insertMathBlock: (attrs?: { latex?: string; display?: boolean }) => ReturnType;
    };
  }
}

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      latex:   { default: '' },
      display: { default: true },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-math]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-math': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathView);
  },

  addCommands() {
    return {
      insertMathBlock:
        (attrs = {}) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});
