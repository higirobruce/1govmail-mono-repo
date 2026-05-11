'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';
import { GitBranch, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';

const MERMAID_PLACEHOLDER = `flowchart LR
  A[Start] --> B{Decision}
  B -- Yes --> C[Do something]
  B -- No --> D[Do nothing]
  C --> E[End]
  D --> E`;

let mermaidId = 0;

function MermaidView({ node, updateAttributes, selected }: any) {
  const { code } = node.attrs as { code: string };
  const [editing, setEditing] = useState(!code);
  const [draft, setDraft] = useState(code ?? '');
  const [error, setError] = useState('');
  const svgRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-${++mermaidId}`);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setTimeout(() => textareaRef.current?.focus(), 50);
      return;
    }
    if (!code || !svgRef.current) return;
    setError('');

    import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
      mermaid.render(idRef.current, code)
        .then(({ svg }) => {
          if (svgRef.current) svgRef.current.innerHTML = svg;
        })
        .catch((err: Error) => {
          setError(err.message ?? 'Invalid diagram syntax');
          if (svgRef.current) svgRef.current.innerHTML = '';
        });
    });
  }, [code, editing]);

  const save = () => {
    updateAttributes({ code: draft.trim() });
    setEditing(false);
  };

  const cancel = () => {
    setDraft(code ?? '');
    if (!code) return;
    setEditing(false);
  };

  return (
    <NodeViewWrapper>
      <div
        contentEditable={false}
        className={cn(
          'my-2 rounded-lg border transition-colors overflow-hidden',
          selected ? 'border-primary/50' : 'border-border',
        )}
      >
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-muted/40 border-b border-border">
          <GitBranch className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">Diagram</span>
          {!editing && (
            <button
              type="button"
              onClick={() => { setDraft(code); setEditing(true); }}
              className="ml-auto text-muted-foreground/50 hover:text-foreground transition-colors"
              title="Edit diagram"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {editing ? (
          <div className="p-3">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancel();
                // Allow Tab for indentation
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const s = e.currentTarget.selectionStart;
                  const v = draft;
                  setDraft(v.slice(0, s) + '  ' + v.slice(e.currentTarget.selectionEnd));
                  setTimeout(() => e.currentTarget.setSelectionRange(s + 2, s + 2), 0);
                }
              }}
              rows={8}
              placeholder={MERMAID_PLACEHOLDER}
              className="w-full text-sm font-mono bg-muted/40 rounded-md p-2 outline-none resize-y placeholder:text-muted-foreground/40"
              spellCheck={false}
            />
            <div className="flex items-center justify-between mt-1.5">
              <a
                href="https://mermaid.js.org/syntax/flowchart.html"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-muted-foreground hover:underline"
              >
                Mermaid syntax reference ↗
              </a>
              <div className="flex gap-1.5">
                <button type="button" onClick={cancel} className="text-xs text-muted-foreground px-2 py-0.5 rounded hover:bg-muted">Cancel</button>
                <button type="button" onClick={save} disabled={!draft.trim()} className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded disabled:opacity-40">Render</button>
              </div>
            </div>
          </div>
        ) : (
          <div
            className="cursor-pointer group relative p-4"
            onClick={() => { setDraft(code); setEditing(true); }}
          >
            {error ? (
              <div className="text-xs text-destructive font-mono bg-destructive/10 rounded p-2">{error}</div>
            ) : (
              <div ref={svgRef} className="w-full flex justify-center [&_svg]:max-w-full [&_svg]:h-auto" />
            )}
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

// ── TipTap Node ───────────────────────────────────────────────────────────────

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mermaidBlock: {
      insertMermaidBlock: (attrs?: { code?: string }) => ReturnType;
    };
  }
}

export const MermaidBlock = Node.create({
  name: 'mermaidBlock',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      code: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-mermaid]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-mermaid': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidView);
  },

  addCommands() {
    return {
      insertMermaidBlock:
        (attrs = {}) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});
