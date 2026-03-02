'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';

function CalloutNodeView({ node }: { node: { attrs: Record<string, string> } }) {
  return (
    <NodeViewWrapper>
      <div className="flex gap-3 items-start rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/50 px-4 py-3 my-1">
        <span
          className="text-base leading-5 shrink-0 select-none mt-px"
          contentEditable={false}
        >
          {node.attrs.emoji ?? '💡'}
        </span>
        <NodeViewContent className="flex-1 min-w-0" />
      </div>
    </NodeViewWrapper>
  );
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      emoji: { default: '💡' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutNodeView);
  },
});
