'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
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
import { Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import {
  SlashCommandMenu,
  filterCommands,
  type SlashCommandItem,
  type SlashCommandMenuHandle,
} from './SlashCommandMenu';

const COLLAB_URL = process.env.NEXT_PUBLIC_COLLAB_WS_URL ?? 'ws://localhost:1234';

interface DocsEditorProps {
  docId: string;
  initialContent: string | null | undefined;
  title: string;
  onTitleChange: (title: string) => void;
  onTitleSave?: (title: string) => Promise<void>;
  collaborationToken: string;
  collaborationUser?: { name: string; color: string };
}

type SaveState = 'saved' | 'saving' | 'unsaved';

interface SlashMenuState {
  items: SlashCommandItem[];
  rect: DOMRect;
  onSelect: (item: SlashCommandItem) => void;
}

export function DocsEditor({
  docId,
  initialContent,
  title,
  onTitleChange,
  onTitleSave,
  collaborationToken,
}: DocsEditorProps) {
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [synced, setSynced] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const destroyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  // Use ref so onUpdate (captured once by useEditor) always sees current synced state
  const syncedRef = useRef(false);

  // ── Slash menu ──────────────────────────────────────────────────────────────
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const menuRef = useRef<SlashCommandMenuHandle>(null);

  // ── Yjs + Hocuspocus (stable per mount — parent uses key={docId}) ─────────
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
          // Bootstrap from JSON if the Yjs doc is empty (first-ever open)
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

  // Cleanup on unmount — deferred by one macrotask so React 18 Strict Mode's
  // simulated unmount/remount cycle can cancel the destroy before it fires.
  // (In production Strict Mode is a no-op, so the timer fires immediately.)
  useEffect(() => {
    // Cancel any pending destroy from the previous Strict Mode cleanup cycle.
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

  // ── Content persistence (REST fallback — keeps content JSON fresh) ─────────
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
      // codeBlock: false — replaced by custom CodeBlockLowlight extension
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
    ],
    // No `content` prop — Yjs controls document state
    onUpdate({ editor: ed, transaction }) {
      if (!syncedRef.current) return; // don't save during initial Yjs sync
      // Skip REST save for remote Yjs updates — Hocuspocus already persists yjsState
      if (isChangeOrigin(transaction)) return;
      setSaveState('unsaved');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void persistContent(JSON.stringify(ed.getJSON()));
      }, 500);
    },
  });

  // Keep editorRef in sync so the provider's onSynced callback can access it
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // ── Real-time title sync via Yjs ────────────────────────────────────────────
  useEffect(() => {
    if (!synced) return;
    const metaMap = ydoc.getMap<string>('meta');

    // On first sync: if another peer already stored a title, apply it immediately
    const yjsTitle = metaMap.get('title');
    if (yjsTitle && titleRef.current) {
      titleRef.current.value = yjsTitle;
      onTitleChange(yjsTitle);
    }

    // Observe future remote title changes; skip if the user is actively editing
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

  // ── Slash command detection ─────────────────────────────────────────────────
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

    editor.view.dom.addEventListener('keydown', handleKeyDown, true);
    return () => editor.view.dom.removeEventListener('keydown', handleKeyDown, true);
  }, [editor, slashMenu]);

  // ── Cleanup save timer ───────────────────────────────────────────────────────
  useEffect(() => {
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  const handleTitleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      const text = e.currentTarget.value.trim() || 'Untitled';
      onTitleChange(text);
      // Broadcast the new title to all connected peers via Yjs
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
      {/* Title + body */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-10">
          <div className="flex items-start justify-between gap-4 mb-6">
            <input
              ref={titleRef}
              defaultValue={title}
              onBlur={handleTitleBlur}
              onKeyDown={handleTitleKeyDown}
              placeholder="Untitled"
              className="flex-1 text-3xl font-bold outline-none bg-transparent placeholder:text-muted-foreground/40"
            />
            <div className="flex items-center gap-1 text-xs text-muted-foreground select-none pt-2 shrink-0">
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
