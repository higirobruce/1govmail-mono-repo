'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { LayoutGrid, LayoutList, GalleryHorizontal, GanttChart, CalendarDays } from 'lucide-react';

const VIEW_META = {
  board: {
    label: 'Board View',
    Icon: LayoutGrid,
    classes:
      'border-blue-200 dark:border-blue-800/50 bg-blue-50 dark:bg-blue-950/20 text-blue-600 dark:text-blue-400',
  },
  list: {
    label: 'List View',
    Icon: LayoutList,
    classes:
      'border-green-200 dark:border-green-800/50 bg-green-50 dark:bg-green-950/20 text-green-600 dark:text-green-400',
  },
  gallery: {
    label: 'Gallery',
    Icon: GalleryHorizontal,
    classes:
      'border-purple-200 dark:border-purple-800/50 bg-purple-50 dark:bg-purple-950/20 text-purple-600 dark:text-purple-400',
  },
  timeline: {
    label: 'Timeline',
    Icon: GanttChart,
    classes:
      'border-orange-200 dark:border-orange-800/50 bg-orange-50 dark:bg-orange-950/20 text-orange-600 dark:text-orange-400',
  },
  calendar: {
    label: 'Calendar',
    Icon: CalendarDays,
    classes:
      'border-rose-200 dark:border-rose-800/50 bg-rose-50 dark:bg-rose-950/20 text-rose-600 dark:text-rose-400',
  },
} as const;

type ViewType = keyof typeof VIEW_META;

function DatabaseNodeView({ node }: { node: { attrs: Record<string, string> } }) {
  const view = (node.attrs.view ?? 'board') as ViewType;
  const meta = VIEW_META[view] ?? VIEW_META.board;
  const { Icon, label, classes } = meta;

  return (
    <NodeViewWrapper contentEditable={false}>
      <div
        className={`flex items-center gap-3 rounded-lg border ${classes} px-4 py-3 my-1 select-none cursor-default`}
      >
        <Icon className="w-5 h-5 shrink-0" />
        <div>
          <p className="text-sm font-medium leading-tight">{node.attrs.title || label}</p>
          <p className="text-[11px] opacity-60 leading-tight mt-0.5">Database · coming soon</p>
        </div>
      </div>
    </NodeViewWrapper>
  );
}

export const DatabaseView = Node.create({
  name: 'databaseView',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      view: { default: 'board' },
      title: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="database-view"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'database-view' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DatabaseNodeView);
  },
});
