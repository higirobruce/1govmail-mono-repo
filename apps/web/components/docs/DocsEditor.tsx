'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { Slice, DOMSerializer } from '@tiptap/pm/model';
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
  Trash2, Columns2, Rows3, History, Activity, Play, MoreHorizontal,
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, Code,
  Link2, Type, Heading1, Heading2, Heading3, ChevronDown, RemoveFormatting,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { ActivityFeedPanel } from './ActivityFeedPanel';
import { VersionHistoryPanel } from './VersionHistoryPanel';
import { EmbedNode, getEmbedInfo } from './extensions/EmbedNode';
import { MathBlock } from './extensions/MathBlock';
import { MermaidBlock } from './extensions/MermaidBlock';
import Image from '@tiptap/extension-image';
import { PresentationMode } from './PresentationMode';

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
type PanelId = 'comments' | 'activity' | 'versions' | 'toc';

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

// ── Debug helpers ─────────────────────────────────────────────────────────
// Gated on `?debug=docs` in the URL. Used to diagnose "images render locally
// but not in prod" — traces REST vs Yjs state, image uploads, and persistence
// paths so we can see which step loses the image.

function isDocsDebug(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('debug') === 'docs';
}

function countImagesInJson(root: unknown): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  const visit = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const node = n as { type?: string; attrs?: { src?: string }; content?: unknown[] };
    if (node.type === 'image') {
      count++;
      bytes += node.attrs?.src?.length ?? 0;
    }
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };
  visit(root);
  return { count, bytes };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dlog(label: string, data?: any) {
  if (!isDocsDebug()) return;
  // eslint-disable-next-line no-console
  console.log(`[docs-debug] ${label}`, data ?? '');
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
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  const [showPresentation, setShowPresentation] = useState(false);
  const [pendingAnchorId, setPendingAnchorId] = useState<string | null>(null);
  const [focusAnchorId, setFocusAnchorId] = useState<string | null>(null);
  const [commentBtnPos, setCommentBtnPos] = useState<{ x: number; y: number } | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; anchorId: string } | null>(null);
  const commentSummariesRef = useRef<Record<string, { authorName: string; content: string }>>({});
  const [wordCount, setWordCount] = useState({ words: 0, chars: 0 });
  const [headingMenuOpen, setHeadingMenuOpen] = useState(false);
  const [selBubble, setSelBubble] = useState<{ top: number; left: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const destroyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const pendingInitRef = useRef<object | null>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const syncedRef = useRef(false);

  const togglePanel = useCallback((id: PanelId) => {
    setActivePanel((prev) => (prev === id ? null : id));
  }, []);

  // Strip orphaned pending mark when comments panel is dismissed without saving
  useEffect(() => {
    if (activePanel !== 'comments' && pendingAnchorId && editor) {
      editor.chain().unsetComment(pendingAnchorId).run();
      setPendingAnchorId(null);
    }
  }, [activePanel]); // eslint-disable-line react-hooks/exhaustive-deps

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
          const fragLength = fragment.length;
          let usedRestFallback = false;
          if (fragLength === 0 && initialContent) {
            try {
              const parsed = JSON.parse(initialContent);
              if (editorRef.current) {
                editorRef.current.commands.setContent(parsed);
              } else {
                // Editor not mounted yet — apply once it becomes available
                pendingInitRef.current = parsed;
              }
              usedRestFallback = true;
            } catch { /* invalid JSON — leave editor empty */ }
          }
          dlog('provider onSynced', {
            yjsFragmentLength: fragLength,
            yjsFragmentEmpty: fragLength === 0,
            hadInitialContent: !!initialContent,
            usedRestFallback,
          });
          syncedRef.current = true;
          setSynced(true);
          setSaveState('saved');
        },
      }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Diagnostic: log initial content stats + fetch backend debug snapshot
  // when the editor mounts. Only runs when `?debug=docs` is in the URL.
  useEffect(() => {
    if (!isDocsDebug()) return;
    const collabOrigin = (() => {
      try { return new URL(COLLAB_URL).origin; } catch { return COLLAB_URL; }
    })();
    dlog('mount', {
      docId,
      initialContentBytes: initialContent?.length ?? 0,
      collabWsUrl: COLLAB_URL,
      collabOrigin,
    });
    if (initialContent) {
      try {
        const parsed = JSON.parse(initialContent);
        const imgs = countImagesInJson(parsed);
        dlog('initialContent images', imgs);
      } catch (err) { dlog('initialContent parse ✗', err); }
    }
    void api.docs.debug(docId)
      .then((info) => dlog('backend /debug', info))
      .catch((err) => dlog('backend /debug ✗', err));
  }, [docId, initialContent]);

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
      if (isDocsDebug()) {
        try {
          const parsed = JSON.parse(json);
          const imgs = countImagesInJson(parsed);
          dlog('REST save →', { bytes: json.length, imageCount: imgs.count, imageBytes: imgs.bytes });
        } catch { /* ignore — not critical in debug path */ }
      }
      try {
        await api.docs.update(docId, { content: json });
        dlog('REST save ✓');
        setSaveState('saved');
      } catch (err) {
        dlog('REST save ✗', err);
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
      Image.configure({ inline: false, allowBase64: true }),
      EmbedNode,
      MathBlock,
      MermaidBlock,
      Placeholder.configure({
        placeholder: "Start writing, or type '/' for commands…",
      }),
      CommentMark,
    ],
    editorProps: {
      handleDrop(view, event) {
        const files = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
          f.type.startsWith('image/'),
        );
        if (!files.length) return false;
        event.preventDefault();
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
        files.forEach(async (file) => {
          dlog('image drop →', { name: file.name, type: file.type, bytes: file.size });
          try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch('/upload/image', { method: 'POST', body: formData });
            dlog('image upload response', { status: res.status, ok: res.ok });
            if (!res.ok) return;
            const { url } = await res.json() as { url: string };
            dlog('image upload ✓', { urlBytes: url.length, urlPrefix: url.slice(0, 48) });
            const node = view.state.schema.nodes.image?.create({ src: url, alt: file.name });
            if (!node) { dlog('image node missing from schema'); return; }
            const pos = coords?.pos ?? view.state.doc.content.size;
            view.dispatch(view.state.tr.insert(pos, node));
          } catch (err) { dlog('image upload ✗', err); }
        });
        return true;
      },
      handlePaste(view, event) {
        // TipTap JSON slice — restores custom nodes/marks that HTML may lose
        const html = event.clipboardData?.getData('text/html') ?? '';
        const keyMatch = html.match(/data-tt-clip-key="([^"]+)"/);
        if (keyMatch) {
          const storedKey = sessionStorage.getItem('__tt_clip_key');
          if (storedKey === keyMatch[1]) {
            const json = sessionStorage.getItem(storedKey);
            if (json) {
              event.preventDefault();
              try {
                const pmSlice = Slice.fromJSON(view.state.schema, JSON.parse(json));
                view.dispatch(view.state.tr.replaceSelection(pmSlice));
                return true;
              } catch { /* fall through to default HTML paste */ }
            }
          }
        }

        // Image files from clipboard
        const imageFiles = Array.from(event.clipboardData?.items ?? [])
          .filter((i) => i.type.startsWith('image/'))
          .map((i) => i.getAsFile())
          .filter(Boolean) as File[];
        if (imageFiles.length) {
          event.preventDefault();
          imageFiles.forEach(async (file) => {
            dlog('image paste →', { name: file.name, type: file.type, bytes: file.size });
            try {
              const formData = new FormData();
              formData.append('file', file);
              const res = await fetch('/upload/image', { method: 'POST', body: formData });
              dlog('image upload response', { status: res.status, ok: res.ok });
              if (!res.ok) return;
              const { url } = await res.json() as { url: string };
              dlog('image upload ✓', { urlBytes: url.length, urlPrefix: url.slice(0, 48) });
              const node = view.state.schema.nodes.image?.create({ src: url, alt: file.name });
              if (!node) { dlog('image node missing from schema'); return; }
              view.dispatch(view.state.tr.replaceSelectionWith(node));
            } catch (err) { dlog('image upload ✗', err); }
          });
          return true;
        }
        // Embed URL detection — only on empty paragraph
        const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
        if (text && /^https?:\/\/\S+$/.test(text)) {
          const { $from } = view.state.selection;
          if ($from.parent.type.name === 'paragraph' && $from.parent.textContent === '') {
            const info = getEmbedInfo(text);
            if (info) {
              event.preventDefault();
              const node = view.state.schema.nodes.embed?.create({
                url: text,
                embedUrl: info.embedUrl,
                embedType: info.embedType,
                label: info.label,
              });
              if (node) {
                view.dispatch(view.state.tr.replaceSelectionWith(node));
                return true;
              }
            }
          }
        }
        return false;
      },
    },
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
    if (editor) {
      setWordCount(getWordCount(editor));
      // Flush any content that onSynced tried to set before the editor was ready
      if (pendingInitRef.current) {
        editor.commands.setContent(pendingInitRef.current);
        pendingInitRef.current = null;
      }
    }
  }, [editor]);

  // Close the heading dropdown when selection collapses or editor loses focus
  useEffect(() => {
    if (!editor) return;
    const close = () => {
      const { from, to } = editor.state.selection;
      if (from === to) setHeadingMenuOpen(false);
    };
    const onBlur = () => setHeadingMenuOpen(false);
    editor.on('selectionUpdate', close);
    editor.on('blur', onBlur);
    return () => { editor.off('selectionUpdate', close); editor.off('blur', onBlur); };
  }, [editor]);

  // Preserve full TipTap JSON on copy/cut so paste into another DocsEditor
  // restores all custom nodes and marks that HTML alone might lose.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onCopyOrCut = (e: ClipboardEvent) => {
      const { from, to } = editor.state.selection;
      if (from === to || !e.clipboardData) return;
      const slice = editor.state.doc.slice(from, to);
      const key = `tt-${Date.now()}`;
      try {
        sessionStorage.setItem('__tt_clip_key', key);
        sessionStorage.setItem(key, JSON.stringify(slice.toJSON()));
      } catch { /* storage quota */ }
      // Serialize the selection to HTML via ProseMirror's DOM serializer
      const serializer = DOMSerializer.fromSchema(editor.state.schema);
      const container = document.createElement('div');
      container.appendChild(serializer.serializeFragment(slice.content));
      // Inject a hidden marker so handlePaste can detect TipTap-origin content
      const marker = document.createElement('span');
      marker.dataset.ttClipKey = key;
      marker.style.display = 'none';
      container.appendChild(marker);
      e.preventDefault();
      e.clipboardData.setData('text/plain', slice.content.textBetween(0, slice.content.size, '\n'));
      e.clipboardData.setData('text/html', container.innerHTML);
      // For cut: delete the selection after writing to clipboard
      if (e.type === 'cut') {
        editor.view.dispatch(editor.state.tr.deleteSelection());
      }
    };
    dom.addEventListener('copy', onCopyOrCut);
    dom.addEventListener('cut',  onCopyOrCut);
    return () => { dom.removeEventListener('copy', onCopyOrCut); dom.removeEventListener('cut', onCopyOrCut); };
  }, [editor]);

  // Track selection position for the custom bubble menu
  useEffect(() => {
    if (!editor || !editable) return;
    const update = () => {
      const { from, to } = editor.state.selection;
      if (
        from === to ||
        editor.isActive('table') ||
        editor.isActive('tableCell') ||
        editor.isActive('tableHeader')
      ) {
        setSelBubble(null);
        return;
      }
      try {
        const startCoords = editor.view.coordsAtPos(from);
        const endCoords = editor.view.coordsAtPos(to);
        const centerX = (startCoords.left + endCoords.left) / 2;
        const top = Math.min(startCoords.top, endCoords.top);
        setSelBubble({
          top,
          left: Math.max(140, Math.min(centerX, window.innerWidth - 140)),
        });
      } catch {
        setSelBubble(null);
      }
    };
    const hide = () => { setSelBubble(null); setHeadingMenuOpen(false); };
    editor.on('selectionUpdate', update);
    editor.on('blur', hide);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('blur', hide);
    };
  }, [editor, editable]);

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

  // ── Load comment summaries for hover tooltips ──────────────────────────────
  useEffect(() => {
    api.docs.comments.list(docId).then((comments: any[]) => {
      const index: Record<string, { authorName: string; content: string }> = {};
      for (const c of comments) {
        index[c.anchorId] = { authorName: c.authorName ?? 'Unknown', content: c.content };
      }
      commentSummariesRef.current = index;
    }).catch(() => {});
  }, [docId]);

  // ── Click / hover handlers on comment marks ────────────────────────────────
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;

    const handleClick = (e: MouseEvent) => {
      const target = (e.target as Element).closest('[data-cid]') as HTMLElement | null;
      if (!target) return;
      const anchorId = target.dataset.cid;
      if (!anchorId) return;
      e.stopPropagation();
      setFocusAnchorId(anchorId);
      setActivePanel('comments');
      setTooltip(null);
    };

    const handleMouseOver = (e: MouseEvent) => {
      const target = (e.target as Element).closest('[data-cid]') as HTMLElement | null;
      if (!target) return;
      const anchorId = target.dataset.cid;
      if (!anchorId) return;
      const rect = target.getBoundingClientRect();
      setTooltip({ x: rect.left, y: rect.top, anchorId });
    };

    const handleMouseOut = (e: MouseEvent) => {
      const related = e.relatedTarget as Element | null;
      if (related && (e.target as Element).closest('[data-cid]')?.contains(related)) return;
      setTooltip(null);
    };

    dom.addEventListener('click', handleClick);
    dom.addEventListener('mouseover', handleMouseOver);
    dom.addEventListener('mouseout', handleMouseOut);
    return () => {
      dom.removeEventListener('click', handleClick);
      dom.removeEventListener('mouseover', handleMouseOver);
      dom.removeEventListener('mouseout', handleMouseOut);
    };
  }, [editor]);

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
                <div className="flex items-center gap-1.5 pt-2 shrink-0">
                  {/* Actions menu — Comments, Activity, Version History */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title="More actions"
                        className="p-1.5 rounded-md transition-colors text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem
                        onClick={() => togglePanel('comments')}
                        className={cn(activePanel === 'comments' && 'bg-muted')}
                      >
                        <MessageSquare className="w-4 h-4 mr-2" />
                        Comments
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => togglePanel('activity')}
                        className={cn(activePanel === 'activity' && 'bg-muted')}
                      >
                        <Activity className="w-4 h-4 mr-2" />
                        Activity
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => togglePanel('versions')}
                        className={cn(activePanel === 'versions' && 'bg-muted')}
                      >
                        <History className="w-4 h-4 mr-2" />
                        Version history
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setShowPresentation(true)}>
                        <Play className="w-4 h-4 mr-2" />
                        Present
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* Table of contents */}
                  <button
                    type="button"
                    title={activePanel === 'toc' ? 'Hide table of contents' : 'Table of contents'}
                    onClick={() => togglePanel('toc')}
                    className={cn(
                      'p-1.5 rounded-md transition-colors',
                      activePanel === 'toc'
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
        {activePanel === 'comments' && (
          <CommentPanel
            docId={docId}
            editor={editor}
            onClose={() => { setActivePanel(null); setFocusAnchorId(null); }}
            pendingAnchorId={pendingAnchorId}
            onPendingResolved={() => setPendingAnchorId(null)}
            focusAnchorId={focusAnchorId}
            onFocusConsumed={() => setFocusAnchorId(null)}
          />
        )}

        {/* Activity feed panel */}
        {activePanel === 'activity' && (
          <ActivityFeedPanel
            docId={docId}
            onClose={() => setActivePanel(null)}
          />
        )}

        {/* Version history panel */}
        {activePanel === 'versions' && (
          <VersionHistoryPanel
            docId={docId}
            onClose={() => setActivePanel(null)}
            onRestored={() => window.location.reload()}
          />
        )}

        {/* Table of Contents panel */}
        {activePanel === 'toc' && (
          <div className="w-56 border-l border-border shrink-0 flex flex-col print:hidden">
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
              <span className="text-xs font-semibold">Contents</span>
              <button
                type="button"
                onClick={() => setActivePanel(null)}
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

      {/* Text selection bubble menu */}
      {editable && selBubble && (
        <div
          style={{
            position: 'fixed',
            top: selBubble.top - 8,
            left: selBubble.left,
            transform: 'translate(-50%, -100%)',
            zIndex: 9999,
          }}
          onMouseDown={(e) => e.preventDefault()}
          className="flex flex-col rounded-xl border border-border bg-popover shadow-xl w-[260px]"
        >
          {/* ── Row 1: inline marks ─────────────────────────────────────────── */}
          <div className="flex items-center gap-0.5 p-1.5">
            {/* Clear formatting */}
            <button
              type="button"
              title="Clear formatting"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().clearNodes().unsetAllMarks().run(); }}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <RemoveFormatting className="w-3.5 h-3.5" />
            </button>

            <div className="w-px h-4 bg-border mx-0.5 shrink-0" />

            {/* Bold */}
            <button
              type="button"
              title="Bold"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }}
              className={cn('p-1.5 rounded-md transition-colors', editor.isActive('bold') ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
            >
              <Bold className="w-3.5 h-3.5" />
            </button>

            {/* Italic */}
            <button
              type="button"
              title="Italic"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }}
              className={cn('p-1.5 rounded-md transition-colors', editor.isActive('italic') ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
            >
              <Italic className="w-3.5 h-3.5" />
            </button>

            {/* Underline */}
            <button
              type="button"
              title="Underline"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleUnderline().run(); }}
              className={cn('p-1.5 rounded-md transition-colors', editor.isActive('underline') ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
            >
              <UnderlineIcon className="w-3.5 h-3.5" />
            </button>

            {/* Strikethrough */}
            <button
              type="button"
              title="Strikethrough"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleStrike().run(); }}
              className={cn('p-1.5 rounded-md transition-colors', editor.isActive('strike') ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
            >
              <Strikethrough className="w-3.5 h-3.5" />
            </button>

            {/* Inline code */}
            <button
              type="button"
              title="Inline code"
              onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleCode().run(); }}
              className={cn('p-1.5 rounded-md transition-colors', editor.isActive('code') ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
            >
              <Code className="w-3.5 h-3.5" />
            </button>

            {/* Link */}
            <button
              type="button"
              title={editor.isActive('link') ? 'Remove link' : 'Add link'}
              onMouseDown={(e) => {
                e.preventDefault();
                if (editor.isActive('link')) {
                  editor.chain().focus().unsetLink().run();
                } else {
                  const url = window.prompt('URL');
                  if (url) editor.chain().focus().setLink({ href: url }).run();
                }
              }}
              className={cn('p-1.5 rounded-md transition-colors', editor.isActive('link') ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
            >
              <Link2 className="w-3.5 h-3.5" />
            </button>

            <div className="w-px h-4 bg-border mx-0.5 shrink-0" />

            {/* Heading dropdown */}
            <div className="relative">
              <button
                type="button"
                title="Heading"
                onMouseDown={(e) => { e.preventDefault(); setHeadingMenuOpen((v) => !v); }}
                className={cn('flex items-center gap-0.5 p-1.5 rounded-md transition-colors', (editor.isActive('heading')) ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
              >
                <Type className="w-3.5 h-3.5" />
                <ChevronDown className="w-2.5 h-2.5" />
              </button>
              {headingMenuOpen && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[120px]">
                  {[
                    { label: 'Heading 1', icon: Heading1, level: 1 },
                    { label: 'Heading 2', icon: Heading2, level: 2 },
                    { label: 'Heading 3', icon: Heading3, level: 3 },
                    { label: 'Normal text', icon: Type, level: null },
                  ].map(({ label, icon: Icon, level }) => (
                    <button
                      key={label}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (level) editor.chain().focus().toggleHeading({ level: level as 1|2|3 }).run();
                        else editor.chain().focus().setParagraph().run();
                        setHeadingMenuOpen(false);
                      }}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors text-left',
                        level && editor.isActive('heading', { level }) ? 'text-primary font-medium' : 'text-foreground',
                      )}
                    >
                      <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Row 2: Comment ──────────────────────────────────────────────── */}
          <div className="border-t border-border/60 p-1">
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setHeadingMenuOpen(false);
                const anchorId = crypto.randomUUID();
                editor.chain().focus().setComment(anchorId).run();
                setPendingAnchorId(anchorId);
                setActivePanel('comments');
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              Comment
            </button>
          </div>
        </div>
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
            setActivePanel('comments');
          }}
          className="w-6 h-6 flex items-center justify-center text-muted-foreground/50 hover:text-foreground transition-colors"
        >
          <MessageSquarePlus className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Comment hover tooltip */}
      {tooltip && (() => {
        const summary = commentSummariesRef.current[tooltip.anchorId];
        return (
          <div
            style={{ position: 'fixed', left: tooltip.x, top: tooltip.y - 8, transform: 'translateY(-100%)', zIndex: 50 }}
            className="max-w-56 rounded-lg border border-border bg-popover shadow-lg px-2.5 py-2 pointer-events-none"
          >
            {summary ? (
              <>
                <p className="text-[10px] font-semibold text-primary mb-0.5">{summary.authorName}</p>
                <p className="text-xs text-foreground line-clamp-3">{summary.content}</p>
                <p className="text-[10px] text-muted-foreground mt-1">Click to open comments</p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Click to open comments</p>
            )}
          </div>
        );
      })()}

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

      {/* Presentation mode overlay */}
      {showPresentation && (
        <PresentationMode
          editor={editor}
          title={title}
          onClose={() => setShowPresentation(false)}
        />
      )}
    </div>
  );
}
