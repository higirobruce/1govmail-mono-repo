'use client';

import { SHORTCUTS } from '@/hooks/useKeyboardShortcuts';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ open, onClose }: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <h2 className="text-sm font-semibold text-foreground">Keyboard shortcuts</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Shortcuts grid */}
        <div className="p-5 grid grid-cols-2 gap-x-8 gap-y-2.5 max-h-[70vh] overflow-y-auto">
          {SHORTCUTS.map(({ key, description }) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <span className="text-[13px] text-muted-foreground">{description}</span>
              <kbd className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-md border border-border/60 bg-muted/50 text-[11px] font-mono font-medium text-foreground/70">
                {key}
              </kbd>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-border/30 text-center">
          <span className="text-[11px] text-muted-foreground/40">Press <kbd className="font-mono">?</kbd> to toggle this panel</span>
        </div>
      </div>
    </div>
  );
}
