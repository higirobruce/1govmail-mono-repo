'use client';

import { useState } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

function ToggleNodeView({
  node,
  updateAttributes,
}: {
  node: { attrs: Record<string, unknown> };
  updateAttributes: (attrs: Record<string, unknown>) => void;
}) {
  const [isOpen, setIsOpen] = useState<boolean>((node.attrs.open as boolean) ?? true);

  const toggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    updateAttributes({ open: next });
  };

  return (
    <NodeViewWrapper className="my-1">
      <div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={toggle}
            contentEditable={false}
            className="p-0.5 shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronRight
              className={cn('w-3.5 h-3.5 transition-transform duration-150', isOpen && 'rotate-90')}
            />
          </button>
          <input
            defaultValue={(node.attrs.summary as string) ?? 'Toggle'}
            onBlur={(e) => updateAttributes({ summary: e.target.value.trim() || 'Toggle' })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setIsOpen(true);
                updateAttributes({ open: true });
              }
              e.stopPropagation();
            }}
            placeholder="Toggle"
            className="flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground/50 min-w-0 py-0.5 cursor-text"
          />
        </div>
        <div className={cn('pl-5 border-l border-border/50 ml-1.5 mt-0.5', !isOpen && 'hidden')}>
          <NodeViewContent />
        </div>
      </div>
    </NodeViewWrapper>
  );
}

export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      summary: { default: 'Toggle' },
      open: { default: true },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="toggle"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'toggle' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleNodeView);
  },
});
