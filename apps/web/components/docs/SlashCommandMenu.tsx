'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  Type, Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks,
  Table, Code, Quote, Minus,
  Lightbulb, ChevronRight,
  LayoutGrid, LayoutList, GalleryHorizontal, GanttChart, CalendarDays,
  Image, Globe, Sigma, GitBranch,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Editor, Range } from '@tiptap/core';

// ── Command items ─────────────────────────────────────────────────────────────

export interface SlashCommandItem {
  title: string;
  description: string;
  icon: React.ReactNode;
  keywords: string[];
  category: string;
  command: (params: { editor: Editor; range: Range }) => void;
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  // ── Basic Blocks ──────────────────────────────────────────────────────────
  {
    title: 'Text',
    description: 'Start writing with plain text',
    icon: <Type className="w-3.5 h-3.5" />,
    keywords: ['text', 'paragraph', 'plain', 'p'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: 'Heading 1',
    description: 'Large section heading',
    icon: <Heading1 className="w-3.5 h-3.5" />,
    keywords: ['h1', 'heading', 'title', 'big'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    description: 'Medium section heading',
    icon: <Heading2 className="w-3.5 h-3.5" />,
    keywords: ['h2', 'heading', 'subtitle'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    description: 'Small section heading',
    icon: <Heading3 className="w-3.5 h-3.5" />,
    keywords: ['h3', 'heading', 'subheading'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(),
  },
  {
    title: 'Bullet List',
    description: 'Unordered list of items',
    icon: <List className="w-3.5 h-3.5" />,
    keywords: ['bullet', 'list', 'unordered', 'ul', '-'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: 'Numbered List',
    description: 'Ordered list of items',
    icon: <ListOrdered className="w-3.5 h-3.5" />,
    keywords: ['numbered', 'ordered', 'list', 'ol', '1.'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: 'Checklist',
    description: 'Track tasks with checkboxes',
    icon: <ListChecks className="w-3.5 h-3.5" />,
    keywords: ['check', 'todo', 'task', 'checklist', '[]'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: 'Callout',
    description: 'Highlight important information',
    icon: <Lightbulb className="w-3.5 h-3.5" />,
    keywords: ['callout', 'note', 'info', 'warning', 'highlight', 'tip', 'alert'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent({
        type: 'callout',
        attrs: { emoji: '💡' },
        content: [{ type: 'paragraph' }],
      }).run(),
  },
  {
    title: 'Toggle',
    description: 'Collapsible section with a title',
    icon: <ChevronRight className="w-3.5 h-3.5" />,
    keywords: ['toggle', 'collapse', 'expand', 'accordion', 'details', 'fold'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent({
        type: 'toggle',
        attrs: { summary: 'Toggle', open: true },
        content: [{ type: 'paragraph' }],
      }).run(),
  },
  {
    title: 'Quote',
    description: 'Highlight a quote or callout',
    icon: <Quote className="w-3.5 h-3.5" />,
    keywords: ['quote', 'blockquote', '>'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: 'Code Block',
    description: 'Monospace code snippet',
    icon: <Code className="w-3.5 h-3.5" />,
    keywords: ['code', 'codeblock', 'pre', 'monospace', '```'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: 'Divider',
    description: 'Visual separator between sections',
    icon: <Minus className="w-3.5 h-3.5" />,
    keywords: ['divider', 'hr', 'separator', 'rule', '---'],
    category: 'Basic Blocks',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },

  // ── Media & Embeds ────────────────────────────────────────────────────────
  {
    title: 'Image',
    description: 'Upload or embed an image',
    icon: <Image className="w-3.5 h-3.5" />,
    keywords: ['image', 'photo', 'picture', 'upload', 'img'],
    category: 'Media',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        try {
          const res = await fetch('/api/upload/image', { method: 'POST', body: formData });
          const { url } = await res.json();
          editor.chain().focus().setImage({ src: url, alt: file.name }).run();
        } catch { /* ignore */ }
      };
      input.click();
    },
  },
  {
    title: 'Embed',
    description: 'YouTube, Figma, Loom, Google Maps',
    icon: <Globe className="w-3.5 h-3.5" />,
    keywords: ['embed', 'youtube', 'figma', 'loom', 'maps', 'video', 'iframe', 'url'],
    category: 'Media',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertEmbed().run(),
  },
  {
    title: 'Math Equation',
    description: 'LaTeX-powered math expression',
    icon: <Sigma className="w-3.5 h-3.5" />,
    keywords: ['math', 'equation', 'latex', 'formula', 'katex', 'sigma', 'integral'],
    category: 'Media',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertMathBlock().run(),
  },
  {
    title: 'Diagram',
    description: 'Mermaid flowchart or sequence diagram',
    icon: <GitBranch className="w-3.5 h-3.5" />,
    keywords: ['diagram', 'mermaid', 'flowchart', 'sequence', 'graph', 'chart', 'flow'],
    category: 'Media',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertMermaidBlock().run(),
  },

  // ── Table ─────────────────────────────────────────────────────────────────
  {
    title: 'Table',
    description: 'Insert a 3×3 structured table',
    icon: <Table className="w-3.5 h-3.5" />,
    keywords: ['table', 'grid', 'spreadsheet', 'rows', 'columns'],
    category: 'Table',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },

  // ── Database ──────────────────────────────────────────────────────────────
  {
    title: 'Board View',
    description: 'Kanban-style card layout',
    icon: <LayoutGrid className="w-3.5 h-3.5" />,
    keywords: ['board', 'kanban', 'card', 'column', 'status', 'trello'],
    category: 'Database',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent({
        type: 'databaseView',
        attrs: { view: 'board', title: 'Board View' },
      }).run(),
  },
  {
    title: 'List View',
    description: 'Linear list with properties',
    icon: <LayoutList className="w-3.5 h-3.5" />,
    keywords: ['list', 'view', 'rows', 'linear', 'flat'],
    category: 'Database',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent({
        type: 'databaseView',
        attrs: { view: 'list', title: 'List View' },
      }).run(),
  },
  {
    title: 'Gallery',
    description: 'Visual card-based gallery',
    icon: <GalleryHorizontal className="w-3.5 h-3.5" />,
    keywords: ['gallery', 'card', 'image', 'grid', 'visual', 'media'],
    category: 'Database',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent({
        type: 'databaseView',
        attrs: { view: 'gallery', title: 'Gallery' },
      }).run(),
  },
  {
    title: 'Timeline',
    description: 'Gantt-style timeline view',
    icon: <GanttChart className="w-3.5 h-3.5" />,
    keywords: ['timeline', 'gantt', 'schedule', 'date', 'project', 'roadmap'],
    category: 'Database',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent({
        type: 'databaseView',
        attrs: { view: 'timeline', title: 'Timeline' },
      }).run(),
  },
  {
    title: 'Calendar',
    description: 'Monthly calendar view',
    icon: <CalendarDays className="w-3.5 h-3.5" />,
    keywords: ['calendar', 'month', 'date', 'event', 'schedule', 'agenda'],
    category: 'Database',
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertContent({
        type: 'databaseView',
        attrs: { view: 'calendar', title: 'Calendar' },
      }).run(),
  },
];

export function filterCommands(query: string): SlashCommandItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.keywords.some((k) => k.includes(q)),
  );
}

// ── Menu component ────────────────────────────────────────────────────────────

export interface SlashCommandMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

interface SlashCommandMenuProps {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
}

export const SlashCommandMenu = forwardRef<SlashCommandMenuHandle, SlashCommandMenuProps>(
  function SlashCommandMenu({ items, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const selectedRef = useRef<HTMLButtonElement>(null);

    // Reset selection when items change
    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    // Scroll selected item into view
    useEffect(() => {
      selectedRef.current?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    useImperativeHandle(ref, () => ({
      onKeyDown(event: KeyboardEvent) {
        if (event.key === 'ArrowDown') {
          setSelectedIndex((i) => (i + 1) % Math.max(items.length, 1));
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelectedIndex((i) => (i - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1));
          return true;
        }
        if (event.key === 'Enter') {
          const item = items[selectedIndex];
          if (item) command(item);
          return true;
        }
        if (event.key === 'Escape') {
          return true; // DocsEditor closes the menu on Escape
        }
        return false;
      },
    }));

    if (!items.length) {
      return (
        <div className="px-3 py-2 text-xs text-muted-foreground">No results</div>
      );
    }

    // Group by category while preserving flat indices for keyboard navigation
    const groups: { category: string; entries: { item: SlashCommandItem; index: number }[] }[] = [];
    items.forEach((item, index) => {
      const cat = item.category ?? 'Other';
      const last = groups[groups.length - 1];
      if (!last || last.category !== cat) {
        groups.push({ category: cat, entries: [{ item, index }] });
      } else {
        last.entries.push({ item, index });
      }
    });

    return (
      <div className="flex flex-col py-1">
        {groups.map(({ category, entries }) => (
          <div key={category}>
            <div className="px-2.5 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 select-none">
              {category}
            </div>
            {entries.map(({ item, index }) => (
              <button
                key={item.title}
                ref={index === selectedIndex ? selectedRef : undefined}
                type="button"
                onClick={() => command(item)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={cn(
                  'flex items-center gap-2.5 px-2.5 py-1.5 text-left w-full transition-colors',
                  index === selectedIndex
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-accent/50',
                )}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border bg-background text-muted-foreground">
                  {item.icon}
                </span>
                <span className="flex flex-col min-w-0">
                  <span className="text-xs font-medium leading-tight">{item.title}</span>
                  <span className="text-[10px] text-muted-foreground leading-tight truncate">{item.description}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    );
  },
);
