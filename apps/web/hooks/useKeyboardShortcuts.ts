import { useEffect } from 'react';

export type ShortcutKey =
  | 'j' | 'k' | 'c' | 'r' | 'a' | 'f' | 's' | 'e' | 'd' | 'u'
  | 'escape' | 'slash' | 'cmdK' | 'question';

export const SHORTCUTS: { key: ShortcutKey; label: string; description: string }[] = [
  { key: 'j',        label: 'J',      description: 'Next message' },
  { key: 'k',        label: 'K',      description: 'Previous message' },
  { key: 'c',        label: 'C',      description: 'Compose new message' },
  { key: 'r',        label: 'R',      description: 'Reply' },
  { key: 'a',        label: 'A',      description: 'Reply all' },
  { key: 'f',        label: 'F',      description: 'Forward' },
  { key: 's',        label: 'S',      description: 'Star / unstar' },
  { key: 'e',        label: 'E',      description: 'Archive' },
  { key: 'd',        label: 'D',      description: 'Delete' },
  { key: 'u',        label: 'U',      description: 'Mark unread' },
  { key: 'slash',    label: '/',      description: 'Focus search' },
  { key: 'cmdK',     label: '⌘K',     description: 'Global search' },
  { key: 'escape',   label: 'Esc',    description: 'Close / deselect' },
  { key: 'question', label: '?',      description: 'Show keyboard shortcuts' },
];

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isTyping(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement;
  if (!target) return false;
  if (TYPING_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts(
  handlers: Partial<Record<ShortcutKey, () => void>>,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K — always fires (even in inputs)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        handlers.cmdK?.();
        return;
      }

      if (isTyping(e)) return;

      switch (e.key) {
        case 'j':        handlers.j?.(); break;
        case 'k':        handlers.k?.(); break;
        case 'c':        handlers.c?.(); break;
        case 'r':        if (!e.metaKey && !e.ctrlKey) handlers.r?.(); break;
        case 'a':        if (!e.metaKey && !e.ctrlKey) handlers.a?.(); break;
        case 'f':        if (!e.metaKey && !e.ctrlKey) handlers.f?.(); break;
        case 's':        handlers.s?.(); break;
        case 'e':        handlers.e?.(); break;
        case 'd':        handlers.d?.(); break;
        case 'u':        handlers.u?.(); break;
        case '/':        e.preventDefault(); handlers.slash?.(); break;
        case 'Escape':   handlers.escape?.(); break;
        case '?':        handlers.question?.(); break;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handlers]);
}
