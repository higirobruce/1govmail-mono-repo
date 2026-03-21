'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import Placeholder from '@tiptap/extension-placeholder';
import { Collaboration, isChangeOrigin } from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Callout } from './extensions/Callout';
import { Toggle } from './extensions/Toggle';
import { DatabaseView } from './extensions/DatabaseView';
import { CodeBlockLowlight } from './extensions/CodeBlockLowlight';
import { TableOfContents } from './TableOfContents';
import {
  Check, Loader2, PanelRight, X, MessageSquare, MessageSquarePlus,
  ArrowDownToLine, ArrowUpToLine, ArrowRightToLine, ArrowLeftToLine,
  Trash2, Columns2, Rows3,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import {
  SlashCommandMenu,
  filterCommands,
  type SlashCommandItem,
  type SlashCommandMenuHandle,
} from './SlashCommandMenu';
import { getCoverClass } from './DocCoverPicker';
import { CommentMark } from './CommentMark';
import { CommentPanel } from './CommentPanel';

const COLLAB_URL = process.env.NEXT_PUBLIC_COLLAB_WS_URL ?? 'ws://localhost:1234';

interface DocsEditorProps {
  docId: string;
  initialContent: string | null | undefined;
  title: string;
  onTitleChange: (title: string) => void;
  onTitleSave?: (title: string) => Promise<void>;
  onContentChange?: (content: string) => void;
  collaborationToken: string;
  collaborationUser?: { name: string; color: string };
  coverColor?: string | null;
  tags?: string[];
  editable?: boolean;
}

type SaveState = 'saved' | 'saving' | 'unsaved';

interface SlashMenuState {
  items: SlashCommandItem[];
  rect: DOMRect;
  onSelect: (item: SlashCommandItem) => void;
}

function getWordCount(ed: Editor): { words: number; chars: number } {
  const text = ed.getText();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return { words, chars: text.length };
}

export function DocsEditor({
  docId,
  initialContent,
  title,
  onTitleChange,
  onTitleSave,
  onContentChange,
  collaborationToken,
  coverColor,
  editable = true,
}: DocsEditorProps) {
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [synced, setSynced] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [pendingAnchorId, setPendingAnchorId] = useState<string | null>(null);
  const [commentBtnPos, setCommentBtnPos] = useState<{ x: number; y: number } | null>(null);
  const [wordCount, setWordCount] = useState({ words: 0, chars: 0 });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const destroyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const syncedRef = useRef(false);

  // ── Slash menu ──────────────────────────────────────────────────────────────
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const menuRef = useRef<SlashCommandMenuHandle>(null);

  // ── Yjs + Hocuspocus ───────────────────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ydoc = useMemo(() => new Y.Doc(), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const provider = useMemo(
    () =>
      new HocuspocusProvider({
        url: COLLAB_URL,
        name: docId,
        document: ydoc,
        token: collaborationToken,
        onSynced() {
          const fragment = ydoc.getXmlFragment('default');
          if (fragment.length === 0 && initialContent) {
            editorRef.current?.commands.setContent(
              JSON.parse(initialContent),
              { emitUpdate: false },
            );
          }
          syncedRef.current = true;
          setSynced(true);
          setSaveState('saved');
        },
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    if (destroyTimer.current !== null) {
      clearTimeout(destroyTimer.current);
      destroyTimer.current = null;
    }
    const p = provider;
    const y = ydoc;
    return () => {
      destroyTimer.current = setTimeout(() => {
        destroyTimer.current = null;
        p.destroy();
        y.destroy();
      }, 0);
    };
  }, [provider, ydoc]);

  // ── Content persistence ────────────────────────────────────────────────────
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

  // ── Editor ─────────────────────────────────────────────────────────────────
  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Collaboration.configure({ document: ydoc }),
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
      CommentMark,
    ],
    onUpdate({ editor: ed, transaction }) {
      if (isChangeOrigin(transaction)) return;
      setSaveState('unsaved');
      setWordCount(getWordCount(ed));
      const json = JSON.stringify(ed.getJSON());
      onContentChange?.(json);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void persistContent(json);
      }, 500);
    },
  });

  useEffect(() => {
    editorRef.current = editor;
    if (editor) setWordCount(getWordCount(editor));
  }, [editor]);

  // ── Real-time title sync via Yjs ───────────────────────────────────────────
  useEffect(() => {
    if (!synced) return;
    const metaMap = ydoc.getMap<string>('meta');

    const yjsTitle = metaMap.get('title');
    if (yjsTitle && titleRef.current) {
      titleRef.current.value = yjsTitle;
      onTitleChange(yjsTitle);
    }

    const observer = (event: Y.YMapEvent<string>) => {
      if (!event.keysChanged.has('title')) return;
      const remoteTitle = metaMap.get('title') ?? '';
      if (titleRef.current && document.activeElement !== titleRef.current) {
        titleRef.current.value = remoteTitle;
        onTitleChange(remoteTitle);
      }
    };

    metaMap.observe(observer);
    return () => metaMap.unobserve(observer);
  }, [synced, ydoc, onTitleChange]);

  // ── Slash command detection ────────────────────────────────────────────────
  useEffect(() => {
    if (!editor) return;

    const detect = () => {
      const { state } = editor;
      const { $from } = state.selection;

      if ($from.parent.type.name !== 'paragraph') {
        setSlashMenu(null);
        return;
      }

      const textBefore = $from.parent.textContent.slice(0, $from.parentOffset);

      if (!textBefore.startsWith('/') || textBefore.includes(' ')) {
        setSlashMenu(null);
        return;
      }

      const query = textBefore.slice(1);
      const items = filterCommands(query);

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

  // ── Keyboard interception when slash menu is open ──────────────────────────
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

    editor.view.dom.addEventListener('keydown', handleKeyDown, true);
    return () => editor.view.dom.removeEventListener('keydown', handleKeyDown, true);
  }, [editor, slashMenu]);

  // ── Margin comment button — tracks which block the cursor is in ────────────
  useEffect(() => {
    if (!editor || !editable) return;

    const updateBtn = () => {
      if (!editorWrapRef.current) return;
      const { $from } = editor.state.selection;
      const depth = Math.min($from.depth, 1); // top-level block is depth 1
      const blockStart = $from.start(depth > 0 ? 1 : 0);
      let domNode: Node | null = null;
      try {
        domNode = editor.view.domAtPos(blockStart).node;
      } catch {
        setCommentBtnPos(null);
        return;
      }
      if (!domNode) { setCommentBtnPos(null); return; }
      // Walk up to first block-level HTMLElement
      let el: HTMLElement | null =
        domNode.nodeType === Node.TEXT_NODE
          ? (domNode as Text).parentElement
          : (domNode as HTMLElement);
      while (el && el.parentElement && !['P','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE','PRE','DIV'].includes(el.tagName)) {
        el = el.parentElement;
      }
      if (!el) { setCommentBtnPos(null); return; }
      const wrapRect = editorWrapRef.current.getBoundingClientRect();
      const nodeRect = el.getBoundingClientRect();
      setCommentBtnPos({
        x: wrapRect.right + 4,
        y: nodeRect.top + nodeRect.height / 2 - 12,
      });
    };

    editor.on('selectionUpdate', updateBtn);
    editor.on('focus', updateBtn);
    editor.on('blur', () => setCommentBtnPos(null));
    return () => {
      editor.off('selectionUpdate', updateBtn);
      editor.off('focus', updateBtn);
      editor.off('blur', () => setCommentBtnPos(null));
    };
  }, [editor, editable]);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  const handleTitleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      const text = e.currentTarget.value.trim() || 'Untitled';
      onTitleChange(text);
      ydoc.getMap<string>('meta').set('title', text);
      if (onTitleSave) {
        void onTitleSave(text);
      } else {
        void api.docs.update(docId, { title: text });
      }
    },
    [docId, onTitleChange, onTitleSave, ydoc],
  );

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        editor?.commands.focus('start');
      }
    },
    [editor],
  );

  if (!editor) return null;

  const menuStyle = slashMenu
    ? {
        position: 'fixed' as const,
        top: Math.min(slashMenu.rect.bottom + 4, window.innerHeight - 340),
        left: Math.min(slashMenu.rect.left, window.innerWidth - 296),
        zIndex: 50,
      }
    : undefined;

  const readingMins = Math.max(1, Math.ceil(wordCount.words / 200));

  return (
    <div className="flex flex-col h-full docs-print-area">
      {/* Read-only banner */}
      {!editable && (
        <div className="shrink-0 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-400 print:hidden">
          You have <strong>view-only</strong> access to this document.
        </div>
      )}

      {/* Cover band */}
      {coverColor && (
        <div className={cn('h-24 shrink-0 print:hidden', getCoverClass(coverColor))} />
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Main editor area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            <div ref={editorWrapRef} className="relative max-w-3xl mx-auto px-8 py-10">
              {/* Title row */}
              <div className="flex items-start justify-between gap-4 mb-6">
                <input
                  ref={titleRef}
                  defaultValue={title}
                  readOnly={!editable}
                  onBlur={editable ? handleTitleBlur : undefined}
                  onKeyDown={editable ? handleTitleKeyDown : undefined}
                  placeholder="Untitled"
                  className="flex-1 text-3xl font-bold outline-none bg-transparent placeholder:text-muted-foreground/40 read-only:cursor-default"
                />
                <div className="flex items-center gap-2 pt-2 shrink-0">
                  {/* Comments toggle */}
                  <button
                    type="button"
                    title={showComments ? 'Hide comments' : 'Show comments'}
                    onClick={() => setShowComments((v) => !v)}
                    className={cn(
                      'p-1.5 rounded-md transition-colors',
                      showComments
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                    )}
                  >
                    <MessageSquare className="w-4 h-4" />
                  </button>

                  {/* TOC toggle */}
                  <button
                    type="button"
                    title={showToc ? 'Hide table of contents' : 'Show table of contents'}
                    onClick={() => setShowToc((v) => !v)}
                    className={cn(
                      'p-1.5 rounded-md transition-colors',
                      showToc
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                    )}
                  >
                    <PanelRight className="w-4 h-4" />
                  </button>

                  {/* Save state */}
                  <div className="flex items-center gap-1 text-xs text-muted-foreground select-none">
                    {!synced ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Connecting…</span>
                      </>
                    ) : saveState === 'saving' ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>Saving…</span>
                      </>
                    ) : (
                      <>
                        <Check className="w-3 h-3 text-green-500" />
                        <span>Saved</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

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

          {/* Status bar */}
          <div className="border-t border-border px-8 py-1.5 flex items-center gap-3 text-xs text-muted-foreground shrink-0 print:hidden">
            <span>{wordCount.words.toLocaleString()} words</span>
            <span className="text-muted-foreground/40">·</span>
            <span>{wordCount.chars.toLocaleString()} characters</span>
            <span className="text-muted-foreground/40">·</span>
            <span>~{readingMins} min read</span>
          </div>
        </div>

        {/* Comments panel */}
        {showComments && (
          <CommentPanel
            docId={docId}
            editor={editor}
            onClose={() => { setShowComments(false); setPendingAnchorId(null); }}
            pendingAnchorId={pendingAnchorId}
            onPendingResolved={() => setPendingAnchorId(null)}
          />
        )}

        {/* Table of Contents panel */}
        {showToc && (
          <div className="w-56 border-l border-border shrink-0 flex flex-col print:hidden">
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
              <span className="text-xs font-semibold">Contents</span>
              <button
                type="button"
                onClick={() => setShowToc(false)}
                className="p-0.5 rounded hover:bg-muted text-muted-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <TableOfContents editor={editor} />
            </div>
          </div>
        )}
      </div>

      {/* Text selection bubble menu — Add comment */}
      {editable && (
        <BubbleMenu
          editor={editor}
          shouldShow={({ editor: ed, state }) => {
            const { from, to } = state.selection;
            return (
              from !== to &&
              !ed.isActive('table') &&
              !ed.isActive('tableCell') &&
              !ed.isActive('tableHeader')
            );
          }}
          options={{ placement: 'top', offset: 8 }}
          className="flex items-center gap-0.5 rounded-lg border border-border bg-popover shadow-lg p-1"
        >
          <button
            type="button"
            title="Add comment"
            onMouseDown={(e) => {
              e.preventDefault();
              const anchorId = crypto.randomUUID();
              editor.chain().focus().setComment(anchorId).run();
              setPendingAnchorId(anchorId);
              setShowComments(true);
            }}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            Comment
          </button>
        </BubbleMenu>
      )}

      {/* Table bubble menu */}
      {editable && (
        <BubbleMenu
          editor={editor}
          shouldShow={({ editor: ed }) => ed.isActive('table') || ed.isActive('tableCell') || ed.isActive('tableHeader')}
          options={{ placement: 'top', offset: 8 }}
          className="flex items-center gap-0.5 rounded-lg border border-border bg-popover shadow-lg p-1"
        >
          {/* Row actions */}
          <span className="text-[10px] text-muted-foreground/50 px-1 font-medium select-none">Row</span>
          <button
            type="button"
            title="Add row above"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addRowBefore().run(); }}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowUpToLine className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Add row below"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addRowAfter().run(); }}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowDownToLine className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Delete row"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteRow().run(); }}
            className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-muted-foreground hover:text-red-500 transition-colors"
          >
            <Rows3 className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-5 bg-border mx-0.5" />

          {/* Column actions */}
          <span className="text-[10px] text-muted-foreground/50 px-1 font-medium select-none">Col</span>
          <button
            type="button"
            title="Add column before"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addColumnBefore().run(); }}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeftToLine className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Add column after"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().addColumnAfter().run(); }}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowRightToLine className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            title="Delete column"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteColumn().run(); }}
            className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-muted-foreground hover:text-red-500 transition-colors"
          >
            <Columns2 className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-5 bg-border mx-0.5" />

          {/* Delete table */}
          <button
            type="button"
            title="Delete table"
            onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().deleteTable().run(); }}
            className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-muted-foreground hover:text-red-500 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </BubbleMenu>
      )}

      {/* Margin comment button — appears next to the cursor's current block */}
      {editable && commentBtnPos && !pendingAnchorId && (
        <button
          type="button"
          title="Comment on this section"
          style={{ position: 'fixed', left: commentBtnPos.x, top: commentBtnPos.y, zIndex: 40 }}
          onMouseDown={(e) => {
            e.preventDefault();
            const { $from } = editor.state.selection;
            const depth = $from.depth > 0 ? 1 : 0;
            const from = $from.start(depth);
            const to = $from.end(depth);
            const anchorId = crypto.randomUUID();
            editor.chain().focus().setTextSelection({ from, to }).setComment(anchorId).run();
            // Collapse selection back so highlight doesn't look odd
            editor.commands.setTextSelection(from);
            setPendingAnchorId(anchorId);
            setShowComments(true);
          }}
          className="w-6 h-6 flex items-center justify-center text-muted-foreground/50 hover:text-foreground transition-colors"
        >
          <MessageSquarePlus className="w-3.5 h-3.5" />
        </button>
      )}

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
