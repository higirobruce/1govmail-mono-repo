'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import Placeholder from '@tiptap/extension-placeholder';
import { Callout } from './extensions/Callout';
import { Toggle } from './extensions/Toggle';
import { DatabaseView } from './extensions/DatabaseView';
import { CodeBlockLowlight } from './extensions/CodeBlockLowlight';
import {
  Bold, Italic, Underline as UnderlineIcon,
  Heading1, Heading2, Heading3,
  List, ListOrdered, ListChecks,
  Table as TableIcon, Code, Quote, Minus,
  Check, Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import {
  SlashCommandMenu,
  filterCommands,
  type SlashCommandItem,
  type SlashCommandMenuHandle,
} from './SlashCommandMenu';

interface DocsEditorProps {
  docId: string;
  initialContent: string | null | undefined;
  title: string;
  onTitleChange: (title: string) => void;
}

type SaveState = 'saved' | 'saving' | 'unsaved';

interface SlashMenuState {
  items: SlashCommandItem[];
  rect: DOMRect;
  onSelect: (item: SlashCommandItem) => void;
}

function ToolbarBtn({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={title}
      className={cn(
        'p-1.5 rounded hover:bg-muted transition-colors',
        active && 'bg-muted text-foreground',
        !active && 'text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}

export function DocsEditor({ docId, initialContent, title, onTitleChange }: DocsEditorProps) {
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // ── Slash menu ──────────────────────────────────────────────────────────────
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const menuRef = useRef<SlashCommandMenuHandle>(null);

  // ── Content persistence ─────────────────────────────────────────────────────
  const persistContent = useCallback(
    async (json: string) => {
      setSaveState('saving');
      try {
        await api.docs.update(docId, { content: json });
        setSaveState('saved');
      } catch {
        setSaveState('unsaved');
      }
    },
    [docId],
  );

  // ── Editor ──────────────────────────────────────────────────────────────────
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      TaskList,
      TaskItem.configure({ nested: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      CodeBlockLowlight,
      Callout,
      Toggle,
      DatabaseView,
      Placeholder.configure({
        placeholder: "Start writing, or type '/' for commands…",
      }),
    ],
    content: initialContent ? JSON.parse(initialContent) : '',
    onUpdate({ editor: ed }) {
      setSaveState('unsaved');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void persistContent(JSON.stringify(ed.getJSON()));
      }, 500);
    },
  });

  // ── Slash command detection ─────────────────────────────────────────────────
  // Detects `/query` at the current cursor position and shows the floating menu.
  // Uses editor events instead of the suggestion ProseMirror plugin to avoid
  // plugin-state initialisation conflicts.
  useEffect(() => {
    if (!editor) return;

    const detect = () => {
      const { state } = editor;
      const { $from } = state.selection;

      // Only trigger inside paragraph nodes
      if ($from.parent.type.name !== 'paragraph') {
        setSlashMenu(null);
        return;
      }

      const textBefore = $from.parent.textContent.slice(0, $from.parentOffset);

      // Must start with '/' and contain no spaces
      if (!textBefore.startsWith('/') || textBefore.includes(' ')) {
        setSlashMenu(null);
        return;
      }

      const query = textBefore.slice(1);
      const items = filterCommands(query);

      // Position menu below the cursor
      const coords = editor.view.coordsAtPos($from.pos);
      const rect = new DOMRect(coords.left, coords.bottom, 0, 0);

      const from = $from.pos - textBefore.length;
      const to = $from.pos;

      setSlashMenu({
        items,
        rect,
        onSelect: (item) => {
          item.command({ editor, range: { from, to } });
          setSlashMenu(null);
        },
      });
    };

    const hide = () => {
      const { $from } = editor.state.selection;
      const textBefore = $from.parent.textContent.slice(0, $from.parentOffset);
      if (!textBefore.startsWith('/') || textBefore.includes(' ')) {
        setSlashMenu(null);
      }
    };

    editor.on('update', detect);
    editor.on('selectionUpdate', hide);
    return () => {
      editor.off('update', detect);
      editor.off('selectionUpdate', hide);
    };
  }, [editor]);

  // ── Keyboard interception when slash menu is open ───────────────────────────
  useEffect(() => {
    if (!editor || !slashMenu) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const handled = menuRef.current?.onKeyDown(e) ?? false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape') setSlashMenu(null);
      }
    };

    // capture=true so we intercept before ProseMirror
    editor.view.dom.addEventListener('keydown', handleKeyDown, true);
    return () => editor.view.dom.removeEventListener('keydown', handleKeyDown, true);
  }, [editor, slashMenu]);

  // ── Reload content on doc switch ────────────────────────────────────────────
  useEffect(() => {
    if (!editor) return;
    const parsed = initialContent ? JSON.parse(initialContent) : '';
    editor.commands.setContent(parsed, false);
    setSaveState('saved');
    setSlashMenu(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  const handleTitleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    const text = e.currentTarget.value.trim() || 'Untitled';
    onTitleChange(text);
    void api.docs.update(docId, { title: text });
  }, [docId, onTitleChange]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      editor?.commands.focus('start');
    }
  }, [editor]);

  if (!editor) return null;

  // ── Slash menu position (fixed, clamp to viewport) ──────────────────────────
  const menuStyle = slashMenu
    ? {
        position: 'fixed' as const,
        top: Math.min(slashMenu.rect.bottom + 4, window.innerHeight - 340),
        left: Math.min(slashMenu.rect.left, window.innerWidth - 296),
        zIndex: 50,
      }
    : undefined;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-4 py-2 border-b border-border flex-wrap">
        <ToolbarBtn title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
          <Bold className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <Italic className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn title="Underline" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
          <UnderlineIcon className="w-4 h-4" />
        </ToolbarBtn>

        <div className="w-px h-5 bg-border mx-1" />

        <ToolbarBtn title="Heading 1" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
          <Heading1 className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn title="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
          <Heading2 className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn title="Heading 3" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
          <Heading3 className="w-4 h-4" />
        </ToolbarBtn>

        <div className="w-px h-5 bg-border mx-1" />

        <ToolbarBtn title="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <List className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          <ListOrdered className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn title="Checklist" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}>
          <ListChecks className="w-4 h-4" />
        </ToolbarBtn>

        <div className="w-px h-5 bg-border mx-1" />

        <ToolbarBtn title="Table" active={editor.isActive('table')} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
          <TableIcon className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn title="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
          <Code className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn title="Blockquote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          <Quote className="w-4 h-4" />
        </ToolbarBtn>
        <ToolbarBtn title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          <Minus className="w-4 h-4" />
        </ToolbarBtn>

        {/* Save indicator */}
        <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground select-none">
          {saveState === 'saving' && <Loader2 className="w-3 h-3 animate-spin" />}
          {saveState === 'saved' && <Check className="w-3 h-3 text-green-500" />}
          <span>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Unsaved'}
          </span>
        </div>
      </div>

      {/* Title + body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-10">
          <input
            ref={titleRef}
            defaultValue={title}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            placeholder="Untitled"
            className="w-full text-3xl font-bold outline-none mb-6 bg-transparent placeholder:text-muted-foreground/40"
          />

          <EditorContent
            editor={editor}
            className={cn(
              'prose prose-sm max-w-none dark:prose-invert',
              'prose-headings:font-semibold',
              'prose-blockquote:border-l-2 prose-blockquote:border-border prose-blockquote:text-muted-foreground',
              '[&_.tiptap]:outline-none [&_.tiptap]:min-h-[300px]',
              '[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0',
              '[&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:items-start [&_ul[data-type=taskList]_li]:gap-2',
              '[&_ul[data-type=taskList]_li_label]:mt-0.5',
              '[&_table]:border-collapse [&_table]:w-full',
              '[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
              '[&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:bg-muted [&_th]:font-semibold [&_th]:text-left',
              '[&_.tiptap_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)] [&_.tiptap_p.is-editor-empty:first-child]:before:text-muted-foreground/50 [&_.tiptap_p.is-editor-empty:first-child]:before:float-left [&_.tiptap_p.is-editor-empty:first-child]:before:pointer-events-none [&_.tiptap_p.is-editor-empty:first-child]:before:h-0',
            )}
          />
        </div>
      </div>

      {/* Slash command floating menu */}
      {slashMenu && (
        <div
          style={menuStyle}
          className="w-72 rounded-lg border border-border bg-popover shadow-lg overflow-hidden max-h-80 overflow-y-auto"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <SlashCommandMenu
            ref={menuRef}
            items={slashMenu.items}
            command={(item) => {
              slashMenu.onSelect(item);
            }}
          />
        </div>
      )}
    </div>
  );
}
